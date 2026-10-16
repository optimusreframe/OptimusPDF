import { describe, expect, it } from "vitest";
import type { AutoField, AutoMapResult } from "../pdf/autoMapTypes";
import { mergeTemplateDrafts, reconcileSources, templateFromAutoMap } from "./templateAuto";
import { buildContent } from "./templateSchema";
import { R } from "./testing/templateSamples";
import { TEMPLATE_LIMITS, type TemplateSignField, type TemplateTextField, type Variant } from "./templateTypes";

let seq = 0;
function auto(over: Partial<AutoField>): AutoField {
  seq += 1;
  return { id: `am-${over.pageIndex ?? 0}-${seq}`, pageIndex: 0, rect: R(0.79, 0.84, 0.05, 0.03), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "x", source: "label", ...over };
}

function result(fields: AutoField[]): AutoMapResult {
  return {
    fields,
    pages: [],
    confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 },
    warnings: [],
  };
}

describe("templateFromAutoMap", () => {
  it("2 firmantes: firma e iniciales por rol a la variante «2» con source auto, confianza e id del automapeo", () => {
    const { draft, stats } = templateFromAutoMap(
      result([
        auto({ id: "am-0-0", type: "initials", signerIndex: 0 }),
        auto({ id: "am-0-1", type: "initials", signerIndex: 1, rect: R(0.85, 0.84, 0.05, 0.03) }),
        auto({ id: "am-3-0", pageIndex: 3, type: "signature", signerIndex: 0, rect: R(0.16, 0.5, 0.25, 0.05), confidence: 0.77 }),
      ]),
      { documentId: "doc-1", signers: 2 },
    );
    expect(draft.documentId).toBe("doc-1");
    expect(draft.variants!["1"]).toBeUndefined();
    const fields = draft.variants!["2"]!.fields as TemplateSignField[];
    expect(fields.map((field) => [field.id, field.roleIndex, field.type, field.pageIndex, field.source, field.required])).toEqual([
      ["am-0-0", 0, "initials", 0, "auto", true],
      ["am-0-1", 1, "initials", 0, "auto", true],
      ["am-3-0", 0, "signature", 3, "auto", true],
    ]);
    expect(fields[2].confidence).toBe(0.77);
    expect(fields.every((field) => field.needsReview === undefined)).toBe(true);
    expect(stats).toMatchObject({ signFields: 3, textFields: 0, needsReview: 0, ignored: 0, noRole: 0, overflow: 0 });
    expect(buildContent(draft)).not.toBeNull();
  });

  it("1 firmante: va a la variante «1»; los campos del firmante 2 no entran", () => {
    const { draft, stats } = templateFromAutoMap(result([auto({ signerIndex: 0 }), auto({ signerIndex: 1 })]), { documentId: null, signers: 1 });
    expect(draft.variants!["1"]!.fields).toHaveLength(1);
    expect(draft.variants!["2"]).toBeUndefined();
    expect(stats.noRole).toBe(1);
  });

  it("tier high + review entran; review lleva needsReview; ignore no entra", () => {
    const { draft, stats } = templateFromAutoMap(
      result([auto({ tier: "high" }), auto({ tier: "review", pageIndex: 1 }), auto({ tier: "ignore", pageIndex: 2 }), auto({ tier: "review", type: "text", label: "Teléfono", signerIndex: undefined })]),
      { documentId: "d", signers: 2 },
    );
    const variant = draft.variants!["2"]!;
    expect(variant.fields).toHaveLength(2);
    expect((variant.fields![1] as TemplateSignField).needsReview).toBe(true);
    expect((variant.fields![0] as TemplateSignField).needsReview).toBeUndefined();
    expect((variant.textFields![0] as TemplateTextField).needsReview).toBe(true);
    expect(stats).toMatchObject({ ignored: 1, needsReview: 2 });
  });

  it("la firma de la otra parte (sin firmante) no entra y se cuenta", () => {
    const { draft, stats } = templateFromAutoMap(result([auto({ type: "signature", signerIndex: undefined, tier: "review" })]), { documentId: "d", signers: 2 });
    expect(draft.variants!["2"]!.fields).toHaveLength(0);
    expect(stats.noRole).toBe(1);
  });

  it("la fecha pasa a campo de texto date con regla «today»; el texto toma el dataKey sugerido de su etiqueta", () => {
    const { draft } = templateFromAutoMap(
      result([
        auto({ type: "date", signerIndex: undefined, rect: R(0.6, 0.55, 0.15, 0.02), label: "Date" }),
        auto({ type: "text", signerIndex: undefined, label: "Claim Number", rect: R(0.2, 0.3, 0.3, 0.02) }),
        auto({ type: "text", signerIndex: undefined, label: "Phone", rect: R(0.2, 0.35, 0.3, 0.02) }),
        auto({ type: "text", signerIndex: undefined, label: "Zzz", rect: R(0.2, 0.4, 0.3, 0.02) }),
        auto({ type: "text", signerIndex: undefined, rect: R(0.2, 0.45, 0.3, 0.02) }),
      ]),
      { documentId: "d", signers: 2 },
    );
    const texts = draft.variants!["2"]!.textFields as TemplateTextField[];
    expect(texts[0]).toMatchObject({ type: "date", label: "Date", dataKey: "today", rule: "today", required: false, source: "auto" });
    expect(texts[1]).toMatchObject({ type: "text", label: "Claim Number", dataKey: "claimNumber" });
    expect(texts[2].dataKey).toBe("phone");
    expect(texts[3].dataKey).toBeUndefined();
    expect(texts[4]).toMatchObject({ label: "", source: "auto" });
    expect("dataKey" in texts[4]).toBe(false);
    expect(buildContent(draft)).not.toBeNull();
  });

  it("los ids repetidos o raros no se copian; las etiquetas se limpian y recortan", () => {
    const { draft } = templateFromAutoMap(
      result([
        auto({ id: "am-0-0", signerIndex: 0 }),
        auto({ id: "am-0-0", signerIndex: 1, rect: R(0.85, 0.84, 0.05, 0.03) }),
        auto({ id: "no válido!", type: "text", signerIndex: undefined, label: `a‮b\n${"x".repeat(300)}`, rect: R(0.2, 0.3, 0.3, 0.02) }),
      ]),
      { documentId: "d", signers: 2 },
    );
    const fields = draft.variants!["2"]!.fields as TemplateSignField[];
    expect(fields[0].id).toBe("am-0-0");
    expect(fields[1].id).toBeUndefined();
    const text = draft.variants!["2"]!.textFields![0] as TemplateTextField;
    expect(text.id).toBeUndefined();
    expect(text.label.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.maxFieldLabelLength);
    expect(text.label).not.toMatch(/[‮\n]/);
    expect(buildContent(draft)).not.toBeNull();
  });

  it("respeta el tope de 500 campos por variante y lo cuenta", () => {
    const many = Array.from({ length: 510 }, (_, index) => auto({ id: `am-${index}-0`, pageIndex: index % 200, signerIndex: 0, rect: R(0.1, 0.1, 0.05, 0.03) }));
    const { draft, stats } = templateFromAutoMap(result(many), { documentId: "d", signers: 2 });
    expect(draft.variants!["2"]!.fields).toHaveLength(500);
    expect(stats.overflow).toBe(10);
    expect(buildContent(draft)).not.toBeNull();
  });

  it("nombre y roles propios; confianza fuera de rango se acota", () => {
    const { draft } = templateFromAutoMap(result([auto({ confidence: 7 })]), { documentId: "d", signers: 1, name: "Mi plantilla", roles: [{ key: "signer1", label: "Cliente" }] });
    expect(draft.name).toBe("Mi plantilla");
    expect(draft.roles).toEqual([{ key: "signer1", label: "Cliente" }]);
    expect((draft.variants!["1"]!.fields![0] as TemplateSignField).confidence).toBe(1);
  });

  it("sin campos: borrador vacío y válido", () => {
    const { draft, stats } = templateFromAutoMap(result([]), { documentId: "d", signers: 2 });
    expect(stats).toEqual({ signFields: 0, textFields: 0, needsReview: 0, ignored: 0, noRole: 0, overflow: 0 });
    expect(buildContent(draft)).not.toBeNull();
  });
});

