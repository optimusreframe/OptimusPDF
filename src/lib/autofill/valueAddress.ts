/**
 * Direcciones postales de EE. UU. / Puerto Rico y de Latinoamerica (Mexico, Colombia…): linea de calle (numero + calle + sufijo, o
 * «Calle/Av./Urb./Col. …»), linea de ciudad-estado-codigo postal, apartado postal y unidad. Une de 1 a 3 lineas con coma y deja la
 * direccion en mayusculas/minusculas normales. Fuera de estos formatos no propone nada (precision primero).
 */

import { collapseSpaces, fold, isAllLower, isAllUpper, titleWord } from "@/lib/autofill/text";

export const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "VI", "GU", "AS", "MP",
] as const;

const STATE_SET = new Set<string>(US_STATE_CODES);

const STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "puerto rico",
];

const SUFFIX =
  "st|street|ave|avenue|av|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|pl|place|way|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|sq|square|loop|path|pass|cv|cove|row|aly|alley|plz|plaza|expy|expressway|fwy|freeway|bnd|bend|xing|crossing|run|walk|ridge|rdg|park|pt|point|pike|trce|trace|lk|lake|cres|crescent|mews|way";

const DIRECTION = "(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)";
const UNIT = "(?:#|apt|apartment|unit|suite|ste|lot|bldg|building|fl|floor|rm|room|space|trlr|no)";

/** Calle de EE. UU.: «8561 NW South River Drive», «123 Main St Apt 4B». */
const US_STREET = new RegExp(
  `^\\d{1,6}[a-z]?(?:-\\d{1,4})?\\s+(?:${DIRECTION}\\.?\\s+)?[\\p{L}0-9'.\\-]+(?:\\s+[\\p{L}0-9'.\\-]+){0,4}?\\s+(?:${SUFFIX})\\.?(?:\\s+${DIRECTION}\\b\\.?)?(?:\\s*,?\\s*${UNIT}\\.?\\s*[\\w\\-]+)?(?=[\\s,]|$)`,
  "iu",
);

/** Calle numerada sin sufijo («1200 NW 5th»): solo vale con una linea de ciudad/estado/CP al lado. */
const US_STREET_LOOSE = /^\d{1,6}[a-z]?\s+(?:[nsew]{1,2}\.?\s+)?[\p{L}0-9'.\-]+(?:\s+[\p{L}0-9'.\-]+){0,4}$/iu;

