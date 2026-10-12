import type { ProHistoryNote, ProSnapshotSource } from "@/app/pdf-pro/proTypes";

/**
 * Borradores locales de PDF Pro (Wave 7 · U2), en IndexedDB. Mismo patron que `editDrafts.ts`.
 *
 * Una base propia, `optimuspdf-pro-drafts`, con dos almacenes:
 *  - `draftFiles`: los BYTES del snapshot actual. Clave = id del borrador.
 *  - `draftMeta`: metadatos y el historial LIGERO (etiquetas y fechas, sin bytes).
 *
 * UN borrador por documento: su id es la huella SHA-256 del archivo ORIGINAL que se abrio
 * (`ProDocument.fingerprint`), asi reabrir ese mismo PDF encuentra su borrador. Lo guardado es el
 * PDF tal y como esta AHORA (con los cambios aplicados); el historial anterior no se restaura (solo
 * sus etiquetas, a modo informativo). Los PDF cifrados NO se guardan nunca (lo decide
 * `proDraftAutosave.ts`): un borrador dejaria su contenido sin el cifrado.
 *
 * REGLA DURA: ninguna funcion de aqui lanza hacia la interfaz. Modo privado, IndexedDB ausente, cuota
 * agotada, base bloqueada o expulsada: todo se devuelve como resultado tipado `{ ok: false, reason }`.
 *
 * Presupuesto: `MAX_PRO_DRAFTS` borradores y `MAX_PRO_DRAFTS_TOTAL_BYTES` en total; al pasarse se
 * expulsa el mas antiguo (jamas el recien guardado), borrando los bytes junto a los metadatos, todo
 * en UNA transaccion. Un solo borrador de mas de `MAX_PRO_DRAFT_BYTES` no se guarda.
 */

const DB_NAME = "optimuspdf-pro-drafts";
const DB_VERSION = 1;
const FILES_STORE = "draftFiles";
const META_STORE = "draftMeta";
const BROADCAST_CHANNEL_NAME = "optimuspdf.pro-drafts";

export const PRO_DRAFT_SCHEMA = 1 as const;
export const MAX_PRO_DRAFTS = 10;
export const MAX_PRO_DRAFTS_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB
export const MAX_PRO_DRAFT_BYTES = 150 * 1024 * 1024; // 150 MB

const FINGERPRINT = /^[0-9a-f]{64}$/;

const limits = {
  maxDrafts: MAX_PRO_DRAFTS,
  maxTotalBytes: MAX_PRO_DRAFTS_TOTAL_BYTES,
  maxDraftBytes: MAX_PRO_DRAFT_BYTES,
};

/** Solo para tests: acota los limites; sin argumentos los restaura. */
export function __setProDraftsLimitsForTests(override: Partial<typeof limits> = {}): void {
  limits.maxDrafts = override.maxDrafts ?? MAX_PRO_DRAFTS;
  limits.maxTotalBytes = override.maxTotalBytes ?? MAX_PRO_DRAFTS_TOTAL_BYTES;
  limits.maxDraftBytes = override.maxDraftBytes ?? MAX_PRO_DRAFT_BYTES;
}

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */

export type ProDraftSummary = {
  schema: typeof PRO_DRAFT_SCHEMA;
  /** Huella SHA-256 (hex) del archivo ORIGINAL abierto. */
  id: string;
  fileName: string;
  /** Bytes del PDF guardado (el snapshot actual). */
  fileSize: number;
  /** ISO 8601. */
  savedAt: string;
  pageCount: number | null;
  /** Pagina (0-based) en la que se dejo el trabajo. */
  currentPage: number;
  /** Cambios aplicados (pasos del historial por encima del original). */
  steps: number;
};

export type ProDraftMeta = ProDraftSummary & {
  history: ProHistoryNote[];
};

