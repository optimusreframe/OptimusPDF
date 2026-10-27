import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SCAN_SESSION_BYTES,
  SCAN_DB_NAME,
  SCAN_SESSION_TTL_MS,
  __resetScanStoreMemoryForTests,
  __setScanOpenTimeoutForTests,
  __setScanStorageModeForTests,
  scanStorageMode,
  __setScanStoreLimitsForTests,
  __setScanTabIdForTests,
  clearScanSessions,
  isMetaRow,
  isValidScanSessionId,
  listScanSessionSummaries,
  newScanSessionId,
  scanSessionStore,
  subscribeToScanSessions,
} from "@/lib/scan/sessionStore";
import { DEFAULT_SCAN_SETTINGS, type ScanPage, type ScanSession } from "@/lib/scan/types";

/**
 * Sesion persistente del Escaner (IndexedDB simulado con fake-indexeddb): guardado incremental, recuperacion con los originales
 * intactos, expiracion, cuota, varias pestanas e integridad. El E2E repite lo esencial en navegadores reales.
 */

const store = scanSessionStore;

function bytesOf(seed: number, length = 2048): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + seed * 17) & 255;
  return bytes;
}

let counter = 0;
function page(seed: number, patch: Partial<ScanPage> = {}): ScanPage {
  counter += 1;
  return {
    id: `p-${seed}-${counter}`,
    createdAt: new Date(2026, 9, 26, 10, seed).toISOString(),
    source: "camera",
    original: new Blob([bytesOf(seed)], { type: "image/jpeg" }),
    originalWidth: 3024,
    originalHeight: 4032,
    corners: { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.12 }, bottomRight: { x: 0.88, y: 0.9 }, bottomLeft: { x: 0.12, y: 0.88 } },
    rotation: 0,
    filter: "auto",
    adjust: { brightness: 0, contrast: 0 },
    processed: null,
    thumb: new Blob([bytesOf(seed + 100, 300)], { type: "image/jpeg" }),
    flags: {},
    mode: "document",
    ...patch,
  };
}

function session(pages: ScanPage[], patch: Partial<ScanSession> = {}): ScanSession {
  return {
    id: newScanSessionId(),
    createdAt: new Date(2026, 9, 26, 10, 0).toISOString(),
    updatedAt: new Date(2026, 9, 26, 10, 5).toISOString(),
    name: "Escaneo de prueba",
    pages,
    settings: { ...DEFAULT_SCAN_SETTINGS },
    ...patch,
  };
}

async function read(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SCAN_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawAll(storeName: string): Promise<Array<Record<string, unknown>>> {
  const db = await openRaw();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function rawPut(storeName: string, value: unknown): Promise<void> {
  const db = await openRaw();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function rawDelete(storeName: string, key: string): Promise<void> {
  const db = await openRaw();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  __setScanStorageModeForTests("blob");
  __resetScanStoreMemoryForTests();
  __setScanTabIdForTests("t-main");
  __setScanStoreLimitsForTests();
  await clearScanSessions();
  __resetScanStoreMemoryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __setScanStoreLimitsForTests();
});

describe("ids", () => {
  it("newScanSessionId cumple la regla del enlace ?resume=scan:<id> y no se repite", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newScanSessionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isValidScanSessionId(id)).toBe(true);
    expect(isValidScanSessionId("../etc/passwd")).toBe(false);
    expect(isValidScanSessionId("ABC-12345678")).toBe(false);
    expect(isValidScanSessionId("corto")).toBe(false);
    expect(isValidScanSessionId(42)).toBe(false);
    expect(isValidScanSessionId(crypto.randomUUID())).toBe(true);
  });
});

