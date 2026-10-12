import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PRO_DRAFTS,
  MAX_PRO_DRAFTS_TOTAL_BYTES,
  MAX_PRO_DRAFT_BYTES,
  PRO_DRAFT_SCHEMA,
  __closeWarmProDraftsConnectionForTests,
  __hasWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  __setProDraftsBlockedTimeoutForTests,
  __setProDraftsLimitsForTests,
  clearAllProDrafts,
  clearLocalProData,
  deleteProDraft,
  isProDraftMeta,
  listProDrafts,
  loadProDraft,
  proDraftsSupported,
  saveProDraft,
  subscribeToProDrafts,
  warmProDraftsConnection,
  type SaveProDraftParams,
} from "@/app/pdf-pro/proDrafts";
import { fakeBytes } from "@/app/pdf-pro/proTestUtils";

const DB_NAME = "optimuspdf-pro-drafts";
const MB = 1024 * 1024;
const idOf = (n: number) => n.toString(16).padStart(64, "0");

const history = [
  { label: "Original", createdAt: 1, source: "open" as const },
  { label: "Rotar todas las páginas 90°", createdAt: 2, source: "operation" as const, opId: "rotate-all" },
];

function params(n: number, patch: Partial<SaveProDraftParams> = {}): SaveProDraftParams {
  return {
    id: idOf(n),
    fileName: `doc-${n}.pdf`,
    bytes: fakeBytes(64, n),
    snapshotId: `snap-${n}-1`,
    history,
    pageCount: 3,
    currentPage: 1,
    ...patch,
  };
}

function rawKeys(store: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
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

beforeEach(async () => {
  __resetProDraftsMemoryForTests();
  __setProDraftsLimitsForTests();
  __closeWarmProDraftsConnectionForTests();
  await clearAllProDrafts();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("constantes", () => {
  it("limites: 10 borradores, 300 MB en total y 150 MB por borrador", () => {
    expect(MAX_PRO_DRAFTS).toBe(10);
    expect(MAX_PRO_DRAFTS_TOTAL_BYTES).toBe(300 * MB);
    expect(MAX_PRO_DRAFT_BYTES).toBe(150 * MB);
    expect(PRO_DRAFT_SCHEMA).toBe(1);
  });

  it("la base es propia de PDF Pro (no comparte con editor ni Firmar)", async () => {
    await saveProDraft(params(1));
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toContain(DB_NAME);
    expect(DB_NAME).not.toBe("optimuspdf-edit-drafts");
  });

  it("proDraftsSupported exige IndexedDB y crypto.subtle", () => {
    expect(proDraftsSupported()).toBe(true);
    vi.stubGlobal("indexedDB", undefined);
    expect(proDraftsSupported()).toBe(false);
  });
});

describe("guardar y cargar", () => {
  it("round-trip: bytes, historial ligero, pagina y nombre", async () => {
    const p = params(1);
    await expect(saveProDraft(p)).resolves.toEqual({ ok: true });
    const loaded = await loadProDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    expect(Array.from(loaded.draft.bytes)).toEqual(Array.from(p.bytes));
    expect(loaded.draft.history).toEqual(history);
    expect(loaded.draft.meta).toMatchObject({
      id: idOf(1),
      fileName: "doc-1.pdf",
      pageCount: 3,
      currentPage: 1,
      steps: 1,
      fileSize: 64,
      schema: 1,
    });
  });

  it("el historial se guarda LIGERO: solo etiquetas, fechas y punteros, sin bytes de los pasos", async () => {
    await saveProDraft(params(1));
    const loaded = await loadProDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    for (const note of loaded.draft.history) {
      expect(Object.keys(note).sort()).toEqual(Object.keys(note).filter((k) => ["label", "createdAt", "source", "opId"].includes(k)).sort());
      expect(note).not.toHaveProperty("bytes");
    }
    // Solo hay UNA fila de bytes por documento: la del snapshot actual.
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
  });

  it("guardar de nuevo el mismo documento lo ACTUALIZA (un borrador por documento)", async () => {
    await saveProDraft(params(1, { fileName: "viejo.pdf" }));
    await saveProDraft(params(1, { fileName: "nuevo.pdf", snapshotId: "snap-1-2", bytes: fakeBytes(80) }));
    const list = await listProDrafts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ fileName: "nuevo.pdf", fileSize: 80 });
  });

  it("no reescribe los bytes si el snapshot es el mismo (solo los metadatos)", async () => {
    const puts: string[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      puts.push(this.name);
      return original.apply(this, args as Parameters<typeof original>);
    });
    await saveProDraft(params(1));
    await saveProDraft(params(1, { currentPage: 2 }));
    expect(puts.filter((name) => name === "draftFiles")).toHaveLength(1);
    expect(puts.filter((name) => name === "draftMeta")).toHaveLength(2);
  });

  it("un snapshot nuevo SI reescribe los bytes", async () => {
    const puts: string[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      puts.push(this.name);
      return original.apply(this, args as Parameters<typeof original>);
    });
    await saveProDraft(params(1));
    await saveProDraft(params(1, { snapshotId: "snap-1-2", bytes: fakeBytes(70) }));
    expect(puts.filter((name) => name === "draftFiles")).toHaveLength(2);
    const loaded = await loadProDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.bytes.byteLength).toBe(70);
  });

  it("un id que no es una huella SHA-256 se rechaza (invalid)", async () => {
    await expect(saveProDraft(params(1, { id: "no-es-huella" }))).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(loadProDraft("no-es-huella")).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(deleteProDraft("no-es-huella")).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("cargar un borrador que no existe es notFound", async () => {
    await expect(loadProDraft(idOf(9))).resolves.toEqual({ ok: false, reason: "notFound" });
  });

  it("las notas del historial se copian (no se guarda ningun campo extra)", async () => {
    await saveProDraft(params(1, { history: [{ label: "A", createdAt: 5, source: "mode-apply", ...( { bytes: fakeBytes(9) } as object) }] }));
    const loaded = await loadProDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.history).toEqual([{ label: "A", createdAt: 5, source: "mode-apply" }]);
  });
});

