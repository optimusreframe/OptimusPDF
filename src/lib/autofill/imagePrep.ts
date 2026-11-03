/**
 * Preparacion de una IMAGEN para el OCR del autorrelleno (fotos del telefono y paginas escaneadas): puro, sobre buffers RGBA, sin DOM,
 * para correr igual en un Web Worker, en el hilo principal (cediendo el hilo) y en Node (medicion).
 *
 * Una foto de una hoja sobre un escritorio llega girada 2-8 grados, con perspectiva, sombras y poca luz: el OCR lee peor las lineas
 * inclinadas y el motor de maquetacion las parte en trozos. Se arregla con piezas que ya tiene el Escaner:
 *   1. encontrar la hoja (`findDocumentCorners`) y enderezarla a un rectangulo a ~300 dpi equivalentes (`inverseHomography` + `warpRowsInto`);
 *   2. quitar sombras y degradados (`enhanceDocument`: divide por el fondo local, el papel queda blanco);
 *   3. corregir el giro que quede (proyeccion de tinta por filas, sin OCR) y volver a escalar si la hoja salio pequena.
 * Si la hoja no se encuentra (foto sin fondo, recorte ya hecho) se salta el paso 1 y el giro se busca en un margen mayor. Cada paso
 * cede el hilo y mira la cancelacion. El segundo intento (`attempt: 1`) usa otra receta (sin recorte, escala de grises con contraste
 * local) por si la primera lee mal.
 */

import { enhanceDocument, backgroundMapsFor, type BackgroundMap } from "@/lib/scan/filters";
import { findDocumentCorners } from "@/lib/scan/findCorners";
import { inverseHomography, quadOutputSize, warpRowsInto } from "@/lib/scan/perspective";
import { boxBlur, clampByte, downscaleRgba, toGray, type Rgba } from "@/lib/scan/pixels";

export type PrepKind = "photo" | "page";

export type PrepHooks = { signal?: AbortSignal; yield?: () => Promise<void> | void };

export type PrepInfo = {
  /** Hoja encontrada y enderezada. */
  cropped: boolean;
  /** Giro corregido (grados). */
  angle: number;
  /** Lado largo de la imagen de salida. */
  longSide: number;
};

/** Lado largo de salida: una hoja Carta a ~300 dpi mide 3 300 px; con 2 900 el texto de 9 pt ya tiene altura de x de ~16 px. */
export const PREP_TARGET_LONG_SIDE = 2900;
/** No se amplia mas de esto (ampliar una foto mala no inventa detalle). */
const MAX_UPSCALE = 2;
/** Margen de busqueda del giro: con la hoja ya enderezada y sin ella. */
const SKEW_RANGE_CROPPED = 3;
const SKEW_RANGE_FREE = 10;
/** Giros menores no se corrigen (remuestrear cuesta nitidez). */
const MIN_ANGLE = 0.25;

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/* ------------------------------------------------------------------ *
 * Giro
 * ------------------------------------------------------------------ */

