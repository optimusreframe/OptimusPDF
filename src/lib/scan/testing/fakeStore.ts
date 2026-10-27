/**
 * ALMACEN FALSO de sesiones del Escaner (solo pruebas): implementa `ScanSessionStore`.
 *
 *  - `backend: "memory"` (por defecto en Vitest): un `Map`; no sobrevive a la pagina.
 *  - `backend: "indexeddb"`: IndexedDB propio (`optimuspdf-scan-fake`, NUNCA el de produccion) para que "recarga la pagina y
 *    retoma" se pruebe de verdad en Playwright. Con `fake-indexeddb` tambien sirve en jsdom.
 *
 * Simula cuota (`quotaBytes`), indisponibilidad y latencia, y cuenta las llamadas.
 */
import type { ScanSession, ScanSessionStore } from "@/lib/scan/types";

export type FakeStoreOptions = {
  backend?: "memory" | "indexeddb";
  /** Suma maxima de bytes de originales de TODAS las sesiones; al pasarse, `save` devuelve `quota`. */
  quotaBytes?: number;
  latencyMs?: number;
};

export type FakeStoreControls = {
  quotaBytes: number | null;
  /** `save` devuelve `unavailable` mientras sea `true`. */
  unavailable: boolean;
  /** `save` devuelve `tooBig` mientras sea `true`. */
  tooBig: boolean;
  /** El proximo `save` se guarda con ESTE id y responde `forkedAs` (otra pestana modifico antes la sesion); despues se borra. */
  forkNext: string | null;
  latencyMs: number;
  /** Lo que se pidio guardar (ids de sesion, numero de paginas) en orden. */
  saveLog: Array<{ id: string; pages: number; at: number }>;
  calls: Record<string, number>;
};

export type FakeStore = ScanSessionStore & { controls: FakeStoreControls };

const DB_NAME = "optimuspdf-scan-fake";
const STORE = "sessions";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function bytesOf(session: ScanSession): number {
  let total = 0;
  for (const page of session.pages) total += page.original.size;
  return total;
}

/*
 * WebKit en un contexto efimero (Playwright, modo privado) no deja guardar `Blob` en IndexedDB («Error preparing Blob/File
 * data»). El almacen falso guarda los bytes como `ArrayBuffer` y reconstruye los `Blob` al leer: asi la recarga se prueba igual
 * en los dos motores. (El almacen real tiene que decidir lo suyo para el modo privado de Safari: se anota en el informe.)
 */
type PackedBlob = { __blob: true; type: string; name: string | null; data: ArrayBuffer };

async function pack(blob: Blob | null | undefined): Promise<PackedBlob | null> {
  if (!blob) return null;
  return { __blob: true, type: blob.type, name: typeof (blob as File).name === "string" ? (blob as File).name : null, data: await blob.arrayBuffer() };
}

function unpack(value: unknown): Blob | null {
  if (!value || typeof value !== "object" || !(value as PackedBlob).__blob) return (value as Blob | null) ?? null;
  const packed = value as PackedBlob;
  return packed.name !== null ? new File([packed.data], packed.name, { type: packed.type }) : new Blob([packed.data], { type: packed.type });
}

async function packSession(session: ScanSession): Promise<unknown> {
  const pages = await Promise.all(session.pages.map(async (page) => ({ ...page, original: await pack(page.original), processed: await pack(page.processed), thumb: await pack(page.thumb) })));
  return { ...session, pages };
}

function unpackSession(record: unknown): ScanSession {
  const session = record as ScanSession & { pages: Array<Record<string, unknown>> };
  return { ...session, pages: session.pages.map((page) => ({ ...page, original: unpack(page.original) as Blob, processed: unpack(page.processed), thumb: unpack(page.thumb) })) } as ScanSession;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createFakeStore(options: FakeStoreOptions = {}): FakeStore {
  const controls: FakeStoreControls = {
    quotaBytes: options.quotaBytes ?? null,
    unavailable: false,
    tooBig: false,
    forkNext: null,
    latencyMs: options.latencyMs ?? 0,
    saveLog: [],
    calls: {},
  };
  const memory = new Map<string, ScanSession>();
  const useIdb = options.backend === "indexeddb";
  const call = (name: string) => {
    controls.calls[name] = (controls.calls[name] ?? 0) + 1;
  };
  const pause = () => (controls.latencyMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, controls.latencyMs)) : Promise.resolve());

  async function readAll(): Promise<ScanSession[]> {
    if (!useIdb) return Array.from(memory.values());
    const db = await openDb();
    try {
      return (await request(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<unknown[]>)).map(unpackSession);
    } finally {
      db.close();
    }
  }

  async function write(session: ScanSession): Promise<void> {
    if (!useIdb) {
      memory.set(session.id, session);
      return;
    }
    const record = await packSession(session);
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    controls,

    async save(session) {
      call("save");
      await pause();
      controls.saveLog.push({ id: session.id, pages: session.pages.length, at: Date.now() });
      if (controls.unavailable) return { ok: false, reason: "unavailable" };
      if (controls.tooBig) return { ok: false, reason: "tooBig" };
      if (controls.quotaBytes !== null) {
        const others = (await readAll()).filter((other) => other.id !== session.id);
        const total = others.reduce((sum, other) => sum + bytesOf(other), 0) + bytesOf(session);
        if (total > controls.quotaBytes) return { ok: false, reason: "quota" };
      }
      try {
        if (controls.forkNext) {
          const forkedAs = controls.forkNext;
          controls.forkNext = null;
          await write({ ...session, id: forkedAs, updatedAt: new Date().toISOString() });
          return { ok: true, forkedAs } as Awaited<ReturnType<ScanSessionStore["save"]>>;
        }
        await write({ ...session, updatedAt: new Date().toISOString() });
        return { ok: true };
      } catch {
        return { ok: false, reason: "quota" };
      }
    },

    async load(id) {
      call("load");
      await pause();
      const found = (await readAll()).find((session) => session.id === id);
      return found ?? null;
    },

    async list() {
      call("list");
      await pause();
      return (await readAll())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((session) => ({
          id: session.id,
          name: session.name,
          updatedAt: session.updatedAt,
          pageCount: session.pages.length,
          thumb: session.pages[0]?.thumb ?? session.pages[0]?.original ?? null,
        }));
    },

    async remove(id) {
      call("remove");
      await pause();
      if (!useIdb) {
        memory.delete(id);
        return;
      }
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },

    async purgeExpired(now = Date.now()) {
      call("purgeExpired");
      let removed = 0;
      for (const session of await readAll()) {
        if (now - Date.parse(session.updatedAt) > SESSION_TTL_MS) {
          await this.remove(session.id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
