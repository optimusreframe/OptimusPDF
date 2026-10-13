import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProDraftAutosaver, type ProDraftSnapshot } from "@/app/pdf-pro/proDraftAutosave";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  clearAllProDrafts,
  listProDrafts,
  loadProDraft,
} from "@/app/pdf-pro/proDrafts";
import { unloadGuardNeeded } from "@/app/pdf-pro/session/proLimits";

/**
 * Autoguardado con documentos GRANDES (Wave 9): el borrador se escribe troceado (plan de hashes + trozos nuevos), lo que
 * es asincrono y mas largo que un `put` suelto. Lo que no puede cambiar: sigue «pendiente» (y el aviso de cierre cierto)
 * hasta que la escritura termina, solo gana el ultimo cambio, lo borrado no resucita y el borrador queda SIEMPRE legible.
 */

const ID = "b".repeat(64);
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

const history = [{ label: "Original", createdAt: 1, source: "open" as const }];

function snap(bytes: Uint8Array, n: number, patch: Partial<ProDraftSnapshot> = {}): ProDraftSnapshot {
  return { id: ID, fileName: "grande.pdf", bytes, snapshotId: `s${n}`, history, pageCount: 3, dirty: true, ...patch };
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function chunkPuts<T>(action: () => Promise<T>): Promise<{ result: T; bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    const value = args[0] as { id?: string; data?: Uint8Array };
    if (value?.id?.startsWith("~c:") && value.data) {
      bytes += value.data.byteLength;
      count += 1;
    }
    return original.apply(this, args);
  });
  try {
    return { result: await action(), bytes, count };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  await clearAllProDrafts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Espera a que el autoguardador no tenga nada pendiente ni en vuelo. */
const idle = (saver: { isPending: () => boolean }) => vi.waitFor(() => expect(saver.isPending()).toBe(false), { timeout: 10_000, interval: 10 });

describe("autoguardado con documentos grandes", () => {
  it("una racha de cambios escribe UNA vez (el ultimo) y solo los trozos nuevos respecto de lo ya guardado", async () => {
    const base = noise(6 * MB, 1);
    const saver = createProDraftAutosaver({ debounceMs: 30 });
    saver.schedule(snap(base, 0));
    await idle(saver);
    const versions = [base];
    for (let i = 1; i <= 5; i += 1) {
      const next = versions[i - 1].slice();
      next[(i * 977_001) % next.length] ^= 0xff;
      versions.push(next);
    }
    const { count, bytes } = await chunkPuts(async () => {
      for (let i = 1; i <= 5; i += 1) {
        saver.schedule(snap(versions[i], i));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await idle(saver);
    });
    // Cinco cambios seguidos = una sola escritura, con los trozos de los cambios acumulados (~5 trozos como mucho).
    expect(count).toBeLessThanOrEqual(10);
    expect(bytes).toBeLessThan(2 * MB);
    const loaded = await loadProDraft(ID);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(same(loaded.draft.bytes, versions[5])).toBe(true);
    saver.dispose({ flush: false });
  });

  it("sigue PENDIENTE (y el aviso de cierre es cierto) hasta que la escritura troceada termina", async () => {
    const saver = createProDraftAutosaver({ debounceMs: 20 });
    const bytes = noise(6 * MB, 2);
    saver.schedule(snap(bytes, 1));
    const guard = () =>
      unloadGuardNeeded({ dirty: true, autosaveEnabled: true, autosaveSupported: true, autosaveFailed: false, wasEncrypted: false, currentBytes: bytes.byteLength, draftWritePending: saver.isPending() });
    expect(saver.isPending()).toBe(true);
    expect(guard()).toBe(true);
    // Pasa el debounce: el plan de trozos y la escritura estan en curso, y NADA ha terminado aun.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await listProDrafts()).length === 0 ? saver.isPending() : true).toBe(true);
    await idle(saver);
    expect(guard()).toBe(false);
    const loaded = await loadProDraft(ID);
    expect(loaded.ok).toBe(true);
    saver.dispose({ flush: false });
  });

  it("un cambio que llega MIENTRAS se calcula el plan del anterior: el anterior calla y gana el nuevo", async () => {
    const saver = createProDraftAutosaver({ debounceMs: 5 });
    const first = noise(6 * MB, 3);
    const second = first.slice();
    second[3 * MB] ^= 0xff;
    saver.schedule(snap(first, 1));
    await new Promise((resolve) => setTimeout(resolve, 15)); // el debounce ya paso: la escritura del primero esta en curso
    saver.schedule(snap(second, 2));
    await idle(saver);
    const loaded = await loadProDraft(ID);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(same(loaded.draft.bytes, second)).toBe(true);
    saver.dispose({ flush: false });
  });

  it("discard durante la escritura: lo borrado NO resucita (ni el manifiesto ni sus trozos)", async () => {
    const saver = createProDraftAutosaver({ debounceMs: 5 });
    saver.schedule(snap(noise(6 * MB, 4), 1));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await saver.discard(ID);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vi.waitFor(async () => expect(await listProDrafts()).toEqual([]), { timeout: 5000 });
    const keys = await new Promise<string[]>((resolve) => {
      const open = indexedDB.open("optimuspdf-pro-drafts");
      open.onsuccess = () => {
        const db = open.result;
        const request = db.transaction("draftFiles").objectStore("draftFiles").getAllKeys();
        request.onsuccess = () => {
          db.close();
          resolve(request.result as string[]);
        };
      };
    });
    expect(keys).toEqual([]);
    saver.dispose({ flush: false });
  });

  it("dispose con flush vuelca lo pendiente grande (cerrar la suite no pierde el ultimo cambio)", async () => {
    const saver = createProDraftAutosaver({ debounceMs: 10_000 });
    const bytes = noise(6 * MB, 5);
    saver.schedule(snap(bytes, 1));
    saver.dispose();
    await vi.waitFor(async () => {
      const loaded = await loadProDraft(ID);
      expect(loaded.ok).toBe(true);
    }, { timeout: 10_000, interval: 20 });
    const loaded = await loadProDraft(ID);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(same(loaded.draft.bytes, bytes)).toBe(true);
  });

  it("volver al estado limpio (dirty=false) retira el borrador troceado entero", async () => {
    const saver = createProDraftAutosaver({ debounceMs: 10 });
    saver.schedule(snap(noise(6 * MB, 6), 1));
    await idle(saver);
    expect((await listProDrafts()).length).toBe(1);
    saver.schedule(snap(noise(6 * MB, 6), 1, { dirty: false }));
    await idle(saver);
    await vi.waitFor(async () => expect(await listProDrafts()).toEqual([]), { timeout: 5000 });
    saver.dispose({ flush: false });
  });

  it("un fallo de escritura (cuota) se informa y NO estropea el borrador anterior; el siguiente cambio vuelve a guardar", async () => {
    const results: string[] = [];
    const saver = createProDraftAutosaver({ debounceMs: 5, onResult: (result) => results.push(result.ok ? "ok" : result.reason) });
    const first = noise(6 * MB, 7);
    saver.schedule(snap(first, 1));
    await idle(saver);
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      calls += 1;
      if (calls === 3) throw new DOMException("sin espacio", "QuotaExceededError");
      return original.apply(this, args);
    });
    const second = noise(6 * MB, 8);
    saver.schedule(snap(second, 2));
    await idle(saver);
    spy.mockRestore();
    expect(results.at(-1)).toBe("quota");
    const afterFailure = await loadProDraft(ID);
    if (!afterFailure.ok) throw new Error(afterFailure.reason);
    expect(same(afterFailure.draft.bytes, first)).toBe(true);
    saver.schedule(snap(second, 3));
    await idle(saver);
    expect(results.at(-1)).toBe("ok");
    const recovered = await loadProDraft(ID);
    if (!recovered.ok) throw new Error(recovered.reason);
    expect(same(recovered.draft.bytes, second)).toBe(true);
    saver.dispose({ flush: false });
  });
});
