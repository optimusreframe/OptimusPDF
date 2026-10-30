import { cleanIso, cleanText, hasOwn, isRecord } from "@/lib/backup/modules/draftsSchema";
import { BIDI_CONTROLS } from "@/lib/backup/modules/draftsPng";
import { MAX_SCAN_ORIGINAL_BYTES } from "@/lib/backup/modules/moduleSpecs";
import { checkImageBytes } from "@/lib/image/imageIntegrity";
import { readImageHeader, type ImageKind } from "@/lib/image/prepareForPdf";
import type { QuadCorners } from "@/lib/scan/perspective";
import {
  DEFAULT_SCAN_SETTINGS,
  type ScanFilterMode,
  type ScanMode,
  type ScanPageFlags,
  type ScanPageSource,
  type ScanResolvedFilter,
  type ScanRotation,
  type ScanSession,
  type ScanSettings,
} from "@/lib/scan/types";

/**
 * Validadores del modulo «Escaneos en curso» (sesiones del Escaner): todo lo que llega de un paquete ajeno se reconstruye
 * CAMPO A CAMPO (nada de copiar objetos enteros: una clave `__proto__` o desconocida no llega a la sesion guardada), con
 * tipos, enumerados, rangos, longitudes y CANTIDADES acotadas. Una pagina que no pasa se descarta sin tumbar su sesion; una
 * sesion que no pasa se aisla sin tumbar las demas. Puro (sin IndexedDB ni DOM).
 */

/* ------------------------------------------------------------------ *
 * Topes
 * ------------------------------------------------------------------ */

/** Sesiones por paquete (el Escaner no limita su numero; 50 sesiones sin terminar ya son un indice sospechoso). */
export const MAX_SCAN_PACKAGE_SESSIONS = 50;
/** Paginas por sesion. */
export const MAX_SCAN_PAGES_PER_SESSION = 500;
/** Paginas por paquete: cada una es una entrada del zip (el contenedor admite 2 000 entre todos los modulos). */
export const MAX_SCAN_PACKAGE_PAGES = 1000;
/** Nombre de una sesion. */
export const MAX_SCAN_NAME_CHARS = 200;
/** Texto reconocido de UNA pagina (una hoja densa ronda los 5 000): por encima se descarta y se vuelve a reconocer al guardar el PDF. */
export const MAX_SCAN_OCR_CHARS = 10_000;
/** Pixeles de una foto (50 Mpx son un iPhone Pro; 200 Mpx dejan margen para una camara de 108-200 Mpx). */
export const MAX_SCAN_PIXELS = 200_000_000;
export const MAX_SCAN_SIDE = 100_000;

/** Id de pagina: el mismo patron que acepta el almacen (`PAGE_ID`). */
export const SCAN_PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_REF = /^s[0-9]{1,3}$/;
const PAGE_REF = /^p[0-9]{1,4}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const CONTROLS_KEEP_NEWLINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/* ------------------------------------------------------------------ *
 * Enumerados (un `Record` por tipo: si el contrato gana un valor y aqui no, TypeScript no compila)
 * ------------------------------------------------------------------ */

const MODES: Record<ScanMode, true> = { document: true, "id-card": true, receipt: true, book: true, whiteboard: true, photo: true };
const FILTERS: Record<ScanFilterMode, true> = { auto: true, color: true, grayscale: true, bw: true, enhance: true, original: true };
const SOURCES: Record<ScanPageSource, true> = { camera: true, library: true, file: true };
const RESOLVED: Record<ScanResolvedFilter, true> = { color: true, grayscale: true, bw: true, enhance: true, original: true, whiteboard: true };
const FLAG_KEYS = ["blank", "sparse", "blurry", "glare", "dark", "noDocument"] as const satisfies readonly (keyof ScanPageFlags)[];
const QUAD_POINTS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

function isIn<T extends string>(table: Record<T, true>, value: unknown): value is T {
  return typeof value === "string" && hasOwn(table, value);
}