describe("listar, borrar y vaciar", () => {
  it("lista del mas reciente al mas antiguo", async () => {
    await saveProDraft(params(1));
    await saveProDraft(params(2));
    await saveProDraft(params(3));
    expect((await listProDrafts()).map((d) => d.id)).toEqual([idOf(3), idOf(2), idOf(1)]);
  });

  it("deleteProDraft quita bytes y metadatos", async () => {
    await saveProDraft(params(1));
    await saveProDraft(params(2));
    await expect(deleteProDraft(idOf(1))).resolves.toEqual({ ok: true });
    expect((await listProDrafts()).map((d) => d.id)).toEqual([idOf(2)]);
    expect(await rawKeys("draftFiles")).toEqual([idOf(2)]);
  });

  it("borrar uno que no existe es ok", async () => {
    await expect(deleteProDraft(idOf(7))).resolves.toEqual({ ok: true });
  });

  it("clearAllProDrafts vacia ambos almacenes", async () => {
    await saveProDraft(params(1));
    await saveProDraft(params(2));
    await expect(clearAllProDrafts()).resolves.toEqual({ ok: true });
    expect(await listProDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("clearLocalProData: lista vacia si todo va bien, [proDrafts] si la base esta rota", async () => {
    await saveProDraft(params(1));
    await expect(clearLocalProData()).resolves.toEqual([]);
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("SecurityError");
      },
    });
    await expect(clearLocalProData()).resolves.toEqual(["proDrafts"]);
  });

  it("tras vaciar, un guardado posterior vuelve a escribir los bytes (no se fia de su memoria)", async () => {
    await saveProDraft(params(1));
    await clearAllProDrafts();
    await saveProDraft(params(1));
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
  });

  it("clearAllProDrafts con la conexion de vida larga abierta tambien funciona", async () => {
    await warmProDraftsConnection();
    await expect(clearAllProDrafts()).resolves.toEqual({ ok: true });
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: true });
  });
});

