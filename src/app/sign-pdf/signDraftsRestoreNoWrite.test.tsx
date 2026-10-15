import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { reportOfWrite } from "@/app/sign-pdf/draftWriteReport";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";
import {
  __createTabForTests,
  __useTabForTests,
  clearAllDrafts,
  deleteSessionDraft,
  listDrafts,
  listSessionDrafts,
  loadDraft,
  loadSessionDraft,
  saveDraft,
  saveSessionDraft,
  subscribeToDrafts,
  type SaveDraftParams,
  type SaveSessionParams,
} from "@/app/sign-pdf/signDrafts";

/**
 * F0-fix2 · N3: abrir o restaurar una sesion en otra pestaña, sin ningun cambio de la persona, NO reescribe el borrador (no sube
 * `rev` ni cambia `writerId`): si no, la pestaña que ya estaba abierta quedaba «desactualizada» y su siguiente cambio real
 * acababa en una «Copia aparte». Solo la primera edicion REAL tras restaurar escribe. Las garantias de D1 (dos pestañas con
 * cambios reales no se pisan) y D2 (un fallo de escritura se dice) siguen como estaban.
 */

const DB_NAME = "optimuspdf-sign-drafts";
const SIGNER = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const STROKE = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };

function docInput(id: string) {
  const bytes = new Uint8Array([1, 2, 3, id.length]);
  return { id, fileName: `${id}.pdf`, size: bytes.byteLength, state: { ...EMPTY_DOC_STATE } as DocState, getBytes: async () => bytes };
}

function signedBlock(): SignerBlock {
  return { id: "bk-1", signerId: SIGNER.id, appliesTo: ["doc-1", "doc-2"], signature: STROKE, initials: null, stamps: {}, auto: true };
}

function session(id: string, over: Partial<SaveSessionParams> = {}): SaveSessionParams {
  return {
    id,
    mode: "multi",
    signMode: "same",
    signers: [SIGNER],
    blocks: [signedBlock()],
    documents: [docInput("doc-1"), docInput("doc-2")],
    activeDocId: "doc-1",
    step: "signers",
    ...over,
  };
}

function single(id: string, over: Partial<SaveDraftParams> = {}): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array([9, 9, 9]),
    fileName: "contrato.pdf",
    manifest: { mode: "multi", signers: [SIGNER], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: { "f-1": { signature: STROKE, initials: null, stamp: "x" } } as unknown as SaveDraftParams["captures"],
    textFieldsDetectedFor: null,
    ...over,
  };
}

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawDeleteFile(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("draftFiles", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("draftFiles").delete(key);
  });
  db.close();
}

async function rawFileKeys(): Promise<string[]> {
  const db = await openDb();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction("draftFiles", "readonly").objectStore("draftFiles").getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

let tabA = __createTabForTests("t-aaaa");
let tabB = __createTabForTests("t-bbbb");
let original = __useTabForTests(tabA);

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  tabA = __createTabForTests("t-aaaa");
  tabB = __createTabForTests("t-bbbb");
  original = __useTabForTests(tabA);
  await clearAllDrafts();
});
afterEach(() => {
  __useTabForTests(original);
  vi.restoreAllMocks();
});

async function as<T>(tab: ReturnType<typeof __createTabForTests>, fn: () => Promise<T>): Promise<T> {
  const previous = __useTabForTests(tab);
  try {
    return await fn();
  } finally {
    __useTabForTests(previous);
  }
}

