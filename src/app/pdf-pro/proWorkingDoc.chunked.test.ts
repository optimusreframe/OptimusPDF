import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";
import { pdfFile } from "@/app/pdf-pro/proTestUtils";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { limitWarnings } from "@/app/pdf-pro/session/proLimits";

// Espia de `planChunks` (llamadas con los bytes concretos): los calculos en segundo plano de un test anterior no la ensucian.
const planSpy = vi.hoisted(() => ({ calls: [] as Uint8Array[] }));
vi.mock("@/app/pdf-pro/proChunks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/pdf-pro/proChunks")>();
  return {
    ...actual,
    planChunks: (bytes: Uint8Array) => {
      planSpy.calls.push(bytes);
      return actual.planChunks(bytes);
    },
  };
});

/**
 * Wave 9 · historial en disco con snapshots TROCEADOS (almacen real sobre fake-indexeddb): cada paso de un PDF grande se
 * parece al anterior, asi que se escribe solo lo que cambia; y aun asi deshacer/rehacer devuelve SIEMPRE los bytes
 * exactos, tambien tras agotarse la cuota (el documento degrada con aviso y no pierde ningun paso).
 */

const MB = 1024 * 1024;
const S = PRO_STRINGS.es.announce;

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

const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** `steps` versiones de un mismo PDF «grande»: cada una cambia un puñado de bytes respecto de la anterior. */
function versions(steps: number, size = 5 * MB): Uint8Array[] {
  const out: Uint8Array[] = [noise(size, 3)];
  for (let i = 1; i <= steps; i += 1) {
    const next = out[i - 1].slice();
    next[(i * 700_001) % size] ^= 0xff;
    next[(i * 1_300_003) % size] ^= 0x55;
    out.push(next);
  }
  return out;
}

const stores: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.dispose();
});

async function build(versionsList: Uint8Array[], options: { hotBytes?: number } = {}) {
  const store = createProHistoryStore({ openTimeoutMs: 2000 });
  if (!store) throw new Error("sin IndexedDB");
  stores.push(store);
  const doc = fakeDoc({ historyStore: store, hotBytes: options.hotBytes ?? 6 * MB });
  await doc.open(pdfFile(versionsList[0]), { pageCount: 3 });
  return { doc, store };
}

async function commitAll(doc: ProWorkingDoc, versionsList: Uint8Array[]) {
  for (let i = 1; i < versionsList.length; i += 1) {
    await doc.commit(versionsList[i], `P${i}`, "operation", { pageCount: 3 });
  }
}

async function settled(doc: ProWorkingDoc) {
  await vi.waitFor(() => expect(doc.getState().restoring).toBe(false), { timeout: 5000, interval: 5 });
}

/** Deshace hasta el principio comprobando que cada paso devuelve EXACTAMENTE sus bytes. */
async function walkBackExact(doc: ProWorkingDoc, versionsList: Uint8Array[]) {
  const last = versionsList.length - 1;
  expect(same(doc.current()!, versionsList[last])).toBe(true);
  for (let step = last - 1; step >= 0; step -= 1) {
    expect(doc.undo()).toBe(true);
    await vi.waitFor(() => expect(doc.getState().document!.cursor).toBe(step), { timeout: 5000, interval: 5 });
    await settled(doc);
    expect(same(doc.current()!, versionsList[step]), `paso ${step}`).toBe(true);
  }
  expect(doc.undo()).toBe(false);
}

async function walkForwardExact(doc: ProWorkingDoc, versionsList: Uint8Array[]) {
  for (let step = 1; step < versionsList.length; step += 1) {
    expect(doc.redo()).toBe(true);
    await vi.waitFor(() => expect(doc.getState().document!.cursor).toBe(step), { timeout: 5000, interval: 5 });
    await settled(doc);
    expect(same(doc.current()!, versionsList[step]), `paso ${step}`).toBe(true);
  }
  expect(doc.redo()).toBe(false);
}