describe("guardar y recuperar", () => {
  it("la sesion vuelve con los ORIGINALES intactos (mismos bytes), el orden, las esquinas, los filtros y las banderas", async () => {
    const pages = [page(1, { filter: "bw", rotation: 90, flags: { blurry: true } }), page(2, { source: "library", adjust: { brightness: 0.25, contrast: -0.5 } }), page(3, { corners: null, flags: { noDocument: true }, mode: "photo", ocrText: "hola" })];
    const input = session(pages, { name: "Contrato · 2026-10-26", nameSuggested: { title: "Contrato", date: "2026-10-26", source: "ocr", name: "Contrato · 2026-10-26" }, settings: { ...DEFAULT_SCAN_SETTINGS, mode: "receipt", searchable: true } });
    expect(await store.save(input)).toMatchObject({ ok: true, rev: 1 });
    __resetScanStoreMemoryForTests();
    const loaded = await store.load(input.id);
    expect(loaded).not.toBeNull();
    const got = loaded as ScanSession;
    expect(got.lostPages).toBeUndefined();
    expect(got.name).toBe("Contrato · 2026-10-26");
    expect(got.nameSuggested).toEqual(input.nameSuggested);
    expect(got.settings).toMatchObject({ mode: "receipt", searchable: true });
    expect(got.pages.map((p) => p.id)).toEqual(pages.map((p) => p.id));
    for (const [index, original] of pages.entries()) {
      const stored = got.pages[index];
      expect(await read(stored.original)).toEqual(await read(original.original));
      expect(stored.original.type).toBe("image/jpeg");
      expect(stored.thumb && (await read(stored.thumb))).toEqual(await read(original.thumb as Blob));
      expect(stored.corners).toEqual(original.corners);
      expect(stored.rotation).toBe(original.rotation);
      expect(stored.filter).toBe(original.filter);
      expect(stored.adjust).toEqual(original.adjust);
      expect(stored.flags).toEqual(original.flags);
      expect(stored.source).toBe(original.source);
      expect(stored.mode).toBe(original.mode);
      expect(stored.processed).toBeNull();
      expect([stored.originalWidth, stored.originalHeight]).toEqual([3024, 4032]);
    }
    expect(got.pages[2].ocrText).toBe("hola");
  });

  it("load de un id inexistente, invalido o sin base devuelve null sin lanzar", async () => {
    expect(await store.load("sc-no-existe-0001")).toBeNull();
    expect(await store.load("../x")).toBeNull();
  });

  it("guardar no toca el original (la misma sesion guardada dos veces sigue dando los mismos bytes)", async () => {
    const input = session([page(5)]);
    const reference = await read(input.pages[0].original);
    await store.save(input);
    await store.save({ ...input, pages: [{ ...input.pages[0], rotation: 180, filter: "grayscale" }] });
    const loaded = (await store.load(input.id)) as ScanSession;
    expect(await read(loaded.pages[0].original)).toEqual(reference);
    expect(loaded.pages[0].rotation).toBe(180);
    expect(loaded.pages[0].filter).toBe("grayscale");
  });

  it("una sesion sin paginas se guarda y se recupera vacia", async () => {
    const input = session([]);
    expect((await store.save(input)).ok).toBe(true);
    const loaded = (await store.load(input.id)) as ScanSession;
    expect(loaded.pages).toEqual([]);
  });

  it("rechaza (sin lanzar) una sesion mal formada: id invalido, ids de pagina repetidos o un original que no es Blob", async () => {
    expect(await store.save({ ...session([page(1)]), id: "../mal" })).toEqual({ ok: false, reason: "unavailable" });
    const a = page(1);
    expect(await store.save(session([a, { ...a }]))).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.save(session([{ ...page(2), original: "no-blob" as unknown as Blob }]))).toEqual({ ok: false, reason: "unavailable" });
    expect(await rawAll("meta")).toEqual([]);
  });
});

