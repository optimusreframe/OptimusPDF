import { describe, expect, it } from "vitest";
import { captureForBlock } from "@/app/sign-pdf/blockModel";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { reviewDocument, reviewSession } from "@/app/sign-pdf/reviewModel";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/* «Revisar antes de descargar» (U1.3): paginas con marcas, contadores y huecos de iniciales. */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const D = "d1";
const SIG = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.5 };
const INI = { dataUrl: "data:image/png;base64,BBBB", ratio: 1 };
const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };

const slot = (id: string, signerId: string, pageIndex: number, type: SignatureField["type"]): SignatureField => ({
  id, signerId, pageIndex, type, rect: RECT,
});
const state = (fields: SignatureField[], extra: Partial<DocState> = {}): DocState => ({ ...EMPTY_DOC_STATE, fields, ...extra });
const block = (signerId: string, extra: Partial<SignerBlock> = {}): SignerBlock => ({
  id: `bk-${signerId}`, signerId, appliesTo: [D], signature: null, initials: null, stamps: {}, auto: false, ...extra,
});

function review(docState: DocState, blocks: SignerBlock[], pageCount?: number, signers: Signer[] = [ANA, LUIS]) {
  const ctx = { signers, docs: { [D]: docState }, keys: { [D]: "key" } };
  return reviewDocument({ docId: D, state: docState, signers, blocks, ctx, pageCount });
}
const signedBlocks = (docState: DocState, signerIds: string[], types: ("signature" | "initials")[] = ["signature", "initials"]) => {
  const ctx = { signers: [ANA, LUIS], docs: { [D]: docState }, keys: { [D]: "key" } };
  let blocks = signerIds.map((id) => block(id));
  for (const b of [...blocks]) {
    blocks = captureForBlock(blocks, b.id, Object.fromEntries(types.map((t) => [t, t === "signature" ? SIG : INI])), ctx);
  }
  return blocks;
};

describe("reviewDocument — paginas con marcas", () => {
  it("solo salen las paginas que llevan firma, iniciales o texto, por orden, con cada marca y su estado", () => {
    const text: DetectedField = { id: "t1", pageIndex: 2, rect: RECT, source: "acroform", confidence: "high" };
    const doc = state(
      [slot("s1", ANA.id, 3, "signature"), slot("i1", ANA.id, 0, "initials"), slot("i2", ANA.id, 3, "initials")],
      { textFields: [text], textValues: { t1: "hola" } },
    );
    const result = review(doc, signedBlocks(doc, [ANA.id]), 5);
    expect(result.pages.map((page) => page.pageIndex)).toEqual([0, 2, 3]);
    expect(result.pages[2].marks.map((mark) => [mark.kind, mark.done])).toEqual([["signature", true], ["initials", true]]);
    expect(result.pages[1].marks).toEqual([expect.objectContaining({ kind: "text", signerId: null, done: true })]);
  });

  it("una marca sin trazo o sin texto no esta hecha", () => {
    const text: DetectedField = { id: "t1", pageIndex: 0, rect: RECT, source: "acroform", confidence: "high" };
    const doc = state([slot("s1", ANA.id, 0, "signature")], { textFields: [text], textValues: {} });
    const result = review(doc, [block(ANA.id)]);
    expect(result.pages[0].marks.map((mark) => mark.done)).toEqual([false, false]);
    expect(result.signatures).toEqual({ done: 0, total: 1 });
    expect(result.text).toEqual({ done: 0, total: 1 });
  });

  it("las sugerencias de campo sin tocar no cuentan como texto del documento", () => {
    const suggestion: DetectedField = { id: "t1", pageIndex: 0, rect: RECT, source: "heuristic-vector", confidence: "low" };
    const result = review(state([], { textFields: [suggestion] }), []);
    expect(result.text).toEqual({ done: 0, total: 0 });
    expect(result.pages).toEqual([]);
  });

  it("un hueco de un firmante que ya no esta en la lista no se cuenta", () => {
    const doc = state([slot("s1", "sg-borrado", 0, "signature"), slot("s2", ANA.id, 1, "signature")]);
    expect(review(doc, [block(ANA.id)]).pages.map((page) => page.pageIndex)).toEqual([1]);
  });
});

