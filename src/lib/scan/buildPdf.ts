import { StandardFonts } from "@cantoo/pdf-lib";
import { DEFAULT_IMAGE_PRESET, isImagePresetId, type ImagePresetId } from "@/lib/image/prepareForPdf";
import { PdfError, savePdfToBlob, throwIfAborted, toPdfError } from "@/lib/pdf/core";
import { buildPdfFromImages } from "@/lib/pdf/imagesToPdf";
import type { OcrResult } from "@/lib/scan/ocr";
import { drawTextLayer, marginPoints } from "@/lib/scan/textLayer";
import type { ScanPage, ScanSession } from "@/lib/scan/types";

/**
 * PDF final del Escaner: una pagina por hoja (A4 / Carta / Ajustar con margen) con las imagenes ya procesadas, preparadas con
 * los presets de `src/lib/image/*` (Original / Alta / Equilibrada / Compacta), y, si se pide, una capa de texto invisible por
 * pagina (OCR local). Progreso por pagina (`onProgress(hecho, total)`) y cancelable (`AbortSignal`) en cada paso.
 *
 * Pasos por pagina (la unidad de `onProgress`): 1) procesar (si aun no hay resultado), 2) incrustar, 3) OCR (opcional).
 */

export type BuildPdfOptions = {
  preset: string;
  pageSize: "a4" | "letter" | "fit";
  margin: "none" | "small" | "large";
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
};

export type BuildPdfDeps = {
  /** Resultado procesado de la pagina (lo calcula si falta). */
  processedBlob(page: ScanPage, signal?: AbortSignal): Promise<Blob>;
  /** OCR del resultado procesado de la pagina (solo con texto buscable). */
  recognize(processed: Blob, signal?: AbortSignal): Promise<OcrResult>;
};

export async function buildScanPdf(session: ScanSession, options: BuildPdfOptions, deps: BuildPdfDeps): Promise<Blob> {
  const pages = session.pages;
  if (pages.length === 0) throw new PdfError("empty");
  const searchable = session.settings.searchable;
  const preset: ImagePresetId = isImagePresetId(options.preset) ? options.preset : DEFAULT_IMAGE_PRESET;
  const steps = searchable ? 3 : 2;
  const total = pages.length * steps;
  let done = 0;
  const tick = () => options.onProgress?.(Math.min(total, ++done), total);
  const { signal } = options;
  options.onProgress?.(0, total);

  try {
    const blobs: Blob[] = [];
    for (const page of pages) {
      throwIfAborted(signal);
      blobs.push(await deps.processedBlob(page, signal));
      tick();
    }
    throwIfAborted(signal);
    const document = await buildPdfFromImages(
      blobs,
      { orientation: "auto", pageSize: options.pageSize, margin: options.margin },
      undefined,
      1,
      {
        preset,
        signal,
        onPhotoStart: (position) => {
          // Cada foto que empieza cierra la anterior: la ultima se cierra al terminar.
          if (position > 1) tick();
        },
      },
    );
    tick();
    if (searchable) {
      const font = await document.embedFont(StandardFonts.Helvetica);
      const margin = marginPoints(options.margin);
      const docPages = document.getPages();
      for (let index = 0; index < blobs.length; index += 1) {
        throwIfAborted(signal);
        const ocr = await deps.recognize(blobs[index], signal);
        throwIfAborted(signal);
        drawTextLayer(docPages[index], font, ocr, margin);
        tick();
      }
    }
    throwIfAborted(signal);
    return await savePdfToBlob(document);
  } catch (error) {
    throw toPdfError(error);
  }
}