describe("guardado incremental", () => {
  /** Cuenta escrituras por almacen. */
  function spyWrites() {
    const puts: string[] = [];
    const deletes: string[] = [];
    const transactions: string[] = [];
    const originalPut = IDBObjectStore.prototype.put;
    const originalDelete = IDBObjectStore.prototype.delete;
    const originalTx = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      puts.push(this.name);
      return originalPut.call(this, value, key);
    });
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      deletes.push(this.name);
      return originalDelete.call(this, query);
    });
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names: string | Iterable<string>, mode?: IDBTransactionMode) {
      if (mode === "readwrite") transactions.push(typeof names === "string" ? names : Array.from(names).join("+"));
      return originalTx.call(this, names, mode);
    });
    return { puts, deletes, transactions };
  }

  it("sin cambios no abre ni la transaccion de escritura", async () => {
    const input = session([page(1), page(2)]);
    await store.save(input);
    const spy = spyWrites();
    expect(await store.save(input)).toMatchObject({ ok: true });
    expect(spy.transactions).toEqual([]);
    expect(spy.puts).toEqual([]);
  });

  it("cambiar UNA pagina escribe solo su fila (ni su original ni las demas) y la ficha de la sesion", async () => {
    const [a, b, c] = [page(1), page(2), page(3)];
    const input = session([a, b, c]);
    await store.save(input);
    const spy = spyWrites();
    await store.save({ ...input, pages: [a, { ...b, rotation: 90 }, c] });
    // Solo la fila de esa pagina y la ficha: girar NO reescribe la foto original (pesada).
    expect(spy.puts.sort()).toEqual(["meta", "pages"]);
    expect(spy.transactions).toHaveLength(1);
  });

  it("anadir una pagina escribe su fila y su original; quitarla la borra de los dos almacenes", async () => {
    const [a, b] = [page(1), page(2)];
    const input = session([a]);
    await store.save(input);
    let spy = spyWrites();
    await store.save({ ...input, pages: [a, b] });
    expect(spy.puts.filter((n) => n === "originals")).toHaveLength(1);
    expect(spy.puts.filter((n) => n === "pages")).toHaveLength(1);
    vi.restoreAllMocks();
    spy = spyWrites();
    await store.save({ ...input, pages: [a] });
    expect(spy.puts).toEqual(["meta"]);
    expect(spy.deletes.sort()).toEqual(["originals", "pages"]);
    expect((await rawAll("originals")).map((r) => r.pid)).toEqual([a.id]);
    expect((await rawAll("pages")).map((r) => r.pid)).toEqual([a.id]);
  });

  it("reordenar solo reescribe la ficha (el orden), no las paginas", async () => {
    const [a, b, c] = [page(1), page(2), page(3)];
    const input = session([a, b, c]);
    await store.save(input);
    const spy = spyWrites();
    await store.save({ ...input, pages: [c, a, b] });
    expect(spy.puts).toEqual(["meta"]);
    const loaded = (await store.load(input.id)) as ScanSession;
    expect(loaded.pages.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
  });

  it("repetir una captura (otro original con el mismo id de pagina) reescribe esa pagina y su original", async () => {
    const a = page(1);
    const input = session([a]);
    await store.save(input);
    const replaced = { ...a, original: new Blob([bytesOf(77)], { type: "image/jpeg" }) };
    await store.save({ ...input, pages: [replaced] });
    const loaded = (await store.load(input.id)) as ScanSession;
    expect(await read(loaded.pages[0].original)).toEqual(Array.from(bytesOf(77)));
  });

  it("tras recargar (load) el primer guardado sin cambios no reescribe nada", async () => {
    const input = session([page(1), page(2)]);
    await store.save(input);
    __resetScanStoreMemoryForTests();
    const loaded = (await store.load(input.id)) as ScanSession;
    const spy = spyWrites();
    expect((await store.save(loaded)).ok).toBe(true);
    expect(spy.transactions).toEqual([]);
  });

  it("dos guardados seguidos SIN esperar se encolan: las revisiones suben 1, 2 y nadie se bifurca", async () => {
    const input = session([page(1)]);
    const [first, second] = await Promise.all([store.save(input), store.save({ ...input, name: "Otro nombre" })]);
    expect(first).toMatchObject({ ok: true, rev: 1 });
    expect(second).toMatchObject({ ok: true, rev: 2 });
    expect((await store.load(input.id))?.name).toBe("Otro nombre");
    expect((await rawAll("meta")).length).toBe(1);
  });
});

