import type { CaptureMap } from "@/app/sign-pdf/SigningCeremony";
import type {
  DocState,
  SignMode as BlockSignMode,
  SignerBlock,
} from "@/app/sign-pdf/docSet";
import type {
  LegacyMultiStep,
  MultiStep,
  SignMode,
} from "@/app/sign-pdf/SignToolClient";
import type { SignConfigManifest } from "@/app/sign-pdf/signConfig";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { Signer, SignatureField } from "@/lib/pdf/sign";

/**
 * Borradores locales de `/sign-pdf`, auto-guardados en IndexedDB: el PDF
 * completo + todo el estado de la ronda (firmantes, huecos, capturas,
 * valores de texto). Primer uso de IndexedDB en el repo -- por eso, y por
 * guardar el PDF completo + capturas de firma indefinidamente por
 * defecto, este modulo paso por una revision de arquitectura dedicada
 * antes de escribirse (ver PrivacyNotice.tsx para el aviso al usuario).
 *
 * Wave 4 (U5): con VARIOS documentos el borrador es uno POR SESION
 * (`sessionMeta` + `draftFiles` con clave `sessionId/docId`), no uno por
 * documento; la sesion entera cuenta como UN borrador (su tamano es la suma
 * de los PDF). Con UN documento se sigue guardando el formato de siempre
 * (`draftMeta`), y los borradores v1 se siguen leyendo tal cual.
 *
 * REGLA DURA igual que `recent.ts`/`valueHistory.ts`: ninguna funcion de
 * aqui puede lanzar hacia la UI. Modo privado (Safari/Firefox bloquean
 * `indexedDB` por completo), cuota agotada, otra pestaña aun en la version
 * anterior de la base, o el navegador expulsando datos bajo presion de
 * almacenamiento -- todo se traga en silencio. El autoguardado es
 * prescindible; la firma nunca debe bloquearse por el.
 */

export type DraftMeta = {
  id: string;
  fileName: string;
  fileSize: number;
  /** ISO 8601. */
  savedAt: string;
  mode: SignMode;
  signers: Signer[];
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
  /**
   * Paso en el que se dejo el borrador. Al LEER puede venir un valor
   * anterior a W2-A ("fields"/"text"): se normaliza con `migrateStep`
   * en `SignToolClient` al reanudar; al escribir siempre va un paso
   * vigente (`SaveDraftParams.step`). Los datos (huecos, campos, valores)
   * no cambian de formato.
   */
  step: LegacyMultiStep;
  captures: CaptureMap;
  /** Espejo de `SignToolOptions.textFieldsDetectedFor` -- ver ese campo. */
  textFieldsDetectedFor: string | null;
};

/** Un documento de un borrador de sesion (los bytes viven en `draftFiles`). */
export type SessionDocMeta = {
  /** Id del documento DENTRO de la sesion guardada (no es el `DocId` vivo: ese cambia al recargar). */
  id: string;
  fileName: string;
  fileSize: number;
};

/**
 * Borrador de una ronda con VARIOS documentos. `blocks` lleva los trazos y
 * los sellos tal cual; `docStates` el estado de cada documento (huecos,
 * campos, valores...). Todos los ids de documento son los guardados
 * (`SessionDocMeta.id`).
 */
export type SessionDraftMeta = {
  kind: "session";
  id: string;
  /** ISO 8601. */
  savedAt: string;
  /** "Solo yo" / "Varios firmantes" (el borrador solo se guarda en "multi"). */
  mode: SignMode;
  /** "Mismas" o "distintas" firmas por documento. */
  signMode: BlockSignMode;
  signers: Signer[];
  blocks: SignerBlock[];
  /** Documentos en el orden de la cola. */
  documents: SessionDocMeta[];
  docStates: Record<string, DocState>;
  activeDocId: string | null;
  step: LegacyMultiStep;
  /** Suma de los PDF: es lo que cuenta para el presupuesto. */
  fileSize: number;
  /** Nombre del primer documento (resumen para listas simples). */
  fileName: string;
  documentCount: number;
};

