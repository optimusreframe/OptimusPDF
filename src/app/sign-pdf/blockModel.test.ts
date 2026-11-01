import { describe, expect, it } from "vitest";
import {
  EMPTY_DOC_STATE,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { captureStamp } from "@/app/sign-pdf/captures";
import {
  addBlock,
  applySavedToBlocks,
  blockNumber,
  blockRequiredTypes,
  blockSlotDocs,
  captureForBlock,
  captureTypeLabel,
  ceremonyAt,
  ceremonyQueue,
  changeBlockScope,
  clearBlock,
  docLabel,
  firstPendingTurn,
  isBlockComplete,
  isSignerCompleteEverywhere,
  isSignerDone,
  pendingBlockCount,
  pendingBlockSigners,
  rememberSource,
  removeBlock,
  resolveCeremony,
  sanitizeCeremony,
  scopeSummary,
  signerLabel,
  turnItemLabel,
  turnProgress,
  visibleDraft,
  type BlockContext,
  type CeremonyState,
  type DocRef,
} from "@/app/sign-pdf/blockModel";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

const strings = SIGN_STRINGS.es;

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

const A = "doc-a";
const B = "doc-b";
const C = "doc-c";
const DOCS: DocRef[] = [
  { id: A, name: "Contrato A.pdf" },
  { id: B, name: "Anexo.pdf" },
  { id: C, name: "Acta.PDF" },
];
const ORDER = [A, B, C];

const KEYS = { [A]: "key-a", [B]: "key-b", [C]: "key-c" };

const SIG: SignatureDraft = { dataUrl: "data:image/png;base64,SIG", ratio: 0.3 };
const INI: SignatureDraft = { dataUrl: "data:image/png;base64,INI", ratio: 1 };
const OTHER_SIG: SignatureDraft = { dataUrl: "data:image/png;base64,OTHER", ratio: 0.4 };

function slot(
  id: string,
  signerId: string,
  type: SignatureField["type"] = "signature",
  x = 0.1,
): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type,
    rect: { x, y: 0.1, width: 0.3, height: 0.1 },
  };
}

function docState(fields: SignatureField[]): DocState {
  return { ...EMPTY_DOC_STATE, fields };
}

function block(
  id: string,
  signerId: string,
  appliesTo: string[],
  extra: Partial<SignerBlock> = {},
): SignerBlock {
  return {
    id,
    signerId,
    appliesTo,
    signature: null,
    initials: null,
    stamps: {},
    auto: false,
    ...extra,
  };
}

function context(
  docs: Record<string, DocState>,
  keys: Record<string, string | null> = KEYS,
  signers: Signer[] = [ANA, LUIS],
): BlockContext {
  return { signers, docs, keys };
}

/** Ana firma e inicia en A, firma en B y C; Luis firma en A. */
const BASE_DOCS = {
  [A]: docState([slot("a1", ANA.id), slot("a2", ANA.id, "initials"), slot("a3", LUIS.id)]),
  [B]: docState([slot("b1", ANA.id)]),
  [C]: docState([slot("c1", ANA.id)]),
};

describe("blockModel — que exige un bloque", () => {
  it("los tipos exigidos son la union de los huecos del firmante en los documentos del bloque", () => {
    const ctx = context(BASE_DOCS);
    expect(blockRequiredTypes(block("bk-1", ANA.id, [A, B, C]), ctx)).toEqual([
      "signature",
      "initials",
    ]);
    // Sin A, Ana solo firma (no hay iniciales en B ni C).
    expect(blockRequiredTypes(block("bk-2", ANA.id, [B, C]), ctx)).toEqual(["signature"]);
  });

  it("ignora los huecos de otros firmantes y los de documentos fuera del alcance", () => {
    const ctx = context(BASE_DOCS);
    expect(blockRequiredTypes(block("bk-3", LUIS.id, [B, C]), ctx)).toEqual([]);
    expect(blockRequiredTypes(block("bk-4", LUIS.id, [A]), ctx)).toEqual(["signature"]);
  });

  it("los huecos de un firmante quitado de la lista no cuentan", () => {
    const ctx = context(BASE_DOCS, KEYS, [LUIS]);
    expect(blockRequiredTypes(block("bk-5", ANA.id, [A, B]), ctx)).toEqual([]);
  });

  it("blockSlotDocs devuelve solo los documentos donde el firmante tiene huecos", () => {
    const ctx = context(BASE_DOCS);
    expect(blockSlotDocs(block("bk-1", LUIS.id, [A, B, C]), ctx)).toEqual([A]);
  });

  it("la cola de la ceremonia son los firmantes con huecos en algun documento, en orden", () => {
    expect(ceremonyQueue(context(BASE_DOCS), ORDER).map((s) => s.id)).toEqual([ANA.id, LUIS.id]);
    expect(ceremonyQueue(context({ [A]: docState([slot("a1", LUIS.id)]) }), [A]).map((s) => s.id)).toEqual([
      LUIS.id,
    ]);
    expect(ceremonyQueue(context({}), ORDER)).toEqual([]);
  });
});

