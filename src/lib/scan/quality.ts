import { boxBlur, downscaleRgba, histogram256, percentileOf, toGray, type Gray, type Rgba } from "@/lib/scan/pixels";

/**
 * Calidad de una hoja ya recortada/enderezada (o de la zona del documento en un fotograma): nitidez, brillo/reflejos,
 * oscuridad y hoja en blanco. Todo puro y barato (trabaja sobre una copia reducida), sin red ni DOM.
 */

/** Ancho de analisis de una pagina entera. */
export const QUALITY_WIDTH = 480;

/** Contraste (p98 - p2 de luminancia) por debajo del cual no hay detalle que juzgar (hoja lisa): no se marca borrosa. */
const MIN_RANGE_FOR_SHARPNESS = 40;

/**
 * Una hoja es borrosa solo si DOS medidas independientes lo dicen: acutancia baja (gradiente fuerte frente al rango de tonos) Y
 * poca perdida de borde al volver a desenfocarla (`reblurRatio`: un borde nitido pierde mucho al desenfocarlo, uno ya borroso
 * casi nada). La acutancia sola daba falsos «Borrosa» en fotos reales nitidas con detalle fino o poco contraste.
 */
export const BLUR_ACUTANCE_THRESHOLD = 0.3;
/** Por debajo de esto el borde apenas cambia al desenfocarlo: ya estaba borroso (corpus: borrosas <= 0,32; nitidas >= 0,39; fotos reales nitidas >= 0,31). */
export const BLUR_REBLUR_THRESHOLD = 0.27;

/** Sin bordes que re-desenfocar, por debajo de esta acutancia (con contenido) la hoja esta borrosa (corpus y fotos reales nitidas >= 0,13). */
export const VERY_BLURRY_ACUTANCE = 0.11;
/** La nitidez se mide con mas resolucion que el resto (lado largo): a 480 px un texto de 12 MP desenfocado ilegible aun parecia nitido. */
export const SHARPNESS_SIDE = 960;
/** Bloques fuera de la superficie de luz: una hoja con menos de esta fraccion es de verdad una hoja vacia. */
export const LAYOUT_DEVIATION = 4;
/** Margen exterior (fraccion del lado) que no cuenta como contenido. */
export const LAYOUT_MARGIN = 0.06;
export const LAYOUT_BLANK_MAX_SHARE = 0.12;

/** Luminancia mediana del papel por debajo de la cual falta luz. */
export const DARK_PAPER_THRESHOLD = 95;
/** ...y ademas lo mas claro (percentil 85) tampoco llega a esto: si hay una hoja clara, aunque ocupe poco, la luz es buena. */
export const DARK_BRIGHT_THRESHOLD = 130;

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

function gradientOf(source: Float32Array | Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      out[i] = Math.abs(source[i + 1] - source[i - 1]) + Math.abs(source[i + width] - source[i - width]);
    }
  }
  return out;
}

/**
 * Perdida media de borde al volver a desenfocar la imagen, en los pixeles de borde fuerte (el 5 % de mayor gradiente, minimo 24):
 * ~0,8 en una hoja nitida, ~0,2 en una desenfocada. Independiente del contenido y del contraste. `null` sin bordes suficientes.
 */
export function reblurRatio(gray: Gray, radius = 2): number | null {
  const { data, width, height } = gray;
  if (width < 16 || height < 16) return null;
  const original = gradientOf(data, width, height);
  const blurred = gradientOf(boxBlur(data, width, height, radius), width, height);
  const sorted = Float32Array.from(original).sort();
  const threshold = Math.max(24, sorted[Math.floor(sorted.length * 0.95)]);
  let edges = 0;
  let loss = 0;
  for (let i = 0; i < original.length; i += 1) {
    if (original[i] < threshold) continue;
    edges += 1;
    loss += Math.max(0, (original[i] - blurred[i]) / original[i]);
  }
  return edges < 200 ? null : loss / edges;
}