describe("lista, borrado y expiracion", () => {
  it("list: miniatura de portada, paginas, ordenada de la mas reciente a la mas antigua", async () => {
    const first = session([page(1), page(2)], { name: "Primera" });
    const second = session([page(3)], { name: "Segunda" });
    await store.save(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save(second);
    const list = await store.list();
    expect(list.map((item) => item.name)).toEqual(["Segunda", "Primera"]);
    expect(list[1]).toMatchObject({ id: first.id, pageCount: 2 });
    expect(list[1].thumb && (await read(list[1].thumb))).toEqual(await read(first.pages[0].thumb as Blob));
    const summaries = await listScanSessionSummaries();
    expect(summaries[0].savedAt >= summaries[1].savedAt).toBe(true);
  });

  it("una ficha corrupta o con forma inesperada NO rompe la lista", async () => {
    const good = session([page(1)]);
    await store.save(good);
    await rawPut("meta", { id: "sc-basura-00001", schema: 1, name: 42 });
    await rawPut("meta", { id: "sc-otro-schema-1", schema: 99 });
    await rawPut("meta", { id: "../ruta", nada: true });
    const list = await store.list();
    expect(list.map((item) => item.id)).toEqual([good.id]);
    expect(isMetaRow(null)).toBe(false);
    expect(isMetaRow({})).toBe(false);
  });

  it("remove borra la sesion entera (ficha, paginas y originales) y avisa a los oyentes; borrar algo inexistente no falla", async () => {
    const input = session([page(1), page(2)]);
    const other = session([page(3)]);
    await store.save(input);
    await store.save(other);
    const listener = vi.fn();
    const unsubscribe = subscribeToScanSessions(listener);
    await store.remove(input.id);
    expect(listener).toHaveBeenCalled();
    expect(await store.load(input.id)).toBeNull();
    expect((await rawAll("pages")).every((row) => row.sid !== input.id)).toBe(true);
    expect((await rawAll("originals")).every((row) => row.sid !== input.id)).toBe(true);
    expect((await store.load(other.id))?.pages).toHaveLength(1);
    await expect(store.remove("sc-no-existe-0001")).resolves.toBeUndefined();
    await expect(store.remove("../x")).resolves.toBeUndefined();
    unsubscribe();
  });

  it("purgeExpired: a los 14 dias borra solo lo caducado y devuelve cuantas; list no muestra lo caducado", async () => {
    const old = session([page(1)], { name: "Vieja" });
    await store.save(old);
    const now = Date.now();
    expect(await store.purgeExpired(now + SCAN_SESSION_TTL_MS - 60_000)).toBe(0);
    expect((await store.list()).map((i) => i.name)).toEqual(["Vieja"]);
    // Un guardado reciente renueva el plazo (14 dias desde el ULTIMO guardado).
    const fresh = session([page(2)], { name: "Nueva" });
    await store.save(fresh);
    expect(await store.purgeExpired(now + SCAN_SESSION_TTL_MS + 60_000)).toBe(2);
    expect(await store.list()).toEqual([]);
    expect(await rawAll("pages")).toEqual([]);
    expect(await rawAll("originals")).toEqual([]);
  });

  it("list con la fecha ya pasada purga sola las caducadas", async () => {
    const input = session([page(1)]);
    await store.save(input);
    expect(await listScanSessionSummaries(Date.now() + SCAN_SESSION_TTL_MS + 1000)).toEqual([]);
    expect(await store.load(input.id)).toBeNull();
  });
});

describe("integridad", () => {
  it("una pagina sin original o con la fila danada no se recupera, el resto si, y se cuenta en lostPages", async () => {
    const [a, b, c] = [page(1), page(2), page(3)];
    const input = session([a, b, c]);
    await store.save(input);
    await rawDelete("originals", `${input.id}\u0001${b.id}`);
    await rawPut("pages", { key: `${input.id}\u0001${c.id}`, sid: input.id, pid: c.id, rotation: 45 });
    __resetScanStoreMemoryForTests();
    const loaded = (await store.load(input.id)) as ScanSession;
    expect(loaded.pages.map((p) => p.id)).toEqual([a.id]);
    expect(loaded.lostPages).toBe(2);
    expect(await read(loaded.pages[0].original)).toEqual(await read(a.original));
  });

  it("un original vacio (0 bytes) cuenta como perdido", async () => {
    const a = page(1);
    const input = session([a]);
    await store.save(input);
    await rawPut("originals", { key: `${input.id}\u0001${a.id}`, sid: input.id, pid: a.id, blob: new Blob([]) });
    __resetScanStoreMemoryForTests();
    expect(((await store.load(input.id)) as ScanSession).lostPages).toBe(1);
  });
});

describe("limites", () => {
  it("tooBig: una sesion por encima del tope no se guarda", async () => {
    __setScanStoreLimitsForTests({ maxSessionBytes: 1000 });
    expect(await store.save(session([page(1)]))).toEqual({ ok: false, reason: "tooBig" });
    expect(MAX_SCAN_SESSION_BYTES).toBeGreaterThan(100 * 1024 * 1024);
    __setScanStoreLimitsForTests();
    expect((await store.save(session([page(1)]))).ok).toBe(true);
  });

  it("quota: sin sitio segun navigator.storage.estimate no se guarda NADA (la sesion anterior queda intacta)", async () => {
    const input = session([page(1)]);
    await store.save(input);
    const estimate = vi.fn().mockResolvedValue({ usage: 990, quota: 1000 });
    vi.stubGlobal("navigator", { ...globalThis.navigator, storage: { estimate } });
    const bigger = { ...input, pages: [...input.pages, page(2)] };
    expect(await store.save(bigger)).toEqual({ ok: false, reason: "quota" });
    vi.unstubAllGlobals();
    expect(((await store.load(input.id)) as ScanSession).pages).toHaveLength(1);
  });

  it("quota: un QuotaExceededError de IndexedDB a mitad de escritura se devuelve como `quota` y no deja la sesion a medias", async () => {
    const input = session([page(1)]);
    await store.save(input);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "originals") throw new DOMException("sin sitio", "QuotaExceededError");
      return original.call(this, value, key);
    });
    const result = await store.save({ ...input, pages: [...input.pages, page(2)] });
    expect(result).toEqual({ ok: false, reason: "quota" });
    vi.restoreAllMocks();
    expect(((await store.load(input.id)) as ScanSession).pages).toHaveLength(1);
  });

  it("unavailable: sin IndexedDB todo devuelve resultados tipados y nada lanza", async () => {
    const saved = (globalThis as { indexedDB?: unknown }).indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
    try {
      __setScanOpenTimeoutForTests(50);
      expect(await store.save(session([page(1)]))).toEqual({ ok: false, reason: "unavailable" });
      expect(await store.load("sc-sin-base-00001")).toBeNull();
      expect(await store.list()).toEqual([]);
      expect(await store.purgeExpired()).toBe(0);
      await expect(store.remove("sc-sin-base-00001")).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { value: saved, configurable: true, writable: true });
      __setScanOpenTimeoutForTests(4000);
    }
  });
});