describe("blockModel — escribir lo que el firmante crea (sello por documento, en el clic)", () => {
  it("guarda los trazos y calcula el sello de CADA documento del alcance con su huella y sus huecos", () => {
    const ctx = context(BASE_DOCS);
    const blocks = captureForBlock([block("bk-1", ANA.id, [A, B])], "bk-1", { signature: SIG, initials: INI }, ctx);
    const saved = blocks[0];
    expect(saved.signature).toEqual(SIG);
    expect(saved.initials).toEqual(INI);
    expect(saved.stamps[A]).toBe(captureStamp("key-a", BASE_DOCS[A].fields, ANA.id));
    expect(saved.stamps[B]).toBe(captureStamp("key-b", BASE_DOCS[B].fields, ANA.id));
    expect(saved.stamps[A]).not.toBe(saved.stamps[B]);
    expect(saved.stamps[C]).toBeUndefined();
  });

  it("completa el bloque cuando ya estan todos los tipos exigidos", () => {
    const ctx = context(BASE_DOCS);
    const only = captureForBlock([block("bk-1", ANA.id, [A, B])], "bk-1", { signature: SIG }, ctx);
    expect(isBlockComplete(only[0], ctx)).toBe(false);
    const both = captureForBlock(only, "bk-1", { initials: INI }, ctx);
    expect(isBlockComplete(both[0], ctx)).toBe(true);
    // La firma que ya estaba sigue ahi: el segundo guardado no la pisa.
    expect(both[0].signature).toEqual(SIG);
  });

  it("rehacer un tipo conserva el otro mientras siga vigente", () => {
    const ctx = context(BASE_DOCS);
    let blocks = captureForBlock([block("bk-1", ANA.id, [A])], "bk-1", { signature: SIG, initials: INI }, ctx);
    blocks = captureForBlock(blocks, "bk-1", { signature: OTHER_SIG }, ctx);
    expect(blocks[0].signature).toEqual(OTHER_SIG);
    expect(blocks[0].initials).toEqual(INI);
    expect(isBlockComplete(blocks[0], ctx)).toBe(true);
  });

  it("si los huecos se movieron desde que se creo, el trazo viejo SIGUE vigente (y guardar otro no pierde el que ya habia)", () => {
    const ctx = context(BASE_DOCS);
    const first = captureForBlock([block("bk-1", ANA.id, [A])], "bk-1", { signature: SIG, initials: INI }, ctx);
    // Se mueve el hueco de firma de Ana en A.
    const moved = context({
      ...BASE_DOCS,
      [A]: docState([slot("a1", ANA.id, "signature", 0.62), slot("a2", ANA.id, "initials"), slot("a3", LUIS.id)]),
    });
    expect(visibleDraft(first[0], "signature", moved)).toEqual(SIG);
    expect(isBlockComplete(first[0], moved)).toBe(true);
    const redone = captureForBlock(first, "bk-1", { signature: OTHER_SIG }, moved);
    expect(redone[0].signature).toEqual(OTHER_SIG);
    // Las iniciales de antes siguen: mover un hueco no las tira.
    expect(redone[0].initials).toEqual(INI);
    expect(isBlockComplete(redone[0], moved)).toBe(true);
  });

  it("sin huella de algun documento del alcance no hay sello para el y el bloque no se completa", () => {
    const ctx = context(BASE_DOCS, { ...KEYS, [B]: null });
    const blocks = captureForBlock([block("bk-1", ANA.id, [A, B])], "bk-1", { signature: SIG, initials: INI }, ctx);
    expect(blocks[0].stamps[A]).toBeTruthy();
    expect(blocks[0].stamps[B]).toBeUndefined();
    expect(isBlockComplete(blocks[0], ctx)).toBe(false);
  });

  it("un documento que entra en el alcance despues no tiene sello: el bloque vuelve a estar pendiente", () => {
    const ctx = context(BASE_DOCS);
    const done = captureForBlock([block("bk-1", ANA.id, [A])], "bk-1", { signature: SIG, initials: INI }, ctx);
    expect(isBlockComplete(done[0], ctx)).toBe(true);
    const widened = changeBlockScope(done, "bk-1", [A, B], DOCS, strings).blocks;
    expect(isBlockComplete(widened[0], ctx)).toBe(false);
    expect(widened[0].stamps[A]).toBe(done[0].stamps[A]);
    expect(widened[0].stamps[B]).toBeUndefined();
  });

  it("clearBlock vacia trazos y sellos", () => {
    const ctx = context(BASE_DOCS);
    const done = captureForBlock([block("bk-1", ANA.id, [A, B])], "bk-1", { signature: SIG, initials: INI }, ctx);
    const cleared = clearBlock(done, "bk-1");
    expect(cleared[0].signature).toBeNull();
    expect(cleared[0].initials).toBeNull();
    expect(cleared[0].stamps).toEqual({});
  });

  it("escribir en un bloque inexistente no cambia nada (misma lista)", () => {
    const blocks = [block("bk-1", ANA.id, [A])];
    expect(captureForBlock(blocks, "bk-99", { signature: SIG }, context(BASE_DOCS))).toBe(blocks);
  });

  it("el bloque de un firmante no toca el del otro", () => {
    const ctx = context(BASE_DOCS);
    const blocks = [block("bk-1", ANA.id, [A]), block("bk-2", LUIS.id, [A])];
    const next = captureForBlock(blocks, "bk-2", { signature: SIG }, ctx);
    expect(next[0].signature).toBeNull();
    expect(next[1].signature).toEqual(SIG);
  });
});

