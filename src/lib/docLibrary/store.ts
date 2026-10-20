import { noteBackupRelevantChange } from "@/lib/backup/backupReminder";
import { ID_PATTERN, cleanText, isIsoDate, parseDocumentEntry } from "./schema";
import { staleVerdict } from "./templateStale";
import {
  LIBRARY_LIMITS,
  LibraryError,
  type DocumentEntry,
  type Fingerprint,
  type PageSize,
  type TemplateStale,
} from "./types";

/**
 * Almacén de la biblioteca de documentos (Fase 2, U2.1): IndexedDB `optimuspdf-doc-library` (v2), NUNCA `localStorage`.
 *
 *   documents  { id → DocumentEntry }               lo que se lista (sin bytes: listar no carga PDF)
 *   blobs      { documentId → { bytes, byteLength } }  la copia del PDF base
 *   meta       { key → value }                      esquema, última copia de seguridad, estado de la persistencia
 *   templates  { id → StoredTemplate }              (v2, U2.2) plantillas de campos; índice `byDocument` (documentId)
 *
 * Campo aditivo `templateStale` de `documents` (F2-fix): ausente en toda entrada de la v2 ya publicada (= la plantilla está al
 * día). Lo escribe `replaceDocumentBytes` cuando el PDF nuevo ya no coincide con el de la plantilla; no cambia el esquema
 * de IndexedDB (ni la versión, ni almacenes, ni índices): una entrada antigua se lee igual y una nueva se lee, sin ese
 * campo, como una entrada sin aviso.
 *
 * Migración v1 → v2 (U2.2): `onupgradeneeded` SOLO crea el almacén `templates` si falta; no toca ni reescribe ningún dato
 * de `documents`, `blobs` ni `meta` (un navegador con la v1 la recibe tal cual y gana el almacén nuevo). Una pestaña con
 * la v1 abierta se aparta sola (`onversionchange`) para dejar subir la versión.
 *
 * Reglas:
 *  - LECTURAS no lanzan: devuelven `null` / lista vacía (`available: false` si no hay IndexedDB). Una entrada que no
 *    pasa la validación estricta se IGNORA y se cuenta en `skipped` (no rompe la lista).
 *  - ESCRITURAS lanzan `LibraryError` con un `code` estable (`quota`, `tooBig`, `full`, `unavailable`, `notFound`,
 *    `conflict`, `invalid`, `failed`). Cada una es UNA transacción (entrada + bytes juntos): o se guarda todo o nada.
 *  - Concurrencia optimista entre pestañas: cada entrada lleva `rev`. Quien modifica dice qué `rev` leyó
 *    (`expectedRev`); si lo guardado ya es otro, `conflict` y no se pisa nada.
 *  - Sin PII en los mensajes de error ni en los avisos (solo códigos).
 *  - Límites: 50 documentos, 100 MiB por documento, 400 MiB en total (`LIBRARY_LIMITS`).
 */

const DB_NAME = "optimuspdf-doc-library";
const DB_VERSION = 2;
const DOCUMENTS = "documents";
const BLOBS = "blobs";
const META = "meta";
const TEMPLATES = "templates";
/** Nombres de los almacenes (los usa `templates.ts` para sus transacciones). */
export const STORE_NAMES = { documents: DOCUMENTS, blobs: BLOBS, meta: META, templates: TEMPLATES } as const;
/** Esquema del almacén (v2 = con plantillas). */
export const LIBRARY_SCHEMA_VERSION = 2;

/* ------------------------------------------------------------------ *
 * Disponibilidad y apertura
 * ------------------------------------------------------------------ */

export type LibraryStatus =
  | { available: true }
  | { available: false; reason: "noIndexedDB" | "openFailed" };

