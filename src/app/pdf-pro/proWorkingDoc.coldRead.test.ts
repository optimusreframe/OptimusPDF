import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProHistoryStore, type ProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { planChunks } from "@/app/pdf-pro/proChunks";
import { fakeDoc, pdfFile } from "@/app/pdf-pro/proTestUtils";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

/**
 * Wave 10 · C-B3 · deshacer/rehacer EN FRIO (el paso esta en disco, no en RAM) con un documento grande: la lectura copia
 * de la RAM lo que comparte con los snapshots residentes y solo pide a IndexedDB lo distinto, un segundo deshacer que
 * llega antes de que termine la lectura del vecino ESPERA esa lectura (no lanza otra), y en todos los casos cada paso
 * vuelve con sus bytes EXACTOS (SHA-256 de cada uno tras 30 operaciones, en los dos sentidos y con saltos).
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

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** `steps` + 1 versiones de un PDF «grande»: cada una cambia unos pocos bytes sueltos de la anterior (como una rotacion). */
function versions(steps: number, size = 5 * MB): Uint8Array[] {
  const out: Uint8Array[] = [noise(size, 7)];
  for (let i = 1; i <= steps; i += 1) {
    const next = out[i - 1].slice();
    next[(i * 700_001) % size] ^= 0xff;
    next[(i * 1_300_003 + 17) % size] ^= 0x55;
    next[(i * 2_100_007 + 5) % size] ^= 0x0f;
    out.push(next);
  }
  return out;
}

const stores: ProHistoryStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.dispose();
});

/** Documento con la ventana caliente de SIEMPRE para un PDF de ~100 MB (solo caben el actual y el anterior). */
async function build(list: Uint8Array[], options: { wrap?: (store: ProHistoryStore) => ProHistoryStore } = {}) {
  const real = createProHistoryStore({ openTimeoutMs: 2000 });
  if (!real) throw new Error("sin IndexedDB");
  stores.push(real);
  const store = options.wrap ? options.wrap(real) : real;
  const doc = fakeDoc({ historyStore: store, hotBytes: 6 * MB });
  await doc.open(pdfFile(list[0]), { pageCount: 3 });
  for (let i = 1; i < list.length; i += 1) await doc.commit(list[i], `P${i}`, "operation", { pageCount: 3 });
  return { doc, store, real };
}

const cursorOf = (doc: ProWorkingDoc) => doc.getState().document!.cursor;
async function arrive(doc: ProWorkingDoc, step: number) {
  await vi.waitFor(() => expect(cursorOf(doc)).toBe(step), { timeout: 8000, interval: 5 });
  await vi.waitFor(() => expect(doc.getState().restoring).toBe(false), { timeout: 8000, interval: 5 });
}

/** Cuenta las filas de trozos que se piden a IndexedDB. */
function countChunkReads() {
  const stats = { chunkGets: 0 };
  const original = IDBObjectStore.prototype.get;
  vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    if (typeof args[0] === "string" && args[0].startsWith("~c:")) stats.chunkGets += 1;
    return original.apply(this, args);
  });
  return stats;
}

/** Espera a que los planes de los snapshots residentes esten calculados (en el navegador lo hace el documento en reposo). */
async function planResident(doc: ProWorkingDoc) {
  for (const snapshot of doc.getState().document!.snapshots) if (!snapshot.offloaded) await planChunks(snapshot.bytes);
}