/** Lo que muestra la hoja de borradores: un documento suelto (v1) o una sesion. */
export type DraftEntry =
  | { kind: "document"; meta: DraftMeta }
  | { kind: "session"; meta: SessionDraftMeta };

type FileRecord = { id: string; bytes: Uint8Array };

const DB_NAME = "optimuspdf-sign-drafts";
const DB_VERSION = 2;
const FILES_STORE = "draftFiles";
const META_STORE = "draftMeta";
const SESSION_STORE = "sessionMeta";
const BROADCAST_CHANNEL_NAME = "optimuspdf.sign-drafts";

/** Borradores totales (una sesion cuenta como UNO) antes de expulsar el mas antiguo. */
export const MAX_DRAFTS = 10;
/** Bytes totales (PDF + capturas) antes de expulsar el mas antiguo. */
export const MAX_DRAFTS_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB
/** Una sesion que pesa mas que esto no se guarda como borrador. */
export const MAX_SESSION_DRAFT_BYTES = 150 * 1024 * 1024; // 150 MB

/**
 * Ids para los que ya se escribieron los bytes del PDF EN ESTA PESTAÑA:
 * evita una lectura a IndexedDB en cada autoguardado (el debounce puede
 * disparar docenas de veces mientras alguien rellena campos). Se invalida
 * por completo ante cualquier cambio anunciado por otra pestaña (borrado,
 * expulsion por cuota): mas barato que llevar la cuenta exacta, y nunca
 * miente hacia el lado peligroso (como mucho repite una escritura ya
 * innecesaria, nunca se salta una que hace falta). Solo para borradores v1;
 * los de sesion consultan las claves existentes en cada guardado.
 */
const writtenFileIds = new Set<string>();

/**
 * Borradores v1 que ESTA pestaña ha guardado (y no ha borrado). Sirve para
 * retirar el borrador de un documento suelto cuando la ronda pasa a tener
 * varios y su sesion lo sustituye -- sin tocar jamas un borrador del mismo PDF
 * que viniera de otra ronda u otra pestaña.
 */
const savedDraftIdsHere = new Set<string>();

export function wasDraftSavedHere(id: string): boolean {
  return savedDraftIdsHere.has(id);
}

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.addEventListener("message", () => {
      writtenFileIds.clear();
      for (const listener of listeners) listener();
    });
  }
  return channel;
}

function announceChange(): void {
  getChannel()?.postMessage("changed");
  for (const listener of listeners) listener();
}

/** Para que `DraftsSheet` sepa cuando refrescar su lista (incluida otra pestaña). */
export function subscribeToDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ *
 * Apertura de la base (v2) y convivencia con otra pestaña en v1
 * ------------------------------------------------------------------ */

/**
 * Cuanto se espera, como mucho, a que se pueda subir la base a v2. Otra pestaña
 * con la version anterior abierta (y sin cerrarla) bloquea la subida (`blocked`);
 * las demas peticiones de apertura quedan ENCOLADAS detras de la bloqueada y ni
 * siquiera llegan a recibir ese evento, por eso el plazo cuenta desde que se pide
 * la conexion, no desde `blocked`. Pasado el plazo la operacion se abandona en
 * silencio (el autoguardado es prescindible) en vez de quedarse colgada; si la
 * apertura se completa mas tarde, su conexion se cierra sola.
 */
const DEFAULT_OPEN_TIMEOUT_MS = 4000;
const DEFAULT_BLOCKED_TIMEOUT_MS = 2000;
let openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS;
let blockedTimeoutMs = DEFAULT_BLOCKED_TIMEOUT_MS;

