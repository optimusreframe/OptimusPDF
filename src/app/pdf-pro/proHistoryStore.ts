/**
 * Almacen en disco del historial de PDF Pro (Wave 8 · memoria del historial).
 *
 * Los snapshots que salen de la «ventana caliente» del documento de trabajo (`proWorkingDoc`) se VUELCAN aqui
 * (IndexedDB) y se recuperan de forma perezosa al deshacer/rehacer. Es un cache de sesion, no un borrador:
 *
 *  - Una base POR PESTAÑA (`optimuspdf-pro-history-<sesion>`), separada de `optimuspdf-pro-drafts`: borrar la base
 *    entera es la limpieza, asi los borradores no corren ningun riesgo y no hay migracion de esquema que pueda
 *    corromperlos.
 *  - Los snapshots GRANDES (>= `chunkMinBytes`, 4 MB) se guardan TROCEADOS POR CONTENIDO y sin repetir (Wave 9,
 *    `proChunks` + `proChunkRows`): cada trozo de ~48 KB se identifica por su SHA-256 y se escribe una sola vez aunque lo
 *    compartan todos los pasos del historial (los pasos consecutivos de un PDF grande comparten >90 %). Un historial de
 *    31 pasos de 100 MB ocupa ~330 MB en vez de ~3 GB: ya no choca con el techo de cuota de blobs de Chromium
 *    (~1,5 GB, medido en perfiles efimeros) ni escribe 100 MB por paso. Los demas, como `Blob` por trozos de 8 MB.
 *  - (Wave 10) Leerlos en frio es una peticion por trozo (~2100 con 100 MB): la lectura va con una ventana deslizante de
 *    peticiones y, si se le dan los bytes de los snapshots que ya estan en RAM (`get(id, resident)`), copia de ellos los
 *    trozos que comparten (se identifican por hash) y solo pide a disco los distintos (~7 % entre pasos consecutivos).
 *  - Sin fugas: al cerrar el documento se vacia; al desmontar la suite se borra la base; y al arrancar, cada
 *    pestaña borra las bases de sesiones MUERTAS (las reconoce porque su Web Lock ya no lo sostiene nadie).
 *
 * REGLA DURA: nada de aqui lanza hacia el documento sin forma tipada: `put` rechaza con un `Error` (sin IndexedDB,
 * cuota agotada, base bloqueada) y el documento de trabajo degrada con aviso al recorte por bytes de siempre.
 */

import {
  collectChunkGarbage,
  deleteManifest,
  putChunked,
  readChunked,
  type ChunkedRead,
  type ChunkSource,
} from "@/app/pdf-pro/proChunkRows";
import {
  CHUNK_MIN_TOTAL_BYTES,
  peekChunkPlan,
  planChunks,
  rememberChunkPlan,
  shouldChunk,
  type ChunkPlan,
} from "@/app/pdf-pro/proChunks";

export const PRO_HISTORY_DB_PREFIX = "optimuspdf-pro-history-";
const STORE = "snapshots";
const DB_VERSION = 1;

export type ProHistoryStore = {
  /** Guarda los bytes de un snapshot. Rechaza si no se pudo (cuota, base cerrada...). */
  put(id: string, bytes: Uint8Array): Promise<void>;
  /**
   * Bytes guardados, o `null` si no estan (expulsados por el navegador, otra sesion los borro...). Con `resident` (bytes de
   * snapshots que YA estan en RAM) un snapshot troceado se reconstruye copiando de ellos los trozos que comparte (solo se
   * leen de disco los distintos: ~7 % entre pasos consecutivos de un PDF grande) siempre que su plan de trozos ya se haya
   * calculado; los que no lo tengan se ignoran y se lee todo de disco. El resultado es el mismo en los dos casos.
   */
  get(id: string, resident?: readonly Uint8Array[]): Promise<Uint8Array | null>;
  /** Borra esos snapshots (los que no existan se ignoran). Nunca rechaza. */
  remove(ids: readonly string[]): Promise<void>;
  /** Vacia el almacen (documento cerrado). Nunca rechaza. */
  clear(): Promise<void>;
  /** Cierra y BORRA la base de esta sesion. Nunca rechaza. */
  dispose(): Promise<void>;
  /** Nombre de la base (tests y diagnostico). */
  readonly name: string;
};

