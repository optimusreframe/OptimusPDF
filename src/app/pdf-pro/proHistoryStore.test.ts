import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRO_HISTORY_DB_PREFIX,
  createProHistoryStore,
  proHistoryStoreSupported,
  purgeStaleProHistoryDatabases,
} from "@/app/pdf-pro/proHistoryStore";
import { fakeBytes } from "@/app/pdf-pro/proTestUtils";

/** Almacen en disco del historial (Wave 8): guardar, recuperar exacto, borrar, vaciar y borrar la base. */

const stores: { dispose: () => Promise<void> }[] = [];
function make(options: Parameters<typeof createProHistoryStore>[0] = {}) {
  const store = createProHistoryStore({ openTimeoutMs: 2000, ...options });
  if (!store) throw new Error("sin IndexedDB en el test");
  stores.push(store);
  return store;
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((info) => info.name ?? "").filter((name) => name.startsWith(PRO_HISTORY_DB_PREFIX));
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

describe("proHistoryStore", () => {
  it("hay soporte con fake-indexeddb", () => {
    expect(proHistoryStoreSupported()).toBe(true);
  });

  it("guarda y devuelve EXACTAMENTE los mismos bytes (como Blob y como bytes)", async () => {
    for (const useBlob of [true, false]) {
      const store = make({ useBlob });
      const bytes = fakeBytes(5000, 7);
      bytes[4999] = 42;
      await store.put("a", bytes);
      const back = await store.get("a");
      expect(back).not.toBeNull();
      expect(back!.byteLength).toBe(5000);
      expect(Array.from(back!.subarray(0, 8))).toEqual(Array.from(bytes.subarray(0, 8)));
      expect(back![4999]).toBe(42);
      // Otra copia: cambiar lo devuelto no toca lo guardado (los snapshots son inmutables).
      back![0] = 0;
      expect((await store.get("a"))![0]).toBe(0x25);
    }
  });

  it("un id que no existe devuelve null; remove y clear no fallan con ids inexistentes", async () => {
    const store = make();
    expect(await store.get("nada")).toBeNull();
    await store.put("a", fakeBytes(10));
    await store.put("b", fakeBytes(10));
    await store.remove(["a", "zzz"]);
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).not.toBeNull();
    await store.clear();
    expect(await store.get("b")).toBeNull();
  });

  it("un snapshot grande se guarda por trozos y vuelve exacto (incluido el ultimo trozo parcial)", async () => {
    const store = make({ sessionId: "trozos" });
    const size = 8 * 1024 * 1024 * 2 + 12345;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 4099) bytes[i] = i & 255;
    await store.put("big", bytes);
    const back = await store.get("big");
    expect(back?.byteLength).toBe(size);
    for (let i = 0; i < size; i += 4099) expect(back![i]).toBe(i & 255);
    await store.remove(["big"]);
    expect(await store.get("big")).toBeNull();
  });

  it("un registro con longitud distinta a la anotada (corrupto) se devuelve como null, nunca como otros bytes", async () => {
    const store = make({ useBlob: false, sessionId: "corrupto" });
    await store.put("a", fakeBytes(10));
    // Se corrompe la fila por detras (otra pestaña, el navegador...): la longitud anotada ya no cuadra.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(store.name);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("snapshots", "readwrite");
        tx.objectStore("snapshots").put({ id: "a", chunks: 1, byteLength: 12 });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(await store.get("a")).toBeNull();
  });

  it("dispose borra la base de la sesion y deja el almacen inutilizable (put rechaza)", async () => {
    const store = make({ sessionId: "s1" });
    await store.put("a", fakeBytes(10));
    expect(await databaseNames()).toContain(store.name);
    await store.dispose();
    expect(await databaseNames()).not.toContain(store.name);
    await expect(store.put("b", fakeBytes(10))).rejects.toThrow();
  });

  it("cada sesion tiene su propia base: lo de una no se ve desde otra", async () => {
    const a = make({ sessionId: "a" });
    const b = make({ sessionId: "b" });
    await a.put("x", fakeBytes(10));
    expect(await b.get("x")).toBeNull();
  });

  it("purgeStaleProHistoryDatabases sin Web Locks no borra nada (no sabe cuales estan vivas)", async () => {
    const store = make({ sessionId: "viva" });
    await store.put("x", fakeBytes(10));
    expect(await purgeStaleProHistoryDatabases()).toBe(0);
    expect(await databaseNames()).toContain(store.name);
  });

  it("purgeStaleProHistoryDatabases borra las bases cuyo lock nadie sostiene y respeta las vivas", async () => {
    const held = new Set<string>();
    const locks = {
      request: async (name: string, options: unknown, callback?: (lock: unknown) => Promise<void>) => {
        const cb = typeof options === "function" ? (options as (lock: unknown) => Promise<void>) : callback;
        if (typeof options === "function") {
          held.add(name);
          try {
            await cb!({ name });
          } finally {
            held.delete(name);
          }
          return;
        }
        await cb!(held.has(name) ? null : { name });
      },
    };
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    try {
      const alive = make({ sessionId: "alive" });
      const dead = make({ sessionId: "dead" });
      await alive.put("x", fakeBytes(10));
      await dead.put("x", fakeBytes(10));
      held.delete(dead.name); // la pestaña «dead» murio: su lock se solto
      expect(await purgeStaleProHistoryDatabases()).toBe(1);
      const names = await databaseNames();
      expect(names).toContain(alive.name);
      expect(names).not.toContain(dead.name);
    } finally {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});
