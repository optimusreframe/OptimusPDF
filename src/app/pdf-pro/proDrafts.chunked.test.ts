import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  __setProDraftsLimitsForTests,
  clearAllProDrafts,
  deleteProDraft,
  listProDrafts,
  loadProDraft,
  saveProDraft,
  type SaveProDraftParams,
} from "@/app/pdf-pro/proDrafts";
import { MAX_CHUNK } from "@/app/pdf-pro/proChunks";

/**
 * Borradores de PDF Pro · bytes TROCEADOS por contenido (Wave 9): el borrador grande se guarda como trozos
 * compartidos + manifiesto; guardar un paso nuevo escribe solo lo que cambio, y NUNCA se pierde el borrador anterior
 * si una escritura falla.
 */

const DB_NAME = "optimuspdf-pro-drafts";
const MB = 1024 * 1024;
const idOf = (n: number) => n.toString(16).padStart(64, "0");
const history = [
  { label: "Original", createdAt: 1, source: "open" as const },
  { label: "Rotar", createdAt: 2, source: "operation" as const, opId: "rotate-all" },
];

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

function params(n: number, bytes: Uint8Array, snapshot = 1, patch: Partial<SaveProDraftParams> = {}): SaveProDraftParams {
  return { id: idOf(n), fileName: `doc-${n}.pdf`, bytes, snapshotId: `snap-${n}-${snapshot}`, history, pageCount: 3, currentPage: 0, ...patch };
}

