/**
 * Valores restantes: numeros de poliza y de reclamo, aseguradora y tipo de reclamo.
 */

import { cleanValue, collapseSpaces, fold, isAllLower, isAllUpper, isJunkValue, isSmallWord, titleWord } from "@/lib/autofill/text";

/* ------------------------------------------------------------------ *
 * Numeros de poliza / reclamo
 * ------------------------------------------------------------------ */

export type IdParse = { value: string; strength: number };

/**
 * Lee un numero de poliza o de reclamo: el primer «token» alfanumerico con cifras (guiones, barras y puntos permitidos).
 * No es una fecha, un telefono con parentesis, un correo ni un ano suelto. Precision primero: «Policy No. ______» no da nada.
 */
export function parseIdValue(raw: string): IdParse | null {
  const text = cleanValue(raw).replace(/^(?:no\.?|n[º°o]\.?|num\.?|number|numero|#)\s*[:.\-]?\s*/i, "").replace(/^[#\s:]+/, "");
  if (text === "" || isJunkValue(text)) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9\-/._]{2,29})(?=$|[\s,;)])/.exec(text);
  if (!match) return null;
  const token = match[1].replace(/[.,;:\-_/]+$/, "");
  const digits = token.replace(/\D/g, "").length;
  if (token.length < 4 || token.length > 30 || digits < 2) return null;
  if (digits < 3 && token.length < 6) return null;
  if (token.includes("@")) return null;
  // Fechas («03/04/2026», «2026-03-04») y anos sueltos.
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(token) || /^(?:19|20)\d{2}$/.test(token)) return null;
  // Palabras con una cifra suelta («Page2», «E1»).
  const letters = token.replace(/[^A-Za-z]/g, "").length;
  if (letters > 0 && digits <= 2 && token.length <= 6) return null;
  // Tras el token no puede seguir mas del mismo bloque: «12345 was issued on…» es una frase, no un campo.
  const rest = text.slice(match[0].length).trim();
  if (rest !== "" && rest.split(/\s+/).length > 3 && /[a-z]{3,}/.test(rest)) return null;
  const strength = letters > 0 && digits > 0 ? 1 : digits >= 6 ? 0.97 : digits >= 4 ? 0.9 : 0.75;
  return { value: token.toUpperCase() === token || /\d/.test(token) ? token.toUpperCase() : token, strength };
}

/* ------------------------------------------------------------------ *
 * Aseguradora
 * ------------------------------------------------------------------ */

/** Nombres frecuentes de aseguradoras (EE. UU., Puerto Rico, Mexico, Latinoamerica). Coincidencia por palabras completas. */
export const KNOWN_INSURERS: readonly string[] = [
  "State Farm", "Allstate", "Progressive", "GEICO", "Liberty Mutual", "Farmers", "USAA", "Nationwide", "Travelers", "American Family", "Citizens Property Insurance",
  "Universal Property", "Heritage Property", "People's Trust", "United Property & Casualty", "Security First", "American Integrity", "Tower Hill", "Federated National",
  "Slide Insurance", "Southern Oak", "Florida Peninsula", "Cypress Property", "Homeowners Choice", "HCI", "Kin Insurance", "Lemonade", "Chubb", "AIG", "The Hartford", "Erie Insurance",
  "State Auto", "Mapfre", "Assurant", "Hanover", "Auto-Owners", "Amica", "Safeco", "Zurich", "Allied Trust", "Foremost", "Universal North America", "Centauri", "American Security Insurance",
  "Olympus Insurance", "Florida Farm Bureau", "Monarch National", "Mercury Insurance", "MetLife", "Penn National", "CSAA", "Sentry", "Seguros Monterrey", "Seguros Sura", "Sura", "AXA",
  "Qualitas", "GNP Seguros", "Triple-S", "Universal Insurance", "MCS", "Integon", "Bankers Insurance", "Wilshire", "Edison Insurance", "American Coastal", "Ace American", "Berkshire Hathaway",
  "Prepared Insurance", "Velocity Risk", "Openly", "Branch Insurance", "Clearcover", "Root Insurance", "Hippo", "Everest", "Sompo", "QBE", "Great American", "Philadelphia Insurance", "Cincinnati Insurance",
];