describe("varias pestanas", () => {
  it("otra pestana que escribio antes: la copia de ESTA no la pisa, se guarda aparte (forkedAs) y la original queda intacta", async () => {
    const input = session([page(1)], { name: "De la pestana A" });
    __setScanTabIdForTests("t-A");
    await store.save(input);
    __setScanTabIdForTests("t-B");
    __resetScanStoreMemoryForTests();
    const result = await store.save({ ...input, name: "De la pestana B" });
    expect(result.ok).toBe(true);
    const forkedAs = (result as { forkedAs?: string }).forkedAs;
    expect(forkedAs).toBeDefined();
    expect(isValidScanSessionId(forkedAs)).toBe(true);
    expect((await store.load(input.id))?.name).toBe("De la pestana A");
    expect((await store.load(forkedAs as string))?.name).toBe("De la pestana B");
    expect(((await store.load(forkedAs as string)) as ScanSession).pages).toHaveLength(1);
    // Los guardados siguientes de B van a la copia (no abren otra por cada autoguardado).
    const again = await store.save({ ...input, name: "B otra vez" });
    expect(again).toMatchObject({ ok: true });
    expect((again as { forkedAs?: string }).forkedAs).toBeUndefined();
    expect((await rawAll("meta")).length).toBe(2);
    expect((await store.load(forkedAs as string))?.name).toBe("B otra vez");
  });

  it("si la otra pestana CARGO la sesion antes (conoce su revision) guarda sin bifurcar", async () => {
    const input = session([page(1)]);
    __setScanTabIdForTests("t-A");
    await store.save(input);
    __setScanTabIdForTests("t-B");
    __resetScanStoreMemoryForTests();
    const loaded = (await store.load(input.id)) as ScanSession;
    const result = await store.save({ ...loaded, name: "Editada en B" });
    expect(result).toMatchObject({ ok: true, rev: 2 });
    expect((result as { forkedAs?: string }).forkedAs).toBeUndefined();
    expect((await rawAll("meta")).length).toBe(1);
  });

  it("la misma pestana nunca se compite a si misma (mismo writerId)", async () => {
    const input = session([page(1)]);
    await store.save(input);
    __resetScanStoreMemoryForTests();
    const result = await store.save({ ...input, name: "Cambio" });
    expect(result).toMatchObject({ ok: true });
    expect((result as { forkedAs?: string }).forkedAs).toBeUndefined();
  });

  it("cada guardado avisa por BroadcastChannel (id, revision y pestana) y los oyentes se refrescan", async () => {
    const heard: unknown[] = [];
    const channel = new BroadcastChannel("optimuspdf.scan-sessions");
    channel.onmessage = (event) => heard.push(event.data);
    const listener = vi.fn();
    const unsubscribe = subscribeToScanSessions(listener);
    const input = session([page(1)]);
    await store.save(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toContainEqual({ type: "write", id: input.id, rev: 1, writerId: "t-main" });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    channel.close();
  });
});

describe("clearScanSessions", () => {
  it("borra todo lo guardado", async () => {
    await store.save(session([page(1)]));
    await store.save(session([page(2)]));
    await clearScanSessions();
    expect(await store.list()).toEqual([]);
    expect(await rawAll("originals")).toEqual([]);
  });
});

describe("navegadores que no guardan Blob en IndexedDB (Safari privado, algunos WebKit)", () => {
  /** Hace que IndexedDB rechace cualquier fila que lleve un Blob, como esos navegadores. */
  function rejectBlobs() {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const row = value as Record<string, unknown>;
      if (row && (row.blob instanceof Blob || row.thumb instanceof Blob || row.cover instanceof Blob)) throw new DOMException("Error preparing Blob/File data to be stored in object store", "UnknownError");
      return original.call(this, value, key);
    });
  }

  it("el guardado se repite con bytes, la sesion vuelve con los MISMOS bytes y la portada, y los guardados siguientes ya no fallan", async () => {
    rejectBlobs();
    const input = session([page(1), page(2)]);
    expect(scanStorageMode()).toBe("blob");
    expect(await store.save(input)).toMatchObject({ ok: true });
    expect(scanStorageMode()).toBe("bytes");
    __resetScanStoreMemoryForTests();
    const loaded = (await store.load(input.id)) as ScanSession;
    expect(loaded.pages).toHaveLength(2);
    for (const [index, original] of input.pages.entries()) {
      expect(await read(loaded.pages[index].original)).toEqual(await read(original.original));
      expect(loaded.pages[index].original.type).toBe("image/jpeg");
      expect(await read(loaded.pages[index].thumb as Blob)).toEqual(await read(original.thumb as Blob));
    }
    const list = await store.list();
    expect(list[0].thumb && (await read(list[0].thumb))).toEqual(await read(input.pages[0].thumb as Blob));
    // Un cambio posterior tambien se guarda (en bytes) sin reintentos.
    expect(await store.save({ ...loaded, pages: loaded.pages.map((p, i) => (i === 0 ? { ...p, rotation: 270 } : p)) })).toMatchObject({ ok: true });
    expect(((await store.load(input.id)) as ScanSession).pages[0].rotation).toBe(270);
  });

  it("si tampoco funciona con bytes devuelve `unavailable` y vuelve al modo normal (no se queda en bytes para siempre)", async () => {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "pages") throw new DOMException("roto", "UnknownError");
      return original.call(this, value, key);
    });
    expect(await store.save(session([page(1)]))).toEqual({ ok: false, reason: "unavailable" });
    expect(scanStorageMode()).toBe("blob");
  });

  it("un error de cuota NO provoca el reintento con bytes (seria gastar el doble de sitio)", async () => {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "originals") throw new DOMException("sin sitio", "QuotaExceededError");
      return original.call(this, value, key);
    });
    expect(await store.save(session([page(1)]))).toEqual({ ok: false, reason: "quota" });
    expect(scanStorageMode()).toBe("blob");
  });
});
