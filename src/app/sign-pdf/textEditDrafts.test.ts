import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import { EMPTY_DOC_STATE, docIdOf, type DocState } from "@/app/sign-pdf/docSet";
import {
  clearAllDrafts,
  loadDraft,
  loadSessionDraft,
  saveDraft,
  saveSessionDraft,
  type SaveDraftParams,
} from "@/app/sign-pdf/signDrafts";
import { hasSessionProgress, restoreSession, snapshotSession, createSessionIdentity } from "@/app/sign-pdf/sessionDraft";
import { DEFAULT_SESSION, applyViewPatch, sessionFromView, syncSession, viewOf, type SignSession } from "@/app/sign-pdf/signSession";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";

/**
 * Borradores con texto original editado (W6-A): el borrador de un documento (v1)
 * y el de una SESION (v2, varios documentos) guardan y restauran las ediciones
 * de cada documento; lo invalido se descarta sin lanzar.
 */

afterEach(async () => {
  await clearAllDrafts();
});

const E1 = makeEdit({ id: "e1", blockId: "p0-b0", text: "Primero" });
const E2 = makeEdit({ id: "e2", blockId: "p0-b1", text: "Segundo" });

function v1Params(id: string, textEdits?: SaveDraftParams["textEdits"]): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array([1, 2, 3]),
    fileName: "doc.pdf",
    manifest: { mode: "single", signers: [], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
    textEdits,
  };
}

describe("borrador de un documento (v1)", () => {
  it("guarda y devuelve las ediciones de texto", async () => {
    await saveDraft(v1Params("k1", [E1, E2]));
    const loaded = await loadDraft("k1");
    expect(loaded?.meta.textEdits).toEqual([E1, E2]);
  });

  it("sin ediciones el borrador es exactamente el de siempre (sin la clave)", async () => {
    await saveDraft(v1Params("k2"));
    const loaded = await loadDraft("k2");
    expect(loaded).not.toBeNull();
    expect("textEdits" in (loaded!.meta as object)).toBe(false);
  });

  it("un borrador anterior a esta funcion (sin la clave) se lee sin problema", async () => {
    await saveDraft(v1Params("k3", []));
    expect((await loadDraft("k3"))?.meta.textEdits).toBeUndefined();
  });
});

describe("borrador de SESION (v2): cada documento con las suyas", () => {
  it("guarda y restaura las ediciones por documento y las deja en su documento", async () => {
    const files = [
      new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" }),
      new File([new Uint8Array([4, 5, 6, 7])], "b.pdf", { type: "application/pdf" }),
    ];
    const [idA, idB] = files.map(docIdOf);
    let session: SignSession = { ...DEFAULT_SESSION, mode: "multi", docOrder: [idA, idB], activeDocId: idA };
    session = { ...session, ...applyViewPatch(session, idA, { textEdits: [E1] }, [idA, idB]) };
    session = { ...session, ...applyViewPatch(session, idB, { textEdits: [E2] }, [idA, idB]) };
    const identity = createSessionIdentity();
    const snapshot = snapshotSession({
      identity,
      session,
      files,
      getBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
    });
    expect(await saveSessionDraft(snapshot)).toMatchObject({ ok: true });
    const loaded = await loadSessionDraft(identity.id);
    expect(loaded).not.toBeNull();
    const restoredFiles = loaded!.files.map(
      (item) => new File([item.bytes as BlobPart], item.fileName, { type: "application/pdf" }),
    );
    const restored = restoreSession(loaded!.meta, restoredFiles, ["k-a", "k-b"]);
    const [newA, newB] = restoredFiles.map(docIdOf);
    expect(restored.patch.docs?.[newA].textEdits).toEqual([E1]);
    expect(restored.patch.docs?.[newB].textEdits).toEqual([E2]);
  });
});

describe("restoreSession — validacion y huella", () => {
  function metaWith(docStates: Record<string, Partial<DocState>>) {
    return {
      kind: "session" as const,
      id: "s-1",
      savedAt: new Date().toISOString(),
      mode: "multi" as const,
      signMode: "same" as const,
      signers: [],
      blocks: [],
      documents: [{ id: "d1", fileName: "a.pdf", fileSize: 3 }],
      docStates: docStates as Record<string, DocState>,
      activeDocId: "d1",
      step: "signers" as const,
      fileSize: 3,
      fileName: "a.pdf",
      documentCount: 1,
    };
  }
  const FILE = new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" });

  it("lo invalido de un borrador manipulado se descarta sin lanzar", () => {
    const restored = restoreSession(
      metaWith({ d1: { ...EMPTY_DOC_STATE, sealedKey: "k", textEdits: [E1, { id: 7 }, null] as never } }),
      [FILE],
      ["k"],
    );
    expect(restored.patch.docs?.[docIdOf(FILE)].textEdits).toEqual([E1]);
  });

  it("si la huella del archivo recuperado ya no coincide con la guardada, las ediciones se descartan (describian otros bytes)", () => {
    const restored = restoreSession(
      metaWith({ d1: { ...EMPTY_DOC_STATE, sealedKey: "vieja", textEdits: [E1] } }),
      [FILE],
      ["nueva"],
    );
    expect(restored.patch.docs?.[docIdOf(FILE)].textEdits).toBeUndefined();
    expect(restored.staleDocs).toBe(1);
  });

  it("los sellos restaurados de un documento editado siguen validos: la huella de sellado se recalcula igual", () => {
    // La huella del archivo es la que sella `sealedKey`; las ediciones restauradas dan la misma huella de sellado.
    expect(stampKeyOf("k", [E1])).toBe(stampKeyOf("k", JSON.parse(JSON.stringify([E1]))));
  });
});

describe("la sesion cuenta las ediciones como progreso y las lleva a cada vista", () => {
  it("un documento con solo ediciones merece guardarse", () => {
    const id = "doc-x";
    const withEdits = { ...DEFAULT_SESSION, docs: { [id]: { ...EMPTY_DOC_STATE, textEdits: [E1] } } };
    const without = { ...DEFAULT_SESSION, docs: { [id]: { ...EMPTY_DOC_STATE } } };
    expect(hasSessionProgress(withEdits, [id])).toBe(true);
    expect(hasSessionProgress(without, [id])).toBe(false);
  });

  it("sessionFromView y viewOf se corresponden; sin ediciones no anaden la clave", () => {
    const patch = sessionFromView("d1", { textEdits: [E1] });
    expect(patch.docs?.d1.textEdits).toEqual([E1]);
    const none = sessionFromView("d1", {});
    expect("textEdits" in (none.docs?.d1 ?? {})).toBe(false);
    expect(viewOf({ ...DEFAULT_SESSION, ...patch } as typeof DEFAULT_SESSION, "d1").textEdits).toEqual([E1]);
  });

  it("quitar un documento de la ronda se lleva sus ediciones", () => {
    const session = { ...DEFAULT_SESSION, docOrder: ["d1", "d2"], docs: { d1: { ...EMPTY_DOC_STATE, textEdits: [E1] }, d2: { ...EMPTY_DOC_STATE, textEdits: [E2] } } };
    const patch = syncSession(session, ["d2"]);
    expect(Object.keys(patch.docs ?? {})).toEqual(["d2"]);
  });

  it("vaciar las ediciones de un documento con un patch vacio las quita", () => {
    const session = { ...DEFAULT_SESSION, docs: { d1: { ...EMPTY_DOC_STATE, textEdits: [E1] } } };
    const patch = applyViewPatch(session, "d1", { textEdits: [] }, ["d1"]);
    expect(patch.docs?.d1.textEdits).toEqual([]);
  });
});
