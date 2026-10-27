import type { OcrLine, OcrResult } from "@/lib/scan/ocr";
import type { ScanMode, ScanSession } from "@/lib/scan/types";

/**
 * Nombre inteligente del escaneo: titulo del primer texto reconocible (la linea mas grande del encabezado de la primera
 * pagina) + fecha del escaneo (o la del documento si es creible). Puro y sin red; el OCR lo pone `ocr.ts`.
 */

export type NameSuggestion = NonNullable<ScanSession["nameSuggested"]> & { name: string };

const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre", "octubre", "noviembre", "diciembre"];
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_NAME = 80;

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0");
}

export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const KIND_LABELS: Record<ScanMode, { es: string; en: string }> = {
  document: { es: "Escaneo", en: "Scan" },
  "id-card": { es: "Identificación", en: "ID" },
  receipt: { es: "Recibo", en: "Receipt" },
  book: { es: "Libro", en: "Book" },
  whiteboard: { es: "Pizarra", en: "Whiteboard" },
  photo: { es: "Fotos", en: "Photos" },
};

/** Modo que mas se repite entre las paginas (empata: el primero); `document` sin paginas. */
export function dominantMode(modes: readonly (ScanMode | undefined)[]): ScanMode {
  const counts = new Map<ScanMode, number>();
  for (const mode of modes) counts.set(mode ?? "document", (counts.get(mode ?? "document") ?? 0) + 1);
  let best: ScanMode = "document";
  let bestCount = 0;
  for (const [mode, count] of counts) {
    if (count > bestCount) {
      best = mode;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Nombre SIN red ni OCR: «<tipo> AAAA-MM-DD HH.mm» (sin dos puntos: no valen en nombres de archivo). El tipo sale del modo
 * («Escaneo», «Identificación», «Recibo», «Libro», «Pizarra», «Fotos»).
 */
export function fallbackName(date: Date, locale: "es" | "en", mode: ScanMode = "document"): string {
  return `${KIND_LABELS[mode][locale]} ${isoDate(date)} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/** Quita lo que no vale en un nombre de archivo y lo acota. */
export function sanitizeFileName(raw: string): string {
  let name = raw.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/^[.\s-]+/, "").replace(/[.\s]+$/, "");
  if (name.length > MAX_NAME) {
    const cut = name.slice(0, MAX_NAME);
    const space = cut.lastIndexOf(" ");
    name = (space > MAX_NAME * 0.5 ? cut.slice(0, space) : cut).trim();
  }
  if (RESERVED.test(name)) name = `${name}_`;
  return name;
}

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

function lineHeight(line: OcrLine): number {
  const heights = line.words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  if (heights.length === 0) return line.bbox.y1 - line.bbox.y0;
  return heights[Math.floor(heights.length / 2)];
}

/** Si casi todo esta en mayusculas se pasa a «Frase» (las siglas cortas se respetan). */
export function tidyTitle(text: string): string {
  let title = text.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.)]+$/gu, "").trim();
  const letters = title.match(/\p{L}/gu) ?? [];
  const upper = letters.filter((l) => l === l.toUpperCase() && l !== l.toLowerCase()).length;
  if (letters.length >= 4 && upper / letters.length > 0.8) {
    title = title.toLowerCase().replace(/^\p{L}/u, (c) => c.toUpperCase());
  }
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const space = cut.lastIndexOf(" ");
    title = (space > 30 ? cut.slice(0, space) : cut).trim();
  }
  return title;
}

/** Linea que puede ser un titulo: texto de verdad (letras), ni solo fecha ni solo numeros, y con lectura fiable. */
function isTitleCandidate(line: OcrLine): boolean {
  const text = line.text.trim();
  if (text.length < 3 || text.length > 90) return false;
  const letters = letterCount(text);
  if (letters < 3 || letters / text.replace(/\s/g, "").length < 0.55) return false;
  if (line.confidence < 55) return false;
  if (/^(fecha|date)\b[: ]/i.test(text)) return false;
  return true;
}

/**
 * Titulo de la primera pagina: la linea candidata mas alta (mayor cuerpo de letra) del 45 % superior; a igual cuerpo (±12 %),
 * la mas alta de la pagina.
 */
export function pickTitle(ocr: OcrResult): string | null {
  const limit = ocr.height * 0.45;
  const candidates = ocr.lines.filter((line) => line.bbox.y0 < limit && isTitleCandidate(line));
  if (candidates.length === 0) return null;
  const tallest = Math.max(...candidates.map(lineHeight));
  const winners = candidates.filter((line) => lineHeight(line) >= tallest * 0.88);
  winners.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const title = tidyTitle(winners[0].text);
  return letterCount(title) >= 3 ? title : null;
}

/** Numero de mes (1-12) de un nombre en espanol o ingles; 0 si no lo es. */
function monthNumber(name: string): number {
  const lower = name.toLowerCase();
  const en = MONTHS_EN.indexOf(lower);
  if (en >= 0) return en + 1;
  const es = MONTHS_ES.indexOf(lower);
  if (es < 0) return 0;
  return es <= 8 ? es + 1 : es === 9 ? 9 : es;
}

type FoundDate = { date: Date; index: number };

function validDate(year: number, month: number, day: number): Date | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** Fechas legibles en el texto: AAAA-MM-DD, DD/MM/AAAA, «12 de marzo de 2026», «March 12, 2026». */
export function findDates(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  const push = (date: Date | null, index: number) => {
    if (date) found.push({ date, index });
  };
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(validDate(+m[1], +m[2], +m[3]), m.index ?? 0);
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) push(validDate(+m[3], +m[2], +m[1]), m.index ?? 0);
  const monthAlt = [...MONTHS_ES, ...MONTHS_EN].join("|");
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?(${monthAlt})\\s+(?:del?\\s+)?(\\d{4})\\b`, "gi"))) {
    push(validDate(+m[3], monthNumber(m[2]), +m[1]), m.index ?? 0);
  }
  for (const m of text.matchAll(new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi"))) {
    push(validDate(+m[3], monthNumber(m[1]), +m[2]), m.index ?? 0);
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Fecha del documento SOLO si es creible: valida, no futura y de los ultimos 2 anos. */
export function credibleDocumentDate(text: string, now: Date): Date | null {
  const earliest = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  const latest = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const candidates = findDates(text).filter(({ date }) => date >= earliest && date <= latest);
  if (candidates.length === 0) return null;
  // La que sigue a la palabra «fecha»/«date» manda; si no, la primera.
  const keyed = candidates.find(({ index }) => /(fecha|date)\W{0,3}$/i.test(text.slice(Math.max(0, index - 14), index)));
  return (keyed ?? candidates[0]).date;
}

/**
 * Propone el nombre. `ocr` es la lectura de la primera pagina (o `null` si no hay OCR / no se leyo nada): sin titulo se usa el
 * nombre de respaldo con la hora del escaneo.
 */
export function buildNameSuggestion(ocr: OcrResult | null, locale: "es" | "en", now: Date, mode: ScanMode = "document"): NameSuggestion {
  const title = ocr ? pickTitle(ocr) : null;
  const documentDate = ocr ? credibleDocumentDate(ocr.text, now) : null;
  const date = isoDate(documentDate ?? now);
  if (title) {
    const name = sanitizeFileName(`${title} · ${date}`) || fallbackName(now, locale, mode);
    return { title, date, source: "ocr", name };
  }
  const name = sanitizeFileName(fallbackName(now, locale, mode));
  return { title: null, date, source: "date", name };
}