function rawKeys(store: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
      request.onsuccess = () => {
        db.close();
        resolve(request.result as string[]);
      };
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

function rawDelete(store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
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
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function load(n: number) {
  const result = await loadProDraft(idOf(n));
  if (!result.ok) throw new Error(`no cargo: ${result.reason}`);
  return result.draft;
}

/** Cuenta los trozos que se piden escribir (filas `~c:`) mientras corre `action`. */
async function countChunkPuts<T>(action: () => Promise<T>): Promise<{ result: T; sizes: number[] }> {
  const sizes: number[] = [];
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    const value = args[0] as { id?: string; data?: Uint8Array };
    if (value?.id?.startsWith("~c:") && value.data) sizes.push(value.data.byteLength);
    return original.apply(this, args);
  });
  try {
    return { result: await action(), sizes };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  __resetProDraftsMemoryForTests();
  __setProDraftsLimitsForTests();
  __closeWarmProDraftsConnectionForTests();
  await clearAllProDrafts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("borradores troceados · guardar y cargar", () => {
  it("un borrador grande se guarda como trozos + manifiesto (sin fila entera) y vuelve EXACTO con su historial", async () => {
    const bytes = noise(6 * MB + 321, 1);
    await expect(saveProDraft(params(1, bytes))).resolves.toEqual({ ok: true });
    const keys = await rawKeys("draftFiles");
    expect(manifestKeys(keys)).toEqual([`~m:${idOf(1)}`]);
    expect(chunkKeys(keys).length).toBeGreaterThan(50);
    expect(keys).not.toContain(idOf(1));
    const draft = await load(1);
    expect(same(draft.bytes, bytes)).toBe(true);
    expect(draft.history).toEqual(history);
    expect(draft.meta).toMatchObject({ id: idOf(1), fileName: "doc-1.pdf", fileSize: bytes.byteLength, steps: 1, pageCount: 3 });
  });

  it("el siguiente paso, casi igual, escribe solo el trozo que cambio (no el borrador entero)", async () => {
    const first = noise(8 * MB, 2);
    await saveProDraft(params(1, first, 1));
    const second = first.slice();
    second[4 * MB + 7] ^= 0xff;
    const { sizes } = await countChunkPuts(() => saveProDraft(params(1, second, 2)));
    expect(sizes.length).toBeGreaterThanOrEqual(1);
    expect(sizes.length).toBeLessThanOrEqual(2);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(2 * MAX_CHUNK);
    expect(same((await load(1)).bytes, second)).toBe(true);
    // Los trozos del paso anterior que ya nadie nombra se barrieron: la base no crece sin fin.
    const keys = await rawKeys("draftFiles");
    const manifestCount = manifestKeys(keys).length;
    expect(manifestCount).toBe(1);
    expect(chunkKeys(keys).length).toBeLessThanOrEqual(Math.ceil((8 * MB) / (16 * 1024)) + 2);
  });

  it("guardar de nuevo el MISMO snapshot (solo cambia la pagina) no reescribe ningun trozo", async () => {
    const bytes = noise(5 * MB, 3);
    await saveProDraft(params(1, bytes, 1, { currentPage: 0 }));
    const { sizes } = await countChunkPuts(() => saveProDraft(params(1, bytes, 1, { currentPage: 7 })));
    expect(sizes).toEqual([]);
    const draft = await load(1);
    expect(draft.meta.currentPage).toBe(7);
    expect(same(draft.bytes, bytes)).toBe(true);
  });

  it("volver a un snapshot ya guardado (deshacer y rehacer) cuesta solo el manifiesto: los trozos siguen en la base", async () => {
    const a = noise(5 * MB, 4);
    const b = a.slice();
    b[2 * MB] ^= 0xff;
    await saveProDraft(params(1, a, 1));
    await saveProDraft(params(1, b, 2));
    // Los trozos exclusivos de `a` se barrieron al guardar `b`; volver a `a` los escribe (solo esos).
    const { sizes } = await countChunkPuts(() => saveProDraft(params(1, a, 3)));
    expect(sizes.length).toBeLessThanOrEqual(2);
    expect(same((await load(1)).bytes, a)).toBe(true);
  });

  it("dos borradores con casi el mismo contenido comparten trozos; borrar uno no rompe el otro", async () => {
    const base = noise(6 * MB, 5);
    const other = base.slice();
    other[3 * MB] ^= 0xff;
    await saveProDraft(params(1, base));
    const { sizes } = await countChunkPuts(() => saveProDraft(params(2, other)));
    expect(sizes.length).toBeLessThanOrEqual(2);
    await expect(deleteProDraft(idOf(1))).resolves.toEqual({ ok: true });
    expect(same((await load(2)).bytes, other)).toBe(true);
    await deleteProDraft(idOf(2));
    const keys = await rawKeys("draftFiles");
    expect(keys).toEqual([]);
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("un borrador pequeño sigue siendo UNA fila con sus bytes (formato de siempre)", async () => {
    const bytes = noise(2 * MB, 6);
    await saveProDraft(params(1, bytes));
    const keys = await rawKeys("draftFiles");
    expect(keys).toEqual([idOf(1)]);
    expect(same((await load(1)).bytes, bytes)).toBe(true);
  });

  it("un borrador de una version anterior (fila entera de >4 MB, sin trozos) se sigue leyendo y se convierte al guardar", async () => {
    __setProDraftsLimitsForTests({ chunkMinBytes: Number.POSITIVE_INFINITY });
    const old = noise(5 * MB, 7);
    await saveProDraft(params(1, old, 1));
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
    __setProDraftsLimitsForTests();
    __resetProDraftsMemoryForTests();
    expect(same((await load(1)).bytes, old)).toBe(true);
    const next = old.slice();
    next[10] ^= 1;
    await saveProDraft(params(1, next, 2));
    const keys = await rawKeys("draftFiles");
    expect(keys).not.toContain(idOf(1));
    expect(manifestKeys(keys)).toHaveLength(1);
    expect(same((await load(1)).bytes, next)).toBe(true);
  });

  it("si el documento encoge por debajo del umbral (p. ej. Comprimir) la forma entera sustituye a la troceada y se barren sus trozos", async () => {
    const big = noise(6 * MB, 8);
    await saveProDraft(params(1, big, 1));
    expect(chunkKeys(await rawKeys("draftFiles")).length).toBeGreaterThan(0);
    const small = noise(2 * MB, 9);
    await saveProDraft(params(1, small, 2));
    const keys = await rawKeys("draftFiles");
    expect(keys).toEqual([idOf(1)]);
    expect(same((await load(1)).bytes, small)).toBe(true);
  });
});

describe("borradores troceados · fallos y presupuesto", () => {
  it("si se agota la cuota a mitad de la escritura, el borrador ANTERIOR queda entero y no sobran trozos ni manifiestos", async () => {
    const v1 = noise(6 * MB, 10);
    await saveProDraft(params(1, v1, 1));
    const before = await rawKeys("draftFiles");
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      calls += 1;
      if (calls === 4) throw new DOMException("sin espacio", "QuotaExceededError");
      return original.apply(this, args);
    });
    const v2 = noise(6 * MB, 11);
    const result = await saveProDraft(params(1, v2, 2));
    vi.restoreAllMocks();
    expect(result).toEqual({ ok: false, reason: "quota" });
    expect(await rawKeys("draftFiles")).toEqual(before);
    expect(same((await load(1)).bytes, v1)).toBe(true);
    expect((await load(1)).meta.fileSize).toBe(v1.byteLength);
  });

  it("un trozo que falta: el borrador se da por corrupto, se borra con su manifiesto y no devuelve bytes parciales", async () => {
    await saveProDraft(params(1, noise(5 * MB, 12)));
    const victim = chunkKeys(await rawKeys("draftFiles"))[2];
    await rawDelete("draftFiles", victim);
    await expect(loadProDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await rawKeys("draftFiles")).toEqual([]);
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("superado mientras se calculaba el plan (llego un cambio mas reciente): no escribe nada", async () => {
    const bytes = noise(5 * MB, 13);
    let current = true;
    const pending = saveProDraft(params(1, bytes, 1, { isCurrent: () => current }));
    current = false; // el calculo del plan es asincrono: aun no habia terminado
    await expect(pending).resolves.toEqual({ ok: false, reason: "superseded" });
    expect(await rawKeys("draftFiles")).toEqual([]);
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("el presupuesto expulsa al borrador mas antiguo con su manifiesto y sus trozos exclusivos, y respeta los compartidos", async () => {
    __setProDraftsLimitsForTests({ maxDrafts: 2 });
    const a = noise(5 * MB, 14);
    const b = a.slice();
    b[1 * MB] ^= 1;
    const c = noise(5 * MB, 15);
    await saveProDraft(params(1, a));
    await saveProDraft(params(2, b));
    await saveProDraft(params(3, c));
    const listed = (await listProDrafts()).map((draft) => draft.id).sort();
    expect(listed).toEqual([idOf(2), idOf(3)]);
    const keys = await rawKeys("draftFiles");
    expect(manifestKeys(keys).sort()).toEqual([`~m:${idOf(2)}`, `~m:${idOf(3)}`]);
    // `b` comparte casi todo con `a`: sigue entero tras expulsar a `a`.
    expect(same((await load(2)).bytes, b)).toBe(true);
    expect(same((await load(3)).bytes, c)).toBe(true);
  });

  it("clearAllProDrafts vacia trozos y manifiestos", async () => {
    await saveProDraft(params(1, noise(5 * MB, 16)));
    await expect(clearAllProDrafts()).resolves.toEqual({ ok: true });
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("sin SHA-256 el borrador grande se guarda entero (no se pierde)", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const bytes = noise(5 * MB, 17);
    await expect(saveProDraft(params(1, bytes))).resolves.toEqual({ ok: true });
    vi.unstubAllGlobals();
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
    expect(same((await load(1)).bytes, bytes)).toBe(true);
  });

  it("el limite por borrador sigue mandando (tooBig) sin trocear ni escribir nada", async () => {
    __setProDraftsLimitsForTests({ maxDraftBytes: 4 * MB });
    await expect(saveProDraft(params(1, noise(5 * MB, 18)))).resolves.toEqual({ ok: false, reason: "tooBig" });
    expect(await rawKeys("draftFiles")).toEqual([]);
  });
});
