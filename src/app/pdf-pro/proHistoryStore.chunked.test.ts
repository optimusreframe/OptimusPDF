import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { MAX_CHUNK } from "@/app/pdf-pro/proChunks";

/**
 * Almacen del historial · snapshots TROCEADOS por contenido (Wave 9): exactitud de los bytes, ahorro de escritura,
 * borrado sin perder lo que comparten otros pasos, filas rotas y escritura abortada sin restos.
 */

const MB = 1024 * 1024;

function noise(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 255;
  }
  return out;
}

const stores: { dispose: () => Promise<void> }[] = [];
function make(options: Parameters<typeof createProHistoryStore>[0] = {}) {
  const store = createProHistoryStore({ openTimeoutMs: 2000, ...options });
  if (!store) throw new Error("sin IndexedDB en el test");
  stores.push(store);
  return store;
}

/** Todas las claves del almacen de snapshots de esa base. */
function rawKeys(name: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("snapshots", "readonly").objectStore("snapshots").getAllKeys();
      request.onsuccess = () => {
        db.close();
        resolve(request.result as string[]);
      };
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

function rawDelete(name: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

function rawPut(name: string, row: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put(row);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

const chunkKeys = (keys: string[]) => keys.filter((key) => key.startsWith("~c:"));
const manifestKeys = (keys: string[]) => keys.filter((key) => key.startsWith("~m:"));

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.dispose();
});

describe("proHistoryStore · snapshots troceados", () => {
  it("un snapshot grande vuelve EXACTO (cada byte) y se guarda en filas de trozos, sin filas enteras", async () => {
    const store = make({ sessionId: "exacto" });
    const bytes = noise(6 * MB + 12_345, 3);
    await store.put("a", bytes);
    const back = await store.get("a");
    expect(back).not.toBeNull();
    expect(back!.byteLength).toBe(bytes.byteLength);
    expect(Buffer.compare(Buffer.from(back!), Buffer.from(bytes))).toBe(0);
    const keys = await rawKeys(store.name);
    expect(manifestKeys(keys)).toEqual(["~m:a"]);
    expect(chunkKeys(keys).length).toBeGreaterThan(50);
    expect(keys.filter((key) => !key.startsWith("~"))).toEqual([]);
    // Lo devuelto es una copia: cambiarlo no toca lo guardado.
    back![0] ^= 0xff;
    expect((await store.get("a"))![0]).toBe(bytes[0]);
  });

  it("un paso casi igual al anterior solo escribe los trozos NUEVOS (la duplicacion es lo que se evita)", async () => {
    const store = make({ sessionId: "dedupe" });
    const first = noise(8 * MB, 5);
    await store.put("p1", first);
    const afterFirst = chunkKeys(await rawKeys(store.name)).length;
    const second = first.slice();
    second[3 * MB] ^= 0xff; // un objeto pequeño cambia en medio del PDF
    const writes: number[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      const value = args[0] as { id?: string; data?: Uint8Array };
      if (value?.id?.startsWith("~c:") && value.data) writes.push(value.data.byteLength);
      return original.apply(this, args);
    });
    await store.put("p2", second);
    // Solo el trozo (o dos) que contiene el cambio: como mucho 2 trozos del maximo, no 8 MB.
    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(2 * MAX_CHUNK);
    const afterSecond = chunkKeys(await rawKeys(store.name)).length;
    expect(afterSecond - afterFirst).toBeLessThanOrEqual(2);
    // Ambos pasos se recuperan exactos.
    expect(Buffer.compare(Buffer.from((await store.get("p1"))!), Buffer.from(first))).toBe(0);
    expect(Buffer.compare(Buffer.from((await store.get("p2"))!), Buffer.from(second))).toBe(0);
  });

  it("borrar un paso conserva los trozos que comparte con otro y barre los suyos; borrar el ultimo deja la base vacia de trozos", async () => {
    const store = make({ sessionId: "barrido" });
    const a = noise(6 * MB, 9);
    const b = a.slice();
    b[1 * MB] ^= 0xff;
    await store.put("a", a);
    await store.put("b", b);
    const both = chunkKeys(await rawKeys(store.name)).length;
    await store.remove(["a"]);
    const onlyB = chunkKeys(await rawKeys(store.name));
    expect(onlyB.length).toBeLessThan(both);
    expect(await store.get("a")).toBeNull();
    expect(Buffer.compare(Buffer.from((await store.get("b"))!), Buffer.from(b))).toBe(0);
    await store.remove(["b"]);
    const left = await rawKeys(store.name);
    expect(chunkKeys(left)).toEqual([]);
    expect(manifestKeys(left)).toEqual([]);
    expect(await store.get("b")).toBeNull();
  });

  it("borrar un id que no existe, o ids de snapshots pequeños, no toca los trozos de los grandes", async () => {
    const store = make({ sessionId: "ajeno" });
    const big = noise(5 * MB, 2);
    await store.put("big", big);
    await store.put("small", noise(1000, 4));
    const before = chunkKeys(await rawKeys(store.name)).length;
    await store.remove(["nada", "small"]);
    expect(chunkKeys(await rawKeys(store.name)).length).toBe(before);
    expect(Buffer.compare(Buffer.from((await store.get("big"))!), Buffer.from(big))).toBe(0);
  });

  it("clear vacia manifiestos y trozos", async () => {
    const store = make({ sessionId: "vaciar" });
    await store.put("a", noise(5 * MB, 1));
    await store.clear();
    expect(await rawKeys(store.name)).toEqual([]);
    expect(await store.get("a")).toBeNull();
  });

  it("un trozo que falta devuelve null, nunca bytes incompletos ni de otro paso", async () => {
    const store = make({ sessionId: "falta" });
    const bytes = noise(5 * MB, 6);
    await store.put("a", bytes);
    const victim = chunkKeys(await rawKeys(store.name))[3];
    await rawDelete(store.name, victim);
    expect(await store.get("a")).toBeNull();
  });

  it("un trozo con otra longitud (fila corrupta) devuelve null", async () => {
    const store = make({ sessionId: "corrupto" });
    await store.put("a", noise(5 * MB, 7));
    const victim = chunkKeys(await rawKeys(store.name))[0];
    await rawPut(store.name, { id: victim, data: new Uint8Array(10) });
    expect(await store.get("a")).toBeNull();
  });

  it("un manifiesto roto devuelve null y NO borra los trozos de otros pasos al barrer", async () => {
    const store = make({ sessionId: "manifiesto" });
    await store.put("good", noise(5 * MB, 8));
    await store.put("other", noise(5 * MB, 9));
    await rawPut(store.name, { id: "~m:other", v: 2, byteLength: 1, hashes: [] });
    expect(await store.get("other")).toBeNull();
    const before = chunkKeys(await rawKeys(store.name)).length;
    await store.remove(["zzz"]);
    expect(chunkKeys(await rawKeys(store.name)).length).toBe(before);
    expect(await store.get("good")).not.toBeNull();
  });

  it("un manifiesto cuyas longitudes no suman lo anotado (alterado) devuelve null, nunca bytes de otro tamaño", async () => {
    const store = make({ sessionId: "suma" });
    await store.put("a", noise(5 * MB, 5));
    const manifest = await new Promise<{ id: string; v: number; byteLength: number; hashes: string[]; sizes: number[] }>((resolve, reject) => {
      const open = indexedDB.open(store.name);
      open.onsuccess = () => {
        const db = open.result;
        const request = db.transaction("snapshots").objectStore("snapshots").get("~m:a");
        request.onsuccess = () => {
          db.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
      };
    });
    // Misma lista de trozos, pero el peso anotado ya no cuadra con la suma de sus longitudes.
    await rawPut(store.name, { ...manifest, byteLength: manifest.byteLength + 5 });
    expect(await store.get("a")).toBeNull();
  });

  it("si la escritura se aborta a medias (cuota) no queda manifiesto ni trozos huerfanos del paso, y el anterior sigue entero", async () => {
    const store = make({ sessionId: "aborto" });
    const first = noise(6 * MB, 11);
    await store.put("a", first);
    const before = await rawKeys(store.name);
    const original = IDBObjectStore.prototype.put;
    let count = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      count += 1;
      if (count === 3) throw new DOMException("sin espacio", "QuotaExceededError");
      return original.apply(this, args);
    });
    await expect(store.put("b", noise(6 * MB, 12))).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await rawKeys(store.name)).toEqual(before);
    expect(await store.get("b")).toBeNull();
    expect(Buffer.compare(Buffer.from((await store.get("a"))!), Buffer.from(first))).toBe(0);
  });

  it("guardar otra vez el mismo id lo sustituye y se lee la version nueva", async () => {
    const store = make({ sessionId: "sustituir" });
    const v1 = noise(5 * MB, 21);
    const v2 = noise(5 * MB, 22);
    await store.put("a", v1);
    await store.put("a", v2);
    expect(Buffer.compare(Buffer.from((await store.get("a"))!), Buffer.from(v2))).toBe(0);
    await store.remove(["a"]);
    expect(await rawKeys(store.name)).toEqual([]);
  });

  it("bajo el umbral se guarda entero como siempre (filas `id:n`, sin trozos) y con `chunkMinBytes` bajo se trocea", async () => {
    const small = make({ sessionId: "pequeño" });
    await small.put("s", noise(2 * MB, 3));
    const keys = await rawKeys(small.name);
    expect(keys.filter((key) => key.startsWith("~"))).toEqual([]);
    expect(keys).toContain("s");
    const low = make({ sessionId: "umbral-bajo", chunkMinBytes: 1000 });
    const bytes = noise(300_000, 4);
    await low.put("t", bytes);
    const lowKeys = await rawKeys(low.name);
    expect(manifestKeys(lowKeys)).toEqual(["~m:t"]);
    expect(Buffer.compare(Buffer.from((await low.get("t"))!), Buffer.from(bytes))).toBe(0);
  });

  it("el mismo contenido repetido dentro de un snapshot guarda ese trozo una sola vez", async () => {
    const store = make({ sessionId: "repetido", chunkMinBytes: 1000 });
    const zeros = new Uint8Array(1 * MB);
    await store.put("z", zeros);
    expect(chunkKeys(await rawKeys(store.name)).length).toBeLessThanOrEqual(2);
    const back = await store.get("z");
    expect(back!.byteLength).toBe(zeros.byteLength);
    expect(back!.every((b) => b === 0)).toBe(true);
  });

  it("dispose borra la base entera (trozos incluidos) y put rechaza despues", async () => {
    const store = make({ sessionId: "dispose" });
    await store.put("a", noise(5 * MB, 31));
    await store.dispose();
    const names = (await indexedDB.databases()).map((info) => info.name);
    expect(names).not.toContain(store.name);
    await expect(store.put("b", noise(5 * MB, 32))).rejects.toThrow();
  });

  it("sin SHA-256 el snapshot grande se guarda entero (no se pierde nada)", async () => {
    const store = make({ sessionId: "sin-hash" });
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const bytes = noise(5 * MB, 41);
    await store.put("a", bytes);
    vi.unstubAllGlobals();
    const keys = await rawKeys(store.name);
    expect(keys.filter((key) => key.startsWith("~"))).toEqual([]);
    expect(Buffer.compare(Buffer.from((await store.get("a"))!), Buffer.from(bytes))).toBe(0);
  });
});
