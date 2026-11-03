import { describe, expect, it } from "vitest";
import { instantiateTemplate, type SignTemplate } from "@/app/sign-pdf/signTemplates";
import { applyTemplate, cloneTemplate, selectVariant } from "./templateApply";
import { repeatInitials } from "./templateRepeat";
import { buildContent } from "./templateSchema";
import { INITIALS_BASE, R, sampleDraft, signField, textField, variantOf } from "./testing/templateSamples";
import { TEMPLATE_SCHEMA_VERSION, type DocTemplate, type TemplateDraft } from "./templateTypes";

function templateFrom(draft: TemplateDraft, extra: Partial<DocTemplate> = {}): DocTemplate {
  const content = buildContent(draft);
  if (!content) throw new Error("borrador inválido");
  return { schemaVersion: TEMPLATE_SCHEMA_VERSION, id: "tpl-a", documentId: draft.documentId, ...content, version: 1, createdAt: "2026-03-01T10:00:00.000Z", updatedAt: "2026-03-01T10:00:00.000Z", rev: 1, ...extra };
}

const full = () => templateFrom(sampleDraft("doc-1"));

describe("applyTemplate: formato de Firmar", () => {
  it("2 firmantes: usa la variante «2» y convierte a SignatureField / DetectedField", () => {
    const out = applyTemplate(full(), { signers: 2 });
    expect(out.variant).toBe("2");
    expect(out.warnings).toEqual([]);
    expect(out.fields).toHaveLength(4);
    expect(out.fields[0]).toEqual({ id: "tpl-s-1", signerId: "signer1", pageIndex: 3, type: "signature", rect: R(0.16, 0.5, 0.25, 0.05) });
    expect(out.fields[1]).toMatchObject({ signerId: "signer2", pageIndex: 3, type: "signature" });
    expect(out.fields.filter((field) => field.type === "initials").map((field) => field.signerId)).toEqual(["signer1", "signer2"]);
    expect(out.textFields).toHaveLength(2);
    // El tipo «text» NO se escribe (ausente = texto libre), igual que `instantiateTemplate`. El dato de la plantilla (`dataKey`)
    // pasa a ser la ETIQUETA del campo (`tag`): nace etiquetado, listo para recordar y propagar.
    expect(out.textFields[0]).toEqual({ id: "tpl-t-1", pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.025), label: "Nombre", source: "manual", confidence: "high", tag: "insuredName1" });
    expect(out.textFields[1]).toMatchObject({ type: "date", label: "Fecha" });
    expect(out.reviewFields).toEqual([]);
    expect(out.skippedPages).toEqual([]);
    expect(out.reviewPages).toEqual([]);
  });

  it("el campo de texto nace con la etiqueta de su `dataKey`; sin `dataKey` no lleva etiqueta", () => {
    const template = templateFrom(
      sampleDraft("doc-1", {
        variants: { "2": variantOf([signField({ pageIndex: 3 })], [textField({ label: "Dirección", dataKey: "address" }), textField({ label: "Nota libre" })]) },
      }),
    );
    const out = applyTemplate(template, { signers: 2 });
    expect(out.textFields[0]).toMatchObject({ label: "Dirección", tag: "address" });
    expect(out.textFields[1]).toMatchObject({ label: "Nota libre" });
    expect(out.textFields[1]).not.toHaveProperty("tag");
    expect(out.textMeta[out.textFields[0].id].dataKey).toBe("address");
  });

  it("mismo formato que las plantillas actuales de localStorage (instantiateTemplate)", () => {
    const legacy: SignTemplate = {
      id: "tpl-1",
      name: "Antigua",
      savedAt: "2026-01-01T00:00:00.000Z",
      sourcePageCount: 4,
      signers: [{ name: "Ana" }, { name: "Luis" }],
      fields: [
        { signerIndex: 0, pageIndex: 3, type: "signature", rect: R(0.16, 0.5, 0.25, 0.05) },
        { signerIndex: 1, pageIndex: 3, type: "signature", rect: R(0.55, 0.5, 0.25, 0.05) },
      ],
      textFields: [{ pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.025), label: "Nombre" }],
    };
    let n = 0;
    const old = instantiateTemplate(legacy, { pageCount: 4, mintSignerId: () => `s${(n += 1)}`, mintFieldId: () => `f${(n += 1)}`, mintTextFieldId: () => `t${(n += 1)}` })!;
    const template = templateFrom({
      documentId: null,
      name: "Nueva",
      variants: { "2": variantOf([signField({ pageIndex: 3 }), signField({ pageIndex: 3, roleIndex: 1, rect: R(0.55, 0.5, 0.25, 0.05) })], [textField({ label: "Nombre" })]) },
    });
    const out = applyTemplate(template, { signers: 2, roles: [{ signerId: old.signers[0].id }, { signerId: old.signers[1].id }] });
    const strip = <T extends { id: string }>(items: T[]) => items.map(({ id, ...rest }) => (void id, rest));
    expect(strip(out.fields)).toEqual(strip(old.fields));
    expect(strip(out.textFields)).toEqual(strip(old.textFields));
  });

  it("usa los signerId reales de los roles y los acuñadores de id que se le den", () => {
    let n = 0;
    const out = applyTemplate(full(), { signers: 2, roles: [{ signerId: "S-ANA" }, { signerId: "S-LUIS" }], mintFieldId: () => `F${(n += 1)}`, mintTextFieldId: () => `T${(n += 1)}` });
    expect(out.fields.map((field) => field.signerId)).toEqual(["S-ANA", "S-LUIS", "S-ANA", "S-LUIS"]);
    expect(out.fields.map((field) => field.id)).toEqual(["F1", "F2", "F3", "F4"]);
    expect(out.textFields.map((field) => field.id)).toEqual(["T5", "T6"]);
  });

  it("los ids nuevos no se repiten entre llamadas con el mismo acuñador y nunca son los de la plantilla", () => {
    const template = templateFrom(sampleDraft("doc-1", { variants: { "2": variantOf([signField({ id: "fixed" })], [textField({ id: "t-fixed" })]) } }));
    const out = applyTemplate(template, { signers: 2 });
    const ids = [...out.fields, ...out.textFields].map((field) => field.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("fixed");
    expect(out.fieldMeta[out.fields[0].id].templateFieldId).toBe("fixed");
    expect(out.textMeta[out.textFields[0].id].templateFieldId).toBe("t-fixed");
  });

  it("conserva dataKey, regla, required y grupo en metadatos aparte", () => {
    const template = templateFrom(sampleDraft("doc-1", { variants: { "2": variantOf([signField({ group: "B", required: false })], [textField({ type: "date", dataKey: "today", rule: "today", required: true, label: "Fecha" })]) } }));
    const out = applyTemplate(template, { signers: 2 });
    expect(out.fieldMeta[out.fields[0].id]).toEqual({ required: false, group: "B" });
    expect(out.textMeta[out.textFields[0].id]).toEqual({ dataKey: "today", required: true, rule: "today" });
  });

  it("no comparte objetos con la plantilla (mutar el resultado no la cambia)", () => {
    const template = full();
    const snapshot = structuredClone(template);
    const out = applyTemplate(template, { signers: 2 });
    out.fields[0].rect.x = 0.99;
    out.textFields[0].rect.x = 0.99;
    expect(template).toEqual(snapshot);
  });
});