export type ProHistoryStoreOptions = {
  /** Identificador de sesion (por defecto, aleatorio). */
  sessionId?: string;
  /** Plazo para abrir la base antes de darla por no disponible. */
  openTimeoutMs?: number;
  /**
   * `false` evita guardar como Blob (entornos donde IndexedDB no lo clona). Con `true` (por defecto) el almacen prueba
   * Blob y, si el navegador lo rechaza (Safari en modo privado o con la sesion efimera, y el WebKit de Playwright:
   * la transaccion falla sin error), reintenta ese paso con bytes y no vuelve a usar Blob en esta sesion.
   */
  useBlob?: boolean;
  /**
   * Desde que tamaño un snapshot se guarda TROCEADO por contenido (Wave 9, `proChunks`): solo se escriben los trozos
   * que el almacen no tiene ya, asi un paso de un PDF grande cuesta ~7 % de su peso en vez del 100 %. Por debajo, se
   * guarda entero como siempre. Por defecto `CHUNK_MIN_TOTAL_BYTES`.
   */
  chunkMinBytes?: number;
};

/** Hay IndexedDB en este contexto (jsdom sin `fake-indexeddb`, modo privado antiguo...: no). */
export function proHistoryStoreSupported(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null && typeof indexedDB.open === "function";
  } catch {
    return false;
  }
}

function randomSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Sin crypto: abajo.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Los bytes que vuelven de IndexedDB pueden ser de otro «realm»: se mira la forma, no la clase. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

/**
 * Un snapshot se guarda en TROZOS de `CHUNK_BYTES` (fila `id:n`) mas un manifiesto (fila `id`): construir un Blob
 * de 100 MB de una vez copia 100 MB en el hilo principal (~30 ms) y serializarlo otros ~20 ms; por trozos, con un
 * respiro entre ellos, ninguna tarea del hilo principal pasa de unos pocos ms.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;
type ManifestRow = { id: string; chunks: number; byteLength: number };
type ChunkRow = { id: string; data: Blob | Uint8Array };

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function openDb(name: string, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!proHistoryStoreSupported()) {
      reject(new Error("indexedDB no disponible"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("la base del historial tarda demasiado en abrirse"));
    }, timeoutMs);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name, DB_VERSION);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
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
      reject(request.error ?? new Error("no se pudo abrir la base del historial"));
    };
    request.onblocked = () => {
      // Una base nueva por sesion nunca deberia estar bloqueada; el plazo la da por perdida.
    };
  });
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Sostiene un Web Lock con el nombre de la base mientras viva la pestaña (se suelta solo al morir). */
function holdSessionLock(name: string): () => void {
  let release: (() => void) | null = null;
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks || typeof locks.request !== "function") return () => {};
    void locks
      .request(name, () => new Promise<void>((resolve) => {
        release = resolve;
      }))
      .catch(() => {});
  } catch {
    return () => {};
  }
  return () => release?.();
}

/**
 * Borra las bases de historial de sesiones que ya no existen (pestañas cerradas o caidas). Una base esta «viva» si
 * alguien sostiene su Web Lock; sin `indexedDB.databases()` o sin Web Locks no se toca nada (sin riesgo de borrar
 * la de otra pestaña). Devuelve cuantas se borraron.
 */
export async function purgeStaleProHistoryDatabases(keep: readonly string[] = []): Promise<number> {
  try {
    if (!proHistoryStoreSupported() || typeof indexedDB.databases !== "function") return 0;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks || typeof locks.request !== "function") return 0;
    const names = (await indexedDB.databases())
      .map((info) => info.name)
      .filter((name): name is string => typeof name === "string" && name.startsWith(PRO_HISTORY_DB_PREFIX))
      .filter((name) => !keep.includes(name));
    let purged = 0;
    for (const name of names) {
      await locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) return; // otra pestaña viva la sostiene
        await deleteDb(name);
        purged += 1;
      });
    }
    return purged;
  } catch {
    return 0;
  }
}