/** Direcciones al estilo de Puerto Rico y Latinoamerica. */
const LATAM_STREET =
  /^(?:urb(?:anizacion)?\.?|res(?:idencial)?\.?|calle|cll?\.?|c\/|carr(?:etera)?\.?|camino|avenida|av\.?|ave\.?|blvd\.?|bulevar|boulevard|paseo|pasaje|privada|prol(?:ongacion)?\.?|calzada|cerrada|andador|callejon|colonia|col\.?|barrio|bo\.?|sector|km\.?|edificio|edif\.?|cond(?:ominio)?\.?|cra\.?|carrera|diagonal|transversal|av\.? )\s*[\p{L}0-9 .'#°º\-/,]+$/iu;

const PO_BOX = /^(?:p\.?\s*o\.?\s*box|apartado(?:\s+postal)?|ap\.?\s+postal)\s*#?\s*\d+/i;

const STATE_ALT = `(?:${US_STATE_CODES.join("|")}|${STATE_NAMES.map((name) => name.replace(/ /g, "\\s+")).join("|")})`;

/** «Miami, FL 33166», «Miami FL 33166-1234», «San Juan, PR 00901», «Miami, Florida 33166». */
const US_CSZ = new RegExp(`(?:^|[,\\s])([\\p{L}][\\p{L}.'\\- ]{1,28}?),?\\s+(${STATE_ALT})\\.?,?\\s+(\\d{5})(?:-\\d{4})?(?![\\d])`, "iu");

/** Mexico/LatAm: «06600 Ciudad de Mexico», «CP 06600», «C.P. 06600 CDMX». */
const LATAM_CSZ = /(?:\bc\.?\s?p\.?\s*(\d{5})\b)|(?:(?:^|[,\s])(\d{5})\s+[\p{L}][\p{L}.' \-]{2,30}$)/iu;

export type CszMatch = { index: number; end: number; kind: "us" | "latam" };

export function findCsz(text: string): CszMatch | null {
  const us = US_CSZ.exec(text);
  if (us) {
    const stateText = us[2].replace(/\s+/g, " ");
    // Una sigla debe ir en mayusculas y ser de las validas («in», «or» o «me» sueltas no son estados); un nombre ya paso la lista.
    const ok = stateText.length > 2 || (stateText === stateText.toUpperCase() && STATE_SET.has(stateText));
    if (ok) return { index: us.index + us[0].indexOf(us[1]), end: us.index + us[0].length, kind: "us" };
  }
  const latam = LATAM_CSZ.exec(text);
  if (latam) return { index: latam.index, end: latam.index + latam[0].length, kind: "latam" };
  return null;
}

export function looksLikeStreet(text: string): "us" | "latam" | "po" | null {
  const line = collapseSpaces(text);
  if (line.length < 4 || line.length > 90) return null;
  if (PO_BOX.test(line)) return "po";
  if (US_STREET.test(line)) return "us";
  if (LATAM_STREET.test(line) && /\d/.test(line)) return "latam";
  return null;
}

/** ¿La linea es (solo) ciudad, estado y codigo postal? */
export function looksLikeCszLine(text: string): boolean {
  const line = collapseSpaces(text);
  if (line.length > 60) return false;
  const csz = findCsz(line);
  if (!csz) return false;
  return line.slice(0, csz.index).replace(/[\s,]/g, "") === "" && line.slice(csz.end).replace(/[\s,]/g, "") === "";
}

export function looksLikeUnitLine(text: string): boolean {
  return new RegExp(`^${UNIT}\\.?\\s*[\\w\\-]+$`, "i").test(collapseSpaces(text));
}

export type AddressParse = {
  value: string;
  /** 0..1. */
  strength: number;
  hasStreet: boolean;
  hasCsz: boolean;
  /** La calle no termina en un sufijo conocido (St, Ave, Pl…): solo vale por tener ciudad-estado-CP al lado. Un OCR que lee «PI» por «Pl» entra aqui. */
  looseStreet: boolean;
};

const PROSE_WORDS = /\b(?:shall|will|hereby|agrees?|authorize[sd]?|pursuant|herein|insured|policy|the|and|that|which|este|esta|que|para|por|con)\b/i;

function titleAddress(text: string): string {
  const tokens = text.split(" ");
  return tokens
    .map((token, index) => {
      const bare = token.replace(/[.,]/g, "");
      const trailing = token.slice(token.search(/[.,]*$/));
      const body = token.slice(0, token.length - trailing.length);
      if (/^(?:n|s|e|w|ne|nw|se|sw)$/i.test(bare)) return bare.toUpperCase() + trailing;
      if (/^p\.o\.?,?$/i.test(token)) return token.toUpperCase();
      if (/^po$/i.test(bare)) return `PO${trailing}`;
      if (/^box$/i.test(bare)) return `Box${trailing}`;
      // Sigla de estado justo antes del codigo postal o al final.
      if (STATE_SET.has(bare.toUpperCase()) && bare.length === 2 && (index === tokens.length - 1 || /^\d{5}/.test(tokens[index + 1] ?? ""))) return bare.toUpperCase() + trailing;
      if (/^\d+(?:st|nd|rd|th)$/i.test(bare)) return bare.toLowerCase() + trailing;
      if (/\d/.test(body)) return body.toUpperCase() + trailing;
      if (/^(?:de|del|la|las|los|y|el|of|the)$/i.test(bare) && index > 0) return bare.toLowerCase() + trailing;
      return titleWord(body) + trailing;
    })
    .join(" ");
}

/**
 * Une 1 a 3 lineas y valida que sea una direccion. `loose` admite una linea de calle con numero pero sin sufijo conocido (solo con
 * linea de ciudad al lado o con etiqueta de direccion).
 */
export function parseAddress(lines: readonly string[], loose = false): AddressParse | null {
  const parts = lines.map((line) => collapseSpaces(line).replace(/^[\s,;:]+|[\s,;]+$/g, "")).filter((line) => line !== "");
  if (parts.length === 0 || parts.length > 3) return null;
  let joined = parts.join(", ").replace(/\s+,/g, ",").replace(/,{2,}/g, ",");
  if (joined.length < 5 || joined.length > 160 || /[@]|https?:|www\./i.test(joined)) return null;
  if (!/\d/.test(joined)) return null;
  const words = joined.split(/\s+/).length;
  if (words > 18 || (words > 8 && PROSE_WORDS.test(fold(joined)))) return null;

  const first = parts[0];
  let street = looksLikeStreet(first);
  const csz = findCsz(joined);
  let looseStreet = false;
  if (!street && loose && csz && (US_STREET_LOOSE.test(first) || LATAM_STREET.test(first))) {
    street = "us";
    looseStreet = true;
  }
  // Sin calle (solo ciudad y codigo postal) es demasiado poco para un campo de direccion.
  if (!street) return null;
  const hasCsz = csz !== null;
  let strength = hasCsz ? 1 : street === "po" ? 0.8 : 0.82;
  if (!hasCsz && parts.length === 1 && street === "latam") strength = 0.78;

  if (isAllUpper(joined) || isAllLower(joined)) joined = titleAddress(joined);
  return { value: joined, strength, hasStreet: true, hasCsz, looseStreet };
}