describe("applyTemplate: 1 o 2 firmantes", () => {
  it("1 firmante con variante «1»: usa solo esa", () => {
    const out = applyTemplate(full(), { signers: 1 });
    expect(out.variant).toBe("1");
    expect(out.fields).toHaveLength(2);
    expect(out.fields.every((field) => field.signerId === "signer1")).toBe(true);
    expect(out.textFields).toHaveLength(1);
    expect(out.warnings).toEqual([]);
  });

  it("1 firmante y solo existe la «2»: usa los campos del firmante 1 y avisa de lo descartado", () => {
    const template = templateFrom(sampleDraft("doc-1", { variants: { "1": variantOf([]), "2": sampleDraft("x").variants!["2"]! } }));
    const out = applyTemplate(template, { signers: 1 });
    expect(out.variant).toBe("2");
    expect(out.fields.map((field) => field.signerId)).toEqual(["signer1", "signer1"]);
    expect(out.fields.map((field) => field.type).sort()).toEqual(["initials", "signature"]);
    expect(out.warnings).toEqual([{ code: "fallbackFromTwoSigners", droppedFields: 2 }]);
  });

  it("el respaldo también descarta los textos del asegurado 2", () => {
    const template = templateFrom(
      sampleDraft("doc-1", { variants: { "2": variantOf([signField(), signField({ roleIndex: 1, rect: R(0.55, 0.5, 0.25, 0.05) })], [textField({ dataKey: "insuredName1" }), textField({ dataKey: "insuredName2", label: "Co" }), textField({ label: "Tel", dataKey: "phone" })]) } }),
    );
    const out = applyTemplate(template, { signers: 1 });
    expect(out.textFields.map((field) => field.label)).toEqual(["Nombre", "Tel"]);
    expect(out.warnings).toEqual([{ code: "fallbackFromTwoSigners", droppedFields: 2 }]);
  });

  it("2 firmantes y solo existe la «1»: el firmante 2 queda sin campos, con aviso", () => {
    const template = templateFrom(sampleDraft("doc-1", { variants: { "1": sampleDraft("x").variants!["1"]!, "2": variantOf([]) } }));
    const out = applyTemplate(template, { signers: 2 });
    expect(out.variant).toBe("1");
    expect(out.fields.every((field) => field.signerId === "signer1")).toBe(true);
    expect(out.warnings).toEqual([{ code: "missingSecondSigner" }]);
  });

  it("sin ninguna firma: avisa y aplica los textos de la variante que los tenga", () => {
    const onlyText = templateFrom({ documentId: null, name: "Solo texto", variants: { "2": variantOf([], [textField()]) } });
    for (const signers of [1, 2] as const) {
      const out = applyTemplate(onlyText, { signers });
      expect(out.fields).toEqual([]);
      expect(out.textFields).toHaveLength(1);
      expect(out.warnings).toEqual([{ code: "noSignFields" }]);
    }
    const empty = templateFrom({ documentId: null, name: "Vacía" });
    expect(applyTemplate(empty, { signers: 2 })).toMatchObject({ fields: [], textFields: [], warnings: [{ code: "noSignFields" }] });
    const onlyTextOne = templateFrom({ documentId: null, name: "Texto 1", variants: { "1": variantOf([], [textField()]) } });
    expect(applyTemplate(onlyTextOne, { signers: 2 }).textFields).toHaveLength(1);
  });

  it("selectVariant devuelve la variante filtrada sin modificar la plantilla", () => {
    const template = full();
    const snapshot = structuredClone(template);
    selectVariant(template, 1);
    selectVariant(template, 2);
    expect(template).toEqual(snapshot);
    expect(selectVariant(template, 2).key).toBe("2");
  });
});