/** Solo para tests: acorta los plazos de apertura y de `onblocked`. */
export function __setDraftsBlockedTimeoutForTests(ms: number): void {
  openTimeoutMs = ms;
  blockedTimeoutMs = ms;
}

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
    giveUp("la base de borradores tarda demasiado en abrirse", openTimeoutMs);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Condicional por almacen: sube de v1 (dos almacenes) sin tocar lo que
      // ya hay, y una base recien creada recibe los tres.
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
    };
    // Otra pestaña mantiene abierta la version anterior y no la cierra: se
    // le da un plazo mas corto; si no la cierra, esta operacion se abandona.
    request.onblocked = () => {
      if (!settled) {
        giveUp("base de borradores bloqueada por otra pestaña", blockedTimeoutMs);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Si una pestaña mas nueva pide subir la version, esta conexion se
      // aparta (las nuestras son de vida corta): nunca bloquea a otras.
      db.onversionchange = () => db.close();
      if (timer) clearTimeout(timer);
      if (settled) {
        // La operacion ya se abandono por el plazo: no dejar la conexion abierta.
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
 * Conexion de vida larga SOLO para guardar sesiones. Abrir la base es asincrono
 * y un volcado en `pagehide` no puede esperarlo (la pagina se esta descargando):
 * con la conexion ya abierta, la escritura arranca en la misma pasada sincrona.
 * Se aparta sola si otra pestaña pide subir la version (`onversionchange`) o el
 * navegador la cierra (`onclose`), de modo que nunca bloquea una migracion ni se
 * queda con un manejador muerto.
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

/** Adopta `db` como conexion de vida larga (si no hay otra). Devuelve si quedo adoptada. */
function adoptWarm(db: IDBDatabase): boolean {
  if (warmDb) return false;
  warmDb = db;
  db.onversionchange = () => dropWarm(db);
  db.onclose = () => {
    if (warmDb === db) warmDb = null;
  };
  return true;
}

/**
 * Deja abierta la conexion de guardado de sesiones para que el primer volcado
 * (incluido el de `pagehide`) no tenga que esperar a `openDb`. Idempotente y
 * silencioso: si no se puede abrir, el guardado sigue por el camino normal.
 */
export function warmDraftsConnection(): Promise<void> {
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
export function __closeWarmDraftsConnectionForTests(): void {
  if (warmDb) dropWarm(warmDb);
}

/** Solo para tests: hay una conexion de vida larga abierta. */
export function __hasWarmDraftsConnectionForTests(): boolean {
  return warmDb !== null;
}

function getFromStore<T>(
  db: IDBDatabase,
  storeName: string,
  id: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function getKeysFromStore(
  db: IDBDatabase,
  storeName: string,
  range?: IDBKeyRange,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .getAllKeys(range);
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}

/* ------------------------------------------------------------------ *
 * Borrador de UN documento (formato v1, sin cambios)
 * ------------------------------------------------------------------ */

export type SaveDraftParams = {
  id: string;
  fileBytes: Uint8Array;
  fileName: string;
  manifest: Omit<SignConfigManifest, "version">;
  step: MultiStep;
  captures: CaptureMap;
  textFieldsDetectedFor: string | null;
};

/**
 * Una unica transaccion que abarca ambos almacenes: IndexedDB da
 * atomicidad por transaccion, la unica forma real de garantizar "si hay
 * metadatos, hay bytes" (revision de arquitectura, riesgo de estado a
 * medias tras un fallo de cuota a mitad de guardar). Los bytes del PDF
 * solo se escriben la primera vez que se ve este `id`; los metadatos se
 * reescriben siempre, con la marca de tiempo puesta al vuelo.
 */
function saveDraftTx(db: IDBDatabase, params: SaveDraftParams): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));

    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);

    const putMeta = () => {
      const meta: DraftMeta = {
        id: params.id,
        fileName: params.fileName,
        fileSize: params.fileBytes.byteLength,
        savedAt: new Date().toISOString(),
        mode: params.manifest.mode,
        signers: params.manifest.signers,
        fields: params.manifest.fields,
        textFields: params.manifest.textFields,
        textValues: params.manifest.textValues,
        step: params.step,
        captures: params.captures,
        textFieldsDetectedFor: params.textFieldsDetectedFor,
      };
      metaStore.put(meta);
    };

    if (writtenFileIds.has(params.id)) {
      putMeta();
      return;
    }
    const existing = filesStore.get(params.id);
    existing.onsuccess = () => {
      if (!existing.result) {
        const record: FileRecord = { id: params.id, bytes: params.fileBytes };
        filesStore.put(record);
      }
      writtenFileIds.add(params.id);
      putMeta();
    };
  });
}

