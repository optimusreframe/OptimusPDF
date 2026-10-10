import {
  asBytes,
  editSessionFromJSON,
  editSessionToJSON,
  pendingChangeCount,
  referencedAssets,
  type EditSession,
  type SerializedEditSession,
} from "@/app/edit-pdf/editSession";

/**
 * Borradores locales del editor de PDF (Wave 5 · U3), en IndexedDB.
 *
 * Una base NUEVA, `optimuspdf-edit-drafts`, separada de la de Firmar (sus
 * versiones y migraciones no se tocan entre si). Dos almacenes:
 *  - `draftFiles`: los BYTES. Clave `<id>` = el PDF; `<id>/<assetId>` = una
 *    imagen anadida por la persona (se guardan una sola vez y aparte, para que
 *    el autoguardado, que reescribe los metadatos a cada cambio, no reescriba
 *    megas de PDF/imagenes).
 *  - `draftMeta`: los metadatos y la sesion serializada (sin bytes).
 *
 * UN borrador por documento: su id es la huella SHA-256 del CONTENIDO del PDF
 * (`fingerprintPdfBytes`). Sin `crypto.subtle` no hay huella fiable y el
 * borrador sencillamente no se ofrece (`editDraftsSupported()` = false).
 *
 * El borrador guarda el documento completo y las ediciones EN EL DISPOSITIVO,
 * nunca en un servidor (ver la politica de privacidad y Ajustes -> «Borrar
 * datos locales», que lo vacia con `clearAllEditDrafts`).
 *
 * REGLA DURA igual que `signDrafts.ts`, `recent.ts` y `valueHistory.ts`:
 * ninguna funcion de aqui lanza hacia la interfaz. Modo privado, IndexedDB
 * ausente, cuota agotada, base bloqueada por otra pestana o expulsada por el
 * navegador: todo se devuelve como un resultado tipado (`{ ok: false, reason }`).
 * El autoguardado es prescindible; editar nunca debe bloquearse por el.
 *
 * Presupuesto: `MAX_EDIT_DRAFTS` borradores y `MAX_EDIT_DRAFTS_TOTAL_BYTES`
 * en total; al pasarse se expulsa el mas antiguo (jamas el recien guardado),
 * borrando SIEMPRE los bytes junto a los metadatos y barriendo cualquier
 * archivo huerfano, todo en UNA transaccion.
 */

const DB_NAME = "optimuspdf-edit-drafts";
const DB_VERSION = 1;
const FILES_STORE = "draftFiles";
const META_STORE = "draftMeta";
const BROADCAST_CHANNEL_NAME = "optimuspdf.edit-drafts";

/** Version del formato de los metadatos del borrador. */
export const EDIT_DRAFT_SCHEMA = 1 as const;
/** Borradores totales antes de expulsar el mas antiguo. */
export const MAX_EDIT_DRAFTS = 10;
/** Bytes totales (PDF + imagenes) antes de expulsar el mas antiguo. */
export const MAX_EDIT_DRAFTS_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB
/** Un documento que pesa mas que esto (PDF + imagenes) no se guarda como borrador. */
export const MAX_EDIT_DRAFT_BYTES = 150 * 1024 * 1024; // 150 MB

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Limites vigentes: las constantes de arriba, salvo que un test los acote (evita reservar 300 MB). */
const limits = {
  maxDrafts: MAX_EDIT_DRAFTS,
  maxTotalBytes: MAX_EDIT_DRAFTS_TOTAL_BYTES,
  maxDraftBytes: MAX_EDIT_DRAFT_BYTES,
};

/** Solo para tests: acota los limites; sin argumentos los restaura. */
export function __setEditDraftsLimitsForTests(
  override: Partial<typeof limits> = {},
): void {
  limits.maxDrafts = override.maxDrafts ?? MAX_EDIT_DRAFTS;
  limits.maxTotalBytes = override.maxTotalBytes ?? MAX_EDIT_DRAFTS_TOTAL_BYTES;
  limits.maxDraftBytes = override.maxDraftBytes ?? MAX_EDIT_DRAFT_BYTES;
}

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */

