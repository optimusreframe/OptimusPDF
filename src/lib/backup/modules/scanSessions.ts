import { sha256Hex } from "@/lib/crypto/sha256";
import { CURRENT_SCAN_SESSIONS_SCHEMA, migrateScanSessionsIndex } from "@/lib/backup/migrations/scanSessions";
import { cleanIso, cleanText, hasOwn, isRecord } from "@/lib/backup/modules/draftsSchema";
import {
  MAX_SCAN_ORIGINAL_BYTES,
  MAX_SCAN_SESSIONS_JSON_BYTES,
  SCAN_SESSIONS_MODULE,
} from "@/lib/backup/modules/moduleSpecs";
import {
  MAX_SCAN_NAME_CHARS,
  MAX_SCAN_PACKAGE_PAGES,
  MAX_SCAN_PACKAGE_SESSIONS,
  MAX_SCAN_PAGES_PER_SESSION,
  cappedClock,
  cleanOcrText,
  inspectOriginal,
  parseNameSuggested,
  parseScanPage,
  parseScanPageFields,
  parseScanSession,
  parseSettings,
  portablePageFields,
  type ParsedScanSession,
  type ScanPageFields,
} from "@/lib/backup/modules/scanSessionsSchema";
import { parseStrictJson } from "@/lib/backup/strictJson";
import {
  NEWER_VERSION_MESSAGE,
  PACKAGE_LIMITS,
  PackageError,
  type PackageFileInput,
  type PackageFileRead,
  type PackageModuleInput,
  type PackageReadResult,
} from "@/lib/backup/types";
import {
  MAX_SCAN_SESSION_BYTES,
  SCAN_SESSION_TTL_MS,
  isValidScanSessionId,
  listScanSessionSummaries,
  newScanSessionId,
  scanSessionStore,
  scanSessionsSupported,
  type ScanSessionSummary,
} from "@/lib/scan/sessionStore";
import { DEFAULT_SCAN_SETTINGS, type ScanPage, type ScanSession } from "@/lib/scan/types";

/**
 * Modulo «Escaneos en curso» del respaldo (sesiones del Escaner, `docs/PLAN-FIRMA-AGIL.md`): las sesiones sin terminar de
 * «Escanear a PDF» (IndexedDB `optimuspdf-scan-sessions`), con la FOTO ORIGINAL de cada pagina y los parametros que la
 * interfaz necesita para seguir (recorte, giro, filtro, ajuste, avisos, modo, texto reconocido).
 *
 * ```
 * scan-sessions/index.json          { sessions: [ { ref, id, name, createdAt, updatedAt, savedAt, settings, nameSuggested?,
 *                                                  pages: [ { ref, id, createdAt, source, originalWidth, originalHeight,
 *                                                             corners, rotation, filter, adjust, flags, mode?, ocrText?,
 *                                                             resolvedFilter?, jpegSample?, file } ] } ] }
 * scan-sessions/s<n>-p<m>.<ext>     foto original de la pagina m de la sesion n (jpg, png, webp, heic, avif, gif o bmp)
 * manifest.modules["scan-sessions"] { schemaVersion: 1, sessions, pages }
 * ```
 * El modulo se llama `scanSessions` en la interfaz y `scan-sessions` en el paquete (el contenedor solo admite minusculas y
 * guiones en el nombre del modulo y UNA carpeta: de ahi tambien `s<n>-p<m>.<ext>` en vez de subcarpetas). La ruta de cada foto
 * se DERIVA de las referencias y del formato real de los bytes: ni nombres ni tipos MIME del zip se creen.
 *
 * Que NO viaja: las miniaturas y el resultado procesado (el almacen tampoco guarda el procesado; la miniatura se vuelve a
 * calcular desde el original y sus parametros al abrir la sesion), `rev`/`writerId`/`expiresAt`/`bytes`/`pageCount` (se
 * recalculan) ni nada de otra pestana.
 *
 * Memoria: se procesa SESION A SESION. Al exportar, las fotos de cada sesion se leen justo antes de usarse y los `Blob` de la
 * anterior ya se soltaron (lo que ocupa memoria al final son los bytes del propio paquete, que el contenedor construye en
 * memoria con el tope de 250 MiB); el tope se comprueba con el tamano de los `Blob` ANTES de leer ninguna foto. Al importar,
 * cada sesion se convierte en `Blob` y se guarda de una en una.
 *
 * Importar (`planScanSessionsImport` -> `applyScanSessionsImport`): cada sesion queda «Nueva», «Ya la tienes (identica)»
 * (mismo contenido bajo cualquier id local) o «Distinta» (mismo id, otro contenido) -> Reemplazar / Conservar ambas / Omitir.
 * Una sesion mas reciente que la del paquete NUNCA se pisa sin una decision explicita (la sugerida es conservar ambas). Lo
 * que se escribe pasa por `scanSessionStore.save` (una transaccion por sesion), asi que respeta los topes del almacen (600 MiB
 * por sesion, cuota del navegador) y avisa a otras pestanas igual que un guardado normal. Una sesion que falla no estropea
 * las demas.
 *
 * LIMITES: (1) el vencimiento a 14 dias se cuenta desde el ULTIMO GUARDADO y el almacen lo fija al guardar: una sesion
 * importada vive 14 dias desde la importacion (no se puede conservar el vencimiento original con la API publica del
 * almacen); una sesion que ya estaba caducada en el paquete se rechaza. (2) Las miniaturas se regeneran al abrir la sesion
 * (la portada de «Recientes» aparece al abrirla). (3) El paquete no puede pasar de 250 MiB aunque el almacen admita 600 MiB
 * por sesion: hay que elegir sesiones.
 */

export { SCAN_SESSIONS_MODULE, SCAN_SESSIONS_MODULE_SPEC, MAX_SCAN_SESSIONS_JSON_BYTES, MAX_SCAN_ORIGINAL_BYTES } from "@/lib/backup/modules/moduleSpecs";
export { MAX_SCAN_PACKAGE_PAGES, MAX_SCAN_PACKAGE_SESSIONS, MAX_SCAN_PAGES_PER_SESSION } from "@/lib/backup/modules/scanSessionsSchema";

