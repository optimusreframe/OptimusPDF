import {
  PDFArray,
  degrees,
  type Color,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  hexToPdfColor,
  loadPdf,
  originForCenter,
  readFileBytes,
  rotatedBounds,
  pdfBytesToBlob,
  savePdfToBytes,
  standardFontFor,
  toPdfError,
  toWinAnsiSafe,
  viewPointToUser,
  type PageGeometry,
  type PdfFontFamily,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de marca de agua (texto o imagen).
 *
 * La geometria de pagina, la tipografia estandar y la conversion de
 * color viven en `lib/pdf/core.ts` y se comparten con `pageNumbers.ts`,
 * `crop.ts`, `sign.ts` y `ocr.ts`.
 */

/**
 * Puente de compatibilidad: estos nombres se movieron a `core.ts` pero
 * siguen importandose desde aqui por varias pantallas (`crop-pdf`,
 * `sign-pdf`, `add-watermark`, `add-page-numbers`). Se re-exportan para
 * no tocar esos archivos; los modulos nuevos deben importarlos de
 * `@/lib/pdf/core`.
 */
export { INK_COLORS } from "@/lib/pdf/core";
export type { NormalizedRect, PdfFontFamily } from "@/lib/pdf/core";

/* ------------------------------------------------------------------ *
 * Capas: dibujar por debajo del contenido existente
 * ------------------------------------------------------------------ */

/**
 * pdf-lib siempre ANADE el flujo de contenido nuevo al final del array
 * `/Contents`, asi que lo dibujado queda encima. Para la capa "debajo"
 * se mueve ese ultimo flujo a la primera posicion: el resultado es
 * exactamente el mismo contenido pero pintado antes que la pagina.
 *
 * Es seguro porque los operadores que emite pdf-lib van envueltos en
 * `q`/`Q`, de modo que no filtran estado grafico al contenido original.
 * Se descarto la alternativa (re-empotrar cada pagina como XObject sobre
 * una pagina nueva) porque destruye enlaces y anotaciones.
 */
function moveLastContentStreamToBack(page: PDFPage): void {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return;
  const size = contents.size();
  if (size < 2) return;
  const last = contents.get(size - 1);
  contents.remove(size - 1);
  contents.insert(0, last);
}

/* ------------------------------------------------------------------ *
 * Opciones publicas
 * ------------------------------------------------------------------ */

export type GridAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export const GRID_ANCHORS: readonly GridAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type WatermarkKind = "text" | "image";
export type WatermarkLayer = "over" | "under";

/** 1 = sin transparencia. */
export const WATERMARK_OPACITIES = [1, 0.75, 0.5, 0.25] as const;
export const WATERMARK_ROTATIONS = [0, 45, 90, 180, 270] as const;

export type WatermarkOptions = {
  kind: WatermarkKind;
  text: string;
  fontFamily: PdfFontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  image: File | null;
  /** Ancho de la imagen como fraccion del ancho visible de la pagina. */
  imageScale: number;
  anchor: GridAnchor;
  tile: boolean;
  opacity: number;
  rotation: number;
  /** Rango 1..N inclusive. 0 significa "sin limite". */
  fromPage: number;
  toPage: number;
  layer: WatermarkLayer;
};

export const DEFAULT_WATERMARK_OPTIONS: WatermarkOptions = {
  kind: "text",
  text: "",
  fontFamily: "helvetica",
  fontSize: 48,
  bold: true,
  italic: false,
  color: "#5b6470",
  image: null,
  imageScale: 0.4,
  anchor: "middle-center",
  tile: false,
  opacity: 0.5,
  rotation: 45,
  fromPage: 1,
  toPage: 0,
  layer: "over",
};

/** Tope de repeticiones por pagina en modo mosaico. */
const MAX_TILES_PER_PAGE = 400;

/** Una imagen de marca de agua que pesa mas que esto se trata como foto: se reduce con la calidad de imagen elegida. */
const WATERMARK_PHOTO_BYTES = 300 * 1024;
/** Lado largo (px) que como maximo necesita una marca de agua (se dibuja a una fraccion del ancho de la pagina). */
const WATERMARK_MAX_SIDE = 1600;

async function embedImageFile(
  document: PDFDocument,
  file: File,
): Promise<PDFImage> {
  let bytes = await readFileBytes(file);
  if (bytes.byteLength < 4) throw new PdfError("invalidType");
  if (bytes.byteLength > WATERMARK_PHOTO_BYTES) {
    // Una FOTO grande como marca de agua (no un logo): se reduce y se hornea su orientacion EXIF. Un PNG con transparencia
    // o un grafico pasa intacto (ver `prepareForPdf.ts`). Ante cualquier fallo se incrusta el archivo tal cual.
    try {
      const [{ prepareImageForPdf }, { readStoredImagePreset }] = await Promise.all([
        import("@/lib/image/prepareBrowser"),
        import("@/lib/image/imageQualityPref"),
      ]);
      const prepared = await prepareImageForPdf(file, readStoredImagePreset(), {
        fitMaxSide: WATERMARK_MAX_SIDE,
        bakeOrientation: true,
      });
      if (prepared.changed) bytes = prepared.bytes;
    } catch {
      // Se usa el archivo original.
    }
  }
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (isPng) return document.embedPng(bytes);
  if (isJpg) return document.embedJpg(bytes);
  throw new PdfError("invalidType");
}

type Stamp = {
  /** Ancho y alto del elemento, en puntos, sin rotar. */
  width: number;
  height: number;
  /** Distancia del borde inferior al origen de dibujo. */
  baselineOffset: number;
  draw: (page: PDFPage, x: number, y: number, angle: number) => void;
};

function resolveRange(
  total: number,
  fromPage: number,
  toPage: number,
): { from: number; to: number } {
  const from = Math.min(Math.max(1, Math.floor(fromPage) || 1), total);
  const rawTo = Math.floor(toPage) || total;
  const to = Math.min(Math.max(from, rawTo), total);
  return { from, to };
}

function anchorCenter(
  anchor: GridAnchor,
  geometry: PageGeometry,
  bounds: { width: number; height: number },
): { vx: number; vy: number } {
  const margin = Math.max(
    18,
    Math.min(geometry.viewWidth, geometry.viewHeight) * 0.05,
  );
  const halfW = bounds.width / 2;
  const halfH = bounds.height / 2;

  const [vertical, horizontal] = anchor.split("-");

  let vx: number;
  if (horizontal === "left") vx = margin + halfW;
  else if (horizontal === "right") vx = geometry.viewWidth - margin - halfW;
  else vx = geometry.viewWidth / 2;

  let vy: number;
  if (vertical === "bottom") vy = margin + halfH;
  else if (vertical === "top") vy = geometry.viewHeight - margin - halfH;
  else vy = geometry.viewHeight / 2;

  // Si el elemento no cabe con margen, se centra en lugar de salirse.
  if (bounds.width + margin * 2 > geometry.viewWidth) vx = geometry.viewWidth / 2;
  if (bounds.height + margin * 2 > geometry.viewHeight) {
    vy = geometry.viewHeight / 2;
  }
  return { vx, vy };
}

function tileCenters(
  geometry: PageGeometry,
  bounds: { width: number; height: number },
): Array<{ vx: number; vy: number }> {
  const gap = Math.max(16, Math.min(bounds.width, bounds.height) * 0.35);
  let stepX = Math.max(24, bounds.width + gap);
  let stepY = Math.max(24, bounds.height + gap);

  let columns = Math.max(1, Math.ceil(geometry.viewWidth / stepX));
  let rows = Math.max(1, Math.ceil(geometry.viewHeight / stepY));

  // Cota dura: si la marca es diminuta el mosaico no debe explotar.
  while (columns * rows > MAX_TILES_PER_PAGE) {
    stepX *= 1.25;
    stepY *= 1.25;
    columns = Math.max(1, Math.ceil(geometry.viewWidth / stepX));
    rows = Math.max(1, Math.ceil(geometry.viewHeight / stepY));
  }

  const startX = (geometry.viewWidth - columns * stepX) / 2 + stepX / 2;
  const startY = (geometry.viewHeight - rows * stepY) / 2 + stepY / 2;

  const centers: Array<{ vx: number; vy: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      centers.push({
        vx: startX + column * stepX,
        vy: startY + row * stepY,
      });
    }
  }
  return centers;
}

