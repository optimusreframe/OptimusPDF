import { boxBlur, downscaleRgba, histogram256, percentileOf, toGray, type Gray, type Rgba } from "@/lib/scan/pixels";

/**
 * Calidad de una hoja ya recortada/enderezada (o de la zona del documento en un fotograma): nitidez, brillo/reflejos,
 * oscuridad y hoja en blanco. Todo puro y barato (trabaja sobre una copia reducida), sin red ni DOM.
 */

/** Ancho de analisis de una pagina entera. */
export const QUALITY_WIDTH = 480;

/** Contraste (p98 - p2 de luminancia) por debajo del cual no hay detalle que juzgar (hoja lisa): no se marca borrosa. */
const MIN_RANGE_FOR_SHARPNESS = 40;

/** Acutancia por debajo de la cual la hoja se considera borrosa (calibrado con el corpus; ver `scan.metrics.test.ts`). */
export const BLUR_ACUTANCE_THRESHOLD = 0.3;

/** Luminancia mediana del papel por debajo de la cual falta luz. */
export const DARK_PAPER_THRESHOLD = 95;

/** Fraccion del papel saturada (suavizada) a partir de la cual hay un reflejo. */
export const GLARE_FRACTION_THRESHOLD = 0.02;
/** Luminancia suavizada a partir de la cual un pixel de papel esta quemado. */
export const GLARE_LEVEL = 252.5;

export function analysisGray(image: Rgba, width = QUALITY_WIDTH): Gray {
  const scaled = image.width > width ? downscaleRgba(image, width) : image;
  return toGray(scaled);
}

/** Acutancia: gradiente alto (p99) frente al rango de tonos. Un borde nitido concentra el salto; el desenfoque lo reparte. */
export function sharpnessOf(gray: Gray, mask?: Uint8Array): number | null {
  const { data, width, height } = gray;
  if (width < 8 || height < 8) return null;
  let hist: Uint32Array;
  if (mask) {
    hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 1) if (mask[i]) hist[data[i]] += 1;
  } else {
    hist = histogram256(data);
  }
  const range = percentileOf(hist, 0.995) - percentileOf(hist, 0.005);
  if (range < MIN_RANGE_FOR_SHARPNESS) return null;
  const gradient = new Uint16Array(width * height);
  const gradHist = new Uint32Array(1024);
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (mask && !mask[i]) continue;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + width] - data[i - width];
      const g = Math.abs(gx) + Math.abs(gy);
      gradient[i] = g;
      gradHist[Math.min(1023, g)] += 1;
      count += 1;
    }
  }
  let seen = 0;
  let p99 = 0;
  for (let level = 1023; level >= 0; level -= 1) {
    seen += gradHist[level];
    if (seen >= count * 0.01) {
      p99 = level;
      break;
    }
  }
  return p99 / (2 * range);
}

/** Mediana de la luminancia (papel), opcionalmente solo dentro de `mask`. */
export function medianLevel(gray: Gray, mask?: Uint8Array): number {
  if (!mask) return percentileOf(histogram256(gray.data), 0.5);
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.data.length; i += 1) if (mask[i]) hist[gray.data[i]] += 1;
  return percentileOf(hist, 0.5);
}

export type GlareReading = { fraction: number; glare: boolean };

/** Reflejo: zona extensa de papel quemado (tras suavizar el ruido). */
export function glareOf(gray: Gray, mask?: Uint8Array, radius = 3): GlareReading {
  const { data, width, height } = gray;
  const smooth = boxBlur(data, width, height, radius);
  let burnt = 0;
  let total = 0;
  for (let index = 0; index < smooth.length; index += 1) {
    if (mask && !mask[index]) continue;
    total += 1;
    if (smooth[index] >= GLARE_LEVEL) burnt += 1;
  }
  const fraction = total > 0 ? burnt / total : 0;
  return { fraction, glare: fraction >= GLARE_FRACTION_THRESHOLD };
}

export type InkStats = {
  /** Fraccion de pixeles de tinta (mas oscuros que el fondo local). */
  fraction: number;
  /** Celdas (1/30 del ancho) con tinta. */
  cells: number;
  cellsTotal: number;
  /** Fraccion del area ocupada por el recuadro de la tinta. */
  boxFraction: number;
  /** Mapa de tinta (1 = tinta) a la resolucion del analisis, para quien lo quiera reutilizar. */
  mask: Uint8Array;
};

/**
 * Tinta de una hoja: se resta el fondo local (desenfoque grande, que absorbe sombras y degradados) y se cuentan los pixeles
 * claramente mas oscuros. Se ignora un margen del 5 % (sombra del borde de la hoja).
 */
export function inkStatsOf(gray: Gray, options: { threshold?: number; margin?: number } = {}): InkStats {
  const { data, width, height } = gray;
  const threshold = options.threshold ?? 18;
  const margin = options.margin ?? 0.05;
  const radius = Math.max(6, Math.round(width / 14));
  const background = boxBlur(data, width, height, radius);
  const mask = new Uint8Array(width * height);
  const mx = Math.round(width * margin);
  const my = Math.round(height * margin);
  const cell = Math.max(4, Math.round(width / 30));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cellHits = new Uint16Array(cols * rows);
  let ink = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = my; y < height - my; y += 1) {
    for (let x = mx; x < width - mx; x += 1) {
      const i = y * width + x;
      if (background[i] - data[i] > threshold) {
        mask[i] = 1;
        ink += 1;
        cellHits[Math.floor(y / cell) * cols + Math.floor(x / cell)] += 1;
      }
    }
  }
  // Una celda cuenta solo con tinta suficiente: el ruido suelto no la enciende.
  const minHits = Math.max(2, Math.round(cell * cell * 0.015));
  let cells = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (cellHits[r * cols + c] >= minHits) {
        cells += 1;
        minX = Math.min(minX, c * cell);
        maxX = Math.max(maxX, (c + 1) * cell);
        minY = Math.min(minY, r * cell);
        maxY = Math.max(maxY, (r + 1) * cell);
      }
    }
  }
  const area = Math.max(1, (width - 2 * mx) * (height - 2 * my));
  const boxFraction = maxX < 0 ? 0 : ((maxX - minX) * (maxY - minY)) / (width * height);
  return { fraction: ink / area, cells, cellsTotal: cols * rows, boxFraction, mask };
}

/** Maximo de celdas con tinta para seguir siendo «en blanco» (un sello pequeno o un numero de pagina). */
export const BLANK_MAX_CELLS = 48;
export const BLANK_MAX_FRACTION = 0.02;

export function isBlankPage(stats: InkStats): boolean {
  return stats.cells <= BLANK_MAX_CELLS && stats.fraction <= BLANK_MAX_FRACTION;
}

export type PageQuality = {
  sharpness: number | null;
  blurry: boolean;
  glare: boolean;
  glareFraction: number;
  dark: boolean;
  paperLevel: number;
  blank: boolean;
  ink: InkStats;
};

/** Lectura completa de una hoja ya recortada. */
export function measurePage(image: Rgba): PageQuality {
  const gray = analysisGray(image);
  const sharpness = sharpnessOf(gray);
  const glare = glareOf(gray);
  const paperLevel = medianLevel(gray);
  const ink = inkStatsOf(gray);
  return {
    sharpness,
    blurry: sharpness !== null && !isBlankPage(ink) && sharpness < BLUR_ACUTANCE_THRESHOLD,
    glare: glare.glare,
    glareFraction: glare.fraction,
    dark: paperLevel < DARK_PAPER_THRESHOLD,
    paperLevel,
    blank: isBlankPage(ink),
    ink,
  };
}
