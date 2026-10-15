import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
  readSignaturesInDraft,
  setSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import {
  clearAllDrafts,
  listDrafts,
  listSessionDrafts,
  saveDraft,
  saveSessionDraft,
  type SaveDraftParams,
  type SaveSessionParams,
} from "@/app/sign-pdf/signDrafts";

/**
 * El ajuste «Guardar tambien las firmas recogidas» (F0 · U0.4) se lee AL ESCRIBIR el borrador: quien guarda no tiene por que
 * pasarlo, y el valor que cuenta es el de ese instante (con el ajuste ya cambiado en otra pestana o en Ajustes).
 */

const SIGNER = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const STROKE = { dataUrl: "data:image/png;base64,TRAZO", ratio: 0.3 };

function session(id: string, overrides: Partial<SaveSessionParams> = {}): SaveSessionParams {
  const block: SignerBlock = {
    id: "bk-1",
    signerId: "sg-1",
    appliesTo: ["a", "b"],
    signature: STROKE,
    initials: null,
    stamps: { a: "x", b: "y" },
    auto: true,
  };
  return {
    id,
    mode: "multi",
    signMode: "same",
    signers: [SIGNER],
    blocks: [block],
    documents: ["a", "b"].map((name) => ({
      id: name,
      fileName: `${name}.pdf`,
      size: 3,
      state: { ...EMPTY_DOC_STATE } as DocState,
      getBytes: async () => new Uint8Array([1, 2, 3]),
    })),
    activeDocId: "a",
    step: "sign",
    ...overrides,
  };
}

function single(id: string, overrides: Partial<SaveDraftParams> = {}): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array([1, 2, 3]),
    fileName: `${id}.pdf`,
    manifest: { mode: "multi", signers: [SIGNER], fields: [], textFields: [], textValues: {} },
    step: "sign",
    captures: { "sg-1": { signature: STROKE, initials: null, stamp: "x" } },
    textFieldsDetectedFor: null,
    ...overrides,
  };
}

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  await clearAllDrafts();
});

describe("readSignaturesInDraft", () => {
  it("nace ENCENDIDO (usuario nuevo)", () => {
    expect(readSignaturesInDraft()).toBe(true);
  });

  it("lo que se apague en Ajustes se persiste y sobrevive a una recarga", () => {
    setSignPdfFeatureFlag("signaturesInDraft", false);
    expect(readSignaturesInDraft()).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY) ?? "{}").signaturesInDraft).toBe(false);
    __resetSignPdfFeatureFlagsCacheForTests();
    expect(readSignaturesInDraft()).toBe(false);
    setSignPdfFeatureFlag("signaturesInDraft", true);
    __resetSignPdfFeatureFlagsCacheForTests();
    expect(readSignaturesInDraft()).toBe(true);
  });

  it("un valor guardado que no es booleano se ignora (queda el defecto)", () => {
    window.localStorage.setItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ signaturesInDraft: "no" }));
    __resetSignPdfFeatureFlagsCacheForTests();
    expect(readSignaturesInDraft()).toBe(true);
  });
});

describe("el borrador respeta el ajuste aunque quien guarda no lo diga", () => {
  it("encendido: los trazos se guardan (sesion y documento suelto)", async () => {
    await saveSessionDraft(session("s-1"));
    await saveDraft(single("doc-1"));
    expect((await listSessionDrafts())[0].blocks[0].signature).toEqual(STROKE);
    expect((await listDrafts())[0].captures["sg-1"].signature).toEqual(STROKE);
  });

  it("apagado: ningun trazo llega a la base (sesion y documento suelto)", async () => {
    setSignPdfFeatureFlag("signaturesInDraft", false);
    await saveSessionDraft(session("s-1"));
    await saveDraft(single("doc-1"));
    const [sessionMeta] = await listSessionDrafts();
    const [documentMeta] = await listDrafts();
    expect(sessionMeta.blocks[0].signature).toBeNull();
    expect(sessionMeta.blocks[0].stamps).toEqual({});
    expect(sessionMeta.signaturesOmitted).toBe(true);
    expect(documentMeta.captures).toEqual({});
    expect(documentMeta.signaturesOmitted).toBe(true);
  });

  it("lo que diga quien guarda manda sobre el ajuste (la pantalla ya lo leyo del mismo sitio)", async () => {
    setSignPdfFeatureFlag("signaturesInDraft", false);
    await saveSessionDraft(session("s-keep", { keepSignatures: true }));
    expect((await listSessionDrafts())[0].blocks[0].signature).toEqual(STROKE);
    setSignPdfFeatureFlag("signaturesInDraft", true);
    await saveSessionDraft(session("s-drop", { keepSignatures: false }));
    const dropped = (await listSessionDrafts()).find((meta) => meta.id === "s-drop");
    expect(dropped?.blocks[0].signature).toBeNull();
  });

  it("volver a guardar la MISMA sesion con el ajuste apagado quita los trazos que ya estaban en la base", async () => {
    await saveSessionDraft(session("s-1"));
    expect((await listSessionDrafts())[0].blocks[0].signature).toEqual(STROKE);
    setSignPdfFeatureFlag("signaturesInDraft", false);
    await saveSessionDraft(session("s-1"));
    const [meta] = await listSessionDrafts();
    expect(meta.blocks[0].signature).toBeNull();
    expect(meta.expiresAt).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain("data:image");
  });
});
