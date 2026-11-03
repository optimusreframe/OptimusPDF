/**
 * Nombres de personas: limpieza, validacion y separacion de «A and B» / «A y B» / «A & B» en dos asegurados.
 * Precision primero: ante la duda (digitos, palabras de formulario, razones sociales, frases) NO es un nombre.
 */

import { cleanValue, collapseSpaces, fold, isAllLower, isAllUpper, isJunkValue, isSmallWord, titleWord } from "@/lib/autofill/text";

export type NameParse = {
  /** Uno o dos nombres, ya normalizados. */
  names: string[];
  /** El apellido del segundo se copio al primero («Juan y Maria Perez»): hay que revisarlo. */
  shared: boolean;
  /** 0..1: 1 = nombre y apellido; menos = una sola palabra o muchas palabras. */
  strength: number;
  /** El texto original venia todo en minusculas (tecleado a mano o prosa): no es de fiar. */
  lower: boolean;
};

/** Razones sociales y organizaciones: no son la persona asegurada. */
const COMPANY_WORDS = new Set(
  (
    "llc llp lp inc inc. corp corp. corporation co co. company companies group solutions services service insurance assurance casualty mutual indemnity underwriters " +
    "restoration construction roofing plumbing adjusters adjuster associates partners holdings enterprises ltd properties realty bank trust attorneys attorney law legal " +
    "firm office department agency association church school hospital clinic " +
    "sa srl cia compania grupo servicios seguros aseguradora constructora inmobiliaria abogados ajustadores oficina empresa fundacion"
  ).split(" "),
);

/** Palabras de formulario o de prosa que delatan que el texto no es un nombre. */
const NOT_NAME_WORDS = new Set(
  (
    "name names nombre nombres address direccion phone telefono email correo policy poliza claim reclamo siniestro number numero date fecha loss perdida signature firma signed " +
    "print printed initials iniciales insured asegurado policyholder client cliente owner propietario customer applicant here above below same agreement hereby authorize authorizes " +
    "the to for with that this these those is are was were will shall agrees agree from by at on in or not no yes of a an as be been has have had which who whom " +
    "para con que por en es son se su sus un una este esta estos estas lo les mi tu nuestro nuestra hereby herein thereof whereas " +
    "page pagina street calle avenue avenida city ciudad state estado zip country pais county condado " +
    "dear estimado estimada attn attention sincerely regards cc re and her his their husband wife spouse children terms conditions contract authorization notice section article general summary information details declaration " +
    "declarations schedule exhibit attachment appendix letter protection retainer assignment benefits representation"
  )
    .split(" ")
    .filter(Boolean),
);