/**
 * Contenido a gran escala: fraccion de bloques cuya luminancia se aparta mas de `LAYOUT_DEVIATION` niveles de una superficie de
 * segundo grado ajustada al conjunto (luz desigual, vineta, sombra suave). Una hoja en blanco, aunque tenga un degradado, un numero
 * de pagina o un sello, deja casi todos los bloques sobre la superficie (< 1 %); un texto desenfocado hasta no leerse sigue siendo
 * un bloque mas oscuro que los margenes (decenas de %).
 */
export function layoutShare(gray: Gray, grid = 24): number {
  const { data, width, height } = gray;
  // Sin el margen exterior: la sombra o un resto de mesa en el borde de un recorte no es contenido de la hoja.
  const mx = Math.round(width * LAYOUT_MARGIN);
  const my = Math.round(height * LAYOUT_MARGIN);
  const innerW = width - 2 * mx;
  const innerH = height - 2 * my;
  const cols = grid;
  const rows = Math.max(8, Math.round((grid * innerH) / innerW));
  const cell: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x0 = mx + Math.floor((c * innerW) / cols);
      const x1 = Math.max(x0 + 1, mx + Math.floor(((c + 1) * innerW) / cols));
      const y0 = my + Math.floor((r * innerH) / rows);
      const y1 = Math.max(y0 + 1, my + Math.floor(((r + 1) * innerH) / rows));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { sum += data[y * width + x]; n += 1; }
      cell.push(sum / Math.max(1, n));
    }
  }
  // Ajuste por minimos cuadrados de z = a + bx + cy + dx^2 + exy + fy^2 sobre las medias de bloque (x, y en [-1, 1]), repetido sin
  // los bloques muy fuera (una franja de borde o un sello no deben torcer la superficie).
  const terms = (x: number, y: number): number[] => [1, x, y, x * x, x * y, y * y];
  const size = 6;
  const pos = (i: number): { x: number; y: number } => ({ x: (((i % cols) + 0.5) / cols) * 2 - 1, y: ((Math.floor(i / cols) + 0.5) / rows) * 2 - 1 });
  const fitSurface = (use: boolean[]): number[] => {
    const normal = Array.from({ length: size }, () => new Array<number>(size + 1).fill(0));
    for (let i = 0; i < cell.length; i += 1) {
      if (!use[i]) continue;
      const { x, y } = pos(i);
      const t = terms(x, y);
      for (let a = 0; a < size; a += 1) {
        for (let b = 0; b < size; b += 1) normal[a][b] += t[a] * t[b];
        normal[a][size] += t[a] * cell[i];
      }
    }
    for (let col = 0; col < size; col += 1) {
      let pivot = col;
      for (let r = col + 1; r < size; r += 1) if (Math.abs(normal[r][col]) > Math.abs(normal[pivot][col])) pivot = r;
      [normal[col], normal[pivot]] = [normal[pivot], normal[col]];
      const d = normal[col][col] || 1e-9;
      for (let r = col + 1; r < size; r += 1) {
        const f = normal[r][col] / d;
        for (let k = col; k <= size; k += 1) normal[r][k] -= f * normal[col][k];
      }
    }
    const coef = new Array<number>(size).fill(0);
    for (let r = size - 1; r >= 0; r -= 1) {
      let acc = normal[r][size];
      for (let k = r + 1; k < size; k += 1) acc -= normal[r][k] * coef[k];
      coef[r] = acc / (normal[r][r] || 1e-9);
    }
    return coef;
  };
  const residual = (coef: number[], i: number): number => {
    const { x, y } = pos(i);
    return cell[i] - terms(x, y).reduce((acc, t, k) => acc + t * coef[k], 0);
  };
  let coef = fitSurface(cell.map(() => true));
  for (let pass = 0; pass < 2; pass += 1) coef = fitSurface(cell.map((_, i) => Math.abs(residual(coef, i)) < LAYOUT_DEVIATION * 2));
  let off = 0;
  for (let i = 0; i < cell.length; i += 1) if (Math.abs(residual(coef, i)) >= LAYOUT_DEVIATION) off += 1;
  return off / cell.length;
}

