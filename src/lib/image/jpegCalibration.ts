/**
 * Calibracion del codificador JPEG del navegador. `canvas.toBlob("image/jpeg", calidad)` NO significa lo mismo en todos los
 * motores: el WebKit de iPhone/iPad (ImageIO) pesa ~1,5-1,8 veces mas que Chromium con la misma «calidad» (a calidad 0,6
 * pesa lo que Chromium a 0,8). Para que «Equilibrada» pese lo mismo en un iPad que en un ordenador, se codifica UNA vez por
 * sesion una imagen de prueba determinista (la misma en todos los motores, pixel a pixel) y se compara con lo que pesa en
 * Chromium (`CALIBRATION_REFERENCE`); si pesa mas, se baja la calidad hasta igualarlo (el JPEG de WebKit a esa calidad
 * menor sigue viendose igual de bien: mismo peso, PSNR igual o mejor, medido). Todo puro salvo `measure`.
 */

export const CALIBRATION_SIZE = 384;

/** Imagen de prueba determinista (RGBA): degradado, textura de media frecuencia, bordes nitidos y grano suave. */
export function calibrationPixels(): Uint8ClampedArray {
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
