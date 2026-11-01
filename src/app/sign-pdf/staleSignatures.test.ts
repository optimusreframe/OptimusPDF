import { describe, expect, it } from "vitest";
import { captureStamp, staleCaptureReason, staleReason, type CaptureMap } from "@/app/sign-pdf/captures";
import {
  captureForBlock,
  isSignerDone,
  resolveCeremony,
  staleSigners,
  type BlockContext,
} from "@/app/sign-pdf/blockModel";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * F0-fix · D7: si se edita el texto del documento (o sus huecos) DESPUES de que alguien firmo, su firma deja de valer y la
 * pantalla tiene que poder decir QUE paso y quien debe firmar otra vez.
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const STROKE = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };
const A = "doc-a";
const B = "doc-b";
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

const slot = (id: string, signerId: string): SignatureField => ({
  id,
  signerId,
  pageIndex: 0,
  type: "signature",
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
});

const docStates = (): Record<string, DocState> => ({
  [A]: { ...EMPTY_DOC_STATE, fields: [slot("a1", ANA.id), slot("a2", LUIS.id)] },
  [B]: { ...EMPTY_DOC_STATE, fields: [slot("b1", ANA.id), slot("b2", LUIS.id)] },
});

const EDIT = makeEdit({ id: "e1", blockId: "p0-b0", text: "nuevo" });

const ctxWith = (keys: Record<string, string | null>, docs = docStates()): BlockContext => ({ signers: [ANA, LUIS], docs, keys });

function freshBlocks(): SignerBlock[] {
  return [
    { id: "bk-1", signerId: ANA.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: true },
    { id: "bk-2", signerId: LUIS.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: true },
  ];
}

/** Ana y Luis firman con el documento tal cual (sin ediciones). */
function bothSigned(): SignerBlock[] {
  const ctx = ctxWith({ [A]: FP_A, [B]: FP_B });
  let blocks = freshBlocks();
  blocks = captureForBlock(blocks, "bk-1", { signature: STROKE }, ctx);
  blocks = captureForBlock(blocks, "bk-2", { signature: STROKE }, ctx);
  return blocks;
}

describe("staleReason: por que un sello ya no vale", () => {
  const fields = [slot("f1", ANA.id)];
  const stamp = (key: string, list = fields) => captureStamp(key, list, ANA.id);

  it("el mismo sello vale; sin sello guardado no hay nada que decir", () => {
    expect(staleReason(stamp(FP_A), stamp(FP_A))).toBeNull();
    expect(staleReason("", stamp(FP_A))).toBeNull();
  });

  it("mismo archivo con OTRAS ediciones de texto (o ediciones donde antes no habia): «text»", () => {
    expect(staleReason(stamp(FP_A), stamp(stampKeyOf(FP_A, [EDIT])))).toBe("text");
    expect(staleReason(stamp(stampKeyOf(FP_A, [EDIT])), stamp(FP_A))).toBe("text");
    expect(staleReason(stamp(stampKeyOf(FP_A, [EDIT])), stamp(stampKeyOf(FP_A, [makeEdit({ id: "e1", blockId: "p0-b0", text: "otro" })])))).toBe("text");
  });

  it("misma huella y OTROS huecos de firma: sigue valiendo (null); los sellos antiguos con huecos tras «~» tambien", () => {
    expect(staleReason(stamp(FP_A), stamp(FP_A, [slot("f1", ANA.id), slot("f2", ANA.id)]))).toBeNull();
    expect(staleReason(`${FP_A}~f1|0|signature|0.1|0.1|0.3|0.1`, stamp(FP_A, [slot("f9", ANA.id)]))).toBeNull();
    expect(staleReason(`${FP_A}~f1|0|signature|0.1|0.1|0.3|0.1`, stamp(FP_B))).toBe("document");
  });

  it("otro archivo: «document»", () => {
    expect(staleReason(stamp(FP_A), stamp(FP_B))).toBe("document");
    expect(staleReason(stamp(stampKeyOf(FP_A, [EDIT])), stamp(FP_B))).toBe("document");
  });
});

