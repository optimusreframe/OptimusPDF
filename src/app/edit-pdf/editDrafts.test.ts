import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDIT_DRAFT_SCHEMA,
  MAX_EDIT_DRAFTS,
  MAX_EDIT_DRAFTS_TOTAL_BYTES,
  MAX_EDIT_DRAFT_BYTES,
  __closeWarmEditDraftsConnectionForTests,
  __hasWarmEditDraftsConnectionForTests,
  __resetEditDraftsMemoryForTests,
  __setEditDraftsBlockedTimeoutForTests,
  __setEditDraftsLimitsForTests,
  clearAllEditDrafts,
  deleteEditDraft,
  editDraftsSupported,
  fingerprintPdfBytes,
  isEditDraftMeta,
  listEditDrafts,
  loadEditDraft,
  saveEditDraft,
  subscribeToEditDrafts,
  warmEditDraftsConnection,
  type SaveEditDraftParams,
} from "@/app/edit-pdf/editDrafts";
import {
  applyOp,
  createEditSession,
  imageAddOp,
  newTextEdit,
  textItem,
  type EditSession,
} from "@/app/edit-pdf/editSession";
import type { ImageElement } from "@/lib/pdf/editPdf";

/**
 * Borradores del editor sobre `fake-indexeddb`: el mismo motor de
 * transacciones que un navegador, sin mocks a mano salvo para forzar fallos.
 */

const DB_NAME = "optimuspdf-edit-drafts";
const MB = 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

/** Huella falsa pero con la forma correcta (64 hex), distinta por numero. */
const idOf = (n: number) => n.toString(16).padStart(64, "0");

function sessionWithText(text = "Hola", withImage = false): EditSession {
  let s = applyOp(
    createEditSession(),
    {
      type: "add",
      item: textItem(
        newTextEdit({
          id: "t1",
          pageIndex: 0,
          box: { x: 10, y: 10, width: 100, height: 20 },
          fontKey: "helvetica",
          text,
        }),
      ),
    },
    0,
  );
  if (withImage) {
    const image: ImageElement = {
      type: "image",
      id: "im1",
      pageIndex: 0,
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.3,
      bytes: PNG,
      previewUrl: "data:image/png;base64,AAAA",
      ratio: 1,
    };
    s = applyOp(s, imageAddOp(image), 10_000);
  }
  return s;
}

function params(n: number, overrides: Partial<SaveEditDraftParams> = {}): SaveEditDraftParams {
  return {
    id: idOf(n),
    fileName: `doc-${n}.pdf`,
    fileBytes: new Uint8Array([1, 2, 3, n % 250]),
    session: sessionWithText(),
    pageCount: 3,
    currentPage: 1,
    ...overrides,
  };
}

async function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawKeys(store: string): Promise<string[]> {
  const db = await openRaw();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function rawPut(store: string, value: unknown): Promise<void> {
  const db = await openRaw();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(store).put(value);
    });
  } finally {
    db.close();
  }
}