describe("N3 · restaurar una sesion no reescribe el borrador", () => {
  it("la otra pestaña restaura y vuelve a guardar lo MISMO: no cambia rev, writerId ni fecha, y no avisa a nadie", async () => {
    await saveSessionDraft(session("s-n3-1")); // pestaña A: rev 1
    const [before] = await listSessionDrafts();
    expect(before.rev).toBe(1);
    const listener = vi.fn();
    const stop = subscribeToDrafts(listener);
    const result = await as(tabB, async () => {
      expect(await loadSessionDraft("s-n3-1")).not.toBeNull();
      return saveSessionDraft(session("s-n3-1"));
    });
    stop();
    expect(result).toEqual({ ok: true, unchanged: true });
    const [after] = await listSessionDrafts();
    expect(after.rev).toBe(1);
    expect(after.writerId).toBe("t-aaaa");
    expect(after.savedAt).toBe(before.savedAt);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(listener).not.toHaveBeenCalled();
    // Para la pantalla sigue siendo «guardado»: lo que hay guardado ES lo que se ve.
    expect(reportOfWrite(result)).toEqual({ kind: "saved" });
  });

  it("la pestaña A que ya estaba abierta NO queda desactualizada: su siguiente cambio real se guarda sin copia aparte", async () => {
    await saveSessionDraft(session("s-n3-2"));
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-2");
      await saveSessionDraft(session("s-n3-2"));
    });
    const result = await saveSessionDraft(session("s-n3-2", { activeDocId: "doc-2" }));
    expect(result).toEqual({ ok: true });
    const metas = await listSessionDrafts();
    expect(metas).toHaveLength(1);
    expect(metas[0].rev).toBe(2);
    expect(metas[0].writerId).toBe("t-aaaa");
    expect(metas[0].copyOf).toBeUndefined();
  });

  it("la primera edicion REAL tras restaurar SI escribe (rev + 1, la pestaña B firma el borrador) y quita la excepcion", async () => {
    await saveSessionDraft(session("s-n3-3"));
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-3");
      expect(await saveSessionDraft(session("s-n3-3"))).toEqual({ ok: true, unchanged: true });
      expect(await saveSessionDraft(session("s-n3-3", { activeDocId: "doc-2" }))).toEqual({ ok: true });
    });
    const [meta] = await listSessionDrafts();
    expect(meta.rev).toBe(2);
    expect(meta.writerId).toBe("t-bbbb");
    expect(meta.activeDocId).toBe("doc-2");
  });

  it("deshacer el cambio y volver al contenido original tras haber escrito SI escribe (la excepcion es solo hasta la primera edicion)", async () => {
    await saveSessionDraft(session("s-n3-4"));
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-4");
      await saveSessionDraft(session("s-n3-4", { activeDocId: "doc-2" }));
      expect(await saveSessionDraft(session("s-n3-4"))).toEqual({ ok: true });
    });
    const [meta] = await listSessionDrafts();
    expect(meta.rev).toBe(3);
  });

  it("D1 intacto: dos pestañas con cambios REALES siguen sin pisarse (la que va por detras guarda una copia aparte)", async () => {
    await saveSessionDraft(session("s-n3-5")); // A rev 1
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-5");
      await saveSessionDraft(session("s-n3-5")); // restaurar: no escribe
    });
    await saveSessionDraft(session("s-n3-5", { activeDocId: "doc-2" })); // A: cambio real, rev 2
    const forked = await as(tabB, () => saveSessionDraft(session("s-n3-5", { step: "document" }))); // B: cambio real, va por detras
    expect(forked.ok && forked.forkedTo).toBeTruthy();
    const metas = await listSessionDrafts();
    expect(metas).toHaveLength(2);
    const original = metas.find((meta) => meta.id === "s-n3-5")!;
    expect(original.activeDocId).toBe("doc-2");
    expect(original.step).toBe("signers");
    expect(metas.find((meta) => meta.copyOf === "s-n3-5")!.step).toBe("document");
  });

  it("D1 intacto: quien restaura una version MAS NUEVA que la que tenia otra pestaña no la hace desactualizarse mas de lo que ya estaba", async () => {
    await saveSessionDraft(session("s-n3-6")); // A rev 1
    await saveSessionDraft(session("s-n3-6", { activeDocId: "doc-2" })); // A rev 2
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-6");
      expect(await saveSessionDraft(session("s-n3-6", { activeDocId: "doc-2" }))).toEqual({ ok: true, unchanged: true });
    });
    const [meta] = await listSessionDrafts();
    expect(meta.rev).toBe(2);
    expect(meta.writerId).toBe("t-aaaa");
  });

  it("si lo guardado cambio mientras tanto (otra pestaña), la restauracion sin tocar NO lo pisa NI lo da por «visto»: el primer cambio real de esta pestaña se guarda aparte", async () => {
    await saveSessionDraft(session("s-n3-11")); // A rev 1
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-11"); // B parte de la rev 1
    });
    await saveSessionDraft(session("s-n3-11", { activeDocId: "doc-2" })); // A rev 2: B no lo ha visto
    const untouched = await as(tabB, () => saveSessionDraft(session("s-n3-11"))); // B sigue con lo que leyo: no escribe
    expect(untouched).toEqual({ ok: true, unchanged: true });
    expect((await listSessionDrafts())[0].rev).toBe(2);
    // Y como B no vio la rev 2, su primer cambio REAL va por detras: copia aparte, el original (de A) queda intacto.
    const forked = await as(tabB, () => saveSessionDraft(session("s-n3-11", { step: "document" })));
    expect(forked.ok && forked.forkedTo).toBeTruthy();
    const original = (await listSessionDrafts()).find((meta) => meta.id === "s-n3-11")!;
    expect(original.activeDocId).toBe("doc-2");
    expect(original.writerId).toBe("t-aaaa");
  });

  it("borrar el borrador tras restaurarlo retira la referencia: lo que vuelva a existir bajo ese id no se salta por haberlo leido antes", async () => {
    await saveSessionDraft(session("s-n3-12"));
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-12");
      await deleteSessionDraft("s-n3-12");
    });
    // Otro borrador con el mismo id, creado desde una tercera pestaña (rev 1: B no lo considera mas nuevo que lo que conocia).
    await as(__createTabForTests("t-cccc"), () => saveSessionDraft(session("s-n3-12", { activeDocId: "doc-2" })));
    const result = await as(tabB, () => saveSessionDraft(session("s-n3-12")));
    expect(result).toEqual({ ok: true });
    expect((await listSessionDrafts())[0].activeDocId).toBe("doc-1");
  });

  it("apagar «guardar las firmas» tras restaurar SI reescribe (quita los trazos): lo que se ve ya no es lo guardado", async () => {
    await saveSessionDraft(session("s-n3-7"));
    window.localStorage.setItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ signaturesInDraft: false }));
    __resetSignPdfFeatureFlagsCacheForTests();
    const result = await as(tabB, async () => {
      await loadSessionDraft("s-n3-7");
      return saveSessionDraft(session("s-n3-7"));
    });
    expect(result).toEqual({ ok: true });
    const [meta] = await listSessionDrafts();
    expect(meta.rev).toBe(2);
    expect(meta.signaturesOmitted).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("data:image");
  });

  it("si faltan bytes de un documento (otra pestaña los expulso) la restauracion SI repara: no deja metadatos sin archivos", async () => {
    await saveSessionDraft(session("s-n3-8"));
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-8");
    });
    await rawDeleteFile("s-n3-8/doc-2");
    const result = await as(tabB, () => saveSessionDraft(session("s-n3-8")));
    expect(result.ok).toBe(true);
    expect((await rawFileKeys()).sort()).toEqual(["s-n3-8/doc-1", "s-n3-8/doc-2"]);
  });

  it("sin haber restaurado nada (sesion nueva, o repetir el mismo guardado en la misma pestaña) nada cambia: la version sigue subiendo", async () => {
    expect(await saveSessionDraft(session("s-n3-9"))).toEqual({ ok: true });
    expect(await saveSessionDraft(session("s-n3-9"))).toEqual({ ok: true });
    expect((await listSessionDrafts())[0].rev).toBe(2);
  });

  it("un borrador que ya no existe (borrado tras restaurar) se vuelve a escribir: no se queda sin guardar", async () => {
    await saveSessionDraft(session("s-n3-10"));
    await as(tabB, async () => {
      await loadSessionDraft("s-n3-10");
    });
    await clearAllDrafts();
    const result = await as(tabB, () => saveSessionDraft(session("s-n3-10")));
    expect(result).toEqual({ ok: true });
    expect(await listSessionDrafts()).toHaveLength(1);
  });
});