const KNOWN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${KNOWN_INSURERS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

const INSURER_SUFFIX =
  /\b(?:insurance|assurance|casualty|mutual|indemnity|insurers?|underwriters?|seguros|aseguradora|assurant|fire\s+and\s+casualty|property\s+(?:and|&)\s+casualty|p&c|surety|reinsurance)\b/i;
const COMPANY_FORM = /\b(?:company|co\.?|corp(?:oration)?\.?|inc\.?|llc|ltd\.?|group|s\.?a\.?(?:\s+de\s+c\.?v\.?)?)\b/i;

const GENERIC_COMPANY_WORD = /^(?:insurance|assurance|casualty|mutual|indemnity|insurers?|underwriters?|seguros?|aseguradora|company|co|corp|corporation|inc|llc|ltd|group|the|of|and|de|del|la|y|&|property|fire|name|nombre)$/i;

export type InsurerParse = { value: string; strength: number; known: boolean };

function titleCompany(text: string): string {
  return text
    .split(" ")
    .map((word, index) => {
      if (/^&$/.test(word)) return word;
      if (/^(?:llc|inc\.?|co\.?|corp\.?|ltd\.?|usaa|geico|aig|hci|csaa|mcs|axa|qbe|ace)$/i.test(word)) return /^(?:inc|co|corp|ltd)/i.test(word) ? titleWord(word) : word.toUpperCase();
      if (index > 0 && isSmallWord(word)) return word.toLowerCase();
      return titleWord(word);
    })
    .join(" ");
}

/**
 * Lee el nombre de una aseguradora. `labeled` = viene tras una etiqueta de aseguradora (acepta nombres cortos desconocidos como
 * «revisar»); sin etiqueta solo se acepta un nombre conocido o con sufijo de aseguradora.
 */
export function parseInsurer(raw: string, labeled: boolean): InsurerParse | null {
  let text = cleanValue(raw).replace(/\([^)]*\)/g, " ");
  text = collapseSpaces(text).replace(/[,;:\s]+$/g, "");
  if (/\.$/.test(text) && !/\b(?:inc|co|corp|ltd|n\.a|s\.a)\.$/i.test(text)) text = text.replace(/\.+$/, "");
  if (text === "" || text.length > 70 || isJunkValue(text) || /@|https?:|www\./i.test(text)) return null;
  const words = text.split(/\s+/);
  if (words.length > 9) return null;
  // «21st Century» lleva cifras; cualquier otro nombre con muchas cifras no es una aseguradora.
  if (/\d/.test(text) && !/^21st\b/i.test(text)) return null;
  const known = KNOWN_RE.test(text);
  const suffix = INSURER_SUFFIX.test(text);
  const form = COMPANY_FORM.test(text);
  if (!known && !suffix && !(labeled && form) && !(labeled && words.length >= 1 && words.length <= 5)) return null;
  // Un nombre propio de persona no es una aseguradora conocida; sin pistas y con una sola palabra en minusculas, tampoco.
  if (!known && !suffix && !form && labeled && isAllLower(text) && words.length === 1) return null;
  // Frases de contrato («as set forth below», «the insurer») no son un nombre.
  if (/^(?:the|a|an|as|to|for|of|in|on|el|la|los|las|un|una|de|del|para|por)\s/i.test(text) && !known) return null;
  if (/\b(?:shall|will|hereby|agrees?|pursuant|herein|below|above)\b/i.test(text)) return null;
  const value = isAllUpper(text) || isAllLower(text) ? titleCompany(text) : text;
  return { value, strength: known || suffix ? 1 : form ? 0.85 : 0.65, known };
}

/** Nombre de aseguradora conocido o con sufijo dentro de un texto corto (para el membrete de una carta). */
export function findInsurerName(line: string): InsurerParse | null {
  const text = collapseSpaces(line);
  if (text.length > 70 || text.split(" ").length > 8 || /[:：]\s*$/.test(text)) return null;
  // «Insurance Company» a secas es una etiqueta, no un nombre: tiene que quedar al menos una palabra propia.
  const own = text.split(/\s+/).filter((word) => !GENERIC_COMPANY_WORD.test(word.replace(/[.,]/g, "")) && /\p{L}{2,}/u.test(word));
  if (own.length === 0) return null;
  const parsed = parseInsurer(text, false);
  return parsed && (parsed.known || INSURER_SUFFIX.test(text)) ? parsed : null;
}

/* ------------------------------------------------------------------ *
 * Tipo de reclamo
 * ------------------------------------------------------------------ */

/** Causas de perdida habituales (EN/ES), plegadas (sin tildes). */
const PERILS =
  /\b(?:wind|hail|water|fire|mold|mould|hurricane|tornado|storm|flood|flooding|lightning|theft|burglary|vandalism|smoke|sewage|sewer|plumbing|pipe|leak|roof|collapse|freeze|freezing|explosion|impact|collision|rain|tree|fallen\s+tree|windstorm|wind\/hail|roof\s+leak|water\s+damage|fire\s+damage|mold\s+damage|viento|granizo|agua|incendio|fuego|moho|huracan|tornado|tormenta|inundacion|rayo|robo|vandalismo|humo|alcantarillado|tuberia|fuga|goteras?|techo|colapso|congelamiento|explosion|impacto|choque|lluvia|arbol)\b/;

export type ClaimTypeParse = { value: string; strength: number; perilFound: boolean };

export function parseClaimType(raw: string): ClaimTypeParse | null {
  const text = collapseSpaces(cleanValue(raw)).replace(/[.,;:\s]+$/g, "");
  if (text === "" || text.length > 60 || isJunkValue(text) || /@|https?:/i.test(text)) return null;
  if (text.split(/\s+/).length > 8) return null;
  const perilFound = PERILS.test(fold(text));
  // Una descripcion sin ninguna causa conocida (p. ej. «Kitchen») solo vale como pista para revisar.
  if (!perilFound && (text.split(/\s+/).length > 5 || /\d{3,}/.test(text))) return null;
  const value = isAllUpper(text) || isAllLower(text) ? titleSlash(text) : text;
  return { value, strength: perilFound ? 1 : 0.55, perilFound };
}

function titleSlash(text: string): string {
  return text
    .split(/(\s+|\/)/)
    .map((piece, index) => (/^(\s+|\/)$/.test(piece) ? piece : index > 0 && isSmallWord(piece) ? piece.toLowerCase() : titleWord(piece)))
    .join("");
}
