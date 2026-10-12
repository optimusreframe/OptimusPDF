import JSZip from "jszip";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  renderPageToCanvas,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/imagesToPdf";

/**
 * Motor "PDF -> imagenes".
 *
 * Rasteriza cada pagina con pdf.js sobre un canvas y la exporta a JPG.
 * El render usa SIEMPRE `intent: "print"`: con `"display"` pdf.js encadena
 * los pasos con `requestAnimationFrame` y el proceso se congela si la
 * pestana deja de pintar, que es justo lo que pasa en un rasterizado
 * masivo fuera de pantalla.
 */

export const JPG_QUALITY_MIN = 0.5;
export const JPG_QUALITY_MAX = 1;
export const JPG_QUALITY_DEFAULT = 0.92;

/** Multiplicadores de resolucion ofrecidos en la interfaz. */
export const PDF_TO_IMAGE_SCALES = [1, 2, 3] as const;
export type PdfToImageScale = (typeof PDF_TO_IMAGE_SCALES)[number];

export type PdfToImageFormat = "jpg" | "png";

export type PdfToImagesOptions = {
  /** Formato de salida (por defecto JPG: la herramienta suelta no lo cambia). PNG ignora `quality`. */
  format?: PdfToImageFormat;
  /** Calidad JPEG 0.5..1. */
  quality: number;
  /** Escala de render: 1x ~ 72 DPI, 2x ~ 144 DPI, 3x ~ 216 DPI. */
  scale: PdfToImageScale;
  /**
   * Indices de pagina (base 0) a exportar. Vacio o ausente = todas.
   */
  pages?: number[];
  /** Prefijo de los archivos dentro del ZIP (lo traduce la interfaz). */
  namePrefix?: string;
};

export const DEFAULT_PDF_TO_IMAGES_OPTIONS: PdfToImagesOptions = {
  quality: JPG_QUALITY_DEFAULT,
  scale: 2,
  namePrefix: "pagina",
};

export type PdfToImagesResult = {
  blob: Blob;
  /** `jpg`/`png` cuando solo hay una pagina; `zip` cuando hay varias. */
  kind: "jpg" | "png" | "zip";
  /** Numero de imagenes generadas. */
  count: number;
};

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return JPG_QUALITY_DEFAULT;
  return Math.min(JPG_QUALITY_MAX, Math.max(JPG_QUALITY_MIN, value));
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.min(3, Math.max(1, Math.round(value)));
}

function resolvePages(total: number, pages?: number[]): number[] {
  if (!pages || pages.length === 0) {
    return Array.from({ length: total }, (_, index) => index);
  }
  const unique = Array.from(new Set(pages));
  return unique
    .filter((index) => Number.isInteger(index) && index >= 0 && index < total)
    .sort((a, b) => a - b);
}

/** `3` con `total = 12` -> `"03"`. */
function padIndex(value: number, total: number): string {
  return String(value).padStart(String(total).length, "0");
}

/**
 * Convierte un PDF en imagenes JPG. Devuelve la imagen suelta cuando solo
 * se exporta una pagina y un ZIP cuando son varias.
 */
export async function pdfToImages(
  file: Blob,
  options: PdfToImagesOptions = DEFAULT_PDF_TO_IMAGES_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<PdfToImagesResult> {
  const quality = clampQuality(options.quality);
  const format: PdfToImageFormat = options.format === "png" ? "png" : "jpg";
  const scale = clampScale(options.scale);
  const prefix = options.namePrefix?.trim() || "pagina";

  let document: PDFDocumentProxy | null = null;
  try {
    document = await openPdfDocument(file);
    const indices = resolvePages(document.numPages, options.pages);
    if (indices.length === 0) throw new PdfError("empty");

    const images: { name: string; blob: Blob }[] = [];

    for (let position = 0; position < indices.length; position += 1) {
      // Cancelacion real: entre pagina y pagina (cada pagina es una unidad corta).
      if (signal?.aborted) throw new PdfError("cancelled");
      const pageNumber = indices[position] + 1;
      const page = await document.getPage(pageNumber);
      const canvas = await renderPageToCanvas(page, {
        scale,
        // Obligatorio: rasterizado fuera de pantalla.
        intent: "print",
      });
      const blob =
        format === "png"
          ? await canvasToBlob(canvas, "image/png")
          : await canvasToBlob(canvas, "image/jpeg", quality);
      // Libera la memoria del canvas antes de pasar a la siguiente pagina.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();

      images.push({
        name: `${prefix}-${padIndex(pageNumber, document.numPages)}.${format}`,
        blob,
      });
      onProgress?.(((position + 1) / indices.length) * 0.9);
    }

    if (images.length === 1) {
      onProgress?.(1);
      return { blob: images[0].blob, kind: format, count: 1 };
    }

    const zip = new JSZip();
    for (const image of images) zip.file(image.name, image.blob);
    // Los JPG ya estan comprimidos: el ZIP solo agrupa.
    const blob = await zip.generateAsync({ type: "blob" });
    onProgress?.(1);
    return { blob, kind: "zip", count: images.length };
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (document) await closePdfDocument(document);
  }
}