describe("blockModel — la ceremonia por bloques coincide con la validacion de la entrega", () => {
  it("isBlockComplete equivale a isSignerComplete documento a documento en cada escenario", () => {
    const ctx = context(BASE_DOCS);
    const scenarios: SignerBlock[][] = [
      [block("bk-1", ANA.id, [A, B, C])],
      [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B, C])],
      [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B]), block("bk-3", ANA.id, [C])],
    ];
    for (const scenario of scenarios) {
      // Nada firmado, solo firma, firma + iniciales por bloque, y el primer bloque solo.
      const variants: SignerBlock[][] = [scenario];
      let partial = scenario;
      for (const item of scenario) partial = captureForBlock(partial, item.id, { signature: SIG }, ctx);
      variants.push(partial);
      let full = scenario;
      for (const item of scenario) {
        full = captureForBlock(full, item.id, { signature: SIG, initials: INI }, ctx);
      }
      variants.push(full);
      variants.push(captureForBlock(scenario, scenario[0].id, { signature: SIG, initials: INI }, ctx));
      for (const blocks of variants) {
        const byBlock = blocks.every((item) => isBlockComplete(item, ctx));
        expect(isSignerCompleteEverywhere(blocks, ctx, ORDER, ANA.id)).toBe(byBlock);
      }
    }
  });

  it("pendingBlockCount y pendingBlockSigners cuentan solo lo que falta", () => {
    const ctx = context(BASE_DOCS);
    let blocks = [
      block("bk-1", ANA.id, [A, B]),
      block("bk-2", ANA.id, [C]),
      block("bk-3", LUIS.id, [A, B, C]),
    ];
    expect(pendingBlockCount(blocks, ANA.id, ctx)).toBe(2);
    expect(pendingBlockSigners(blocks, ctx, ORDER).map((s) => s.id)).toEqual([ANA.id, LUIS.id]);
    blocks = captureForBlock(blocks, "bk-1", { signature: SIG, initials: INI }, ctx);
    expect(pendingBlockCount(blocks, ANA.id, ctx)).toBe(1);
    blocks = captureForBlock(blocks, "bk-2", { signature: SIG }, ctx);
    expect(isSignerDone(blocks, ANA.id, ctx)).toBe(true);
    blocks = captureForBlock(blocks, "bk-3", { signature: SIG }, ctx);
    expect(pendingBlockSigners(blocks, ctx, ORDER)).toEqual([]);
  });

  it("un bloque cuyo firmante no tiene huecos en su alcance no exige nada", () => {
    const ctx = context(BASE_DOCS);
    const empty = block("bk-9", LUIS.id, [B, C]);
    expect(isBlockComplete(empty, ctx)).toBe(true);
    expect(pendingBlockCount([empty], LUIS.id, ctx)).toBe(0);
  });
});

