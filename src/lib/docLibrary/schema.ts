import { MINHASH_SIZE } from "./fingerprintCore";
import {
  FINGERPRINT_VERSION,
  LIBRARY_LIMITS,
  type DocumentEntry,
  type Fingerprint,
  type MatchLevel,
  type PageFingerprint,
  type PageSize,
  type TemplateStale,
} from "./types";

/**
 * Validación ESTRICTA de lo que sale de IndexedDB o de un archivo importado. Todo lo que no cumple se descarta
 * (devuelve `null`); lo que cumple se COPIA campo a campo (los campos desconocidos no pasan).
 */

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
/** Marcas bidireccionales y controles: no entran en nombres (se verían al revés o romperían la lista). */
const BAD_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const MAX_PAGES_STORED = 100_000;
const MAX_PAGE_POINTS = 20_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Texto sin controles ni marcas bidi, de 0 a `max` caracteres. */
export function cleanText(value: unknown, max: number = LIBRARY_LIMITS.maxNameLength): string | null {
  if (typeof value !== "string" || value.length > max || BAD_TEXT.test(value)) return null;
  return value;
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function parsePageSize(raw: unknown): PageSize | null {
  if (!isRecord(raw)) return null;
  const { width, height } = raw;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 0 || height < 0 || width > MAX_PAGE_POINTS || height > MAX_PAGE_POINTS) return null;
  return { width, height };
}

function parsePage(raw: unknown): PageFingerprint | null {
  if (!isRecord(raw)) return null;
  const { textHash, minhash, dhash } = raw;
  if (typeof textHash !== "string" || !(textHash === "" || HEX64.test(textHash))) return null;
  if (!Array.isArray(minhash)) return null;
  if (textHash === "" ? minhash.length !== 0 : minhash.length !== MINHASH_SIZE) return null;
  const values: number[] = [];
  for (const value of minhash) {
    if (!isInt(value, 0, 0xffffffff)) return null;
    values.push(value);
  }
  if (dhash !== undefined && !(typeof dhash === "string" && HEX16.test(dhash))) return null;
  return dhash === undefined ? { textHash, minhash: values } : { textHash, minhash: values, dhash };
}

export function parseFingerprint(raw: unknown): Fingerprint | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== FINGERPRINT_VERSION) return null;
  if (typeof raw.exact !== "string" || !HEX64.test(raw.exact)) return null;
  if (!isInt(raw.pageCount, 0, MAX_PAGES_STORED)) return null;
  if (!Array.isArray(raw.pageSizes) || !Array.isArray(raw.pages)) return null;
  const partial = raw.partial;
  if (partial !== undefined && partial !== "tooManyPages") return null;
  if (partial) {
    if (raw.pageSizes.length !== 0 || raw.pages.length !== 0) return null;
    return { version: FINGERPRINT_VERSION, exact: raw.exact, pageCount: raw.pageCount, pageSizes: [], pages: [], partial };
  }
  if (raw.pageCount > LIBRARY_LIMITS.maxFingerprintPages) return null;
  if (raw.pageSizes.length !== raw.pageCount || raw.pages.length !== raw.pageCount) return null;
  const pageSizes: PageSize[] = [];
  for (const item of raw.pageSizes) {
    const size = parsePageSize(item);
    if (!size) return null;
    pageSizes.push(size);
  }
  const pages: PageFingerprint[] = [];
  for (const item of raw.pages) {
    const page = parsePage(item);
    if (!page) return null;
    pages.push(page);
  }
  return { version: FINGERPRINT_VERSION, exact: raw.exact, pageCount: raw.pageCount, pageSizes, pages };
}

const MATCH_LEVELS: readonly MatchLevel[] = ["exact", "match", "similar", "none"];

/** `templateStale` es ADITIVO: ausente o mal formado = al día (nunca invalida el documento). */
export function parseTemplateStale(raw: unknown): TemplateStale | null {
  if (!isRecord(raw)) return null;
  if (!isIsoDate(raw.since)) return null;
  if (typeof raw.level !== "string" || !MATCH_LEVELS.includes(raw.level as MatchLevel)) return null;
  if (!isInt(raw.percent, 0, 100)) return null;
  const base = parseFingerprint(raw.base);
  if (!base) return null;
  return { since: raw.since, level: raw.level as MatchLevel, percent: raw.percent, base };
}

export function parseDocumentEntry(raw: unknown): DocumentEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) return null;
  const name = cleanText(raw.name);
  const docType = cleanText(raw.docType);
  const fileName = cleanText(raw.fileName);
  if (name === null || name.trim() === "" || docType === null || fileName === null) return null;
  const fingerprint = parseFingerprint(raw.fingerprint);
  if (!fingerprint) return null;
  if (!isInt(raw.pageCount, 0, MAX_PAGES_STORED) || raw.pageCount !== fingerprint.pageCount) return null;
  if (!Array.isArray(raw.pageSizes) || raw.pageSizes.length !== fingerprint.pageSizes.length) return null;
  const pageSizes: PageSize[] = [];
  for (const item of raw.pageSizes) {
    const size = parsePageSize(item);
    if (!size) return null;
    pageSizes.push(size);
  }
  if (!isIsoDate(raw.createdAt) || !isIsoDate(raw.updatedAt)) return null;
  if (!Array.isArray(raw.templateIds) || raw.templateIds.length > LIBRARY_LIMITS.maxTemplatesPerDocument) return null;
  const templateIds: string[] = [];
  for (const id of raw.templateIds) {
    if (typeof id !== "string" || !ID_PATTERN.test(id) || templateIds.includes(id)) return null;
    templateIds.push(id);
  }
  if (!isInt(raw.byteLength, 0, LIBRARY_LIMITS.maxDocumentBytes)) return null;
  if (!isInt(raw.rev, 1, Number.MAX_SAFE_INTEGER)) return null;
  const templateStale = raw.templateStale === undefined ? null : parseTemplateStale(raw.templateStale);
  return {
    id: raw.id,
    name,
    docType,
    fileName,
    pageCount: raw.pageCount,
    pageSizes,
    fingerprint,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    templateIds,
    ...(templateStale ? { templateStale } : {}),
    byteLength: raw.byteLength,
    rev: raw.rev,
  };
}