describe("applyTemplate: mapeo de páginas (huella)", () => {
  const spread = () =>
    templateFrom({
      documentId: "doc-1",
      name: "Cuatro páginas",
      variants: {
        "2": variantOf(
          [0, 1, 2, 3].map((page) => signField({ pageIndex: page, type: "initials", rect: R(0.79, 0.84, 0.1, 0.03) })),
          [textField({ pageIndex: 2, label: "Dato" })],
        ),
      },
    });

  it("sin mapa: identidad", () => {
    const out = applyTemplate(spread(), { signers: 2 });
    expect(out.fields.map((field) => field.pageIndex)).toEqual([0, 1, 2, 3]);
  });

  it("recoloca cada campo en la página del documento que le corresponde", () => {
    const out = applyTemplate(spread(), { signers: 2, pageMapping: [1, 2, 3, 4] });
    expect(out.fields.map((field) => field.pageIndex)).toEqual([1, 2, 3, 4]);
    expect(out.textFields[0].pageIndex).toBe(3);
  });

  it("página sin coincidencia (null): sus campos NO se aplican solos; van a «Revisar» y la página a skippedPages", () => {
    const out = applyTemplate(spread(), { signers: 2, pageMapping: [0, 1, null, 2] });
    expect(out.fields.map((field) => field.pageIndex)).toEqual([0, 1, 2]);
    expect(out.skippedPages).toEqual([2]);
    expect(out.reviewPages).toEqual([]);
    expect(out.reviewFields.map((field) => [field.templatePage, field.documentPage, field.reason, field.kind])).toEqual([
      [2, null, "noPageMatch", "signature"],
      [2, null, "noPageMatch", "text"],
    ]);
    expect(out.textFields).toHaveLength(0);
  });

  it("página «parecida» (reviewPages): se empareja pero NO se aplica sola", () => {
    const out = applyTemplate(spread(), { signers: 2, pageMapping: [0, 1, 2, 3], reviewPages: [1, 3] });
    expect(out.fields.map((field) => field.pageIndex)).toEqual([0, 2]);
    expect(out.reviewPages).toEqual([1, 3]);
    expect(out.skippedPages).toEqual([]);
    expect(out.reviewFields).toHaveLength(2);
    expect(out.reviewFields[0]).toMatchObject({ templatePage: 1, documentPage: 1, reason: "pageReview", type: "initials", roleIndex: 0 });
  });

  it("acepta { mappedPages, reviewPages } de un MatchResult; los parámetros sueltos mandan", () => {
    const match = { mappedPages: [0, 1, null, 3], reviewPages: [2] };
    expect(applyTemplate(spread(), { signers: 2, match }).skippedPages).toEqual([2]);
    const override = applyTemplate(spread(), { signers: 2, match, pageMapping: [0, 1, 2, 3], reviewPages: [] });
    expect(override.fields).toHaveLength(4);
  });

  it("un mapa más corto que la plantilla, o con valores raros, cuenta como «sin coincidencia»", () => {
    expect(applyTemplate(spread(), { signers: 2, pageMapping: [0, 1] }).skippedPages).toEqual([2, 3]);
    expect(applyTemplate(spread(), { signers: 2, pageMapping: [0, -1, 1.5, Number.NaN] }).skippedPages).toEqual([1, 2, 3]);
  });

  it("sin mapa, páginas fuera del documento (pageCount) van a «Revisar» como outOfRange", () => {
    const out = applyTemplate(spread(), { signers: 2, pageCount: 2 });
    expect(out.fields.map((field) => field.pageIndex)).toEqual([0, 1]);
    expect(out.skippedPages).toEqual([2, 3]);
    expect(out.reviewFields.every((field) => field.reason === "outOfRange")).toBe(true);
    // Con mapa, una página destino fuera de rango también.
    const mapped = applyTemplate(spread(), { signers: 2, pageMapping: [0, 1, 2, 3], pageCount: 3 });
    expect(mapped.skippedPages).toEqual([3]);
  });

  it("solo se listan páginas que TIENEN campos", () => {
    const template = templateFrom({ documentId: null, name: "Una", variants: { "2": variantOf([signField({ pageIndex: 5 })]) } });
    const out = applyTemplate(template, { signers: 2, pageMapping: [null, null, null, null, null, 5, null] });
    expect(out.skippedPages).toEqual([]);
    expect(out.fields).toHaveLength(1);
    expect(applyTemplate(template, { signers: 2, pageMapping: [null, null, null, null, null, null] }).skippedPages).toEqual([5]);
  });

  it("un campo marcado needsReview no se aplica solo, aunque su página coincida; la página no es «de revisión»", () => {
    const template = templateFrom({ documentId: null, name: "Auto", variants: { "2": variantOf([signField({ pageIndex: 0, needsReview: true, source: "auto" }), signField({ pageIndex: 0, roleIndex: 1 })], [textField({ needsReview: true })]) } });
    const out = applyTemplate(template, { signers: 2 });
    expect(out.fields).toHaveLength(1);
    expect(out.reviewFields.map((field) => field.reason)).toEqual(["needsReview", "needsReview"]);
    expect(out.reviewPages).toEqual([]);
    expect(out.skippedPages).toEqual([]);
  });
});