describe("blockModel — aplicar una firma guardada", () => {
  const saved = { signature: SIG, initials: INI };

  it("rellena firma e iniciales del bloque elegido a la vez", () => {
    const ctx = context(BASE_DOCS);
    const result = applySavedToBlocks([block("bk-1", ANA.id, [A, B])], "bk-1", saved, false, ctx);
    expect(result.blocks[0].signature).toEqual(SIG);
    expect(result.blocks[0].initials).toEqual(INI);
    expect(result.missing).toEqual([]);
    expect(result.appliedBlockIds).toEqual(["bk-1"]);
    expect(isBlockComplete(result.blocks[0], ctx)).toBe(true);
  });

  it("lo que la entrada no trae NO se inventa y se informa", () => {
    const ctx = context(BASE_DOCS);
    const result = applySavedToBlocks(
      [block("bk-1", ANA.id, [A])],
      "bk-1",
      { signature: SIG, initials: null },
      false,
      ctx,
    );
    expect(result.blocks[0].initials).toBeNull();
    expect(result.missing).toEqual(["initials"]);
    expect(isBlockComplete(result.blocks[0], ctx)).toBe(false);
  });

  it("sin la casilla, los demas bloques del firmante no se tocan", () => {
    const ctx = context(BASE_DOCS);
    const blocks = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B, C])];
    const result = applySavedToBlocks(blocks, "bk-1", saved, false, ctx);
    expect(result.blocks[1].signature).toBeNull();
    expect(result.filledOthers).toBe(0);
  });

  it("«aplicar a todos mis bloques» rellena SOLO los vacios del mismo firmante", () => {
    const ctx = context(BASE_DOCS);
    let blocks = [
      block("bk-1", ANA.id, [A]),
      block("bk-2", ANA.id, [B]),
      block("bk-3", ANA.id, [C]),
      block("bk-4", LUIS.id, [A]),
    ];
    // bk-2 ya tiene SU firma: no se pisa.
    blocks = captureForBlock(blocks, "bk-2", { signature: OTHER_SIG }, ctx);
    const result = applySavedToBlocks(blocks, "bk-1", saved, true, ctx);
    const byId = Object.fromEntries(result.blocks.map((item) => [item.id, item]));
    expect(byId["bk-1"].signature).toEqual(SIG);
    expect(byId["bk-2"].signature).toEqual(OTHER_SIG);
    expect(byId["bk-3"].signature).toEqual(SIG);
    // Luis es otra persona.
    expect(byId["bk-4"].signature).toBeNull();
    expect(result.filledOthers).toBe(1);
    expect(result.appliedBlockIds).toEqual(["bk-1", "bk-3"]);
  });

  it("«aplicar a todos» rellena a nivel de tipo: un bloque con la firma pero sin iniciales recibe solo las iniciales", () => {
    const ctx = context({
      [A]: docState([slot("a1", ANA.id), slot("a2", ANA.id, "initials")]),
      [B]: docState([slot("b1", ANA.id), slot("b2", ANA.id, "initials")]),
    });
    let blocks = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B])];
    blocks = captureForBlock(blocks, "bk-2", { signature: OTHER_SIG }, ctx);
    const result = applySavedToBlocks(blocks, "bk-1", saved, true, ctx);
    const second = result.blocks.find((item) => item.id === "bk-2")!;
    expect(second.signature).toEqual(OTHER_SIG);
    expect(second.initials).toEqual(INI);
    expect(isBlockComplete(second, ctx)).toBe(true);
  });

  it("los sellos de los bloques rellenados son los de SUS documentos (no los del bloque elegido)", () => {
    const ctx = context(BASE_DOCS);
    const blocks = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B, C])];
    const result = applySavedToBlocks(blocks, "bk-1", saved, true, ctx);
    const second = result.blocks.find((item) => item.id === "bk-2")!;
    expect(second.stamps[B]).toBe(captureStamp("key-b", BASE_DOCS[B].fields, ANA.id));
    expect(second.stamps[C]).toBe(captureStamp("key-c", BASE_DOCS[C].fields, ANA.id));
    expect(second.stamps[A]).toBeUndefined();
  });

  it("un bloque inexistente no cambia nada", () => {
    const blocks = [block("bk-1", ANA.id, [A])];
    const result = applySavedToBlocks(blocks, "bk-x", saved, true, context(BASE_DOCS));
    expect(result.blocks).toBe(blocks);
    expect(result.appliedBlockIds).toEqual([]);
  });
});

