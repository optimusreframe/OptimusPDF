/**
 * Núcleo PURO de la huella robusta (sin pdf.js, sin DOM, sin red): normalización del texto, MinHash de trigramas de
 * palabras y dHash de 64 bits. Determinista: la misma entrada da SIEMPRE los mismos números (semillas fijas), en
 * cualquier navegador y en Node. Lo usan el motor (`fingerprintEngine.ts`), el worker y las pruebas.
 */

/** Permutaciones del MinHash (128 → error típico del Jaccard estimado ≈ 0,03-0,04). */
export const MINHASH_SIZE = 128;
/** Una página con menos letras/cifras que esto (ya normalizada) cuenta como «sin texto» y se compara por dHash. */
export const MIN_TEXT_CHARS = 16;
/** Palabras máximas por página que entran en el MinHash (tope de memoria/tiempo con páginas gigantes). */
export const MAX_WORDS_PER_PAGE = 20_000;
/** Lado de la rejilla en gris con la que se calcula el dHash. */
export const DHASH_GRID = 32;
/** Diferencia mínima (niveles de gris, 0..255) entre vecinos para que el bit del dHash sea 1: estabiliza las páginas lisas. */
export const DHASH_MARGIN = 0.5;

/* ------------------------------------------------------------------ *
 * Normalización del texto
 * ------------------------------------------------------------------ */

const MONTHS =
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|" +
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "ene|feb|mar|abr|jun|jul|ago|sept|sep|oct|nov|dic|jan|apr|aug|dec";

/** Fechas y horas: son los datos que cambian de un ejemplar a otro del mismo contrato. Se aplican en este orden. */
const DATE_PATTERNS: RegExp[] = [
  // 15/10/2026, 2026-10-15, 15 - 10 - 26
  /\b\d{1,4}\s?[/-]\s?\d{1,2}\s?[/-]\s?\d{1,4}\b/gu,
  // 15.10.2026, 2026.10.15 (con año de 4 cifras: «4.2.1» es una cláusula y se conserva)
  /\b(?:\d{1,2}\.\d{1,2}\.\d{4}|\d{4}\.\d{1,2}\.\d{1,2})\b/gu,
  // 15 de octubre de 2026, 15 octubre 2026, 15 de octubre
  new RegExp(`\\b\\d{1,2}\\s+(?:de\\s+)?(?:${MONTHS})\\b\\.?(?:\\s+(?:de|del)\\s+\\d{2,4}|\\s+\\d{4})?`, "gu"),
  // de octubre de 2026, October 2026
  new RegExp(`(?:\\bde\\s+)?\\b(?:${MONTHS})\\b\\.?(?:\\s+(?:de|del))?\\s*,?\\s*\\d{4}\\b`, "gu"),
  // October 15, 2026 / Oct 15th
  new RegExp(`\\b(?:${MONTHS})\\b\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*\\d{4}\\b)?`, "gu"),
  // 10:30, 10:30:15, 10:30 pm
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\b\.?)?/gu,
];

/** Caracteres invisibles que cambian de un generador de PDF a otro sin cambiar lo que se lee. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/gu;

/**
 * Texto normalizado de una página: NFKC, minúsculas, sin fechas ni horas, sin folios/números largos/códigos (todo
 * token con cifras que no sea un número de 1 a 3 cifras: «0012345», «CLM-2026-77», «$1,500.00», «2026»), sin
 * puntuación, y con los espacios colapsados. Se conservan los números cortos («30 días», «cláusula 4») porque
 * cambiarlos sí cambia el contrato.
 */
