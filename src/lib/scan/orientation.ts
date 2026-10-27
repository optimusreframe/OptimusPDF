import type { OcrResult } from "@/lib/scan/ocr";
import { analysisGray, inkStatsOf } from "@/lib/scan/quality";
import { rotateRgba, type Gray, type Rgba } from "@/lib/scan/pixels";
import type { ScanRotation } from "@/lib/scan/types";

/**
 * Orientacion del texto SIN OCR (heuristica barata por proyeccion): decide si las lineas son horizontales o verticales por
 * la periodicidad del perfil de tinta, y cual lado es «arriba» por la asimetria entre ascendentes (b d f h k l t) y
 * descendentes (g j p q y) de cada linea y por el borde izquierdo alineado del texto. Si la evidencia es debil devuelve
 * `null`: NUNCA gira a ciegas.
 *
 * Es una heuristica para texto latino (espanol/ingles); una pagina de mayusculas sueltas, cifras o dibujos no da evidencia.
 */

export type OrientationReading = {
  /** Giro horario (relativo a la imagen recibida) que deja el texto derecho. */
  rotation: ScanRotation;
  /** 0..1: fuerza de la evidencia. */
  confidence: number;
};

/** Ancho de analisis de la pagina. */
const WIDTH = 560;
/** Evidencia minima del eje horizontal/vertical. */
const MIN_AXIS_PERIODICITY = 0.2;
const MIN_AXIS_MARGIN = 0.1;
/** Evidencia minima arriba/abajo. */
const MIN_FLIP_SCORE = 0.16;

function smooth1d(values: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k += 1) {
      sum += values[k];
      count += 1;
    }
    out[i] = sum / count;
  }
  return out;
}

/** Perfiles de tinta por fila y por columna. */
export function inkProfiles(mask: Uint8Array, width: number, height: number): { rows: Float32Array; cols: Float32Array } {
  const rows = new Float32Array(height);
  const cols = new Float32Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        rows[y] += 1;
        cols[x] += 1;
      }
    }
  }
  return { rows, cols };
}

/** Mayor pico de autocorrelacion (despues del primer cruce por cero) de un perfil: 0 = sin periodicidad. */
export function periodicity(profile: Float32Array): number {
  const n = profile.length;
  if (n < 24) return 0;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += profile[i];
  mean /= n;
  const p = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i += 1) {
    p[i] = profile[i] - mean;
    energy += p[i] * p[i];
  }
  if (energy < 1e-6) return 0;
  const maxLag = Math.min(Math.floor(n / 4), 90);
  let crossed = false;
  let best = 0;
  let previous = 1;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < n; i += 1) sum += p[i] * p[i + lag];
    const r = sum / energy;
    if (!crossed && r < 0) crossed = true;
    if (crossed && r > previous && r > best) best = r;
    previous = r;
  }
  return Math.max(0, best);
}

type Band = { from: number; to: number };

/** Lineas de texto de un perfil por filas: tramos densos ampliados a sus ascendentes/descendentes. */
export function findLineBands(rows: Float32Array): Band[] {
  const s = smooth1d(rows, 1);
  const sorted = Array.from(s).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  if (p95 < 3) return [];
  const high = p95 * 0.1;
  const low = p95 * 0.02;
  const runs: Band[] = [];
  let start = -1;
  for (let y = 0; y <= s.length; y += 1) {
    const on = y < s.length && s[y] > high;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (y - start >= 4) runs.push({ from: start, to: y - 1 });
      start = -1;
    }
  }
  const bands: Band[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const limitUp = i === 0 ? 0 : Math.floor((runs[i - 1].to + runs[i].from) / 2);
    const limitDown = i === runs.length - 1 ? s.length - 1 : Math.ceil((runs[i].to + runs[i + 1].from) / 2);
    let from = runs[i].from;
    while (from > limitUp && s[from - 1] > low) from -= 1;
    let to = runs[i].to;
    while (to < limitDown && s[to + 1] > low) to += 1;
    bands.push({ from, to });
  }
  return bands;
}

type FlipEvidence = { score: number; lines: number };

/**
 * Evidencia de «derecho» (positiva) o «cabeza abajo» (negativa) para texto ya horizontal. Combina la asimetria
 * ascendentes/descendentes y el borde izquierdo alineado.
 */
