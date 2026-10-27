import { DEFAULT_IMAGE_PRESET, IMAGE_PRESETS, estimatePreparedBytes, isImagePresetId, type ImageHeader } from "@/lib/image/prepareForPdf";
import { fitSide } from "@/lib/scan/pixels";
import { isDegenerateQuad, isFullFrameQuad, quadOutputSize } from "@/lib/scan/perspective";
import { rotateQuad } from "@/lib/scan/renderCore";
import type { ScanPage, ScanSizeEstimate } from "@/lib/scan/types";

/**
 * Estimacion RAPIDA (sincrona, sin decodificar) del peso del PDF: usa las dimensiones y el peso del resultado procesado (o,
 * si aun no existe, las del recorte previsto sobre el original) con la misma politica de `prepareForPdf` que el motor real
 * (`estimatePreparedBytes`). Es una ESTIMACION: la interfaz la muestra con «≈».
 */

/** Lado largo maximo del resultado procesado (A4 a 300 ppp). */
export const PROCESSED_MAX_SIDE = 3508;
const PAGE_OVERHEAD_BYTES = 2048;
/** Texto buscable: bytes aproximados que anade el OCR por pagina (capa de texto + fuente). */
const SEARCHABLE_BYTES_PER_PAGE = 2500;
const LOW = 0.8;
const HIGH = 1.3;

function headerFor(width: number, height: number): ImageHeader {
  return { kind: "jpeg", width, height, displayWidth: width, displayHeight: height, orientation: 1, mayHaveAlpha: false };
}

/** Dimensiones y peso previstos del JPEG que saldra de esta pagina. */
export function expectedProcessed(page: ScanPage): { width: number; height: number; bytes: number } {
  if (page.processed && page.processedSize) return { ...page.processedSize, bytes: page.processed.size };
  const full = { width: Math.max(1, page.originalWidth), height: Math.max(1, page.originalHeight) };
  let width = full.width;
  let height = full.height;
  const mode = page.mode ?? "document";
  if (mode !== "photo" && page.corners && !isDegenerateQuad(page.corners) && !isFullFrameQuad(page.corners)) {
    ({ width, height } = quadOutputSize(rotateQuad(page.corners, page.rotation / 90), full.width, full.height));
  } else if (page.rotation % 180 !== 0) {
    [width, height] = [height, width];
  }
  const fitted = fitSide(width, height, PROCESSED_MAX_SIDE);
  const ratio = (fitted.width * fitted.height) / (full.width * full.height);
  // Un JPEG de escaner (texto sobre papel) pesa del orden de 0,35 bytes/pixel a calidad 0,9; la foto original trae mas.
  const bytes = page.processed ? page.processed.size : Math.max(20_000, Math.min(page.original.size * Math.min(1, ratio) * 0.9, fitted.width * fitted.height * 0.5));
  return { width: fitted.width, height: fitted.height, bytes };
}

export function estimateScanSize(pages: readonly ScanPage[], options: { preset: string; searchable: boolean }): ScanSizeEstimate {
  const presetId = isImagePresetId(options.preset) ? options.preset : DEFAULT_IMAGE_PRESET;
  const preset = IMAGE_PRESETS[presetId];
  let total = 0;
  for (const page of pages) {
    const expected = expectedProcessed(page);
    const { optimized } = estimatePreparedBytes(headerFor(expected.width, expected.height), expected.bytes, preset);
    total += optimized + PAGE_OVERHEAD_BYTES + (options.searchable ? SEARCHABLE_BYTES_PER_PAGE : 0);
  }
  const bytes = Math.round(total);
  return { bytes, low: Math.round(bytes * LOW), high: Math.round(bytes * HIGH) };
}
