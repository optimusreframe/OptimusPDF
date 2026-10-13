import type { ChunkPlan } from "@/app/pdf-pro/proChunks";

/**
 * Filas de IndexedDB para snapshots TROCEADOS por contenido (Wave 9). Las usan los dos almacenes de PDF Pro
 * (`proDrafts`: el borrador persistente, y `proHistoryStore`: el historial de la sesion) dentro de un almacen de
 * objetos con `keyPath: "id"`:
 *
 *  - `~c:<sha256>` → `{ id, data }`: UN trozo de contenido. Se escribe una sola vez aunque lo compartan muchos
 *    snapshots (y los pasos consecutivos de un PDF grande comparten >90 %).
 *  - `~m:<id>` → `{ id, v: 2, byteLength, hashes, sizes }`: el manifiesto de un snapshot (que trozos, en que orden).
 *
 * Las funciones trabajan DENTRO de una transaccion ya abierta y encadenan sus peticiones desde `onsuccess` (la
 * transaccion sigue viva mientras haya peticiones en curso): asi ningun valor grande se serializa de golpe (como mucho
 * `BATCH_BYTES` por tanda) y todo, trozos nuevos + manifiesto, se confirma o se descarta JUNTO (nunca queda un manifiesto
 * sin sus trozos). El orden importa: el manifiesto se pide el ULTIMO.
 *
 * Recoleccion de basura (`collectChunkGarbage`): marca y barrido sobre todos los manifiestos de ese almacen; un trozo
 * que ningun manifiesto nombra se borra. Es obvia y robusta (sin contadores de referencias que puedan desfasarse).
 */

export const CHUNK_PREFIX = "~c:";
export const MANIFEST_PREFIX = "~m:";
const CHUNK_RANGE_END = "~c;"; // ';' va justo despues de ':'
const MANIFEST_RANGE_END = "~m;";
/** Bytes de trozos NUEVOS que se piden por tanda antes de esperar a que el navegador los acepte. */
const BATCH_BYTES = 8 * 1024 * 1024;
/** Trozos que se leen por tanda (~6 MB): lo leido se copia a su sitio y se suelta antes de pedir mas. */
const READ_BATCH = 128;

export const chunkKey = (hash: string): string => `${CHUNK_PREFIX}${hash}`;
export const manifestKey = (id: string): string => `${MANIFEST_PREFIX}${id}`;
/** Una clave de las que NO son un snapshot entero (trozos o manifiestos): los barridos de otras filas las respetan. */
export const isChunkRowKey = (key: unknown): boolean =>
  typeof key === "string" && (key.startsWith(CHUNK_PREFIX) || key.startsWith(MANIFEST_PREFIX));

export type ChunkManifest = {
  id: string;
  v: 2;
  byteLength: number;
  hashes: string[];
  sizes: number[];
};

function isManifest(value: unknown): value is ChunkManifest {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<ChunkManifest>;
  return (
    row.v === 2 &&
    typeof row.byteLength === "number" &&
    Array.isArray(row.hashes) &&
    Array.isArray(row.sizes) &&
    row.hashes.length === row.sizes.length &&
    row.hashes.every((hash) => typeof hash === "string") &&
    row.sizes.every((size) => typeof size === "number" && size >= 0) &&
    row.sizes.reduce((sum, size) => sum + size, 0) === row.byteLength
  );
}

/** Los bytes que vuelven de IndexedDB pueden ser de otro «realm»: se mira la forma, no la clase. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * Pide escribir los trozos que faltan y el manifiesto de `bytes` (cuyo plan ya esta calculado). `done` se llama cuando
 * TODAS las peticiones estan hechas (la transaccion se confirma sola despues); `fail` si algo lanza (el llamador aborta).
 */
export function putChunked(
  store: IDBObjectStore,
  id: string,
  bytes: Uint8Array,
  plan: ChunkPlan,
  done: () => void,
  fail: (error: unknown) => void,
): void {
  const run = (body: () => void) => {
    try {
      body();
    } catch (error) {
      fail(error);
    }
  };
  const keysRequest = store.getAllKeys(IDBKeyRange.bound(CHUNK_PREFIX, CHUNK_RANGE_END));
  keysRequest.onsuccess = () =>
    run(() => {
      const have = new Set(keysRequest.result as string[]);
      const pending: { hash: string; start: number; length: number }[] = [];
      const queued = new Set<string>();
      let offset = 0;
      for (let index = 0; index < plan.hashes.length; index += 1) {
        const hash = plan.hashes[index];
        const length = plan.sizes[index];
        if (!have.has(chunkKey(hash)) && !queued.has(hash)) {
          queued.add(hash);
          pending.push({ hash, start: offset, length });
        }
        offset += length;
      }
      let next = 0;
      const pump = () =>
        run(() => {
          let issued = 0;
          let last: IDBRequest | null = null;
          while (next < pending.length && issued < BATCH_BYTES) {
            const chunk = pending[next];
            next += 1;
            // Una COPIA propia: clonar una vista de IndexedDB serializaria el buffer ENTERO de `bytes`.
            last = store.put({ id: chunkKey(chunk.hash), data: bytes.slice(chunk.start, chunk.start + chunk.length) });
            issued += chunk.length;
          }
          if (next < pending.length && last) {
            last.onsuccess = pump;
            return;
          }
          const manifest: ChunkManifest = {
            id: manifestKey(id),
            v: 2,
            byteLength: plan.byteLength,
            hashes: [...plan.hashes],
            sizes: [...plan.sizes],
          };
          store.put(manifest);
          done();
        });
      pump();
    });
}