export type EditDraftSummary = {
  schema: typeof EDIT_DRAFT_SCHEMA;
  /** Huella SHA-256 (hex) del contenido del PDF. */
  id: string;
  fileName: string;
  /** Bytes del PDF. */
  fileSize: number;
  /** PDF + imagenes: lo que cuenta para el presupuesto. */
  totalBytes: number;
  /** ISO 8601. */
  savedAt: string;
  pageCount: number | null;
  /** Pagina (0-based) en la que se dejo el trabajo. */
  currentPage: number;
  /** Cambios pendientes (`pendingChangeCount`) al guardar. */
  pendingCount: number;
};

export type EditDraftMeta = EditDraftSummary & {
  /** Sesion serializada SIN bytes de imagen (viven en `draftFiles`). */
  session: SerializedEditSession;
};

export type SaveEditDraftParams = {
  /** Huella del contenido (`fingerprintPdfBytes`). */
  id: string;
  fileName: string;
  /** El PDF original, ya en memoria (la huella se calculo de aqui). */
  fileBytes: Uint8Array;
  session: EditSession;
  pageCount?: number | null;
  currentPage?: number;
  /**
   * Se consulta justo antes de escribir: `false` = este guardado ya lo
   * reemplazo otro mas nuevo (o un borrado) y no debe escribir nada.
   */
  isCurrent?: () => boolean;
};

export type EditDraftFailure =
  | "unsupported" // sin IndexedDB
  | "invalid" // id que no es una huella
  | "tooBig" // supera MAX_EDIT_DRAFT_BYTES
  | "quota" // cuota agotada
  | "superseded" // lo reemplazo un guardado mas nuevo
  | "unavailable"; // bloqueada, lenta o fallo no clasificado

export type SaveEditDraftResult = { ok: true } | { ok: false; reason: EditDraftFailure };

export type LoadedEditDraft = {
  meta: EditDraftSummary;
  bytes: Uint8Array;
  /** Sesion reconstruida (historial vacio). */
  session: EditSession;
  /** Items del borrador que no pasaron la validacion al leerlo. */
  discarded: number;
};

export type LoadEditDraftResult =
  | { ok: true; draft: LoadedEditDraft }
  | { ok: false; reason: "notFound" | "corrupt" | "invalid" | "unsupported" | "unavailable" };

export type DeleteEditDraftResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unavailable" };

export type ClearEditDraftsResult = { ok: true } | { ok: false; reason: "unavailable" };

/* ------------------------------------------------------------------ *
 * Soporte y huella
 * ------------------------------------------------------------------ */

