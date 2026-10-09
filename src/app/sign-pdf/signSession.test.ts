import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION,
  activeDocOf,
  applyViewPatch,
  sessionFromView,
  syncSession,
  viewOf,
  type SignSession,
} from "@/app/sign-pdf/signSession";
import { EMPTY_DOC_STATE, ensureBlocks, type DocState } from "@/app/sign-pdf/docSet";
import { captureStamp, type CaptureMap } from "@/app/sign-pdf/captures";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import type { DetectedField } from "@/lib/pdf/detectFields";

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#e5484d" };
const DRAFT = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };

function field(id: string, signerId: string): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  };
}

function text(id: string): DetectedField {
  return {
    id,
    pageIndex: 0,
    rect: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 },
    label: "Nombre",
    type: "text",
    source: "manual",
    confidence: "high",
  };
}

function session(over: Partial<SignSession> = {}): SignSession {
  return { ...DEFAULT_SESSION, ...over };
}

describe("viewOf — src/app/sign-pdf/signSession.ts", () => {
  it("un documento sin estado se ve como las opciones en blanco de siempre", () => {
    const view = viewOf(session({ signers: [ANA] }), "d1");
    expect(view).toMatchObject({
      mode: "single",
      pageIndex: 0,
      signature: "",
      step: "signers",
      fields: [],
      captures: {},
      fieldPageIndex: 0,
      textFields: [],
      textValues: {},
      textFieldsDetectedFor: null,
      selectedFieldId: null,
    });
    expect(view.signers).toEqual([ANA]);
  });

  it("lo del documento sale de SU entrada y la huella es el sello", () => {
    const doc: DocState = { ...EMPTY_DOC_STATE, sealedKey: "k1", fields: [field("f1", "sg-1")], textFields: [text("t1")], textValues: { t1: "x" } };
    const view = viewOf(session({ signers: [ANA], docs: { d1: doc } }), "d1");
    expect(view.signature).toBe("k1");
    expect(view.fields).toHaveLength(1);
    expect(view.textValues).toEqual({ t1: "x" });
    expect(viewOf(session({ signers: [ANA], docs: { d1: doc } }), "d2").fields).toEqual([]);
  });

  it("oculta los huecos de firmantes que ya no estan", () => {
    const doc: DocState = { ...EMPTY_DOC_STATE, fields: [field("f1", "sg-1"), field("f2", "sg-2")] };
    const view = viewOf(session({ signers: [ANA], docs: { d1: doc } }), "d1");
    expect(view.fields.map((f) => f.id)).toEqual(["f1"]);
  });

  it("las capturas salen de los bloques, con el sello de ese documento", () => {
    const blocks = ensureBlocks([ANA], ["d1", "d2"], "same", []);
    const stamped = blocks.map((b) => ({ ...b, signature: DRAFT, stamps: { d1: "s1" } }));
    const s = session({ signers: [ANA], blocks: stamped });
    expect(viewOf(s, "d1").captures["sg-1"].stamp).toBe("s1");
    expect(viewOf(s, "d2").captures["sg-1"].stamp).toBe("");
  });

  it("respeta fields/captures memoizados que se le pasen (referencias estables)", () => {
    const fields: SignatureField[] = [];
    const captures: CaptureMap = {};
    const view = viewOf(session(), "d1", { fields, captures });
    expect(view.fields).toBe(fields);
    expect(view.captures).toBe(captures);
  });
});

