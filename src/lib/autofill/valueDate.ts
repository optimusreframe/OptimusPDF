/**
 * Fechas en varios formatos (numericas, ISO, con el mes en letras en espanol o ingles) y su salida en el formato del idioma de
 * la interfaz: «dd/mm/aaaa» en espanol, «mm/dd/aaaa» en ingles. Una fecha numerica ambigua («03/04/2026», que puede ser 3 de abril
 * o 4 de marzo) NO se reinterpreta: se conserva el texto original y la marca como ambigua (el motor la baja a revision).
 */

import { fold } from "@/lib/autofill/text";

export type DateMatch = {
  year: number;
  month: number;
  day: number;
  /** Texto original tal cual aparecia. */
  source: string;
  index: number;
  end: number;
  /** Los dos primeros numeros caben como dia y como mes: no se sabe cual es cual. */
  ambiguous: boolean;
};

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1, january: 1, jan: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, abr: 4, april: 4, apr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, ago: 8, august: 8, aug: 8,
  septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dic: 12, december: 12, dec: 12,
};

const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** Anos que se aceptan (el reloj no interviene: el motor es determinista). */
const MIN_YEAR = 1980;
const MAX_YEAR = 2100;

function daysIn(month: number, year: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function fullYear(text: string): number {
  const value = Number(text);
  if (text.length === 4) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

function valid(year: number, month: number, day: number): boolean {
  return year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(month, year);
}

type Draft = { year: number; month: number; day: number; index: number; end: number; ambiguous: boolean };

/**
 * Todas las fechas validas de un texto, en orden de aparicion. El texto se pliega internamente (sin tildes ni mayusculas) pero
 * `source` conserva el original.
 */
export function findDates(text: string): DateMatch[] {
  const lower = fold(text);
  const drafts: Draft[] = [];
  const taken = (index: number, end: number): boolean => drafts.some((draft) => index < draft.end && end > draft.index);
  const add = (draft: Draft): void => {
    if (!taken(draft.index, draft.end) && valid(draft.year, draft.month, draft.day)) drafts.push(draft);
  };

  // 1) Mes en letras: «20 de febrero de 2026», «Feb 20, 2026», «20-feb-26», «20th of February 2026».
  const dayMonthYear = new RegExp(`(?<![\\w])(\\d{1,2})(?:st|nd|rd|th|o|ro|do)?\\.?(?:\\s+(?:de|of)\\s+|[\\s\\-/.]+)(${MONTH_ALT})\\b\\.?(?:(?:\\s+(?:de|del|of))?[\\s,\\-/.]*(\\d{4})|[\\-/.](\\d{2}))(?![\\d])`, "g");
  for (let m = dayMonthYear.exec(lower); m !== null; m = dayMonthYear.exec(lower)) {
    add({ year: fullYear(m[3] ?? m[4]), month: MONTHS[m[2]], day: Number(m[1]), index: m.index, end: m.index + m[0].length, ambiguous: false });
  }
  const monthDayYear = new RegExp(`(?<![\\p{L}])(${MONTH_ALT})\\b\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:de\\s+|del\\s+|of\\s+)?(\\d{4})(?![\\d])`, "gu");
  for (let m = monthDayYear.exec(lower); m !== null; m = monthDayYear.exec(lower)) {
    add({ year: Number(m[3]), month: MONTHS[m[1]], day: Number(m[2]), index: m.index, end: m.index + m[0].length, ambiguous: false });
  }

  // 2) ISO: 2026-03-04 (el ano va primero: sin ambiguedad).
  const iso = /(?<![\d/.\-])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/g;
  for (let m = iso.exec(lower); m !== null; m = iso.exec(lower)) {
    add({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), index: m.index, end: m.index + m[0].length, ambiguous: false });
  }

  // 3) Numerica: 03/04/2026, 3-4-26, 25.02.2026.
  const numeric = /(?<![\d/.\-])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?![\d])/g;
  for (let m = numeric.exec(lower); m !== null; m = numeric.exec(lower)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = fullYear(m[3]);
    let month: number;
    let day: number;
    let ambiguous = false;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else {
      // Ambos caben como mes: sin saber el orden del documento. Si son iguales no importa.
      month = a;
      day = b;
      ambiguous = a !== b;
    }
    add({ year, month, day, index: m.index, end: m.index + m[0].length, ambiguous });
  }

  return drafts
    .sort((x, y) => x.index - y.index)
    .map((draft) => ({ ...draft, source: text.slice(draft.index, draft.end) }));
}

/** Primera fecha de un texto que EMPIEZA el valor (tras la etiqueta), o `null`. */
export function parseLeadingDate(text: string): DateMatch | null {
  const found = findDates(text);
  if (found.length === 0) return null;
  const first = found[0];
  // La fecha debe abrir el valor (se admite algo de puntuacion o «el»/«on» antes); no una fecha perdida al fondo de una frase.
  const before = text.slice(0, first.index).replace(/[\s:;,.\-–—()[\]]/g, "").toLowerCase();
  if (before !== "" && !/^(?:el|on|the|en|dia|day|date|fecha)$/.test(before)) return null;
  return first;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** «20/02/2026» (es) o «02/20/2026» (en). */
export function formatDateForLocale(match: Pick<DateMatch, "year" | "month" | "day">, locale: "es" | "en"): string {
  return locale === "es" ? `${pad2(match.day)}/${pad2(match.month)}/${match.year}` : `${pad2(match.month)}/${pad2(match.day)}/${match.year}`;
}