describe("expulsion por presupuesto", () => {
  it("al pasar de MAX borradores se expulsa el mas ANTIGUO, nunca el recien guardado", async () => {
    __setProDraftsLimitsForTests({ maxDrafts: 3 });
    for (let n = 1; n <= 4; n += 1) await saveProDraft(params(n));
    const ids = (await listProDrafts()).map((d) => d.id);
    expect(ids).toEqual([idOf(4), idOf(3), idOf(2)]);
    expect(await rawKeys("draftFiles")).toHaveLength(3);
  });

  it("la expulsion borra tambien los bytes del expulsado", async () => {
    __setProDraftsLimitsForTests({ maxDrafts: 1 });
    await saveProDraft(params(1));
    await saveProDraft(params(2));
    expect(await rawKeys("draftFiles")).toEqual([idOf(2)]);
    expect(await rawKeys("draftMeta")).toEqual([idOf(2)]);
  });

  it("por bytes totales: expulsa hasta caber", async () => {
    __setProDraftsLimitsForTests({ maxTotalBytes: 250 });
    await saveProDraft(params(1, { bytes: fakeBytes(100) }));
    await saveProDraft(params(2, { bytes: fakeBytes(100) }));
    await saveProDraft(params(3, { bytes: fakeBytes(100) }));
    expect((await listProDrafts()).map((d) => d.id)).toEqual([idOf(3), idOf(2)]);
  });

  it("actualizar un borrador existente no expulsa a otro si sigue cabiendo", async () => {
    __setProDraftsLimitsForTests({ maxDrafts: 2 });
    await saveProDraft(params(1));
    await saveProDraft(params(2));
    await saveProDraft(params(1, { snapshotId: "snap-1-2" }));
    expect((await listProDrafts()).map((d) => d.id).sort()).toEqual([idOf(1), idOf(2)]);
  });

  it("un borrador que pesa mas que el tope por documento no se guarda (tooBig) y no deja nada", async () => {
    __setProDraftsLimitsForTests({ maxDraftBytes: 100 });
    await expect(saveProDraft(params(1, { bytes: fakeBytes(101) }))).resolves.toEqual({ ok: false, reason: "tooBig" });
    expect(await listProDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("el tope por documento incluye exactamente el limite", async () => {
    __setProDraftsLimitsForTests({ maxDraftBytes: 100 });
    await expect(saveProDraft(params(1, { bytes: fakeBytes(100) }))).resolves.toEqual({ ok: true });
  });

  it("barre los archivos huerfanos (bytes sin metadatos) al guardar", async () => {
    await saveProDraft(params(1));
    await saveProDraft(params(2));
    await rawDelete("draftMeta", idOf(1));
    await saveProDraft(params(3));
    expect((await rawKeys("draftFiles")).sort()).toEqual([idOf(2), idOf(3)]);
  });
});

describe("borradores corruptos o a medias", () => {
  it("faltan los bytes (expulsados por el navegador): corrupt y se limpia la fila", async () => {
    await saveProDraft(params(1));
    await rawDelete("draftFiles", idOf(1));
    await expect(loadProDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await listProDrafts()).toEqual([]);
  });

  it("metadatos con otra forma: corrupt y se purga", async () => {
    await saveProDraft(params(1));
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("draftMeta", "readwrite");
        tx.objectStore("draftMeta").put({ id: idOf(1), schema: 99 });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    await expect(loadProDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("isProDraftMeta valida la forma completa", () => {
    const meta = {
      schema: 1,
      id: idOf(1),
      fileName: "a.pdf",
      fileSize: 1,
      savedAt: "2026-10-11T00:00:00.000Z",
      pageCount: 2,
      currentPage: 0,
      steps: 0,
      history: [],
    };
    expect(isProDraftMeta(meta)).toBe(true);
    expect(isProDraftMeta({ ...meta, schema: 2 })).toBe(false);
    expect(isProDraftMeta({ ...meta, id: "x" })).toBe(false);
    expect(isProDraftMeta({ ...meta, history: [{ label: 1 }] })).toBe(false);
    expect(isProDraftMeta({ ...meta, history: [{ label: "a", createdAt: 1, source: "otro" }] })).toBe(false);
    expect(isProDraftMeta({ ...meta, pageCount: null })).toBe(true);
    expect(isProDraftMeta(null)).toBe(false);
    expect(isProDraftMeta([])).toBe(false);
  });
});

describe("guardados superados", () => {
  it("isCurrent() = false justo antes de escribir: superseded y no se escribe nada", async () => {
    await expect(saveProDraft(params(1, { isCurrent: () => false }))).resolves.toEqual({ ok: false, reason: "superseded" });
    expect(await listProDrafts()).toEqual([]);
  });

  it("con la conexion de vida larga tambien respeta isCurrent (cae al camino normal y calla)", async () => {
    await warmProDraftsConnection();
    await expect(saveProDraft(params(1, { isCurrent: () => false }))).resolves.toEqual({ ok: false, reason: "superseded" });
    expect(await listProDrafts()).toEqual([]);
  });
});

describe("otra pestana (BroadcastChannel)", () => {
  it("guardar y borrar avisan por optimuspdf.pro-drafts", async () => {
    const other = new BroadcastChannel("optimuspdf.pro-drafts");
    const received: unknown[] = [];
    other.onmessage = (event) => received.push(event.data);
    await saveProDraft(params(1));
    await deleteProDraft(idOf(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    other.close();
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it("un aviso de otra pestana refresca a los oyentes y esta pestana vuelve a escribir los bytes", async () => {
    const puts: string[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      puts.push(`${this.name}:${(args[0] as { id: string }).id}`);
      return original.apply(this, args as Parameters<typeof original>);
    });
    const listener = vi.fn();
    const stop = subscribeToProDrafts(listener);
    await saveProDraft(params(1));
    listener.mockClear();

    // Otra pestana lo borra y lo anuncia.
    await rawDelete("draftFiles", idOf(1));
    await rawDelete("draftMeta", idOf(1));
    const other = new BroadcastChannel("optimuspdf.pro-drafts");
    other.postMessage("changed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    other.close();
    expect(listener).toHaveBeenCalled();

    await saveProDraft(params(1));
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
    expect(puts.filter((p) => p === `draftFiles:${idOf(1)}`)).toHaveLength(2);
    stop();
  });

  it("los oyentes de esta pestana tambien se avisan al guardar", async () => {
    const listener = vi.fn();
    const stop = subscribeToProDrafts(listener);
    await saveProDraft(params(1));
    expect(listener).toHaveBeenCalled();
    stop();
    listener.mockClear();
    await saveProDraft(params(2));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("IndexedDB no disponible, bloqueada o con cuota agotada: nada lanza", () => {
  it("sin IndexedDB: resultados tipados, lista vacia y borrar es ok", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: false, reason: "unsupported" });
    await expect(loadProDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unsupported" });
    await expect(listProDrafts()).resolves.toEqual([]);
    await expect(deleteProDraft(idOf(1))).resolves.toEqual({ ok: true });
    await expect(clearAllProDrafts()).resolves.toEqual({ ok: true });
  });

  it("indexedDB.open lanza (modo privado): unavailable en todo", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("SecurityError");
      },
    });
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(loadProDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(listProDrafts()).resolves.toEqual([]);
    await expect(deleteProDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(clearAllProDrafts()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("apertura bloqueada por otra pestana: se abandona tras el plazo sin colgarse", async () => {
    __setProDraftsBlockedTimeoutForTests(40);
    vi.stubGlobal("indexedDB", {
      open: () => {
        const request: { onblocked?: () => void } = {};
        setTimeout(() => request.onblocked?.(), 0);
        return request;
      },
    });
    const started = Date.now();
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(clearAllProDrafts()).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("apertura que nunca responde: tambien se abandona por plazo", async () => {
    __setProDraftsBlockedTimeoutForTests(40);
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    await expect(loadProDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("cuota agotada al escribir: quota y NO queda nada a medias", async () => {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("cuota", "QuotaExceededError");
    });
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: false, reason: "quota" });
    vi.restoreAllMocks();
    expect(await listProDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("cuota agotada con la conexion de vida larga: tambien quota, sin descartar la conexion buena", async () => {
    await warmProDraftsConnection();
    expect(__hasWarmProDraftsConnectionForTests()).toBe(true);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("cuota", "QuotaExceededError");
    });
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: false, reason: "quota" });
    vi.restoreAllMocks();
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: true });
  });

  it("un fallo no clasificado al escribir es unavailable y el borrador anterior sigue intacto", async () => {
    await saveProDraft(params(1, { fileName: "viejo.pdf" }));
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new Error("fallo raro");
    });
    await expect(saveProDraft(params(1, { fileName: "nuevo.pdf", snapshotId: "snap-1-9" }))).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    vi.restoreAllMocks();
    const loaded = await loadProDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.meta.fileName).toBe("viejo.pdf");
  });

  it("onversionchange: la conexion de vida larga se aparta y no bloquea a una pestana mas nueva", async () => {
    await saveProDraft(params(1));
    await warmProDraftsConnection();
    expect(__hasWarmProDraftsConnectionForTests()).toBe(true);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onblocked = () => reject(new Error("bloqueada por nuestra conexion"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    upgraded.close();
    expect(__hasWarmProDraftsConnectionForTests()).toBe(false);
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await expect(saveProDraft(params(1))).resolves.toEqual({ ok: true });
  });
});

describe("camino rapido (sobrevive a beforeunload)", () => {
  it("el primer guardado adopta la conexion para los siguientes", async () => {
    await saveProDraft(params(1));
    expect(__hasWarmProDraftsConnectionForTests()).toBe(true);
  });

  it("con la conexion abierta la transaccion se CREA sin esperar nada", async () => {
    await warmProDraftsConnection();
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction");
    const pending = saveProDraft(params(1));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe("readwrite");
    await pending;
  });

  it("un documento NUEVO escribe bytes y metadatos en esa misma pasada", async () => {
    await warmProDraftsConnection();
    const puts: string[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      puts.push(this.name);
      return original.apply(this, args as Parameters<typeof original>);
    });
    const pending = saveProDraft(params(1));
    expect(puts.sort()).toEqual(["draftFiles", "draftMeta"]);
    await pending;
  });
});