export function normalizeText(input: string): string {
  let text = input.normalize("NFKC").toLowerCase().normalize("NFKC").replace(INVISIBLE, "");
  for (const pattern of DATE_PATTERNS) text = text.replace(pattern, " ");
  const kept: string[] = [];
  for (const token of text.split(/\s+/u)) {
    if (token === "") continue;
    const core = token.replace(/[^\p{L}\p{N}]/gu, "");
    if (core === "") continue;
    if (/\p{N}/u.test(core) && !/^\p{Nd}{1,3}$/u.test(core)) continue;
    kept.push(token);
  }
  return kept
    .join(" ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** ¿La página tiene texto suficiente para compararse por texto? (si no, se compara por imagen) */
export function hasUsefulText(normalized: string): boolean {
  return normalized.replace(/\s+/gu, "").length >= MIN_TEXT_CHARS;
}

/* ------------------------------------------------------------------ *
 * MinHash de trigramas de palabras
 * ------------------------------------------------------------------ */

/** Trigramas de palabras («a b c», «b c d», …). Con menos de 3 palabras, un solo «trigrama» con todas. */
export function wordShingles(normalized: string): string[] {
  if (normalized === "") return [];
  const words = normalized.split(" ");
  if (words.length > MAX_WORDS_PER_PAGE) words.length = MAX_WORDS_PER_PAGE;
  if (words.length < 3) return [words.join(" ")];
  const out: string[] = [];
  for (let index = 0; index + 2 < words.length; index += 1) {
    out.push(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return out;
}

/** Mezcla final de 32 bits (finalizador de MurmurHash3). */
function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash de 32 bits de una cadena (FNV-1a sobre unidades UTF-16, con mezcla final). */
export function hashString32(value: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/** Semillas FIJAS de las 128 permutaciones (generador splitmix32): no cambian jamás sin subir `FINGERPRINT_VERSION`. */
const MULTIPLIERS = new Uint32Array(MINHASH_SIZE);
const OFFSETS = new Uint32Array(MINHASH_SIZE);
(() => {
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  for (let index = 0; index < MINHASH_SIZE; index += 1) {
    MULTIPLIERS[index] = (next() | 1) >>> 0; // impar: multiplicar por un impar es una biyección módulo 2^32
    OFFSETS[index] = next();
  }
})();

/** MinHash de un conjunto de trigramas: `MINHASH_SIZE` enteros sin signo de 32 bits. */
export function minhashOf(shingles: readonly string[]): number[] {
  const slots = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const shingle of shingles) {
    const base = hashString32(shingle);
    for (let index = 0; index < MINHASH_SIZE; index += 1) {
      const value = mix32(Math.imul(base, MULTIPLIERS[index]) ^ OFFSETS[index]);
      if (value < slots[index]) slots[index] = value;
    }
  }
  return Array.from(slots);
}

/** Jaccard estimado: fracción de posiciones iguales. 0 si alguno no tiene los 128 valores. */
export function estimateJaccard(a: readonly number[], b: readonly number[]): number {
  if (a.length !== MINHASH_SIZE || b.length !== MINHASH_SIZE) return 0;
  let equal = 0;
  for (let index = 0; index < MINHASH_SIZE; index += 1) if (a[index] === b[index]) equal += 1;
  return equal / MINHASH_SIZE;
}

/**
 * Nº de trigramas distintos de una página, ESTIMADO con sus 128 mínimos: cada uno es el mínimo de n valores uniformes en
 * [0, 2^32), de media 1/(n+1) (error típico ≈ 9 %). Sirve para saber si un conjunto es mucho mayor que otro sin guardar
 * nada más en la huella (la comparación puede mejorar sin subir `FINGERPRINT_VERSION`). `NaN` si no son 128 valores.
 */
export function estimateSetSize(minhash: readonly number[]): number {
  if (minhash.length !== MINHASH_SIZE) return Number.NaN;
  let sum = 0;
  for (const value of minhash) sum += value / 4_294_967_296;
  const mean = sum / MINHASH_SIZE;
  return mean > 0 ? 1 / mean - 1 : Number.POSITIVE_INFINITY;
}

/* ------------------------------------------------------------------ *
 * dHash de 64 bits
 * ------------------------------------------------------------------ */

/** Luminancia (Rec. 601) de una imagen RGBA; el alfa se compone sobre blanco. */
export function grayFromRgba(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let index = 0; index < out.length; index += 1) {
    const alpha = rgba[index * 4 + 3] / 255;
    const luminance = 0.299 * rgba[index * 4] + 0.587 * rgba[index * 4 + 1] + 0.114 * rgba[index * 4 + 2];
    out[index] = luminance * alpha + 255 * (1 - alpha);
  }
  return out;
}

/** Pesos (por índice destino) de reducir una dimensión de `source` a `target` por promedio de áreas. */
function areaWeights(source: number, target: number): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  const ratio = source / target;
  for (let t = 0; t < target; t += 1) {
    const from = t * ratio;
    const to = (t + 1) * ratio;
    const weights: Array<[number, number]> = [];
    for (let s = Math.floor(from); s < Math.min(source, Math.ceil(to)); s += 1) {
      const overlap = Math.min(to, s + 1) - Math.max(from, s);
      if (overlap > 0) weights.push([s, overlap / ratio]);
    }
    out.push(weights);
  }
  return out;
}

/** Reduce una imagen en gris a `targetWidth × targetHeight` promediando áreas (separable, determinista). */
export function resizeGray(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Float32Array {
  const columns = areaWeights(sourceWidth, targetWidth);
  const rows = areaWeights(sourceHeight, targetHeight);
  const horizontal = new Float32Array(targetWidth * sourceHeight);
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      let sum = 0;
      for (const [s, weight] of columns[x]) sum += source[y * sourceWidth + s] * weight;
      horizontal[y * targetWidth + x] = sum;
    }
  }
  const out = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      let sum = 0;
      for (const [s, weight] of rows[y]) sum += horizontal[s * targetWidth + x] * weight;
      out[y * targetWidth + x] = sum;
    }
  }
  return out;
}

/**
 * dHash de 64 bits (16 hex) de una página en gris de `DHASH_GRID × DHASH_GRID`: se reduce a 9×8 y cada bit dice si
 * un píxel es más claro que su vecino de la derecha por más de `DHASH_MARGIN` niveles (fila a fila, de arriba abajo).
 */
export function dhashFromGray(gray: ArrayLike<number>, width = DHASH_GRID, height = DHASH_GRID, margin = DHASH_MARGIN): string {
  const small = resizeGray(gray, width, height, 9, 8);
  let hex = "";
  for (let row = 0; row < 8; row += 1) {
    let nibbleA = 0;
    let nibbleB = 0;
    for (let column = 0; column < 4; column += 1) {
      nibbleA = (nibbleA << 1) | (small[row * 9 + column] - small[row * 9 + column + 1] > margin ? 1 : 0);
      nibbleB = (nibbleB << 1) | (small[row * 9 + column + 4] - small[row * 9 + column + 5] > margin ? 1 : 0);
    }
    hex += nibbleA.toString(16) + nibbleB.toString(16);
  }
  return hex;
}

/** Distancia de Hamming entre dos dHash de 16 hex; `Infinity` si alguno no tiene la forma correcta. */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return Infinity;
  let bits = 0;
  for (let index = 0; index < 16; index += 1) {
    let xor = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    while (xor) {
      bits += xor & 1;
      xor >>= 1;
    }
  }
  return bits;
}
