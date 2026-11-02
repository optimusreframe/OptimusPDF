import { describe, expect, it } from "vitest";
import {
  captureStamp,
  isSignerComplete,
  pendingSigners,
  requiredCaptureTypes,
  staleCaptureReason,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/captures";
import {
  captureForBlock,
  ceremonyQueue,
  firstPendingTurn,
  isSignerDone,
  pendingBlockSigners,
  resolveCeremony,
  staleSigners,
  type BlockContext,
} from "@/app/sign-pdf/blockModel";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  NO_EARLY,
  applySavedEarly,
  applySavedSingle,
  clearSignerBlocks,
  clearSingle,
  collectSingle,
  currentCapture,
  earlyStatusBlocks,
  earlyStatusSingle,
  hasCollected,
  collectedSignerIds,
  keepReusedNames,
  reuseSignerIds,
  signersToReuse,
} from "@/app/sign-pdf/earlyCapture";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * Recoger la firma y las iniciales ANTES o DESPUES de poner los campos: lo recogido va atado al firmante y a la huella del
 * documento, nunca a los huecos. Estas pruebas fijan, ademas, que NINGUN cambio de huecos (poner, mover, redimensionar,
 * quitar) invalida lo recogido -- el defecto que ya se corrigio y no debe volver --, que la ceremonia solo pide lo que falta y
 * que solo editar el texto o cambiar de documento lo invalida.
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const STROKE_A = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };
const STROKE_B = { dataUrl: "data:image/png;base64,BBBB", ratio: 0.4 };
const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const EDIT = makeEdit({ id: "e1", blockId: "p0-b0", text: "nuevo" });

const slot = (id: string, signerId: string, type: SignatureField["type"] = "signature", x = 0.1): SignatureField => ({
  id,
  signerId,
  pageIndex: 0,
  type,
  rect: { x, y: 0.1, width: 0.3, height: 0.1 },
});

/* ------------------------------------------------------------------ *
 * Un documento
 * ------------------------------------------------------------------ */

describe("un documento: estado de un firmante", () => {
  const withBoth = (stampKey = KEY): CaptureMap =>
    collectSingle(collectSingle({}, ANA.id, stampKey, { signature: STROKE_A }), ANA.id, stampKey, { initials: STROKE_B });

  it("sin nada recogido: «none»; con la huella aun calculandose tampoco hay nada vigente", () => {
    expect(earlyStatusSingle({}, ANA.id, KEY)).toEqual(NO_EARLY);
    expect(earlyStatusSingle(withBoth(), ANA.id, null)).toEqual(NO_EARLY);
  });

  it("firma sola, iniciales solas y las dos: cada una con su estado", () => {
    const signature = collectSingle({}, ANA.id, KEY, { signature: STROKE_A });
    expect(earlyStatusSingle(signature, ANA.id, KEY).kind).toBe("signature");
    const initials = collectSingle({}, ANA.id, KEY, { initials: STROKE_B });
    expect(earlyStatusSingle(initials, ANA.id, KEY).kind).toBe("initials");
    expect(earlyStatusSingle(withBoth(), ANA.id, KEY).kind).toBe("complete");
  });

  it("guardar el segundo trazo conserva el primero y los sella igual", () => {
    const captures = withBoth();
    expect(captures[ANA.id]).toEqual({ signature: STROKE_A, initials: STROKE_B, stamp: captureStamp(KEY) });
  });

  it("el sello es solo la huella del documento (sin huecos)", () => {
    expect(captureStamp(KEY, [slot("f1", ANA.id)], ANA.id)).toBe(KEY);
    expect(withBoth()[ANA.id].stamp).toBe(KEY);
  });

  it("editar el texto original caduca lo recogido y dice por que: «text»", () => {
    const captures = withBoth();
    const status = earlyStatusSingle(captures, ANA.id, stampKeyOf(KEY, [EDIT]));
    expect(status).toEqual({ kind: "stale", reason: "text" });
    expect(hasCollected(status)).toBe(false);
    expect(staleCaptureReason(captures, [], ANA.id, stampKeyOf(KEY, [EDIT]))).toBe("text");
  });

  it("cambiar de documento caduca lo recogido: «document»", () => {
    expect(earlyStatusSingle(withBoth(), ANA.id, OTHER_KEY)).toEqual({ kind: "stale", reason: "document" });
  });

  it("un trazo caducado NO se mezcla con uno nuevo: se parte de cero bajo el sello de ahora", () => {
    const old = withBoth();
    const now = stampKeyOf(KEY, [EDIT]);
    const next = collectSingle(old, ANA.id, now, { signature: STROKE_B });
    expect(next[ANA.id]).toEqual({ signature: STROKE_B, initials: null, stamp: now });
    expect(earlyStatusSingle(next, ANA.id, now).kind).toBe("signature");
  });

  it("quitar solo quita a ese firmante", () => {
    const captures = { ...withBoth(), ...collectSingle({}, LUIS.id, KEY, { signature: STROKE_A }) };
    const cleared = clearSingle(captures, ANA.id);
    expect(Object.keys(cleared)).toEqual([LUIS.id]);
    expect(clearSingle(cleared, ANA.id)).toBe(cleared);
  });

  it("una firma guardada del baul que solo trae la firma: las iniciales quedan sin inventar y se avisan", () => {
    const result = applySavedSingle({}, ANA.id, KEY, { signature: STROKE_A, initials: null });
    expect(result.missing).toEqual(["initials"]);
    expect(earlyStatusSingle(result.captures, ANA.id, KEY).kind).toBe("signature");
    // Si las iniciales ya estaban recogidas, no faltan.
    const both = applySavedSingle(withBoth(), ANA.id, KEY, { signature: STROKE_B, initials: null });
    expect(both.missing).toEqual([]);
    expect(both.captures[ANA.id].initials).toBe(STROKE_B);
  });
});