export function flipEvidence(mask: Uint8Array, width: number, height: number): FlipEvidence {
  const { rows } = inkProfiles(mask, width, height);
  const bands = findLineBands(rows);
  let weighted = 0;
  let weights = 0;
  const starts: number[] = [];
  const ends: number[] = [];
  let lengthSum = 0;
  let lines = 0;
  for (const band of bands) {
    if (band.to - band.from < 6) continue;
    let peak = 0;
    let mass = 0;
    for (let y = band.from; y <= band.to; y += 1) {
      peak = Math.max(peak, rows[y]);
      mass += rows[y];
    }
    if (mass < width * 0.6) continue;
    let core0 = band.from;
    while (core0 < band.to && rows[core0] < peak * 0.45) core0 += 1;
    let core1 = band.to;
    while (core1 > core0 && rows[core1] < peak * 0.45) core1 -= 1;
    let asc = 0;
    let desc = 0;
    let coreMass = 0;
    for (let y = band.from; y <= band.to; y += 1) {
      if (y < core0) asc += rows[y];
      else if (y > core1) desc += rows[y];
      else coreMass += rows[y];
    }
    lines += 1;
    if (asc + desc > coreMass * 0.04) {
      weighted += ((asc - desc) / (asc + desc)) * mass;
      weights += mass;
    }
    // Extremos horizontales de la linea (cuantiles para ignorar manchas sueltas).
    const columns: number[] = [];
    for (let x = 0; x < width; x += 1) {
      let any = 0;
      for (let y = core0; y <= core1; y += 1) any += mask[y * width + x];
      if (any > 0) columns.push(x);
    }
    if (columns.length > 8) {
      const a = columns[Math.floor(columns.length * 0.01)];
      const b = columns[Math.floor(columns.length * 0.99)];
      starts.push(a);
      ends.push(b);
      lengthSum += b - a;
    }
  }
  const stdOf = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  };
  let score = weights > 0 ? weighted / weights : 0;
  // Borde izquierdo alineado y derecho irregular (texto a la izquierda): solo con varias lineas largas.
  if (starts.length >= 6 && lengthSum / starts.length > width * 0.3) {
    const sStart = stdOf(starts);
    const sEnd = stdOf(ends);
    if (sStart + sEnd > 3) {
      const cue = (sEnd - sStart) / (sEnd + sStart);
      score = score * 0.7 + cue * 0.3 * (weights > 0 ? 1 : 0.6);
    }
  }
  return { score, lines };
}

/**
 * Orientacion del texto de una pagina. `null` si no hay evidencia suficiente (pagina en blanco, foto, solo mayusculas...).
 */
export function detectTextOrientation(image: Rgba | Gray): OrientationReading | null {
  const rgba: Rgba | null = "data" in image && image.data.length === image.width * image.height * 4 ? (image as Rgba) : null;
  const gray: Gray = rgba ? analysisGray(rgba, WIDTH) : (image as Gray);
  const ink = inkStatsOf(gray, { threshold: 22 });
  if (ink.fraction < 0.004 || ink.cells < 20) return null;
  const { width, height } = gray;
  const { rows, cols } = inkProfiles(ink.mask, width, height);
  const horizontal = periodicity(rows);
  const vertical = periodicity(cols);
  const axisStrength = Math.max(horizontal, vertical);
  if (axisStrength < MIN_AXIS_PERIODICITY || Math.abs(horizontal - vertical) < MIN_AXIS_MARGIN) return null;
  let mask = ink.mask;
  let w = width;
  let h = height;
  let base: 0 | 90;
  if (vertical > horizontal) {
    // Texto en vertical: se gira 90° horario para analizar las lineas en horizontal.
    const turned = rotateMask(mask, w, h);
    mask = turned.mask;
    w = turned.width;
    h = turned.height;
    base = 90;
  } else {
    base = 0;
  }
  const evidence = flipEvidence(mask, w, h);
  if (evidence.lines < 3 || Math.abs(evidence.score) < MIN_FLIP_SCORE) return null;
  const upright = evidence.score > 0;
  const rotation = (base === 0 ? (upright ? 0 : 180) : upright ? 90 : 270) as ScanRotation;
  return { rotation, confidence: Math.min(1, Math.abs(evidence.score) * 2) };
}

function rotateMask(mask: Uint8Array, width: number, height: number): { mask: Uint8Array; width: number; height: number } {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // 90° horario: (x, y) -> (height - 1 - y, x)
      out[x * height + (height - 1 - y)] = mask[y * width + x];
    }
  }
  return { mask: out, width: height, height: width };
}

/** Utilidad para pruebas: gira una imagen y devuelve la lectura relativa. */
export function detectAfterRotating(image: Rgba, quarters: number): OrientationReading | null {
  return detectTextOrientation(rotateRgba(image, quarters));
}

/* ------------------------------------------------------------------ *
 * Orientacion con OCR (cuando ya esta cargado)
 * ------------------------------------------------------------------ */


/** Puntuacion de lectura de un OCR: suma de (confianza x letras) de las palabras de >= 3 letras y buena confianza. */
export function ocrReadingScore(result: OcrResult): number {
  let score = 0;
  for (const line of result.lines) {
    for (const word of line.words) {
      const letters = (word.text.match(/\p{L}/gu) ?? []).length;
      if (letters >= 3 && word.confidence >= 60) score += (word.confidence / 100) * letters;
    }
  }
  return score;
}

/**
 * Orientacion por OCR: reconoce la muestra en los cuatro giros y se queda con el que MAS texto legible da, solo si gana
 * con claridad al segundo. `null` si ninguno lee (pagina en blanco, foto...) o si estan parejos: nunca gira a ciegas.
 */
export async function ocrOrientation(image: Rgba, recognize: (image: Rgba) => Promise<OcrResult>): Promise<OrientationReading | null> {
  const scores: Array<{ rotation: ScanRotation; score: number }> = [];
  for (const rotation of [0, 90, 180, 270] as const) {
    const turned = rotation === 0 ? image : rotateRgba(image, rotation / 90);
    scores.push({ rotation, score: ocrReadingScore(await recognize(turned)) });
  }
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (best.score < 12 || best.score < second.score * 1.6) return null;
  return { rotation: best.rotation, confidence: Math.min(1, 1 - second.score / best.score) };
}
