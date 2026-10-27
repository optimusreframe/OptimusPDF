import type { QuadCorners } from "@/lib/scan/perspective";
import {
  DEFAULT_SCAN_SETTINGS,
  type ScanFilterMode,
  type ScanMode,
  type ScanPage,
  type ScanPageFlags,
  type ScanPageSource,
  type ScanRotation,
  type ScanSession,
  type ScanSessionStore,
} from "@/lib/scan/types";

/**
 * Sesion de escaneo PERSISTENTE (IndexedDB `optimuspdf-scan-sessions`): nunca se pierde un escaneo (recarga, cierre, BACK,
 * otra pestana). Mismo patron que los borradores de Firmar / Editar / PDF Pro (`signDrafts.ts`, `proDrafts.ts`):
 *
 *  - Tres almacenes: `meta` (una fila por sesion: nombre, orden de las paginas, ajustes, miniatura de portada, `rev`/`writerId`),
 *    `pages` (una fila por pagina: parametros, banderas y miniatura) y `originals` (el original como `Blob`, sin tocar).
 *    Un `Blob` de IndexedDB es un manejador respaldado por disco: cargar una sesion NO mete 100 fotos en memoria.
 *  - Guardado INCREMENTAL y barato: solo se escriben las paginas nuevas o cambiadas (firma de sus parametros y de sus
 *    blobs) y el orden; sin cambios no se abre ni la transaccion. Las paginas quitadas se borran en la misma transaccion.
 *  - Varias pestanas: cada sesion lleva `rev` y el `writerId` de la pestana que la escribio; si otra pestana la modifico con
 *    una `rev` mayor que la que esta conoce, NO se pisa: la copia de esta pestana se guarda con otro id (`forkedAs`).
 *    Los cambios se avisan por `BroadcastChannel`.
 *  - Integridad: lo que viene de IndexedDB no se da por bueno. Una sesion corrupta no rompe la lista; una pagina sin
 *    original o danada se descarta y se cuenta en `lostPages`.
 *  - Limites: 14 dias de vida desde el ultimo guardado (`purgeExpired`), `tooBig` si la sesion pasa del tope y `quota`
 *    si el navegador no tiene sitio (se comprueba antes con `navigator.storage.estimate()` y ante `QuotaExceededError`).
 *    Ninguna funcion lanza hacia la interfaz: todo vuelve como resultado tipado.
 */

export const SCAN_DB_NAME = "optimuspdf-scan-sessions";
const DB_VERSION = 1;
const META_STORE = "meta";
const PAGES_STORE = "pages";
const ORIGINALS_STORE = "originals";
const BROADCAST_CHANNEL_NAME = "optimuspdf.scan-sessions";
export const SCAN_SCHEMA = 1 as const;

/** Vida de una sesion sin tocar. */
export const SCAN_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Una sola sesion no pasa de esto (originales + miniaturas). */
export const MAX_SCAN_SESSION_BYTES = 600 * 1024 * 1024;
/** Margen que se deja libre del cupo del navegador al comprobar la cuota. */
const QUOTA_HEADROOM = 0.98;

const limits = { maxSessionBytes: MAX_SCAN_SESSION_BYTES };

/** Solo para tests: acota el tope por sesion; sin argumentos lo restaura. */
export function __setScanStoreLimitsForTests(override: Partial<typeof limits> = {}): void {
  limits.maxSessionBytes = override.maxSessionBytes ?? MAX_SCAN_SESSION_BYTES;
}

/** Ids validos: minusculas, cifras y guiones (8-64): sirven en la URL `?resume=scan:<id>` y como clave de IndexedDB. */
const SESSION_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidScanSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id);
}

let idCounter = 0;
/** Id nuevo de sesion: `sc-<tiempo>-<contador+azar>` (cumple `isValidScanSessionId` y el patron de `resumeLinks`). */
export function newScanSessionId(): string {
  idCounter += 1;
  let random = "";
  try {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    random = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
  } catch {
    random = Math.random().toString(36).slice(2, 8);
  }
  return `sc-${Date.now().toString(36)}-${idCounter.toString(36)}${random}`;
}