describe("staleSigners (varios documentos)", () => {
  it("nadie esta obsoleto mientras todo valga o nadie haya firmado", () => {
    const ctx = ctxWith({ [A]: FP_A, [B]: FP_B });
    expect(staleSigners(bothSigned(), ctx, [A, B])).toEqual([]);
    expect(staleSigners(freshBlocks(), ctx, [A, B])).toEqual([]);
  });

  it("tras editar el TEXTO de un documento, cada firmante que ya habia firmado queda «text»: vuelve a estar pendiente y se sabe por que", () => {
    const edited = ctxWith({ [A]: stampKeyOf(FP_A, [EDIT]) as string, [B]: FP_B });
    const blocks = bothSigned();
    expect(isSignerDone(blocks, ANA.id, edited)).toBe(false);
    expect(staleSigners(blocks, edited, [A, B])).toEqual([
      { signerId: ANA.id, reason: "text" },
      { signerId: LUIS.id, reason: "text" },
    ]);
  });

  it("si solo firmo Ana, solo Ana esta obsoleta (Luis nunca firmo: esta pendiente, no «volver a firmar»)", () => {
    const ctx = ctxWith({ [A]: FP_A, [B]: FP_B });
    const blocks = captureForBlock(freshBlocks(), "bk-1", { signature: STROKE }, ctx);
    const edited = ctxWith({ [A]: stampKeyOf(FP_A, [EDIT]) as string, [B]: FP_B });
    expect(staleSigners(blocks, edited, [A, B])).toEqual([{ signerId: ANA.id, reason: "text" }]);
  });

  it("en cuanto la firmante vuelve a firmar con el documento ya editado, deja de estar obsoleta", () => {
    const edited = ctxWith({ [A]: stampKeyOf(FP_A, [EDIT]) as string, [B]: FP_B });
    const blocks = captureForBlock(bothSigned(), "bk-1", { signature: STROKE }, edited);
    expect(isSignerDone(blocks, ANA.id, edited)).toBe(true);
    expect(staleSigners(blocks, edited, [A, B])).toEqual([{ signerId: LUIS.id, reason: "text" }]);
  });

  it("si cambian los huecos no hay motivo; si cambia el archivo, «document»; con varios motivos manda el texto", () => {
    const blocks = bothSigned();
    const moved = docStates();
    moved[A] = { ...moved[A], fields: [slot("a1", ANA.id), slot("a1b", ANA.id), slot("a2", LUIS.id)] };
    expect(staleSigners(blocks, ctxWith({ [A]: FP_A, [B]: FP_B }, moved), [A, B])).toEqual([]);
    expect(staleSigners(blocks, ctxWith({ [A]: "c".repeat(64), [B]: FP_B }), [A, B])[0]).toEqual({ signerId: ANA.id, reason: "document" });
    expect(staleSigners(blocks, ctxWith({ [A]: "c".repeat(64), [B]: stampKeyOf(FP_B, [EDIT]) as string }), [A, B])[0]).toEqual({
      signerId: ANA.id,
      reason: "text",
    });
  });

  it("sin huella de algun documento (aun calculandose) no se dice nada", () => {
    expect(staleSigners(bothSigned(), ctxWith({ [A]: null, [B]: FP_B }), [A, B])).toEqual([]);
  });

  it("un firmante sin huecos en ningun documento no tiene turno y nunca esta obsoleto", () => {
    const blocks = bothSigned();
    const noLuis = docStates();
    noLuis[A] = { ...noLuis[A], fields: [slot("a1", ANA.id)] };
    noLuis[B] = { ...noLuis[B], fields: [slot("b1", ANA.id)] };
    const edited = ctxWith({ [A]: stampKeyOf(FP_A, [EDIT]) as string, [B]: FP_B }, noLuis);
    expect(staleSigners(blocks, edited, [A, B]).map((item) => item.signerId)).toEqual([ANA.id]);
  });
});

describe("staleCaptureReason (un documento)", () => {
  const fields = [slot("a1", ANA.id)];
  const captures = (key: string): CaptureMap => ({ [ANA.id]: { signature: STROKE, initials: null, stamp: captureStamp(key, fields, ANA.id) } });

  it("sin trazo, o con el sello vigente, no hay nada que decir", () => {
    expect(staleCaptureReason({}, fields, ANA.id, FP_A)).toBeNull();
    expect(staleCaptureReason({ [ANA.id]: { signature: null, initials: null, stamp: "" } }, fields, ANA.id, FP_A)).toBeNull();
    expect(staleCaptureReason(captures(FP_A), fields, ANA.id, FP_A)).toBeNull();
    expect(staleCaptureReason(captures(FP_A), fields, ANA.id, null)).toBeNull();
  });

  it("editar el texto despues de firmar: «text»", () => {
    expect(staleCaptureReason(captures(FP_A), fields, ANA.id, stampKeyOf(FP_A, [EDIT]) as string)).toBe("text");
  });
});

describe("resolveCeremony: el turno vuelve a quien debe volver a firmar", () => {
  const queue = [{ id: ANA.id }, { id: LUIS.id }];
  const isDone = () => false;

  it("con un turno guardado de Luis y la firma de Ana obsoleta, el turno vuelve a ANA, en el traspaso", () => {
    expect(resolveCeremony({ signerId: LUIS.id, stage: "capture" }, queue, isDone, ANA.id)).toEqual({ index: 0, stage: "handoff" });
    expect(resolveCeremony({ signerId: LUIS.id, stage: "handoff" }, queue, isDone, ANA.id)).toEqual({ index: 0, stage: "handoff" });
  });

  it("si el turno guardado YA es de quien debe volver a firmar, se respeta su etapa", () => {
    expect(resolveCeremony({ signerId: ANA.id, stage: "capture" }, queue, isDone, ANA.id)).toEqual({ index: 0, stage: "capture" });
  });

  it("sin obsoletos, manda el turno guardado como siempre", () => {
    expect(resolveCeremony({ signerId: LUIS.id, stage: "capture" }, queue, isDone, null)).toEqual({ index: 1, stage: "capture" });
    expect(resolveCeremony({ signerId: LUIS.id, stage: "capture" }, queue, isDone)).toEqual({ index: 1, stage: "capture" });
  });

  it("un firmante obsoleto que ya no esta en la cola no desvia a nadie", () => {
    expect(resolveCeremony({ signerId: LUIS.id, stage: "capture" }, queue, isDone, "sg-9")).toEqual({ index: 1, stage: "capture" });
  });

  it("sin turno guardado, el primer pendiente (que es el obsoleto o uno anterior) en el traspaso", () => {
    expect(resolveCeremony(null, queue, isDone, LUIS.id)).toEqual({ index: 1, stage: "handoff" });
  });
});