/* ------------------------------------------------------------------ *
 * Fotos originales
 * ------------------------------------------------------------------ */

/** Formatos de foto que acepta el modulo (con su extension y su tipo MIME). SVG y cualquier otra cosa quedan fuera. */
const IMAGE_FORMATS: Partial<Record<ImageKind, { ext: string; mime: string }>> = {
  jpeg: { ext: "jpg", mime: "image/jpeg" },
  png: { ext: "png", mime: "image/png" },
  webp: { ext: "webp", mime: "image/webp" },
  heic: { ext: "heic", mime: "image/heic" },
  avif: { ext: "avif", mime: "image/avif" },
  gif: { ext: "gif", mime: "image/gif" },
  bmp: { ext: "bmp", mime: "image/bmp" },
};
export const SCAN_IMAGE_EXTENSIONS: readonly string[] = Object.values(IMAGE_FORMATS).map((format) => format.ext);

export type OriginalProblem = "tooLarge" | "notImage" | "corrupt" | "pixels";

export type OriginalInfo = {
  ext: string;
  mime: string;
  /** Dimensiones tal como se VEN (con la orientacion aplicada), leidas de la cabecera; `null` si el formato no las da. */
  width: number | null;
  height: number | null;
};

/**
 * Comprueba los BYTES de una foto original sin decodificarla: formato por los primeros bytes (nunca por el nombre ni el tipo
 * que declara el paquete), estructura completa (JPEG con EOI, PNG con IEND...), tamano y pixeles de la cabecera. La
 * decodificacion real la hace `validateImage` en el plan (opcional) y, al abrir la sesion, el motor del Escaner.
 */
export function inspectOriginal(bytes: Uint8Array): { ok: true; info: OriginalInfo } | { ok: false; problem: OriginalProblem } {
  if (bytes.byteLength === 0) return { ok: false, problem: "notImage" };
  if (bytes.byteLength > MAX_SCAN_ORIGINAL_BYTES) return { ok: false, problem: "tooLarge" };
  const header = readImageHeader(bytes);
  const format = IMAGE_FORMATS[header.kind];
  if (!format) return { ok: false, problem: "notImage" };
  const verdict = checkImageBytes(bytes);
  if (!verdict.ok) return { ok: false, problem: verdict.problem === "notImage" || verdict.problem === "empty" ? "notImage" : "corrupt" };
  const { displayWidth: width, displayHeight: height } = header;
  if (width !== null && height !== null && (width > MAX_SCAN_SIDE || height > MAX_SCAN_SIDE || width * height > MAX_SCAN_PIXELS)) {
    return { ok: false, problem: "pixels" };
  }
  return { ok: true, info: { ext: format.ext, mime: format.mime, width, height } };
}

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function parseCorners(value: unknown): QuadCorners | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const out: Partial<Record<(typeof QUAD_POINTS)[number], { x: number; y: number }>> = {};
  for (const key of QUAD_POINTS) {
    const point = hasOwn(value, key) ? value[key] : undefined;
    if (!isRecord(point)) return undefined;
    // Esquinas «0..1»; un poco fuera es lo que deja un arrastre al borde, mas alla no es un documento.
    const x = finite(point.x, -0.5, 1.5);
    const y = finite(point.y, -0.5, 1.5);
    if (x === null || y === null) return undefined;
    out[key] = { x, y };
  }
  return out as QuadCorners;
}

function parseFlags(value: unknown): ScanPageFlags | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const out: ScanPageFlags = {};
  for (const key of FLAG_KEYS) {
    if (!hasOwn(value, key) || value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") return null;
    // Solo las banderas puestas: `false` y «ausente» son lo mismo (y asi se comparan con lo local).
    if (value[key] === true) out[key] = true;
  }
  if (hasOwn(value, "duplicateOf") && value.duplicateOf !== undefined) {
    if (typeof value.duplicateOf !== "string" || !SCAN_PAGE_ID.test(value.duplicateOf)) return null;
    out.duplicateOf = value.duplicateOf;
  }
  return out;
}