const TITLE_RE = /^(?:mr|mrs|ms|miss|mx|dr|dra|sr|sra|srta|don|dona|lic|ing|atty|prof|rev)\.?\s+/i;
const SUFFIX_RE = /^(?:jr|sr|ii|iii|iv|esq|md|phd|dds)\.?$/i;
const TOKEN_RE = /^[\p{L}][\p{L}'.\-]*$/u;

function suffixForm(token: string): string {
  const lower = token.toLowerCase().replace(/\.$/, "");
  if (lower === "jr" || lower === "sr") return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}.`;
  if (lower === "ii" || lower === "iii" || lower === "iv") return lower.toUpperCase();
  if (lower === "esq") return "Esq.";
  return token;
}

function normalizeCase(tokens: string[], force: boolean): string[] {
  if (!force) return tokens;
  return tokens.map((token, index) => {
    const plainToken = token.replace(/\.$/, "");
    if (SUFFIX_RE.test(token) && index > 0) return suffixForm(token);
    if (plainToken.length === 1) return `${plainToken.toUpperCase()}.`;
    if (index > 0 && isSmallWord(plainToken)) return plainToken.toLowerCase();
    return titleWord(token);
  });
}

/** Un solo nombre (sin «y»): quita tratamientos, reordena «Apellido, Nombre», valida palabras y normaliza mayusculas. */
function cleanOne(part: string): { text: string; tokens: number; lower: boolean } | null {
  let text = collapseSpaces(part);
  for (let pass = 0; pass < 2; pass += 1) text = text.replace(TITLE_RE, "");
  text = text.replace(/^[\s,.;:'"]+|[\s,;:'"]+$/g, "").trim();
  if (text === "") return null;

  if (text.includes(",")) {
    const segments = text.split(",").map((segment) => segment.trim());
    if (segments.length !== 2 || segments.some((segment) => segment === "")) return null;
    // «Perez, Maria» -> «Maria Perez»; «Smith, Jr.» se queda como esta.
    text = SUFFIX_RE.test(segments[1]) ? `${segments[0]} ${segments[1]}` : `${segments[1]} ${segments[0]}`;
  }

  const rawTokens = text.split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0 || rawTokens.length > 7) return null;
  for (const token of rawTokens) {
    if (token.length > 24 || !TOKEN_RE.test(token)) return null;
    const key = fold(token).replace(/[.']/g, "");
    // Una inicial («A.») nunca es una palabra de relleno.
    if (key.length === 1) continue;
    if (COMPANY_WORDS.has(key) || NOT_NAME_WORDS.has(key)) return null;
  }
  // Un nombre empieza con una letra que no es una particula, y ninguna palabra (salvo particulas) va en minuscula si hay mayusculas.
  if (isSmallWord(rawTokens[0]) && rawTokens.length > 1 && !/^[A-Z]/.test(rawTokens[0])) return null;
  const lower = isAllLower(text);
  const upper = isAllUpper(text);
  const mixed = !lower && !upper;
  if (mixed) {
    // Mezcla de mayusculas y minusculas: cada palabra (salvo particulas) debe empezar con mayuscula («Maria de la Cruz»).
    for (const token of rawTokens) {
      if (isSmallWord(token)) continue;
      if (!/^\p{Lu}/u.test(token)) return null;
    }
  }
  // El sufijo «Jr»/«Sr» sale siempre con su punto (el OCR lo pierde y un sistema de polizas lo imprime sin el).
  const tokens = normalizeCase(rawTokens, lower || upper).map((token, index) => (index > 0 && /^(?:jr|sr)$/i.test(token) ? suffixForm(token) : token));
  return { text: tokens.join(" "), tokens: tokens.length, lower };
}

/**
 * Lee el valor de una etiqueta de nombre. Devuelve uno o dos nombres, o `null` si no parece una persona.
 * `split` = permitir «A y B» (las etiquetas de un solo asegurado, como «Co-insured», pasan `false`).
 */
export function parseNames(raw: string, split = true): NameParse | null {
  let text = cleanValue(raw)
    .replace(/\((?:s|es|a|as|os)\)/gi, "")
    .replace(/\([^)]*\)/g, " ");
  text = collapseSpaces(text).replace(/[,;:\s]+$/g, "");
  // El punto final se queda tras una inicial o un sufijo («John A.», «Smith Jr.»); en cualquier otro caso se quita.
  if (/\.$/.test(text) && !/(?:\b(?:jr|sr|esq)|\b\p{L})\.$/iu.test(text)) text = text.replace(/\.+$/, "");
  if (text === "" || text.length > 90 || /[\d@:_#\\]/.test(text) || isJunkValue(text)) return null;

  const pieces = split ? text.split(/\s+(?:and|y|&|\+)\s+|\s*[;/]\s*/i).filter((piece) => piece.trim() !== "") : [text];
  if (pieces.length === 0 || pieces.length > 3) return null;
  const parsed = pieces.slice(0, 2).map(cleanOne);
  if (parsed.some((item) => item === null)) return null;
  const items = parsed as Array<NonNullable<ReturnType<typeof cleanOne>>>;

  // Mezclar una parte en minusculas con otra bien escrita delata prosa («Maria Perez and her husband»).
  if (items.length === 2 && items[0].lower !== items[1].lower) return null;
  // Dos palabras sueltas («Terms and Conditions», «Maria and Jose») no son dos personas con nombre y apellido.
  if (items.length === 2 && items[0].tokens === 1 && items[1].tokens === 1) return null;

  let shared = false;
  if (items.length === 2 && items[0].tokens === 1 && items[1].tokens >= 2) {
    // «Juan y Maria Perez»: el primero comparte el apellido del segundo.
    const tail = items[1].text.split(" ").slice(1).join(" ");
    items[0] = { ...items[0], text: `${items[0].text} ${tail}`, tokens: items[0].tokens + items[1].tokens - 1 };
    shared = true;
  }
  const names = items.map((item) => item.text);
  if (names.length === 2 && fold(names[0]) === fold(names[1])) names.pop();
  const lower = items.every((item) => item.lower);
  const minTokens = Math.min(...items.map((item) => item.tokens));
  let strength = minTokens >= 2 ? (items.some((item) => item.tokens > 5) ? 0.9 : 1) : 0.55;
  if (pieces.length > 2) strength = Math.min(strength, 0.8);
  return { names, shared, strength, lower };
}

/** ¿El texto, tal cual, parece el nombre de una persona (2 a 5 palabras, sin separador de dos personas)? Para bloques sin etiqueta. */
export function looksLikePersonName(text: string): boolean {
  const parsed = parseNames(text, false);
  if (!parsed || parsed.names.length !== 1) return false;
  const words = parsed.names[0].split(" ").length;
  return words >= 2 && words <= 5 && !parsed.lower;
}