/** Puntos de tinta (x, y) de una copia reducida: pixeles bastante mas oscuros que su entorno. */
function inkPoints(image: Rgba): { xs: number[]; ys: number[]; width: number; height: number } {
  const small = downscaleRgba(image, 1000);
  const gray = toGray(small);
  const { width, height } = gray;
  const blur = boxBlur(gray.data, width, height, Math.max(6, Math.round(width / 60)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (gray.data[index] < blur[index] - 18 && gray.data[index] < 175) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  return { xs, ys, width, height };
}

/**
 * Giro (grados) que deja horizontales las lineas de texto: el que hace mas «afilado» el perfil de tinta por filas. Busca cada 0,5 grados
 * en `[-range, range]` y afina cada 0,1. `0` si hay poca tinta o ninguna inclinacion destaca. El signo es el de `rotateBy`.
 */
export function estimateSkew(image: Rgba, range: number): number {
  const { xs, ys, width, height } = inkPoints(image);
  const count = xs.length;
  if (count < 400) return 0;
  const step = Math.max(1, Math.floor(count / 60_000));
  const bins = new Float64Array(width + height + 8);
  const offset = width * 0.5 + 2;
  const score = (degrees: number): number => {
    const a = (degrees * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    bins.fill(0);
    for (let i = 0; i < count; i += step) {
      const y = ys[i] * cos - xs[i] * sin + offset;
      bins[Math.max(0, Math.min(bins.length - 1, Math.round(y)))] += 1;
    }
    let total = 0;
    for (let i = 1; i < bins.length; i += 1) {
      const d = bins[i] - bins[i - 1];
      total += d * d;
    }
    return total;
  };
  let best = 0;
  let bestScore = score(0);
  const base = bestScore;
  for (let degrees = -range; degrees <= range + 1e-9; degrees += 0.5) {
    const s = score(degrees);
    if (s > bestScore) {
      bestScore = s;
      best = degrees;
    }
  }
  const coarse = best;
  for (let degrees = coarse - 0.5; degrees <= coarse + 0.5 + 1e-9; degrees += 0.1) {
    const s = score(degrees);
    if (s > bestScore) {
      bestScore = s;
      best = degrees;
    }
  }
  // Sin una mejora clara sobre «sin girar», no se toca (una hoja ya derecha da picos parecidos en todas partes).
  if (bestScore < base * 1.04) return 0;
  return Math.abs(best) < MIN_ANGLE ? 0 : Math.round(best * 10) / 10;
}

/**
 * Gira la imagen `degrees` alrededor de su centro con la MISMA transformacion con la que `estimateSkew` midio los puntos: el destino
 * (x', y') = (x cos a + y sin a, -x sin a + y cos a). Bilineal; el hueco se rellena con `fill` (el papel).
 */
export async function rotateBy(image: Rgba, degrees: number, fill: number, hooks: PrepHooks = {}): Promise<Rgba> {
  const { width, height, data } = image;
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = width / 2;
  const cy = height / 2;
  const out = new Uint8ClampedArray(width * height * 4);
  const rows = Math.max(16, Math.floor(400_000 / width));
  for (let y0 = 0; y0 < height; y0 += rows) {
    abortIfNeeded(hooks.signal);
    const y1 = Math.min(height, y0 + rows);
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // Inversa: origen = R^-1 (destino - centro) + centro.
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const sx = dx * cos - dy * sin + cx - 0.5;
        const sy = dx * sin + dy * cos + cy - 0.5;
        const o = (y * width + x) * 4;
        if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) {
          out[o] = fill;
          out[o + 1] = fill;
          out[o + 2] = fill;
          out[o + 3] = 255;
          continue;
        }
        const x0 = Math.floor(sx);
        const y0i = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0i;
        const i00 = (y0i * width + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + width * 4;
        const i11 = i01 + 4;
        for (let c = 0; c < 3; c += 1) {
          const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
          const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
          out[o + c] = top * (1 - fy) + bottom * fy;
        }
        out[o + 3] = 255;
      }
    }
    if (hooks.yield && y1 < height) await hooks.yield();
  }
  return { data: out, width, height };
}

/* ------------------------------------------------------------------ *
 * Escala
 * ------------------------------------------------------------------ */

/** Cambia el tamano (bilineal al ampliar, por promedio de bloques al reducir). */
export async function resizeTo(image: Rgba, width: number, height: number, hooks: PrepHooks = {}): Promise<Rgba> {
  if (width === image.width && height === image.height) return image;
  if (width <= image.width && height <= image.height) return downscaleRgba(image, Math.max(width, height));
  const out = new Uint8ClampedArray(width * height * 4);
  const rows = Math.max(16, Math.floor(400_000 / width));
  const kx = image.width / width;
  const ky = image.height / height;
  for (let y0 = 0; y0 < height; y0 += rows) {
    abortIfNeeded(hooks.signal);
    const y1 = Math.min(height, y0 + rows);
    for (let y = y0; y < y1; y += 1) {
      const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * ky - 0.5));
      const yy = Math.floor(sy);
      const fy = sy - yy;
      const yn = Math.min(image.height - 1, yy + 1);
      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * kx - 0.5));
        const xx = Math.floor(sx);
        const fx = sx - xx;
        const xn = Math.min(image.width - 1, xx + 1);
        const o = (y * width + x) * 4;
        for (let c = 0; c < 4; c += 1) {
          const top = image.data[(yy * image.width + xx) * 4 + c] * (1 - fx) + image.data[(yy * image.width + xn) * 4 + c] * fx;
          const bottom = image.data[(yn * image.width + xx) * 4 + c] * (1 - fx) + image.data[(yn * image.width + xn) * 4 + c] * fx;
          out[o + c] = top * (1 - fy) + bottom * fy;
        }
      }
    }
    if (hooks.yield && y1 < height) await hooks.yield();
  }
  return { data: out, width, height };
}