/* ------------------------------------------------------------------ *
 * Filas
 * ------------------------------------------------------------------ */

type MetaRow = {
  schema: typeof SCAN_SCHEMA;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** ISO del ultimo guardado y su vencimiento (ms desde epoch). */
  savedAt: string;
  expiresAt: number;
  settings: ScanSession["settings"];
  nameSuggested?: ScanSession["nameSuggested"];
  order: string[];
  pageCount: number;
  /** Miniatura de la primera pagina (para la lista de Recientes). `coverBytes`: lo mismo en bytes (almacenamiento sin Blob). */
  cover: Blob | null;
  coverBytes?: ArrayBuffer;
  coverType?: string;
  bytes: number;
  rev: number;
  writerId: string;
};

type PageRow = {
  key: string;
  sid: string;
  pid: string;
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
  thumb: Blob | null;
  thumbBytes?: ArrayBuffer;
  thumbType?: string;
  originalBytes: number;
};

/** `blob`: el original como Blob (respaldado por disco); `bytes`+`type`: el mismo original como bytes (almacenamiento sin Blob). */
type OriginalRow = { key: string; sid: string; pid: string; blob?: Blob; bytes?: ArrayBuffer; type?: string };

const rowKey = (sid: string, pid: string) => `${sid}\u0001${pid}`;
const sessionRange = (sid: string) => IDBKeyRange.bound(`${sid}\u0001`, `${sid}\u0002`, false, true);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

const MODES: readonly string[] = ["document", "id-card", "receipt", "book", "whiteboard", "photo"];
const FILTERS: readonly string[] = ["auto", "color", "grayscale", "bw", "enhance", "original"];
const SOURCES: readonly string[] = ["camera", "library", "file"];

function isCorners(value: unknown): value is QuadCorners {
  if (!isRecord(value)) return false;
  return ["topLeft", "topRight", "bottomRight", "bottomLeft"].every((key) => {
    const point = value[key];
    return isRecord(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y);
  });
}

export function isMetaRow(value: unknown): value is MetaRow {
  if (!isRecord(value) || value.schema !== SCAN_SCHEMA) return false;
  if (!isValidScanSessionId(value.id)) return false;
  if (typeof value.name !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || typeof value.savedAt !== "string") return false;
  if (!isFiniteNumber(value.expiresAt) || !isFiniteNumber(value.pageCount) || !isFiniteNumber(value.rev) || typeof value.writerId !== "string") return false;
  if (!Array.isArray(value.order) || !value.order.every((id) => typeof id === "string" && PAGE_ID.test(id))) return false;
  if (!isRecord(value.settings) || typeof value.settings.mode !== "string" || !MODES.includes(value.settings.mode)) return false;
  return value.cover === null || value.cover === undefined || isBlobLike(value.cover);
}

function isBytes(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer || (typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object ArrayBuffer]");
}

/** Blob o bytes -> Blob (o `null`). */
function blobFrom(blob: unknown, bytes: unknown, type: unknown): Blob | null {
  if (isBlobLike(blob)) return blob;
  if (isBytes(bytes)) return new Blob([bytes], { type: typeof type === "string" ? type : "" });
  return null;
}

function isPageRow(value: unknown, sid: string, pid: string): value is PageRow {
  if (!isRecord(value) || value.sid !== sid || value.pid !== pid) return false;
  if (typeof value.createdAt !== "string" || typeof value.source !== "string" || !SOURCES.includes(value.source)) return false;
  if (!isFiniteNumber(value.originalWidth) || !isFiniteNumber(value.originalHeight)) return false;
  if (value.corners !== null && !isCorners(value.corners)) return false;
  if (![0, 90, 180, 270].includes(value.rotation as number)) return false;
  if (typeof value.filter !== "string" || !FILTERS.includes(value.filter)) return false;
  if (!isRecord(value.adjust) || !isFiniteNumber(value.adjust.brightness) || !isFiniteNumber(value.adjust.contrast)) return false;
  if (!isRecord(value.flags)) return false;
  if (value.mode !== undefined && (typeof value.mode !== "string" || !MODES.includes(value.mode))) return false;
  return value.thumb === null || value.thumb === undefined || isBlobLike(value.thumb) || isBytes(value.thumbBytes);
}

