import { chunkIndexOf, yieldToMain, type ChunkIndex, type ChunkPlan } from "@/app/pdf-pro/proChunks";

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
 * Lectura (`readChunked`, Wave 10): un buffer del tamaño final reservado una vez; los trozos que YA tiene un snapshot
 * residente (se conoce su plan) se copian de la RAM por hash (nunca por posicion) y los demas se piden a IndexedDB con una
 * ventana deslizante de peticiones. Entre dos pasos consecutivos de un PDF grande solo cambia ~7 % de los trozos.
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
/**
 * Peticiones de lectura en vuelo a la vez (~3 MB como mucho). Ventana DESLIZANTE: cada trozo que llega pide el siguiente,
 * asi la cola de IndexedDB nunca se vacia (con tandas fijas de 128 hay un hueco entre tanda y tanda; medido con 100 MB:
 * 94 ms por tandas frente a 51 ms con ventana) y lo leido se copia a su sitio y se suelta sin acumular una copia entera.
 */
const READ_WINDOW = 64;
/** Tiempo maximo seguido copiando desde la RAM antes de ceder el hilo (ms) y tamaño maximo de una copia (bytes). */
let copySliceMs = 6;
let copyPieceBytes = 8 * 1024 * 1024;

/** Solo para pruebas: con `0` ms y piezas pequeñas CADA copia cede el hilo (recorre el camino asincrono con pocos datos). */
export function __setCopySliceForTests(ms: number | null, pieceBytes: number | null = null): void {
  copySliceMs = ms ?? 6;
  copyPieceBytes = pieceBytes ?? 8 * 1024 * 1024;
}

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

/** Un snapshot ya en RAM cuyo plan de trozos se conoce: sus trozos no hace falta volver a leerlos de disco. */
export type ChunkSource = { bytes: Uint8Array; plan: ChunkPlan };

export type ChunkedRead =
  /** No hay manifiesto troceado con ese id. */
  | { kind: "none" }
  /** Hay manifiesto pero falta un trozo, no cuadra una longitud o la fila esta rota. */
  | { kind: "corrupt" }
  | {
      kind: "ok";
      bytes: Uint8Array;
      /** El plan del manifiesto (los bytes se identificaron trozo a trozo por su SHA-256 al escribirse). */
      plan: ChunkPlan;
      /** Bytes copiados de snapshots residentes (`sources`) en lugar de leerse de disco. */
      reusedBytes: number;
      /** Filas de trozos pedidas a IndexedDB. */
      readChunks: number;
    };

type CopyRun = { source: Uint8Array; from: number; to: number; length: number };
type SourceEntry = { source: ChunkSource; index: ChunkIndex };
type ActiveRun = CopyRun & { entry: SourceEntry };

/**
 * Reparte los trozos del manifiesto entre «ya esta en RAM» (copias, con los trozos contiguos juntos en UNA copia) y
 * «hay que leerlo de disco». Un trozo se reutiliza solo si un origen tiene el MISMO hash (mismo contenido) y la misma
 * longitud: nunca por posicion ni por tamaño.
 */
function planReuse(
  hashes: readonly string[],
  sizes: readonly number[],
  offsets: readonly number[],
  sources: readonly ChunkSource[],
): { runs: CopyRun[]; missing: number[]; reusedBytes: number } {
  const usable: SourceEntry[] = sources
    .filter((source) => source.bytes.byteLength === source.plan.byteLength)
    .map((source) => ({ source, index: chunkIndexOf(source.plan) }));
  const runs: CopyRun[] = [];
  const missing: number[] = [];
  let reusedBytes = 0;
  let run: ActiveRun | null = null;
  for (let position = 0; position < hashes.length; position += 1) {
    const hash = hashes[position];
    const size = sizes[position];
    let hit: { entry: SourceEntry; at: number } | null = null;
    // Preferir el origen del tramo en curso si sigue siendo contiguo (menos copias, mas largas).
    if (run) {
      const found: number | undefined = run.entry.index.firstByHash.get(hash);
      if (found !== undefined && run.entry.source.plan.sizes[found] === size && run.entry.index.offsets[found] === run.from + run.length) {
        hit = { entry: run.entry, at: found };
      }
    }
    if (!hit) {
      for (const entry of usable) {
        const found: number | undefined = entry.index.firstByHash.get(hash);
        if (found !== undefined && entry.source.plan.sizes[found] === size) {
          hit = { entry, at: found };
          break;
        }
      }
    }
    if (!hit) {
      if (run) runs.push(run);
      run = null;
      missing.push(position);
      continue;
    }
    const from: number = hit.entry.index.offsets[hit.at];
    if (run && run.entry === hit.entry && run.from + run.length === from && run.to + run.length === offsets[position]) {
      run.length += size;
    } else {
      if (run) runs.push(run);
      run = { entry: hit.entry, source: hit.entry.source.bytes, from, to: offsets[position], length: size };
    }
    reusedBytes += size;
  }
  if (run) runs.push(run);
  return { runs, missing, reusedBytes };
}

