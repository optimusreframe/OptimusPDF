/**
 * Calibracion del codificador JPEG del navegador. `canvas.toBlob("image/jpeg", calidad)` NO significa lo mismo en todos los
 * motores: el WebKit de iPhone/iPad (ImageIO) pesa ~1,5-1,8 veces mas que Chromium con la misma «calidad» (a calidad 0,6
 * pesa lo que Chromium a 0,8). Para que «Equilibrada» pese lo mismo en un iPad que en un ordenador, se codifica UNA vez por
 * sesion una imagen de prueba determinista (la misma en todos los motores, pixel a pixel) y se compara con lo que pesa en
 * Chromium (`CALIBRATION_REFERENCE`); si pesa mas, se baja la calidad hasta igualarlo (el JPEG de WebKit a esa calidad
 * menor sigue viendose igual de bien: mismo peso, PSNR igual o mejor, medido). Todo puro salvo `measure`.
 */

export const CALIBRATION_SIZE = 384;

/**
 * Imagenes de prueba: una sola no basta, porque el peso relativo de dos codificadores cambia con el CONTENIDO (WebKit pesa
 * mas que Chromium con una foto de mucha textura y casi igual con una lisa). Se usan tres con contenido distinto y se iguala
 * la MEDIA GEOMETRICA de los cocientes. `mixed` = degradado + textura + bordes + grano (la original), `smooth` = cielo y
 * paredes (casi sin detalle), `texture` = follaje, grava, tejas (energia a todas las escalas y bordes duros).
 */
export type CalibrationKind = "mixed" | "smooth" | "texture";
export const CALIBRATION_KINDS: readonly CalibrationKind[] = ["mixed", "smooth", "texture"];
/** Lado (px) de cada imagen de prueba. */
export function calibrationSize(kind: CalibrationKind): number {
  return kind === "mixed" ? CALIBRATION_SIZE : 320;
}

function xorshift(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** Cielo y paredes: degradados suaves, dos manchas redondas de bordes blandos y un grano muy fino. */
function smoothPixels(): Uint8ClampedArray {
  const size = 320;
  const data = new Uint8ClampedArray(size * size * 4);
  const random = xorshift(0x1f123bb5);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const fx = x / size;
      const fy = y / size;
      const blob1 = 38 * Math.exp(-(((fx - 0.3) * 3.2) ** 2 + ((fy - 0.35) * 3.2) ** 2));
      const blob2 = 30 * Math.exp(-(((fx - 0.72) * 2.6) ** 2 + ((fy - 0.7) * 2.8) ** 2));
      const base = 95 + 80 * fy - 25 * fx + blob1 - blob2;
      const grain = (random() + random() - 1) * 2.2;
      data[at] = base * 0.92 + 12 + grain;
      data[at + 1] = base * 0.97 + 8 + grain;
      data[at + 2] = base * 1.08 + grain;
      data[at + 3] = 255;
    }
  }
  return data;
}

/** Follaje y grava: ruido de valor a cuatro escalas con mucha energia, tejas con bordes duros y grano marcado. */
function texturePixels(): Uint8ClampedArray {
  const size = 320;
  const data = new Uint8ClampedArray(size * size * 4);
  const random = xorshift(0x6c8e9cf5);
  const lattice = new Float32Array(64 * 64);
  for (let index = 0; index < lattice.length; index += 1) lattice[index] = random() * 2 - 1;
  const noise = (x: number, y: number, cell: number): number => {
    const fx = x / cell;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (ix: number, iy: number): number => lattice[(iy & 63) * 64 + (ix & 63)];
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const tile = (Math.floor(y / 24) % 2 === 0 ? (x + 12) % 48 : x % 48) < 3 || y % 24 < 2 ? -46 : 0;
      const value = 118 + 46 * noise(x, y, 40) + 34 * noise(x, y, 14) + 26 * noise(x, y, 5) + 18 * noise(x, y, 2) + tile + (random() + random() + random() - 1.5) * 9;
      data[at] = value * 0.9 + 16 * noise(x, y, 60);
      data[at + 1] = value * 1.02;
      data[at + 2] = value * 0.78 + 12 * noise(x + 99, y, 33);
      data[at + 3] = 255;
    }
  }
  return data;
}

/** Imagen de prueba determinista (RGBA, `calibrationSize(kind)` de lado): la misma, pixel a pixel, en todos los motores. */
export function calibrationPixels(kind: CalibrationKind = "mixed"): Uint8ClampedArray {
  if (kind === "smooth") return smoothPixels();
  if (kind === "texture") return texturePixels();
  return mixedPixels();
}