const INDEX_PATH = "scan-sessions/index.json";

/** A partir de este peso se avisa de que el paquete sera grande y tardara. */
export const LARGE_SCAN_BYTES = 100 * 1024 * 1024;

/** Reserva para el manifiesto y los demas modulos del mismo paquete al comprobar que las sesiones caben. */
const DEFAULT_PACKAGE_BYTES_BUDGET = PACKAGE_LIMITS.maxUncompressedBytes - 4 * 1024 * 1024;
let PACKAGE_BYTES_BUDGET = DEFAULT_PACKAGE_BYTES_BUDGET;

/** Solo para pruebas: acota el tope de bytes del paquete (evita reservar 250 MB); sin argumentos lo restaura. */
export function __setScanSessionsPackageBudgetForTests(bytes?: number): void {
  PACKAGE_BYTES_BUDGET = bytes ?? DEFAULT_PACKAGE_BYTES_BUDGET;
}

/** Tope de una sesion en el almacen (600 MiB): el del propio almacen. */
let SESSION_BYTES_CAP = MAX_SCAN_SESSION_BYTES;

/** Solo para pruebas: acota el tope por sesion que aplica el modulo (evita fabricar 600 MiB); sin argumentos lo restaura. */
export function __setScanSessionBytesCapForTests(bytes?: number): void {
  SESSION_BYTES_CAP = bytes ?? MAX_SCAN_SESSION_BYTES;
}

const encoder = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  // copia al Uint8Array del dominio actual (en jsdom el de TextEncoder es ajeno)
  return new Uint8Array(encoder.encode(JSON.stringify(value)));
}

/** Lo que ocupa una sesion en el almacen (la misma cuenta que hace `sessionStore`: originales + 600 por pagina + 1 200). */
function storeBytesOf(originalBytes: number, pages: number): number {
  return originalBytes + pages * 600 + 1200;
}

/* ------------------------------------------------------------------ *
 * Resumen previo a exportar
 * ------------------------------------------------------------------ */

export type ScanSessionInfo = {
  id: string;
  name: string;
  /** Paginas CON foto (las que viajarian). */
  pageCount: number;
  /** Bytes de las fotos originales. */
  bytes: number;
  updatedAt: string;
  savedAt: string;
};

export type ScanSessionsSummary =
  | {
      ok: true;
      /** De la mas reciente a la mas antigua. */
      sessions: ScanSessionInfo[];
      total: { count: number; pages: number; bytes: number };
      /** Sesiones que no se pudieron leer (no se ofrecen). */
      unreadable: number;
      /** Cada sesion lleva fotos de documentos, a menudo de clientes: se recomienda cifrar. */
      containsClientData: boolean;
      encryptionRecommended: boolean;
      /** TODAS las sesiones caben en un paquete. */
      fitsInPackage: boolean;
    }
  | { ok: false; reason: "unavailable" };

/** ¿Caben estas sesiones en un solo paquete? (bytes, paginas y numero de sesiones). */
export function scanSelectionFits(sessions: readonly Pick<ScanSessionInfo, "pageCount" | "bytes">[]): boolean {
  let bytes = 0;
  let pages = 0;
  for (const session of sessions) {
    bytes += session.bytes;
    pages += session.pageCount;
  }
  return sessions.length <= MAX_SCAN_PACKAGE_SESSIONS && pages <= MAX_SCAN_PACKAGE_PAGES && bytes <= PACKAGE_BYTES_BUDGET;
}

/**
 * Tamano de cada sesion ya medido (el almacen publico no lo da en la lista: hay que cargar la sesion, que solo trae
 * MANEJADORES de `Blob` respaldados en disco, y sumar `size`; no se lee ningun byte). Se recuerda por id + fecha de guardado,
 * asi que abrir la hoja de exportar y marcar casillas no vuelve a cargar lo que no cambio.
 */
const sizeMemo = new Map<string, { savedAt: string; pages: number; bytes: number }>();

/** Solo para pruebas: olvida los tamanos medidos. */
export function __resetScanSessionsSizeMemoForTests(): void {
  sizeMemo.clear();
}

async function measure(summary: ScanSessionSummary): Promise<{ pages: number; bytes: number } | null> {
  const known = sizeMemo.get(summary.id);
  if (known && known.savedAt === summary.savedAt) return { pages: known.pages, bytes: known.bytes };
  const session = await scanSessionStore.load(summary.id);
  if (!session) return null;
  let bytes = 0;
  for (const page of session.pages) bytes += page.original.size;
  const measured = { pages: session.pages.length, bytes };
  sizeMemo.set(summary.id, { savedAt: summary.savedAt, ...measured });
  return measured;
}

/**
 * «N sesiones, M paginas, X MB». Solo mide (ni lee fotos ni cambia nada). Sin IndexedDB, `{ ok: false }`. Nunca lanza.
 */
