import {
  ESTIMATE_HEAD_BYTES,
  IMAGE_PRESETS,
  MIN_SAVING,
  estimatePreparedBytes,
  fitWithin,
  planPreparation,
  readImageHeader,
  withFitMaxSide,
  type ImageHeader,
  type ImagePreset,
  type ImagePresetId,
} from "@/lib/image/prepareForPdf";
import {
  layoutPhotoGrid,
  pixelsNeededForRect,
  type PhotoGridOptions,
  type PhotoSize,
} from "@/lib/pdf/photoGrid";

/**
 * Estimacion del peso del PDF antes de generarlo.
 *
 * Dos niveles:
 *  1. `estimatePdfSize`: BARATA y sincrona (solo cabeceras y pesos, sin decodificar). Es una aproximacion gruesa (fotos
 *     sinteticas ruidosas pesan la mitad de lo previsto; fotos lisas, mas): sirve de respaldo.
 *  2. `estimatePdfSizeSampled`: codifica de verdad 1-2 fotos REPRESENTATIVAS (las de menos y mas bytes por pixel entre las
 *     que se reencodan) con el mismo motor y la misma calidad que el PDF final, y extrapola al resto por pixeles. Medido con
 *     fotos reales y sinteticas, en Chromium y WebKit/iPad, el peso de cada foto reencodada es ~ (pixeles finales) x (bytes por
 *     pixel de la muestra) x (bytes por pixel del original / el de la muestra)^g, con g ~ 1 si apenas se reduce y ~ 0,3-0,6 si
 *     se reduce mucho (error de la suma: <= 4 % en los 28 casos medidos). Como la muestra pasa por el codificador real del
 *     navegador, la calibracion de WebKit queda incluida. Cuando las dos muestras discrepan entre si, el resultado se da como
 *     RANGO («≈ 35-45 MB»).
 */

export type ImageProbe = { size: number; header: ImageHeader | null };

/** Lee la cabecera de cada archivo (sin decodificar). Un archivo que no se puede leer cuenta solo por su peso. */
export async function probeImageFiles(files: readonly Blob[], signal?: AbortSignal): Promise<ImageProbe[]> {
  const probes: ImageProbe[] = [];
  for (const file of files) {
    if (signal?.aborted) break;
    let header: ImageHeader | null = null;
    try {
      header = readImageHeader(new Uint8Array(await file.slice(0, ESTIMATE_HEAD_BYTES).arrayBuffer()));
    } catch {
      header = null;
    }
    probes.push({ size: file.size, header });
  }
  return probes;
}

export type PdfSizeEstimate = {
  photos: number;
  /** Peso de los archivos originales sumado. */
  sourceBytes: number;
  /** Peso estimado del PDF con la calidad elegida (valor central). */
  optimizedBytes: number;
  /**
   * Extremos del rango en que se espera el peso real (= `optimizedBytes` si se conoce bien). Opcionales: quien construye una
   * estimacion a mano (solo con los cuatro numeros de arriba) sigue siendo valido y se muestra como un solo valor.
   */
  lowBytes?: number;
  highBytes?: number;
  /** `true` si la incertidumbre es alta: la interfaz da el rango («≈ 35-45 MB») y no un solo numero. */
  uncertain?: boolean;
  /** `true` si salio de codificar fotos de muestra; `false` = aproximacion gruesa por cabeceras. */
  sampled?: boolean;
  /** Peso estimado del PDF sin optimizar (todo tal cual, como antes de existir la calidad de imagen). */
  unoptimizedBytes: number;
  /** Mayor numero de pixeles de una foto (para decidir si «Alta» conserva visiblemente mas detalle). */
  maxPhotoPixels?: number;
};

const SHEET_OVERHEAD_BYTES = 2048;
/** Desde esta semianchura relativa del rango se muestra «≈ a-b» en vez de un solo numero. */
export const UNCERTAIN_HALF_WIDTH = 0.1;
/** Fotos de mas de este tamano (pixeles) pierden detalle visible al ampliar con «Equilibrada» frente a «Alta». */
export const HIGH_DETAIL_PIXELS = 12_000_000;

type Grid = Omit<PhotoGridOptions, "margin"> & { margin: number };

type Analysed = {
  header: ImageHeader | null;
  size: number;
  /** Preset ya acotado por la celda de la foto. */
  preset: ImagePreset;
  fit: number | undefined;
  transcode: boolean;
  /** Pixeles del original y del resultado (si se reencoda). */
  srcPixels: number;
  outPixels: number;
  /** Bytes por pixel del archivo original. */
  originalBpp: number;
  group: "jpeg" | "other";
  rough: { optimized: number; unoptimized: number };
};

