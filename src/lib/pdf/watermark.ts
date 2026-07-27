import {
  PDFArray,
  StandardFonts,
  degrees,
  rgb,
  type Color,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  readFileBytes,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de marca de agua (texto o imagen) y utilidades de geometria de
 * pagina compartidas por el resto de motores de edicion.
 *
 * NOTA DE UBICACION: `getPageGeometry`, `viewPointToUser` y
 * `originForCenter` son genericas y su sitio natural seria
 * `lib/pdf/core.ts`, pero ese archivo queda fuera del alcance de este
 * workstream. Se exportan desde aqui y se importan desde `pageNumbers.ts`,
 * `crop.ts` y `sign.ts`. Extraerlas a `core.ts` es una tarea de limpieza
 * posterior.
 */

/* ------------------------------------------------------------------ *
 * Geometria de pagina (compartida)
 * ------------------------------------------------------------------ */

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Relacion entre el espacio de usuario del PDF (origen abajo-izquierda,
 * sin rotacion aplicada) y el espacio "de vista": lo que el lector
 * muestra en pantalla despues de aplicar `/Rotate`, tambien con origen
 * abajo-izquierda.
 */
export type PageGeometry = {
  /** CropBox en espacio de usuario (o MediaBox si no hay CropBox). */
  box: Box;
  /** `/Rotate` normalizado a 0, 90, 180 o 270 grados (horario). */
  rotation: number;
  /** Ancho tal y como lo ve el usuario. */
  viewWidth: number;
  /** Alto tal y como lo ve el usuario. */
  viewHeight: number;
};

function normalizeAngle(angle: number): number {
  const value = Math.round(angle / 90) * 90;
  return ((value % 360) + 360) % 360;
}

export function getPageGeometry(page: PDFPage): PageGeometry {
  const box = page.getCropBox();
  const rotation = normalizeAngle(page.getRotation().angle);
  const swapped = rotation === 90 || rotation === 270;
  return {
    box,
    rotation,
    viewWidth: swapped ? box.height : box.width,
    viewHeight: swapped ? box.width : box.height,
  };
}

/**
 * Convierte un punto del espacio de vista (lo que el usuario ve) al
 * espacio de usuario del PDF, deshaciendo `/Rotate`.
 */
export function viewPointToUser(
  geometry: PageGeometry,
  vx: number,
  vy: number,
): { x: number; y: number } {
  const { box, rotation } = geometry;
  switch (rotation) {
    case 90:
      return { x: box.x + box.width - vy, y: box.y + vx };
    case 180:
      return { x: box.x + box.width - vx, y: box.y + box.height - vy };
    case 270:
      return { x: box.x + vy, y: box.y + box.height - vx };
    default:
      return { x: box.x + vx, y: box.y + vy };
  }
}

/**
 * Convierte un rectangulo normalizado (0..1) medido sobre la vista
 * renderizada, con origen ARRIBA-izquierda como en el DOM, en la caja
 * equivalente del espacio de usuario del PDF.
 */
export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function normalizedRectToUserBox(
  geometry: PageGeometry,
  rect: NormalizedRect,
): Box {
  const vx = rect.x * geometry.viewWidth;
  const vw = rect.width * geometry.viewWidth;
  // El DOM mide desde arriba; el espacio de vista, desde abajo.
  const vy = (1 - rect.y - rect.height) * geometry.viewHeight;
  const vh = rect.height * geometry.viewHeight;

  const corners = [
    viewPointToUser(geometry, vx, vy),
    viewPointToUser(geometry, vx + vw, vy),
    viewPointToUser(geometry, vx, vy + vh),
    viewPointToUser(geometry, vx + vw, vy + vh),
  ];

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/**
 * Punto de dibujo (`x`/`y` de pdf-lib) para que un elemento de tamano
 * `width` x `height` quede centrado en (`cx`, `cy`) despues de rotarlo
 * `angle` grados en sentido antihorario alrededor de ese mismo punto de
 * dibujo. `baselineOffset` es la distancia entre el borde inferior de la
 * caja y el origen de dibujo (0 para imagenes, el descendente para texto).
 */
export function originForCenter(
  cx: number,
  cy: number,
  width: number,
  height: number,
  baselineOffset: number,
  angle: number,
): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = width / 2;
  const localY = height / 2 - baselineOffset;
  return {
    x: cx - (localX * cos - localY * sin),
    y: cy - (localX * sin + localY * cos),
  };
}

/** Tamano de la caja envolvente de un rectangulo `w` x `h` rotado. */
export function rotatedBounds(
  width: number,
  height: number,
  angle: number,
): { width: number; height: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };
}

/* ------------------------------------------------------------------ *
 * Tipografia y color (compartido con pageNumbers.ts)
 * ------------------------------------------------------------------ */

export type PdfFontFamily = "helvetica" | "times" | "courier";

export const PDF_FONT_FAMILIES: readonly PdfFontFamily[] = [
  "helvetica",
  "times",
  "courier",
] as const;

export function standardFontFor(
  family: PdfFontFamily,
  bold: boolean,
  italic: boolean,
): StandardFonts {
  if (family === "times") {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === "courier") {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/**
 * Tintas disponibles para texto del documento. NO son tokens de la
 * interfaz: son datos que el usuario elige y que acaban impresos en el
 * PDF, por eso viven aqui como valores hexadecimales y no en el CSS.
 */
export const INK_COLORS = [
  "#000000",
  "#5b6470",
  "#c0c6cf",
  "#0d4bff",
  "#0f9d68",
  "#e11d48",
  "#f59e0b",
  "#ffffff",
] as const;

export type InkColor = (typeof INK_COLORS)[number];

export function hexToPdfColor(hex: string): Color {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => char + char)
          .join("")
      : clean;
  const value = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(value)) return rgb(0, 0, 0);
  return rgb(
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  );
}

/**
 * Los tipos estandar de PDF solo codifican WinAnsi. Se sustituye todo lo
 * que quede fuera para que un caracter exotico no aborte el proceso
 * entero (los acentos del espanol si estan cubiertos).
 */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function toWinAnsiSafe(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 10 || code === 13) {
      out += " ";
    } else if ((code >= 32 && code <= 255) || WIN_ANSI_EXTRA.has(code)) {
      out += char;
    } else {
      out += "?";
    }
  }
  return out;
}

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

async function embedImageFile(
  document: PDFDocument,
  file: File,
): Promise<PDFImage> {
  const bytes = await readFileBytes(file);
  if (bytes.byteLength < 4) throw new PdfError("invalidType");
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

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
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