/**
 * Copia las tiradas desde la RAM al buffer de salida cediendo el hilo cada ~6 ms (una copia nunca pasa de 8 MB): leer
 * de disco el resto sigue mientras tanto. Sin nada que ceder, termina en el acto (sincrono). `done(false)` si una copia
 * falla (por ejemplo, unos bytes transferidos entretanto): el snapshot no se da por bueno.
 */
function copyRuns(runs: readonly CopyRun[], out: Uint8Array, done: (ok: boolean) => void): void {
  let runIndex = 0;
  let inside = 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const step = () => {
    const started = now();
    try {
      while (runIndex < runs.length) {
        const run = runs[runIndex];
        const piece = Math.min(copyPieceBytes, run.length - inside);
        out.set(run.source.subarray(run.from + inside, run.from + inside + piece), run.to + inside);
        inside += piece;
        if (inside >= run.length) {
          runIndex += 1;
          inside = 0;
        }
        if (runIndex < runs.length && now() - started > copySliceMs) {
          void yieldToMain().then(step);
          return;
        }
      }
    } catch {
      done(false);
      return;
    }
    done(true);
  };
  step();
}

/** Lee de disco los trozos `missing` con una ventana deslizante de `READ_WINDOW` peticiones y los copia a su sitio. */
function readMissing(
  store: IDBObjectStore,
  hashes: readonly string[],
  sizes: readonly number[],
  offsets: readonly number[],
  missing: readonly number[],
  out: Uint8Array,
  broken: () => void,
  done: () => void,
): void {
  if (missing.length === 0) {
    done();
    return;
  }
  let next = 0;
  let inFlight = 0;
  let finished = 0;
  const pump = () => {
    while (inFlight < READ_WINDOW && next < missing.length) {
      const index = missing[next];
      next += 1;
      inFlight += 1;
      const request = store.get(chunkKey(hashes[index]));
      request.onsuccess = () => {
        const part = request.result ? asBytes((request.result as { data?: unknown }).data) : null;
        if (!part || part.byteLength !== sizes[index]) broken();
        else out.set(part, offsets[index]);
        inFlight -= 1;
        finished += 1;
        if (finished === missing.length) done();
        else pump();
      };
    }
  };
  pump();
}

/**
 * Lee un snapshot troceado: el manifiesto y sus trozos, a un buffer del tamaño final reservado una vez (sin
 * concatenaciones intermedias). Con `sources` (snapshots ya residentes cuyo plan se conoce) los trozos que ya tienen se
 * COPIAN de la RAM y solo se leen de disco los que no: dos pasos consecutivos de un PDF grande comparten >90 % de los
 * trozos, asi un deshacer/rehacer en frio lee ~7 % y no el 100 %.
 *
 * `done` se llama cuando todo esta en su sitio; con copias desde la RAM puede ser DESPUES de que la transaccion termine
 * (por eso el llamador no debe esperar a `oncomplete`).
 */
export function readChunked(
  store: IDBObjectStore,
  id: string,
  done: (result: ChunkedRead) => void,
  options: { sources?: readonly ChunkSource[] } = {},
): void {
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
    const plan: ChunkPlan = { byteLength: row.byteLength, hashes: row.hashes, sizes: row.sizes };
    if (row.hashes.length === 0) {
      done({ kind: "ok", bytes: out, plan, reusedBytes: 0, readChunks: 0 });
      return;
    }
    const { offsets } = chunkIndexOf(plan);
    const { runs, missing, reusedBytes } = planReuse(row.hashes, row.sizes, offsets, options.sources ?? []);
    let broken = false;
    let pending = 2;
    const part = () => {
      pending -= 1;
      if (pending === 0) {
        done(broken ? { kind: "corrupt" } : { kind: "ok", bytes: out, plan, reusedBytes, readChunks: missing.length });
      }
    };
    // Primero se piden los trozos de disco (corren en paralelo) y mientras tanto se copia lo que ya esta en RAM.
    readMissing(store, row.hashes, row.sizes, offsets, missing, out, () => (broken = true), part);
    copyRuns(runs, out, (ok) => {
      if (!ok) broken = true;
      part();
    });
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
