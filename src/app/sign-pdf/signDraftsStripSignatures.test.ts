import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  __createTabForTests,
  __useTabForTests,
  clearAllDrafts,
  listDrafts,
  listSessionDrafts,
  saveDraft,
  saveSessionDraft,
  stripSignaturesFromDrafts,
  subscribeToDrafts,
  type SaveDraftParams,
  type SaveSessionParams,
} from "@/app/sign-pdf/signDrafts";

/**
 * F0-fix2 · N2: «Quitar ahora las firmas de los borradores guardados». Apagar «guardar las firmas» NO purga lo ya guardado
 * (queda hasta 7 dias); este boton reescribe los borradores (sesion y documento suelto) conservando TODO menos los trazos, y
 * respeta `rev` / `writerId` (no cuenta como un guardado de esta pestaña: no deja desactualizada a ninguna otra).
 */

const DB_NAME = "optimuspdf-sign-drafts";
const SIGNER = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const STROKE = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };

function docInput(id: string) {
  const bytes = new Uint8Array([1, 2, 3, id.length]);
  return { id, fileName: `${id}.pdf`, size: bytes.byteLength, state: { ...EMPTY_DOC_STATE, textValues: { campo: "valor" } } as DocState, getBytes: async () => bytes };
}

function block(over: Partial<SignerBlock> = {}): SignerBlock {
  return { id: "bk-1", signerId: SIGNER.id, appliesTo: ["doc-1", "doc-2"], signature: STROKE, initials: STROKE, stamps: { "doc-1": "sello" }, auto: true, ...over };
}

function session(id: string, over: Partial<SaveSessionParams> = {}): SaveSessionParams {
  return {
    id,
    mode: "multi",
    signMode: "same",
    signers: [SIGNER],
    blocks: [block()],
    documents: [docInput("doc-1"), docInput("doc-2")],
    activeDocId: "doc-2",
    step: "sign",
    ceremony: { signerId: SIGNER.id, stage: "capture" },
    ...over,
  };
}

function single(id: string, over: Partial<SaveDraftParams> = {}): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array([9, 9, 9]),
    fileName: "contrato.pdf",
    manifest: { mode: "multi", signers: [SIGNER], fields: [], textFields: [], textValues: { campo: "valor" } },
    step: "sign",
    captures: { "f-1": { signature: STROKE, initials: null, stamp: "x" } } as unknown as SaveDraftParams["captures"],
    textFieldsDetectedFor: null,
    ...over,
  };
}

async function rawAll(store: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
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
  tabA = __createTabForTests("t-aaaa");
  tabB = __createTabForTests("t-bbbb");
  original = __useTabForTests(tabA);
  await clearAllDrafts();
});
afterEach(() => {
  __useTabForTests(original);
  vi.restoreAllMocks();
});

