/**
 * Valores restantes: numeros de poliza y de reclamo, aseguradora y tipo de reclamo.
 */

import { cleanValue, collapseSpaces, fold, isAllLower, isAllUpper, isJunkValue, isSmallWord, titleWord } from "@/lib/autofill/text";
import { findCsz, looksLikeStreet } from "@/lib/autofill/valueAddress";

/* ------------------------------------------------------------------ *
 * Numeros de poliza / reclamo
 * ------------------------------------------------------------------ */

export type IdParse = { value: string; strength: number };

/** El primer token de un numero de poliza o reclamo: con cifras suficientes y sin parecer fecha ni palabra con una cifra. */
function validId(raw: string): boolean {
  const token = raw.replace(/[.,;:\-_/]+$/, "");
  const digits = token.replace(/\D/g, "").length;
  if (token.length < 4 || token.length > 30 || digits < 2) return false;
  return !(digits < 3 && token.length < 6);
}

/**
 * Lee un numero de poliza o de reclamo: el primer «token» alfanumerico con cifras (guiones, barras y puntos permitidos).
 * No es una fecha, un telefono con parentesis, un correo ni un ano suelto. Precision primero: «Policy No. ______» no da nada.
 */
export function parseIdValue(raw: string): IdParse | null {
  const text = cleanValue(raw).replace(/^(?:no\.?|n[º°o]\.?|num\.?|number|numero|#)\s*[:.\-]?\s*/i, "").replace(/^[#\s:]+/, "");
  if (text === "" || isJunkValue(text)) return null;
  // Un telefono (1-800-555-0142, (305) 555-0142) escrito junto a «Claim:» o «Claims:» no es un numero de reclamo ni de poliza.
  if (/^(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?:\b|$)/.test(text) && (/\(/.test(text.slice(0, 5)) || /^(?:\+?1[\s.-]?)?8(?:00|33|44|55|66|77|88)\b/.test(text))) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9\-/._]{2,29})(?=$|[\s,;)])/.exec(text);
  if (!match || !validId(match[1])) {
    // Polizas escritas en grupos separados por un espacio («HOP 6032289 04», «HO 7001 8000»): letras o cifras + grupos con cifras.
    const grouped = /^([A-Z]{2,6}|\d{3,6})((?: [A-Z]*\d[A-Z0-9]*){1,3})(?=$|[\s,;)])/.exec(text);
    if (grouped) {
      const value = `${grouped[1]}${grouped[2]}`;
      const digits = value.replace(/\D/g, "").length;
      if (value.length <= 30 && digits >= 4 && !/^\d{1,2} \d{1,2} \d{2,4}$/.test(value)) return { value, strength: 0.97 };
    }
    return null;
  }
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

