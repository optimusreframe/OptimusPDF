import { describe, expect, it } from "vitest";
import {
  EMPTY_DOC_STATE,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { captureForBlock } from "@/app/sign-pdf/blockModel";
import {
  blockerMessages,
  deliveryBlockers,
  signersForDoc,
} from "@/app/sign-pdf/multiDelivery";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

const strings = SIGN_STRINGS.es;

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const A = "doc-a";
const B = "doc-b";
const C = "doc-c";
const ORDER = [A, B];
const SIG: SignatureDraft = { dataUrl: "data:image/png;base64,SIG", ratio: 0.3 };

function slot(id: string, signerId: string): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  };
}

function doc(fields: SignatureField[], extra: Partial<DocState> = {}): DocState {
  return { ...EMPTY_DOC_STATE, fields, sealedKey: "", ...extra };
}

function block(id: string, signerId: string, appliesTo: string[]): SignerBlock {
  return {
    id,
    signerId,
    appliesTo,
    signature: null,
    initials: null,
    stamps: {},
    auto: false,
  };
}

function session(patch: Partial<SignSession>): SignSession {
  return { ...DEFAULT_SESSION, mode: "multi", docOrder: ORDER, ...patch };
}

const TEXT_FIELD: DetectedField = {
  id: "t1",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 },
  label: "Nombre",
  source: "acroform",
  confidence: "high",
};

/** Ana firma A y B; Luis solo A. Sellos listos. */
function readySession(): SignSession {
  const docs = {
    [A]: doc([slot("a1", ANA.id), slot("a2", LUIS.id)], { sealedKey: "key-a" }),
    [B]: doc([slot("b1", ANA.id)], { sealedKey: "key-b" }),
  };
  const ctx = { signers: [ANA, LUIS], docs, keys: { [A]: "key-a", [B]: "key-b" } };
  let blocks = [block("bk-1", ANA.id, [A, B]), block("bk-2", LUIS.id, [A])];
  blocks = captureForBlock(blocks, "bk-1", { signature: SIG }, ctx);
  blocks = captureForBlock(blocks, "bk-2", { signature: SIG }, ctx);
  return session({ signers: [ANA, LUIS], docs, blocks });
}

describe("signersForDoc — quien firma cada documento", () => {
  it("solo los firmantes con bloque que lo cubre Y huecos en el: Luis no aparece en B", () => {
    const current = readySession();
    expect(signersForDoc(current, A).map((s) => s.name)).toEqual(["Ana", "Luis"]);
    expect(signersForDoc(current, B).map((s) => s.name)).toEqual(["Ana"]);
  });

  it("un firmante con huecos pero sin bloque que cubra el documento no cuenta", () => {
    const current = readySession();
    const without = { ...current, blocks: current.blocks.filter((b) => b.signerId !== LUIS.id) };
    expect(signersForDoc(without, A).map((s) => s.name)).toEqual(["Ana"]);
  });

  it("un bloque que cubre el documento pero cuyo firmante no tiene huecos alli no lo hace firmante", () => {
    const current = readySession();
    const widened = {
      ...current,
      blocks: current.blocks.map((b) => (b.id === "bk-2" ? { ...b, appliesTo: [A, B] } : b)),
    };
    expect(signersForDoc(widened, B).map((s) => s.name)).toEqual(["Ana"]);
  });

  it("mantiene el orden de la lista de firmantes aunque los bloques esten al reves", () => {
    const current = readySession();
    const reversed = { ...current, blocks: [...current.blocks].reverse() };
    expect(signersForDoc(reversed, A).map((s) => s.name)).toEqual(["Ana", "Luis"]);
  });

  it("sin huecos en el documento no hay firmantes (nombre sin prefijo)", () => {
    const current = session({
      signers: [ANA],
      docs: { [A]: doc([]) },
      blocks: [block("bk-1", ANA.id, [A])],
    });
    expect(signersForDoc(current, A)).toEqual([]);
  });

  it("los huecos de un firmante quitado de la lista no cuentan", () => {
    const current = readySession();
    expect(signersForDoc({ ...current, signers: [ANA] }, A).map((s) => s.name)).toEqual(["Ana"]);
  });
});