type JpegSample = NonNullable<ParsedScanPage["jpegSample"]>;

function parseJpegSample(value: unknown): JpegSample | null {
  if (!isRecord(value)) return null;
  const side = finite(value.side, Number.MIN_VALUE, MAX_SCAN_SIDE);
  const bytesPerPixel = finite(value.bytesPerPixel, Number.MIN_VALUE, 100);
  if (side === null || bytesPerPixel === null) return null;
  const out: JpegSample = { side, bytesPerPixel };
  if (hasOwn(value, "qualityRatio") && value.qualityRatio !== undefined) {
    if (!isRecord(value.qualityRatio)) return null;
    const entries = Object.entries(value.qualityRatio);
    if (entries.length > 16) return null;
    const ratios: Record<string, number> = {};
    for (const [key, ratio] of entries) {
      const clean = finite(ratio, Number.MIN_VALUE, 1000);
      if (!/^[A-Za-z0-9_.-]{1,16}$/.test(key) || FORBIDDEN_KEYS.has(key) || clean === null) return null;
      ratios[key] = clean;
    }
    out.qualityRatio = ratios;
  }
  return out;
}

/** Texto reconocido: sin controles (salvo saltos de linea y tabuladores) ni marcas bidi; demasiado largo = se descarta. */
export function cleanOcrText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_SCAN_OCR_CHARS * 2) return null;
  const clean = value.replace(CONTROLS_KEEP_NEWLINES, " ").replace(BIDI_CONTROLS, "").trim();
  return clean.length <= MAX_SCAN_OCR_CHARS ? clean : null;
}

/* ------------------------------------------------------------------ *
 * Pagina
 * ------------------------------------------------------------------ */

export type ScanPageFields = {
  id: string;
  createdAt: string;
  source: ScanPageSource;
  originalWidth: number;
  originalHeight: number;
  corners: QuadCorners | null;
  rotation: ScanRotation;
  filter: ScanFilterMode;
  adjust: { brightness: number; contrast: number };
  flags: ScanPageFlags;
  ocrText?: string;
  mode?: ScanMode;
  resolvedFilter?: ScanResolvedFilter;
  jpegSample?: { side: number; bytesPerPixel: number; qualityRatio?: Record<string, number> };
};

export type ParsedScanPage = ScanPageFields & {
  ref: string;
  /** Ruta de la foto en el paquete, ya comprobada contra `scan-sessions/<sesion>-<pagina>.<ext>`. */
  file: string;
  /** Extension declarada en la ruta (la real la decide `inspectOriginal`). */
  ext: string;
};

/**
 * Los campos de una pagina reconstruidos UNO A UNO (nada del objeto original sobrevive salvo lo validado), o `null` si la
 * pagina no es valida. Lo usan el lector del indice y la revalidacion de lo que se va a escribir.
 */
