import { describe, expect, it } from "vitest";
import { captureStamp } from "@/app/sign-pdf/captures";
import { EMPTY_DOC_STATE, docIdOf, type SignerBlock } from "@/app/sign-pdf/docSet";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { SOLO_GUARD_ID, hasSavedProgress, hasSoloWork, isRoundOpen, sessionHasSavedProgress, singleDocProgress } from "@/app/sign-pdf/signWork";
import { markDecryptedCopy } from "@/lib/pdf/inputGuard";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/** Que cuenta como «trabajo que proteger» y cuando la ronda de firmas esta «a medias» (U0.3). */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const STROKE = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };
const pdf = (name: string, byte: number) => new File([new Uint8Array([37, 80, 68, 70, byte])], name, { type: "application/pdf" });
const slot = (signerId: string, id: string): SignatureField => ({
  id,
  signerId,
  pageIndex: 0,
  type: "signature",
  rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
});

const NOTHING = { signers: [], fields: [], textFields: [], textValues: {}, textEdits: undefined };

describe("singleDocProgress (la regla del autoguardado de un documento)", () => {
  it("sin nada no hay progreso; cualquier firmante, hueco, campo o valor lo es", () => {
    expect(singleDocProgress(NOTHING)).toBe(false);
    expect(singleDocProgress({ ...NOTHING, signers: [ANA] })).toBe(true);
    expect(singleDocProgress({ ...NOTHING, fields: [slot("sg-1", "f1")] })).toBe(true);
    expect(
      singleDocProgress({ ...NOTHING, textFields: [{ id: "t", pageIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, type: "text", source: "manual", confidence: 1 } as never] }),
    ).toBe(true);
    expect(singleDocProgress({ ...NOTHING, textValues: { a: "x" } })).toBe(true);
  });
});

describe("hasSavedProgress: solo «Varios firmantes» se guarda", () => {
  const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
  const ids = files.map(docIdOf);
  const multi: SignSession = { ...DEFAULT_SESSION, mode: "multi", signers: [ANA], docOrder: ids, activeDocId: ids[0] };

  it("«Solo yo» NUNCA cuenta (no guarda borrador): ni con firma colocada ni con varios documentos", () => {
    const solo: SignSession = { ...multi, mode: "single", signaturePng: "data:image/png;base64,AAAA" };
    expect(hasSavedProgress(files, solo, { ...NOTHING, signers: [ANA] })).toBe(false);
    expect(hasSavedProgress([files[0]], solo, { ...NOTHING, signers: [ANA] })).toBe(false);
  });

  it("con varios documentos manda la regla de la sesion (un firmante basta)", () => {
    expect(hasSavedProgress(files, multi, NOTHING)).toBe(true);
    expect(hasSavedProgress(files, { ...multi, signers: [] }, NOTHING)).toBe(false);
  });

  it("con un documento manda la del documento suelto", () => {
    expect(hasSavedProgress([files[0]], { ...multi, signers: [] }, { ...NOTHING, signers: [ANA] })).toBe(true);
    expect(hasSavedProgress([files[0]], { ...multi, signers: [] }, NOTHING)).toBe(false);
  });

  it("una copia abierta con contrasena nunca se guarda, asi que no hay nada que proteger", () => {
    const protectedCopy = pdf("cifrado.pdf", 9);
    markDecryptedCopy(protectedCopy);
    expect(hasSavedProgress([files[0], protectedCopy], multi, NOTHING)).toBe(false);
    expect(hasSavedProgress([protectedCopy], multi, { ...NOTHING, signers: [ANA] })).toBe(false);
    // Control: con archivos normales el mismo trabajo SI cuenta.
    expect(hasSavedProgress(files, multi, NOTHING)).toBe(true);
  });

  it("sessionHasSavedProgress lo lee de la sesion canonica (documento activo incluido)", () => {
    expect(sessionHasSavedProgress(files, multi)).toBe(true);
    expect(sessionHasSavedProgress(files, { ...multi, signers: [] })).toBe(false);
    expect(sessionHasSavedProgress(files, { ...multi, mode: "single" })).toBe(false);
    const doc = { ...EMPTY_DOC_STATE, fields: [slot("sg-1", "f1")] };
    expect(sessionHasSavedProgress([files[0]], { ...multi, signers: [ANA], docs: { [ids[0]]: doc } })).toBe(true);
  });
});