describe("applyTemplate: iniciales en todas las páginas con ajuste (flujo del usuario)", () => {
  it("8 páginas × 2 firmantes = 16 iniciales + firmas de las páginas de firma; todas aplicadas al reexportado", () => {
    const initials = repeatInitials({ fields: [], textFields: [] }, { signers: 2, base: INITIALS_BASE, toPage: [0, 1, 2, 3, 4, 5, 6], pageCount: 8, perPageAdjust: { 3: { dx: -0.01, dy: 0.01 } } });
    const template = templateFrom({
      documentId: "doc-1",
      name: "Moho",
      variants: { "2": { fields: [...initials.variant.fields, signField({ pageIndex: 7 }), signField({ pageIndex: 7, roleIndex: 1, rect: R(0.55, 0.5, 0.25, 0.05) })] } },
    });
    const out = applyTemplate(template, { signers: 2, pageMapping: [0, 1, 2, 3, 4, 5, 6, 7], reviewPages: [] });
    expect(out.fields).toHaveLength(16);
    expect(out.fields.filter((field) => field.type === "initials")).toHaveLength(14);
    const perPage = new Map<number, number>();
    for (const field of out.fields) if (field.type === "initials") perPage.set(field.pageIndex, (perPage.get(field.pageIndex) ?? 0) + 1);
    expect([...perPage.values()].every((count) => count === 2)).toBe(true);
    expect(perPage.size).toBe(7);
  });
});