export function parseScanPageFields(raw: unknown): ScanPageFields | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && SCAN_PAGE_ID.test(raw.id) ? raw.id : null;
  const createdAt = cleanIso(raw.createdAt);
  if (!id || !createdAt || !isIn(SOURCES, raw.source)) return null;
  const width = integer(raw.originalWidth, 1, MAX_SCAN_SIDE);
  const height = integer(raw.originalHeight, 1, MAX_SCAN_SIDE);
  if (width === null || height === null || width * height > MAX_SCAN_PIXELS) return null;
  const corners = hasOwn(raw, "corners") ? parseCorners(raw.corners) : null;
  if (corners === undefined) return null;
  if (!(raw.rotation === 0 || raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270)) return null;
  if (!isIn(FILTERS, raw.filter) || !isRecord(raw.adjust)) return null;
  const brightness = finite(raw.adjust.brightness, -1, 1);
  const contrast = finite(raw.adjust.contrast, -1, 1);
  if (brightness === null || contrast === null) return null;
  const flags = parseFlags(raw.flags);
  if (!flags) return null;

  const page: ScanPageFields = {
    id,
    createdAt,
    source: raw.source,
    originalWidth: width,
    originalHeight: height,
    corners,
    rotation: raw.rotation,
    filter: raw.filter,
    adjust: { brightness, contrast },
    flags,
  };
  if (hasOwn(raw, "ocrText") && raw.ocrText !== undefined) {
    // Un texto reconocido que no cabe (o no es texto) se descarta SIN tumbar la pagina: se vuelve a reconocer al guardar el PDF.
    const text = cleanOcrText(raw.ocrText);
    if (text !== null) page.ocrText = text;
  }
  if (hasOwn(raw, "mode") && raw.mode !== undefined) {
    if (!isIn(MODES, raw.mode)) return null;
    page.mode = raw.mode;
  }
  if (hasOwn(raw, "resolvedFilter") && raw.resolvedFilter !== undefined) {
    if (!isIn(RESOLVED, raw.resolvedFilter)) return null;
    page.resolvedFilter = raw.resolvedFilter;
  }
  if (hasOwn(raw, "jpegSample") && raw.jpegSample !== undefined) {
    const sample = parseJpegSample(raw.jpegSample);
    if (!sample) return null;
    page.jpegSample = sample;
  }
  return page;
}

/** `null` si la pagina del indice no es valida (se descarta; no tumba la sesion). `sessionRef` ata la ruta de la foto a su sesion. */
export function parseScanPage(raw: unknown, sessionRef: string): ParsedScanPage | null {
  if (!isRecord(raw)) return null;
  const ref = typeof raw.ref === "string" && PAGE_REF.test(raw.ref) ? raw.ref : null;
  const fields = parseScanPageFields(raw);
  if (!ref || !fields) return null;
  const file = typeof raw.file === "string" ? raw.file : "";
  const match = new RegExp(`^scan-sessions/${sessionRef}-${ref}\\.([a-z0-9]{2,5})$`).exec(file);
  if (!match || !SCAN_IMAGE_EXTENSIONS.includes(match[1])) return null;
  return { ...fields, ref, file, ext: match[1] };
}

/* ------------------------------------------------------------------ *
 * Sesion
 * ------------------------------------------------------------------ */

export type ParsedScanSession = {
  ref: string;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  savedAt: string;
  settings: ScanSettings;
  nameSuggested?: NonNullable<ScanSession["nameSuggested"]>;
  /** Entradas de pagina SIN validar (cada una pasa por `parseScanPage`). */
  rawPages: unknown[];
};

/** Ajustes de una sesion: lo que falta toma el valor por defecto; un valor de otro tipo o fuera del enumerado invalida el conjunto. */
export function parseSettings(value: unknown): ScanSettings | null {
  if (value === undefined) return { ...DEFAULT_SCAN_SETTINGS };
  if (!isRecord(value)) return null;
  const out: ScanSettings = { ...DEFAULT_SCAN_SETTINGS };
  if (hasOwn(value, "mode") && value.mode !== undefined) {
    if (!isIn(MODES, value.mode)) return null;
    out.mode = value.mode;
  }
  if (hasOwn(value, "defaultFilter") && value.defaultFilter !== undefined) {
    if (!isIn(FILTERS, value.defaultFilter)) return null;
    out.defaultFilter = value.defaultFilter;
  }
  for (const key of ["autoCapture", "batch", "searchable"] as const) {
    if (!hasOwn(value, key) || value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") return null;
    out[key] = value[key];
  }
  return out;
}

export function parseNameSuggested(value: unknown): NonNullable<ScanSession["nameSuggested"]> | null {
  if (!isRecord(value) || (value.source !== "ocr" && value.source !== "date")) return null;
  let title: string | null = null;
  if (value.title !== null && value.title !== undefined) {
    const clean = cleanText(value.title, MAX_SCAN_NAME_CHARS, true);
    if (clean === null) return null;
    title = clean === "" ? null : clean;
  }
  let date: string | null = null;
  if (value.date !== null && value.date !== undefined) {
    if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || Number.isNaN(Date.parse(value.date))) return null;
    date = value.date;
  }
  const out: NonNullable<ScanSession["nameSuggested"]> = { title, date, source: value.source };
  if (hasOwn(value, "name") && value.name !== undefined) {
    const name = cleanText(value.name, MAX_SCAN_NAME_CHARS, true);
    if (name === null) return null;
    if (name !== "") out.name = name;
  }
  return out;
}