describe("applyViewPatch", () => {
  const order = ["d1", "d2"];

  it("un patch de documento va a SU entrada y no toca a los demas", () => {
    const base = session({ docs: { d2: { ...EMPTY_DOC_STATE, sealedKey: "k2" } } });
    const patch = applyViewPatch(base, "d1", { signature: "k1", fieldPageIndex: 3 }, order);
    expect(patch.docs?.d1).toMatchObject({ sealedKey: "k1", fieldPageIndex: 3 });
    expect(patch.docs?.d2.sealedKey).toBe("k2");
  });

  it("lo global va a la sesion y no a ningun documento", () => {
    const patch = applyViewPatch(session(), "d1", { mode: "multi", step: "document", activeSignerId: "sg-1", signaturePng: "x", ratio: 0.2 }, order);
    expect(patch).toMatchObject({ mode: "multi", step: "document", activeSignerId: "sg-1", signaturePng: "x", ratio: 0.2 });
    expect(patch.docs).toBeUndefined();
  });

  it("alta de un firmante: crea su bloque para los documentos de la cola", () => {
    const patch = applyViewPatch(session(), "d1", { signers: [ANA] }, order);
    expect(patch.signers).toEqual([ANA]);
    expect(patch.blocks).toHaveLength(1);
    expect(patch.blocks?.[0].appliesTo).toEqual(order);
  });

  it("baja de un firmante: quita su bloque y sus huecos de ESTE documento; los de los otros quedan ocultos, no perdidos", () => {
    const blocks = ensureBlocks([ANA, LUIS], order, "same", []);
    const base = session({
      signers: [ANA, LUIS],
      blocks,
      docs: {
        d1: { ...EMPTY_DOC_STATE, fields: [field("f1", "sg-1"), field("f2", "sg-2")] },
        d2: { ...EMPTY_DOC_STATE, fields: [field("f3", "sg-2")] },
      },
    });
    const patch = applyViewPatch(base, "d1", { signers: [ANA] }, order);
    expect(patch.blocks?.map((b) => b.signerId)).toEqual(["sg-1"]);
    expect(patch.docs?.d1.fields.map((f) => f.id)).toEqual(["f1"]);
    expect(patch.docs?.d2).toBe(base.docs.d2);
    // Si el firmante vuelve (Deshacer), los huecos del otro documento reaparecen.
    const restored = { ...base, ...patch };
    const back = applyViewPatch(restored, "d1", { signers: [ANA, LUIS] }, order);
    const afterUndo = { ...restored, ...back };
    expect(viewOf(afterUndo, "d2").fields.map((f) => f.id)).toEqual(["f3"]);
  });

  it("renombrar un firmante no reordena ni recrea bloques", () => {
    const blocks = ensureBlocks([ANA], order, "same", []);
    const base = session({ signers: [ANA], blocks });
    const patch = applyViewPatch(base, "d1", { signers: [{ ...ANA, name: "Anita" }] }, order);
    expect(patch.blocks).toBeUndefined();
  });

  it("las capturas del patch se vuelcan en los bloques del documento", () => {
    const blocks = ensureBlocks([ANA], order, "same", []);
    const base = session({ signers: [ANA], blocks });
    const captures: CaptureMap = { "sg-1": { signature: DRAFT, initials: null, stamp: captureStamp("k", [], "sg-1") } };
    const patch = applyViewPatch(base, "d1", { captures }, order);
    expect(patch.blocks?.[0].signature).toEqual(DRAFT);
    expect(Object.keys(patch.blocks?.[0].stamps ?? {})).toEqual(["d1"]);
  });

  it("'fields' sustituye los del documento (los ocultos de ese documento se purgan al escribirlo)", () => {
    const base = session({ signers: [ANA], docs: { d1: { ...EMPTY_DOC_STATE, fields: [field("f9", "sg-2")] } } });
    const patch = applyViewPatch(base, "d1", { fields: [field("f1", "sg-1")] }, order);
    expect(patch.docs?.d1.fields.map((f) => f.id)).toEqual(["f1"]);
  });

  it("un patch vacio no produce cambios", () => {
    expect(applyViewPatch(session(), "d1", {}, order)).toEqual({});
  });

  it("escribir en d1 jamas modifica d2 (cierra por construccion la mezcla entre documentos)", () => {
    const base = session({ docs: { d2: { ...EMPTY_DOC_STATE, textValues: { t: "de d2" }, sealedKey: "k2" } } });
    const patch = applyViewPatch(base, "d1", { textValues: { t: "de d1" }, signature: "k1" }, order);
    const next = { ...base, ...patch };
    expect(next.docs.d2.textValues).toEqual({ t: "de d2" });
    expect(next.docs.d2.sealedKey).toBe("k2");
    expect(next.docs.d1.textValues).toEqual({ t: "de d1" });
  });
});