/** Clave de los bytes de un documento de una sesion: `sessionId/docId`. */
export function sessionFileKey(sessionId: string, docId: string): string {
  return `${sessionId}/${docId}`;
}

/** Todas las claves de archivo de una sesion (`sessionId/...`). */
function sessionKeyRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${sessionId}/`, `${sessionId}/￿`);
}

/** El id de sesion al que pertenece una clave de archivo, o `null` si es de un borrador v1. */
function sessionIdOfFileKey(key: string): string | null {
  const slash = key.indexOf("/");
  return slash < 0 ? null : key.slice(0, slash);
}

type BudgetEntry = {
  kind: "document" | "session";
  id: string;
  savedAt: string;
  bytes: number;
};

/**
 * Expulsa los borradores mas antiguos por encima de `MAX_DRAFTS` o
 * `MAX_DRAFTS_TOTAL_BYTES` (una sesion cuenta como UN borrador, con la suma de
 * sus PDF como tamano). Nunca expulsa `protectedId` (el que se acaba de
 * guardar: una sesion no puede borrarse a si misma). Borra SIEMPRE los bytes
 * junto con los metadatos -- una sesion expulsada pierde todos sus archivos --
 * y barre cualquier archivo huerfano (sin borrador que lo referencie), de modo
 * que nunca queda nada consumiendo cuota. Todo en UNA transaccion: otra
 * pestaña no puede ver (ni producir) un estado a medias.
 */
function enforceDraftBudget(db: IDBDatabase, protectedId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE, SESSION_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const sessionStore = tx.objectStore(SESSION_STORE);

    const metasRequest = metaStore.getAll();
    const sessionsRequest = sessionStore.getAll();
    const keysRequest = filesStore.getAllKeys();
    let pending = 3;
    const onRead = () => {
      pending -= 1;
      if (pending > 0) return;

      const metas = metasRequest.result as DraftMeta[];
      const sessionRows = sessionsRequest.result as unknown[];
      const sessions = sessionRows.filter(isSessionDraftMeta);
      // Filas corruptas (no pasan la validacion): nadie las puede retomar ni
      // listar y consumirian cuota para siempre. Se purgan; sus archivos
      // `sessionId/*` caen en el barrido de huerfanos de mas abajo.
      for (const row of sessionRows) {
        if (!isSessionDraftMeta(row) && isRecord(row) && typeof row.id === "string") {
          sessionStore.delete(row.id);
        }
      }
      const entries: BudgetEntry[] = [
        ...metas.map<BudgetEntry>((meta) => ({
          kind: "document",
          id: meta.id,
          savedAt: meta.savedAt,
          bytes: meta.fileSize,
        })),
        ...sessions.map<BudgetEntry>((meta) => ({
          kind: "session",
          id: meta.id,
          savedAt: meta.savedAt,
          bytes: meta.fileSize,
        })),
      ];
      const oldestFirst = entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt));

      let totalBytes = oldestFirst.reduce((sum, entry) => sum + entry.bytes, 0);
      let count = oldestFirst.length;
      const evicted = new Set<BudgetEntry>();
      for (const entry of oldestFirst) {
        if (count <= MAX_DRAFTS && totalBytes <= MAX_DRAFTS_TOTAL_BYTES) break;
        if (entry.id === protectedId) continue;
        evicted.add(entry);
        count -= 1;
        totalBytes -= entry.bytes;
      }

      const keptDocuments = new Set<string>();
      const keptSessions = new Set<string>();
      for (const entry of oldestFirst) {
        if (evicted.has(entry)) {
          if (entry.kind === "document") {
            metaStore.delete(entry.id);
            writtenFileIds.delete(entry.id);
          } else {
            sessionStore.delete(entry.id);
          }
        } else if (entry.kind === "document") {
          keptDocuments.add(entry.id);
        } else {
          keptSessions.add(entry.id);
        }
      }

      // Cada archivo se queda solo si hay un borrador vivo que lo reclame.
      for (const key of keysRequest.result as string[]) {
        const sessionId = sessionIdOfFileKey(key);
        const alive =
          sessionId === null ? keptDocuments.has(key) : keptSessions.has(sessionId);
        if (!alive) {
          filesStore.delete(key);
          if (sessionId === null) writtenFileIds.delete(key);
        }
      }
    };
    metasRequest.onsuccess = onRead;
    sessionsRequest.onsuccess = onRead;
    keysRequest.onsuccess = onRead;
  });
}

export async function saveDraft(params: SaveDraftParams): Promise<void> {
  try {
    const db = await openDb();
    try {
      await saveDraftTx(db, params);
      savedDraftIdsHere.add(params.id);
      await enforceDraftBudget(db, params.id);
    } finally {
      db.close();
    }
    announceChange();
  } catch {
    // Ver la nota de "REGLA DURA" arriba: nunca interrumpe la firma.
  }
}

/** Borradores de UN documento (v1), del mas reciente al mas antiguo. Las sesiones: `listSessionDrafts` / `listAllDrafts`. */
export async function listDrafts(): Promise<DraftMeta[]> {
  try {
    const db = await openDb();
    try {
      const metas = await getAllFromStore<DraftMeta>(db, META_STORE);
      return metas.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export type LoadedDraft = { meta: DraftMeta; bytes: Uint8Array };

/**
 * Si los metadatos existen pero los bytes no (expulsados por otra
 * pestaña, o el navegador liberando cuota bajo presion), el borrador no
 * se puede reanudar: se limpia la entrada huerfana en vez de devolver un
 * estado a medias.
 */
export async function loadDraft(id: string): Promise<LoadedDraft | null> {
  try {
    const db = await openDb();
    try {
      const meta = await getFromStore<DraftMeta>(db, META_STORE, id);
      if (!meta) return null;
      const fileRecord = await getFromStore<FileRecord>(db, FILES_STORE, id);
      if (!fileRecord) {
        await deleteDraftTx(db, id);
        return null;
      }
      return { meta, bytes: fileRecord.bytes };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function deleteDraftTx(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(FILES_STORE).delete(id);
    tx.objectStore(META_STORE).delete(id);
  });
}

export async function deleteDraft(id: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await deleteDraftTx(db, id);
      writtenFileIds.delete(id);
      savedDraftIdsHere.delete(id);
    } finally {
      db.close();
    }
    announceChange();
  } catch {
    // Tolerado.
  }
}

/* ------------------------------------------------------------------ *
 * Borrador de SESION (varios documentos)
 * ------------------------------------------------------------------ */

/** Un documento a guardar: sus bytes se leen solo si todavia no estan en la base. */
export type SessionDocInput = {
  /** Id del documento dentro de la sesion guardada (estable entre guardados). */
  id: string;
  fileName: string;
  size: number;
  state: DocState;
  getBytes: () => Promise<Uint8Array>;
};

export type SaveSessionParams = {
  id: string;
  mode: SignMode;
  signMode: BlockSignMode;
  signers: Signer[];
  blocks: SignerBlock[];
  /** En el orden de la cola. */
  documents: SessionDocInput[];
  activeDocId: string | null;
  step: MultiStep;
  /**
   * Se consulta justo antes de escribir (y tras leer los bytes): `false` =
   * este guardado ya lo reemplazo otro mas nuevo (o un borrado) y no debe
   * escribir nada. Evita que un volcado tardio resucite un estado dejado atras.
   */
  isCurrent?: () => boolean;
};

export type SaveSessionResult =
  | { ok: true }
  | { ok: false; reason: "tooBig" | "unavailable" | "superseded" };

/** Los metadatos que se persisten (sin bytes ni funciones). Puro: lo reutilizan los tests. */
export function buildSessionMeta(
  params: SaveSessionParams,
  savedAt: string = new Date().toISOString(),
): SessionDraftMeta {
  const docStates: Record<string, DocState> = {};
  for (const doc of params.documents) docStates[doc.id] = doc.state;
  return {
    kind: "session",
    id: params.id,
    savedAt,
    mode: params.mode,
    signMode: params.signMode,
    signers: params.signers,
    blocks: params.blocks,
    documents: params.documents.map((doc) => ({
      id: doc.id,
      fileName: doc.fileName,
      fileSize: doc.size,
    })),
    docStates,
    activeDocId: params.activeDocId,
    step: params.step,
    fileSize: params.documents.reduce((sum, doc) => sum + doc.size, 0),
    fileName: params.documents[0]?.fileName ?? "",
    documentCount: params.documents.length,
  };
}

/** Suma de bytes de los documentos de la sesion. */
export function sessionBytes(documents: readonly { size: number }[]): number {
  return documents.reduce((sum, doc) => sum + doc.size, 0);
}

type WriteOutcome = "ok" | "retry";

/**
 * Escribe la sesion en UNA transaccion: borra los archivos de documentos que
 * ya no estan, anade los que faltan y reescribe los metadatos. Las claves que
 * existen se leen DENTRO de esta misma transaccion de escritura (no de una
 * lectura anterior): asi, si otra pestaña guardo la misma sesion entre medias,
 * sus archivos sobrantes tambien se borran y no queda ningun huerfano dentro de
 * una sesion viva. Si un archivo que se daba por presente ha desaparecido (otra
 * pestaña lo expulso) aborta TODO y pide reintentar leyendo los bytes de nuevo:
 * nunca quedan metadatos apuntando a bytes que no existen.
 */
function writeSessionTx(
  db: IDBDatabase,
  params: SaveSessionParams,
  loaded: ReadonlyMap<string, Uint8Array>,
): Promise<WriteOutcome> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, SESSION_STORE], "readwrite");
    let needRetry = false;
    tx.oncomplete = () => resolve("ok");
    tx.onerror = () => {
      if (!needRetry) reject(tx.error);
    };
    tx.onabort = () =>
      needRetry ? resolve("retry") : reject(tx.error ?? new Error("transaccion abortada"));

    const filesStore = tx.objectStore(FILES_STORE);
    const sessionStore = tx.objectStore(SESSION_STORE);
    const wanted = new Set(params.documents.map((doc) => sessionFileKey(params.id, doc.id)));

    const current = filesStore.getAllKeys(sessionKeyRange(params.id));
    current.onsuccess = () => {
      const present = new Set(current.result as string[]);
      for (const key of present) {
        if (!wanted.has(key)) filesStore.delete(key);
      }
      for (const key of wanted) {
        const bytes = loaded.get(key);
        if (bytes) {
          const record: FileRecord = { id: key, bytes };
          filesStore.put(record);
        } else if (!present.has(key)) {
          needRetry = true;
          tx.abort();
          return;
        }
      }
      sessionStore.put(buildSessionMeta(params));
    };
  });
}