export type SaveProDraftParams = {
  id: string;
  fileName: string;
  /** Bytes del snapshot actual. */
  bytes: Uint8Array;
  /** Id del snapshot: si ya se escribieron sus bytes desde esta pestana no se reescriben. */
  snapshotId: string;
  history: readonly ProHistoryNote[];
  pageCount?: number | null;
  currentPage?: number;
  /** Se consulta justo antes de escribir: `false` = ya lo reemplazo otro guardado (o un borrado). */
  isCurrent?: () => boolean;
};

export type ProDraftFailure =
  | "unsupported"
  | "invalid"
  | "tooBig"
  | "quota"
  | "superseded"
  | "unavailable";

export type SaveProDraftResult = { ok: true } | { ok: false; reason: ProDraftFailure };

export type LoadedProDraft = {
  meta: ProDraftSummary;
  bytes: Uint8Array;
  history: ProHistoryNote[];
};

export type LoadProDraftResult =
  | { ok: true; draft: LoadedProDraft }
  | { ok: false; reason: "notFound" | "corrupt" | "invalid" | "unsupported" | "unavailable" };

export type DeleteProDraftResult = { ok: true } | { ok: false; reason: "invalid" | "unavailable" };
export type ClearProDraftsResult = { ok: true } | { ok: false; reason: "unavailable" };

/* ------------------------------------------------------------------ *
 * Soporte
 * ------------------------------------------------------------------ */

/** Hay IndexedDB y `crypto.subtle`: sin ambos no se ofrece borrador. */
export function proDraftsSupported(): boolean {
  try {
    return (
      typeof indexedDB !== "undefined" &&
      indexedDB !== null &&
      typeof crypto !== "undefined" &&
      typeof crypto.subtle?.digest === "function"
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Avisos entre pestanas
 * ------------------------------------------------------------------ */

/** id -> snapshot cuyos bytes ESTA pestana ya escribio (evita reescribir megas en cada autoguardado). */
const writtenSnapshots = new Map<string, string>();

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === "undefined") return null;
    if (!channel) {
      channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      channel.addEventListener("message", () => {
        writtenSnapshots.clear();
        for (const listener of listeners) listener();
      });
    }
    return channel;
  } catch {
    return null;
  }
}

function announceChange(): void {
  try {
    getChannel()?.postMessage("changed");
  } catch {
    // Canal cerrado: los oyentes de esta pestana igualmente se avisan.
  }
  for (const listener of listeners) listener();
}