describe("cloneTemplate («Usar esta plantilla en otro documento»)", () => {
  const base = () => templateFrom(sampleDraft("doc-1", { name: "Original" }), { id: "tpl-src" });

  it("identidad: copia todo, conserva el diseño de iniciales y apunta al origen", () => {
    const withLayout = { ...base(), layout: { initials: repeatInitials({ fields: [], textFields: [] }, { signers: 2, base: INITIALS_BASE, toPage: [0, 1] }).layout } };
    const out = cloneTemplate(withLayout, { documentId: "doc-2", mappedPages: [0, 1, 2, 3] });
    expect(out.draft.documentId).toBe("doc-2");
    expect(out.draft.name).toBe("Original (copia)");
    expect(out.draft.origin).toEqual({ kind: "clone", fromTemplateId: "tpl-src", fromDocumentId: "doc-1" });
    expect(out.draft.layout).toEqual(withLayout.layout);
    expect(out.dropped).toBe(0);
    expect(out.flagged).toBe(0);
    expect(out.kept).toBe(2 + 1 + 4 + 2);
    expect(buildContent(out.draft)).not.toBeNull();
  });

  it("el diseño de iniciales solo se conserva con el mapa identidad (si las páginas se mueven, deja de valer)", () => {
    const layout = repeatInitials({ fields: [], textFields: [] }, { signers: 2, base: INITIALS_BASE, toPage: [0, 1] }).layout;
    const withLayout = { ...base(), layout: { initials: layout } };
    expect(cloneTemplate(withLayout, { documentId: "d", mappedPages: [0, 1, 2, 3] }).draft.layout).toEqual({ initials: layout });
    expect(cloneTemplate(withLayout, { documentId: "d", mappedPages: [1, 2, 3, 4] }).draft.layout).toBeUndefined();
    expect(cloneTemplate(withLayout, { documentId: "d", mappedPages: [0, 1, null, 3] }).draft.layout).toBeUndefined();
    // La copia del diseño no comparte objetos con el original.
    const copy = cloneTemplate(withLayout, { documentId: "d", mappedPages: [0, 1, 2, 3] }).draft.layout!;
    copy.initials!.base.x = 0.5;
    expect(withLayout.layout.initials.base.x).toBe(INITIALS_BASE.x);
  });

  it("recoloca las páginas, descarta las sin correspondencia y marca para revisar las parecidas", () => {
    const out = cloneTemplate(base(), { documentId: "doc-2", mappedPages: [1, null, null, 3], reviewPages: [3] });
    const two = out.draft.variants!["2"]!;
    expect(two.fields!.map((field) => field.pageIndex).sort()).toEqual([1, 1, 3, 3]);
    expect(two.fields!.filter((field) => field.pageIndex === 3).every((field) => field.needsReview === true)).toBe(true);
    expect(two.fields!.filter((field) => field.pageIndex === 1).every((field) => field.needsReview === undefined)).toBe(true);
    expect(out.droppedPages).toEqual([]);
    expect(out.flagged).toBeGreaterThan(0);
    expect(out.draft.layout).toBeUndefined();
  });

  it("cuenta lo descartado y las páginas afectadas", () => {
    const out = cloneTemplate(base(), { documentId: "doc-2", mappedPages: [0, null, null, null] });
    expect(out.droppedPages).toEqual([3]);
    // Variante «1»: 2 campos + 1 texto; variante «2»: 4 campos + 2 textos. Solo los de la página 0 se conservan.
    expect(out.kept).toBe(5);
    expect(out.dropped).toBe(4);
    expect(out.kept + out.dropped).toBe(9);
  });

  it("un destino con menos páginas descarta los campos que caerían fuera", () => {
    const out = cloneTemplate(base(), { documentId: "doc-2", mappedPages: [0, 1, 2, 3], targetPageCount: 2 });
    expect(out.droppedPages).toEqual([3]);
  });

  it("nombre propio, recortado a 120 y sin tocar la plantilla de origen", () => {
    const source = base();
    const snapshot = structuredClone(source);
    expect(cloneTemplate(source, { documentId: null, mappedPages: [0, 1, 2, 3], name: "Otro" }).draft.name).toBe("Otro");
    const long = { ...source, name: "n".repeat(120) };
    expect(cloneTemplate(long, { documentId: null, mappedPages: [0] }).draft.name).toHaveLength(120);
    expect(source).toEqual(snapshot);
  });

  it("un mapa roto (valores raros) descarta sin lanzar", () => {
    const out = cloneTemplate(base(), { documentId: null, mappedPages: [-1, 1.5, Number.NaN] });
    expect(out.kept).toBe(0);
  });
});