function analyse(probes: readonly ImageProbe[], presetId: ImagePresetId, grid: Grid): Analysed[] {
  const base = IMAGE_PRESETS[presetId];
  const sizes: PhotoSize[] = probes.map((probe) => {
    const header = probe.header;
    return header && header.displayWidth && header.displayHeight
      ? { width: header.displayWidth, height: header.displayHeight }
      : { width: 4, height: 3 };
  });
  // Lado largo (px) que necesita cada foto por el sitio que ocupa; solo con varias fotos por hoja.
  const fit: Array<number | undefined> = probes.map(() => undefined);
  if (grid.perPage > 1 && base.cellPpi > 0) {
    for (const sheet of layoutPhotoGrid(sizes, grid)) {
      for (const placed of sheet.photos) fit[placed.index] = pixelsNeededForRect(placed.rect, base.cellPpi);
    }
  }
  return probes.map((probe, index) => {
    const header = probe.header;
    const preset = withFitMaxSide(base, fit[index]);
    const rough = estimatePreparedBytes(header, probe.size, preset);
    const known = header !== null && header.kind !== "unknown" && header.width !== null && header.height !== null && !!header.displayWidth && !!header.displayHeight;
    const plan = known ? planPreparation(header, probe.size, preset) : null;
    const transcode = plan !== null && plan.action === "transcode";
    const srcPixels = known ? (header.width as number) * (header.height as number) : 0;
    let outPixels = srcPixels;
    if (transcode && plan.action === "transcode" && header) {
      const out = fitWithin(header.displayWidth as number, header.displayHeight as number, plan.maxSide, plan.maxPixels);
      outPixels = out.width * out.height;
    }
    return {
      header,
      size: probe.size,
      preset,
      fit: fit[index],
      transcode,
      srcPixels,
      outPixels,
      originalBpp: srcPixels > 0 ? probe.size / srcPixels : 0,
      group: header?.kind === "jpeg" ? "jpeg" : "other",
      rough,
    };
  });
}

function summarise(items: Analysed[], optimized: number[], perPage: number, extra: { low: number; high: number; sampled: boolean }): PdfSizeEstimate {
  const sheets = Math.ceil(items.length / perPage);
  const overhead = sheets * SHEET_OVERHEAD_BYTES;
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
  const optimizedBytes = Math.round(sum(optimized) + overhead);
  const lowBytes = Math.round(sum(optimized) * extra.low + overhead);
  const highBytes = Math.round(sum(optimized) * extra.high + overhead);
  const unoptimized = sum(items.map((item) => item.rough.unoptimized));
  return {
    photos: items.length,
    sourceBytes: sum(items.map((item) => item.size)),
    optimizedBytes,
    lowBytes,
    highBytes,
    uncertain: extra.high - extra.low > 2 * UNCERTAIN_HALF_WIDTH,
    sampled: extra.sampled,
    unoptimizedBytes: Math.round(unoptimized + items.length * SHEET_OVERHEAD_BYTES),
    maxPhotoPixels: items.reduce((max, item) => Math.max(max, item.srcPixels), 0),
  };
}

/** Aproximacion gruesa por cabeceras (sin decodificar nada). Siempre se da como rango amplio. */
export function estimatePdfSize(probes: readonly ImageProbe[], preset: ImagePresetId, grid: Grid): PdfSizeEstimate {
  const items = analyse(probes, preset, grid);
  const rough = preset === "original" ? 0 : 0.35;
  return summarise(items, items.map((item) => item.rough.optimized), grid.perPage, { low: 1 - rough, high: 1 + rough, sampled: false });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Muestras                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** Una foto reencodada de verdad: `bytes` es lo que pesa su JPEG/PNG nuevo y `width` x `height` sus pixeles. */
export type PhotoSample = { index: number; bytes: number; width: number; height: number };

/** Muestras que hacen falta: hasta dos por grupo (JPEG / resto), las de menos y mas bytes por pixel entre las que se reencodan. */
export function planSamples(probes: readonly ImageProbe[], preset: ImagePresetId, grid: Grid): Array<{ index: number; fit: number | undefined }> {
  if (preset === "original") return [];
  const items = analyse(probes, preset, grid);
  const picks: Array<{ index: number; fit: number | undefined }> = [];
  for (const group of ["jpeg", "other"] as const) {
    const candidates = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.transcode && item.group === group && item.originalBpp > 0)
      .sort((a, b) => a.item.originalBpp - b.item.originalBpp);
    if (candidates.length === 0) continue;
    const chosen = new Set<number>();
    for (const quantile of candidates.length === 1 ? [0.5] : [0.2, 0.8]) {
      chosen.add(Math.min(candidates.length - 1, Math.floor(quantile * candidates.length)));
    }
    for (const position of chosen) picks.push({ index: candidates[position].index, fit: candidates[position].item.fit });
  }
  return picks;
}

