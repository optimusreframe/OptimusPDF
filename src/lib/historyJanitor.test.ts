import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_DB_PREFIX, sweepDeadHistoryDatabases } from "@/lib/historyJanitor";

/**
 * Wave 8 · F2 menor 5 (privacidad): el barrido de historiales huerfanos corre en cualquier pagina, no carga el modulo
 * pesado si no hay nada que limpiar, borra las bases de sesiones muertas y respeta la de una pestana viva y los
 * borradores.
 */

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/app/pdf-pro/proHistoryStore", async (importOriginal) => {
  loaded.count += 1;
  return importOriginal();
});

function createDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("s");
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

const names = async () => (await indexedDB.databases()).map((info) => info.name ?? "");

/** Web Locks de mentira: `held` son las pestanas vivas. */
function fakeLocks(held: Set<string>) {
  return {
    request: async (name: string, options: unknown, callback?: (lock: unknown) => Promise<void>) => {
      const cb = typeof options === "function" ? (options as (lock: unknown) => Promise<void>) : callback;
      await cb!(held.has(name) ? null : { name });
    },
  };
}

afterEach(async () => {
  Reflect.deleteProperty(globalThis, "navigator");
  for (const name of await names()) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});

describe("sweepDeadHistoryDatabases", () => {
  it("el prefijo coincide con el del almacen", async () => {
    const { PRO_HISTORY_DB_PREFIX } = await vi.importActual<typeof import("@/app/pdf-pro/proHistoryStore")>(
      "@/app/pdf-pro/proHistoryStore",
    );
    expect(HISTORY_DB_PREFIX).toBe(PRO_HISTORY_DB_PREFIX);
  });

  it("sin ninguna base de historial no carga el modulo pesado ni borra nada", async () => {
    await createDb("optimuspdf-pro-drafts");
    loaded.count = 0;
    expect(await sweepDeadHistoryDatabases()).toBe(0);
    expect(loaded.count).toBe(0);
    expect(await names()).toEqual(["optimuspdf-pro-drafts"]);
  });

  it("borra la base de una sesion muerta, respeta la de otra pestana viva y no toca los borradores", async () => {
    await createDb("optimuspdf-pro-drafts");
    await createDb(`${HISTORY_DB_PREFIX}muerta`);
    await createDb(`${HISTORY_DB_PREFIX}viva`);
    Object.defineProperty(globalThis, "navigator", {
      value: { locks: fakeLocks(new Set([`${HISTORY_DB_PREFIX}viva`])) },
      configurable: true,
    });
    loaded.count = 0;
    expect(await sweepDeadHistoryDatabases()).toBe(1);
    expect(loaded.count).toBeGreaterThan(0);
    const left = await names();
    expect(left).toContain(`${HISTORY_DB_PREFIX}viva`);
    expect(left).toContain("optimuspdf-pro-drafts");
    expect(left).not.toContain(`${HISTORY_DB_PREFIX}muerta`);
  });

  it("sin Web Locks no sabe cuales estan vivas: no borra ninguna", async () => {
    await createDb(`${HISTORY_DB_PREFIX}x`);
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    expect(await sweepDeadHistoryDatabases()).toBe(0);
    expect(await names()).toContain(`${HISTORY_DB_PREFIX}x`);
  });

  it("indexedDB.databases() que lanza (o no existe) se traga el error y devuelve 0", async () => {
    const spy = vi.spyOn(indexedDB, "databases").mockRejectedValue(new Error("no disponible"));
    expect(await sweepDeadHistoryDatabases()).toBe(0);
    spy.mockRestore();
    const original = indexedDB.databases;
    Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
    expect(await sweepDeadHistoryDatabases()).toBe(0);
    Object.defineProperty(indexedDB, "databases", { value: original, configurable: true });
  });
});