/** Degradado, textura de media frecuencia, bordes nitidos y grano suave. */
function mixedPixels(): Uint8ClampedArray {
  const size = CALIBRATION_SIZE;
  const data = new Uint8ClampedArray(size * size * 4);
  let state = 0x2545f491;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const gradient = 60 + (x / size) * 90 + (y / size) * 50;
      const texture = 14 * Math.sin(x * 0.21) * Math.cos(y * 0.17) + 9 * Math.sin((x + y) * 0.53);
      // Bloques con borde nitido (tejas, ventanas): cambian el nivel de golpe.
      const block = ((Math.floor(x / 48) + Math.floor(y / 40)) % 3) * 22;
      const grain = (random() + random() + random() - 1.5) * 5;
      const value = gradient + texture + block + grain;
      data[at] = value + 10;
      data[at + 1] = value * 0.92 + 18 * Math.sin(x * 0.05);
      data[at + 2] = value * 0.8 + 30 * (y / size);
      data[at + 3] = 255;
    }
  }
  return data;
}

/** Bytes de la imagen de prueba codificada por Chromium a cada calidad (medidos con Chromium 151; el WebKit de Playwright da 17397 / 22002 / 31002 / 39469 / 51008 / 56006 / 57836). */
export const CALIBRATION_REFERENCE: ReadonlyArray<readonly [number, number]> = [
  [0.5, 11832],
  [0.6, 13062],
  [0.7, 15251],
  [0.8, 19599],
  [0.87, 25164],
  [0.92, 33816],
  [0.95, 48260],
];

/**
 * Pesos de las tres imagenes de prueba codificadas por Chromium 151 a cada calidad (`canvas.toBlob`). El WebKit de Playwright
 * pesa 1,1-2,6 veces mas segun la imagen (la lisa es la mas penalizada): por eso se iguala la media geometrica, no una sola.
 */
export const CALIBRATION_REFERENCES: Readonly<Record<CalibrationKind, ReadonlyArray<readonly [number, number]>>> = {
  mixed: CALIBRATION_REFERENCE,
  smooth: [
    [0.5, 2064],
    [0.6, 2254],
    [0.7, 2515],
    [0.8, 3168],
    [0.87, 4389],
    [0.92, 7080],
    [0.95, 11793],
  ],
  texture: [
    [0.5, 14303],
    [0.6, 16404],
    [0.7, 19473],
    [0.8, 24371],
    [0.87, 31318],
    [0.92, 41543],
    [0.95, 53617],
  ],
};

/** El codificador puede pesar hasta un 4 % mas que Chromium (media geometrica de las tres imagenes) sin que se corrija la calidad. */
export const CALIBRATION_MEAN_TOLERANCE = 1.04;

/**
 * Media geometrica de los cocientes `peso medido / peso de Chromium a la calidad pedida` de las imagenes de prueba. 1 = pesa
 * igual que Chromium; 2 = el doble. `Infinity` si falta alguna referencia o medida (no se corrige nada).
 */
export function geometricMeanRatio(requestedQuality: number, measured: Readonly<Record<CalibrationKind, number>>): number {
  let logSum = 0;
  for (const kind of CALIBRATION_KINDS) {
    const reference = referenceBytesFor(requestedQuality, CALIBRATION_REFERENCES[kind]);
    const bytes = measured[kind];
    if (!(reference > 0) || !(bytes > 0) || !Number.isFinite(reference)) return Number.POSITIVE_INFINITY;
    logSum += Math.log(bytes / reference);
  }
  return Math.exp(logSum / CALIBRATION_KINDS.length);
}

/** Peso de referencia para una calidad cualquiera (interpolado linealmente entre los puntos medidos). */
export function referenceBytesFor(quality: number, table: ReadonlyArray<readonly [number, number]> = CALIBRATION_REFERENCE): number {
  if (table.length === 0) return Number.POSITIVE_INFINITY;
  if (quality <= table[0][0]) return table[0][1];
  for (let index = 1; index < table.length; index += 1) {
    const [q1, b1] = table[index];
    const [q0, b0] = table[index - 1];
    if (quality <= q1) return b0 + ((b1 - b0) * (quality - q0)) / (q1 - q0);
  }
  return table[table.length - 1][1];
}

/** El codificador puede pesar hasta un 12 % mas que Chromium sin que se corrija la calidad. */
export const CALIBRATION_TOLERANCE = 1.12;
/** Por debajo de esto no se baja nunca la calidad (la imagen se veria mal). */
export const MIN_CALIBRATED_QUALITY = 0.5;

/**
 * La calidad mas alta (<= `quality`, >= `MIN_CALIBRATED_QUALITY`) con la que `measure` (bytes de la imagen de prueba) no
 * pasa de `reference * tolerance`. Biseccion: asume que el peso crece con la calidad. Sin referencia (`Infinity`) o si ya
 * cabe, devuelve `quality` sin tocar.
 */
export async function pickCalibratedQuality(
  quality: number,
  reference: number,
  measure: (quality: number) => Promise<number>,
  tolerance: number = CALIBRATION_TOLERANCE,
): Promise<number> {
  if (!Number.isFinite(reference)) return quality;
  const limit = reference * tolerance;
  if ((await measure(quality)) <= limit) return quality;
  let low = MIN_CALIBRATED_QUALITY;
  let high = quality;
  if ((await measure(low)) > limit) return low;
  for (let step = 0; step < 6; step += 1) {
    const middle = (low + high) / 2;
    if ((await measure(middle)) <= limit) low = middle;
    else high = middle;
  }
  return Math.round(low * 1000) / 1000;
}