describe("un documento: NINGUN cambio de huecos invalida lo recogido (el defecto ya corregido no vuelve)", () => {
  const collected = (): CaptureMap =>
    collectSingle(collectSingle({}, ANA.id, KEY, { signature: STROKE_A }), ANA.id, KEY, { initials: STROKE_B });

  it("recoger ANTES de poner campos: los huecos que se pongan despues usan lo ya recogido y no se pide nada", () => {
    const captures = collected();
    const fields = [slot("f1", ANA.id), slot("f2", ANA.id, "initials", 0.5)];
    expect(isSignerComplete(fields, captures, ANA.id, KEY)).toBe(true);
    expect(pendingSigners([ANA], fields, captures, KEY)).toEqual([]);
  });

  it("poner, mover, redimensionar, cambiar de pagina, duplicar y quitar huecos: lo recogido sigue valiendo", () => {
    const captures = collected();
    const base = [slot("f1", ANA.id), slot("f2", ANA.id, "initials", 0.5)];
    const variants: SignatureField[][] = [
      base,
      base.map((f) => (f.id === "f1" ? { ...f, rect: { ...f.rect, x: 0.62, y: 0.7 } } : f)),
      base.map((f) => ({ ...f, rect: { ...f.rect, width: 0.5, height: 0.2 } })),
      base.map((f) => ({ ...f, pageIndex: 3 })),
      [...base, slot("f3", ANA.id, "signature", 0.2), slot("f4", ANA.id, "initials", 0.7)],
      [base[0]],
      [],
    ];
    for (const fields of variants) {
      expect(validCapture(captures, fields, ANA.id, KEY)).toBe(captures[ANA.id]);
      expect(isSignerComplete(fields, captures, ANA.id, KEY)).toBe(true);
      expect(earlyStatusSingle(captures, ANA.id, KEY).kind).toBe("complete");
      expect(staleCaptureReason(captures, fields, ANA.id, KEY)).toBeNull();
    }
  });

  it("recogi la firma y añado un hueco de iniciales: la ceremonia pide SOLO las iniciales y no tira la firma", () => {
    const captures = collectSingle({}, ANA.id, KEY, { signature: STROKE_A });
    const fields = [slot("f1", ANA.id), slot("f2", ANA.id, "initials", 0.5)];
    expect(requiredCaptureTypes(fields, ANA.id)).toEqual(["signature", "initials"]);
    const valid = validCapture(captures, fields, ANA.id, KEY);
    expect(valid.signature).toBe(STROKE_A);
    expect(valid.initials).toBeNull();
    expect(isSignerComplete(fields, captures, ANA.id, KEY)).toBe(false);
    expect(pendingSigners([ANA], fields, captures, KEY)).toEqual([ANA]);
    // Y tras recoger las iniciales ya esta completo, sin haber vuelto a pedir la firma.
    const done = collectSingle(captures, ANA.id, KEY, { initials: STROKE_B });
    expect(done[ANA.id].signature).toBe(STROKE_A);
    expect(isSignerComplete(fields, done, ANA.id, KEY)).toBe(true);
  });

  it("recogida antes de que existan campos: un firmante con trazo y SIN campos no cuenta como pendiente ni rompe nada", () => {
    const captures = collected();
    expect(pendingSigners([ANA], [], captures, KEY)).toEqual([]);
    expect(isSignerComplete([], captures, ANA.id, KEY)).toBe(true);
    expect(requiredCaptureTypes([], ANA.id)).toEqual([]);
  });

  it("cambiar de documento o editar el texto SI la invalida (y solo eso)", () => {
    const captures = collected();
    const fields = [slot("f1", ANA.id)];
    expect(isSignerComplete(fields, captures, ANA.id, OTHER_KEY)).toBe(false);
    expect(isSignerComplete(fields, captures, ANA.id, stampKeyOf(KEY, [EDIT]))).toBe(false);
  });

  it("Ana ya recogida y Luis sin recoger: el turno de la ceremonia salta a Luis", () => {
    const captures = collected();
    const fields = [slot("f1", ANA.id), slot("f2", LUIS.id, "signature", 0.5)];
    const queue = [ANA, LUIS];
    const isDone = (id: string) => isSignerComplete(fields, captures, id, KEY);
    expect(firstPendingTurn(queue, isDone)).toBe(1);
    expect(resolveCeremony(null, queue, isDone)).toEqual({ index: 1, stage: "handoff" });
  });

  it("todos recogidos antes: no queda nadie pendiente y no hay turno que pedir", () => {
    const captures: CaptureMap = {
      ...collected(),
      ...collectSingle({}, LUIS.id, KEY, { signature: STROKE_A, initials: STROKE_B }),
    };
    const fields = [slot("f1", ANA.id), slot("f2", LUIS.id)];
    expect(pendingSigners([ANA, LUIS], fields, captures, KEY)).toEqual([]);
    expect(firstPendingTurn([ANA, LUIS], (id) => isSignerComplete(fields, captures, id, KEY))).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Varios documentos: bloques con sello por documento
 * ------------------------------------------------------------------ */

describe("varios documentos: lo recogido por grupo, aunque aun no haya huecos", () => {
  const A = "doc-a";
  const B = "doc-b";
  const KEY_A = "a".repeat(64);
  const KEY_B = "b".repeat(64);

  const docs = (fields: Record<string, SignatureField[]> = {}): Record<string, DocState> => ({
    [A]: { ...EMPTY_DOC_STATE, fields: fields[A] ?? [] },
    [B]: { ...EMPTY_DOC_STATE, fields: fields[B] ?? [] },
  });
  const ctxOf = (keys: Record<string, string | null> = { [A]: KEY_A, [B]: KEY_B }, fields?: Record<string, SignatureField[]>): BlockContext => ({
    signers: [ANA, LUIS],
    docs: docs(fields),
    keys,
  });
  /** «Una firma para todos»: un grupo por firmante que cubre los dos documentos. */
  const same = (): SignerBlock[] => [
    { id: "bk-1", signerId: ANA.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: true },
    { id: "bk-2", signerId: LUIS.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: true },
  ];
  /** «Una firma por documento»: un grupo por (firmante, documento). */
  const independent = (): SignerBlock[] => [
    { id: "bk-1", signerId: ANA.id, appliesTo: [A], signature: null, initials: null, stamps: {}, auto: false },
    { id: "bk-2", signerId: ANA.id, appliesTo: [B], signature: null, initials: null, stamps: {}, auto: false },
    { id: "bk-3", signerId: LUIS.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: false },
  ];

  it("sin nada recogido: «none»; sin huella de algun documento nada vale", () => {
    expect(earlyStatusBlocks(same(), ctxOf(), ANA.id)).toEqual(NO_EARLY);
    const blocks = captureForBlock(same(), "bk-1", { signature: STROKE_A }, ctxOf());
    expect(earlyStatusBlocks(blocks, ctxOf({ [A]: KEY_A, [B]: null }), ANA.id)).toEqual(NO_EARLY);
  });

  it("recoger sella CADA documento del alcance con su huella, sin ningun hueco", () => {
    const blocks = captureForBlock(captureForBlock(same(), "bk-1", { signature: STROKE_A }, ctxOf()), "bk-1", { initials: STROKE_B }, ctxOf());
    const ana = blocks.find((block) => block.id === "bk-1")!;
    expect(ana.signature).toBe(STROKE_A);
    expect(ana.initials).toBe(STROKE_B);
    expect(ana.stamps).toEqual({ [A]: KEY_A, [B]: KEY_B });
    expect(earlyStatusBlocks(blocks, ctxOf(), ANA.id).kind).toBe("complete");
    expect(earlyStatusBlocks(blocks, ctxOf(), LUIS.id)).toEqual(NO_EARLY);
  });

  it("poner, mover o quitar huecos despues NO invalida lo recogido; la ceremonia pide solo lo que falta", () => {
    const only = captureForBlock(same(), "bk-1", { signature: STROKE_A }, ctxOf());
    const layouts: Array<Record<string, SignatureField[]>> = [
      {},
      { [A]: [slot("f1", ANA.id)], [B]: [slot("f2", ANA.id)] },
      { [A]: [slot("f1", ANA.id, "signature", 0.6)], [B]: [slot("f2", ANA.id, "signature", 0.2), slot("f3", ANA.id, "initials")] },
      { [A]: [] },
    ];
    for (const fields of layouts) {
      const ctx = ctxOf(undefined, fields);
      expect(earlyStatusBlocks(only, ctx, ANA.id).kind).toBe("signature");
      expect(staleSigners(only, ctx, [A, B])).toEqual([]);
    }
    // Con un hueco de iniciales en B: Ana tiene la firma y le faltan las iniciales (solo eso).
    const ctx = ctxOf(undefined, { [A]: [slot("f1", ANA.id)], [B]: [slot("f3", ANA.id, "initials")] });
    expect(pendingBlockSigners(only, ctx, [A, B]).map((signer) => signer.id)).toEqual([ANA.id]);
    const done = captureForBlock(only, "bk-1", { initials: STROKE_B }, ctx);
    expect(pendingBlockSigners(done, ctx, [A, B])).toEqual([]);
    expect(done.find((block) => block.id === "bk-1")!.signature).toBe(STROKE_A);
  });

  it("Ana recogida y Luis no: la ronda arranca en Luis; con los dos recogidos nadie queda pendiente", () => {
    const fields = { [A]: [slot("f1", ANA.id), slot("f2", LUIS.id, "signature", 0.5)], [B]: [slot("f3", ANA.id), slot("f4", LUIS.id, "signature", 0.5)] };
    const ctx = ctxOf(undefined, fields);
    let blocks = captureForBlock(same(), "bk-1", { signature: STROKE_A }, ctx);
    const queue = ceremonyQueue(ctx, [A, B]);
    expect(firstPendingTurn(queue, (id) => isSignerDone(blocks, id, ctx))).toBe(1);
    blocks = captureForBlock(blocks, "bk-2", { signature: STROKE_B }, ctx);
    expect(pendingBlockSigners(blocks, ctx, [A, B])).toEqual([]);
  });

  it("editar el texto de UN documento caduca al grupo que lo cubria y lo dice: «text»", () => {
    const blocks = captureForBlock(same(), "bk-1", { signature: STROKE_A, initials: STROKE_B }, ctxOf());
    const edited = ctxOf({ [A]: stampKeyOf(KEY_A, [EDIT]), [B]: KEY_B });
    expect(earlyStatusBlocks(blocks, edited, ANA.id)).toEqual({ kind: "stale", reason: "text" });
    // Luis nunca recogio nada: no se le dice nada.
    expect(earlyStatusBlocks(blocks, edited, LUIS.id)).toEqual(NO_EARLY);
  });

  it("un documento NUEVO en el alcance (nadie lo vio) caduca lo recogido con su propio motivo («added»); uno cambiado, «document»", () => {
    const blocks = captureForBlock(same(), "bk-1", { signature: STROKE_A }, ctxOf());
    const grown = blocks.map((block) => (block.id === "bk-1" ? { ...block, appliesTo: [A, B, "doc-c"] } : block));
    const ctx = ctxOf({ [A]: KEY_A, [B]: KEY_B, "doc-c": "c".repeat(64) });
    expect(earlyStatusBlocks(grown, ctx, ANA.id)).toEqual({ kind: "stale", reason: "added" });
    expect(earlyStatusBlocks(blocks, ctxOf({ [A]: KEY_A, [B]: "d".repeat(64) }), ANA.id)).toEqual({ kind: "stale", reason: "document" });
  });

  it("con varios grupos, recoger solo uno deja al firmante «a medias»; los dos grupos lo completan", () => {
    const ctx = ctxOf();
    const first = captureForBlock(captureForBlock(independent(), "bk-1", { signature: STROKE_A }, ctx), "bk-1", { initials: STROKE_B }, ctx);
    expect(earlyStatusBlocks(first, ctx, ANA.id).kind).toBe("partial");
    const second = captureForBlock(captureForBlock(first, "bk-2", { signature: STROKE_B }, ctx), "bk-2", { initials: STROKE_A }, ctx);
    expect(earlyStatusBlocks(second, ctx, ANA.id).kind).toBe("complete");
  });

  it("una firma guardada con «aplicar a todos»: rellena solo lo VACIO de los demas grupos y no pisa lo que ya tenian", () => {
    const ctx = ctxOf();
    const start = captureForBlock(independent(), "bk-2", { signature: STROKE_B }, ctx);
    const result = applySavedEarly(start, "bk-1", { signature: STROKE_A, initials: STROKE_A }, true, ctx);
    const get = (id: string) => result.blocks.find((block) => block.id === id)!;
    expect(get("bk-1").signature).toBe(STROKE_A);
    expect(get("bk-1").initials).toBe(STROKE_A);
    // bk-2 conservaba su firma (no se pisa) y recibe las iniciales que le faltaban.
    expect(get("bk-2").signature).toBe(STROKE_B);
    expect(get("bk-2").initials).toBe(STROKE_A);
    expect(result.filledOthers).toBe(1);
    expect(result.missing).toEqual([]);
    // Luis (otro firmante) no se toca.
    expect(get("bk-3").signature).toBeNull();
  });

  it("una guardada sin iniciales deja las iniciales sin inventar y las avisa", () => {
    const result = applySavedEarly(independent(), "bk-1", { signature: STROKE_A, initials: null }, false, ctxOf());
    expect(result.missing).toEqual(["initials"]);
    expect(result.blocks.find((block) => block.id === "bk-1")!.initials).toBeNull();
  });

  it("quitar vacia TODOS los grupos del firmante (trazos y sellos) y no toca a los demas", () => {
    const ctx = ctxOf();
    let blocks = captureForBlock(independent(), "bk-1", { signature: STROKE_A }, ctx);
    blocks = captureForBlock(blocks, "bk-2", { signature: STROKE_A }, ctx);
    blocks = captureForBlock(blocks, "bk-3", { signature: STROKE_B }, ctx);
    const cleared = clearSignerBlocks(blocks, ANA.id);
    expect(cleared.filter((block) => block.signerId === ANA.id).every((block) => !block.signature && Object.keys(block.stamps).length === 0)).toBe(true);
    expect(cleared.find((block) => block.id === "bk-3")!.signature).toBe(STROKE_B);
    expect(earlyStatusBlocks(cleared, ctx, ANA.id)).toEqual(NO_EARLY);
  });

  it("currentCapture devuelve vacio cuando el sello no coincide (ante la duda, no vale)", () => {
    const captures = collectSingle({}, ANA.id, KEY, { signature: STROKE_A });
    expect(currentCapture(captures, ANA.id, KEY).signature).toBe(STROKE_A);
    expect(currentCapture(captures, ANA.id, OTHER_KEY).signature).toBeNull();
    expect(currentCapture(captures, ANA.id, null).signature).toBeNull();
  });
});

describe("plantillas que reemplazan a los firmantes: lo recogido se conserva", () => {
  const withStroke = (signerId: string): SignerBlock => ({
    id: `bk-${signerId}`,
    signerId,
    appliesTo: ["doc-a"],
    signature: STROKE_A,
    initials: null,
    stamps: { "doc-a": KEY },
    auto: true,
  });
  const empty = (signerId: string): SignerBlock => ({ ...withStroke(signerId), signature: null, stamps: {} });
  const fresh = [
    { id: "sg-9", name: "Asegurado", color: "#111" },
    { id: "sg-10", name: "Co-asegurado", color: "#222" },
  ];

  it("si nadie recogio nada no se reutiliza ningun firmante (la plantilla se aplica como siempre)", () => {
    expect(signersToReuse([ANA, LUIS], [empty(ANA.id), empty(LUIS.id)])).toEqual([]);
    expect(signersToReuse([], [])).toEqual([]);
  });

  it("si alguien ya recogio, la plantilla se aplica a los mismos firmantes, por orden", () => {
    const reuse = signersToReuse([ANA, LUIS], [withStroke(ANA.id), empty(LUIS.id)]);
    expect(reuse.map((signer) => signer.id)).toEqual([ANA.id, LUIS.id]);
    const mint = reuseSignerIds(reuse, () => "sg-new");
    expect([mint(), mint(), mint()]).toEqual([ANA.id, LUIS.id, "sg-new"]);
  });

  it("los firmantes que deja la plantilla conservan el id y el NOMBRE de quien ya estaba; los nuevos, el de la plantilla", () => {
    const kept = keepReusedNames(fresh, [ANA], new Set([ANA.id]));
    expect(kept[0]).toEqual({ id: "sg-9", name: "Ana", color: "#111" });
    expect(kept[1].name).toBe("Co-asegurado");
    expect(keepReusedNames(fresh, [], new Set())).toEqual(fresh);
  });

  it("si la plantilla trae MENOS firmantes, los sobrantes que ya recogieron se quedan (sin campos); los que no, se van", () => {
    const MARTA = { id: "sg-3", name: "Marta", color: "#333" };
    const blocks = [withStroke(ANA.id), withStroke(LUIS.id), empty(MARTA.id)];
    const reuse = signersToReuse([ANA, LUIS, MARTA], blocks);
    const kept = keepReusedNames([fresh[0]], reuse, collectedSignerIds(blocks));
    expect(kept.map((signer) => signer.id)).toEqual(["sg-9", LUIS.id]);
    // Una plantilla sin firmantes tampoco borra lo recogido.
    expect(keepReusedNames([], reuse, collectedSignerIds(blocks)).map((signer) => signer.id)).toEqual([ANA.id, LUIS.id]);
  });
});