describe("stripSignaturesFromDrafts", () => {
  it("una SESION con firmas: se queda sin trazos, sellos ni turno, marcada como «sin firmas», sin caducidad y con todo lo demas igual", async () => {
    await saveSessionDraft(session("s-n2-1"));
    const [before] = await listSessionDrafts();
    expect(before.expiresAt).toBeTruthy();
    expect(JSON.stringify(before)).toContain("data:image");

    const result = await stripSignaturesFromDrafts();
    expect(result).toEqual({ ok: true, sessions: 1, documents: 0 });

    const [after] = await listSessionDrafts();
    expect(JSON.stringify(after)).not.toContain("data:image");
    expect(after.blocks).toEqual([block({ signature: null, initials: null, stamps: {} })]);
    expect(after.signaturesOmitted).toBe(true);
    expect(after.expiresAt).toBeUndefined();
    expect(after.ceremony).toBeUndefined();
    // Todo lo demas se conserva.
    const { blocks: _b, signaturesOmitted: _s, expiresAt: _e, ceremony: _c, ...restAfter } = after;
    const { blocks: _b2, signaturesOmitted: _s2, expiresAt: _e2, ceremony: _c2, ...restBefore } = before;
    void [_b, _s, _e, _c, _b2, _s2, _e2, _c2];
    expect(restAfter).toEqual(restBefore);
    expect(after.signers).toEqual([SIGNER]);
    expect(after.docStates["doc-1"].textValues).toEqual({ campo: "valor" });
    expect(after.activeDocId).toBe("doc-2");
    // Y los bytes de los PDF siguen ahi.
    expect((await rawAll("draftFiles")).map((row) => (row as { id: string }).id).sort()).toEqual(["s-n2-1/doc-1", "s-n2-1/doc-2"]);
  });

  it("un documento SUELTO con firmas: sus capturas se vacian y el resto del borrador se conserva", async () => {
    await saveDraft(single("d-n2-1"));
    const [before] = await listDrafts();
    const result = await stripSignaturesFromDrafts();
    expect(result).toEqual({ ok: true, sessions: 0, documents: 1 });
    const [after] = await listDrafts();
    expect(after.captures).toEqual({});
    expect(after.signaturesOmitted).toBe(true);
    expect(after.expiresAt).toBeUndefined();
    expect(after.textValues).toEqual({ campo: "valor" });
    expect(after.signers).toEqual([SIGNER]);
    expect(after.step).toBe("sign");
    expect(after.fileName).toBe(before.fileName);
    expect(JSON.stringify(await rawAll("draftMeta"))).not.toContain("data:image");
    expect((await rawAll("draftFiles")).length).toBe(1);
  });

  it("respeta `rev`, `writerId`, `copyOf` y la fecha de guardado: no cuenta como un guardado (nadie queda desactualizado)", async () => {
    await saveSessionDraft(session("s-n2-2")); // A rev 1
    await saveSessionDraft(session("s-n2-2", { activeDocId: "doc-1" })); // A rev 2
    await saveDraft(single("d-n2-2"));
    const sessionBefore = (await listSessionDrafts())[0];
    const docBefore = (await listDrafts())[0];
    await __runAs(tabB, () => stripSignaturesFromDrafts()); // la quita OTRA pestaña
    const sessionAfter = (await listSessionDrafts())[0];
    const docAfter = (await listDrafts())[0];
    for (const [a, b] of [[sessionBefore, sessionAfter], [docBefore, docAfter]] as const) {
      expect(b.rev).toBe(a.rev);
      expect(b.writerId).toBe("t-aaaa");
      expect(b.savedAt).toBe(a.savedAt);
    }
    // La pestaña A sigue sin estar desactualizada: su siguiente cambio real se guarda sin copia aparte.
    const next = await saveSessionDraft(session("s-n2-2", { activeDocId: "doc-2" }));
    expect(next).toEqual({ ok: true });
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("un borrador SIN firmas no se toca (ni se reescribe) y el resultado dice 0", async () => {
    await saveSessionDraft(session("s-n2-3", { blocks: [block({ signature: null, initials: null, stamps: {} })], ceremony: undefined }));
    const before = await rawAll("sessionMeta");
    const listener = vi.fn();
    const stop = subscribeToDrafts(listener);
    expect(await stripSignaturesFromDrafts()).toEqual({ ok: true, sessions: 0, documents: 0 });
    stop();
    expect(await rawAll("sessionMeta")).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("con varios borradores quita las firmas de TODOS (sesiones y documentos) y avisa una vez a las listas abiertas", async () => {
    await saveSessionDraft(session("s-n2-4a"));
    await saveSessionDraft(session("s-n2-4b"));
    await saveDraft(single("d-n2-4"));
    const listener = vi.fn();
    const stop = subscribeToDrafts(listener);
    expect(await stripSignaturesFromDrafts()).toEqual({ ok: true, sessions: 2, documents: 1 });
    stop();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([await rawAll("sessionMeta"), await rawAll("draftMeta")])).not.toContain("data:image");
  });

  it("sin IndexedDB disponible dice que no pudo (no afirma que quito algo)", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(await stripSignaturesFromDrafts()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("sin nada guardado devuelve 0 y 0", async () => {
    expect(await stripSignaturesFromDrafts()).toEqual({ ok: true, sessions: 0, documents: 0 });
  });
});

async function __runAs<T>(tab: ReturnType<typeof __createTabForTests>, fn: () => Promise<T>): Promise<T> {
  const previous = __useTabForTests(tab);
  try {
    return await fn();
  } finally {
    __useTabForTests(previous);
  }
}