/**
 * Guarda (o actualiza) el borrador de una sesion. Una sesion que pasa de
 * `MAX_SESSION_DRAFT_BYTES` no se guarda: devuelve `tooBig` para que la
 * interfaz avise con amabilidad (lo ya guardado de esa sesion no se toca).
 * Nunca lanza.
 */
export async function saveSessionDraft(
  params: SaveSessionParams,
): Promise<SaveSessionResult> {
  if (sessionBytes(params.documents) > MAX_SESSION_DRAFT_BYTES) {
    return { ok: false, reason: "tooBig" };
  }

  // CAMINO RAPIDO. Con una conexion ya abierta, la transaccion se CREA aqui, en
  // esta misma pasada sincrona, sin ninguna espera antes: es lo unico que
  // sobrevive de forma fiable a un `pagehide` (durante la descarga de la pagina
  // el navegador mata las promesas pendientes, pero una transaccion ya lanzada
  // al proceso de IndexedDB se completa). Solo reescribe los metadatos y sincroniza
  // la lista de archivos; si falta algun archivo (documento nuevo) aborta sin
  // escribir nada y se sigue por el camino lento, que lee los bytes que falten.
  const warm = warmDb;
  if (warm && (!params.isCurrent || params.isCurrent())) {
    let fast: WriteOutcome | null = null;
    try {
      fast = await writeSessionTx(warm, params, new Map());
    } catch {
      dropWarm(warm);
    }
    if (fast === "ok") {
      try {
        await enforceDraftBudget(warm, params.id);
      } catch {
        // El presupuesto es limpieza: lo guardado ya esta guardado.
      }
      announceChange();
      return { ok: true };
    }
  }

  try {
    const db = warmDb ?? (await openDb());
    const adopted = db === warmDb || adoptWarm(db);
    try {
      let outcome: WriteOutcome = "retry";
      for (let attempt = 0; attempt < 3 && outcome === "retry"; attempt += 1) {
        const existing = new Set(
          await getKeysFromStore(db, FILES_STORE, sessionKeyRange(params.id)),
        );
        const loaded = new Map<string, Uint8Array>();
        for (const doc of params.documents) {
          const key = sessionFileKey(params.id, doc.id);
          // Primer intento: solo lo que falta. Tras un reintento, todo: no
          // se fia de nada de lo que "estaba".
          if (attempt === 0 && existing.has(key)) continue;
          loaded.set(key, await doc.getBytes());
        }
        if (params.isCurrent && !params.isCurrent()) {
          return { ok: false, reason: "superseded" };
        }
        outcome = await writeSessionTx(db, params, loaded);
      }
      if (outcome !== "ok") return { ok: false, reason: "unavailable" };
      await enforceDraftBudget(db, params.id);
    } finally {
      if (!adopted) db.close();
    }
    announceChange();
    return { ok: true };
  } catch {
    // Ver la nota de "REGLA DURA" arriba: nunca interrumpe la firma.
    return { ok: false, reason: "unavailable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Forma minima de un borrador de sesion: lo que viene de IndexedDB no se da por bueno. */
export function isSessionDraftMeta(value: unknown): value is SessionDraftMeta {
  if (!isRecord(value)) return false;
  if (value.kind !== "session") return false;
  if (typeof value.id !== "string" || typeof value.savedAt !== "string") return false;
  if (value.signMode !== "same" && value.signMode !== "independent") return false;
  if (typeof value.step !== "string") return false;
  if (typeof value.fileSize !== "number") return false;
  if (!Array.isArray(value.signers)) return false;
  if (
    !Array.isArray(value.documents) ||
    !value.documents.every(
      (doc) =>
        isRecord(doc) &&
        typeof doc.id === "string" &&
        typeof doc.fileName === "string" &&
        typeof doc.fileSize === "number",
    )
  ) {
    return false;
  }
  if (!isRecord(value.docStates)) return false;
  // Sin `blocks` (un borrador anterior al modelo de bloques) se migra al restaurar.
  if (value.blocks !== undefined) {
    if (
      !Array.isArray(value.blocks) ||
      !value.blocks.every(
        (block) =>
          isRecord(block) &&
          typeof block.id === "string" &&
          typeof block.signerId === "string" &&
          Array.isArray(block.appliesTo) &&
          isRecord(block.stamps),
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function listSessionDrafts(): Promise<SessionDraftMeta[]> {
  try {
    const db = await openDb();
    try {
      const metas = await getAllFromStore<unknown>(db, SESSION_STORE);
      return metas
        .filter(isSessionDraftMeta)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Sesiones y borradores v1 juntos, del mas reciente al mas antiguo. */
export async function listAllDrafts(): Promise<DraftEntry[]> {
  const [documents, sessions] = await Promise.all([
    listDrafts(),
    listSessionDrafts(),
  ]);
  const entries: DraftEntry[] = [
    ...documents.map<DraftEntry>((meta) => ({ kind: "document", meta })),
    ...sessions.map<DraftEntry>((meta) => ({ kind: "session", meta })),
  ];
  return entries.sort((a, b) => b.meta.savedAt.localeCompare(a.meta.savedAt));
}

export type LoadedSessionDraft = {
  meta: SessionDraftMeta;
  /** En el orden de `meta.documents`. */
  files: { id: string; fileName: string; bytes: Uint8Array }[];
};

function deleteSessionTx(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, SESSION_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    tx.objectStore(FILES_STORE).delete(sessionKeyRange(id));
    tx.objectStore(SESSION_STORE).delete(id);
  });
}

/**
 * Lee una sesion con los bytes de TODOS sus documentos. Si falta alguno
 * (expulsado por otra pestaña o por el navegador) la sesion no se puede
 * retomar entera: se limpia lo que quedaba en vez de devolver una ronda con
 * documentos de menos.
 */
export async function loadSessionDraft(
  id: string,
): Promise<LoadedSessionDraft | null> {
  try {
    const db = await openDb();
    try {
      const meta = await getFromStore<unknown>(db, SESSION_STORE, id);
      if (!isSessionDraftMeta(meta)) return null;
      const files: LoadedSessionDraft["files"] = [];
      for (const doc of meta.documents) {
        const record = await getFromStore<FileRecord>(
          db,
          FILES_STORE,
          sessionFileKey(id, doc.id),
        );
        if (!record) {
          await deleteSessionTx(db, id);
          return null;
        }
        files.push({ id: doc.id, fileName: doc.fileName, bytes: record.bytes });
      }
      return { meta, files };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function deleteSessionDraft(id: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await deleteSessionTx(db, id);
    } finally {
      db.close();
    }
    announceChange();
  } catch {
    // Tolerado.
  }
}

/** Borra una entrada de la lista, sea un documento suelto o una sesion. */
export function deleteDraftEntry(entry: DraftEntry): Promise<void> {
  return entry.kind === "session"
    ? deleteSessionDraft(entry.meta.id)
    : deleteDraft(entry.meta.id);
}

export type ClearDraftsResult = { ok: true } | { ok: false; reason: "unavailable" };

/**
 * Async a proposito (a diferencia de `clearValueHistory`, sincrono):
 * IndexedDB es asincrono por naturaleza, y quien llama (`PrivacyNotice`)
 * espera esto antes de afirmar "Datos borrados" -- afirmarlo antes de
 * que la operacion termine mentiria si fallara.
 *
 * Sigue sin lanzar nunca, pero ahora INFORMA: `{ ok: false }` si la base
 * existe y no se pudo vaciar (bloqueada por otra pestaña, cuota...). Sin
 * IndexedDB en el navegador no hay nada guardado que borrar: `{ ok: true }`.
 * Vacia tambien las sesiones (borradores de varios documentos).
 */
export async function clearAllDrafts(): Promise<ClearDraftsResult> {
  if (typeof indexedDB === "undefined" || indexedDB === null) return { ok: true };
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const stores = [FILES_STORE, META_STORE, SESSION_STORE].filter((name) =>
          db.objectStoreNames.contains(name),
        );
        const tx = db.transaction(stores, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
        for (const name of stores) tx.objectStore(name).clear();
      });
      writtenFileIds.clear();
      savedDraftIdsHere.clear();
    } finally {
      db.close();
    }
    announceChange();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