describe("syncSession", () => {
  it("una ronda nueva elige el primer documento y arranca en el paso Firmantes", () => {
    const patch = syncSession(session({ step: "sign", selectedFieldId: "f1", signers: [ANA] }), ["d1", "d2"]);
    expect(patch.activeDocId).toBe("d1");
    expect(patch.docOrder).toEqual(["d1", "d2"]);
    expect(patch.step).toBe("signers");
    expect(patch.selectedFieldId).toBeNull();
    expect(patch.blocks).toHaveLength(1);
  });

  it("no toca a los firmantes ni al modo al arrancar una ronda nueva", () => {
    const patch = syncSession(session({ mode: "multi", signers: [ANA] }), ["d1"]);
    expect(patch.mode).toBeUndefined();
    expect(patch.signers).toBeUndefined();
  });

  it("es idempotente: aplicado el patch, no hay mas que hacer", () => {
    const first = session({ signers: [ANA] });
    const patch = syncSession(first, ["d1", "d2"]);
    const synced = { ...first, ...patch };
    expect(syncSession(synced, ["d1", "d2"])).toEqual({});
  });

  it("quitar el documento activo pasa al que ocupa su lugar y poda su estado, SIN reiniciar el paso", () => {
    const base = session({
      step: "document",
      docOrder: ["d1", "d2", "d3"],
      activeDocId: "d2",
      docs: { d1: EMPTY_DOC_STATE, d2: EMPTY_DOC_STATE, d3: EMPTY_DOC_STATE },
    });
    const patch = syncSession(base, ["d1", "d3"]);
    expect(patch.activeDocId).toBe("d3");
    expect(Object.keys(patch.docs ?? {})).toEqual(["d1", "d3"]);
    expect(patch.step).toBeUndefined();
  });

  it("reordenar la cola solo actualiza el orden", () => {
    const base = session({ docOrder: ["d1", "d2"], activeDocId: "d1" });
    const patch = syncSession(base, ["d2", "d1"]);
    expect(patch.docOrder).toEqual(["d2", "d1"]);
    expect(patch.activeDocId).toBeUndefined();
  });

  it("subir un documento nuevo a una ronda en marcha no reinicia nada y se suma a los bloques automaticos", () => {
    const blocks = ensureBlocks([ANA], ["d1"], "same", []);
    const base = session({ step: "document", signers: [ANA], blocks, docOrder: ["d1"], activeDocId: "d1", docs: { d1: EMPTY_DOC_STATE } });
    const patch = syncSession(base, ["d1", "d2"]);
    expect(patch.step).toBeUndefined();
    expect(patch.blocks?.[0].appliesTo).toEqual(["d1", "d2"]);
  });

  it("sin documentos no hace nada (la sesion no se vacia al quedarse sin archivos)", () => {
    expect(syncSession(session({ docOrder: ["d1"], activeDocId: "d1", docs: { d1: EMPTY_DOC_STATE } }), [])).toEqual({});
  });

  it("un documento cargado con estado (borrador) no es una ronda nueva", () => {
    const loaded = session({ step: "document", docs: { d1: { ...EMPTY_DOC_STATE, sealedKey: "k" } }, docOrder: ["d1"], activeDocId: "d1" });
    expect(syncSession(loaded, ["d1"]).step).toBeUndefined();
  });
});

describe("activeDocOf", () => {
  it("el guardado si sigue en la cola; si no, el vecino; si no hay, null", () => {
    expect(activeDocOf({ docOrder: ["a", "b"], activeDocId: "b" }, ["a", "b"])).toBe("b");
    expect(activeDocOf({ docOrder: ["a", "b"], activeDocId: "a" }, ["b"])).toBe("b");
    expect(activeDocOf({ docOrder: [], activeDocId: null }, [])).toBeNull();
  });
});

describe("sessionFromView — cargar un borrador o una configuracion", () => {
  it("traduce el patch plano de siempre al modelo por documento", () => {
    const captures: CaptureMap = { "sg-1": { signature: DRAFT, initials: null, stamp: "s" } };
    const patch = sessionFromView("d1", {
      mode: "multi",
      signature: "huella",
      step: "document",
      signers: [ANA],
      fields: [field("f1", "sg-1")],
      captures,
      textFields: [text("t1")],
      textValues: { t1: "x" },
      textFieldsDetectedFor: "huella",
    });
    expect(patch).toMatchObject({ mode: "multi", step: "document", activeDocId: "d1", docOrder: ["d1"], signers: [ANA] });
    expect(patch.docs?.d1).toMatchObject({ sealedKey: "huella", textFieldsDetectedFor: "huella" });
    const view = viewOf({ ...DEFAULT_SESSION, ...patch }, "d1");
    expect(view.signature).toBe("huella");
    expect(view.captures).toEqual(captures);
    expect(view.fields).toHaveLength(1);
    expect(view.textValues).toEqual({ t1: "x" });
  });

  it("firmantes sin captura reciben su bloque vacio para el documento", () => {
    const patch = sessionFromView("d1", { signers: [ANA, LUIS] });
    expect(patch.blocks?.map((b) => b.signerId)).toEqual(["sg-1", "sg-2"]);
  });

  it("no es una ronda nueva: syncSession no la reinicia", () => {
    const patch = sessionFromView("d1", { step: "sign", signers: [ANA] });
    expect(syncSession({ ...DEFAULT_SESSION, ...patch }, ["d1"]).step).toBeUndefined();
  });
});