/* ------------------------------------------------------------------ *
 * Pestanas: avisos y revisiones
 * ------------------------------------------------------------------ */

const tab = { id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, knownRevs: new Map<string, number>() };
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === "undefined") return null;
    if (!channel) {
      channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      channel.addEventListener("message", (event) => {
        const data = event.data as unknown;
        if (isRecord(data) && data.type === "write" && typeof data.id === "string" && typeof data.writerId === "string" && data.writerId !== tab.id) {
          // Otra pestana escribio: lo que esta pestana creia tener escrito ya no es de fiar.
          writtenBySession.delete(data.id);
        }
        for (const listener of listeners) listener();
      });
    }
    return channel;
  } catch {
    return null;
  }
}

function announce(write?: { id: string; rev: number }): void {
  try {
    getChannel()?.postMessage(write ? { type: "write", id: write.id, rev: write.rev, writerId: tab.id } : { type: "changed", writerId: tab.id });
  } catch {
    // Canal cerrado: los oyentes de esta pestana igualmente se avisan.
  }
  for (const listener of listeners) listener();
}

/** Para refrescar una lista de sesiones cuando cambian (esta pestana u otra). */
export function subscribeToScanSessions(listener: () => void): () => void {
  listeners.add(listener);
  getChannel();
  return () => {
    listeners.delete(listener);
  };
}

/** Sesion -> id con el que se guarda de verdad (tras una bifurcacion por conflicto entre pestanas). */
const forks = new Map<string, string>();

/** Lo que ESTA pestana ya escribio por sesion: pagina -> firma (parametros + identidad de sus blobs). Evita reescribir megas. */
type WrittenPage = { signature: string; original: string };
const writtenBySession = new Map<string, Map<string, WrittenPage>>();
const metaSignatureBySession = new Map<string, string>();

let blobCounter = 0;
const blobIds = new WeakMap<Blob, number>();
function blobId(blob: Blob | null | undefined): string {
  if (!blob) return "0";
  let id = blobIds.get(blob);
  if (id === undefined) {
    blobCounter += 1;
    id = blobCounter;
    blobIds.set(blob, id);
  }
  return String(id);
}

/** Solo para tests: olvida lo que esta pestana cree haber escrito (como si fuera otra pestana o se hubiera recargado). */
export function __resetScanStoreMemoryForTests(): void {
  writtenBySession.clear();
  metaSignatureBySession.clear();
  forks.clear();
  tab.knownRevs.clear();
}

/** Solo para tests: simula ser OTRA pestana (otro `writerId`). */
export function __setScanTabIdForTests(id: string): void {
  tab.id = id;
}

/* ------------------------------------------------------------------ *
 * Apertura de la base
 * ------------------------------------------------------------------ */

const DEFAULT_OPEN_TIMEOUT_MS = 4000;
let openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS;

/** Solo para tests: acorta el plazo de apertura. */
export function __setScanOpenTimeoutForTests(ms: number): void {
  openTimeoutMs = ms;
}

export function scanSessionsSupported(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!scanSessionsSupported()) {
      reject(new Error("indexedDB no disponible"));
      return;
    }
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(SCAN_DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("la base de sesiones de escaneo tarda demasiado en abrirse"));
    }, openTimeoutMs);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PAGES_STORE)) db.createObjectStore(PAGES_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(ORIGINALS_STORE)) db.createObjectStore(ORIGINALS_STORE, { keyPath: "key" });
    };
    request.onblocked = () => {
      // Otra pestana tiene la base abierta con otra version: se espera al plazo.
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      clearTimeout(timer);
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(request.error);
    };
  });
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || code === 22;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
  });
}