describe("N3 · lo mismo con un documento suelto", () => {
  it("restaurar el borrador de un documento y guardar lo mismo no lo reescribe; la primera edicion real si", async () => {
    await saveDraft(single("d-n3-1")); // A rev 1
    const [before] = await listDrafts();
    expect(before.rev).toBe(1);
    await as(tabB, async () => {
      expect(await loadDraft("d-n3-1")).not.toBeNull();
      expect(await saveDraft(single("d-n3-1"))).toEqual({ ok: true, unchanged: true });
    });
    const [same] = await listDrafts();
    expect(same.rev).toBe(1);
    expect(same.writerId).toBe("t-aaaa");
    expect(same.savedAt).toBe(before.savedAt);
    // A no quedo desactualizada.
    expect(await saveDraft(single("d-n3-1", { step: "document" }))).toEqual({ ok: true });
    expect(await listDrafts()).toHaveLength(1);
    expect((await listDrafts())[0].rev).toBe(2);
    // Y B, que no hizo nada, hace luego un cambio real: va por detras, copia aparte (D1).
    const forked = await as(tabB, () => saveDraft(single("d-n3-1", { step: "sign" })));
    expect(forked.ok && forked.forkedTo).toBeTruthy();
    expect(await listDrafts()).toHaveLength(2);
  });

  it("apagar «guardar las firmas» tras restaurar un documento SI reescribe (sin trazos)", async () => {
    await saveDraft(single("d-n3-2"));
    window.localStorage.setItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ signaturesInDraft: false }));
    __resetSignPdfFeatureFlagsCacheForTests();
    await as(tabB, async () => {
      await loadDraft("d-n3-2");
      expect(await saveDraft(single("d-n3-2"))).toEqual({ ok: true });
    });
    const [meta] = await listDrafts();
    expect(meta.rev).toBe(2);
    expect(meta.captures).toEqual({});
  });
});
