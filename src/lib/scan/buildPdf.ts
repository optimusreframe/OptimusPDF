import { StandardFonts } from "@cantoo/pdf-lib";
import { DEFAULT_IMAGE_PRESET, isImagePresetId, type ImagePresetId } from "@/lib/image/prepareForPdf";
import { PdfError, savePdfToBlob, throwIfAborted, toPdfError } from "@/lib/pdf/core";
import { buildPdfFromImages } from "@/lib/pdf/imagesToPdf";
import type { OcrResult } from "@/lib/scan/ocr";
import { drawTextLayer, marginPoints } from "@/lib/scan/textLayer";
import type { ScanBuildWarning, ScanPage, ScanSession } from "@/lib/scan/types";

/**
 * PDF final del Escaner: una pagina por hoja (A4 / Carta / Ajustar con margen) con las imagenes ya procesadas, preparadas con
 * los presets de `src/lib/image/*` (Original / Alta / Equilibrada / Compacta), y, si se pide, una capa de texto invisible por
 * pagina (OCR local). Progreso por pagina (`onProgress(hecho, total)`) y cancelable (`AbortSignal`) en cada paso.
 *
 * Pasos por pagina (la unidad de `onProgress`): 1) procesar (si aun no hay resultado), 2) incrustar, 3) OCR (opcional).
 *
 * El texto buscable DEGRADA, no falla: si el modelo de OCR no esta en local y no se autorizo descargarlo, o la descarga o el
 * reconocimiento fallan, se entrega el PDF normal (con el texto de las paginas que si se leyeron) y se avisa por `onWarning`.
 * Solo la cancelacion interrumpe.
 */

export type BuildPdfOptions = {
  preset: string;
  pageSize: "a4" | "letter" | "fit";
  margin: "none" | "small" | "large";
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  allowModelDownload?: boolean;
  onWarning?: (warning: ScanBuildWarning) => void;
};

export type BuildPdfDeps = {
  /** Resultado procesado de la pagina (lo calcula si falta). */
  processedBlob(page: ScanPage, signal?: AbortSignal): Promise<Blob>;
  /** ¿Se puede usar el OCR? (modelo en local, o permiso para descargarlo y conexion). Nunca toca la red. */
  ocrGate(allowDownload: boolean): Promise<{ ok: true } | { ok: false; reason: "model-missing" | "offline" }>;
  /** OCR del resultado procesado de la pagina (solo con texto buscable). */
  recognize(processed: Blob, signal?: AbortSignal): Promise<OcrResult>;
};

export async function buildScanPdf(session: ScanSession, options: BuildPdfOptions, deps: BuildPdfDeps): Promise<Blob> {
  const pages = session.pages;
  if (pages.length === 0) throw new PdfError("empty");
  let searchable = session.settings.searchable;
  const preset: ImagePresetId = isImagePresetId(options.preset) ? options.preset : DEFAULT_IMAGE_PRESET;
  const steps = searchable ? 3 : 2;
  const total = pages.length * steps;
  let done = 0;
  const tick = () => options.onProgress?.(Math.min(total, ++done), total);
  const { signal } = options;
  options.onProgress?.(0, total);

  const warn = (reason: ScanBuildWarning["reason"], pagesWithText: number): void =>
    options.onWarning?.({ code: "searchable-unavailable", reason, pagesWithText, total: pages.length });

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
      const gate = await deps.ocrGate(options.allowModelDownload === true);
      if (!gate.ok) {
        searchable = false;
        warn(gate.reason, 0);
        for (let index = 0; index < blobs.length; index += 1) tick();
      }
    }
    if (searchable) {
      const font = await document.embedFont(StandardFonts.Helvetica);
      const margin = marginPoints(options.margin);
      const docPages = document.getPages();
      let withText = 0;
      for (let index = 0; index < blobs.length; index += 1) {
        throwIfAborted(signal);
        let ocr: OcrResult;
        try {
          ocr = await deps.recognize(blobs[index], signal);
        } catch (error) {
          throwIfAborted(signal);
          if (error instanceof Error && error.name === "AbortError") throw error;
          // El OCR no se pudo hacer (sin red para el modelo, motor roto): se entrega el PDF sin el texto que falte.
          const code = (error as { code?: unknown } | null)?.code;
          warn(code === "ocrNetworkFailure" ? "network" : "engine", withText);
          for (let rest = index; rest < blobs.length; rest += 1) tick();
          break;
        }
        throwIfAborted(signal);
        drawTextLayer(docPages[index], font, ocr, margin);
        withText += 1;
        tick();
      }
    }
    throwIfAborted(signal);
    return await savePdfToBlob(document);
  } catch (error) {
    throw toPdfError(error);
  }
}