/**
 * Superpone texto o imagen sobre las paginas elegidas. Todo el trabajo
 * ocurre en la memoria del navegador.
 */
export async function addWatermark(
  file: File,
  options: WatermarkOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return pdfBytesToBlob(await addWatermarkToBytes(file, options, onProgress));
}

/**
 * Igual que `addWatermark`, pero devuelve los BYTES del PDF resultante (`Uint8Array`) sin pasar por un `Blob`: para quien sigue
 * trabajando con bytes (PDF Pro). Mismos bytes que el `Blob` de `addWatermark`.
 */
export async function addWatermarkToBytes(
  file: File,
  options: WatermarkOptions,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    const text = toWinAnsiSafe(options.text.trim());
    if (options.kind === "text" && text.length === 0) {
      throw new PdfError("empty");
    }
    if (options.kind === "image" && !options.image) {
      throw new PdfError("empty");
    }

    const document = await loadPdf(file);
    onProgress?.(0.15);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    let font: PDFFont | null = null;
    let image: PDFImage | null = null;
    if (options.kind === "text") {
      font = await document.embedFont(
        standardFontFor(options.fontFamily, options.bold, options.italic),
      );
    } else if (options.image) {
      image = await embedImageFile(document, options.image);
    }
    onProgress?.(0.3);

    const color = hexToPdfColor(options.color);
    const opacity = Math.min(1, Math.max(0.02, options.opacity));
    const { from, to } = resolveRange(
      pages.length,
      options.fromPage,
      options.toPage,
    );

    for (let index = from - 1; index <= to - 1; index += 1) {
      const page = pages[index];
      const geometry = getPageGeometry(page);
      // El angulo visible lo elige el usuario; en espacio de usuario hay
      // que compensar el `/Rotate` de la pagina para que se vea asi.
      const userAngle = options.rotation + geometry.rotation;

      const stamp = buildStamp({
        options,
        geometry,
        font,
        image,
        text,
        color,
        opacity,
      });

      const bounds = rotatedBounds(
        stamp.width,
        stamp.height,
        options.rotation,
      );
      const centers = options.tile
        ? tileCenters(geometry, bounds)
        : [anchorCenter(options.anchor, geometry, bounds)];

      for (const center of centers) {
        const userCenter = viewPointToUser(geometry, center.vx, center.vy);
        const origin = originForCenter(
          userCenter.x,
          userCenter.y,
          stamp.width,
          stamp.height,
          stamp.baselineOffset,
          userAngle,
        );
        stamp.draw(page, origin.x, origin.y, userAngle);
      }

      if (options.layer === "under") moveLastContentStreamToBack(page);

      onProgress?.(0.3 + ((index - from + 1) / (to - from + 1)) * 0.65);
    }

    const bytes = await savePdfToBytes(document);
    onProgress?.(1);
    return bytes;
  } catch (error) {
    throw toPdfError(error);
  }
}