describe("deliveryBlockers — que impide descargar la ronda", () => {
  it("una ronda completa no tiene bloqueos", () => {
    expect(deliveryBlockers(readySession(), ORDER)).toEqual([]);
  });

  it("«Varios»: bloques sin firmar -> un pendiente por firmante con el numero de documentos", () => {
    const current = readySession();
    const unsigned = {
      ...current,
      blocks: current.blocks.map((b) => ({ ...b, signature: null, stamps: {} })),
    };
    expect(deliveryBlockers(unsigned, ORDER)).toEqual([
      { kind: "pending", signerId: ANA.id, count: 1 },
      { kind: "pending", signerId: LUIS.id, count: 1 },
    ]);
  });

  it("«Varios»: el recuento de pendientes son BLOQUES, no documentos (un bloque sobre 3 documentos = 1)", () => {
    const docs = {
      [A]: doc([slot("a1", ANA.id)], { sealedKey: "key-a" }),
      [B]: doc([slot("b1", ANA.id)], { sealedKey: "key-b" }),
      [C]: doc([slot("c1", ANA.id)], { sealedKey: "key-c" }),
    };
    const one = session({
      signers: [ANA],
      docs,
      blocks: [block("bk-1", ANA.id, [A, B, C])],
      docOrder: [A, B, C],
    });
    expect(deliveryBlockers(one, [A, B, C])).toEqual([
      { kind: "pending", signerId: ANA.id, count: 1 },
    ]);
    const two = { ...one, blocks: [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B, C])] };
    expect(deliveryBlockers(two, [A, B, C])).toEqual([
      { kind: "pending", signerId: ANA.id, count: 2 },
    ]);
  });

  it("«Varios»: un firmante con huecos en un documento que ningun bloque cubre es COBERTURA, no pendiente", () => {
    const current = readySession();
    const holed = {
      ...current,
      blocks: current.blocks.map((b) => (b.id === "bk-1" ? { ...b, appliesTo: [A], stamps: { [A]: b.stamps[A] } } : b)),
    };
    expect(deliveryBlockers(holed, ORDER)).toEqual([
      { kind: "coverage", signerId: ANA.id, docId: B },
    ]);
  });

  it("«Varios»: sin huella de algun documento, espera (y no marca a todos como pendientes)", () => {
    const current = readySession();
    const noKey = {
      ...current,
      docs: { ...current.docs, [B]: { ...current.docs[B], sealedKey: "" } },
    };
    expect(deliveryBlockers(noKey, ORDER)).toEqual([{ kind: "keys" }]);
  });

  it("«Varios»: un documento sin huecos ni campos rellenos bloquea; con un campo relleno ya no", () => {
    const current = readySession();
    const emptyDoc = {
      ...current,
      docs: { ...current.docs, [B]: doc([], { sealedKey: "key-b" }) },
    };
    expect(deliveryBlockers(emptyDoc, ORDER)).toEqual([{ kind: "empty", docId: B }]);
    const filled = {
      ...emptyDoc,
      docs: {
        ...emptyDoc.docs,
        [B]: doc([], {
          sealedKey: "key-b",
          textFields: [TEXT_FIELD],
          textValues: { t1: "Ana Pérez" },
        }),
      },
    };
    expect(deliveryBlockers(filled, ORDER)).toEqual([]);
  });

  it("«Varios»: si solo hay campos de texto rellenos no hace falta huella", () => {
    const current = session({
      signers: [],
      docs: {
        [A]: doc([], { textFields: [TEXT_FIELD], textValues: { t1: "x" } }),
        [B]: doc([], { textFields: [TEXT_FIELD], textValues: { t1: "y" } }),
      },
    });
    expect(deliveryBlockers(current, ORDER)).toEqual([]);
  });

  it("«Solo yo» sin firma creada: un bloqueo", () => {
    expect(deliveryBlockers(session({ mode: "single", signaturePng: "" }), ORDER)).toEqual([
      { kind: "noSignature" },
    ]);
  });

  it("«Solo yo»: cada documento sin firma colocada bloquea, con el nombre del que falta", () => {
    const placed = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };
    const current = session({
      mode: "single",
      signaturePng: "data:image/png;base64,SIG",
      docs: { [A]: doc([], { rect: placed }), [B]: doc([]) },
    });
    expect(deliveryBlockers(current, ORDER)).toEqual([{ kind: "soloUnplaced", docId: B }]);
    const both = {
      ...current,
      docs: { ...current.docs, [B]: doc([], { rect: placed }) },
    };
    expect(deliveryBlockers(both, ORDER)).toEqual([]);
  });

  it("«Solo yo» no exige huellas ni bloques", () => {
    const placed = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };
    const current = session({
      mode: "single",
      signaturePng: "data:image/png;base64,SIG",
      docs: { [A]: doc([], { rect: placed }), [B]: doc([], { rect: placed }) },
      blocks: [],
    });
    expect(deliveryBlockers(current, ORDER)).toEqual([]);
  });
});

describe("blockerMessages — frases con nombres de firmante y de documento", () => {
  const docs = [
    { id: A, name: "Contrato A.pdf" },
    { id: B, name: "Anexo.pdf" },
  ];

  it("traduce cada bloqueo con el nombre del documento sin .pdf", () => {
    const messages = blockerMessages(
      [
        { kind: "coverage", signerId: ANA.id, docId: B },
        { kind: "pending", signerId: LUIS.id, count: 2 },
        { kind: "empty", docId: A },
        { kind: "soloUnplaced", docId: B },
        { kind: "noSignature" },
        { kind: "keys" },
      ],
      { signers: [ANA, LUIS], docs },
      strings,
    );
    expect(messages).toEqual([
      strings.coverageMissing("Ana", "Anexo"),
      strings.batchPendingBlocks("Luis", 2),
      strings.batchDocEmpty("Contrato A"),
      strings.batchSoloUnplaced("Anexo"),
      strings.noSignature,
      strings.checkingDocument,
    ]);
  });

  it("«Falta el bloque de Ana para Anexo»: el mensaje literal del contrato", () => {
    expect(
      blockerMessages([{ kind: "coverage", signerId: ANA.id, docId: B }], { signers: [ANA], docs }, strings)[0],
    ).toBe("Falta el bloque de Ana para Anexo.");
  });

  it("existe en ingles", () => {
    const [message] = blockerMessages(
      [{ kind: "coverage", signerId: ANA.id, docId: B }],
      { signers: [ANA], docs },
      SIGN_STRINGS.en,
    );
    expect(message).toContain("Ana");
    expect(message).toContain("Anexo");
  });

  it("un firmante sin nombre usa «Firmante N»", () => {
    const [message] = blockerMessages(
      [{ kind: "pending", signerId: LUIS.id, count: 1 }],
      { signers: [ANA, { ...LUIS, name: "" }], docs },
      strings,
    );
    expect(message).toBe(strings.batchPendingBlocks("Firmante 2", 1));
  });
});