describe("reviewDocument — contadores", () => {
  it("firmas: hechas de total, por hueco", () => {
    const doc = state([slot("s1", ANA.id, 1, "signature"), slot("s2", LUIS.id, 1, "signature")]);
    const blocks = signedBlocks(doc, [ANA.id], ["signature"]);
    expect(review(doc, [...blocks, block(LUIS.id)]).signatures).toEqual({ done: 1, total: 2 });
  });

  it("iniciales repetidas por todo el cuerpo: «8 de 8» con 2 firmantes y 4 paginas", () => {
    const fields = [0, 1, 2, 3].flatMap((page) => [slot(`a${page}`, ANA.id, page, "initials"), slot(`l${page}`, LUIS.id, page, "initials")]);
    const doc = state(fields);
    const result = review(doc, signedBlocks(doc, [ANA.id, LUIS.id], ["initials"]), 4);
    expect(result.initials).toEqual({ done: 8, expected: 8 });
    expect(result.initialsGaps).toEqual([]);
  });

  it("faltan iniciales en una pagina del cuerpo -> «6 de 8» (esperado = paginas x firmantes) y avisa de que paginas", () => {
    const fields = [0, 1, 3].flatMap((page) => [slot(`a${page}`, ANA.id, page, "initials"), slot(`l${page}`, LUIS.id, page, "initials")]);
    const doc = state(fields);
    const result = review(doc, signedBlocks(doc, [ANA.id, LUIS.id], ["initials"]), 4);
    expect(result.initials).toEqual({ done: 6, expected: 8 });
    expect(result.initialsGaps).toEqual([
      { signerId: ANA.id, pages: [2] },
      { signerId: LUIS.id, pages: [2] },
    ]);
  });

  it("una pagina que solo lleva la firma de ese firmante no se espera con iniciales (la ultima del contrato)", () => {
    const fields = [
      slot("a0", ANA.id, 0, "initials"), slot("a1", ANA.id, 1, "initials"), slot("a2", ANA.id, 2, "signature"),
    ];
    const doc = state(fields);
    const result = review(doc, signedBlocks(doc, [ANA.id]), 3);
    expect(result.initials).toEqual({ done: 2, expected: 2 });
    expect(result.initialsGaps).toEqual([]);
  });

  it("con una sola inicial colocada no hay patron de «repetidas»: se espera exactamente lo colocado", () => {
    const doc = state([slot("a0", ANA.id, 0, "initials")]);
    const result = review(doc, signedBlocks(doc, [ANA.id], ["initials"]), 6);
    expect(result.initials).toEqual({ done: 1, expected: 1 });
    expect(result.initialsGaps).toEqual([]);
  });

  it("mas iniciales colocadas que paginas del cuerpo: se espera al menos lo colocado", () => {
    const doc = state([slot("a0", ANA.id, 0, "initials"), slot("a1", ANA.id, 0, "initials")]);
    const result = review(doc, signedBlocks(doc, [ANA.id], ["initials"]), 1);
    expect(result.initials).toEqual({ done: 2, expected: 2 });
  });

  it("sin el numero de paginas todavia no se inventa un esperado ni un aviso", () => {
    const doc = state([slot("a0", ANA.id, 0, "initials"), slot("a1", ANA.id, 1, "initials")]);
    const result = review(doc, signedBlocks(doc, [ANA.id], ["initials"]), undefined);
    expect(result.initials).toEqual({ done: 2, expected: 2 });
    expect(result.initialsGaps).toEqual([]);
  });

  it("iniciales sin trazo: 0 de N", () => {
    const doc = state([slot("a0", ANA.id, 0, "initials"), slot("a1", ANA.id, 1, "initials")]);
    expect(review(doc, [block(ANA.id)], 2).initials).toEqual({ done: 0, expected: 2 });
  });
});

describe("reviewSession", () => {
  it("devuelve un resumen por documento de la cola con SU numero de paginas", () => {
    const docA = state([slot("a0", ANA.id, 0, "initials"), slot("a1", ANA.id, 1, "initials")]);
    const ctx = { signers: [ANA], docs: { d1: docA }, keys: { d1: "key", d2: "key" } };
    const out = reviewSession({
      docIds: ["d1", "d2"],
      docs: { d1: docA },
      signers: [ANA],
      blocks: [],
      ctx,
      pageCounts: { d1: 4, d2: undefined },
    });
    expect(out.map((entry) => entry.docId)).toEqual(["d1", "d2"]);
    expect(out[0].initials.expected).toBe(4);
    expect(out[1].pages).toEqual([]);
  });
});
