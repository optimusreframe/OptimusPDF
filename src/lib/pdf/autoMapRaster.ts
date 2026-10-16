/*
 * Paginas escaneadas (sin texto extraible): solo geometria raster simple. Se buscan rayas horizontales largas por
 * proyeccion de filas sobre la luminancia; no hay etiquetas con que cruzarlas, asi que el resultado es siempre de
 * confianza BAJA (`review` como maximo, y solo las mas claras). Puro: recibe pixeles ya renderizados.
 */

import { toLuminance } from "@/lib/pdf/detectFields";
import type { RasterPage } from "@/lib/pdf/autoMapTypes";

export type RasterLine = {
  /** Fracciones 0..1 del ancho; `y` desde ARRIBA. */
  x0: number;
  x1: number;
  y: number;
  /** Grosor en fraccion del alto. */
  thickness: number;
};

/** Luminancia por debajo de la que un pixel cuenta como tinta. */
export const RASTER_INK_THRESHOLD = 128;
/** Una raya mide al menos esta fraccion del ancho de la pagina... */
export const RASTER_MIN_LINE_FRACTION = 0.16;
/** ... y como mucho esta (mas es una regla de pagina o un borde). */
export const RASTER_MAX_LINE_FRACTION = 0.7;
/** Grosor maximo de una raya (fraccion del alto de la pagina). */
export const RASTER_MAX_THICKNESS_FRACTION = 0.012;
/** Hueco maximo (px) que se tolera dentro de una raya (ruido de escaneo). */
const RASTER_MAX_GAP_PX = 3;

/** Racha oscura mas larga de cada fila (con huecos de hasta `RASTER_MAX_GAP_PX`) y su inicio. */
export function longestRuns(luminance: ArrayLike<number>, width: number, height: number): Array<{ length: number; start: number }> {
  const out: Array<{ length: number; start: number }> = [];
  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let best = 0;
    let bestStart = 0;
    let start = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      if (luminance[base + x] < RASTER_INK_THRESHOLD) {
        if (start < 0 || x - last > RASTER_MAX_GAP_PX + 1) start = x;
        last = x;
        if (last - start + 1 > best) {
          best = last - start + 1;
          bestStart = start;
        }
      }
    }
    out.push({ length: best, start: bestStart });
  }
  return out;
}

/** Rayas horizontales largas y finas de una pagina escaneada. */
export function detectRasterLines(page: RasterPage): RasterLine[] {
  const { width, height } = page;
  if (width <= 0 || height <= 0) return [];
  const luminance = toLuminance(page.data);
  const runs = longestRuns(luminance, width, height);
  const minRun = RASTER_MIN_LINE_FRACTION * width;
  const maxRun = RASTER_MAX_LINE_FRACTION * width;
  const maxRows = Math.max(1, Math.round(RASTER_MAX_THICKNESS_FRACTION * height));
  const lines: RasterLine[] = [];
  let y = 0;
  while (y < height) {
    if (runs[y].length < minRun) {
      y += 1;
      continue;
    }
    let end = y;
    while (end + 1 < height && runs[end + 1].length >= minRun) end += 1;
    const rows = end - y + 1;
    if (rows <= maxRows) {
      let x0 = Infinity;
      let x1 = 0;
      let longest = 0;
      for (let r = y; r <= end; r += 1) {
        x0 = Math.min(x0, runs[r].start);
        x1 = Math.max(x1, runs[r].start + runs[r].length);
        longest = Math.max(longest, runs[r].length);
      }
      if (longest <= maxRun) {
        lines.push({ x0: x0 / width, x1: x1 / width, y: (y + end + 1) / 2 / height, thickness: rows / height });
      }
    }
    y = end + 1;
  }
  return lines;
}