/** Tamano de salida: lado largo `PREP_TARGET_LONG_SIDE` (sin ampliar mas de `MAX_UPSCALE`). */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const k = Math.max(1 / 4, Math.min(MAX_UPSCALE, PREP_TARGET_LONG_SIDE / long));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/* ------------------------------------------------------------------ *
 * Receta
 * ------------------------------------------------------------------ */

/** Mediana del borde de una imagen (el papel tras `enhanceDocument` es casi blanco: 245-255). */
function paperLevel(image: Rgba): number {
  const samples: number[] = [];
  const step = Math.max(1, Math.floor(image.width / 40));
  for (let x = 0; x < image.width; x += step) {
    for (const y of [Math.floor(image.height * 0.02), Math.floor(image.height * 0.98)]) samples.push(image.data[(y * image.width + x) * 4 + 1]);
  }
  samples.sort((a, b) => a - b);
  return samples.length > 0 ? samples[samples.length >> 1] : 255;
}

/** Escala de grises con contraste local (segundo intento): normaliza cada pixel por el fondo y reparte el rango. */
async function localContrast(image: Rgba, hooks: PrepHooks): Promise<void> {
  const maps: BackgroundMap[] = backgroundMapsFor(downscaleRgba(image, 1280), image.width, image.height);
  const { data, width, height } = image;
  const band = 128;
  for (let y0 = 0; y0 < height; y0 += band) {
    abortIfNeeded(hooks.signal);
    const y1 = Math.min(height, y0 + band);
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        const gray = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
        const map = maps[1];
        const bx = Math.min(map.width - 1, Math.max(0, Math.floor(x * map.scaleX)));
        const by = Math.min(map.height - 1, Math.max(0, Math.floor(y * map.scaleY)));
        const bg = Math.max(40, map.data[by * map.width + bx]);
        // Contraste: lo que esta a menos del 70 % del fondo va a negro; mas del 92 %, a blanco.
        const ratio = gray / bg;
        const v = clampByte(((ratio - 0.55) / (0.95 - 0.55)) * 255);
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
      }
    }
    if (hooks.yield && y1 < height) await hooks.yield();
  }
}

/**
 * Prepara una imagen para el OCR. `attempt` 0 = receta normal; 1 = segunda receta (sin recorte). Devuelve la imagen nueva (la de
 * entrada no se toca) y lo que se hizo.
 */
export async function prepareImage(source: Rgba, options: { kind: PrepKind; attempt: number } & PrepHooks): Promise<{ image: Rgba; info: PrepInfo }> {
  const hooks: PrepHooks = { signal: options.signal, yield: options.yield };
  abortIfNeeded(options.signal);
  let work: Rgba = source;
  let cropped = false;
  if (options.kind === "photo" && options.attempt === 0) {
    const quad = await findDocumentCorners(source, "document", hooks.yield);
    abortIfNeeded(options.signal);
    if (quad) {
      const natural = quadOutputSize(quad, source.width, source.height);
      const size = targetSize(natural.width, natural.height);
      const homography = inverseHomography(quad, source.width, source.height, size.width, size.height);
      if (homography) {
        const data = new Uint8ClampedArray(size.width * size.height * 4);
        const rows = Math.max(8, Math.floor(450_000 / size.width));
        for (let y = 0; y < size.height; y += rows) {
          abortIfNeeded(options.signal);
          warpRowsInto(source, homography, size.width, y, Math.min(size.height, y + rows), data);
          if (hooks.yield && y + rows < size.height) await hooks.yield();
        }
        work = { data, width: size.width, height: size.height };
        cropped = true;
      }
    }
  }
  if (!cropped) {
    const size = targetSize(source.width, source.height);
    work = await resizeTo(source, size.width, size.height, hooks);
    // `resizeTo` devuelve la misma imagen si no cambia el tamano: se copia para no modificar la entrada.
    if (work === source) work = { data: new Uint8ClampedArray(source.data), width: source.width, height: source.height };
  }
  abortIfNeeded(options.signal);
  if (options.attempt === 0) await enhanceDocument(work, { onBand: hooks.yield });
  else await localContrast(work, hooks);
  abortIfNeeded(options.signal);
  const angle = estimateSkew(work, cropped ? SKEW_RANGE_CROPPED : options.kind === "photo" ? SKEW_RANGE_FREE : SKEW_RANGE_CROPPED);
  if (angle !== 0) work = await rotateBy(work, angle, options.attempt === 0 ? Math.max(paperLevel(work), 235) : 255, hooks);
  return { image: work, info: { cropped, angle, longSide: Math.max(work.width, work.height) } };
}
