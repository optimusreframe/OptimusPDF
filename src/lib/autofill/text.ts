/**
 * Utilidades de TEXTO del motor de autorrelleno (puras, sin DOM): plegado de mayusculas y tildes que NO cambia la longitud
 * (para buscar etiquetas en el texto plegado y cortar el valor en el texto original), limpieza de espacios, rellenos de formulario
 * («______», «......») y valores basura («N/A», «TBD»). Ningun valor sale de aqui: son funciones sin estado ni efectos.
 */

/** Pliega UN caracter no ASCII a su letra base en minuscula; si el plegado cambiara la longitud, lo deja igual. */
function foldNonAscii(char: string): string {
  if (char === "İ") return "i";
  const lower = char.toLowerCase();
  if (lower.length !== char.length) return char;
  const base = lower.normalize("NFD").charAt(0);
  return base.length === char.length ? base : lower;
}

/**
 * Minuscula sin tildes ni dieresis, con la MISMA longitud que el original (cada letra se pliega a una sola letra): un indice del
 * texto plegado vale tal cual en el texto original. «Año» -> «ano», «ÁLVAREZ» -> «alvarez».
 */
export function fold(text: string): string {
  // Solo se bajan las ASCII a mano: `toLowerCase` de ciertas letras (como la «İ» turca) cambia la longitud.
  return text.replace(/[^\x00-\x7f]/gu, foldNonAscii).replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
}

/**
 * Normaliza lo que entrega una fuente de texto: comillas tipograficas a ASCII, espacios raros (NBSP, finos, de ancho cero) a
 * espacio normal o nada, y caracteres de control fuera. No toca letras ni cifras.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[   -   　]/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

/** Varios espacios (y tabuladores) a uno, sin bordes. */
export function collapseSpaces(text: string): string {
  return text.replace(/[ \t\r\n]+/g, " ").trim();
}

/** Recorta a `max` caracteres con puntos suspensivos. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Rellenos de formulario: rayas de guiones bajos, puntos suspensivos largos, guiones largos y casillas vacias. No llevan
 * informacion; la persona (o la plantilla) escribe encima.
 */
const FILLER_RE = /_{2,}|\.{4,}|…{2,}|-{4,}|—{2,}|–{3,}|[─-┃▁]+|\[\s*\]|\(\s*\)|[☐□]/gu;

export function hasFiller(text: string): boolean {
  FILLER_RE.lastIndex = 0;
  return FILLER_RE.test(text);
}

/** Quita los rellenos y los sustituye por un espacio (o por `replacement`). */
export function stripFiller(text: string, replacement = " "): string {
  return text.replace(FILLER_RE, replacement);
}

/** El texto no tiene nada que no sea relleno, espacios o signos sueltos. */
export function isBlank(text: string): boolean {
  return stripFiller(text).replace(/[\s:;,.\-–—/\\|()[\]*#_]+/g, "") === "";
}

/** Valores que son «no hay dato». */
const JUNK_RE =
  /^(?:n\/?a|n\.a\.?|na|none|nil|null|nulo|tbd|tba|pending|pendiente|unknown|desconocido|ninguno|ninguna|no aplica|no applicable|not applicable|same as above|igual|igual que arriba|ver arriba|see above|x+|-+|\?+|\.+|xxx+|_+)$/iu;

export function isJunkValue(text: string): boolean {
  const plain = collapseSpaces(text).replace(/^[\s:;,.\-–—()[\]"']+|[\s:;,.\-–—()[\]"']+$/g, "");
  return plain === "" || JUNK_RE.test(plain);
}

/** Limpia los extremos de un valor leido tras una etiqueta: sin relleno, sin signos sueltos, sin espacios dobles. */
export function cleanValue(raw: string): string {
  return collapseSpaces(stripFiller(raw))
    .replace(/^[\s:;,\-–—|•●·]+/u, "")
    .replace(/\s+[-–—]+\s*$|[\s;,|•●·]+$/u, "")
    .trim();
}

/** ¿El texto es todo mayusculas (ignorando lo que no son letras) y tiene al menos dos letras? */
export function isAllUpper(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

export function isAllLower(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toLowerCase() && letters !== letters.toUpperCase();
}

const SMALL_WORDS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "o", "and", "of", "the", "van", "von", "der", "den", "da", "das", "do", "dos", "di", "du", "bin", "al", "le", "st", "en", "por", "con", "para"]);

/** Partes que van en minuscula dentro de un nombre propio o de una razon social (no la primera palabra). */
export function isSmallWord(word: string): boolean {
  return SMALL_WORDS.has(word.toLowerCase());
}

/** Una palabra a «Titulo»: respeta guiones, apostrofes y los prefijos Mc/O'. */
export function titleWord(word: string): string {
  if (word === "") return word;
  const lower = word.toLowerCase();
  const cap = (part: string): string => (part === "" ? part : part.charAt(0).toUpperCase() + part.slice(1));
  return lower
    .split("-")
    .map((chunk) =>
      chunk
        .split("'")
        .map((piece, index) => {
          const upper = cap(piece);
          // «Mcdonald» -> «McDonald» (solo con al menos 5 letras para no tocar «Mca»).
          if (index === 0 && /^mc[a-z]{3,}$/.test(piece)) return `Mc${cap(piece.slice(2))}`;
          return upper;
        })
        .join("'"),
    )
    .join("-");
}