export async function summarizeScanSessions(options: { now?: number } = {}): Promise<ScanSessionsSummary> {
  if (!scanSessionsSupported()) return { ok: false, reason: "unavailable" };
  try {
    const listing = await listScanSessionSummaries(options.now ?? Date.now());
    const sessions: ScanSessionInfo[] = [];
    let unreadable = 0;
    for (const summary of listing) {
      const measured = await measure(summary);
      if (!measured || measured.pages === 0) {
        unreadable += 1;
        continue;
      }
      sessions.push({ id: summary.id, name: summary.name, pageCount: measured.pages, bytes: measured.bytes, updatedAt: summary.updatedAt, savedAt: summary.savedAt });
    }
    const total = {
      count: sessions.length,
      pages: sessions.reduce((sum, session) => sum + session.pageCount, 0),
      bytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
    };
    return {
      ok: true,
      sessions,
      total,
      unreadable,
      containsClientData: total.count > 0,
      encryptionRecommended: total.count > 0,
      fitsInPackage: scanSelectionFits(sessions),
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

export type ExportScanSessionsOptions = {
  /** Ids de las sesiones que viajan. Sin esto, todas las vigentes. */
  ids?: readonly string[];
  /** Solo para pruebas: la fecha con la que se juzga la caducidad. */
  now?: number;
};

export type ExportScanSessionsReport = {
  sessions: number;
  pages: number;
  /** Bytes de las fotos que viajan. */
  bytes: number;
  /** Sesiones que se quedaron fuera (no se pudieron leer o ninguna de sus fotos es valida). */
  skippedSessions: number;
  /** Paginas que se quedaron fuera (foto danada, demasiado grande o de un formato que el modulo no admite). */
  skippedPages: number;
};

type PortableSession = { item: Record<string, unknown>; files: PackageFileInput[]; pages: number; bytes: number; skippedPages: number };

async function readBytes(blob: Blob): Promise<Uint8Array> {
  // copia al Uint8Array del dominio actual (en jsdom/fake-indexeddb el de `arrayBuffer()` puede ser ajeno)
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Una sesion local -> su entrada del indice y sus archivos. Las fotos se leen UNA a UNA. Una pagina cuya foto no pasa
 * `inspectOriginal` (o cuya entrada no pasaria `parseScanPage`: el modulo nunca escribe lo que luego rechazaria) se queda
 * fuera y se cuenta.
 */
async function portableSession(session: ScanSession, savedAt: string, ref: string, now: number): Promise<PortableSession> {
  const files: PackageFileInput[] = [];
  const pages: Record<string, unknown>[] = [];
  const usedIds = new Set<string>();
  let bytes = 0;
  let skipped = 0;
  for (const page of session.pages) {
    const entry = await portablePage(page, ref, `p${pages.length + 1}`);
    if (!entry || usedIds.has(page.id)) {
      skipped += 1;
      continue;
    }
    usedIds.add(page.id);
    bytes += entry.file.data.byteLength;
    files.push(entry.file);
    pages.push(entry.item);
  }
  const settings = parseSettings(session.settings) ?? { ...DEFAULT_SCAN_SETTINGS };
  const suggested = session.nameSuggested ? parseNameSuggested(session.nameSuggested) : null;
  const cleanSavedAt = cappedClock(cleanIso(savedAt) ?? new Date(now).toISOString(), now);
  const item: Record<string, unknown> = {
    ref,
    id: session.id,
    name: cleanText(session.name, MAX_SCAN_NAME_CHARS, true) ?? cleanText(session.name.slice(0, MAX_SCAN_NAME_CHARS), MAX_SCAN_NAME_CHARS, true) ?? "",
    createdAt: cleanIso(session.createdAt) ?? cleanSavedAt,
    updatedAt: cleanIso(session.updatedAt) ?? cleanSavedAt,
    savedAt: cleanSavedAt,
    settings,
    ...(suggested ? { nameSuggested: suggested } : {}),
    pages,
  };
  return { item, files, pages: pages.length, bytes, skippedPages: skipped };
}

async function portablePage(page: ScanPage, sessionRef: string, pageRef: string): Promise<{ item: Record<string, unknown>; file: PackageFileInput } | null> {
  try {
    if (!page.original || page.original.size === 0 || page.original.size > MAX_SCAN_ORIGINAL_BYTES) return null;
    const data = await readBytes(page.original);
    const inspected = inspectOriginal(data);
    if (!inspected.ok) return null;
    const { info } = inspected;
    const width = Number.isInteger(page.originalWidth) && page.originalWidth > 0 ? page.originalWidth : info.width;
    const height = Number.isInteger(page.originalHeight) && page.originalHeight > 0 ? page.originalHeight : info.height;
    if (width === null || height === null) return null;
    const path = `scan-sessions/${sessionRef}-${pageRef}.${info.ext}`;
    const ocrText = typeof page.ocrText === "string" ? cleanOcrText(page.ocrText) : null;
    const item = {
      ref: pageRef,
      ...portablePageFields({ ...page, originalWidth: width, originalHeight: height, ocrText: ocrText ?? undefined }),
      file: path,
    };
    // Lo que el lector no aceptaria, no se escribe.
    if (!parseScanPage(item, sessionRef)) return null;
    return { item, file: { path, data, type: info.mime } };
  } catch {
    return null;
  }
}

/**
 * Modulo «Escaneos en curso» con lo que hay ahora en este navegador, mas un informe de lo que viajo y de lo que se quedo
 * fuera. NO exporta sesiones caducadas. Sin IndexedDB lanza `PackageError("unavailable")`; si lo elegido pasa del tope de un
 * paquete, `PackageError("tooLarge")` ANTES de leer ninguna foto (la interfaz debe dejar elegir sesiones con `ids`).
 */
export async function exportScanSessionsDetailed(
  options: ExportScanSessionsOptions = {},
): Promise<{ module: PackageModuleInput; report: ExportScanSessionsReport }> {
  if (!scanSessionsSupported()) throw new PackageError("unavailable");
  const now = options.now ?? Date.now();
  const wanted = options.ids ? new Set(options.ids) : null;
  const listing = (await listScanSessionSummaries(now)).filter((summary) => wanted === null || wanted.has(summary.id));
  const ordered = [...listing].sort((a, b) => a.savedAt.localeCompare(b.savedAt));

  const files: PackageFileInput[] = [];
  const sessions: Record<string, unknown>[] = [];
  let bytes = 0;
  let pages = 0;
  let skippedSessions = 0;
  let skippedPages = 0;
  for (const summary of ordered) {
    if (sessions.length >= MAX_SCAN_PACKAGE_SESSIONS) throw new PackageError("tooLarge");
    const session = await scanSessionStore.load(summary.id);
    if (!session || session.pages.length === 0) {
      skippedSessions += 1;
      continue;
    }
    // El tope se mira con el tamano de los Blob (sin leerlos): lo que no cabria no llega a leerse.
    const declared = session.pages.reduce((sum, page) => sum + page.original.size, 0);
    if (bytes + declared > PACKAGE_BYTES_BUDGET || pages + session.pages.length > MAX_SCAN_PACKAGE_PAGES) throw new PackageError("tooLarge");
    const portable = await portableSession(session, summary.savedAt, `s${sessions.length + 1}`, now);
    // Las que el almacen ya dio por perdidas al cargar (sin original o danadas) tampoco viajan.
    skippedPages += portable.skippedPages + (session.lostPages ?? 0);
    if (portable.pages === 0) {
      skippedSessions += 1;
      continue;
    }
    bytes += portable.bytes;
    pages += portable.pages;
    files.push(...portable.files);
    sessions.push(portable.item);
  }

  files.unshift({ path: INDEX_PATH, data: jsonBytes({ sessions }), type: "application/json" });
  return {
    module: {
      name: SCAN_SESSIONS_MODULE,
      schemaVersion: CURRENT_SCAN_SESSIONS_SCHEMA,
      meta: { sessions: sessions.length, pages },
      files,
    },
    report: { sessions: sessions.length, pages, bytes, skippedSessions, skippedPages },
  };
}

export async function exportScanSessions(options: ExportScanSessionsOptions = {}): Promise<PackageModuleInput> {
  return (await exportScanSessionsDetailed(options)).module;
}

/* ------------------------------------------------------------------ *
 * Planificar la importacion
 * ------------------------------------------------------------------ */

export type ScanSessionItemStatus = "new" | "identical" | "different" | "invalid";
export type ScanSessionInvalidReason = "integrity" | "invalidEntry" | "duplicateId" | "noValidPages" | "expired" | "tooLarge" | "tooMany";
export type ScanSessionDecision = "import" | "replace" | "keepBoth" | "omit";

/** Una pagina lista para guardarse: los metadatos ya validados y los bytes verificados (SHA-256 del paquete). */
export type ScanPagePayload = {
  id: string;
  createdAt: string;
  source: ScanPage["source"];
  originalWidth: number;
  originalHeight: number;
  corners: ScanPage["corners"];
  rotation: ScanPage["rotation"];
  filter: ScanPage["filter"];
  adjust: ScanPage["adjust"];
  flags: ScanPage["flags"];
  ocrText?: string;
  mode?: ScanPage["mode"];
  resolvedFilter?: ScanPage["resolvedFilter"];
  jpegSample?: ScanPage["jpegSample"];
  bytes: Uint8Array;
  mime: string;
  sha256: string;
};

export type ScanSessionPayload = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  savedAt: string;
  settings: ScanSession["settings"];
  nameSuggested?: ScanSession["nameSuggested"];
  pages: ScanPagePayload[];
};

export type ScanSessionImportItem = {
  /** Clave de la decision: `scan:<id>`; los invalidos reciben `scan:#invalid-N` (el `#` no puede estar en un id real). */
  key: string;
  /** Id en el paquete (o el sintetico de un invalido). */
  id: string;
  status: ScanSessionItemStatus;
  reason?: ScanSessionInvalidReason;
  name: string;
  /** Paginas que se importarian. */
  pageCount: number;
  /** Paginas del paquete que se descartan (foto danada, no coincide con su hash, repetida...). */
  discardedPages: number;
  updatedAt: string;
  savedAt: string;
  /** Bytes de las fotos que se importarian. */
  bytes: number;
  /** `different`/`identical`: la sesion local con la que choca. */
  conflictWith?: { id: string; updatedAt: string; savedAt: string; pageCount: number; newer: boolean };
  /** Siempre se puede «Conservar ambas»: la copia entra con un id nuevo. */
  canKeepBoth: boolean;
  /** Lo que se escribiria (solo si `status !== "invalid"`). */
  payload?: ScanSessionPayload;
};

export type ScanSessionsPlanState = "ok" | "absent" | "newerVersion" | "damaged";

export type ScanSessionsImportPlan = {
  module: typeof SCAN_SESSIONS_MODULE;
  state: ScanSessionsPlanState;
  message?: string;
  items: ScanSessionImportItem[];
  counts: { new: number; identical: number; different: number; invalid: number };
  /** Lo que hay hoy y el sitio que queda en el navegador (`null` si no lo dice). */
  local: { count: number; storage: { usage: number; quota: number } | null };
  /** Fecha con la que se planifico (caducidad). */
  now: number;
};

export type PlanScanSessionsOptions = {
  /** Comprobacion EXTRA de cada foto (p. ej. decodificarla). `false` = la pagina se descarta. La interfaz no la pasa: el motor decodifica al abrir. */
  validateImage?: (bytes: Uint8Array, mime: string) => Promise<boolean>;
  /** Solo para pruebas: la fecha con la que se juzga la caducidad y la de «en el futuro». */
  now?: number;
};

function emptyPlan(state: ScanSessionsPlanState, now: number, message?: string): ScanSessionsImportPlan {
  return {
    module: SCAN_SESSIONS_MODULE,
    state,
    ...(message ? { message } : {}),
    items: [],
    counts: { new: 0, identical: 0, different: 0, invalid: 0 },
    local: { count: 0, storage: null },
    now,
  };
}

function blankItem(position: number, id = `#invalid-${position + 1}`): ScanSessionImportItem {
  return {
    key: `scan:#invalid-${position + 1}`,
    id,
    status: "invalid",
    name: "",
    pageCount: 0,
    discardedPages: 0,
    updatedAt: "",
    savedAt: "",
    bytes: 0,
    canKeepBoth: true,
  };
}

function fileOk(read: PackageReadResult["modules"][number], path: string): PackageFileRead | null {
  const file = read.files.get(path);
  return file && file.status === "ok" && file.bytes ? file : null;
}

type BuiltItem = { item: ScanSessionImportItem };

/** Una sesion del indice -> item del plan (o invalido con su motivo). Las fotos se verifican UNA a UNA. */
async function buildItem(
  raw: unknown,
  position: number,
  data: PackageReadResult["modules"][number],
  options: PlanScanSessionsOptions,
  now: number,
): Promise<BuiltItem> {
  const invalid = (reason: ScanSessionInvalidReason, parsed?: Partial<ParsedScanSession>): BuiltItem => ({
    item: { ...blankItem(position, parsed?.id), name: parsed?.name ?? "", updatedAt: parsed?.updatedAt ?? "", savedAt: parsed?.savedAt ?? "", reason },
  });
  const header = parseScanSession(raw, now);
  if ("failure" in header) return invalid(header.failure);
  // Caducada en el paquete: su vida (14 dias desde el ultimo guardado) ya se acabo. Ni se miran sus fotos.
  if (Date.parse(header.savedAt) + SCAN_SESSION_TTL_MS <= now) return invalid("expired", header);

  const pages: ScanPagePayload[] = [];
  const seenRefs = new Set<string>();
  const seenIds = new Set<string>();
  let discarded = 0;
  let integrity = 0;
  let originalBytes = 0;
  for (const rawPage of header.rawPages) {
    const parsed = parseScanPage(rawPage, header.ref);
    if (!parsed || seenRefs.has(parsed.ref) || seenIds.has(parsed.id)) {
      discarded += 1;
      continue;
    }
    seenRefs.add(parsed.ref);
    seenIds.add(parsed.id);
    const file = fileOk(data, parsed.file);
    if (!file?.bytes) {
      discarded += 1;
      integrity += 1;
      continue;
    }
    const inspected = inspectOriginal(file.bytes);
    // La extension de la ruta tiene que ser la del formato REAL de los bytes (nada del zip se cree).
    if (!inspected.ok || inspected.info.ext !== parsed.ext || (options.validateImage && !(await options.validateImage(file.bytes, inspected.info.mime)))) {
      discarded += 1;
      continue;
    }
    // Las dimensiones salen de la cabecera de la foto cuando existe: lo declarado por el paquete no se usa para estimar.
    const { width, height } = inspected.info;
    pages.push({
      id: parsed.id,
      createdAt: parsed.createdAt,
      source: parsed.source,
      originalWidth: width ?? parsed.originalWidth,
      originalHeight: height ?? parsed.originalHeight,
      corners: parsed.corners,
      rotation: parsed.rotation,
      filter: parsed.filter,
      adjust: parsed.adjust,
      flags: parsed.flags,
      ...(parsed.ocrText !== undefined ? { ocrText: parsed.ocrText } : {}),
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      ...(parsed.resolvedFilter !== undefined ? { resolvedFilter: parsed.resolvedFilter } : {}),
      ...(parsed.jpegSample !== undefined ? { jpegSample: parsed.jpegSample } : {}),
      bytes: file.bytes,
      mime: inspected.info.mime,
      sha256: file.sha256,
    });
    originalBytes += file.bytes.byteLength;
  }
  if (pages.length === 0) return invalid(integrity > 0 ? "integrity" : "noValidPages", header);
  if (storeBytesOf(originalBytes, pages.length) > SESSION_BYTES_CAP) return invalid("tooLarge", header);

  const payload: ScanSessionPayload = {
    id: header.id,
    name: header.name,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    savedAt: header.savedAt,
    settings: header.settings,
    ...(header.nameSuggested ? { nameSuggested: header.nameSuggested } : {}),
    pages,
  };
  return {
    item: {
      key: `scan:${header.id}`,
      id: header.id,
      status: "new",
      name: header.name,
      pageCount: pages.length,
      discardedPages: discarded,
      updatedAt: header.updatedAt,
      savedAt: header.savedAt,
      bytes: originalBytes,
      canKeepBoth: true,
      payload,
    },
  };
}

/* ---- Comparar con lo local ---- */

type Comparable = {
  name: string;
  createdAt: string;
  settings: ScanSession["settings"];
  nameSuggested: ScanSession["nameSuggested"] | null;
  pages: Array<Record<string, unknown>>;
};

function comparablePage(page: ScanPageFields): Record<string, unknown> {
  return portablePageFields({ ...page, ocrText: typeof page.ocrText === "string" ? (cleanOcrText(page.ocrText) ?? undefined) : undefined });
}

function comparableOfPayload(payload: ScanSessionPayload): Comparable {
  return {
    name: payload.name,
    createdAt: payload.createdAt,
    settings: payload.settings,
    nameSuggested: payload.nameSuggested ?? null,
    pages: payload.pages.map((page) => comparablePage(page)),
  };
}

function comparableOfLocal(session: ScanSession): Comparable {
  return {
    name: cleanText(session.name, MAX_SCAN_NAME_CHARS, true) ?? session.name,
    createdAt: cleanIso(session.createdAt) ?? session.createdAt,
    settings: parseSettings(session.settings) ?? { ...DEFAULT_SCAN_SETTINGS },
    nameSuggested: session.nameSuggested ? parseNameSuggested(session.nameSuggested) : null,
    pages: session.pages.map((page) => comparablePage({ ...page, createdAt: cleanIso(page.createdAt) ?? page.createdAt })),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** ¿La sesion local `id` tiene el MISMO contenido que el paquete? Barato primero (paginas, tamanos, parametros); los hashes solo si todo lo demas coincide. */
async function sameContent(payload: ScanSessionPayload, localId: string): Promise<boolean> {
  try {
    const local = await scanSessionStore.load(localId);
    if (!local || local.lostPages || local.pages.length !== payload.pages.length) return false;
    for (const [index, page] of local.pages.entries()) if (page.original.size !== payload.pages[index].bytes.byteLength) return false;
    if (stableStringify(comparableOfLocal(local)) !== stableStringify(comparableOfPayload(payload))) return false;
    for (const [index, page] of local.pages.entries()) {
      if ((await sha256Hex(await readBytes(page.original))) !== payload.pages[index].sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const isNewer = (local: string, packaged: string): boolean => {
  const a = Date.parse(local);
  const b = Date.parse(packaged);
  // Sin fechas fiables, lo local se trata como «igual de nuevo o mas»: nunca se pisa por un empate dudoso.
  return !(Number.isFinite(a) && Number.isFinite(b)) || a >= b;
};

async function classify(item: ScanSessionImportItem, listing: readonly ScanSessionSummary[]): Promise<void> {
  const payload = item.payload as ScanSessionPayload;
  const conflict = (summary: ScanSessionSummary) => ({
    id: summary.id,
    updatedAt: summary.updatedAt,
    savedAt: summary.savedAt,
    pageCount: summary.pageCount,
    newer: isNewer(summary.updatedAt, item.updatedAt),
  });
  const byId = listing.find((summary) => summary.id === item.id);
  if (byId && (await sameContent(payload, byId.id))) {
    item.status = "identical";
    item.conflictWith = conflict(byId);
    return;
  }
  // El mismo contenido bajo OTRO id (p. ej. un «conservar ambas» anterior): ya lo tienes.
  for (const summary of listing) {
    if (summary.id === item.id || summary.pageCount !== payload.pages.length || summary.name !== payload.name) continue;
    if (await sameContent(payload, summary.id)) {
      item.status = "identical";
      item.conflictWith = conflict(summary);
      return;
    }
  }
  if (byId) {
    item.status = "different";
    item.conflictWith = conflict(byId);
  }
}

async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate || typeof estimate.usage !== "number" || typeof estimate.quota !== "number") return null;
    if (!Number.isFinite(estimate.usage) || !Number.isFinite(estimate.quota) || estimate.quota <= 0) return null;
    return { usage: estimate.usage, quota: estimate.quota };
  } catch {
    return null;
  }
}

/**
 * Vista previa de importar el modulo «Escaneos en curso» de un paquete ya leido (`readPackage`). No escribe nada. Lee las
 * sesiones locales solo para comparar. Una sesion corrupta se aisla (`invalid` + motivo) sin tumbar el resto; un indice
 * ilegible o con demasiadas entradas deja el modulo `damaged`.
 */
export async function planScanSessionsImport(read: PackageReadResult, options: PlanScanSessionsOptions = {}): Promise<ScanSessionsImportPlan> {
  const now = options.now ?? Date.now();
  const data = read.modules.find((module) => module.name === SCAN_SESSIONS_MODULE);
  if (!data) return emptyPlan("absent", now);
  if (data.status === "newerVersion") return emptyPlan("newerVersion", now, data.message ?? NEWER_VERSION_MESSAGE);

  const indexFile = fileOk(data, INDEX_PATH);
  let sessions: unknown[];
  try {
    if (!indexFile?.bytes) throw new PackageError("invalidJson");
    const migrated = migrateScanSessionsIndex(parseStrictJson(indexFile.bytes, MAX_SCAN_SESSIONS_JSON_BYTES), data.declaredSchemaVersion);
    if (!isRecord(migrated) || !Array.isArray(migrated.sessions) || migrated.sessions.length > MAX_SCAN_PACKAGE_SESSIONS) throw new PackageError("invalidJson");
    sessions = migrated.sessions as unknown[];
  } catch {
    return emptyPlan("damaged", now);
  }
  // Un indice con mas paginas de las que cabe un paquete es hostil: ni se recorre.
  let declaredPages = 0;
  for (const raw of sessions) if (isRecord(raw) && Array.isArray(raw.pages)) declaredPages += raw.pages.length;
  if (declaredPages > MAX_SCAN_PACKAGE_PAGES) return emptyPlan("damaged", now);

  const plan = emptyPlan("ok", now);
  const candidates: ScanSessionImportItem[] = [];
  const seen = new Set<string>();
  for (const [position, raw] of sessions.entries()) {
    const { item } = await buildItem(raw, position, data, options, now);
    if (item.status === "invalid") {
      plan.items.push(item);
      continue;
    }
    if (seen.has(item.key)) {
      // Mismo id dos veces en el indice: el segundo se aisla (no pisa al primero).
      plan.items.push({ ...blankItem(position, `${item.id}#${position + 1}`), name: item.name, reason: "duplicateId" });
      continue;
    }
    seen.add(item.key);
    plan.items.push(item);
    candidates.push(item);
  }

  let listing: ScanSessionSummary[] = [];
  try {
    // El reloj REAL (no `now`): listar purga lo caducado, y una fecha de prueba no debe borrar sesiones guardadas.
    listing = scanSessionsSupported() ? await listScanSessionSummaries() : [];
  } catch {
    listing = [];
  }
  plan.local = { count: listing.length, storage: await storageEstimate() };
  for (const item of candidates) await classify(item, listing);
  for (const item of plan.items) plan.counts[item.status] += 1;
  return plan;
}

/* ------------------------------------------------------------------ *
 * Decisiones y limites
 * ------------------------------------------------------------------ */

/**
 * Decision sugerida: lo nuevo se importa; lo identico y lo invalido se omiten; lo distinto se REEMPLAZA solo si el del
 * paquete es MAS NUEVO que el local, y si el local es igual de nuevo o mas se CONSERVAN AMBAS. Jamas se pisa una sesion mas
 * nueva sin una decision explicita.
 */
export function defaultScanSessionDecisions(plan: ScanSessionsImportPlan): Record<string, ScanSessionDecision> {
  const out: Record<string, ScanSessionDecision> = {};
  for (const item of plan.items) {
    if (item.status === "new") out[item.key] = "import";
    else if (item.status === "different") out[item.key] = item.conflictWith && !item.conflictWith.newer ? "replace" : "keepBoth";
    else out[item.key] = "omit";
  }
  return out;
}

type Approved = { item: ScanSessionImportItem; decision: "import" | "replace" | "keepBoth" };

function approvedItems(plan: ScanSessionsImportPlan, decisions: Record<string, ScanSessionDecision | undefined>): Approved[] {
  const out: Approved[] = [];
  for (const item of plan.items) {
    if (!item.payload) continue;
    const decision = hasOwn(decisions, item.key) ? decisions[item.key] : undefined;
    if (item.status === "new" && decision === "import") out.push({ item, decision });
    else if (item.status === "different" && item.conflictWith && (decision === "replace" || decision === "keepBoth")) out.push({ item, decision });
  }
  return out;
}

/** Margen que el almacen deja libre del cupo del navegador (el mismo que usa `sessionStore`). */
const QUOTA_HEADROOM = 0.98;

export type ScanSessionsLimitCheck = {
  /** Sesiones aprobadas que se escribirian. */
  wanted: number;
  /** Bytes de fotos que se escribirian. */
  bytes: number;
  /** Mayor sesion aprobada, en bytes del almacen, y el tope por sesion. */
  largest: number;
  maxSessionBytes: number;
  /** Sitio libre en el navegador (`null` si el navegador no lo dice) y si lo aprobado cabe. */
  free: number | null;
  ok: boolean;
};

/**
 * ¿Caben los aprobados? Tope por sesion del almacen (600 MiB) y sitio libre del navegador, ANTES de escribir; el propio
 * almacen lo vuelve a comprobar al guardar cada sesion.
 */
export function checkScanSessionsLimits(plan: ScanSessionsImportPlan, decisions: Record<string, ScanSessionDecision | undefined>): ScanSessionsLimitCheck {
  const approved = approvedItems(plan, decisions);
  const bytes = approved.reduce((sum, { item }) => sum + item.bytes, 0);
  const largest = approved.reduce((max, { item }) => Math.max(max, storeBytesOf(item.bytes, item.pageCount)), 0);
  const storage = plan.local.storage;
  const free = storage ? Math.max(0, Math.floor(storage.quota * QUOTA_HEADROOM) - storage.usage) : null;
  return {
    wanted: approved.length,
    bytes,
    largest,
    maxSessionBytes: SESSION_BYTES_CAP,
    free,
    ok: largest <= SESSION_BYTES_CAP && (free === null || bytes <= free),
  };
}

/* ------------------------------------------------------------------ *
 * Aplicar
 * ------------------------------------------------------------------ */

export type ApplyScanSessionsResult =
  | {
      ok: true;
      /** Sesiones guardadas (nuevas, sustituidas y conservadas aparte). */
      written: number;
      replaced: number;
      keptBoth: number;
      /** Elementos del plan que no se escribieron por decision o por no ser importables. */
      skipped: number;
      /** Aprobadas que NO se escribieron porque lo local cambio desde la vista previa (no se pisa nada). */
      changed: number;
      /** Aprobadas que el almacen no pudo guardar, y por que (la primera razon). */
      failed: number;
      failedReason?: "quota" | "tooBig" | "unavailable";
      /** Ids con los que quedaron guardadas (para `?resume=scan:`). */
      saved: { id: string }[];
    }
  | { ok: false; reason: "blocked" | "invalid" | "limit"; limits?: ScanSessionsLimitCheck };

export type ApplyScanSessionsOptions = {
  now?: number;
  /** Texto que se anade al nombre de una copia «Conservar ambas» (p. ej. «(importado)»). */
  copySuffix?: string;
  /** Solo para pruebas: ocurre justo antes de guardar la sesion `id` (para provocar cambios concurrentes). */
  beforeSave?: (id: string) => void | Promise<void>;
};

/**
 * Revalida y SANEA un payload (la vista previa puede venir de la interfaz): cada campo se reconstruye otra vez con los mismos
 * validadores del plan, de modo que lo que se escribe nunca es el objeto recibido sino lo validado. `null` si algo no vale
 * (ids, paginas, fotos, tope por sesion o caducidad).
 */
function sanitizePayload(payload: ScanSessionPayload, now: number): ScanSessionPayload | null {
  try {
    if (!isRecord(payload) || !isValidScanSessionId(payload.id) || !Array.isArray(payload.pages)) return null;
    if (payload.pages.length === 0 || payload.pages.length > MAX_SCAN_PAGES_PER_SESSION) return null;
    const name = cleanText(payload.name, MAX_SCAN_NAME_CHARS, true);
    const createdAt = cleanIso(payload.createdAt);
    const updatedAt = cleanIso(payload.updatedAt);
    const savedAt = cleanIso(payload.savedAt);
    const settings = parseSettings(payload.settings);
    const suggested = payload.nameSuggested === undefined ? undefined : parseNameSuggested(payload.nameSuggested);
    if (name === null || !createdAt || !updatedAt || !savedAt || !settings || suggested === null) return null;
    if (!(Date.parse(savedAt) + SCAN_SESSION_TTL_MS > now)) return null;
    const ids = new Set<string>();
    const pages: ScanPagePayload[] = [];
    let total = 0;
    for (const page of payload.pages) {
      if (!isRecord(page) || !(page.bytes instanceof Uint8Array)) return null;
      const fields = parseScanPageFields(portablePageFields(page as ScanPageFields));
      if (!fields || ids.has(fields.id)) return null;
      ids.add(fields.id);
      // El texto reconocido recibido tiene que ser ya el limpio (el saneado lo descartaria en silencio y se escribiria el original).
      if (page.ocrText !== undefined && cleanOcrText(page.ocrText) !== page.ocrText) return null;
      const inspected = inspectOriginal(page.bytes);
      if (!inspected.ok || inspected.info.mime !== page.mime) return null;
      total += page.bytes.byteLength;
      pages.push({ ...fields, bytes: page.bytes, mime: inspected.info.mime, sha256: typeof page.sha256 === "string" ? page.sha256 : "" });
    }
    if (storeBytesOf(total, pages.length) > SESSION_BYTES_CAP) return null;
    return { id: payload.id, name, createdAt, updatedAt, savedAt, settings, ...(suggested ? { nameSuggested: suggested } : {}), pages };
  } catch {
    return null;
  }
}

function toSession(payload: ScanSessionPayload, id: string, name: string): ScanSession {
  return {
    id,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    name,
    ...(payload.nameSuggested ? { nameSuggested: payload.nameSuggested } : {}),
    settings: { ...DEFAULT_SCAN_SETTINGS, ...payload.settings },
    pages: payload.pages.map((page): ScanPage => ({
      id: page.id,
      createdAt: page.createdAt,
      source: page.source,
      original: new Blob([page.bytes as unknown as BlobPart], { type: page.mime }),
      originalWidth: page.originalWidth,
      originalHeight: page.originalHeight,
      corners: page.corners,
      rotation: page.rotation,
      filter: page.filter,
      adjust: page.adjust,
      processed: null,
      thumb: null,
      flags: page.flags,
      ...(page.ocrText !== undefined ? { ocrText: page.ocrText } : {}),
      ...(page.mode !== undefined ? { mode: page.mode } : {}),
      ...(page.resolvedFilter !== undefined ? { resolvedFilter: page.resolvedFilter } : {}),
      ...(page.jpegSample !== undefined ? { jpegSample: page.jpegSample } : {}),
    })),
  };
}

type SaveOutcome = { status: "saved"; id: string } | { status: "changed" } | { status: "failed"; reason: "quota" | "tooBig" | "unavailable" };

/**
 * Escribe SOLO lo que `decisions` aprueba (`import` para lo nuevo; `replace` / `keepBoth` para lo distinto; cualquier otra
 * cosa u omision = no se toca). Todo se REVALIDA aqui. Cada sesion se guarda con `scanSessionStore.save` (una transaccion por
 * sesion, una a una) y, justo antes, se mira que lo local siga siendo lo que vio la vista previa: una sesion que aparecio
 * desde entonces NUNCA se pisa con «Importar», y una que cambio no se sustituye (se cuenta en `changed`). Una sesion que el
 * almacen no puede guardar (cuota, tope) no impide las demas.
 */
export async function applyScanSessionsImport(
  plan: ScanSessionsImportPlan,
  decisions: Record<string, ScanSessionDecision | undefined>,
  options: ApplyScanSessionsOptions = {},
): Promise<ApplyScanSessionsResult> {
  if (!plan || plan.state !== "ok" || !Array.isArray(plan.items)) return { ok: false, reason: "blocked" };
  const now = options.now ?? Date.now();
  const approved = approvedItems(plan, decisions ?? {});
  if (approved.length === 0) {
    return { ok: true, written: 0, replaced: 0, keptBoth: 0, skipped: plan.items.length, changed: 0, failed: 0, saved: [] };
  }
  const limits = checkScanSessionsLimits(plan, decisions ?? {});
  if (!limits.ok) return { ok: false, reason: "limit", limits };
  const clean = new Map<string, ScanSessionPayload>();
  for (const { item } of approved) {
    const sane = sanitizePayload(item.payload as ScanSessionPayload, now);
    if (!sane) return { ok: false, reason: "invalid" };
    clean.set(item.key, sane);
  }

  let written = 0;
  let replaced = 0;
  let keptBoth = 0;
  let changed = 0;
  let failed = 0;
  let failedReason: "quota" | "tooBig" | "unavailable" | undefined;
  const saved: { id: string }[] = [];

  for (const { item, decision } of approved) {
    const payload = clean.get(item.key) as ScanSessionPayload;
    let outcome: SaveOutcome;
    try {
      outcome = await saveOne(payload, decision, item, options);
    } catch {
      outcome = { status: "failed", reason: "unavailable" };
    }
    if (outcome.status === "saved") {
      written += 1;
      if (decision === "replace") replaced += 1;
      if (decision === "keepBoth") keptBoth += 1;
      saved.push({ id: outcome.id });
    } else if (outcome.status === "changed") {
      changed += 1;
    } else {
      failed += 1;
      failedReason ??= outcome.reason;
    }
  }
  return {
    ok: true,
    written,
    replaced,
    keptBoth,
    skipped: plan.items.length - approved.length,
    changed,
    failed,
    ...(failedReason ? { failedReason } : {}),
    saved,
  };
}

async function saveOne(payload: ScanSessionPayload, decision: "import" | "replace" | "keepBoth", item: ScanSessionImportItem, options: ApplyScanSessionsOptions): Promise<SaveOutcome> {
  // Lo local de AHORA (no de la vista previa): otra pestana pudo guardar, borrar o cambiar la sesion mientras se revisaba.
  const listing = await listScanSessionSummaries();
  const local = listing.find((summary) => summary.id === payload.id);

  let id = payload.id;
  let name = payload.name;
  if (decision === "import") {
    if (local) return { status: "changed" };
  } else if (decision === "replace") {
    const seen = item.conflictWith;
    // `local.savedAt` cambia con CUALQUIER escritura de otra pestana: si cambio desde la vista previa, no se pisa. (Al planificar se
    // cargo esta sesion para compararla, lo que anoto su revision en esta pestana: si otra pestana escribe justo despues de esta
    // comprobacion, el almacen no la pisa, guarda la copia aparte.)
    if (!local || !seen || local.savedAt !== seen.savedAt) return { status: "changed" };
  } else {
    id = newScanSessionId();
    const suffix = options.copySuffix?.trim();
    if (suffix) name = `${payload.name} ${suffix}`.slice(0, MAX_SCAN_NAME_CHARS).trim();
  }

  await options.beforeSave?.(id);
  const result = await scanSessionStore.save(toSession(payload, id, name));
  if (!result.ok) return { status: "failed", reason: result.reason };
  // Si otra pestana tocó la sesion entre medias, el almacen la guardo aparte (no pisa): queda guardada con ese id.
  return { status: "saved", id: result.forkedAs ?? id };
}