export type ChunkedRead =
  /** No hay manifiesto troceado con ese id. */
  | { kind: "none" }
  /** Hay manifiesto pero falta un trozo, no cuadra una longitud o la fila esta rota. */
  | { kind: "corrupt" }
  | { kind: "ok"; bytes: Uint8Array };

/** Lee un snapshot troceado: el manifiesto y, uno a uno, sus trozos (cada uno se copia y se suelta enseguida). */
export function readChunked(store: IDBObjectStore, id: string, done: (result: ChunkedRead) => void): void {
  const manifestRequest = store.get(manifestKey(id));
  manifestRequest.onsuccess = () => {
    const row: unknown = manifestRequest.result;
    if (row === undefined) {
      done({ kind: "none" });
      return;
    }
    if (!isManifest(row)) {
      done({ kind: "corrupt" });
      return;
    }
    let out: Uint8Array;
    try {
      out = new Uint8Array(row.byteLength);
    } catch {
      done({ kind: "corrupt" });
      return;
    }
    if (row.hashes.length === 0) {
      done({ kind: "ok", bytes: out });
      return;
    }
    // Por tandas: pedir los ~2000 trozos de un PDF de 100 MB de golpe dejaria sus resultados vivos (otra copia entera)
    // hasta que termine la transaccion. Cada tanda se copia a `out` y se suelta antes de pedir la siguiente.
    const hashes = row.hashes;
    const sizes = row.sizes;
    const offsets = new Array<number>(hashes.length);
    let total = 0;
    for (let index = 0; index < hashes.length; index += 1) {
      offsets[index] = total;
      total += sizes[index];
    }
    let next = 0;
    let broken = false;
    const pumpBatch = () => {
      const end = Math.min(hashes.length, next + READ_BATCH);
      if (next >= end) {
        done(broken ? { kind: "corrupt" } : { kind: "ok", bytes: out });
        return;
      }
      let remaining = end - next;
      for (; next < end; next += 1) {
        const index = next;
        const request = store.get(chunkKey(hashes[index]));
        request.onsuccess = () => {
          const part = request.result ? asBytes((request.result as { data?: unknown }).data) : null;
          if (!part || part.byteLength !== sizes[index]) broken = true;
          else out.set(part, offsets[index]);
          remaining -= 1;
          if (remaining === 0) pumpBatch();
        };
      }
    };
    pumpBatch();
  };
}

/** Borra el manifiesto de ese id (los trozos que queden sin nombre los barre `collectChunkGarbage`). */
export function deleteManifest(store: IDBObjectStore, id: string): void {
  store.delete(manifestKey(id));
}

/** Marca y barrido: borra los trozos que ningun manifiesto del almacen nombra. */
export function collectChunkGarbage(store: IDBObjectStore, done: () => void, fail: (error: unknown) => void): void {
  const manifests = store.getAll(IDBKeyRange.bound(MANIFEST_PREFIX, MANIFEST_RANGE_END));
  manifests.onsuccess = () => {
    try {
      const referenced = new Set<string>();
      for (const row of manifests.result as unknown[]) {
        if (!isManifest(row)) {
          // Un manifiesto roto no dice que trozos necesita: ante la duda NO se borra nada (borrar de mas es perder datos).
          done();
          return;
        }
        for (const hash of row.hashes) referenced.add(chunkKey(hash));
      }
      const keys = store.getAllKeys(IDBKeyRange.bound(CHUNK_PREFIX, CHUNK_RANGE_END));
      keys.onsuccess = () => {
        try {
          for (const key of keys.result as string[]) if (!referenced.has(key)) store.delete(key);
          done();
        } catch (error) {
          fail(error);
        }
      };
    } catch (error) {
      fail(error);
    }
  };
}