/** El futuro no existe: una fecha de mas de un dia por delante se recorta a ahora (un paquete no puede dar a una sesion vida eterna). */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
export function cappedClock(iso: string, now: number): string {
  return Date.parse(iso) > now + FUTURE_SLACK_MS ? new Date(now).toISOString() : iso;
}

/** La cabecera de una sesion del indice, o el motivo por el que no vale. Las paginas se validan una a una aparte. */
export function parseScanSession(raw: unknown, now: number): ParsedScanSession | { failure: "invalidEntry" | "tooMany" } {
  if (!isRecord(raw)) return { failure: "invalidEntry" };
  const ref = typeof raw.ref === "string" && SESSION_REF.test(raw.ref) ? raw.ref : null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const createdAt = cleanIso(raw.createdAt);
  const updatedAt = cleanIso(raw.updatedAt);
  const savedAt = cleanIso(raw.savedAt);
  const name = cleanText(raw.name, MAX_SCAN_NAME_CHARS, true);
  const settings = parseSettings(raw.settings);
  if (!ref || !isSessionId(id) || !createdAt || !updatedAt || !savedAt || name === null || !settings) return { failure: "invalidEntry" };
  if (!Array.isArray(raw.pages)) return { failure: "invalidEntry" };
  if (raw.pages.length > MAX_SCAN_PAGES_PER_SESSION) return { failure: "tooMany" };
  const parsed: ParsedScanSession = {
    ref,
    id,
    name,
    createdAt: cappedClock(createdAt, now),
    updatedAt: cappedClock(updatedAt, now),
    savedAt: cappedClock(savedAt, now),
    settings,
    rawPages: raw.pages as unknown[],
  };
  if (hasOwn(raw, "nameSuggested") && raw.nameSuggested !== undefined && raw.nameSuggested !== null) {
    const suggested = parseNameSuggested(raw.nameSuggested);
    if (!suggested) return { failure: "invalidEntry" };
    parsed.nameSuggested = suggested;
  }
  return parsed;
}

/** Mismo patron que `isValidScanSessionId` del almacen (la copia local se comprueba otra vez con la funcion del almacen al aplicar). */
const SESSION_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** Lo que un `ScanPage` local aporta al indice del paquete (solo lo que viaja; las fechas ya normalizadas por quien llama). */
export function portablePageFields(page: ScanPageFields): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const key of FLAG_KEYS) if (page.flags?.[key] === true) flags[key] = true;
  if (typeof page.flags?.duplicateOf === "string") flags.duplicateOf = page.flags.duplicateOf;
  return {
    id: page.id,
    createdAt: page.createdAt,
    source: page.source,
    originalWidth: page.originalWidth,
    originalHeight: page.originalHeight,
    corners: page.corners,
    rotation: page.rotation,
    filter: page.filter,
    adjust: { brightness: page.adjust.brightness, contrast: page.adjust.contrast },
    flags,
    ...(page.ocrText !== undefined ? { ocrText: page.ocrText } : {}),
    ...(page.mode !== undefined ? { mode: page.mode } : {}),
    ...(page.resolvedFilter !== undefined ? { resolvedFilter: page.resolvedFilter } : {}),
    ...(page.jpegSample !== undefined ? { jpegSample: page.jpegSample } : {}),
  };
}
