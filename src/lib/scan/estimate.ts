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
/** Correccion del modelo de recodificado de JPEG (estimado / real medio = 0,91 con 13 fotos reales y los presets Alta, Equilibrada y Compacta). */
export const TRANSCODE_BIAS = 1.09;
/**
 * Regla del 15 % de `prepareForPdf`: se recodifica solo si el resultado pesa >= 15 % menos; si no, se conserva el archivo. Cuando
 * el ahorro previsto cae cerca de ese umbral (Alta: ~18-22 %), el resultado REAL depende del codificador del navegador (en
 * Chromium sale recodificado, en WebKit suele quedar el original): la estimacion da el valor esperado, no un extremo.
 */
export const KEEP_RULE_START = 0.7;
export const KEEP_RULE_SPAN = 0.15;
export const KEEP_RULE_MAX_WEIGHT = 0.8;
const LOW = 0.8;
const HIGH = 1.3;

function kindOf(blob: Blob): ImageHeader["kind"] {
  if (blob.type === "image/png") return "png";
  if (blob.type === "image/webp") return "webp";
  return "jpeg";
}

function headerFor(width: number, height: number, kind: ImageHeader["kind"] = "jpeg"): ImageHeader {
  return { kind, width, height, displayWidth: width, displayHeight: height, orientation: 1, mayHaveAlpha: kind !== "jpeg" };
}

/** Exponente con el que baja el peso por pixel al subir la resolucion (calibrado con documentos y fotos en Chromium y WebKit). */
export const SAMPLE_BPP_EXPONENT = 0.5;

/**
 * ¿El resultado de esta pagina ES su original (sin recodificar)? Sin recorte, sin giro, sin ajuste y con un filtro que no
 * toca los pixeles (`original`/`color`; modo `photo` siempre). Es lo que hace `renderPage` (passthrough).
 */
export function isIdentityPage(page: ScanPage): boolean {
  const mode = page.mode ?? "document";
  const cropped = mode !== "photo" && !!page.corners && !isDegenerateQuad(page.corners) && !isFullFrameQuad(page.corners);
  if (cropped || page.rotation !== 0 || page.adjust.brightness !== 0 || page.adjust.contrast !== 0) return false;
  if (mode === "photo") return true;
  const filter = page.resolvedFilter ?? page.filter;
  return filter === "original" || filter === "color";
}

/** Dimensiones y peso previstos del resultado de esta pagina (el que se incrustara en el PDF). */
export function expectedProcessed(page: ScanPage): { width: number; height: number; bytes: number; kind: ImageHeader["kind"] } {
  if (page.processed && page.processedSize) return { ...page.processedSize, bytes: page.processed.size, kind: kindOf(page.processed) };
  const full = { width: Math.max(1, page.originalWidth), height: Math.max(1, page.originalHeight) };
  if (isIdentityPage(page)) return { ...full, bytes: page.original.size, kind: kindOf(page.original) };
  let width = full.width;
  let height = full.height;
  const mode = page.mode ?? "document";
  if (mode !== "photo" && page.corners && !isDegenerateQuad(page.corners) && !isFullFrameQuad(page.corners)) {
    ({ width, height } = quadOutputSize(rotateQuad(page.corners, page.rotation / 90), full.width, full.height));
  } else if (page.rotation % 180 !== 0) {
    [width, height] = [height, width];
  }
  const fitted = fitSide(width, height, PROCESSED_MAX_SIDE);
  const pixels = fitted.width * fitted.height;
  let bytes: number;
  if (page.jpegSample) {
    // Peso por pixel medido a resolucion NATIVA en un parche del resultado (con su filtro): al reducir (`scale` < 1) el detalle se
    // concentra y el peso por pixel SUBE.
    bytes = page.jpegSample.bytesPerPixel * fitted.scale ** -SAMPLE_BPP_EXPONENT * pixels;
  } else {
    // Sin muestra: un JPEG de escaner pesa del orden de 0,35 bytes/pixel a calidad 0,9.
    const ratio = pixels / (full.width * full.height);
    bytes = Math.max(20_000, Math.min(page.original.size * Math.min(1, ratio) * 0.9, pixels * 0.5));
  }
  return { width: fitted.width, height: fitted.height, bytes, kind: "jpeg" };
}

export function estimateScanSize(pages: readonly ScanPage[], options: { preset: string; searchable: boolean }): ScanSizeEstimate {
  const presetId = isImagePresetId(options.preset) ? options.preset : DEFAULT_IMAGE_PRESET;
  const preset = IMAGE_PRESETS[presetId];
  let total = 0;
  for (const page of pages) {
    const expected = expectedProcessed(page);
    // La politica y el modelo de `prepareForPdf` (Original conserva el archivo; el resto, solo si ahorra >= 15 %).
    const { optimized: modelled } = estimatePreparedBytes(headerFor(expected.width, expected.height, expected.kind), expected.bytes, preset);
    // El modelo de `prepareForPdf` se queda corto ~9 % cuando recodifica un JPEG (medido con fotos reales en los tres presets).
    let optimized = modelled < expected.bytes ? Math.min(expected.bytes, modelled * TRANSCODE_BIAS) : modelled;
    if (optimized < expected.bytes) {
      const ratio = optimized / expected.bytes;
      const keepWeight = KEEP_RULE_MAX_WEIGHT * Math.min(1, Math.max(0, (ratio - KEEP_RULE_START) / KEEP_RULE_SPAN));
      optimized = expected.bytes * (ratio + (1 - ratio) * keepWeight);
    }
    total += optimized + PAGE_OVERHEAD_BYTES + (options.searchable ? SEARCHABLE_BYTES_PER_PAGE : 0);
  }
  const bytes = Math.round(total);
  return { bytes, low: Math.round(bytes * LOW), high: Math.round(bytes * HIGH) };
}