describe("blockModel — anadir y quitar bloques (invariante: un documento, un bloque por firmante)", () => {
  function invariantHolds(blocks: readonly SignerBlock[]): boolean {
    const seen = new Set<string>();
    for (const item of blocks) {
      for (const doc of item.appliesTo) {
        const key = `${item.signerId}|${doc}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
    }
    return true;
  }

  it("anadir parte el bloque mas ancho: el nuevo se queda con su ULTIMO documento y se anota el movimiento", () => {
    const blocks = [block("bk-1", ANA.id, [A, B, C], { auto: true })];
    const added = addBlock(blocks, ANA.id, ORDER, undefined, () => "bk-new");
    expect(added.addedBlockId).toBe("bk-new");
    expect(added.blocks.find((item) => item.id === "bk-1")!.appliesTo).toEqual([A, B]);
    expect(added.blocks.find((item) => item.id === "bk-new")!.appliesTo).toEqual([C]);
    expect(added.moved).toEqual([{ docId: C, fromBlockId: "bk-1", toBlockId: "bk-new" }]);
    expect(invariantHolds(added.blocks)).toBe(true);
  });

  it("anadir no es posible si cada documento ya tiene su bloque", () => {
    const blocks = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B])];
    const added = addBlock(blocks, ANA.id, ORDER);
    expect(added.addedBlockId).toBeNull();
    expect(added.blocks).toBe(blocks);
  });

  it("anadir para un documento concreto (cobertura) crea el bloque de ese documento", () => {
    const blocks = [block("bk-1", ANA.id, [A])];
    const added = addBlock(blocks, ANA.id, ORDER, B, () => "bk-cov");
    expect(added.blocks.find((item) => item.id === "bk-cov")!.appliesTo).toEqual([B]);
    expect(added.moved).toEqual([]);
    expect(invariantHolds(added.blocks)).toBe(true);
  });

  it("el bloque nuevo nace sin trazos, sin sellos y no automatico", () => {
    const added = addBlock([block("bk-1", ANA.id, [A, B], { signature: SIG, stamps: { [A]: "x", [B]: "y" } })], ANA.id, ORDER, undefined, () => "bk-n");
    const fresh = added.blocks.find((item) => item.id === "bk-n")!;
    expect(fresh.signature).toBeNull();
    expect(fresh.stamps).toEqual({});
    expect(fresh.auto).toBe(false);
    // El que cede el documento conserva sus trazos y el sello de lo que le queda.
    const donor = added.blocks.find((item) => item.id === "bk-1")!;
    expect(donor.signature).toEqual(SIG);
    expect(donor.stamps).toEqual({ [A]: "x" });
  });

  it("quitar un bloque pasa sus documentos al ANTERIOR del mismo firmante", () => {
    const blocks = [
      block("bk-1", ANA.id, [A]),
      block("bk-2", ANA.id, [B]),
      block("bk-3", ANA.id, [C]),
      block("bk-4", LUIS.id, [A, B, C]),
    ];
    const removed = removeBlock(blocks, "bk-3", ORDER);
    expect(removed.receiverId).toBe("bk-2");
    expect(removed.blocks.find((item) => item.id === "bk-2")!.appliesTo).toEqual([B, C]);
    expect(removed.blocks.some((item) => item.id === "bk-3")).toBe(false);
    expect(removed.movedDocs).toEqual([C]);
    // Luis no se toca.
    expect(removed.blocks.find((item) => item.id === "bk-4")!.appliesTo).toEqual([A, B, C]);
    expect(invariantHolds(removed.blocks)).toBe(true);
  });

  it("quitar el PRIMERO pasa sus documentos al siguiente, en el orden de la cola", () => {
    const blocks = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B, C])];
    const removed = removeBlock(blocks, "bk-1", ORDER);
    expect(removed.receiverId).toBe("bk-2");
    expect(removed.blocks.find((item) => item.id === "bk-2")!.appliesTo).toEqual([A, B, C]);
  });

  it("los documentos que llegan al bloque receptor NO traen sello: hay que confirmarlos", () => {
    const ctx = context(BASE_DOCS);
    let blocks = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B, C])];
    blocks = captureForBlock(blocks, "bk-2", { signature: SIG }, ctx);
    blocks = captureForBlock(blocks, "bk-1", { signature: SIG, initials: INI }, ctx);
    expect(blocks.every((item) => isBlockComplete(item, ctx))).toBe(true);
    const removed = removeBlock(blocks, "bk-1", ORDER);
    const receiver = removed.blocks.find((item) => item.id === "bk-2")!;
    expect(receiver.stamps[A]).toBeUndefined();
    expect(isBlockComplete(receiver, ctx)).toBe(false);
  });

  it("el unico bloque de un firmante no se puede quitar", () => {
    const blocks = [block("bk-1", ANA.id, [A, B])];
    const removed = removeBlock(blocks, "bk-1", ORDER);
    expect(removed.receiverId).toBeNull();
    expect(removed.blocks).toBe(blocks);
  });
});

describe("blockModel — alcance: edicion, resumen y anuncio", () => {
  it("changeBlockScope fija el alcance y anuncia el bloque y lo que se movio", () => {
    const blocks = [block("bk-1", ANA.id, [A, B]), block("bk-2", ANA.id, [C])];
    const edit = changeBlockScope(blocks, "bk-2", [B, C], DOCS, strings);
    expect(edit.blocks.find((item) => item.id === "bk-2")!.appliesTo).toEqual([B, C]);
    expect(edit.blocks.find((item) => item.id === "bk-1")!.appliesTo).toEqual([A]);
    expect(edit.message).toContain(strings.blockScopeUpdated("Bloque 2", "Anexo, Acta"));
    expect(edit.message).toContain(strings.blockScopeMoved("Anexo", 1, 2));
  });

  it("un alcance vacio no se aplica ni anuncia nada", () => {
    const blocks = [block("bk-1", ANA.id, [A, B])];
    const edit = changeBlockScope(blocks, "bk-1", [], DOCS, strings);
    expect(edit.blocks).toBe(blocks);
    expect(edit.message).toBe("");
  });

  it("si un bloque se queda sin documentos al ceder todos, desaparece y el invariante se mantiene", () => {
    const blocks = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B, C])];
    const edit = changeBlockScope(blocks, "bk-2", [A, B, C], DOCS, strings);
    expect(edit.blocks.map((item) => item.id)).toEqual(["bk-2"]);
    expect(edit.message).toContain(strings.blockScopeMoved("Contrato A", 1, 1));
  });

  it("scopeSummary: «Todos (N)», nombres sin .pdf y «+N» a partir del cuarto", () => {
    expect(scopeSummary(block("b", ANA.id, [A, B, C]), DOCS, strings)).toBe("Todos (3)");
    expect(scopeSummary(block("b", ANA.id, [A, B]), DOCS, strings)).toBe("Contrato A, Anexo");
    const many: DocRef[] = [...DOCS, { id: "doc-d", name: "Extra.pdf" }, { id: "doc-e", name: "Otro.pdf" }];
    expect(scopeSummary(block("b", ANA.id, ["doc-a", "doc-b", "doc-c", "doc-d"]), many, strings)).toBe(
      "Contrato A, Anexo, Acta +1",
    );
    expect(scopeSummary(block("b", ANA.id, ["doc-a", "doc-b", "doc-c", "doc-d", "doc-e"]), many, strings)).toBe(
      "Todos (5)",
    );
  });

  it("scopeSummary en ingles", () => {
    expect(scopeSummary(block("b", ANA.id, [A, B, C]), DOCS, SIGN_STRINGS.en)).toBe("All (3)");
  });

  it("docLabel quita .pdf sin importar mayusculas y conserva nombres que solo son «.pdf»", () => {
    expect(docLabel("Acta.PDF")).toBe("Acta");
    expect(docLabel("informe v1.2.pdf")).toBe("informe v1.2");
    expect(docLabel(".pdf")).toBe(".pdf");
  });

  it("rememberSource: el primer documento del alcance, o «N documentos»", () => {
    expect(rememberSource(block("b", ANA.id, [B]), DOCS, strings)).toBe("Anexo.pdf");
    expect(rememberSource(block("b", ANA.id, [A, B]), DOCS, strings)).toBe("2 documentos");
    expect(rememberSource(block("b", ANA.id, [A, B]), DOCS, SIGN_STRINGS.en)).toBe("2 documents");
    expect(rememberSource(block("b", ANA.id, []), DOCS, strings)).toBe("");
  });

  it("blockNumber cuenta entre los bloques del mismo firmante; signerLabel cae a «Firmante N»", () => {
    const blocks = [block("bk-1", ANA.id, [A]), block("bk-2", LUIS.id, [A]), block("bk-3", ANA.id, [B])];
    expect(blockNumber(blocks, "bk-3")).toBe(2);
    expect(blockNumber(blocks, "bk-2")).toBe(1);
    expect(signerLabel([ANA, { ...LUIS, name: "  " }], LUIS.id, strings)).toBe(strings.defaultSignerName(2));
    expect(signerLabel([ANA, LUIS], ANA.id, strings)).toBe("Ana");
  });
});

/* ------------------------------------------------------------------ *
 * Turno de la ceremonia (Fase 0 · U0.2)
 * ------------------------------------------------------------------ */

const EVA: Signer = { id: "sg-3", name: "Eva", color: "#e11d48" };

/** `done` por firmante: solo los ids listados han terminado. */
const doneBy = (...ids: string[]) => (signerId: string) => ids.includes(signerId);

describe("blockModel — firstPendingTurn: a quien le toca", () => {
  it("sin firmantes (cola vacia) no hay turno: devuelve la longitud, 0", () => {
    expect(firstPendingTurn([], doneBy())).toBe(0);
  });

  it("un firmante: pendiente = turno 0; firmado = ya no hay turno (1)", () => {
    expect(firstPendingTurn([ANA], doneBy())).toBe(0);
    expect(firstPendingTurn([ANA], doneBy(ANA.id))).toBe(1);
  });

  it("dos firmantes: el primero pendiente, no el primero de la cola", () => {
    expect(firstPendingTurn([ANA, LUIS], doneBy())).toBe(0);
    expect(firstPendingTurn([ANA, LUIS], doneBy(ANA.id))).toBe(1);
    // Luis firmo primero (fuera de orden): le toca a Ana.
    expect(firstPendingTurn([ANA, LUIS], doneBy(LUIS.id))).toBe(0);
  });

  it("todos firmados: devuelve la longitud de la cola", () => {
    expect(firstPendingTurn([ANA, LUIS], doneBy(ANA.id, LUIS.id))).toBe(2);
  });

  it("un firmante sin huecos no esta en la cola y por tanto nunca tiene turno", () => {
    const ctx = context({ [A]: docState([slot("a1", ANA.id), slot("a2", LUIS.id)]) }, KEYS, [ANA, EVA, LUIS]);
    const queue = ceremonyQueue(ctx, [A]);
    expect(queue.map((signer) => signer.id)).toEqual([ANA.id, LUIS.id]);
    expect(firstPendingTurn(queue, doneBy(ANA.id))).toBe(1);
    expect(queue[firstPendingTurn(queue, doneBy(ANA.id))].id).toBe(LUIS.id);
  });

  it("con bloques reales: Ana firmada en todos sus bloques -> el turno es de Luis", () => {
    const docs = { ...BASE_DOCS, [A]: docState([slot("a1", ANA.id), slot("a3", LUIS.id)]) };
    const ctx = context(docs);
    const blocks = [block("bk-1", ANA.id, [A, B, C]), block("bk-2", LUIS.id, [A])];
    const queue = ceremonyQueue(ctx, ORDER);
    const isDone = (id: string) => isSignerDone(blocks, id, ctx);
    expect(firstPendingTurn(queue, isDone)).toBe(0);
    const signed = captureForBlock(blocks, "bk-1", { signature: SIG }, ctx);
    const afterAna = (id: string) => isSignerDone(signed, id, ctx);
    expect(firstPendingTurn(queue, afterAna)).toBe(1);
    const both = captureForBlock(signed, "bk-2", { signature: SIG }, ctx);
    expect(firstPendingTurn(queue, (id) => isSignerDone(both, id, ctx))).toBe(2);
  });

  it("con firmas distintas por documento, Ana sigue pendiente hasta firmar TODOS sus bloques", () => {
    const docs = {
      [A]: docState([slot("a1", ANA.id), slot("a3", LUIS.id)]),
      [B]: docState([slot("b1", ANA.id), slot("b2", LUIS.id)]),
    };
    const ctx = context(docs);
    const blocks = [
      block("bk-1", ANA.id, [A]),
      block("bk-2", ANA.id, [B]),
      block("bk-3", LUIS.id, [A]),
      block("bk-4", LUIS.id, [B]),
    ];
    const queue = ceremonyQueue(ctx, [A, B]);
    const half = captureForBlock(blocks, "bk-1", { signature: SIG }, ctx);
    expect(firstPendingTurn(queue, (id) => isSignerDone(half, id, ctx))).toBe(0);
    const full = captureForBlock(half, "bk-2", { signature: SIG }, ctx);
    expect(firstPendingTurn(queue, (id) => isSignerDone(full, id, ctx))).toBe(1);
  });
});

describe("blockModel — resolveCeremony: el turno guardado, o el derivado de lo que falta", () => {
  const queue = [ANA, LUIS];

  it("sin nada guardado (borrador anterior, ronda nueva): primer pendiente, en el traspaso", () => {
    expect(resolveCeremony(null, queue, doneBy())).toEqual({ index: 0, stage: "handoff" });
    expect(resolveCeremony(undefined, queue, doneBy(ANA.id))).toEqual({ index: 1, stage: "handoff" });
  });

  it("sin nada guardado y todos firmados: ya no hay turno", () => {
    expect(resolveCeremony(null, queue, doneBy(ANA.id, LUIS.id))).toEqual({ index: 2, stage: "handoff" });
    expect(resolveCeremony(null, [], doneBy())).toEqual({ index: 0, stage: "handoff" });
  });

  it("lo guardado manda: el turno de Luis y su etapa sobreviven aunque Ana siga pendiente", () => {
    const stored: CeremonyState = { signerId: LUIS.id, stage: "capture" };
    expect(resolveCeremony(stored, queue, doneBy())).toEqual({ index: 1, stage: "capture" });
  });

  it("lo guardado manda tambien con el firmante ya completo (la revision de quien acaba de firmar)", () => {
    const stored: CeremonyState = { signerId: ANA.id, stage: "review" };
    expect(resolveCeremony(stored, queue, doneBy(ANA.id))).toEqual({ index: 0, stage: "review" });
    expect(resolveCeremony({ signerId: ANA.id, stage: "handoff" }, queue, doneBy(ANA.id))).toEqual({
      index: 0,
      stage: "handoff",
    });
  });

  it("una revision de quien ya no esta completo (los huecos cambiaron) vuelve a la captura", () => {
    expect(resolveCeremony({ signerId: ANA.id, stage: "review" }, queue, doneBy())).toEqual({
      index: 0,
      stage: "capture",
    });
  });

  it("un firmante guardado que ya no esta en la cola se descarta y se deriva", () => {
    expect(resolveCeremony({ signerId: EVA.id, stage: "capture" }, queue, doneBy(ANA.id))).toEqual({
      index: 1,
      stage: "handoff",
    });
  });

  it("una etapa desconocida (dato manipulado) se descarta y se deriva", () => {
    const bad = { signerId: LUIS.id, stage: "hacked" } as unknown as CeremonyState;
    expect(resolveCeremony(bad, queue, doneBy())).toEqual({ index: 0, stage: "handoff" });
  });

  it("es idempotente: resolver lo ya resuelto no cambia nada", () => {
    for (const stored of [
      null,
      { signerId: ANA.id, stage: "capture" as const },
      { signerId: LUIS.id, stage: "review" as const },
    ]) {
      const first = resolveCeremony(stored, queue, doneBy(ANA.id));
      const again = resolveCeremony(ceremonyAt(queue, first.index, first.stage), queue, doneBy(ANA.id));
      expect(again).toEqual(first);
    }
  });
});

describe("blockModel — ceremonyAt y sanitizeCeremony", () => {
  it("ceremonyAt guarda el id del firmante, no la posicion; fuera de la cola = sin turno", () => {
    expect(ceremonyAt([ANA, LUIS], 1, "capture")).toEqual({ signerId: LUIS.id, stage: "capture" });
    expect(ceremonyAt([ANA, LUIS], 2, "handoff")).toBeNull();
    expect(ceremonyAt([], 0, "handoff")).toBeNull();
  });

  it("sanitizeCeremony acepta la forma exacta con un firmante que existe", () => {
    expect(sanitizeCeremony({ signerId: LUIS.id, stage: "review" }, [ANA.id, LUIS.id])).toEqual({
      signerId: LUIS.id,
      stage: "review",
    });
  });

  it("sanitizeCeremony descarta todo lo demas (borrador anterior, firmante inexistente, etapa rara, tipos erroneos)", () => {
    const ids = [ANA.id, LUIS.id];
    for (const raw of [
      undefined,
      null,
      "Ana",
      42,
      [],
      {},
      { signerId: ANA.id },
      { stage: "handoff" },
      { signerId: "sg-99", stage: "handoff" },
      { signerId: ANA.id, stage: "capturing" },
      { signerId: 7, stage: "handoff" },
      { signerId: ANA.id, stage: 1 },
    ]) {
      expect(sanitizeCeremony(raw, ids)).toBeNull();
    }
  });

  it("sanitizeCeremony devuelve una copia limpia: ignora campos extra", () => {
    const clean = sanitizeCeremony({ signerId: ANA.id, stage: "handoff", extra: "x" }, [ANA.id]);
    expect(clean).toEqual({ signerId: ANA.id, stage: "handoff" });
    expect(Object.keys(clean ?? {})).toEqual(["signerId", "stage"]);
  });
});

describe("blockModel — turnProgress y turnItemLabel: que falta, bloque a bloque", () => {
  const docs = {
    [A]: docState([slot("a1", ANA.id), slot("a2", ANA.id, "initials")]),
    [B]: docState([slot("b1", ANA.id)]),
  };
  const ctx = context(docs);
  const split = [block("bk-1", ANA.id, [A]), block("bk-2", ANA.id, [B])];
  const docRefs = DOCS.filter((doc) => doc.id !== C);

  it("lista firma antes que iniciales por bloque, en el orden de los bloques, todo pendiente al empezar", () => {
    expect(turnProgress(split, ANA.id, ctx)).toEqual([
      { blockId: "bk-1", type: "signature", done: false },
      { blockId: "bk-1", type: "initials", done: false },
      { blockId: "bk-2", type: "signature", done: false },
    ]);
  });

  it("marca hecho solo el trazo vigente: firma A y iniciales A hechas, firma B pendiente", () => {
    const blocks = captureForBlock(split, "bk-1", { signature: SIG, initials: INI }, ctx);
    expect(turnProgress(blocks, ANA.id, ctx).map((item) => item.done)).toEqual([true, true, false]);
  });

  it("un trazo hecho sigue contando como hecho aunque los huecos se muevan; si cambia el documento, vuelve a pendiente", () => {
    const blocks = captureForBlock(split, "bk-1", { signature: SIG, initials: INI }, ctx);
    const moved = {
      ...docs,
      [A]: docState([slot("a1", ANA.id, "signature", 0.5), slot("a2", ANA.id, "initials")]),
    };
    expect(turnProgress(blocks, ANA.id, context(moved)).map((item) => item.done)).toEqual([true, true, false]);
  });

  it("un firmante sin huecos no tiene nada que firmar; otros firmantes no se mezclan", () => {
    expect(turnProgress(split, LUIS.id, ctx)).toEqual([]);
    expect(turnProgress([...split, block("bk-3", LUIS.id, [A])], LUIS.id, ctx)).toEqual([]);
  });

  it("el nombre del trazo lleva el documento cuando el turno tiene varios bloques", () => {
    const [first, , third] = turnProgress(split, ANA.id, ctx);
    expect(turnItemLabel(first, split, docRefs, strings, true)).toBe("Firma · Contrato A");
    expect(turnItemLabel(third, split, docRefs, strings, true)).toBe("Firma · Anexo");
    expect(turnItemLabel(third, split, docRefs, strings, false)).toBe("Firma");
    expect(turnItemLabel(third, split, docRefs, SIGN_STRINGS.en, true)).toBe("Signature · Anexo");
  });

  it("captureTypeLabel: firma / iniciales, ES y EN", () => {
    expect(captureTypeLabel("signature", strings)).toBe("Firma");
    expect(captureTypeLabel("initials", strings)).toBe("Iniciales");
    expect(captureTypeLabel("initials", SIGN_STRINGS.en)).toBe(SIGN_STRINGS.en.fieldInitials);
  });

  it("los textos del aviso: «Falta: Iniciales · Contrato B» y el aviso de todo listo", () => {
    expect(strings.ceremonyMissing(["Iniciales · Contrato B"])).toBe("Falta: Iniciales · Contrato B");
    expect(strings.ceremonyMissing(["Firma · A", "Firma · B"])).toBe("Falta: Firma · A; Firma · B");
    expect(SIGN_STRINGS.en.ceremonyMissing(["Initials · Contract B"])).toBe("Missing: Initials · Contract B");
    expect(strings.ceremonyGoToMissing).toBe("Ir a lo que falta");
  });
});