async function rawDelete(store: string, key: string): Promise<void> {
  const db = await openRaw();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(store).delete(key);
    });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  __setEditDraftsBlockedTimeoutForTests(150);
  __setEditDraftsLimitsForTests();
  __closeWarmEditDraftsConnectionForTests();
  __resetEditDraftsMemoryForTests();
  await clearAllEditDrafts();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("constantes y soporte", () => {
  it("limites del plan: 10 borradores, 300 MB en total, 150 MB por documento", () => {
    expect(MAX_EDIT_DRAFTS).toBe(10);
    expect(MAX_EDIT_DRAFTS_TOTAL_BYTES).toBe(300 * MB);
    expect(MAX_EDIT_DRAFT_BYTES).toBe(150 * MB);
  });

  it("la base se llama optimuspdf-edit-drafts y tiene los dos almacenes", async () => {
    await saveEditDraft(params(1));
    const db = await openRaw();
    try {
      expect(db.name).toBe("optimuspdf-edit-drafts");
      expect([...db.objectStoreNames].sort()).toEqual(["draftFiles", "draftMeta"]);
    } finally {
      db.close();
    }
  });

  it("fingerprintPdfBytes es un SHA-256 hex estable y distinto por contenido", async () => {
    const a = await fingerprintPdfBytes(new Uint8Array([1, 2, 3]));
    const b = await fingerprintPdfBytes(new Uint8Array([1, 2, 3]));
    const c = await fingerprintPdfBytes(new Uint8Array([1, 2, 4]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // SHA-256 de «abc»: vector conocido.
    expect(await fingerprintPdfBytes(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("sin crypto.subtle no hay huella y el borrador no se ofrece", async () => {
    expect(editDraftsSupported()).toBe(true);
    vi.stubGlobal("crypto", {});
    expect(await fingerprintPdfBytes(new Uint8Array([1]))).toBeNull();
    expect(editDraftsSupported()).toBe(false);
  });

  it("si digest rechaza, la huella es null (no lanza)", async () => {
    vi.stubGlobal("crypto", {
      subtle: { digest: () => Promise.reject(new Error("boom")) },
    });
    await expect(fingerprintPdfBytes(new Uint8Array([1]))).resolves.toBeNull();
  });

  it("sin IndexedDB tampoco se ofrece", () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(editDraftsSupported()).toBe(false);
  });
});

describe("guardar y restaurar", () => {
  it("ida y vuelta: PDF, edicion, pagina y contador", async () => {
    const p = params(1);
    await expect(saveEditDraft(p)).resolves.toEqual({ ok: true });
    const loaded = await loadEditDraft(p.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(Array.from(loaded.draft.bytes)).toEqual(Array.from(p.fileBytes));
    expect(loaded.draft.session.items).toEqual(p.session.items);
    expect(loaded.draft.discarded).toBe(0);
    expect(loaded.draft.meta).toMatchObject({
      schema: EDIT_DRAFT_SCHEMA,
      id: p.id,
      fileName: "doc-1.pdf",
      fileSize: 4,
      pageCount: 3,
      currentPage: 1,
      pendingCount: 1,
    });
    // La sesion restaurada arranca con historial vacio.
    expect(loaded.draft.session.history).toHaveLength(0);
  });

  it("las imagenes van como archivos aparte (id/assetId) y se restauran con sus bytes", async () => {
    const p = params(2, { session: sessionWithText("x", true) });
    await saveEditDraft(p);
    expect((await rawKeys("draftFiles")).sort()).toEqual([p.id, `${p.id}/im1`]);
    const loaded = await loadEditDraft(p.id);
    if (!loaded.ok) throw new Error("no cargo");
    expect(Array.from(loaded.draft.session.assets.im1.bytes)).toEqual(Array.from(PNG));
    expect(loaded.draft.session.items).toHaveLength(2);
    expect(loaded.draft.meta.totalBytes).toBe(p.fileBytes.byteLength + PNG.byteLength);
  });

  it("los metadatos NO llevan bytes de imagen (se reescriben a cada cambio)", async () => {
    const p = params(3, { session: sessionWithText("x", true) });
    await saveEditDraft(p);
    const db = await openRaw();
    try {
      const meta = await new Promise<{ session: { assets: Record<string, { data?: string }> } }>((resolve, reject) => {
        const request = db.transaction("draftMeta").objectStore("draftMeta").get(p.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(meta.session.assets.im1.data).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("UN borrador por documento: guardar otra vez el mismo id actualiza, no duplica", async () => {
    await saveEditDraft(params(4));
    await saveEditDraft(params(4, { session: sessionWithText("Cambiado") }));
    const list = await listEditDrafts();
    expect(list).toHaveLength(1);
    const loaded = await loadEditDraft(idOf(4));
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.session.items[0]).toMatchObject({ edit: { text: "Cambiado" } });
  });

  it("los bytes del PDF se escriben UNA vez; los autoguardados siguientes solo reescriben metadatos", async () => {
    const puts: string[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      puts.push(`${this.name}:${(args[0] as { id: string }).id}`);
      return original.apply(this, args as Parameters<typeof original>);
    });
    await saveEditDraft(params(5));
    await saveEditDraft(params(5, { session: sessionWithText("dos") }));
    await saveEditDraft(params(5, { session: sessionWithText("tres") }));
    expect(puts.filter((p) => p === `draftFiles:${idOf(5)}`)).toHaveLength(1);
    expect(puts.filter((p) => p === `draftMeta:${idOf(5)}`)).toHaveLength(3);
  });

  it("listEditDrafts: del mas reciente al mas antiguo, sin la sesion", async () => {
    await saveEditDraft(params(1));
    await saveEditDraft(params(2));
    await saveEditDraft(params(3));
    const list = await listEditDrafts();
    expect(list.map((d) => d.id)).toEqual([idOf(3), idOf(2), idOf(1)]);
    expect("session" in list[0]).toBe(false);
    expect(list[0]).toMatchObject({ fileName: "doc-3.pdf", pendingCount: 1 });
  });

  it("savedAt crece estrictamente aunque dos guardados caigan en el mismo milisegundo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));
    await saveEditDraft(params(1));
    await saveEditDraft(params(2));
    const [newer, older] = await listEditDrafts();
    expect(newer.id).toBe(idOf(2));
    expect(newer.savedAt > older.savedAt).toBe(true);
  });

  it("ids que no son huellas se rechazan sin tocar la base", async () => {
    for (const id of ["", "abc", "../x", "A".repeat(64), `${"a".repeat(63)}/`]) {
      await expect(saveEditDraft(params(1, { id }))).resolves.toEqual({ ok: false, reason: "invalid" });
      await expect(loadEditDraft(id)).resolves.toEqual({ ok: false, reason: "invalid" });
      await expect(deleteEditDraft(id)).resolves.toEqual({ ok: false, reason: "invalid" });
    }
    expect(await listEditDrafts()).toEqual([]);
  });

  it("cargar un id que no existe -> notFound", async () => {
    await expect(loadEditDraft(idOf(99))).resolves.toEqual({ ok: false, reason: "notFound" });
  });

  it("un documento por encima del tope por borrador no se guarda (tooBig) y no deja nada", async () => {
    __setEditDraftsLimitsForTests({ maxDraftBytes: 10 });
    const big = params(1, { fileBytes: new Uint8Array(11) });
    await expect(saveEditDraft(big)).resolves.toEqual({ ok: false, reason: "tooBig" });
    expect(await listEditDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
    // Justo en el tope si cabe.
    await expect(saveEditDraft(params(1, { fileBytes: new Uint8Array(10) }))).resolves.toEqual({ ok: true });
  });

  it("las imagenes cuentan para el tope por borrador", async () => {
    __setEditDraftsLimitsForTests({ maxDraftBytes: 10 });
    const withImage = params(1, { fileBytes: new Uint8Array(5), session: sessionWithText("x", true) });
    await expect(saveEditDraft(withImage)).resolves.toEqual({ ok: false, reason: "tooBig" });
  });

  it("isEditDraftMeta rechaza lo que no tiene la forma de un borrador", () => {
    const good = {
      schema: 1,
      id: idOf(1),
      fileName: "a.pdf",
      fileSize: 1,
      totalBytes: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      pageCount: null,
      currentPage: 0,
      pendingCount: 0,
      session: { schema: 1, items: [], assets: {} },
    };
    expect(isEditDraftMeta(good)).toBe(true);
    for (const bad of [
      null,
      7,
      {},
      { ...good, schema: 2 },
      { ...good, id: "corto" },
      { ...good, totalBytes: "1" },
      { ...good, pageCount: "3" },
      { ...good, session: null },
      { ...good, session: { schema: 1, items: {}, assets: {} } },
      { ...good, session: { schema: 2, items: [], assets: {} } },
    ]) {
      expect(isEditDraftMeta(bad)).toBe(false);
    }
  });
});

describe("presupuesto: expulsion sin huerfanos", () => {
  it(`al pasar de ${MAX_EDIT_DRAFTS} borradores sale el mas antiguo con TODOS sus archivos`, async () => {
    for (let n = 1; n <= MAX_EDIT_DRAFTS + 2; n += 1) {
      await saveEditDraft(params(n, { session: sessionWithText("x", n <= 2) }));
    }
    const ids = (await listEditDrafts()).map((d) => d.id);
    expect(ids).toHaveLength(MAX_EDIT_DRAFTS);
    expect(ids).not.toContain(idOf(1));
    expect(ids).not.toContain(idOf(2));
    const files = await rawKeys("draftFiles");
    expect(files.some((key) => key.startsWith(idOf(1)))).toBe(false);
    expect(files.some((key) => key.startsWith(idOf(2)))).toBe(false); // ni sus imagenes
    expect(files).toHaveLength(MAX_EDIT_DRAFTS);
    expect(await rawKeys("draftMeta")).toHaveLength(MAX_EDIT_DRAFTS);
  });

  it("expulsa por bytes totales (PDF + imagenes), el mas antiguo primero", async () => {
    __setEditDraftsLimitsForTests({ maxTotalBytes: 100 });
    await saveEditDraft(params(1, { fileBytes: new Uint8Array(40) }));
    await saveEditDraft(params(2, { fileBytes: new Uint8Array(40) }));
    expect(await listEditDrafts()).toHaveLength(2);
    await saveEditDraft(params(3, { fileBytes: new Uint8Array(40) })); // 120 > 100
    expect((await listEditDrafts()).map((d) => d.id).sort()).toEqual([idOf(2), idOf(3)]);
    expect(await rawKeys("draftFiles")).not.toContain(idOf(1));
  });

  it("el borrador que se acaba de guardar NUNCA se expulsa a si mismo", async () => {
    __setEditDraftsLimitsForTests({ maxTotalBytes: 10 });
    await saveEditDraft(params(1, { fileBytes: new Uint8Array(40) }));
    expect((await listEditDrafts()).map((d) => d.id)).toEqual([idOf(1)]);
    await saveEditDraft(params(2, { fileBytes: new Uint8Array(40) }));
    expect((await listEditDrafts()).map((d) => d.id)).toEqual([idOf(2)]);
  });

  it("al actualizar un borrador existente no se expulsa a otro sin necesidad", async () => {
    for (let n = 1; n <= MAX_EDIT_DRAFTS; n += 1) await saveEditDraft(params(n));
    await saveEditDraft(params(MAX_EDIT_DRAFTS, { session: sessionWithText("otro") }));
    expect(await listEditDrafts()).toHaveLength(MAX_EDIT_DRAFTS);
  });

  it("barre los archivos huerfanos (sin borrador que los reclame) al guardar", async () => {
    await rawPut("draftFiles", { id: idOf(77), bytes: new Uint8Array([1]) });
    await rawPut("draftFiles", { id: `${idOf(78)}/im9`, bytes: new Uint8Array([1]) });
    await saveEditDraft(params(1));
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
  });

  it("una imagen que la sesion ya no usa se barre sin tocar el PDF ni las imagenes vivas", async () => {
    await saveEditDraft(params(1, { session: sessionWithText("x", true) }));
    expect((await rawKeys("draftFiles")).sort()).toEqual([idOf(1), `${idOf(1)}/im1`]);
    await saveEditDraft(params(1, { session: sessionWithText("x", false) }));
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
  });

  it("filas corruptas se purgan al guardar y no cuentan para el tope", async () => {
    await rawPut("draftMeta", { id: "basura", savedAt: "x" });
    await rawPut("draftMeta", { id: idOf(50), schema: 1 });
    await rawPut("draftFiles", { id: idOf(50), bytes: new Uint8Array([1]) });
    await saveEditDraft(params(1));
    expect(await rawKeys("draftMeta")).toEqual([idOf(1)]);
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
  });

  it("los metadatos de un borrador expulsado y sus archivos desaparecen en la misma transaccion (nada a medias)", async () => {
    // Si la expulsion fallara a mitad, quedarian metadatos sin bytes o al reves:
    // tras una racha de guardados los dos almacenes siempre coinciden.
    for (let n = 1; n <= 25; n += 1) {
      await saveEditDraft(params(n, { session: sessionWithText("x", n % 2 === 0) }));
      const metaIds = new Set(await rawKeys("draftMeta"));
      const fileDocs = new Set((await rawKeys("draftFiles")).map((k) => k.split("/")[0]));
      expect(fileDocs).toEqual(metaIds);
    }
  });
});

describe("lectura con datos danados o expulsados", () => {
  it("si faltan los bytes del PDF no se puede retomar: corrupt y se limpia lo que quedaba", async () => {
    const p = params(1, { session: sessionWithText("x", true) });
    await saveEditDraft(p);
    await rawDelete("draftFiles", p.id);
    await expect(loadEditDraft(p.id)).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await rawKeys("draftMeta")).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("si falta una imagen se restaura el resto y solo se descarta el item que la usaba", async () => {
    const p = params(1, { session: sessionWithText("x", true) });
    await saveEditDraft(p);
    await rawDelete("draftFiles", `${p.id}/im1`);
    const loaded = await loadEditDraft(p.id);
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.session.items.map((i) => i.id)).toEqual(["t1"]);
    expect(loaded.draft.discarded).toBe(1);
  });

  it("una fila de metadatos corrupta -> corrupt y se borra; el listado no la muestra", async () => {
    await rawPut("draftMeta", { id: idOf(9), schema: 1, nada: true });
    expect(await listEditDrafts()).toEqual([]);
    await expect(loadEditDraft(idOf(9))).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("items basura dentro de un borrador valido se descartan sin lanzar", async () => {
    const p = params(1);
    await saveEditDraft(p);
    const db = await openRaw();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("draftMeta", "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        const store = tx.objectStore("draftMeta");
        const get = store.get(p.id);
        get.onsuccess = () => {
          const meta = get.result;
          meta.session.items.push({ kind: "text", id: "malo", edit: { id: "malo" } }, 42, null);
          store.put(meta);
        };
      });
    } finally {
      db.close();
    }
    const loaded = await loadEditDraft(p.id);
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.session.items).toHaveLength(1);
    expect(loaded.draft.discarded).toBe(3);
  });

  it("los items de paginas que ya no existen (pageCount del borrador) se descartan", async () => {
    let s = sessionWithText();
    s = applyOp(
      s,
      {
        type: "add",
        item: textItem(
          newTextEdit({ id: "lejos", pageIndex: 9, box: { x: 1, y: 1, width: 5, height: 5 }, fontKey: "times", text: "z" }),
        ),
      },
    );
    await saveEditDraft(params(1, { session: s, pageCount: 3 }));
    const loaded = await loadEditDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.session.items.map((i) => i.id)).toEqual(["t1"]);
  });
});

describe("borrar", () => {
  it("deleteEditDraft quita metadatos, PDF e imagenes de ESE borrador y deja los demas", async () => {
    await saveEditDraft(params(1, { session: sessionWithText("x", true) }));
    await saveEditDraft(params(2));
    await expect(deleteEditDraft(idOf(1))).resolves.toEqual({ ok: true });
    expect((await listEditDrafts()).map((d) => d.id)).toEqual([idOf(2)]);
    expect(await rawKeys("draftFiles")).toEqual([idOf(2)]);
  });

  it("tras borrar, el siguiente guardado vuelve a escribir los bytes", async () => {
    await saveEditDraft(params(1));
    await deleteEditDraft(idOf(1));
    await saveEditDraft(params(1));
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
    const loaded = await loadEditDraft(idOf(1));
    expect(loaded.ok).toBe(true);
  });

  it("clearAllEditDrafts vacia todo y avisa a los oyentes", async () => {
    await saveEditDraft(params(1, { session: sessionWithText("x", true) }));
    await saveEditDraft(params(2));
    const listener = vi.fn();
    const stop = subscribeToEditDrafts(listener);
    await expect(clearAllEditDrafts()).resolves.toEqual({ ok: true });
    expect(await listEditDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
    expect(listener).toHaveBeenCalled();
    stop();
  });

  it("clearAllEditDrafts con la conexion de vida larga abierta sigue funcionando", async () => {
    await saveEditDraft(params(1));
    await warmEditDraftsConnection();
    await expect(clearAllEditDrafts()).resolves.toEqual({ ok: true });
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: true });
    expect(await listEditDrafts()).toHaveLength(1);
  });
});

describe("otra pestana (BroadcastChannel)", () => {
  it("guardar y borrar avisan por optimuspdf.edit-drafts", async () => {
    const other = new BroadcastChannel("optimuspdf.edit-drafts");
    const received: unknown[] = [];
    other.onmessage = (event) => received.push(event.data);
    await saveEditDraft(params(1));
    await deleteEditDraft(idOf(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    other.close();
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it("un aviso de otra pestana refresca a los oyentes y olvida lo que esta pestana creia escrito", async () => {
    const puts: string[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      puts.push(`${this.name}:${(args[0] as { id: string }).id}`);
      return original.apply(this, args as Parameters<typeof original>);
    });
    const listener = vi.fn();
    const stop = subscribeToEditDrafts(listener);
    await saveEditDraft(params(1));
    listener.mockClear();

    // Otra pestana borra el borrador y lo anuncia.
    await rawDelete("draftFiles", idOf(1));
    await rawDelete("draftMeta", idOf(1));
    const other = new BroadcastChannel("optimuspdf.edit-drafts");
    other.postMessage("changed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    other.close();
    expect(listener).toHaveBeenCalled();

    // El siguiente guardado rehace los bytes (no se fia de su memoria).
    await saveEditDraft(params(1));
    expect(await rawKeys("draftFiles")).toEqual([idOf(1)]);
    expect(puts.filter((p) => p === `draftFiles:${idOf(1)}`)).toHaveLength(2);
    stop();
  });
});

describe("IndexedDB no disponible, bloqueada o con cuota agotada: nada lanza", () => {
  it("sin IndexedDB: resultados tipados, lista vacia y borrar es ok (no hay nada guardado)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: false, reason: "unsupported" });
    await expect(loadEditDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unsupported" });
    await expect(listEditDrafts()).resolves.toEqual([]);
    await expect(deleteEditDraft(idOf(1))).resolves.toEqual({ ok: true });
    await expect(clearAllEditDrafts()).resolves.toEqual({ ok: true });
  });

  it("indexedDB.open lanza (modo privado de algunos navegadores): unavailable en todo", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("SecurityError");
      },
    });
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(loadEditDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(listEditDrafts()).resolves.toEqual([]);
    await expect(deleteEditDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(clearAllEditDrafts()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("apertura bloqueada por otra pestana: se abandona tras el plazo sin colgarse ni lanzar", async () => {
    __setEditDraftsBlockedTimeoutForTests(40);
    vi.stubGlobal("indexedDB", {
      open: () => {
        const request: { onblocked?: () => void } = {};
        setTimeout(() => request.onblocked?.(), 0);
        return request;
      },
    });
    const started = Date.now();
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(clearAllEditDrafts()).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("apertura que nunca responde: tambien se abandona por plazo", async () => {
    __setEditDraftsBlockedTimeoutForTests(40);
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    await expect(loadEditDraft(idOf(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("cuota agotada al escribir: reason quota y NO queda nada a medias", async () => {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("cuota", "QuotaExceededError");
    });
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: false, reason: "quota" });
    vi.restoreAllMocks();
    expect(await listEditDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("cuota agotada con la conexion de vida larga: tambien quota, sin descartar la conexion buena", async () => {
    await warmEditDraftsConnection();
    expect(__hasWarmEditDraftsConnectionForTests()).toBe(true);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("cuota", "QuotaExceededError");
    });
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: false, reason: "quota" });
    vi.restoreAllMocks();
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: true });
  });

  it("un fallo no clasificado al escribir es unavailable (y el borrador anterior sigue intacto)", async () => {
    await saveEditDraft(params(1, { session: sessionWithText("viejo") }));
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      calls += 1;
      if (calls >= 1) throw new Error("fallo raro");
      return original.apply(this, args as Parameters<typeof original>);
    });
    await expect(saveEditDraft(params(1, { session: sessionWithText("nuevo") }))).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    vi.restoreAllMocks();
    const loaded = await loadEditDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.session.items[0]).toMatchObject({ edit: { text: "viejo" } });
  });

  it("onversionchange: la conexion de vida larga se aparta y no bloquea a una pestana mas nueva", async () => {
    await saveEditDraft(params(1));
    await warmEditDraftsConnection();
    expect(__hasWarmEditDraftsConnectionForTests()).toBe(true);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onblocked = () => reject(new Error("bloqueada por nuestra conexion"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    upgraded.close();
    expect(__hasWarmEditDraftsConnectionForTests()).toBe(false);
    // La base esta en una version futura que este codigo no entiende: nada lanza.
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(listEditDrafts()).resolves.toEqual([]);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await expect(saveEditDraft(params(1))).resolves.toEqual({ ok: true });
  });
});

describe("camino rapido: conexion abierta y escritura sincrona (sobrevive a beforeunload)", () => {
  it("el primer guardado adopta la conexion para los siguientes", async () => {
    await saveEditDraft(params(1));
    expect(__hasWarmEditDraftsConnectionForTests()).toBe(true);
  });

  it("con la conexion abierta la transaccion se CREA sin esperar nada", async () => {
    await warmEditDraftsConnection();
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction");
    const pending = saveEditDraft(params(1));
    // Nada se ha esperado todavia: la transaccion de escritura ya esta lanzada.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe("readwrite");
    await pending;
  });

  it("un documento NUEVO tambien escribe sus bytes en esa misma pasada (no hay lectura previa)", async () => {
    await warmEditDraftsConnection();
    const puts: string[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      puts.push(this.name);
      return original.apply(this, args as Parameters<typeof original>);
    });
    const pending = saveEditDraft(params(1, { session: sessionWithText("x", true) }));
    expect(puts.sort()).toEqual(["draftFiles", "draftFiles", "draftMeta"]); // PDF + imagen + metadatos
    await pending;
    expect((await loadEditDraft(idOf(1))).ok).toBe(true);
  });

  it("si la conexion de vida larga quedo muerta, no lanza y se recupera por el camino normal", async () => {
    await saveEditDraft(params(1));
    await warmEditDraftsConnection();
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
      throw new DOMException("closed", "InvalidStateError");
    });
    await expect(saveEditDraft(params(1, { session: sessionWithText("recuperado") }))).resolves.toEqual({ ok: true });
    vi.restoreAllMocks();
    const loaded = await loadEditDraft(idOf(1));
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.session.items[0]).toMatchObject({ edit: { text: "recuperado" } });
  });

  it("isCurrent=false: un guardado ya superado no escribe nada, ni por el camino rapido ni por el lento", async () => {
    await expect(saveEditDraft(params(1, { isCurrent: () => false }))).resolves.toEqual({
      ok: false,
      reason: "superseded",
    });
    expect(await listEditDrafts()).toEqual([]);
    await warmEditDraftsConnection();
    await expect(saveEditDraft(params(2, { isCurrent: () => false }))).resolves.toEqual({
      ok: false,
      reason: "superseded",
    });
    expect(await listEditDrafts()).toEqual([]);
  });
});
