import {
  ESTIMATE_HEAD_BYTES,
  IMAGE_PRESETS,
  estimatePreparedBytes,
  readImageHeader,
  withFitMaxSide,
  type ImageHeader,
  type ImagePresetId,
} from "@/lib/image/prepareForPdf";
import {
  layoutPhotoGrid,
  pixelsNeededForRect,
  type PhotoGridOptions,
  type PhotoSize,
} from "@/lib/pdf/photoGrid";

/**
 * Estimacion BARATA del peso del PDF antes de generarlo: solo cabeceras (los primeros 512 KB de cada archivo) y el peso de
 * cada uno; no decodifica nada. Usa la misma politica (`planPreparation`) y la misma composicion (`layoutPhotoGrid`) que
 * el motor, asi que con varias fotos por hoja tiene en cuenta que cada foto solo necesita los pixeles de su celda. Es una
 * ESTIMACION (en la interfaz va marcada con «≈»): el peso real depende del contenido de cada foto.
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
  /** Peso estimado del PDF con la calidad elegida. */
  optimizedBytes: number;
  /** Peso estimado del PDF sin optimizar (todo tal cual, como antes de existir la calidad de imagen). */
  unoptimizedBytes: number;
};

const SHEET_OVERHEAD_BYTES = 2048;

export function estimatePdfSize(
  probes: readonly ImageProbe[],
  preset: ImagePresetId,
  grid: Omit<PhotoGridOptions, "margin"> & { margin: number },
): PdfSizeEstimate {
  const base = IMAGE_PRESETS[preset];
  const perPage = grid.perPage;
  const sizes: PhotoSize[] = probes.map((probe) => {
    const header = probe.header;
    return header && header.displayWidth && header.displayHeight
      ? { width: header.displayWidth, height: header.displayHeight }
      : { width: 4, height: 3 };
  });
  // Lado largo (px) que necesita cada foto por el sitio que ocupa; solo con varias fotos por hoja.
  const fit: Array<number | undefined> = probes.map(() => undefined);
  if (perPage > 1 && base.cellPpi > 0) {
    for (const sheet of layoutPhotoGrid(sizes, grid)) {
      for (const placed of sheet.photos) fit[placed.index] = pixelsNeededForRect(placed.rect, base.cellPpi);
    }
  }
  let source = 0;
  let optimized = 0;
  let unoptimized = 0;
  probes.forEach((probe, index) => {
    const estimate = estimatePreparedBytes(probe.header, probe.size, withFitMaxSide(base, fit[index]));
    source += probe.size;
    optimized += estimate.optimized;
    unoptimized += estimate.unoptimized;
  });
  const sheets = Math.ceil(probes.length / perPage);
  return {
    photos: probes.length,
    sourceBytes: source,
    optimizedBytes: Math.round(optimized + sheets * SHEET_OVERHEAD_BYTES),
    unoptimizedBytes: Math.round(unoptimized + probes.length * SHEET_OVERHEAD_BYTES),
  };
}