/** Para refrescar una lista de borradores cuando cambian (incluida otra pestana). */
export function subscribeToProDrafts(listener: () => void): () => void {
  listeners.add(listener);
  getChannel();
  return () => {
    listeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ *
 * Apertura de la base
 * ------------------------------------------------------------------ */

const DEFAULT_OPEN_TIMEOUT_MS = 4000;
const DEFAULT_BLOCKED_TIMEOUT_MS = 2000;
let openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS;
let blockedTimeoutMs = DEFAULT_BLOCKED_TIMEOUT_MS;

/** Solo para tests: acorta los plazos de apertura y de `onblocked`. */
export function __setProDraftsBlockedTimeoutForTests(ms: number): void {
  openTimeoutMs = ms;
  blockedTimeoutMs = ms;
}

/** Abre la base con plazo: si otra pestana la bloquea o tarda demasiado, se abandona en silencio. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || indexedDB === null) {
      reject(new Error("indexedDB no disponible"));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const giveUp = (reason: string, delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(reason));
      }, delay);
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    giveUp("la base de borradores de PDF Pro tarda demasiado en abrirse", openTimeoutMs);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) db.createObjectStore(FILES_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "id" });
    };
    request.onblocked = () => {
      if (!settled) giveUp("base de borradores de PDF Pro bloqueada por otra pestana", blockedTimeoutMs);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (timer) clearTimeout(timer);
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(request.error);
    };
  });
}

/**
 * Conexion de vida larga para guardar: un volcado al irse de la pagina no puede esperar a abrir la
 * base; con la conexion ya abierta la transaccion se crea en la misma pasada sincrona del evento.
 */
let warmDb: IDBDatabase | null = null;
let warming: Promise<void> | null = null;

function dropWarm(db: IDBDatabase): void {
  if (warmDb === db) warmDb = null;
  try {
    db.close();
  } catch {
    // Ya cerrada.
  }
}

function adoptWarm(db: IDBDatabase): boolean {
  if (warmDb) return false;
  warmDb = db;
  db.onversionchange = () => dropWarm(db);
  db.onclose = () => {
    if (warmDb === db) warmDb = null;
  };
  return true;
}

/** Deja abierta la conexion de guardado. Idempotente y silenciosa. */
export function warmProDraftsConnection(): Promise<void> {
  if (warmDb) return Promise.resolve();
  warming ??= openDb()
    .then((db) => {
      if (!adoptWarm(db)) db.close();
    })
    .catch(() => {})
    .finally(() => {
      warming = null;
    });
  return warming;
}

/** Solo para tests: cierra y olvida la conexion de vida larga. */
export function __closeWarmProDraftsConnectionForTests(): void {
  if (warmDb) dropWarm(warmDb);
}

/** Solo para tests: hay una conexion de vida larga abierta. */
export function __hasWarmProDraftsConnectionForTests(): boolean {
  return warmDb !== null;
}

/** Solo para tests: olvida lo que esta pestana cree haber escrito. */
export function __resetProDraftsMemoryForTests(): void {
  writtenSnapshots.clear();
}

/* ------------------------------------------------------------------ *
 * Utilidades de almacen
 * ------------------------------------------------------------------ */

type FileRecord = { id: string; bytes: Uint8Array };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SOURCES: readonly ProSnapshotSource[] = ["open", "operation", "mode-apply"];

function isHistoryNote(value: unknown): value is ProHistoryNote {
  if (!isRecord(value)) return false;
  return (
    typeof value.label === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.source === "string" &&
    (SOURCES as readonly string[]).includes(value.source) &&
    (value.opId === undefined || typeof value.opId === "string")
  );
}

/** Forma minima de un borrador: lo que viene de IndexedDB no se da por bueno. */
export function isProDraftMeta(value: unknown): value is ProDraftMeta {
  if (!isRecord(value)) return false;
  if (value.schema !== PRO_DRAFT_SCHEMA) return false;
  if (typeof value.id !== "string" || !FINGERPRINT.test(value.id)) return false;
  if (typeof value.fileName !== "string" || typeof value.savedAt !== "string") return false;
  for (const key of ["fileSize", "currentPage", "steps"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return false;
  }
  if (value.pageCount !== null && typeof value.pageCount !== "number") return false;
  return Array.isArray(value.history) && value.history.every(isHistoryNote);
}

function summaryOf(meta: ProDraftMeta): ProDraftSummary {
  return {
    schema: meta.schema,
    id: meta.id,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    savedAt: meta.savedAt,
    pageCount: meta.pageCount,
    currentPage: meta.currentPage,
    steps: meta.steps,
  };
}

function getFromStore<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || code === 22;
}

/** Sello de tiempo estrictamente creciente en esta pestana. */
let lastStamp = 0;
function nextSavedAt(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/** Los bytes que vuelven de IndexedDB pueden ser de otro «realm» (iframe, entorno de pruebas): se mira la forma. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/* ------------------------------------------------------------------ *
 * Presupuesto
 * ------------------------------------------------------------------ */

/**
 * Expulsa los borradores mas antiguos por encima de los limites, nunca `protectedId`. Borra los bytes
 * junto con los metadatos y barre todo archivo sin borrador vivo. Filas corruptas se purgan.
 */
function enforceBudget(db: IDBDatabase, protectedId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);

    const metasRequest = metaStore.getAll();
    const keysRequest = filesStore.getAllKeys();
    let pending = 2;
    const onRead = () => {
      pending -= 1;
      if (pending > 0) return;

      const rows = metasRequest.result as unknown[];
      const metas = rows.filter(isProDraftMeta);
      for (const row of rows) {
        if (!isProDraftMeta(row) && isRecord(row) && typeof row.id === "string") metaStore.delete(row.id);
      }

      const oldestFirst = [...metas].sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      let totalBytes = oldestFirst.reduce((sum, meta) => sum + meta.fileSize, 0);
      let count = oldestFirst.length;
      const kept = new Set<string>();
      for (const meta of oldestFirst) {
        if ((count > limits.maxDrafts || totalBytes > limits.maxTotalBytes) && meta.id !== protectedId) {
          metaStore.delete(meta.id);
          writtenSnapshots.delete(meta.id);
          count -= 1;
          totalBytes -= meta.fileSize;
        } else {
          kept.add(meta.id);
        }
      }
      for (const key of keysRequest.result as string[]) {
        if (!kept.has(key)) {
          filesStore.delete(key);
          writtenSnapshots.delete(key);
        }
      }
    };
    metasRequest.onsuccess = onRead;
    keysRequest.onsuccess = onRead;
  });
}