describe("deshacer y rehacer en frio con un documento grande", () => {
  it("30 operaciones: cada paso vuelve con su SHA-256 exacto al deshacer hasta el original, rehacer hasta el final y saltar", async () => {
    const list = versions(30);
    const hashes = list.map(sha);
    const { doc } = await build(list);
    // Solo el actual y el anterior estan en RAM: todo lo demas se recupera de disco.
    expect(doc.getState().document!.snapshots.filter((snapshot) => !snapshot.offloaded)).toHaveLength(2);
    const last = list.length - 1;
    expect(sha(doc.current()!)).toBe(hashes[last]);

    for (let step = last - 1; step >= 0; step -= 1) {
      await planResident(doc);
      expect(doc.undo()).toBe(true);
      await arrive(doc, step);
      expect(sha(doc.current()!), `deshacer al paso ${step}`).toBe(hashes[step]);
    }
    expect(doc.undo()).toBe(false);

    for (let step = 1; step <= last; step += 1) {
      await planResident(doc);
      expect(doc.redo()).toBe(true);
      await arrive(doc, step);
      expect(sha(doc.current()!), `rehacer al paso ${step}`).toBe(hashes[step]);
    }
    expect(doc.redo()).toBe(false);

    // Saltos largos en ambos sentidos (y a un paso intermedio) con los planes ya conocidos.
    for (const target of [0, last, 13, 2, 27, 14, 0, last]) {
      await planResident(doc);
      expect(doc.goTo(target) || cursorOf(doc) === target).toBe(true);
      await arrive(doc, target);
      expect(sha(doc.current()!), `salto al paso ${target}`).toBe(hashes[target]);
    }
  }, 60_000);

  it("rehacer en frio con los residentes ya calculados lee de disco una fraccion de los trozos, no todos", async () => {
    const list = versions(8);
    const { doc } = await build(list);
    await arrive(doc, 8);
    // Se deshace hasta el principio: ahora los residentes son el original y el paso 1; rehacer pide el paso 2 (frio).
    expect(doc.goTo(0)).toBe(true);
    await arrive(doc, 0);
    await planResident(doc);
    const total = (await planChunks(list[2])).hashes.length;
    expect(total).toBeGreaterThan(80);
    const stats = countChunkReads();
    expect(doc.goTo(2)).toBe(true);
    await arrive(doc, 2);
    expect(sha(doc.current()!)).toBe(sha(list[2]));
    // 6 bytes distintos respecto del original: a lo sumo 6 trozos; sin copiar de la RAM habria que leer los `total`.
    expect(stats.chunkGets).toBeGreaterThan(0);
    expect(stats.chunkGets).toBeLessThanOrEqual(12);
    expect(stats.chunkGets).toBeLessThan(total / 5);
  }, 30_000);

  it("sin planes calculados la lectura sigue siendo correcta (lee todo de disco)", async () => {
    const list = versions(5);
    const { doc } = await build(list);
    await arrive(doc, 5);
    const stats = countChunkReads();
    expect(doc.goTo(1)).toBe(true);
    await arrive(doc, 1);
    expect(sha(doc.current()!)).toBe(sha(list[1]));
    expect(stats.chunkGets).toBeGreaterThan(0);
  }, 30_000);

  it("dos deshacer seguidos antes de que termine la lectura del vecino la COMPARTEN: el disco se lee una vez por paso", async () => {
    const list = versions(6);
    const gets: string[] = [];
    const { doc, real } = await build(list, {
      wrap: (store) => ({
        ...store,
        get: (id: string, resident?: readonly Uint8Array[]) => {
          gets.push(id);
          return store.get(id, resident);
        },
      }),
    });
    await arrive(doc, 6);
    void real;
    gets.length = 0;
    expect(doc.undo()).toBe(true); // al paso 5 (residente): el reequilibrio trae por adelantado el 4
    expect(doc.undo()).toBe(true); // al 4 antes de que llegue: debe esperar esa misma lectura
    await arrive(doc, 4);
    expect(sha(doc.current()!)).toBe(sha(list[4]));
    const fourId = doc.getState().document!.snapshots[4].id;
    expect(gets.filter((id) => id === fourId)).toHaveLength(1);
    // Y cada id se pidio como mucho una vez en toda la racha.
    expect(new Set(gets).size).toBe(gets.length);
  }, 30_000);

  it("una lectura que falla (trozo ausente en disco) sigue retirando el paso con aviso y no deja el documento colgado", async () => {
    const list = versions(4);
    const { doc, real } = await build(list);
    await arrive(doc, 4);
    // Se borran de disco los trozos de todos los pasos intermedios: ninguno se puede recuperar.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(real.name);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("snapshots", "readwrite");
        tx.objectStore("snapshots").clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(doc.goTo(1)).toBe(true);
    await vi.waitFor(() => expect(doc.getState().restoring).toBe(false), { timeout: 8000, interval: 5 });
    expect(doc.getState().document!.historyOffloadFailed).toBe(true);
    // El paso perdido sale de la lista (el cursor sigue en el ultimo, que esta en RAM y no se toco).
    expect(doc.getState().document!.snapshots).toHaveLength(list.length - 1);
    expect(cursorOf(doc)).toBe(list.length - 2);
    expect(sha(doc.current()!)).toBe(sha(list[4]));
    expect(doc.getState().announcement?.text).toContain("P1");
  }, 30_000);
});