let openTimeoutMs = 4000;
/** Solo para pruebas. */
export function __setLibraryOpenTimeoutForTests(ms: number): void {
  openTimeoutMs = ms;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let unavailableReason: "noIndexedDB" | "openFailed" | null = null;

function idbFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" || indexedDB === null ? null : indexedDB;
  } catch {
    // Algunos navegadores lanzan al ACCEDER a `indexedDB` (cookies bloqueadas).
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const factory = idbFactory();
  if (!factory) {
    unavailableReason = "noIndexedDB";
    return Promise.reject(new LibraryError("unavailable"));
  }
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LibraryError("unavailable"));
    }, openTimeoutMs);
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      clearTimeout(timer);
      settled = true;
      reject(new LibraryError("unavailable"));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCUMENTS)) db.createObjectStore(DOCUMENTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "documentId" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      // v1 → v2: solo se AÑADE el almacén de plantillas.
      if (!db.objectStoreNames.contains(TEMPLATES)) {
        const templates = db.createObjectStore(TEMPLATES, { keyPath: "id" });
        templates.createIndex("byDocument", "documentId", { unique: false });
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // Otra pestaña (versión más nueva) pide actualizar: se aparta y la próxima operación reabre.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === attempt) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === attempt) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new LibraryError("unavailable"));
    };
    request.onblocked = () => {
      // Una pestaña con otra versión no la cierra: se espera hasta el plazo.
    };
  });
  dbPromise = attempt;
  attempt.catch(() => {
    unavailableReason = unavailableReason ?? "openFailed";
    if (dbPromise === attempt) dbPromise = null;
  });
  return attempt;
}

/** ¿Hay biblioteca? `available: false` con el motivo (p. ej. Safari en modo privado antiguo, sin IndexedDB). */
export async function libraryStatus(): Promise<LibraryStatus> {
  try {
    await openDb();
    return { available: true };
  } catch {
    return { available: false, reason: unavailableReason ?? "openFailed" };
  }
}

/** Solo para pruebas: cierra la conexión y olvida todo el estado en memoria. */
export function __resetLibraryForTests(): void {
  const pending = dbPromise;
  dbPromise = null;
  unavailableReason = null;
  openTimeoutMs = 4000;
  pending?.then((db) => db.close()).catch(() => undefined);
  if (channel) {
    try {
      channel.close();
    } catch {
      // Ya cerrado.
    }
  }
  channel = null;
  signalsReady = false;
  listeners.clear();
}

/* ------------------------------------------------------------------ *
 * Transacciones
 * ------------------------------------------------------------------ */

function toLibraryError(error: unknown): LibraryError {
  if (error instanceof LibraryError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "QuotaExceededError") return new LibraryError("quota");
  if (name === "SecurityError" || name === "InvalidStateError" || name === "VersionError") return new LibraryError("unavailable");
  return new LibraryError("failed");
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Una transacción atómica. `work` solo puede esperar peticiones de ESTA transacción (si espera otra cosa, el navegador
 * la cierra). Si `work` lanza, la transacción se aborta y no queda nada escrito.
 */
export async function run<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDb().catch((error) => {
    throw toLibraryError(error);
  });
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (error) {
      reject(toLibraryError(error));
      return;
    }
    let result: T;
    let failure: unknown = null;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(toLibraryError(failure ?? tx.error));
    tx.onerror = () => undefined; // el aborto se gestiona en `onabort`
    work(tx).then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          // Ya terminada.
        }
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Avisos entre pestañas
 * ------------------------------------------------------------------ */

const CHANNEL_NAME = "optimuspdf-doc-library";
const SIGNAL_STORAGE_KEY = "optimuspdf.doc-library.signal";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let signalsReady = false;

function ensureSignals(): void {
  if (signalsReady) return;
  signalsReady = true;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      // Node (pruebas): que el canal no mantenga vivo el proceso. En navegadores no existe.
      (channel as unknown as { unref?: () => void }).unref?.();
      channel.addEventListener("message", () => notify());
      return;
    } catch {
      channel = null;
    }
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (event) => {
      if (event.key === SIGNAL_STORAGE_KEY && event.newValue) notify();
    });
  }
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Un oyente roto no debe tumbar a los demás.
    }
  }
}

export function announceChange(): void {
  // U4.7: todo cambio de la biblioteca (documento o plantilla, alta, edicion o borrado) cuenta para el recordatorio de respaldo.
  noteBackupRelevantChange(undefined, "library");
  ensureSignals();
  if (channel) {
    try {
      channel.postMessage("changed");
    } catch {
      // Canal cerrado: nadie a quien avisar.
    }
  } else {
    try {
      window.localStorage.setItem(SIGNAL_STORAGE_KEY, JSON.stringify({ n: Math.random() }));
    } catch {
      // Sin localStorage: sin aviso entre pestañas.
    }
  }
  notify();
}