function buildStamp(input: {
  options: WatermarkOptions;
  geometry: PageGeometry;
  font: PDFFont | null;
  image: PDFImage | null;
  text: string;
  color: Color;
  opacity: number;
}): Stamp {
  const { options, geometry, font, image, text, color, opacity } = input;

  if (options.kind === "image" && image) {
    const target = Math.max(
      24,
      geometry.viewWidth * Math.min(1, Math.max(0.05, options.imageScale)),
    );
    const ratio = image.height / image.width;
    const width = target;
    const height = target * ratio;
    return {
      width,
      height,
      baselineOffset: 0,
      draw: (page, x, y, angle) => {
        page.drawImage(image, {
          x,
          y,
          width,
          height,
          opacity,
          rotate: degrees(angle),
        });
      },
    };
  }

  if (!font) throw new PdfError("unknown");
  const size = Math.min(400, Math.max(6, options.fontSize));
  const width = font.widthOfTextAtSize(text, size);
  const height = font.heightAtSize(size);
  const baselineOffset = height - font.heightAtSize(size, { descender: false });

  return {
    width,
    height,
    baselineOffset,
    draw: (page, x, y, angle) => {
      page.drawText(text, {
        x,
        y,
        size,
        font,
        color,
        opacity,
        rotate: degrees(angle),
      });
    },
  };
}