/** Crea el almacen de esta sesion, o `null` si no hay IndexedDB. La base se abre al primer uso. */
export function createProHistoryStore(options: ProHistoryStoreOptions = {}): ProHistoryStore | null {
  if (!proHistoryStoreSupported()) return null;
  const name = `${PRO_HISTORY_DB_PREFIX}${options.sessionId ?? randomSessionId()}`;
  const timeoutMs = options.openTimeoutMs ?? 4000;
  /** Se baja a `false` la primera vez que el navegador rechaza un Blob (ver `put`). */
  let blobRows = options.useBlob ?? typeof Blob !== "undefined";
  const chunkMinBytes = options.chunkMinBytes ?? CHUNK_MIN_TOTAL_BYTES;
  let dbPromise: Promise<IDBDatabase> | null = null;
  let disposed = false;
  const releaseLock = holdSessionLock(name);

  const db = (): Promise<IDBDatabase> => {
    if (disposed) return Promise.reject(new Error("almacen del historial cerrado"));
    dbPromise ??= openDb(name, timeoutMs).then((opened) => {
      opened.onversionchange = () => {
        opened.close();
        dbPromise = null;
      };
      opened.onclose = () => {
        dbPromise = null;
      };
      return opened;
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
    return dbPromise;
  };

  const inTx = <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
    db().then(
      (opened) =>
        new Promise<T | undefined>((resolve, reject) => {
          let tx: IDBTransaction;
          try {
            tx = opened.transaction(STORE, mode);
          } catch (error) {
            reject(error);
            return;
          }
          let result: T | undefined;
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error ?? new Error("transaccion fallida"));
          tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
          try {
            const request = body(tx.objectStore(STORE));
            if (request) request.onsuccess = () => (result = request.result);
          } catch (error) {
            reject(error);
            try {
              tx.abort();
            } catch {
              // Ya abortada.
            }
          }
        }),
    );

  /**
   * Como `inTx`, pero para trabajo que ENCADENA peticiones desde sus propios `onsuccess` (los snapshots troceados): la
   * transaccion sigue viva mientras haya peticiones en curso y termina sola. `run` recibe un `fail` para abortarla.
   */
  const inTxChain = (mode: IDBTransactionMode, run: (store: IDBObjectStore, fail: (error: unknown) => void) => void): Promise<void> =>
    db().then(
      (opened) =>
        new Promise<void>((resolve, reject) => {
          let tx: IDBTransaction;
          try {
            tx = opened.transaction(STORE, mode);
          } catch (error) {
            reject(error);
            return;
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("transaccion fallida"));
          tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
          const fail = (error: unknown) => {
            reject(error);
            try {
              tx.abort();
            } catch {
              // Ya abortada.
            }
          };
          try {
            run(tx.objectStore(STORE), fail);
          } catch (error) {
            fail(error);
          }
        }),
    );

  /**
   * Lee un snapshot troceado. Se resuelve cuando `readChunked` termina (todo en su sitio), NO al completarse la
   * transaccion: con copias desde la RAM puede acabar despues, y esperar el `oncomplete` suma un viaje de ida y vuelta.
   * Si la transaccion falla o se aborta antes, rechaza.
   */
  const readChunkedRows = (id: string, sources: readonly ChunkSource[]): Promise<ChunkedRead> =>
    new Promise<ChunkedRead>((resolve, reject) => {
      inTxChain("readonly", (store) => readChunked(store, id, resolve, { sources })).catch(reject);
    });

  return {
    name,
    async put(id, bytes) {
      if (shouldChunk(bytes.byteLength, chunkMinBytes)) {
        let plan: ChunkPlan | null = null;
        try {
          plan = await planChunks(bytes);
        } catch {
          plan = null; // sin SHA-256: se guarda entero
        }
        if (plan && plan.byteLength === bytes.byteLength) {
          if (disposed) throw new Error("almacen del historial cerrado");
          const chunkedPlan = plan;
          await inTxChain("readwrite", (store, fail) => {
            // Un paso con el mismo id que se vuelve a guardar sustituye al anterior (los trozos viejos los barre `remove`).
            putChunked(store, id, bytes, chunkedPlan, () => {}, fail);
          });
          return;
        }
      }
      const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
      const writeRows = async (asBlob: boolean): Promise<void> => {
        const rows: ChunkRow[] = [];
        for (let index = 0; index < chunks; index += 1) {
          const part = bytes.subarray(index * CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * CHUNK_BYTES));
          rows.push({ id: `${id}:${index}`, data: asBlob ? new Blob([part as unknown as BlobPart]) : new Uint8Array(part) });
          if (index + 1 < chunks) await yieldToMain();
        }
        if (disposed) throw new Error("almacen del historial cerrado");
        const manifest: ManifestRow = { id, chunks, byteLength: bytes.byteLength };
        await inTx("readwrite", (store) => {
          for (const row of rows) store.put(row);
          store.put(manifest);
        });
      };
      if (!blobRows) return writeRows(false);
      try {
        await writeRows(true);
      } catch (error) {
        // Sin espacio de verdad o almacen cerrado: no se insiste (el documento de trabajo degrada con aviso).
        if (disposed || (error instanceof DOMException && error.name === "QuotaExceededError")) throw error;
        // Safari en modo privado / sesion efimera rechaza Blob en IndexedDB (la transaccion falla sin error). Con bytes
        // si guarda: se reintenta este paso y los demas ya no prueban Blob.
        blobRows = false;
        await writeRows(false);
      }
    },
    async get(id, resident = []) {
      const sources: ChunkSource[] = [];
      for (const bytes of resident) {
        const plan = peekChunkPlan(bytes);
        if (plan) sources.push({ bytes, plan });
      }
      const chunked = await readChunkedRows(id, sources);
      if (chunked.kind === "ok") {
        // Estos bytes salen de un manifiesto: su plan ya se conoce y no hay que calcularlo para usarlos de origen o volcarlos.
        rememberChunkPlan(chunked.bytes, chunked.plan);
        return chunked.bytes;
      }
      if (chunked.kind === "corrupt") return null;
      const manifest = await inTx<ManifestRow | undefined>("readonly", (store) => store.get(id) as IDBRequest<ManifestRow | undefined>);
      if (!manifest || typeof manifest.chunks !== "number" || typeof manifest.byteLength !== "number") return null;
      const rows = await inTx<ChunkRow[]>("readonly", (store) =>
        store.getAll(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`)) as IDBRequest<ChunkRow[]>,
      );
      if (!rows || rows.length !== manifest.chunks) return null;
      const byIndex = new Map(rows.map((row) => [Number(row.id.slice(id.length + 1)), row]));
      const out = new Uint8Array(manifest.byteLength);
      let offset = 0;
      for (let index = 0; index < manifest.chunks; index += 1) {
        const row = byIndex.get(index);
        if (!row) return null;
        const part = isBlobLike(row.data) ? new Uint8Array(await row.data.arrayBuffer()) : asBytes(row.data);
        if (!part || offset + part.byteLength > out.byteLength) return null;
        out.set(part, offset);
        offset += part.byteLength;
      }
      return offset === manifest.byteLength ? out : null;
    },
    async remove(ids) {
      if (ids.length === 0) return;
      try {
        await inTxChain("readwrite", (store, fail) => {
          for (const id of ids) {
            store.delete(id);
            store.delete(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
            deleteManifest(store, id);
          }
          // Los trozos que ya no nombra ningun manifiesto se borran (un trozo compartido con otro paso se queda).
          collectChunkGarbage(store, () => {}, fail);
        });
      } catch {
        // Limpieza: si falla, `dispose` borra la base entera.
      }
    },
    async clear() {
      try {
        await inTx("readwrite", (store) => {
          store.clear();
        });
      } catch {
        // Idem.
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        const opened = dbPromise ? await dbPromise.catch(() => null) : null;
        opened?.close();
      } catch {
        // Ya cerrada.
      }
      dbPromise = null;
      await deleteDb(name);
      releaseLock();
    },
  };
}