/** Llama a `listener` cuando la biblioteca cambia (en esta u otra pestaña). Devuelve la función para darse de baja. */
export function subscribeToLibrary(listener: () => void): () => void {
  listeners.add(listener);
  ensureSignals();
  return () => {
    listeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ *
 * Lecturas
 * ------------------------------------------------------------------ */

export type SkippedEntry = { id: string; reason: "invalid" };

export type ListResult = {
  /** `false` si no hay IndexedDB: la lista está vacía y la interfaz debe decirlo. */
  available: boolean;
  /** Más reciente primero. */
  documents: DocumentEntry[];
  /** Entradas guardadas que no pasaron la validación (dañadas): se ignoran. */
  skipped: SkippedEntry[];
};

function safeId(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && ID_PATTERN.test(id) ? id : "?";
}

export async function listDocuments(): Promise<ListResult> {
  try {
    const rows = await run([DOCUMENTS], "readonly", (tx) => req(tx.objectStore(DOCUMENTS).getAll() as IDBRequest<unknown[]>));
    const documents: DocumentEntry[] = [];
    const skipped: SkippedEntry[] = [];
    for (const row of rows) {
      const entry = parseDocumentEntry(row);
      if (entry) documents.push(entry);
      else skipped.push({ id: safeId(row), reason: "invalid" });
    }
    documents.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
    return { available: true, documents, skipped };
  } catch {
    return { available: false, documents: [], skipped: [] };
  }
}

export async function getDocument(id: string): Promise<DocumentEntry | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    const row = await run([DOCUMENTS], "readonly", (tx) => req(tx.objectStore(DOCUMENTS).get(id)));
    return parseDocumentEntry(row);
  } catch {
    return null;
  }
}