const sf = (over: Partial<TemplateSignField>): TemplateSignField => ({ roleIndex: 0, pageIndex: 0, type: "initials", rect: R(0.79, 0.84, 0.05, 0.03), required: true, source: "auto", ...over });
const tf = (over: Partial<TemplateTextField>): TemplateTextField => ({ pageIndex: 0, rect: R(0.2, 0.3, 0.3, 0.02), type: "text", label: "x", required: false, source: "auto", ...over });
const v = (fields: TemplateSignField[], textFields: TemplateTextField[] = []): Variant => ({ fields, textFields });
const wrap = (two: Variant, one: Variant = v([])) => ({ variants: { "1": one, "2": two } });

describe("mergeTemplateDrafts", () => {
  it("lo que ya está (mismo id) no se duplica y se respeta la versión de la persona", () => {
    const edited = wrap(v([sf({ id: "am-0-0", rect: R(0.8, 0.85, 0.05, 0.03), source: "manual" })]));
    const fresh = wrap(v([sf({ id: "am-0-0" }), sf({ id: "am-1-0", pageIndex: 1 })]));
    const out = mergeTemplateDrafts(edited, fresh);
    expect(out.variants["2"].fields).toHaveLength(2);
    expect(out.variants["2"].fields[0]).toEqual(edited.variants["2"].fields[0]);
    expect(out.stats).toMatchObject({ added: 1, matched: 1 });
  });

  it("lo que cae en el mismo sitio (mismo tipo, rol y página, IoU ≥ 0,3) cuenta como el mismo aunque cambie el id", () => {
    const edited = wrap(v([sf({ id: "mine", rect: R(0.79, 0.84, 0.05, 0.03), source: "manual" })]));
    const near = wrap(v([sf({ id: "am-9", rect: R(0.795, 0.845, 0.05, 0.03) })]));
    expect(mergeTemplateDrafts(edited, near).stats).toMatchObject({ added: 0, matched: 1 });
    const far = wrap(v([sf({ id: "am-9", rect: R(0.2, 0.2, 0.05, 0.03) })]));
    expect(mergeTemplateDrafts(edited, far).stats).toMatchObject({ added: 1, matched: 0 });
    // Otro tipo, otro rol u otra página en el mismo sitio NO es el mismo campo.
    for (const other of [sf({ id: "n1", type: "signature" }), sf({ id: "n2", roleIndex: 1 }), sf({ id: "n3", pageIndex: 4 })]) {
      expect(mergeTemplateDrafts(edited, wrap(v([other]))).stats.added, other.id).toBe(1);
    }
  });

  it("lo que la persona añadió a mano o dejó solo (no está en la propuesta nueva) se conserva", () => {
    const edited = wrap(v([sf({ id: "gone", pageIndex: 2 }), sf({ id: "hand", pageIndex: 5, source: "manual" })], [tf({ id: "t1", source: "manual" })]));
    const out = mergeTemplateDrafts(edited, wrap(v([])));
    expect(out.variants["2"].fields.map((field) => field.id)).toEqual(["gone", "hand"]);
    expect(out.variants["2"].textFields).toHaveLength(1);
  });

  it("los ids descartados a propósito no vuelven", () => {
    const edited = wrap(v([]));
    const fresh = wrap(v([sf({ id: "am-0-0" }), sf({ id: "am-0-1", pageIndex: 1 })], [tf({ id: "am-t" })]));
    const out = mergeTemplateDrafts(edited, fresh, { dismissed: ["am-0-0", "am-t"] });
    expect(out.variants["2"].fields.map((field) => field.id)).toEqual(["am-0-1"]);
    expect(out.variants["2"].textFields).toHaveLength(0);
    expect(out.stats).toMatchObject({ added: 1, dismissed: 2 });
  });

  it("fusiona las dos variantes y los textos; lo añadido queda como auto", () => {
    const edited = { variants: { "1": v([sf({ id: "a", roleIndex: 0 })]), "2": v([]) } };
    const fresh = { variants: { "1": v([]), "2": v([sf({ id: "b", roleIndex: 1 })], [tf({ id: "c", source: "manual" })]) } };
    const out = mergeTemplateDrafts(edited, fresh);
    expect(out.variants["1"].fields).toHaveLength(1);
    expect(out.variants["2"].fields[0]).toMatchObject({ id: "b", source: "auto" });
    expect(out.variants["2"].textFields[0]).toMatchObject({ id: "c", source: "auto" });
  });

  it("un id nuevo que choca con uno existente se quita (no se repite dentro de la variante)", () => {
    const edited = wrap(v([sf({ id: "x", pageIndex: 7 })]));
    const out = mergeTemplateDrafts(edited, wrap(v([sf({ id: "x", pageIndex: 8, rect: R(0.1, 0.1, 0.05, 0.03) })], [])), { minOverlap: 0.99 });
    // Mismo id = mismo campo (matched), así que no se añade.
    expect(out.variants["2"].fields).toHaveLength(1);
    const clash = mergeTemplateDrafts(wrap(v([sf({ id: "x", pageIndex: 7 })], [tf({ id: "y", source: "manual" })])), wrap(v([], [tf({ id: "x", rect: R(0.5, 0.5, 0.2, 0.02) })])));
    const ids = [...clash.variants["2"].fields, ...clash.variants["2"].textFields].map((field) => field.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("respeta el tope de 500 campos y no modifica las entradas", () => {
    const fill = Array.from({ length: 499 }, (_, index) => sf({ id: `e${index}`, pageIndex: index % 100 + 1, rect: R(0.1, 0.1 + (index % 50) * 0.01, 0.05, 0.005) }));
    const edited = wrap(v(fill));
    const fresh = wrap(v([sf({ id: "n1", pageIndex: 150 }), sf({ id: "n2", pageIndex: 151 })]));
    const snapshotE = structuredClone(edited);
    const snapshotF = structuredClone(fresh);
    const out = mergeTemplateDrafts(edited, fresh);
    expect(out.variants["2"].fields).toHaveLength(500);
    expect(out.stats).toMatchObject({ added: 1, overflow: 1 });
    expect(edited).toEqual(snapshotE);
    expect(fresh).toEqual(snapshotF);
  });
});

describe("reconcileSources: trazabilidad auto → manual", () => {
  it("un campo auto que la persona movió (o cambió de tipo/rol/página) pasa a manual y pierde la confianza", () => {
    const before = wrap(v([sf({ id: "a", confidence: 0.9 }), sf({ id: "b", pageIndex: 1, confidence: 0.8 }), sf({ id: "c", pageIndex: 2 }), sf({ id: "d", pageIndex: 3 })]));
    const after = wrap(
      v([
        sf({ id: "a", confidence: 0.9, rect: R(0.8, 0.84, 0.05, 0.03), needsReview: true }),
        sf({ id: "b", pageIndex: 1, confidence: 0.8 }),
        sf({ id: "c", pageIndex: 2, type: "signature" }),
        sf({ id: "d", pageIndex: 3, roleIndex: 1 }),
      ]),
    );
    const out = reconcileSources(before, after)["2"].fields;
    expect(out[0]).toMatchObject({ source: "manual" });
    expect("confidence" in out[0]).toBe(false);
    expect("needsReview" in out[0]).toBe(false);
    expect(out[1]).toMatchObject({ source: "auto", confidence: 0.8 });
    expect(out[2].source).toBe("manual");
    expect(out[3].source).toBe("manual");
  });

  it("textos también; los campos sin id o nuevos no se tocan; las entradas no cambian", () => {
    const before = wrap(v([], [tf({ id: "t", confidence: 0.5 })]));
    const after = wrap(v([sf({})], [tf({ id: "t", confidence: 0.5, rect: R(0.2, 0.31, 0.3, 0.02) }), tf({ id: "new" })]));
    const snapshot = structuredClone(after);
    const out = reconcileSources(before, after)["2"];
    expect(out.textFields[0].source).toBe("manual");
    expect(out.textFields[1].source).toBe("auto");
    expect(out.fields[0].source).toBe("auto");
    expect(after).toEqual(snapshot);
  });

  it("un campo manual no vuelve a auto ni cambia", () => {
    const before = wrap(v([sf({ id: "m", source: "manual" })]));
    const after = wrap(v([sf({ id: "m", source: "manual", rect: R(0.5, 0.5, 0.1, 0.1) })]));
    expect(reconcileSources(before, after)["2"].fields[0].source).toBe("manual");
  });
});