describe("historial en disco con snapshots troceados", () => {
  it("deshacer hasta el principio y rehacer hasta el final devuelve los bytes EXACTOS de cada paso", async () => {
    const list = versions(6);
    const { doc } = await build(list);
    await commitAll(doc, list);
    const snapshots = doc.getState().document!.snapshots;
    // Con ventana de 6 MB solo quedan el actual y el anterior: el resto esta en disco.
    expect(snapshots.filter((s) => s.offloaded).length).toBeGreaterThanOrEqual(4);
    expect(doc.getState().document!.historyOffloadFailed).toBeUndefined();
    await walkBackExact(doc, list);
    await walkForwardExact(doc, list);
  });

  it("un salto largo al original y de vuelta al ultimo tambien es exacto", async () => {
    const list = versions(6);
    const { doc } = await build(list);
    await commitAll(doc, list);
    expect(doc.goTo(0)).toBe(true);
    await vi.waitFor(() => expect(doc.getState().document!.cursor).toBe(0), { timeout: 5000, interval: 5 });
    expect(same(doc.current()!, list[0])).toBe(true);
    expect(doc.goTo(list.length - 1)).toBe(true);
    await vi.waitFor(() => expect(doc.getState().document!.cursor).toBe(list.length - 1), { timeout: 5000, interval: 5 });
    expect(same(doc.current()!, list[list.length - 1])).toBe(true);
  });

  it("escribe a disco SOLO lo que cambia: 6 pasos de 5 MB no escriben 6 × 5 MB", async () => {
    const list = versions(6);
    const written: number[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      const value = args[0] as { id?: string; data?: Uint8Array };
      if (value?.id?.startsWith("~c:") && value.data) written.push(value.data.byteLength);
      return original.apply(this, args);
    });
    const { doc } = await build(list);
    await commitAll(doc, list);
    await vi.waitFor(() => expect(doc.getState().document!.snapshots.filter((s) => s.offloaded).length).toBeGreaterThanOrEqual(4), { timeout: 5000 });
    const total = written.reduce((sum, size) => sum + size, 0);
    // El primer paso volcado se escribe entero (~5 MB); los demas solo el trozo o dos que cambian.
    expect(total).toBeLessThan(5 * MB * 1.5);
    expect(total).toBeGreaterThan(4 * MB);
  });

  it("agotar la cuota a mitad: el documento queda marcado, se anuncia y se puede deshacer hasta el principio SIN perder ningun paso", async () => {
    const list = versions(6);
    const original = IDBObjectStore.prototype.put;
    let chunkPuts = 0;
    let failing = false;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      const value = args[0] as { id?: string };
      if (value?.id?.startsWith("~c:")) {
        chunkPuts += 1;
        if (failing || chunkPuts > 108) {
          failing = true;
          throw new DOMException("sin espacio", "QuotaExceededError");
        }
      }
      return original.apply(this, args);
    });
    const { doc } = await build(list);
    const heard: string[] = [];
    doc.subscribe(() => {
      const text = doc.getState().announcement?.text;
      if (text && heard.at(-1) !== text) heard.push(text);
    });
    await commitAll(doc, list);
    await vi.waitFor(() => expect(doc.getState().document!.historyOffloadFailed).toBe(true), { timeout: 5000 });
    expect(failing).toBe(true);
    // Todos los pasos siguen en la lista (el presupuesto por bytes de lo RESIDENTE puede haber recortado alguno: lo anuncia).
    const document = doc.getState().document!;
    expect(document.snapshots.length + document.trimmedCount).toBe(list.length);
    // Se AVISO: en la region viva (en el momento del fallo) y, de forma permanente, en el panel de limites.
    expect(heard.some((text) => text.includes(S.historyOffloadFailed))).toBe(true);
    expect(limitWarnings(document).some((warning) => warning.code === "historyOffloadUnavailable")).toBe(true);
    // Deshacer recorre los pasos que quedan y cada uno devuelve sus bytes exactos (los de disco y los de RAM).
    const labels: string[] = [];
    for (;;) {
      const cursor = doc.getState().document!.cursor;
      const snapshot = doc.getState().document!.snapshots[cursor];
      const index = Number(snapshot.label.replace("P", "")) || 0;
      expect(same(doc.current()!, list[snapshot.label === "Original" ? 0 : index]), `paso ${snapshot.label}`).toBe(true);
      labels.push(snapshot.label);
      if (!doc.undo()) break;
      await vi.waitFor(() => expect(doc.getState().document!.cursor).toBe(cursor - 1), { timeout: 5000, interval: 5 });
      await settled(doc);
    }
    expect(labels.at(-1)).toBe("Original");
    expect(same(doc.current()!, list[0])).toBe(true);
  });

  it("cerrar el documento vacia por completo el disco (manifiestos y trozos)", async () => {
    const list = versions(4);
    const { doc, store } = await build(list);
    await commitAll(doc, list);
    await vi.waitFor(() => expect(doc.getState().document!.snapshots.some((s) => s.offloaded)).toBe(true));
    doc.close();
    await vi.waitFor(async () => {
      const keys = await new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open(store.name);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("snapshots")) {
            db.close();
            resolve([]);
            return;
          }
          const request = db.transaction("snapshots").objectStore("snapshots").getAllKeys();
          request.onsuccess = () => {
            db.close();
            resolve(request.result as string[]);
          };
          request.onerror = () => reject(request.error);
        };
        open.onerror = () => reject(open.error);
      });
      expect(keys).toEqual([]);
    });
  });

  it("el plan de trozos de un snapshot grande se calcula en segundo plano al nacer (abrir y confirmar), no cuando hace falta", async () => {
    const list = versions(2);
    const { doc } = await build(list);
    const opened = doc.currentSnapshot()!.bytes;
    // No bloquea la apertura: el calculo se aplaza hasta que el navegador este ocioso...
    expect(planSpy.calls).not.toContain(opened);
    // ...y arranca sin que nadie lo pida.
    await vi.waitFor(() => expect(planSpy.calls).toContain(opened), { timeout: 3000, interval: 10 });
    const next = list[1];
    await doc.commit(next, "P1", "operation", { pageCount: 3 });
    await vi.waitFor(() => expect(planSpy.calls).toContain(next), { timeout: 3000, interval: 10 });
  });

  it("un snapshot pequeño no calcula ningun plan (no hay nada que trocear)", async () => {
    const small = noise(3000, 1);
    const { doc } = await build([small]);
    const next = noise(3000, 2);
    await doc.commit(next, "P1", "operation", { pageCount: 3 });
    expect(planSpy.calls).not.toContain(doc.currentSnapshot()!.bytes);
    expect(planSpy.calls).not.toContain(next);
  });

  it("un documento pequeño sigue sin volcar nada y sin tocar el disco", async () => {
    const { doc } = await build([noise(2000, 1)], { hotBytes: 6 * MB });
    for (let i = 1; i <= 5; i += 1) await doc.commit(noise(2000, i + 1), `P${i}`, "operation", { pageCount: 3 });
    expect(doc.getState().document!.snapshots.every((s) => !s.offloaded)).toBe(true);
    expect(fakeFile).toBeDefined();
  });
});