function toUint8(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/** Los bytes del PDF base, o `null` si no hay copia (o está dañada). Cada llamada devuelve una copia propia. */
export async function getDocumentBytes(id: string): Promise<Uint8Array | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    const record = (await run([BLOBS], "readonly", (tx) => req(tx.objectStore(BLOBS).get(id)))) as
      | { bytes?: unknown; byteLength?: unknown }
      | undefined;
    const bytes = toUint8(record?.bytes);
    if (!bytes || typeof record?.byteLength !== "number" || bytes.length !== record.byteLength) return null;
    // IndexedDB entrega una copia nueva en cada lectura: no hace falta duplicar (hasta 100 MiB).
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Ids de los documentos que tienen una copia del PDF guardada (solo las CLAVES: no lee ningun PDF). `null` si el navegador
 * no deja leer. Lo usa el respaldo para contar, antes de exportar, los documentos cuya copia falta.
 */
export async function listBlobIds(): Promise<Set<string> | null> {
  try {
    const keys = await run([BLOBS], "readonly", (tx) => req(tx.objectStore(BLOBS).getAllKeys() as IDBRequest<IDBValidKey[]>));
    return new Set(keys.filter((key): key is string => typeof key === "string"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Escrituras
 * ------------------------------------------------------------------ */

/** Lo que se guarda; el almacén pone `rev`, `byteLength` y las fechas. */
export type DocumentInput = {
  id: string;
  name: string;
  docType: string;
  fileName: string;
  pageCount: number;
  pageSizes: PageSize[];
  fingerprint: Fingerprint;
  templateIds: string[];
  /** Solo al restaurar una copia: la plantilla del documento estaba desactualizada. En una actualización se conserva la que hubiera. */
  templateStale?: TemplateStale;
  /** La `rev` que quien llama LEYÓ (0 o ausente = documento nuevo). Si lo guardado es otra, `conflict`. */
  expectedRev?: number;
  /** Solo documentos nuevos: conserva esta fecha de creación (al restaurar una copia). */
  createdAt?: string;
};

export type WriteOptions = {
  /** Solo para restaurar/importar: conserva `updatedAt` (y `createdAt`) de la entrada en lugar de la hora actual. */
  updatedAt?: string;
  now?: () => Date;
};

function nowIso(options?: WriteOptions): string {
  return (options?.now?.() ?? new Date()).toISOString();
}

function asBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Lo que se guarda en IndexedDB. La clonación estructurada de una VISTA (`subarray`, un trozo de un buffer mayor)
 * guardaría TODO el buffer: se copia solo si la vista no es el buffer entero; si lo es, se pasa tal cual (se clona una vez).
 */
function exactBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.buffer.byteLength === data.length ? data : data.slice();
}

function checkBytes(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new LibraryError("invalid");
  if (bytes.length > LIBRARY_LIMITS.maxDocumentBytes) throw new LibraryError("tooBig");
}

type RawRow = { id?: unknown; byteLength?: unknown } | undefined;

/** Bytes que ocupan todas las entradas (menos `exceptId`) y cuántas son. Lee los campos tal cual: no valida. */
function usageOf(rows: unknown[], exceptId: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const row of rows as RawRow[]) {
    if (!row || row.id === exceptId) continue;
    count += 1;
    if (typeof row.byteLength === "number" && Number.isFinite(row.byteLength) && row.byteLength > 0) bytes += row.byteLength;
  }
  return { count, bytes };
}

function checkRoom(rows: unknown[], id: string, isNew: boolean, newBytes: number): void {
  const others = usageOf(rows, id);
  if (isNew && others.count >= LIBRARY_LIMITS.maxDocuments) throw new LibraryError("full", "count");
  if (others.bytes + newBytes > LIBRARY_LIMITS.maxTotalBytes) throw new LibraryError("full", "total");
}

/**
 * Guarda (crea o actualiza) un documento y, si se dan, sus bytes. Una sola transacción. Devuelve la entrada guardada
 * (con su nueva `rev`). Sin `bytes` en una actualización se conserva la copia que hubiera.
 */
export async function putDocument(
  input: DocumentInput,
  bytes?: Uint8Array | ArrayBuffer,
  options: WriteOptions = {},
): Promise<DocumentEntry> {
  const data = bytes === undefined ? undefined : asBytes(bytes);
  const expected = input.expectedRev ?? 0;
  if (!Number.isInteger(expected) || expected < 0) throw new LibraryError("invalid");
  if (data) checkBytes(data);
  const now = nowIso(options);
  const draft = {
    id: input.id,
    name: input.name,
    docType: input.docType,
    fileName: input.fileName,
    pageCount: input.pageCount,
    pageSizes: input.pageSizes,
    fingerprint: input.fingerprint,
    createdAt: input.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    templateIds: input.templateIds,
    byteLength: data?.length ?? 0,
    rev: 1,
  };
  if (!parseDocumentEntry(draft)) throw new LibraryError("invalid");
  if (options.updatedAt !== undefined && !isIsoDate(options.updatedAt)) throw new LibraryError("invalid");

  const stored = await run([DOCUMENTS, BLOBS], "readwrite", async (tx) => {
    const documents = tx.objectStore(DOCUMENTS);
    const rows = (await req(documents.getAll() as IDBRequest<unknown[]>)) as unknown[];
    const existing = parseDocumentEntry(rows.find((row) => (row as RawRow)?.id === input.id));
    if (existing ? existing.rev !== expected : expected !== 0) throw new LibraryError("conflict");
    const byteLength = data ? data.length : (existing?.byteLength ?? 0);
    checkRoom(rows, input.id, existing === null, byteLength);
    const templateStale = input.templateStale ?? existing?.templateStale;
    const entry: DocumentEntry = {
      ...draft,
      ...(templateStale ? { templateStale } : {}),
      createdAt: existing?.createdAt ?? draft.createdAt,
      updatedAt: options.updatedAt ?? now,
      byteLength,
      rev: (existing?.rev ?? 0) + 1,
    };
    await req(documents.put(entry));
    if (data) await req(tx.objectStore(BLOBS).put({ documentId: input.id, bytes: exactBytes(data), byteLength: data.length }));
    return entry;
  });
  announceChange();
  return stored;
}

export type DocumentPatch = { name?: string; docType?: string; templateIds?: string[] };

/** Cambia nombre, tipo o plantillas de un documento. Con `expectedRev`, falla con `conflict` si otra pestaña lo cambió. */
export async function updateDocument(
  id: string,
  patch: DocumentPatch,
  options: WriteOptions & { expectedRev?: number } = {},
): Promise<DocumentEntry> {
  if (!ID_PATTERN.test(id)) throw new LibraryError("invalid");
  const now = nowIso(options);
  const stored = await run([DOCUMENTS], "readwrite", async (tx) => {
    const documents = tx.objectStore(DOCUMENTS);
    const existing = parseDocumentEntry(await req(documents.get(id)));
    if (!existing) throw new LibraryError("notFound");
    if (options.expectedRev !== undefined && existing.rev !== options.expectedRev) throw new LibraryError("conflict");
    const next = {
      ...existing,
      name: patch.name ?? existing.name,
      docType: patch.docType ?? existing.docType,
      templateIds: patch.templateIds ?? existing.templateIds,
      updatedAt: now,
      rev: existing.rev + 1,
    };
    if (!parseDocumentEntry(next)) throw new LibraryError("invalid");
    await req(documents.put(next));
    return next;
  });
  announceChange();
  return stored;
}

/** Cambia el nombre (sin espacios sobrantes; no vacío; ≤ 200 caracteres). */
export function renameDocument(id: string, name: string, options: WriteOptions & { expectedRev?: number } = {}): Promise<DocumentEntry> {
  const clean = cleanText(name.trim());
  if (clean === null || clean === "") return Promise.reject(new LibraryError("invalid"));
  return updateDocument(id, { name: clean }, options);
}

export type ReplaceBytesOptions = WriteOptions & {
  expectedRev?: number;
  signal?: AbortSignal;
  /** Para pruebas: sustituye el cálculo de la huella. */
  fingerprinter?: (bytes: Uint8Array, options: { signal?: AbortSignal }) => Promise<Fingerprint>;
  /** Nombre del archivo nuevo (si cambia). */
  fileName?: string;
};

/**
 * Sustituye el PDF base de un documento y RECALCULA su huella, páginas y tamaños (el nombre, el tipo y las plantillas
 * se conservan). La huella se calcula antes de abrir la transacción (pdf.js es asíncrono ajeno a IndexedDB).
 */
export async function replaceDocumentBytes(
  id: string,
  bytes: Uint8Array | ArrayBuffer,
  options: ReplaceBytesOptions = {},
): Promise<DocumentEntry> {
  if (!ID_PATTERN.test(id)) throw new LibraryError("invalid");
  const data = asBytes(bytes);
  checkBytes(data);
  const fingerprinter =
    options.fingerprinter ??
    (async (input: Uint8Array, opts: { signal?: AbortSignal }) => (await import("./fingerprint")).computeFingerprint(input, opts));
  const fingerprint = await fingerprinter(data, { signal: options.signal });
  const now = nowIso(options);
  const stored = await run([DOCUMENTS, BLOBS], "readwrite", async (tx) => {
    const documents = tx.objectStore(DOCUMENTS);
    const rows = (await req(documents.getAll() as IDBRequest<unknown[]>)) as unknown[];
    const existing = parseDocumentEntry(rows.find((row) => (row as RawRow)?.id === id));
    if (!existing) throw new LibraryError("notFound");
    if (options.expectedRev !== undefined && existing.rev !== options.expectedRev) throw new LibraryError("conflict");
    checkRoom(rows, id, false, data.length);
    const fileName = options.fileName === undefined ? existing.fileName : cleanText(options.fileName);
    if (fileName === null) throw new LibraryError("invalid");
    // La plantilla se configuró sobre el PDF de ANTES: si el nuevo ya no coincide queda «desactualizada» (sin tocarla). Se
    // compara siempre con el PDF sobre el que se configuró (`base`), no con el anterior reemplazo: volver a poner el original
    // la deja al día.
    const { templateStale: previousStale, ...withoutStale } = existing;
    let templateStale: TemplateStale | undefined;
    if (existing.templateIds.length > 0) {
      const base = previousStale?.base ?? existing.fingerprint;
      const verdict = staleVerdict(base, fingerprint);
      if (verdict.stale) templateStale = { since: previousStale?.since ?? now, level: verdict.level, percent: verdict.percent, base };
    }
    const next: DocumentEntry = {
      ...withoutStale,
      ...(templateStale ? { templateStale } : {}),
      fileName,
      pageCount: fingerprint.pageCount,
      pageSizes: fingerprint.pageSizes,
      fingerprint,
      byteLength: data.length,
      updatedAt: options.updatedAt ?? now,
      rev: existing.rev + 1,
    };
    if (!parseDocumentEntry(next)) throw new LibraryError("invalid");
    await req(documents.put(next));
    await req(tx.objectStore(BLOBS).put({ documentId: id, bytes: exactBytes(data), byteLength: data.length }));
    return next;
  });
  announceChange();
  return stored;
}

/**
 * «Esta plantilla sigue valiendo» (o la plantilla se acaba de reconfigurar): quita el aviso de «desactualizada». No cambia
 * `updatedAt` (el documento no se mueve en la lista). Sin aviso no escribe nada. `notFound` si el documento ya no existe.
 */
export async function markTemplatesCurrent(id: string, options: { expectedRev?: number } = {}): Promise<DocumentEntry> {
  if (!ID_PATTERN.test(id)) throw new LibraryError("invalid");
  const result = await run([DOCUMENTS], "readwrite", async (tx) => {
    const documents = tx.objectStore(DOCUMENTS);
    const existing = parseDocumentEntry(await req(documents.get(id)));
    if (!existing) throw new LibraryError("notFound");
    if (options.expectedRev !== undefined && existing.rev !== options.expectedRev) throw new LibraryError("conflict");
    if (!existing.templateStale) return { entry: existing, written: false };
    const { templateStale: dropped, ...rest } = existing;
    void dropped;
    const next: DocumentEntry = { ...rest, rev: existing.rev + 1 };
    await req(documents.put(next));
    return { entry: next, written: true };
  });
  if (result.written) announceChange();
  return result.entry;
}

/** Borra el documento y su copia. Devuelve si existía. Con `expectedRev`, `conflict` si otra pestaña lo cambió. */
export async function deleteDocument(id: string, options: { expectedRev?: number } = {}): Promise<boolean> {
  if (!ID_PATTERN.test(id)) throw new LibraryError("invalid");
  const existed = await run([DOCUMENTS, BLOBS, TEMPLATES], "readwrite", async (tx) => {
    const documents = tx.objectStore(DOCUMENTS);
    const raw = await req(documents.get(id));
    if (raw === undefined) return false;
    const existing = parseDocumentEntry(raw);
    if (options.expectedRev !== undefined && existing && existing.rev !== options.expectedRev) throw new LibraryError("conflict");
    await req(documents.delete(id));
    await req(tx.objectStore(BLOBS).delete(id));
    // U2.2: las plantillas del documento NO se borran (son trabajo de la persona): quedan «sin documento» y se pueden
    // reasignar. Se parchea la fila tal cual (sin validarla): si estaba dañada, sigue dañada y se ignora al leer.
    const templates = tx.objectStore(TEMPLATES);
    const rows = (await req(templates.index("byDocument").getAll(id))) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const rev = typeof row.rev === "number" && Number.isFinite(row.rev) ? row.rev : 0;
      await req(templates.put({ ...row, documentId: null, rev: rev + 1, updatedAt: nowIso() }));
    }
    return true;
  });
  if (existed) announceChange();
  return existed;
}

/** Borra TODA la biblioteca (documentos, copias y plantillas; conserva `meta`). Para «Borrar datos». */
export async function clearLibrary(): Promise<void> {
  await run([DOCUMENTS, BLOBS, TEMPLATES], "readwrite", async (tx) => {
    await req(tx.objectStore(DOCUMENTS).clear());
    await req(tx.objectStore(BLOBS).clear());
    await req(tx.objectStore(TEMPLATES).clear());
  });
  announceChange();
}

/* ------------------------------------------------------------------ *
 * Uso y persistencia
 * ------------------------------------------------------------------ */

export type LibraryUsage = {
  available: boolean;
  documents: number;
  /** Bytes de las copias de PDF guardadas. */
  bytes: number;
  limits: { maxDocuments: number; maxDocumentBytes: number; maxTotalBytes: number };
  /** Estimación del navegador (todo el origen), si la da. */
  browser?: { usage: number; quota: number };
};

export async function estimateUsage(): Promise<LibraryUsage> {
  const limits = {
    maxDocuments: LIBRARY_LIMITS.maxDocuments,
    maxDocumentBytes: LIBRARY_LIMITS.maxDocumentBytes,
    maxTotalBytes: LIBRARY_LIMITS.maxTotalBytes,
  };
  const listed = await listDocuments();
  const usage: LibraryUsage = {
    available: listed.available,
    documents: listed.documents.length,
    bytes: listed.documents.reduce((sum, entry) => sum + entry.byteLength, 0),
    limits,
  };
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate && typeof estimate.usage === "number" && typeof estimate.quota === "number") {
      usage.browser = { usage: estimate.usage, quota: estimate.quota };
    }
  } catch {
    // Sin estimación: se omite.
  }
  return usage;
}