describe("isRoundOpen: ya firmo alguien y falta otra persona", () => {
  const files = [pdf("a.pdf", 11), pdf("b.pdf", 12)];
  const [d1, d2] = files.map(docIdOf);
  const keys = { [d1]: "k1", [d2]: "k2" };
  const docs = {
    [d1]: { ...EMPTY_DOC_STATE, fields: [slot("sg-1", "f1"), slot("sg-2", "f2")], sealedKey: "k1" },
    [d2]: { ...EMPTY_DOC_STATE, fields: [slot("sg-1", "f3"), slot("sg-2", "f4")], sealedKey: "k2" },
  };
  const block = (signerId: string, signed: boolean): SignerBlock => ({
    id: `bk-${signerId}`,
    signerId,
    appliesTo: [d1, d2],
    signature: signed ? STROKE : null,
    initials: null,
    stamps: signed
      ? { [d1]: captureStamp("k1", docs[d1].fields, signerId), [d2]: captureStamp("k2", docs[d2].fields, signerId) }
      : {},
    auto: true,
  });
  const session = (signed: string[]) => ({
    signers: [ANA, LUIS],
    docs,
    blocks: [block("sg-1", signed.includes("sg-1")), block("sg-2", signed.includes("sg-2"))],
  });
  const single = { signers: [], fields: [], captures: {}, signature: "", textEdits: undefined };

  it("nadie ha firmado: la ronda esta en reposo, no «a medias»", () => {
    expect(isRoundOpen({ files, session: session([]), options: single, keys })).toBe(false);
  });

  it("uno firmo y el otro no: a medias", () => {
    expect(isRoundOpen({ files, session: session(["sg-1"]), options: single, keys })).toBe(true);
  });

  it("firmaron todos: ya no esta a medias", () => {
    expect(isRoundOpen({ files, session: session(["sg-1", "sg-2"]), options: single, keys })).toBe(false);
  });

  it("sin huella de algun documento (aun calculandose) se cuenta como a medias: ante la duda, se avisa", () => {
    expect(isRoundOpen({ files, session: session(["sg-1", "sg-2"]), options: single, keys: { [d1]: "k1", [d2]: null } })).toBe(true);
  });

  it("con UN documento se mide con las capturas del documento", () => {
    const one = [files[0]];
    const field = slot("sg-1", "f1");
    const field2 = slot("sg-2", "f2");
    const opts = (captures: Record<string, never>) => ({
      signers: [ANA, LUIS],
      fields: [field, field2],
      captures: captures as never,
      signature: "k1",
      textEdits: undefined,
    });
    const anaDone = { "sg-1": { signature: STROKE, initials: null, stamp: captureStamp("k1", [field, field2], "sg-1") } } as never;
    expect(isRoundOpen({ files: one, session: session([]), options: opts({} as never), keys: {} })).toBe(false);
    expect(isRoundOpen({ files: one, session: session([]), options: opts(anaDone), keys: {} })).toBe(true);
    const both = {
      ...(anaDone as object),
      "sg-2": { signature: STROKE, initials: null, stamp: captureStamp("k1", [field, field2], "sg-2") },
    } as never;
    expect(isRoundOpen({ files: one, session: session([]), options: opts(both), keys: {} })).toBe(false);
  });
});

describe("hasSoloWork: «Solo yo» no guarda borrador, asi que lo hecho ahi no tiene red (F0-fix, D2)", () => {
  const files = [pdf("a.pdf", 21), pdf("b.pdf", 22)];
  const ids = files.map(docIdOf);
  const solo: SignSession = { ...DEFAULT_SESSION, mode: "single", docOrder: ids, activeDocId: ids[0] };

  it("sin tocar nada (solo se subio el PDF) no hay trabajo que perder", () => {
    expect(hasSoloWork(files, solo)).toBe(false);
    expect(hasSoloWork([files[0]], solo)).toBe(false);
  });

  it("crear la firma cuenta; tambien cualquier valor escrito en un campo o un texto editado", () => {
    expect(hasSoloWork(files, { ...solo, signaturePng: "data:image/png;base64,AAAA" })).toBe(true);
    expect(hasSoloWork(files, { ...solo, docs: { [ids[1]]: { ...EMPTY_DOC_STATE, textValues: { a: "x" } } } })).toBe(true);
    expect(
      hasSoloWork(files, {
        ...solo,
        docs: { [ids[0]]: { ...EMPTY_DOC_STATE, textEdits: [{ id: "e1", pageIndex: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, text: "nuevo", fontSize: 12 } as never] } },
      }),
    ).toBe(true);
  });

  it("solo existe en «Solo yo»: «Varios firmantes» se guarda y lo cuenta `hasSavedProgress`", () => {
    expect(hasSoloWork(files, { ...solo, mode: "multi", signaturePng: "data:image/png;base64,AAAA" })).toBe(false);
  });

  it("sin archivos no hay nada, aunque quede una firma en la sesion", () => {
    expect(hasSoloWork([], { ...solo, signaturePng: "data:image/png;base64,AAAA" })).toBe(false);
  });

  it("el valor de `?s=` de este modo NO es un id de borrador valido (recargar no restaura nada)", async () => {
    const { sessionTargetOf } = await import("@/app/sign-pdf/sessionUrl");
    expect(sessionTargetOf(SOLO_GUARD_ID)).toBeNull();
  });
});
