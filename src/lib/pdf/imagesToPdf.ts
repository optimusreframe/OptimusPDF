import { PDFDocument, type PDFImage } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import {
  PdfError,
  readFileBytes,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor "imagenes -> PDF".
 *
 * Modulo puro (sin React) que se ejecuta en el navegador: los bytes de
 * las imagenes nunca salen del dispositivo. `scanToPdf.ts` reutiliza la
 * composicion de paginas de este archivo para las capturas de camara.
 */

/* ------------------------------------------------------------------ *
 * Tipos de layout
 * ------------------------------------------------------------------ */

/** Orientacion de la pagina; `auto` la deduce del lado mayor de la imagen. */
export type ImageOrientation = "portrait" | "landscape" | "auto";

/** `fit` genera una pagina del tamano exacto de la imagen mas el margen. */
export type ImagePageSize = "a4" | "letter" | "fit";

export type ImageMargin = "none" | "small" | "large";

export type ImageLayout = {
  orientation: ImageOrientation;
  pageSize: ImagePageSize;
  margin: ImageMargin;
};

export const DEFAULT_IMAGE_LAYOUT: ImageLayout = {
  orientation: "auto",
  pageSize: "a4",
  margin: "none",
};

/** Puntos PostScript (1 pt = 1/72") de los tamanos estandar en vertical. */
const PAGE_SIZES: Record<Exclude<ImagePageSize, "fit">, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGINS: Record<ImageMargin, number> = {
  none: 0,
  small: 24,
  large: 56,
};

/* ------------------------------------------------------------------ *
 * Utilidades de canvas / decodificacion
 * ------------------------------------------------------------------ */

/**
 * Envuelve `canvas.toBlob` en una promesa. Vive aqui porque es la unica
 * pieza de canvas compartida por los tres motores de conversion
 * (`imagesToPdf`, `pdfToImages` y `scanToPdf`).
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new PdfError("unknown", "canvas.toBlob returned null"));
      },
      type,
      quality,
    );
  });
}

type ImageKind = "jpeg" | "png" | "other";

/** Detecta el formato por los bytes magicos, no por el MIME declarado. */
function detectImageKind(bytes: Uint8Array): ImageKind {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  return "other";
}

/**
 * Reconvierte a PNG cualquier formato que pdf-lib no sabe incrustar
 * (WEBP, AVIF...) usando el decodificador del propio navegador.
 */
async function rasterizeToPng(source: Blob): Promise<Uint8Array> {
  if (typeof createImageBitmap !== "function") {
    throw new PdfError("invalidType");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new PdfError("invalidType");
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bitmap.width);
  canvas.height = Math.max(1, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const png = await canvasToBlob(canvas, "image/png");
  canvas.width = 0;
  canvas.height = 0;
  return readFileBytes(png);
}

/** Incrusta una imagen en el documento eligiendo el embebedor correcto. */
async function embedImage(
  document: PDFDocument,
  source: Blob,
): Promise<PDFImage> {
  const bytes = await readFileBytes(source);
  if (bytes.byteLength === 0) throw new PdfError("invalidType");

  const kind = detectImageKind(bytes);
  try {
    if (kind === "jpeg") return await document.embedJpg(bytes);
    if (kind === "png") return await document.embedPng(bytes);
    return await document.embedPng(await rasterizeToPng(source));
  } catch (error) {
    if (error instanceof PdfError) throw error;
    // pdf-lib lanza errores de parseo propios cuando el archivo miente
    // sobre su formato: para el usuario es simplemente un tipo invalido.
    throw new PdfError("invalidType");
  }
}

/* ------------------------------------------------------------------ *
 * Composicion de paginas
 * ------------------------------------------------------------------ */

type PageBox = { pageWidth: number; pageHeight: number; margin: number };

function resolvePageBox(
  layout: ImageLayout,
  imageWidth: number,
  imageHeight: number,
): PageBox {
  const margin = MARGINS[layout.margin];

  if (layout.pageSize === "fit") {
    // El tamano de pagina lo dicta la imagen: la orientacion ya viene dada.
    return {
      pageWidth: imageWidth + margin * 2,
      pageHeight: imageHeight + margin * 2,
      margin,
    };
  }

  const [shortSide, longSide] = PAGE_SIZES[layout.pageSize];
  const landscape =
    layout.orientation === "landscape" ||
    (layout.orientation === "auto" && imageWidth > imageHeight);

  return {
    pageWidth: landscape ? longSide : shortSide,
    pageHeight: landscape ? shortSide : longSide,
    margin,
  };
}

/** Anade una pagina con la imagen centrada dentro del area util. */
function addImagePage(
  document: PDFDocument,
  image: PDFImage,
  layout: ImageLayout,
): void {
  const imageWidth = Math.max(1, image.width);
  const imageHeight = Math.max(1, image.height);
  const { pageWidth, pageHeight, margin } = resolvePageBox(
    layout,
    imageWidth,
    imageHeight,
  );

  const boxWidth = Math.max(1, pageWidth - margin * 2);
  const boxHeight = Math.max(1, pageHeight - margin * 2);
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;

  const page = document.addPage([pageWidth, pageHeight]);
  page.drawImage(image, {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  });
}

/**
 * Construye un unico PDF con una pagina por imagen. Es el nucleo que
 * comparten la herramienta de imagenes y la de escaneo con camara.
 */
export async function buildPdfFromImages(
  sources: Blob[],
  layout: ImageLayout = DEFAULT_IMAGE_LAYOUT,
  onProgress?: ProgressCallback,
  progressTo = 1,
): Promise<PDFDocument> {
  if (sources.length === 0) throw new PdfError("empty");

  const document = await PDFDocument.create();
  for (let index = 0; index < sources.length; index += 1) {
    const image = await embedImage(document, sources[index]);
    addImagePage(document, image, layout);
    onProgress?.(((index + 1) / sources.length) * progressTo);
  }
  return document;
}

/* ------------------------------------------------------------------ *
 * API de la herramienta
 * ------------------------------------------------------------------ */

export type ImagesToPdfOptions = ImageLayout & {
  /** `true` (por defecto) une todo en un PDF; `false` genera un ZIP. */
  merge: boolean;
  /**
   * Orden e inclusion final de las imagenes, como indices de `files`.
   * Si se omite se usan todas en el orden de subida.
   */
  order?: number[];
};

export const DEFAULT_IMAGES_TO_PDF_OPTIONS: ImagesToPdfOptions = {
  ...DEFAULT_IMAGE_LAYOUT,
  merge: true,
};

export type ImagesToPdfResult = {
  blob: Blob;
  /** `pdf` cuando se unen todas; `zip` cuando hay un PDF por imagen. */
  kind: "pdf" | "zip";
  /** Numero de PDFs generados. */
  count: number;
};

function replaceExtension(filename: string, extension: string): string {
  const dot = filename.lastIndexOf(".");
  const base = (dot > 0 ? filename.slice(0, dot) : filename).trim();
  return `${base || "imagen"}.${extension}`;
}

function resolveOrder(files: File[], order?: number[]): number[] {
  // `undefined` = todavia no hay plan explicito: se usan todas.
  // Un array vacio si es un plan, y significa "no queda ninguna imagen".
  if (!order) return files.map((_, index) => index);
  return order.filter((index) => index >= 0 && index < files.length);
}

/**
 * Convierte imagenes (JPG, PNG y cualquier formato que el navegador sepa
 * decodificar) en PDF. Devuelve un unico documento o un ZIP con un PDF
 * por imagen segun `merge`.
 */
export async function imagesToPdf(
  files: File[],
  options: ImagesToPdfOptions = DEFAULT_IMAGES_TO_PDF_OPTIONS,
  onProgress?: ProgressCallback,
): Promise<ImagesToPdfResult> {
  if (files.length === 0) throw new PdfError("empty");

  const indices = resolveOrder(files, options.order);
  if (indices.length === 0) throw new PdfError("empty");

  const layout: ImageLayout = {
    orientation: options.orientation,
    pageSize: options.pageSize,
    margin: options.margin,
  };

  try {
    if (options.merge) {
      const document = await buildPdfFromImages(
        indices.map((index) => files[index]),
        layout,
        onProgress,
        0.9,
      );
      const blob = await savePdfToBlob(document);
      onProgress?.(1);
      return { blob, kind: "pdf", count: 1 };
    }

    const zip = new JSZip();
    const used = new Set<string>();

    for (let position = 0; position < indices.length; position += 1) {
      const file = files[indices[position]];
      const document = await buildPdfFromImages([file], layout);
      const pdf = await savePdfToBlob(document);

      let name = replaceExtension(file.name, "pdf");
      let duplicate = 2;
      while (used.has(name.toLowerCase())) {
        name = replaceExtension(`${file.name}-${duplicate}`, "pdf");
        duplicate += 1;
      }
      used.add(name.toLowerCase());
      zip.file(name, pdf);

      onProgress?.(((position + 1) / indices.length) * 0.9);
    }

    // Sin compresion: un PDF ya viene comprimido y el ZIP solo agrupa.
    const blob = await zip.generateAsync({ type: "blob" });
    onProgress?.(1);
    return { blob, kind: "zip", count: indices.length };
  } catch (error) {
    throw toPdfError(error);
  }
}