export type PersistenceState = {
  /** El navegador concedió almacenamiento persistente. */
  granted: boolean;
  /** El navegador ofrece `navigator.storage.persist`. */
  supported: boolean;
};

export type LibraryMeta = {
  schema: number;
  /** ISO 8601 de la última copia de seguridad (.zip) hecha, o `null`. */
  lastBackupAt: string | null;
  /** Lo último que dijo `requestPersistence` (o `null` si nunca se pidió). */
  persistence: (PersistenceState & { checkedAt: string }) | null;
};

async function readMeta<T>(key: string): Promise<T | undefined> {
  const row = (await run([META], "readonly", (tx) => req(tx.objectStore(META).get(key)))) as { value?: T } | undefined;
  return row?.value;
}

async function writeMeta(key: string, value: unknown): Promise<void> {
  await run([META], "readwrite", async (tx) => {
    await req(tx.objectStore(META).put({ key, value }));
  });
}

export async function getLibraryMeta(): Promise<LibraryMeta> {
  const empty: LibraryMeta = { schema: LIBRARY_SCHEMA_VERSION, lastBackupAt: null, persistence: null };
  try {
    const lastBackupAt = await readMeta<unknown>("lastBackupAt");
    const persistence = await readMeta<unknown>("persistence");
    const p = persistence as { granted?: unknown; supported?: unknown; checkedAt?: unknown } | null | undefined;
    return {
      schema: LIBRARY_SCHEMA_VERSION,
      lastBackupAt: isIsoDate(lastBackupAt) ? lastBackupAt : null,
      persistence:
        p && typeof p.granted === "boolean" && typeof p.supported === "boolean" && isIsoDate(p.checkedAt)
          ? { granted: p.granted, supported: p.supported, checkedAt: p.checkedAt }
          : null,
    };
  } catch {
    return empty;
  }
}

/** Anota que se hizo una copia de seguridad ahora (o en `at`). */
export async function markBackup(at: Date = new Date()): Promise<void> {
  await writeMeta("lastBackupAt", at.toISOString());
}

/**
 * Pide al navegador que NO borre estos datos bajo presión de almacenamiento (`navigator.storage.persist()`), y lo
 * recuerda en `meta` para mostrarlo en Ajustes. No promete nada: Safari/iPadOS puede negarla. Nunca lanza.
 */
export async function requestPersistence(): Promise<PersistenceState> {
  let result: PersistenceState = { granted: false, supported: false };
  try {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    if (storage && typeof storage.persist === "function") {
      let granted = false;
      try {
        granted = typeof storage.persisted === "function" && (await storage.persisted()) ? true : await storage.persist();
      } catch {
        granted = false;
      }
      result = { granted: granted === true, supported: true };
    }
  } catch {
    result = { granted: false, supported: false };
  }
  try {
    await writeMeta("persistence", { ...result, checkedAt: new Date().toISOString() });
  } catch {
    // Sin almacén: el resultado se devuelve igualmente.
  }
  return result;
}