/**
 * Borrosa segun las dos medidas. Sin bordes fuertes que re-desenfocar (`reblur` null: un texto desenfocado hasta no leerse ya no
 * tiene ninguno) basta una acutancia muy baja, SI hay contenido (`content`): una pagina sin nada no se marca.
 */
export function isBlurry(sharpness: number | null, reblur: number | null, content = false): boolean {
  if (sharpness === null) return false;
  if (reblur === null) return content && sharpness < VERY_BLURRY_ACUTANCE;
  return sharpness < BLUR_ACUTANCE_THRESHOLD && reblur < BLUR_REBLUR_THRESHOLD;
}

/** Mediana de la luminancia (papel), opcionalmente solo dentro de `mask`. */
export function medianLevel(gray: Gray, mask?: Uint8Array): number {
  if (!mask) return percentileOf(histogram256(gray.data), 0.5);
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.data.length; i += 1) if (mask[i]) hist[gray.data[i]] += 1;
  return percentileOf(hist, 0.5);
}

/** Recuadro maximo (fraccion del analisis) de la mancha quemada para ser un reflejo. */
export const GLARE_MAX_BOX = 0.85;

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i];
  return count;
}

/** Mayor componente conexa (4 vecinos) de pixeles quemados dentro de `mask`: su tamano y el area de su recuadro. */
function largestBurntBlob(smooth: Float32Array, width: number, height: number, mask?: Uint8Array): { size: number; box: number } {
  const seen = new Uint8Array(smooth.length);
  const stack = new Int32Array(smooth.length);
  let best = { size: 0, box: 0 };
  for (let start = 0; start < smooth.length; start += 1) {
    if (seen[start] || smooth[start] < GLARE_LEVEL || (mask && !mask[start])) continue;
    let size = 0;
    let top = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const index = stack[--top];
      size += 1;
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const n of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1]) {
        if (n < 0 || seen[n] || smooth[n] < GLARE_LEVEL || (mask && !mask[n])) continue;
        seen[n] = 1;
        stack[top++] = n;
      }
    }
    if (size > best.size) best = { size, box: (maxX - minX + 1) * (maxY - minY + 1) };
  }
  return best;
}

export type GlareReading = { fraction: number; glare: boolean };

/** Un reflejo ocupa como mucho esto del papel: mas es una hoja (o una pared) blanca, no un reflejo. */
export const GLARE_MAX_FRACTION = 0.6;
/** El papel de alrededor del reflejo (lo no quemado) debe verse y no ser ya casi blanco. */
export const GLARE_PAPER_MIN = 150;
export const GLARE_PAPER_MAX = 242;
/** Papel «liso» alrededor de un reflejo: la luminancia suavizada cambia como mucho GLARE_FLAT_SLOPE niveles (suma de dos diferencias) entre dos puntos a +-GLARE_FLAT_SPAN px (el borde antialias de un texto cambia mucho mas). */
export const GLARE_FLAT_SLOPE = 6;
export const GLARE_FLAT_SPAN = 1;

/**
 * Reflejo: zona extensa de papel quemado (tras suavizar el ruido) RODEADA de papel que si se ve (claro pero no blanco). Un
 * documento blanco puro (todo quemado, sin papel alrededor) o una escena oscura con una luz NO son un reflejo.
 */