export function titleCompany(text: string): string {
  return text
    .split(" ")
    .map((word, index) => {
      if (/^&$/.test(word)) return word;
      if (/^(?:llc|inc\.?|co\.?|corp\.?|ltd\.?|usaa|geico|aig|hci|csaa|mcs|axa|qbe|ace|fsb|fcu|n\.?a\.?|isaoa|atima)$/i.test(word)) return /^(?:inc|co|corp|ltd)/i.test(word) ? titleWord(word) : word.toUpperCase();
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

/* ------------------------------------------------------------------ *
 * Acreedor hipotecario
 * ------------------------------------------------------------------ */

export type MortgageeParse = { value: string; strength: number };

/** Palabras de una entidad financiera: el nombre se reconoce con mas seguridad. */
const LENDER_WORDS = /\b(?:bank|banco|savings|credit\s+union|mortgage|hipotec\w*|loans?|lending|financial|servicing|servicer|federal|capital|funding|trust|home\s+loans|bancorp|n\.?a\.?|fsb|fcu|cooperativa|financiera)\b/i;

/** «Sin hipoteca»: el campo dice que no hay. */
const NO_MORTGAGE = /^(?:none|n\/?a|not\s+applicable|no\s+mortgagee|no\s+mortgage|nil|paid\s+in\s+full|free\s+and\s+clear|owner\s+financed|ninguno|ninguna|no\s+aplica|sin\s+hipoteca|sin\s+acreedor)$/i;

/** Cola legal de los hipotecarios («… ISAOA ATIMA», «its successors and/or assigns»): no es parte del nombre. */
const LENDER_TAIL = /[\s,;]*\b(?:isaoa|atima|i\.s\.a\.o\.a\.?|its\s+successors?|successors?\s+and\/or\s+assigns?|as\s+their\s+interests?\s+may\s+appear)\b.*$/i;

/** Distancia de edicion entre dos palabras cortas (para reconocer «ISAOA» y «ATIMA» mal leidas por el OCR). */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length];
}

/** Quita del final hasta dos palabras que son «ISAOA»/«ATIMA» con una o dos letras mal leidas («ISACA», «[SAOA», «ATIM»). */
function stripFuzzyLegalTail(text: string): string {
  const words = text.split(" ");
  for (let k = 0; k < 2 && words.length > 1; k += 1) {
    const letters = fold(words[words.length - 1]).replace(/[^a-z]/g, "");
    const tail = letters.length >= 4 && letters.length <= 6 && (editDistance(letters, "isaoa") <= 2 || editDistance(letters, "atima") <= 2);
    if (!tail) break;
    words.pop();
  }
  return words.join(" ");
}

export function parseMortgagee(raw: string): MortgageeParse | null {
  let text = collapseSpaces(cleanValue(raw)).replace(LENDER_TAIL, "").replace(/\([^)]*\)/g, " ");
  text = stripFuzzyLegalTail(collapseSpaces(text)).replace(/[,;:\s]+$/g, "");
  if (text.length < 3 || text.length > 70 || isJunkValue(text) || NO_MORTGAGE.test(text) || /@|https?:|www\./i.test(text)) return null;
  if (/\d{5,}/.test(text) || looksLikeStreet(text) || findCsz(text)) return null;
  // Un banco no lleva dos puntos ni mas de tres cifras: «Policy Period: 11/14/2026 …» (otra celda leida por error) no es un hipotecario.
  if (/[:;]/.test(text) || (text.match(/\d/g) ?? []).length > 3) return null;
  const words = text.split(/\s+/);
  if (words.length > 9 || (text.match(/\p{L}/gu) ?? []).length < 3) return null;
  // Frases (prosa de un clausulado) no son un nombre.
  if (/\b(?:shall|will|hereby|agrees?|pursuant|herein|if\s+a|name[sd]?\s+in|is\s+named|are\s+named)\b/i.test(text)) return null;
  const lender = LENDER_WORDS.test(text);
  const value = isAllUpper(text) || isAllLower(text) ? titleCompany(text) : text;
  return { value, strength: lender ? 1 : words.length >= 2 ? 0.8 : 0.6 };
}

/* ------------------------------------------------------------------ *
 * Deducibles
 * ------------------------------------------------------------------ */

export type DeductibleParse = { value: string; strength: number };

const AMOUNT = /\$\s?(\d{1,3}(?:,\s?\d{3})+|\d{1,7})(?:\.(\d{2}))?(?![\d,])/;
const PERCENT = /(?<![\d.])(\d{1,2}(?:\.\d{1,2})?)\s?%/;

const WIND_WORDS = /\b(?:wind|windstorm|hurricane|named\s+storm|hail|viento|huracan|granizo|vendaval|tormenta)\b/i;

/**
 * Importe de un deducible tal como se imprime: «$2,500», «2%» o «2% ($7,000)». Un deducible de monto no baja de $100 ni pasa de
 * $250,000 y uno en porcentaje va de 0,5 % a 15 %: lo demas es un limite de cobertura o una cifra suelta. `wind` = la etiqueta es
 * de viento/huracan; una etiqueta general no acepta un valor que diga viento (es del otro deducible).
 */
export function parseDeductible(raw: string, wind: boolean): DeductibleParse | null {
  const text = collapseSpaces(cleanValue(raw));
  if (text === "" || text.length > 70 || isJunkValue(text) || text.split(/\s+/).length > 10) return null;
  if (!wind && WIND_WORDS.test(fold(text))) return null;
  const amount = AMOUNT.exec(text);
  const percent = PERCENT.exec(text);
  let amt: string | null = null;
  if (amount) {
    const number = Number(amount[1].replace(/[,\s]/g, ""));
    if (number >= 100 && number <= 250_000) amt = `$${number.toLocaleString("en-US")}${amount[2] && amount[2] !== "00" ? `.${amount[2]}` : ""}`;
  }
  let pct: string | null = null;
  if (percent) {
    const number = Number(percent[1]);
    if (number >= 0.5 && number <= 15) pct = `${percent[1]}%`;
  }
  if (!amt && !pct) return null;
  // Importe y porcentaje distintos juntos en una etiqueta general («$1,000 / 2%»): no se sabe a que riesgo corresponde cada uno.
  const mixed = amt !== null && pct !== null && !wind && !/\bof\b|\bde\b|\(/i.test(text);
  if (pct && amt) return { value: `${pct} (${amt})`, strength: mixed ? 0.7 : 1 };
  return { value: pct ?? (amt as string), strength: 1 };
}