/** Hay IndexedDB y `crypto.subtle`: sin ambos no se ofrece borrador. */
export function editDraftsSupported(): boolean {
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

/**
 * Huella SHA-256 del contenido, o `null` si no se puede calcular (sin
 * `crypto.subtle`, contexto no seguro, fallo): sin huella no hay id fiable y el
 * borrador no se ofrece.
 */
export async function fingerprintPdfBytes(bytes: Uint8Array): Promise<string | null> {
  try {
    const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
    if (!subtle || typeof subtle.digest !== "function") return null;
    const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Avisos entre pestanas
 * ------------------------------------------------------------------ */

/**
 * Claves (`<id>` o `<id>/<assetId>`) cuyos bytes ESTA pestana ya escribio: evita
 * reescribir el PDF en cada autoguardado. Se vacia entera ante cualquier cambio
 * anunciado por otra pestana: como mucho repite una escritura innecesaria, nunca
 * se salta una necesaria.
 */
const writtenKeys = new Set<string>();

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === "undefined") return null;
    if (!channel) {
      channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      channel.addEventListener("message", () => {
        writtenKeys.clear();
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
export function subscribeToEditDrafts(listener: () => void): () => void {
  listeners.add(listener);
  getChannel(); // para recibir avisos de otras pestanas desde ya
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
export function __setEditDraftsBlockedTimeoutForTests(ms: number): void {
  openTimeoutMs = ms;
  blockedTimeoutMs = ms;
}

/**
 * Abre la base con plazo: si otra pestana la mantiene bloqueada (una subida de
 * version futura con una conexion vieja abierta) o tarda demasiado, la
 * operacion se abandona en silencio en vez de quedarse colgada; si la apertura
 * se completa despues, su conexion se cierra sola.
 */
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
    giveUp("la base de borradores del editor tarda demasiado en abrirse", openTimeoutMs);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }
    };
    request.onblocked = () => {
      if (!settled) giveUp("base de borradores del editor bloqueada por otra pestana", blockedTimeoutMs);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Si otra pestana pide subir la version, esta conexion se aparta: nunca bloquea.
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
 * Conexion de vida larga para guardar. Abrir la base es asincrono y un volcado
 * al irse de la pagina no puede esperarlo: con la conexion ya abierta, la
 * transaccion se crea en la misma pasada sincrona del evento. Se aparta sola si
 * otra pestana pide subir la version o el navegador la cierra.
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
export function warmEditDraftsConnection(): Promise<void> {
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
export function __closeWarmEditDraftsConnectionForTests(): void {
  if (warmDb) dropWarm(warmDb);
}

/** Solo para tests: hay una conexion de vida larga abierta. */
export function __hasWarmEditDraftsConnectionForTests(): boolean {
  return warmDb !== null;
}

/** Solo para tests: olvida lo que esta pestana cree haber escrito. */
export function __resetEditDraftsMemoryForTests(): void {
  writtenKeys.clear();
}

/* ------------------------------------------------------------------ *
 * Utilidades de almacen
 * ------------------------------------------------------------------ */

type FileRecord = { id: string; bytes: Uint8Array };

function fileKey(id: string, assetId?: string): string {
  return assetId === undefined ? id : `${id}/${assetId}`;
}

/** Todas las claves de imagen de un borrador (`<id>/...`). */
function assetKeyRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound(`${id}/`, `${id}/\uffff`);
}

function forgetWritten(id: string): void {
  for (const key of [...writtenKeys]) {
    if (key === id || key.startsWith(`${id}/`)) writtenKeys.delete(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Forma minima de un borrador: lo que viene de IndexedDB no se da por bueno. */
export function isEditDraftMeta(value: unknown): value is EditDraftMeta {
  if (!isRecord(value)) return false;
  if (value.schema !== EDIT_DRAFT_SCHEMA) return false;
  if (typeof value.id !== "string" || !FINGERPRINT.test(value.id)) return false;
  if (typeof value.fileName !== "string" || typeof value.savedAt !== "string") return false;
  for (const key of ["fileSize", "totalBytes", "pendingCount", "currentPage"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return false;
  }
  if (value.pageCount !== null && typeof value.pageCount !== "number") return false;
  const session = value.session;
  return (
    isRecord(session) &&
    session.schema === 1 &&
    Array.isArray(session.items) &&
    isRecord(session.assets)
  );
}

function summaryOf(meta: EditDraftMeta): EditDraftSummary {
  return {
    schema: meta.schema,
    id: meta.id,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    totalBytes: meta.totalBytes,
    savedAt: meta.savedAt,
    pageCount: meta.pageCount,
    currentPage: meta.currentPage,
    pendingCount: meta.pendingCount,
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

/** Sello de tiempo estrictamente creciente en esta pestana: ordena sin empates los guardados del mismo milisegundo. */
let lastStamp = 0;
function nextSavedAt(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/* ------------------------------------------------------------------ *
 * Presupuesto y huerfanos
 * ------------------------------------------------------------------ */

/**
 * Expulsa los borradores mas antiguos por encima de `MAX_EDIT_DRAFTS` o
 * `MAX_EDIT_DRAFTS_TOTAL_BYTES`, nunca `protectedId`. Borra los bytes junto con
 * los metadatos y barre todo archivo sin borrador vivo que lo reclame (incluidas
 * imagenes que la sesion ya no usa). Filas corruptas se purgan. UNA transaccion.
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
      const metas = rows.filter(isEditDraftMeta);
      for (const row of rows) {
        if (!isEditDraftMeta(row) && isRecord(row) && typeof row.id === "string") {
          metaStore.delete(row.id);
        }
      }

      const oldestFirst = [...metas].sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      let totalBytes = oldestFirst.reduce((sum, meta) => sum + meta.totalBytes, 0);
      let count = oldestFirst.length;
      const kept = new Map<string, EditDraftMeta>();
      const evicted = new Set<string>();
      for (const meta of oldestFirst) {
        if (
          (count > limits.maxDrafts || totalBytes > limits.maxTotalBytes) &&
          meta.id !== protectedId
        ) {
          evicted.add(meta.id);
          count -= 1;
          totalBytes -= meta.totalBytes;
        } else {
          kept.set(meta.id, meta);
        }
      }
      for (const id of evicted) {
        metaStore.delete(id);
        forgetWritten(id);
      }

      for (const key of keysRequest.result as string[]) {
        const slash = key.indexOf("/");
        const docId = slash < 0 ? key : key.slice(0, slash);
        const meta = kept.get(docId);
        const alive =
          meta !== undefined &&
          (slash < 0 || Object.prototype.hasOwnProperty.call(meta.session.assets, key.slice(slash + 1)));
        if (!alive) {
          filesStore.delete(key);
          writtenKeys.delete(key);
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

type FileToWrite = { key: string; bytes: Uint8Array };

/**
 * Escribe metadatos y archivos nuevos en UNA transaccion. Todas las peticiones
 * se lanzan en la misma pasada sincrona que crea la transaccion (sin leer antes):
 * es lo unico que sobrevive de forma fiable a un `beforeunload`. Si algo lanza
 * (cuota inmediata, cursor invalido) se aborta TODO: nunca quedan metadatos sin bytes.
 */
function writeDraftTx(db: IDBDatabase, meta: EditDraftMeta, files: FileToWrite[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: unknown;
    const written: string[] = [];
    let tx: IDBTransaction;
    try {
      tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      for (const key of written) writtenKeys.add(key);
      resolve();
    };
    tx.onerror = () => {
      // El error de una peticion llega tambien como abort; se resuelve ahi.
      failure ??= tx.error;
    };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("transaccion abortada"));
    try {
      const filesStore = tx.objectStore(FILES_STORE);
      for (const file of files) {
        if (writtenKeys.has(file.key)) continue;
        const record: FileRecord = { id: file.key, bytes: file.bytes };
        filesStore.put(record);
        written.push(file.key);
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

function buildDraft(params: SaveEditDraftParams): {
  meta: EditDraftMeta;
  files: FileToWrite[];
} {
  const assets = referencedAssets(params.session);
  const serialized = editSessionToJSON(params.session, { inlineAssets: false });
  const totalBytes =
    params.fileBytes.byteLength + assets.reduce((sum, a) => sum + a.bytes.byteLength, 0);
  const meta: EditDraftMeta = {
    schema: EDIT_DRAFT_SCHEMA,
    id: params.id,
    fileName: params.fileName,
    fileSize: params.fileBytes.byteLength,
    totalBytes,
    savedAt: nextSavedAt(),
    pageCount: params.pageCount ?? null,
    currentPage: Math.max(0, Math.floor(params.currentPage ?? 0)),
    pendingCount: pendingChangeCount(params.session),
    session: serialized,
  };
  const files: FileToWrite[] = [
    { key: fileKey(params.id), bytes: params.fileBytes },
    ...assets.map((a) => ({ key: fileKey(params.id, a.assetId), bytes: a.bytes })),
  ];
  return { meta, files };
}

/**
 * Guarda (o actualiza) el borrador de un documento. Nunca lanza. Con una
 * conexion ya abierta (`warmEditDraftsConnection`) la transaccion se crea SIN
 * esperar nada, para sobrevivir a un volcado en `beforeunload`.
 */
export async function saveEditDraft(params: SaveEditDraftParams): Promise<SaveEditDraftResult> {
  if (!FINGERPRINT.test(params.id)) return { ok: false, reason: "invalid" };
  if (typeof indexedDB === "undefined" || indexedDB === null) {
    return { ok: false, reason: "unsupported" };
  }
  let built: ReturnType<typeof buildDraft>;
  try {
    built = buildDraft(params);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (built.meta.totalBytes > limits.maxDraftBytes) return { ok: false, reason: "tooBig" };

  // CAMINO RAPIDO: la transaccion nace aqui, en esta pasada sincrona.
  const warm = warmDb;
  if (warm && (!params.isCurrent || params.isCurrent())) {
    try {
      await writeDraftTx(warm, built.meta, built.files);
      try {
        await enforceBudget(warm, params.id);
      } catch {
        // El presupuesto es limpieza: lo guardado ya esta guardado.
      }
      announceChange();
      return { ok: true };
    } catch (error) {
      if (isQuotaError(error)) return { ok: false, reason: "quota" };
      dropWarm(warm); // conexion muerta: se sigue por el camino normal
    }
  }

  try {
    const db = warmDb ?? (await openDb());
    const adopted = db === warmDb || adoptWarm(db);
    try {
      if (params.isCurrent && !params.isCurrent()) return { ok: false, reason: "superseded" };
      await writeDraftTx(db, built.meta, built.files);
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
    // REGLA DURA: nunca interrumpe la edicion.
    return { ok: false, reason: isQuotaError(error) ? "quota" : "unavailable" };
  }
}

/* ------------------------------------------------------------------ *
 * Leer, listar, borrar
 * ------------------------------------------------------------------ */

/** Borradores del mas reciente al mas antiguo (vacio si no hay IndexedDB o falla). */
export async function listEditDrafts(): Promise<EditDraftSummary[]> {
  try {
    const db = await openDb();
    try {
      const rows = await getAllFromStore<unknown>(db, META_STORE);
      return rows
        .filter(isEditDraftMeta)
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
    const filesStore = tx.objectStore(FILES_STORE);
    filesStore.delete(id);
    filesStore.delete(assetKeyRange(id));
    tx.objectStore(META_STORE).delete(id);
  });
}

/**
 * Lee un borrador con el PDF y las imagenes. Si faltan los bytes del PDF
 * (expulsados por otra pestana o por el navegador bajo presion de cuota) el
 * borrador no se puede retomar: se limpia lo que quedaba y se devuelve
 * `corrupt`. Si falta alguna imagen, solo se descartan los items que la usaban.
 */
export async function loadEditDraft(id: string): Promise<LoadEditDraftResult> {
  if (!FINGERPRINT.test(id)) return { ok: false, reason: "invalid" };
  if (typeof indexedDB === "undefined" || indexedDB === null) {
    return { ok: false, reason: "unsupported" };
  }
  try {
    const db = await openDb();
    try {
      const row = await getFromStore<unknown>(db, META_STORE, id);
      if (row === undefined) return { ok: false, reason: "notFound" };
      if (!isEditDraftMeta(row)) {
        await deleteDraftTx(db, id);
        forgetWritten(id);
        return { ok: false, reason: "corrupt" };
      }
      const pdf = await getFromStore<FileRecord>(db, FILES_STORE, fileKey(id));
      const pdfBytes = pdf ? asBytes(pdf.bytes) : null;
      if (!pdfBytes) {
        await deleteDraftTx(db, id);
        forgetWritten(id);
        announceChange();
        return { ok: false, reason: "corrupt" };
      }
      const assetBytes: Record<string, Uint8Array | undefined> = {};
      for (const assetId of Object.keys(row.session.assets)) {
        const record = await getFromStore<FileRecord>(db, FILES_STORE, fileKey(id, assetId));
        const bytes = record ? asBytes(record.bytes) : null;
        if (bytes) assetBytes[assetId] = bytes;
      }
      const restored = editSessionFromJSON(row.session, {
        pageCount: row.pageCount ?? undefined,
        assetBytes,
      });
      return {
        ok: true,
        draft: {
          meta: summaryOf(row),
          bytes: pdfBytes,
          session: restored.session,
          discarded: restored.discarded,
        },
      };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function deleteEditDraft(id: string): Promise<DeleteEditDraftResult> {
  if (!FINGERPRINT.test(id)) return { ok: false, reason: "invalid" };
  if (typeof indexedDB === "undefined" || indexedDB === null) return { ok: true };
  try {
    const db = await openDb();
    try {
      await deleteDraftTx(db, id);
      forgetWritten(id);
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
 * Vacia TODOS los borradores del editor (bytes y metadatos). Async a proposito:
 * quien llama («Borrar datos locales») espera esto antes de afirmar «borrado».
 * Sin IndexedDB no hay nada guardado: `{ ok: true }`. Si la base existe y no se
 * pudo vaciar (bloqueada, cuota...) informa `{ ok: false }`. Nunca lanza.
 */
export async function clearAllEditDrafts(): Promise<ClearEditDraftsResult> {
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
      writtenKeys.clear();
    } finally {
      db.close();
    }
    announceChange();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