export function glareOf(gray: Gray, mask?: Uint8Array, radius = 3): GlareReading {
  const { data, width, height } = gray;
  const smooth = boxBlur(data, width, height, radius);
  let burnt = 0;
  let total = 0;
  const hist = new Uint32Array(256);
  let paper = 0;
  for (let index = 0; index < smooth.length; index += 1) {
    if (mask && !mask[index]) continue;
    total += 1;
    if (smooth[index] >= GLARE_LEVEL) {
      burnt += 1;
    } else if (smooth[index] >= GLARE_PAPER_MIN) {
      // Papel de verdad = claro Y LISO: el borde antialias de un texto digital tiene los mismos grises pero cambia deprisa.
      const x = index % width;
      const y = (index - x) / width;
      if (x < GLARE_FLAT_SPAN || y < GLARE_FLAT_SPAN || x >= width - GLARE_FLAT_SPAN || y >= height - GLARE_FLAT_SPAN) continue;
      const slope = Math.abs(smooth[index + GLARE_FLAT_SPAN] - smooth[index - GLARE_FLAT_SPAN]) + Math.abs(smooth[index + GLARE_FLAT_SPAN * width] - smooth[index - GLARE_FLAT_SPAN * width]);
      if (slope > GLARE_FLAT_SLOPE) continue;
      hist[Math.min(255, Math.round(smooth[index]))] += 1;
      paper += 1;
    }
  }
  const fraction = total > 0 ? burnt / total : 0;
  let reference = 255;
  if (paper > 0) {
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += hist[v];
      if (seen >= paper / 2) {
        reference = v;
        break;
      }
    }
  }
  const surrounded = total > 0 && paper >= total * 0.15 && reference <= GLARE_PAPER_MAX;
  if (!(fraction >= GLARE_FRACTION_THRESHOLD && fraction <= GLARE_MAX_FRACTION && surrounded)) return { fraction, glare: false };
  // Un reflejo es una MANCHA: la mayor zona quemada conexa ocupa una parte de la hoja y su recuadro NO la cubre casi entera
  // (el blanco de una hoja con texto se cuela entre las lineas por toda la pagina y no es un reflejo).
  const blob = largestBurntBlob(smooth, width, height, mask);
  const area = Math.max(1, mask ? countMask(mask) : width * height);
  return { fraction, glare: blob.size / area >= GLARE_FRACTION_THRESHOLD && blob.box / (width * height) <= GLARE_MAX_BOX };
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
  reblur: number | null;
  blurry: boolean;
  glare: boolean;
  glareFraction: number;
  dark: boolean;
  paperLevel: number;
  blank: boolean;
  /** Fraccion de bloques fuera de la superficie de luz (ver `layoutShare`). */
  layout: number;
  ink: InkStats;
};

/** Lectura completa de una hoja ya recortada. */
export function measurePage(image: Rgba, options: { width?: number; sharpSide?: number } = {}): PageQuality {
  const gray = analysisGray(image, options.width ?? QUALITY_WIDTH);
  // Nitidez con mas resolucion (si la imagen la tiene): un desenfoque grande solo se ve en los pixeles del original.
  const wide = image.width > gray.width || image.height > gray.height ? analysisGray(image, options.sharpSide ?? SHARPNESS_SIDE) : gray;
  const sharpness = sharpnessOf(wide);
  const reblur = reblurRatio(wide);
  const glare = glareOf(gray);
  const paperLevel = medianLevel(gray);
  const brightLevel = percentileOf(histogram256(gray.data), 0.85);
  const ink = inkStatsOf(gray);
  const layout = layoutShare(gray);
  // En blanco = sin tinta Y sin estructura a gran escala: un texto desenfocado hasta no leerse no es una hoja vacia.
  const blank = isBlankPage(ink) && layout < LAYOUT_BLANK_MAX_SHARE;
  return {
    sharpness,
    reblur,
    blurry: !blank && isBlurry(sharpness, reblur, !isBlankPage(ink) || layout >= LAYOUT_BLANK_MAX_SHARE),
    glare: glare.glare,
    glareFraction: glare.fraction,
    // Oscura = falta luz en lo mas claro de la imagen: una hoja bien iluminada sobre una mesa oscura (pagina sin recortar) no lo esta.
    dark: paperLevel < DARK_PAPER_THRESHOLD && brightLevel < DARK_BRIGHT_THRESHOLD,
    paperLevel,
    blank,
    layout,
    ink,
  };
}
