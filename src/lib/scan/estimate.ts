import { DEFAULT_IMAGE_PRESET, IMAGE_PRESETS, MIN_SAVING, estimatePreparedBytes, fitWithin, isImagePresetId, planPreparation, type ImageHeader, type ImagePreset } from "@/lib/image/prepareForPdf";
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
 * Banda alrededor del umbral del 15 % (relacion recodificado / original) donde el resultado real es incierto: por debajo de
 * `below` se estima lo recodificado, por encima de `above` el original, y entre medias una mezcla. Con la medida de la propia pagina
 * (`SAMPLE_KEEP_BAND`) la banda es estrecha; con el modelo aproximado de una foto sin medir (`MODEL_KEEP_BAND`) es ancha y sesgada
 * hacia el original (mejor decir de mas que de menos).
 */
export type KeepBand = { below: number; above: number };
export const SAMPLE_KEEP_BAND: KeepBand = { below: 0.04, above: 0.04 };
export const MODEL_KEEP_BAND: KeepBand = { below: 0.15, above: 0.02 };
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
/** Sesgo hacia arriba de la muestra (49 parches): con documentos reales y sinteticos queda entre -7 % y +9 %; mejor decir de mas que de menos. */
export const SAMPLE_BIAS = 1.08;

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
export function expectedProcessed(page: ScanPage): { width: number; height: number; bytes: number; kind: ImageHeader["kind"]; qualityRatio?: Record<string, number> } {
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
    bytes = page.jpegSample.bytesPerPixel * fitted.scale ** -SAMPLE_BPP_EXPONENT * pixels * SAMPLE_BIAS;
  } else {
    // Sin muestra: un JPEG de escaner pesa del orden de 0,35 bytes/pixel a calidad 0,9.
    const ratio = pixels / (full.width * full.height);
    bytes = Math.max(20_000, Math.min(page.original.size * Math.min(1, ratio) * 0.9, pixels * 0.5));
  }
  return { width: fitted.width, height: fitted.height, bytes, kind: "jpeg", ...(page.jpegSample?.qualityRatio ? { qualityRatio: page.jpegSample.qualityRatio } : {}) };
}

/** Peso relativo de un JPEG a la calidad del preset frente a 0,9 cuando la pagina no trae medida propia (contenido tipico). */
const FALLBACK_QUALITY_RATIO: Record<string, number> = { "0.92": 1.12, "0.87": 0.86, "0.8": 0.66 };

/**
 * Regla del 15 % de `prepareForPdf` (recodificar solo si el resultado pesa >= 15 % menos). Cerca del umbral el resultado real
 * depende del codificador del navegador (en Chromium sale recodificado, en WebKit suele quedar el original): se estima el valor
 * esperado, con un sesgo hacia arriba (mejor decir de mas que de menos).
 */
export function blendKeepRule(original: number, encoded: number, band: KeepBand = MODEL_KEEP_BAND): number {
  const ratio = encoded / original;
  if (ratio >= 1) return original;
  const threshold = 1 - MIN_SAVING;
  const low = threshold - band.below;
  const high = threshold + band.above;
  if (ratio <= low) return encoded;
  if (ratio >= high) return original;
  const kept = (ratio - low) / (high - low);
  return encoded * (1 - kept) + original * kept;
}

function estimateFromSample(header: ImageHeader, bytes: number, preset: ImagePreset, qualityRatio: Record<string, number>): number {
  const plan = planPreparation(header, bytes, preset);
  if (plan.action === "keep") return bytes;
  const width = header.displayWidth ?? header.width ?? 1;
  const height = header.displayHeight ?? header.height ?? 1;
  const out = fitWithin(width, height, plan.maxSide, plan.maxPixels);
  const shrink = out.width / Math.max(1, width);
  const ratio = qualityRatio[String(preset.quality)] ?? FALLBACK_QUALITY_RATIO[String(preset.quality)] ?? 1;
  // Pixeles ~ shrink^2 y peso por pixel ~ shrink^-0,5 (el detalle se concentra al reducir).
  const encoded = bytes * shrink ** (2 - SAMPLE_BPP_EXPONENT) * ratio;
  return blendKeepRule(bytes, encoded, SAMPLE_KEEP_BAND);
}

export function estimateScanSize(pages: readonly ScanPage[], options: { preset: string; searchable: boolean }): ScanSizeEstimate {
  const presetId = isImagePresetId(options.preset) ? options.preset : DEFAULT_IMAGE_PRESET;
  const preset = IMAGE_PRESETS[presetId];
  let total = 0;
  for (const page of pages) {
    const expected = expectedProcessed(page);
    const header = headerFor(expected.width, expected.height, expected.kind);
    let optimized: number;
    if (expected.qualityRatio && presetId !== "original") {
      // Pagina procesada con muestra: se reproduce lo que hace `prepareForPdf` con el peso REAL de este contenido a la calidad de cada
      // preset (reducir si pasa del lado maximo, recodificar y quedarse con lo nuevo solo si ahorra >= 15 %).
      optimized = estimateFromSample(header, expected.bytes, preset, expected.qualityRatio);
    } else {
      // La politica y el modelo de `prepareForPdf` (Original conserva el archivo; el resto, solo si ahorra >= 15 %).
      const { optimized: modelled } = estimatePreparedBytes(header, expected.bytes, preset);
      // El modelo de `prepareForPdf` se queda corto ~9 % cuando recodifica un JPEG (medido con fotos reales en los tres presets).
      optimized = modelled < expected.bytes ? Math.min(expected.bytes, modelled * TRANSCODE_BIAS) : modelled;
      if (optimized < expected.bytes) optimized = blendKeepRule(expected.bytes, optimized);
    }
    total += optimized + PAGE_OVERHEAD_BYTES + (options.searchable ? SEARCHABLE_BYTES_PER_PAGE : 0);
  }
  const bytes = Math.round(total);
  return { bytes, low: Math.round(bytes * LOW), high: Math.round(bytes * HIGH) };
}