/** Exponente con el que el peso por pixel sigue al del original: ~1 si apenas se reduce, menos cuanto mas se reduce. */
function gammaFor(reduction: number): number {
  return Math.min(1.2, Math.max(0, 0.25 + 0.8 * Math.sqrt(Math.min(1, reduction))));
}

/** Estimacion a partir de las muestras ya codificadas (ver `planSamples`). Sin muestras de un grupo, cae a la aproximacion gruesa. */
export function estimateFromSamples(probes: readonly ImageProbe[], preset: ImagePresetId, grid: Grid, samples: readonly PhotoSample[]): PdfSizeEstimate {
  const items = analyse(probes, preset, grid);
  if (samples.length === 0) return estimatePdfSize(probes, preset, grid);
  type Known = { originalBpp: number; bpp: number; reduction: number };
  const known: Record<"jpeg" | "other", Known[]> = { jpeg: [], other: [] };
  for (const sample of samples) {
    const item = items[sample.index];
    if (!item || sample.width * sample.height <= 0) continue;
    known[item.group].push({
      originalBpp: item.originalBpp,
      bpp: sample.bytes / (sample.width * sample.height),
      reduction: item.srcPixels > 0 ? (sample.width * sample.height) / item.srcPixels : 1,
    });
  }
  const predict = (item: Analysed, among: Known[]): number => {
    const reduction = item.srcPixels > 0 ? item.outPixels / item.srcPixels : 1;
    const gamma = gammaFor(reduction);
    let weighted = 0;
    let weights = 0;
    for (const sample of among) {
      const guess = sample.bpp * (item.originalBpp / sample.originalBpp) ** gamma;
      const weight = 1 / (0.1 + Math.abs(Math.log(item.originalBpp / sample.originalBpp)));
      weighted += weight * guess;
      weights += weight;
    }
    return weighted / weights;
  };
  let relativeError = 0;
  const optimized = items.map((item) => {
    if (!item.header || item.header.kind === "unknown") return item.rough.optimized;
    if (!item.transcode) return item.rough.optimized;
    const among = known[item.group];
    if (among.length === 0) {
      relativeError = Math.max(relativeError, 0.35);
      return item.rough.optimized;
    }
    const encoded = item.outPixels * predict(item, among);
    // Se conserva el original si el reencodado no ahorra el 15 % (salvo formatos que hay que convertir si o si).
    const mustConvert = item.rough.unoptimized > item.size && item.header.kind !== "jpeg" && item.header.kind !== "png";
    if (mustConvert) return Math.min(encoded, item.rough.unoptimized);
    return encoded <= item.size * (1 - MIN_SAVING) ? encoded : item.size;
  });
  // Incertidumbre: cuanto se equivoca una muestra al predecir a la otra; con una sola muestra no hay forma de saberlo.
  for (const group of ["jpeg", "other"] as const) {
    const among = known[group];
    if (among.length >= 2) {
      let worst = 0;
      among.forEach((sample, position) => {
        const others = among.filter((_, other) => other !== position);
        const gamma = gammaFor(sample.reduction);
        const guess =
          others.reduce((sum, other) => sum + other.bpp * (sample.originalBpp / other.originalBpp) ** gamma, 0) / others.length;
        worst = Math.max(worst, Math.abs(Math.log(guess / sample.bpp)));
      });
      // La discrepancia mide una EXTRAPOLACION de una muestra a la otra; el resto de fotos quedan entre las dos (interpolacion),
      // asi que el error real es bastante menor: medido <= 4 % con discrepancias de hasta 0,26.
      relativeError = Math.max(relativeError, 0.05 + 0.3 * worst);
    } else if (among.length === 1) {
      relativeError = Math.max(relativeError, 0.12);
    }
  }
  const half = Math.min(0.3, relativeError);
  return summarise(items, optimized, grid.perPage, { low: 1 - half, high: 1 + half, sampled: true });
}

export type SampleRunner = (index: number, fit: number | undefined) => Promise<{ bytes: number; width: number; height: number } | null>;

/**
 * Estimacion con muestras: las codifica con `runSample` (el motor real: worker, calibracion y regla del 15 % incluidas) y
 * extrapola. Si una muestra falla se usa la aproximacion gruesa para ese grupo. Respeta `signal`.
 */
export async function estimatePdfSizeSampled(
  probes: readonly ImageProbe[],
  preset: ImagePresetId,
  grid: Grid,
  runSample: SampleRunner,
  signal?: AbortSignal,
): Promise<PdfSizeEstimate> {
  const samples: PhotoSample[] = [];
  for (const pick of planSamples(probes, preset, grid)) {
    if (signal?.aborted) break;
    try {
      const result = await runSample(pick.index, pick.fit);
      if (result) samples.push({ index: pick.index, ...result });
    } catch {
      // Una muestra que falla no impide estimar: se cae a la aproximacion gruesa de su grupo.
    }
  }
  return estimateFromSamples(probes, preset, grid, samples);
}