/* ------------------------------------------------------------------ *
 * Guardar
 * ------------------------------------------------------------------ */

/**
 * Escribe metadatos y bytes en UNA transaccion, todo en la misma pasada sincrona que la crea (lo
 * unico que sobrevive de forma fiable a un `beforeunload`). Si algo lanza se aborta TODO: nunca
 * quedan metadatos sin bytes.
 */
function writeDraftTx(
  db: IDBDatabase,
  meta: ProDraftMeta,
  bytes: Uint8Array,
  snapshotId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: unknown;
    let wroteBytes = false;
    let tx: IDBTransaction;
    try {
      tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      if (wroteBytes) writtenSnapshots.set(meta.id, snapshotId);
      resolve();
    };
    tx.onerror = () => {
      failure ??= tx.error;
    };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("transaccion abortada"));
    try {
      if (writtenSnapshots.get(meta.id) !== snapshotId) {
        const record: FileRecord = { id: meta.id, bytes };
        tx.objectStore(FILES_STORE).put(record);
        wroteBytes = true;
      }
      tx.objectStore(META_STORE).put(meta);
    } catch (error) {
      failure = error;
      try {
        tx.abort();
      } catch {
        // Ya abortada.
      }
    }
  });
}

function buildMeta(params: SaveProDraftParams): ProDraftMeta {
  const history: ProHistoryNote[] = params.history.map((note) => ({
    label: note.label,
    createdAt: note.createdAt,
    source: note.source,
    ...(note.opId ? { opId: note.opId } : {}),
  }));
  return {
    schema: PRO_DRAFT_SCHEMA,
    id: params.id,
    fileName: params.fileName,
    fileSize: params.bytes.byteLength,
    savedAt: nextSavedAt(),
    pageCount: params.pageCount ?? null,
    currentPage: Math.max(0, Math.floor(params.currentPage ?? 0)),
    steps: Math.max(0, history.length - 1),
    history,
  };
}

/** Guarda (o actualiza) el borrador de un documento. Nunca lanza. */
export async function saveProDraft(params: SaveProDraftParams): Promise<SaveProDraftResult> {
  if (!FINGERPRINT.test(params.id)) return { ok: false, reason: "invalid" };
  if (typeof indexedDB === "undefined" || indexedDB === null) return { ok: false, reason: "unsupported" };
  if (params.bytes.byteLength > limits.maxDraftBytes) return { ok: false, reason: "tooBig" };
  const meta = buildMeta(params);

  // CAMINO RAPIDO: la transaccion nace aqui, en esta pasada sincrona.
  const warm = warmDb;
  if (warm && (!params.isCurrent || params.isCurrent())) {
    try {
      await writeDraftTx(warm, meta, params.bytes, params.snapshotId);
      try {
        await enforceBudget(warm, params.id);
      } catch {
        // El presupuesto es limpieza: lo guardado ya esta guardado.
      }
      announceChange();
      return { ok: true };
    } catch (error) {
      if (isQuotaError(error)) return { ok: false, reason: "quota" };
      dropWarm(warm);
    }
  }

  try {
    const db = warmDb ?? (await openDb());
    const adopted = db === warmDb || adoptWarm(db);
    try {
      if (params.isCurrent && !params.isCurrent()) return { ok: false, reason: "superseded" };
      await writeDraftTx(db, meta, params.bytes, params.snapshotId);
      try {
        await enforceBudget(db, params.id);
      } catch {
        // Ver arriba.
      }
    } finally {
      if (!adopted) db.close();
    }
    announceChange();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? "quota" : "unavailable" };
  }
}

