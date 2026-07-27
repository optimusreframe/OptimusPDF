import { PDFDocument } from "@cantoo/pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  readFileBytes,
  renderPageToCanvas,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/imagesToPdf";

/**
 * Motor de compresion.
 *
 * Estrategia honesta y 100% local: cada pagina se rasteriza con pdf.js a
 * una resolucion dada, se re-codifica como JPEG y se vuelve a montar un
 * PDF nuevo con esa imagen ocupando exactamente el tamano original de la
 * pagina.
 *
 * CONSECUENCIA REAL: el documento resultante es una secuencia de
 * imagenes. El texto deja de ser seleccionable, buscable y accesible, y
 * los enlaces, formularios y marcadores desaparecen. Es la unica via
 * fiable de reducir peso sin servidor, y la interfaz lo dice sin
 * adornos. Para documentos de texto puro el resultado puede pesar MAS
 * que el original: se devuelven siempre los tamanos reales para que la
 * interfaz lo muestre tal cual.
 *
 * El render usa SIEMPRE `intent: "print"`: con `"display"` pdf.js
 * encadena los pasos con `requestAnimationFrame` y el proceso se congela
 * si la pestana deja de pintar.
 */

export const COMPRESSION_LEVELS = ["extreme", "recommended", "low"] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number];

export type CompressionPreset = {
  /** Multiplicador de resolucion sobre el tamano de pagina (1 ~ 72 DPI). */
  scale: number;
  /** Calidad JPEG 0..1. */
  quality: number;
};

export const COMPRESSION_PRESETS: Record<CompressionLevel, CompressionPreset> = {
  extreme: { scale: 1, quality: 0.5 },
  recommended: { scale: 1.5, quality: 0.75 },
  low: { scale: 2, quality: 0.9 },
};

export type CompressOptions = {
  level: CompressionLevel;
};

export const DEFAULT_COMPRESS_OPTIONS: CompressOptions = {
  level: "recommended",
};

export type CompressResult = {
  blob: Blob;
  /** Peso del archivo de entrada, en bytes. */
  originalSize: number;
  /** Peso del archivo generado, en bytes. */
  compressedSize: number;
  pages: number;
};

/**
 * Lado maximo del canvas por pagina. Los navegadores limitan el area de
 * un canvas (Safari iOS es el mas estricto) y una pagina A0 a 2x se
 * saldria del limite: se recorta la escala antes de rasterizar.
 */
const MAX_RASTER_SIDE = 4000;

function presetFor(level: CompressionLevel): CompressionPreset {
  return COMPRESSION_PRESETS[level] ?? COMPRESSION_PRESETS.recommended;
}

/** Porcentaje de reduccion (negativo si el resultado pesa mas). */
export function reductionPercent(original: number, compressed: number): number {
  if (!Number.isFinite(original) || original <= 0) return 0;
  return Math.round(((original - compressed) / original) * 100);
}

export async function compressPdf(
  file: File,
  options: CompressOptions = DEFAULT_COMPRESS_OPTIONS,
  onProgress?: ProgressCallback,
): Promise<CompressResult> {
  const preset = presetFor(options.level);
  const originalSize = file.size;

  let source: PDFDocumentProxy | null = null;
  try {
    source = await openPdfDocument(file);
    const total = source.numPages;
    if (total === 0) throw new PdfError("corrupt");

    const output = await PDFDocument.create();

    for (let index = 0; index < total; index += 1) {
      const page = await source.getPage(index + 1);
      // Viewport a escala 1: ancho y alto en puntos PDF, con la
      // rotacion de la pagina ya aplicada.
      const base = page.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height, 1);
      const scale = Math.max(
        0.1,
        Math.min(preset.scale, MAX_RASTER_SIDE / longest),
      );

      const canvas = await renderPageToCanvas(page, {
        scale,
        // Obligatorio: rasterizado fuera de pantalla.
        intent: "print",
      });
      const jpeg = await canvasToBlob(canvas, "image/jpeg", preset.quality);
      // Libera la memoria del canvas antes de la siguiente pagina.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();

      const image = await output.embedJpg(await readFileBytes(jpeg));
      const target = output.addPage([base.width, base.height]);
      target.drawImage(image, {
        x: 0,
        y: 0,
        width: base.width,
        height: base.height,
      });

      onProgress?.(((index + 1) / total) * 0.92);
    }

    const blob = await savePdfToBlob(output);
    onProgress?.(1);

    return {
      blob,
      originalSize,
      compressedSize: blob.size,
      pages: total,
    };
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (source) await closePdfDocument(source);
  }
}