/* ------------------------------------------------------------------ *
 * Firmas de lo escrito
 * ------------------------------------------------------------------ */

function pageSignature(page: ScanPage): string {
  return JSON.stringify([
    page.createdAt,
    page.source,
    page.originalWidth,
    page.originalHeight,
    page.corners,
    page.rotation,
    page.filter,
    page.adjust,
    page.flags,
    page.ocrText ?? null,
    page.mode ?? null,
    blobId(page.thumb),
  ]);
}

function metaSignature(session: ScanSession): string {
  return JSON.stringify([session.name, session.createdAt, session.settings, session.nameSuggested ?? null, session.pages.map((p) => p.id), blobId(session.pages[0]?.thumb)]);
}

function sessionBytes(session: ScanSession): number {
  let total = 0;
  for (const page of session.pages) total += (page.original?.size ?? 0) + (page.thumb?.size ?? 0) + 600;
  return total + 1200;
}

async function enoughQuota(extraBytes: number): Promise<boolean> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate || !isFiniteNumber(estimate.quota) || !isFiniteNumber(estimate.usage)) return true;
    return estimate.usage + extraBytes <= estimate.quota * QUOTA_HEADROOM;
  } catch {
    return true;
  }
}

function pageRowOf(sid: string, page: ScanPage, thumbBytes?: ArrayBuffer): PageRow {
  return {
    key: rowKey(sid, page.id),
    sid,
    pid: page.id,
    createdAt: page.createdAt,
    source: page.source,
    originalWidth: page.originalWidth,
    originalHeight: page.originalHeight,
    corners: page.corners,
    rotation: page.rotation,
    filter: page.filter,
    adjust: page.adjust,
    flags: page.flags,
    ...(page.ocrText !== undefined ? { ocrText: page.ocrText } : {}),
    ...(page.mode !== undefined ? { mode: page.mode } : {}),
    thumb: thumbBytes ? null : page.thumb,
    ...(thumbBytes ? { thumbBytes, thumbType: page.thumb?.type ?? "" } : {}),
    originalBytes: page.original.size,
  };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

type SaveResult = Awaited<ReturnType<ScanSessionStore["save"]>>;

function validSession(session: ScanSession): boolean {
  if (!isRecord(session) || !isValidScanSessionId(session.id) || !Array.isArray(session.pages)) return false;
  const seen = new Set<string>();
  for (const page of session.pages) {
    if (!isRecord(page) || typeof page.id !== "string" || !PAGE_ID.test(page.id) || seen.has(page.id) || !isBlobLike(page.original)) return false;
    seen.add(page.id);
  }
  return true;
}

function forkId(id: string): string {
  const suffix = `-b${Math.random().toString(36).slice(2, 7)}`;
  return `${id.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * Como se guardan los Blob: `blob` (lo normal: el navegador los respalda en disco) o `bytes` (ArrayBuffer). Algunos navegadores
 * rechazan Blob en IndexedDB (Safari en ventanas privadas, algunos WebKit sin almacenamiento persistente): si la escritura
 * falla por algo que no es la cuota se repite UNA vez con bytes y, si funciona, se sigue asi (nunca se pierde el escaneo).
 */
let storageMode: "blob" | "bytes" = "blob";

/** Solo para tests: fija el modo de almacenamiento. */
export function __setScanStorageModeForTests(mode: "blob" | "bytes"): void {
  storageMode = mode;
}

export function scanStorageMode(): "blob" | "bytes" {
  return storageMode;
}

async function saveSessionNow(input: ScanSession): Promise<SaveResult> {
  if (!validSession(input)) return { ok: false, reason: "unavailable" };
  let targetId = forks.get(input.id) ?? input.id;
  const bytes = sessionBytes(input);
  if (bytes > limits.maxSessionBytes) return { ok: false, reason: "tooBig" };
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  let forkedAs: string | undefined;
  try {
    const read = await requestToPromise(db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(targetId));
    const stored = isMetaRow(read) ? read : null;
    // Otra pestana escribio esta sesion con una revision que esta no conoce: no se pisa, se guarda aparte.
    if (stored && stored.writerId !== tab.id && stored.rev > (tab.knownRevs.get(targetId) ?? 0)) {
      targetId = forkId(input.id);
      forks.set(input.id, targetId);
      forkedAs = targetId;
      writtenBySession.delete(targetId);
      metaSignatureBySession.delete(targetId);
    }
    const base = forkedAs ? null : stored;
    const written = writtenBySession.get(targetId) ?? new Map<string, WrittenPage>();
    const keep = new Set(input.pages.map((page) => page.id));
    // La fila de la pagina (parametros y miniatura) y su original (pesado) se vigilan por separado: girar una pagina no reescribe la foto.
    const dirtyPages = input.pages.filter((page) => written.get(page.id)?.signature !== pageSignature(page) || written.get(page.id)?.original !== blobId(page.original));
    const dirtyOriginals = new Set(input.pages.filter((page) => written.get(page.id)?.original !== blobId(page.original)).map((page) => page.id));
    const removed = base ? base.order.filter((id) => !keep.has(id)) : [];
    const sameOrder = !!base && base.order.length === input.pages.length && base.order.every((id, index) => id === input.pages[index].id);
    const metaChanged = !base || !sameOrder || metaSignatureBySession.get(targetId) !== metaSignature(input) || removed.length > 0;
    // Sin cambios: ni siquiera se abre la transaccion de escritura.
    if (dirtyPages.length === 0 && !metaChanged) return { ok: true, rev: base?.rev };

    const newBytes = dirtyPages.reduce((total, page) => total + (dirtyOriginals.has(page.id) ? page.original.size : 0) + (page.thumb?.size ?? 0) + 600, 0);
    if (!(await enoughQuota(newBytes))) return { ok: false, reason: "quota" };

    const rev = Math.max(base?.rev ?? 0, tab.knownRevs.get(targetId) ?? 0) + 1;
    const now = Date.now();
    const meta: MetaRow = {
      schema: SCAN_SCHEMA,
      id: targetId,
      name: input.name,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      savedAt: new Date(now).toISOString(),
      expiresAt: now + SCAN_SESSION_TTL_MS,
      settings: input.settings,
      ...(input.nameSuggested ? { nameSuggested: input.nameSuggested } : {}),
      order: input.pages.map((page) => page.id),
      pageCount: input.pages.length,
      cover: input.pages[0]?.thumb ?? null,
      bytes,
      rev,
      writerId: tab.id,
    };
    // En modo `bytes` se leen los datos ANTES de abrir la transaccion (una transaccion no espera a nada asincrono).
    const asBytes = storageMode === "bytes";
    const buffers = new Map<string, { original: ArrayBuffer | undefined; thumb: ArrayBuffer | undefined }>();
    let coverBytes: ArrayBuffer | undefined;
    if (asBytes) {
      for (const page of dirtyPages) buffers.set(page.id, { original: dirtyOriginals.has(page.id) ? await page.original.arrayBuffer() : undefined, thumb: page.thumb ? await page.thumb.arrayBuffer() : undefined });
      if (input.pages[0]?.thumb) coverBytes = await input.pages[0].thumb.arrayBuffer();
      if (coverBytes) {
        meta.cover = null;
        meta.coverBytes = coverBytes;
        meta.coverType = input.pages[0].thumb?.type ?? "";
      }
    }
    const tx = db.transaction([META_STORE, PAGES_STORE, ORIGINALS_STORE], "readwrite");
    const pages = tx.objectStore(PAGES_STORE);
    const originals = tx.objectStore(ORIGINALS_STORE);
    for (const page of dirtyPages) {
      const data = buffers.get(page.id);
      pages.put(pageRowOf(targetId, page, data?.thumb));
      if (!dirtyOriginals.has(page.id)) continue;
      originals.put(
        (data?.original
          ? { key: rowKey(targetId, page.id), sid: targetId, pid: page.id, bytes: data.original, type: page.original.type }
          : { key: rowKey(targetId, page.id), sid: targetId, pid: page.id, blob: page.original }) satisfies OriginalRow,
      );
    }
    for (const pid of removed) {
      pages.delete(rowKey(targetId, pid));
      originals.delete(rowKey(targetId, pid));
    }
    tx.objectStore(META_STORE).put(meta);
    await txDone(tx);

    const next = new Map<string, WrittenPage>();
    for (const page of input.pages) next.set(page.id, { signature: pageSignature(page), original: blobId(page.original) });
    writtenBySession.set(targetId, next);
    metaSignatureBySession.set(targetId, metaSignature(input));
    tab.knownRevs.set(targetId, rev);
    announce({ id: targetId, rev });
    return { ok: true, rev, ...(forkedAs ? { forkedAs } : {}) };
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: "quota" };
    if (storageMode === "blob") {
      // Puede ser un navegador que no admite Blob en IndexedDB: se reintenta con bytes (una vez) antes de rendirse.
      storageMode = "bytes";
      const retry = await saveSessionNow(input);
      if (!retry.ok) storageMode = "blob";
      // El reintento ya escribe en la copia (el conflicto se detecto en el primer intento): se sigue avisando.
      return retry.ok && forkedAs && !retry.forkedAs ? { ...retry, forkedAs } : retry;
    }
    return { ok: false, reason: "unavailable" };
  } finally {
    db.close();
  }
}

/** Guardados de una misma sesion en fila (un autoguardado no pisa a otro que sigue en vuelo). */
const saveQueues = new Map<string, Promise<unknown>>();

function saveSession(input: ScanSession): Promise<SaveResult> {
  const key = isRecord(input) && typeof input.id === "string" ? input.id : "";
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => saveSessionNow(input),
    () => saveSessionNow(input),
  );
  const tail = run.finally(() => {
    if (saveQueues.get(key) === tail) saveQueues.delete(key);
  });
  saveQueues.set(key, tail);
  return run;
}

async function loadSession(id: string): Promise<ScanSession | null> {
  if (!isValidScanSessionId(id)) return null;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    const meta = await requestToPromise(db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(id));
    if (!isMetaRow(meta)) return null;
    const tx = db.transaction([PAGES_STORE, ORIGINALS_STORE], "readonly");
    const [pageRows, originalRows] = await Promise.all([
      requestToPromise(tx.objectStore(PAGES_STORE).getAll(sessionRange(id))),
      requestToPromise(tx.objectStore(ORIGINALS_STORE).getAll(sessionRange(id))),
    ]);
    const originalsById = new Map<string, Blob>();
    for (const row of originalRows as unknown[]) {
      if (!isRecord(row) || typeof row.pid !== "string") continue;
      const blob = blobFrom(row.blob, row.bytes, row.type);
      if (blob && blob.size > 0) originalsById.set(row.pid, blob);
    }
    const rowsById = new Map<string, unknown>();
    for (const row of pageRows as unknown[]) if (isRecord(row) && typeof row.pid === "string") rowsById.set(row.pid, row);
    const pages: ScanPage[] = [];
    let lost = 0;
    for (const pid of meta.order) {
      const row = rowsById.get(pid);
      const original = originalsById.get(pid);
      if (!isPageRow(row, id, pid) || !original) {
        lost += 1;
        continue;
      }
      pages.push({
        id: pid,
        createdAt: row.createdAt,
        source: row.source,
        original,
        originalWidth: row.originalWidth,
        originalHeight: row.originalHeight,
        corners: row.corners,
        rotation: row.rotation,
        filter: row.filter,
        adjust: row.adjust,
        processed: null,
        thumb: row.thumb ?? blobFrom(null, row.thumbBytes, row.thumbType),
        flags: row.flags,
        ...(row.ocrText !== undefined ? { ocrText: row.ocrText } : {}),
        ...(row.mode !== undefined ? { mode: row.mode } : {}),
      });
    }
    const session: ScanSession = {
      id,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      name: meta.name,
      ...(meta.nameSuggested ? { nameSuggested: meta.nameSuggested } : {}),
      pages,
      settings: { ...DEFAULT_SCAN_SETTINGS, ...meta.settings },
      ...(lost > 0 ? { lostPages: lost } : {}),
    };
    // Lo cargado ya esta escrito: el primer guardado tras recargar no reescribe nada (salvo lo que cambie).
    const written = new Map<string, WrittenPage>();
    for (const page of pages) written.set(page.id, { signature: pageSignature(page), original: blobId(page.original) });
    writtenBySession.set(id, written);
    metaSignatureBySession.set(id, lost > 0 ? "" : metaSignature(session));
    tab.knownRevs.set(id, meta.rev);
    return session;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export type ScanSessionSummary = { id: string; name: string; updatedAt: string; savedAt: string; pageCount: number; thumb: Blob | null };

async function readAllMeta(db: IDBDatabase): Promise<unknown[]> {
  return requestToPromise(db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll());
}

async function deleteSessions(db: IDBDatabase, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const tx = db.transaction([META_STORE, PAGES_STORE, ORIGINALS_STORE], "readwrite");
  for (const id of ids) {
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(PAGES_STORE).delete(sessionRange(id));
    tx.objectStore(ORIGINALS_STORE).delete(sessionRange(id));
  }
  await txDone(tx);
  for (const id of ids) {
    writtenBySession.delete(id);
    metaSignatureBySession.delete(id);
    tab.knownRevs.delete(id);
  }
}

async function removeSession(id: string): Promise<void> {
  if (!isValidScanSessionId(id)) return;
  const real = forks.get(id);
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  try {
    await deleteSessions(db, real ? [id, real] : [id]);
    forks.delete(id);
    announce();
  } catch {
    // Sin permiso o sin base: no hay nada mas que borrar.
  } finally {
    db.close();
  }
}

async function purge(now: number): Promise<number> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return 0;
  }
  try {
    const rows = await readAllMeta(db);
    const expired = rows.filter((row): row is MetaRow => isMetaRow(row) && row.expiresAt <= now).map((row) => row.id);
    await deleteSessions(db, expired);
    if (expired.length > 0) announce();
    return expired.length;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** Sesiones vigentes (sin las caducadas ni las corruptas), de la mas reciente a la mas antigua. Nunca lanza. */
export async function listScanSessionSummaries(now: number = Date.now()): Promise<ScanSessionSummary[]> {
  await purge(now);
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  try {
    const rows = await readAllMeta(db);
    return rows
      .filter(isMetaRow)
      .filter((row) => row.expiresAt > now)
      .map((row) => ({ id: row.id, name: row.name, updatedAt: row.updatedAt, savedAt: row.savedAt, pageCount: row.pageCount, thumb: blobFrom(row.cover, row.coverBytes, row.coverType) }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Borra TODO lo guardado (para «Borrar mis datos»). Nunca lanza. */
export async function clearScanSessions(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  try {
    const tx = db.transaction([META_STORE, PAGES_STORE, ORIGINALS_STORE], "readwrite");
    tx.objectStore(META_STORE).clear();
    tx.objectStore(PAGES_STORE).clear();
    tx.objectStore(ORIGINALS_STORE).clear();
    await txDone(tx);
    writtenBySession.clear();
    metaSignatureBySession.clear();
    forks.clear();
    announce();
  } catch {
    // Nada que borrar.
  } finally {
    db.close();
  }
}

export const scanSessionStore: ScanSessionStore = {
  save: saveSession,
  load: loadSession,
  list: async () => (await listScanSessionSummaries()).map(({ id, name, updatedAt, pageCount, thumb }) => ({ id, name, updatedAt, pageCount, thumb })),
  remove: removeSession,
  purgeExpired: (now) => purge(now ?? Date.now()),
};