/* ------------------------------------------------------------------ *
 * Leer, listar, borrar
 * ------------------------------------------------------------------ */

/** Borradores del mas reciente al mas antiguo (vacio si no hay IndexedDB o falla). */
export async function listProDrafts(): Promise<ProDraftSummary[]> {
  try {
    const db = await openDb();
    try {
      const rows = await getAllFromStore<unknown>(db, META_STORE);
      return rows
        .filter(isProDraftMeta)
        .map(summaryOf)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function deleteDraftTx(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    tx.objectStore(FILES_STORE).delete(id);
    tx.objectStore(META_STORE).delete(id);
  });
}

/**
 * Lee un borrador con su PDF. Si faltan los bytes (expulsados por otra pestana o por el navegador
 * bajo presion de cuota) el borrador no se puede retomar: se limpia lo que quedaba y se devuelve
 * `corrupt`.
 */
export async function loadProDraft(id: string): Promise<LoadProDraftResult> {
  if (!FINGERPRINT.test(id)) return { ok: false, reason: "invalid" };
  if (typeof indexedDB === "undefined" || indexedDB === null) return { ok: false, reason: "unsupported" };
  try {
    const db = await openDb();
    try {
      const row = await getFromStore<unknown>(db, META_STORE, id);
      if (row === undefined) return { ok: false, reason: "notFound" };
      if (!isProDraftMeta(row)) {
        await deleteDraftTx(db, id);
        writtenSnapshots.delete(id);
        return { ok: false, reason: "corrupt" };
      }
      const record = await getFromStore<FileRecord>(db, FILES_STORE, id);
      const bytes = record ? asBytes(record.bytes) : null;
      if (!bytes || bytes.byteLength === 0) {
        await deleteDraftTx(db, id);
        writtenSnapshots.delete(id);
        announceChange();
        return { ok: false, reason: "corrupt" };
      }
      return { ok: true, draft: { meta: summaryOf(row), bytes, history: row.history } };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function deleteProDraft(id: string): Promise<DeleteProDraftResult> {
  if (!FINGERPRINT.test(id)) return { ok: false, reason: "invalid" };
  if (typeof indexedDB === "undefined" || indexedDB === null) return { ok: true };
  try {
    const db = await openDb();
    try {
      await deleteDraftTx(db, id);
      writtenSnapshots.delete(id);
    } finally {
      db.close();
    }
    announceChange();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Vacia TODOS los borradores de PDF Pro. Async a proposito: quien llama («Borrar datos locales»)
 * espera esto antes de afirmar «borrado». Sin IndexedDB no hay nada guardado: `{ ok: true }`. Si la
 * base existe y no se pudo vaciar (bloqueada, cuota...) informa `{ ok: false }`. Nunca lanza.
 */
export async function clearAllProDrafts(): Promise<ClearProDraftsResult> {
  if (typeof indexedDB === "undefined" || indexedDB === null) return { ok: true };
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
        tx.objectStore(FILES_STORE).clear();
        tx.objectStore(META_STORE).clear();
      });
      writtenSnapshots.clear();
    } finally {
      db.close();
    }
    announceChange();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Vacia los borradores de PDF Pro y devuelve cuales fallaron (lista vacia = todo borrado). */
export async function clearLocalProData(): Promise<"proDrafts"[]> {
  const result = await clearAllProDrafts();
  return result.ok ? [] : ["proDrafts"];
}
