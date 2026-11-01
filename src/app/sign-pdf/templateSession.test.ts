import { describe, expect, it } from "vitest";
import type { AutoField, AutoMapResult } from "@/lib/pdf/autoMapTypes";
import { repeatInitials } from "@/lib/docLibrary/templateRepeat";
import { DEFAULT_ROLES, TEMPLATE_SCHEMA_VERSION, type DocTemplate, type TemplateSignField, type Variant } from "@/lib/docLibrary/templateTypes";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { captureStamp } from "@/app/sign-pdf/captures";
import { EMPTY_DOC_STATE, docStateOf, liveFields, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  autoMapSignerCount,
  chooseCount,
  clampCount,
  ensureRoleSigners,
  isPristine,
  planAccept,
  planAutoMapApplication,
  planTemplateApplication,
  planUndo,
  hasLoss,
  signerWork,
  undoWork,
  NO_LOSS,
  reuseFieldIds,
  reuseFieldIdsByRole,
  restampKeptSigners,
  appliedFieldsUnchanged,
  signerNamesAreRoleDefaults,
  variantSupport,
  type Mint,
  type PendingField,
} from "@/app/sign-pdf/templateSession";

const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
let counter = 0;
const mint: Mint = { signerId: () => `sg-${(counter += 1)}`, fieldId: () => `fld-${(counter += 1)}`, textFieldId: () => `txt-${(counter += 1)}` };

const LINE = R(0.74, 0.885, 0.13, 0.045);
function variantWithInitials(signers: 1 | 2, pages: number): Variant {
  const base: Variant = { fields: [], textFields: [] };
  const withInitials = repeatInitials(base, { signers, base: LINE, fromPage: 0, toPage: pages - 1, pageCount: pages }).variant;
  const sign: TemplateSignField[] = [{ id: "s0", roleIndex: 0, pageIndex: pages - 1, type: "signature", rect: R(0.1, 0.5, 0.3, 0.05), required: true, source: "manual" }];
  if (signers === 2) sign.push({ id: "s1", roleIndex: 1, pageIndex: pages - 1, type: "signature", rect: R(0.55, 0.5, 0.3, 0.05), required: true, source: "manual" });
  return { fields: [...withInitials.fields, ...sign], textFields: [{ id: "t1", pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.03), type: "text", label: "Nombre", required: false, source: "manual", dataKey: "insuredName1" }, { id: "t2", pageIndex: pages - 1, rect: R(0.1, 0.62, 0.2, 0.03), type: "date", label: "Fecha", required: false, source: "manual", dataKey: "today", rule: "today" }] };
}
function template(pages = 4, options: { one?: boolean; two?: boolean } = { one: true, two: true }): DocTemplate {
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id: "tpl-1",
    documentId: "doc-lib",
    name: "Mold Test",
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    rev: 4,
    roles: DEFAULT_ROLES.map((role) => ({ ...role })),
    variants: { "1": options.one ? variantWithInitials(1, pages) : { fields: [], textFields: [] }, "2": options.two ? variantWithInitials(2, pages) : { fields: [], textFields: [] } },
  };
}
function session(over: Partial<SignSession> = {}): SignSession {
  return { ...DEFAULT_SESSION, docOrder: ["doc-1"], activeDocId: "doc-1", ...over };
}

describe("firmantes y contadores", () => {
  it("clampCount y chooseCount: los que ya hay, si no los recordados, si no 2; sin variante de 2 se usa 1", () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(5)).toBe(2);
    const both = { one: true, two: true };
    expect(chooseCount({ signers: 2, remembered: null, support: both })).toBe(2);
    expect(chooseCount({ signers: 1, remembered: 2, support: both })).toBe(1);
    expect(chooseCount({ signers: 0, remembered: 1, support: both })).toBe(1);
    expect(chooseCount({ signers: 0, remembered: null, support: both })).toBe(2);
    expect(chooseCount({ signers: 0, remembered: null, support: { one: true, two: false } })).toBe(1);
    expect(chooseCount({ signers: 2, remembered: null, support: { one: true, two: false } })).toBe(1);
    expect(chooseCount({ signers: 0, remembered: 2, support: { one: true, two: false } })).toBe(1);
  });

  it("variantSupport: la variante de 1 puede venir del firmante 1 de la de 2", () => {
    expect(variantSupport(template(3, { two: true }))).toEqual({ one: true, two: true });
    expect(variantSupport(template(3, { one: true }))).toEqual({ one: true, two: false });
    expect(variantSupport(template(3, {}))).toEqual({ one: false, two: false });
  });

  it("ensureRoleSigners crea solo los que faltan, con el nombre del rol y colores distintos", () => {
    const own = { id: "sg-own", name: "Ana", color: "#000" };
    const out = ensureRoleSigners([own], DEFAULT_ROLES, 2, () => "sg-new");
    expect(out.signers.map((s) => [s.id, s.name])).toEqual([["sg-own", "Ana"], ["sg-new", "Co-asegurado"]]);
    expect(out.created).toEqual(["sg-new"]);
    expect(out.signers[0].color).not.toBe(out.signers[1].color);
    expect(ensureRoleSigners([own], DEFAULT_ROLES, 1, mint.signerId).created).toEqual([]);
  });

  it("signerNamesAreRoleDefaults solo si TODOS conservan el nombre de su rol", () => {
    const names = (...list: string[]) => list.map((name, index) => ({ id: `s${index}`, name, color: "#000" }));
    expect(signerNamesAreRoleDefaults(names("Asegurado", "Co-asegurado"), DEFAULT_ROLES)).toBe(true);
    expect(signerNamesAreRoleDefaults(names("Asegurado", "Luis"), DEFAULT_ROLES)).toBe(false);
    expect(signerNamesAreRoleDefaults([], DEFAULT_ROLES)).toBe(false);
  });
});

describe("documento limpio", () => {
  const dirty = (patch: Partial<typeof EMPTY_DOC_STATE>) => session({ docs: { "doc-1": { ...EMPTY_DOC_STATE, ...patch } } });
  const signer = { id: "sg-1", name: "Ana", color: "#000" };
  it("limpio: sin huecos, valores, ediciones, campos a mano ni trazos; la deteccion automatica no cuenta como trabajo", () => {
    expect(isPristine(session(), "doc-1")).toBe(true);
    expect(isPristine(dirty({ textFields: [{ id: "a", pageIndex: 0, rect: R(0, 0, 0.1, 0.1), source: "acroform", confidence: "high" }, { id: "b", pageIndex: 0, rect: R(0, 0, 0.1, 0.1), source: "heuristic-vector", confidence: "low" }] }), "doc-1")).toBe(true);
  });
  it("no limpio: huecos, campos a mano, valores, ediciones o trazos", () => {
    const field = { id: "f", signerId: "sg-1", pageIndex: 0, type: "signature" as const, rect: R(0, 0, 0.1, 0.1) };
    expect(isPristine({ ...dirty({ fields: [field] }), signers: [signer] }, "doc-1")).toBe(false);
    expect(isPristine(dirty({ fields: [field] }), "doc-1")).toBe(false);
    expect(isPristine(dirty({ textFields: [{ id: "m", pageIndex: 0, rect: R(0, 0, 0.1, 0.1), source: "manual", confidence: "high" }] }), "doc-1")).toBe(false);
    expect(isPristine(dirty({ textValues: { a: "x" } }), "doc-1")).toBe(false);
    expect(isPristine(dirty({ textEdits: [{ id: "e" } as never] }), "doc-1")).toBe(false);
    const block = { id: "bk-1", signerId: "sg-1", appliesTo: ["doc-1"], signature: { dataUrl: "d", ratio: 1 }, initials: null, stamps: {}, auto: true };
    expect(isPristine(session({ blocks: [block] }), "doc-1")).toBe(false);
    expect(isPristine(session({ blocks: [{ ...block, appliesTo: ["doc-2"] }] }), "doc-1")).toBe(true);
  });
});

describe("aplicar una plantilla", () => {
  it("2 firmantes: crea los dos firmantes con el nombre de su rol, pasa a «Varios firmantes» y pone todos los campos", () => {
    const plan = planTemplateApplication({ template: template(4), match: null, count: 2, session: session(), docId: "doc-1", pageCount: 4, mint });
    expect(plan.patch.mode).toBe("multi");
    expect(plan.patch.signers?.map((s) => s.name)).toEqual(["Asegurado", "Co-asegurado"]);
    const doc = docStateOf(plan.patch.docs!, "doc-1");
    // 4 paginas x 2 iniciales + 2 firmas
    expect(doc.fields).toHaveLength(10);
    expect(doc.fields.filter((f) => f.type === "initials")).toHaveLength(8);
    expect(doc.textFields.map((f) => f.type ?? "text")).toEqual(["text", "date"]);
    expect(plan.record).toMatchObject({ source: "template", count: 2, level: "exact", percent: 100, pages: 4, template: { id: "tpl-1", name: "Mold Test", version: 3 } });
    expect(plan.record.createdSignerIds).toHaveLength(2);
    expect(plan.record.before).toMatchObject({ mode: "single", signers: [] });
    expect(plan.record.textMeta[doc.textFields[1].id]).toMatchObject({ dataKey: "today", rule: "today" });
    expect(plan.patch.blocks?.map((b) => b.signerId).sort()).toEqual(plan.patch.signers?.map((s) => s.id).sort());
    expect(plan.pending).toEqual([]);
  });

  it("las iniciales quedan una al lado de la otra: el firmante 1 a la izquierda en TODAS las paginas", () => {
    const plan = planTemplateApplication({ template: template(5), match: null, count: 2, session: session(), docId: "doc-1", pageCount: 5, mint });
    const [one, two] = plan.patch.signers!;
    const fields = docStateOf(plan.patch.docs!, "doc-1").fields.filter((f) => f.type === "initials");
    for (let page = 0; page < 5; page += 1) {
      const left = fields.find((f) => f.pageIndex === page && f.signerId === one.id)!;
      const right = fields.find((f) => f.pageIndex === page && f.signerId === two.id)!;
      expect(left.rect.x).toBeLessThan(right.rect.x);
      expect(left.rect.y).toBe(right.rect.y);
    }
  });

  it("1 firmante: usa la variante de 1 y no crea el segundo", () => {
    const plan = planTemplateApplication({ template: template(3), match: null, count: 1, session: session(), docId: "doc-1", pageCount: 3, mint });
    expect(plan.patch.signers).toHaveLength(1);
    expect(docStateOf(plan.patch.docs!, "doc-1").fields).toHaveLength(4);
    expect(plan.record.count).toBe(1);
  });

  it("con firmantes ya definidos se usan esos (por orden) y solo se crean los que faltan", () => {
    const ana = { id: "sg-ana", name: "Ana", color: "#000" };
    const plan = planTemplateApplication({ template: template(2), match: null, count: 2, session: session({ mode: "multi", signers: [ana] }), docId: "doc-1", pageCount: 2, mint });
    expect(plan.patch.signers?.[0].id).toBe("sg-ana");
    expect(plan.patch.signers?.[1].name).toBe("Co-asegurado");
    expect(plan.record.createdSignerIds).toHaveLength(1);
    expect(docStateOf(plan.patch.docs!, "doc-1").fields.some((f) => f.signerId === "sg-ana")).toBe(true);
  });

  it("paginas a revisar: no se aplican solas y van a las sugerencias; «Parece» recoloca con el mapa", () => {
    const match = { level: "similar" as const, percent: 85, mappedPages: [0, 1, 2, 3], reviewPages: [1, 3] };
    const plan = planTemplateApplication({ template: template(4), match, count: 2, session: session(), docId: "doc-1", pageCount: 4, mint });
    const doc = docStateOf(plan.patch.docs!, "doc-1");
    expect(new Set(doc.fields.map((f) => f.pageIndex))).toEqual(new Set([0, 2]));
    expect(plan.record.reviewPages).toEqual([1, 3]);
    expect(plan.record.level).toBe("similar");
    expect(plan.pending.length).toBeGreaterThan(0);
    expect(plan.pending.every((p) => p.origin === "template" && (p.templatePage === 1 || p.templatePage === 3) && p.pageIndex !== null)).toBe(true);
  });

  it("una pagina sin equivalente va a «Revisar» sin pagina (no se puede aceptar)", () => {
    const match = { level: "similar" as const, percent: 80, mappedPages: [0, 1, 2, null], reviewPages: [] as number[] };
    const plan = planTemplateApplication({ template: template(4), match, count: 1, session: session(), docId: "doc-1", pageCount: 3, mint });
    const missing = plan.pending.filter((p) => p.pageIndex === null);
    expect(missing.length).toBeGreaterThan(0);
    expect(plan.record.skippedPages).toEqual([3]);
    expect(planAccept(session({ signers: plan.patch.signers! }), "doc-1", missing[0], mint)).toBeNull();
  });

  it("de 2 a 1 firmante re-aplica: el firmante creado se retira, los campos del firmante 1 que no cambian CONSERVAN su id", () => {
    const first = planTemplateApplication({ template: template(3), match: null, count: 2, session: session(), docId: "doc-1", pageCount: 3, mint });
    const after = session({ ...first.patch, mode: "multi" });
    const signatureBefore = docStateOf(after.docs, "doc-1").fields.find((f) => f.type === "signature" && f.signerId === after.signers[0].id)!;
    const again = planTemplateApplication({ template: template(3), match: null, count: 1, session: after, docId: "doc-1", pageCount: 3, mint, previous: first.record });
    expect(again.patch.signers).toHaveLength(1);
    const doc = docStateOf(again.patch.docs!, "doc-1");
    expect(doc.fields.every((f) => f.signerId === after.signers[0].id)).toBe(true);
    expect(doc.fields.filter((f) => f.type === "initials")).toHaveLength(3);
    // La firma del firmante 1 esta en el mismo sitio en las dos variantes: mismo id (su trazo sigue valiendo).
    expect(doc.fields.find((f) => f.type === "signature")!.id).toBe(signatureBefore.id);
    // Los textos tampoco se duplican.
    expect(doc.textFields).toHaveLength(2);
    expect(again.record.before).toEqual(first.record.before);
  });

  it("de 1 a 2 firmantes: se anade el segundo y lo que no cambia conserva el id", () => {
    const first = planTemplateApplication({ template: template(3), match: null, count: 1, session: session(), docId: "doc-1", pageCount: 3, mint });
    const after = session({ ...first.patch, mode: "multi" });
    const again = planTemplateApplication({ template: template(3), match: null, count: 2, session: after, docId: "doc-1", pageCount: 3, mint, previous: first.record });
    expect(again.patch.signers).toHaveLength(2);
    const ids = new Set(docStateOf(after.docs, "doc-1").fields.filter((f) => f.type === "signature").map((f) => f.id));
    expect(docStateOf(again.patch.docs!, "doc-1").fields.some((f) => ids.has(f.id))).toBe(true);
  });

  it("re-aplicar no toca lo que la persona puso a mano ni a un firmante que puso ella", () => {
    const luis = { id: "sg-luis", name: "Luis", color: "#000" };
    const first = planTemplateApplication({ template: template(2), match: null, count: 1, session: session({ signers: [luis] }), docId: "doc-1", pageCount: 2, mint });
    const manual = { id: "fld-manual", signerId: luis.id, pageIndex: 0, type: "signature" as const, rect: R(0.2, 0.2, 0.2, 0.05) };
    const doc = docStateOf(first.patch.docs!, "doc-1");
    const withManual = session({ ...first.patch, mode: "multi", docs: { "doc-1": { ...doc, fields: [...doc.fields, manual] } } });
    const again = planTemplateApplication({ template: template(2), match: null, count: 2, session: withManual, docId: "doc-1", pageCount: 2, mint, previous: first.record });
    expect(docStateOf(again.patch.docs!, "doc-1").fields.some((f) => f.id === "fld-manual")).toBe(true);
    expect(again.patch.signers?.[0].id).toBe("sg-luis");
    // Bajar a 1 no retira al segundo si lo puso la persona: aqui el segundo lo creo la aplicacion.
    const down = planTemplateApplication({ template: template(2), match: null, count: 1, session: session({ ...again.patch, mode: "multi" }), docId: "doc-1", pageCount: 2, mint, previous: again.record });
    expect(down.patch.signers?.map((s) => s.id)).toEqual(["sg-luis"]);
  });

  it("las sugerencias heuristicas de campos de texto se sustituyen por los de la plantilla", () => {
    const heuristic = { id: "h1", pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.03), source: "heuristic-vector" as const, confidence: "low" as const };
    const acro = { id: "a1", pageIndex: 1, rect: R(0.1, 0.2, 0.3, 0.03), source: "acroform" as const, confidence: "high" as const };
    const base = session({ docs: { "doc-1": { ...EMPTY_DOC_STATE, textFields: [heuristic, acro] } } });
    const plan = planTemplateApplication({ template: template(2), match: null, count: 1, session: base, docId: "doc-1", pageCount: 2, mint });
    const ids = docStateOf(plan.patch.docs!, "doc-1").textFields.map((f) => f.id);
    expect(ids).not.toContain("h1");
    expect(ids).toContain("a1");
  });
});

describe("¿lo aplicado sigue intacto?", () => {
  it("intacto solo si no se movió, quitó ni añadió ningún campo (la deteccion automatica no cuenta)", () => {
    const plan = planTemplateApplication({ template: template(3), match: null, count: 2, session: session(), docId: "doc-1", pageCount: 3, mint });
    const doc = docStateOf(plan.patch.docs!, "doc-1");
    expect(appliedFieldsUnchanged(doc, plan.record)).toBe(true);
    const heuristic = { id: "h", pageIndex: 0, rect: R(0.1, 0.9, 0.2, 0.03), source: "heuristic-vector" as const, confidence: "low" as const };
    expect(appliedFieldsUnchanged({ ...doc, textFields: [...doc.textFields, heuristic] }, plan.record)).toBe(true);
    const moved = { ...doc, fields: doc.fields.map((f, i) => (i === 0 ? { ...f, rect: { ...f.rect, x: f.rect.x + 0.01 } } : f)) };
    expect(appliedFieldsUnchanged(moved, plan.record)).toBe(false);
    expect(appliedFieldsUnchanged({ ...doc, fields: doc.fields.slice(1) }, plan.record)).toBe(false);
    const extra = { id: "x", signerId: doc.fields[0].signerId, pageIndex: 0, type: "signature" as const, rect: R(0.2, 0.2, 0.2, 0.05) };
    expect(appliedFieldsUnchanged({ ...doc, fields: [...doc.fields, extra] }, plan.record)).toBe(false);
    expect(appliedFieldsUnchanged({ ...doc, textFields: [...doc.textFields, { ...heuristic, source: "manual" as const }] }, plan.record)).toBe(false);
  });
});

describe("deshacer y aceptar", () => {
  it("deshacer retira lo aplicado, los firmantes que creo y vuelve a «Solo yo»", () => {
    const plan = planTemplateApplication({ template: template(3), match: null, count: 2, session: session(), docId: "doc-1", pageCount: 3, mint });
    const applied = session({ ...plan.patch });
    const undone = planUndo(applied, "doc-1", plan.record);
    expect(docStateOf(undone.docs!, "doc-1").fields).toEqual([]);
    expect(docStateOf(undone.docs!, "doc-1").textFields).toEqual([]);
    expect(undone.signers).toEqual([]);
    expect(undone.mode).toBe("single");
    expect(undone.blocks).toEqual([]);
  });

  it("deshacer no quita lo que la persona anadio, ni los firmantes que ya estaban", () => {
    const ana = { id: "sg-ana", name: "Ana", color: "#000" };
    const plan = planTemplateApplication({ template: template(2), match: null, count: 1, session: session({ mode: "multi", signers: [ana] }), docId: "doc-1", pageCount: 2, mint });
    const doc = docStateOf(plan.patch.docs!, "doc-1");
    const manual = { id: "m1", signerId: ana.id, pageIndex: 0, type: "signature" as const, rect: R(0.2, 0.2, 0.2, 0.05) };
    const applied = session({ ...plan.patch, docs: { "doc-1": { ...doc, fields: [...doc.fields, manual] } } });
    const undone = planUndo(applied, "doc-1", plan.record);
    expect(docStateOf(undone.docs!, "doc-1").fields).toEqual([manual]);
    expect(undone.signers).toHaveLength(1);
    expect(undone.mode).toBe("multi");
  });

  it("aceptar una sugerencia: firma al firmante que le toca; sin ese firmante, nada", () => {
    const ana = { id: "sg-ana", name: "Ana", color: "#000" };
    const item: PendingField = { key: "k", origin: "automap", kind: "sign", type: "initials", signerIndex: 0, pageIndex: 2, rect: R(0.7, 0.9, 0.1, 0.04), reason: "r" };
    const planned = planAccept(session({ signers: [ana] }), "doc-1", item, mint)!;
    expect(docStateOf(planned.patch.docs!, "doc-1").fields[0]).toMatchObject({ signerId: "sg-ana", pageIndex: 2, type: "initials" });
    expect(planAccept(session(), "doc-1", item, mint)).toBeNull();
    expect(planAccept(session({ signers: [ana] }), "doc-1", { ...item, signerIndex: 1 }, mint)).toBeNull();
    const text = planAccept(session(), "doc-1", { key: "t", origin: "automap", kind: "text", type: "date", pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), label: "Fecha", reason: "r" }, mint)!;
    expect(docStateOf(text.patch.docs!, "doc-1").textFields[0]).toMatchObject({ type: "date", label: "Fecha", source: "manual" });
  });

  it("reuseFieldIds solo reutiliza lo que queda en el mismo sitio, del mismo firmante y tipo", () => {
    const old = [{ id: "a", signerId: "s1", pageIndex: 0, type: "initials" as const, rect: R(0.1, 0.1, 0.1, 0.1) }];
    const same = { id: "n1", signerId: "s1", pageIndex: 0, type: "initials" as const, rect: R(0.1, 0.1, 0.1, 0.1) };
    expect(reuseFieldIds(old, [same])[0].id).toBe("a");
    expect(reuseFieldIds(old, [{ ...same, signerId: "s2" }])[0].id).toBe("n1");
    expect(reuseFieldIds(old, [{ ...same, rect: R(0.2, 0.1, 0.1, 0.1) }])[0].id).toBe("n1");
    expect(reuseFieldIds(old, [{ ...same, type: "signature" as const }])[0].id).toBe("n1");
    expect(reuseFieldIds(old, [same, { ...same, id: "n2" }]).map((f) => f.id)).toEqual(["a", "n2"]);
  });
});

describe("automapeo en Firmar", () => {
  const field = (id: string, over: Partial<AutoField>): AutoField => ({ id, pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.04), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "linea de iniciales", source: "label", ...over });
  const result = (fields: AutoField[]): AutoMapResult => ({ fields, pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] });

  it("coloca los de confianza alta, deja los de revision como sugerencias y crea los firmantes", () => {
    const plan = planAutoMapApplication({
      result: result([field("am-0-1", {}), field("am-0-2", { signerIndex: 1, rect: R(0.4, 0.1, 0.2, 0.04) }), field("am-1-1", { tier: "review", pageIndex: 1 }), field("am-1-2", { type: "date", signerIndex: undefined, label: "Date", tier: "review" }), field("am-2", { tier: "ignore" }), field("am-3", { type: "signature", signerIndex: undefined, tier: "review" }), field("am-4", { type: "text", label: "Phone", rect: R(0.1, 0.3, 0.3, 0.03) })]),
      count: 2,
      session: session(),
      docId: "doc-1",
      roles: DEFAULT_ROLES,
      mint,
    });
    const doc = docStateOf(plan.patch.docs!, "doc-1");
    expect(doc.fields).toHaveLength(2);
    expect(doc.textFields).toHaveLength(1);
    expect(doc.textFields[0]).toMatchObject({ label: "Phone", source: "manual" });
    expect(plan.patch.signers).toHaveLength(2);
    expect(plan.patch.mode).toBe("multi");
    // La firma sin firmante claro (am-3) se ofrece, sin firmante asignado.
    expect(plan.pending.map((p) => p.key).sort()).toEqual(["am-1-1", "am-1-2", "am-3"]);
    expect(plan.pending.find((p) => p.key === "am-3")?.signerIndex).toBeUndefined();
    expect(plan.record).toMatchObject({ source: "automap", count: 2, placed: 3 });
    expect(liveFields(doc, plan.patch.signers!).length).toBe(2);
  });

  it("con 1 firmante ignora lo del firmante 2; la fecha de confianza alta lleva la regla «hoy»", () => {
    const plan = planAutoMapApplication({ result: result([field("a", {}), field("b", { signerIndex: 1 }), field("d", { type: "date", signerIndex: undefined, label: "Date" })]), count: 1, session: session(), docId: "doc-1", roles: DEFAULT_ROLES, mint });
    const doc = docStateOf(plan.patch.docs!, "doc-1");
    expect(doc.fields).toHaveLength(1);
    expect(plan.patch.signers).toHaveLength(1);
    expect(plan.record.textMeta[doc.textFields[0].id]).toMatchObject({ dataKey: "today", rule: "today" });
    expect(doc.textFields[0].type).toBe("date");
  });

  it("una firma de CONFIANZA ALTA sin firmante nunca se coloca ni se ofrece (solo las de revision se ofrecen)", () => {
    const plan = planAutoMapApplication({ result: result([field("x", { type: "signature", signerIndex: undefined, tier: "high" }), field("y", { type: "signature", signerIndex: undefined, tier: "review" })]), count: 2, session: session(), docId: "doc-1", roles: DEFAULT_ROLES, mint });
    expect(docStateOf(plan.patch.docs!, "doc-1").fields).toHaveLength(0);
    expect(plan.pending.map((p) => p.key)).toEqual(["y"]);
  });

  it("autoMapSignerCount: 2 solo si hay un campo de firma o iniciales del firmante 2 con confianza alta", () => {
    expect(autoMapSignerCount(result([field("a", {})]))).toBe(1);
    expect(autoMapSignerCount(result([field("a", {}), field("b", { signerIndex: 1 })]))).toBe(2);
    expect(autoMapSignerCount(result([field("b", { signerIndex: 1, tier: "review" })]))).toBe(1);
    expect(autoMapSignerCount(result([field("b", { signerIndex: 1, type: "date" })]))).toBe(1);
  });

  it("re-aplicar el automapeo con otro nº de firmantes sustituye lo anterior sin duplicar", () => {
    const fields = [field("a", {}), field("b", { signerIndex: 1, rect: R(0.4, 0.1, 0.2, 0.04) })];
    const first = planAutoMapApplication({ result: result(fields), count: 2, session: session(), docId: "doc-1", roles: DEFAULT_ROLES, mint });
    const after = session({ ...first.patch, mode: "multi" });
    const again = planAutoMapApplication({ result: result([fields[0]]), count: 1, session: after, docId: "doc-1", roles: DEFAULT_ROLES, mint, previous: first.record });
    expect(docStateOf(again.patch.docs!, "doc-1").fields).toHaveLength(1);
    expect(docStateOf(again.patch.docs!, "doc-1").fields[0].id).toBe(docStateOf(after.docs, "doc-1").fields[0].id);
  });
});

/* ------------------------------------------------------------------ *
 * F2-fix: no se pierde trabajo de la persona (cambio de firmantes y Deshacer)
 * ------------------------------------------------------------------ */

const DRAFT = { dataUrl: "data:image/png;base64,AAAA", ratio: 3 };
const strokesFor = (signerId: string, docId = "doc-1"): SignerBlock => ({ id: `bk-${signerId}`, signerId, appliesTo: [docId], signature: DRAFT, initials: DRAFT, stamps: { [docId]: "stamp" }, auto: true });

/** Plantilla de 2 firmantes con un campo de texto que solo existe en la variante de 2 (para ver valores huerfanos). */
function appliedTwoSigners(over: { tpl?: DocTemplate } = {}) {
  const tpl = over.tpl ?? template(3);
  const plan = planTemplateApplication({ template: tpl, match: null, count: 2, session: session(), docId: "doc-1", pageCount: 3, mint });
  return { tpl, plan, applied: session({ ...plan.patch, mode: "multi" }) };
}

describe("trabajo de la persona: lo que un cambio quitaria", () => {
  it("signerWork distingue trazos recogidos y un nombre escrito distinto del que dio la plantilla", () => {
    const { plan, applied } = appliedTwoSigners();
    const second = applied.signers[1];
    expect(signerWork(applied, second, plan.record)).toEqual({ strokes: false, typed: false });
    expect(signerWork({ blocks: [strokesFor(second.id)] }, second, plan.record)).toEqual({ strokes: true, typed: false });
    expect(signerWork(applied, { ...second, name: "Luis Pérez" }, plan.record)).toEqual({ strokes: false, typed: true });
    // Escribir y volver a dejar el nombre del rol no es trabajo; un nombre vacio tampoco.
    expect(signerWork(applied, { ...second, name: "  Co-asegurado " }, plan.record).typed).toBe(false);
    expect(signerWork(applied, { ...second, name: "" }, plan.record).typed).toBe(false);
    // Sin registro (un firmante que no creo la aplicacion) cualquier nombre cuenta.
    expect(signerWork(applied, { ...second, name: "Luis" }, undefined).typed).toBe(true);
  });

  it("2 → 1 sin nada que perder (nombres genericos, sin trazos): sin perdida, hay que hacerlo sin preguntar", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: applied, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.loss).toEqual(NO_LOSS);
    expect(hasLoss(down.loss)).toBe(false);
    expect(down.patch.signers).toHaveLength(1);
  });

  it("2 → 1 con la firma e iniciales del firmante 2: la perdida lo nombra (con trazos) y el plan sigue siendo el mismo", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const second = applied.signers[1];
    const withStrokes = { ...applied, blocks: [...applied.blocks.filter((b) => b.signerId !== second.id), strokesFor(second.id)] };
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: withStrokes, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.loss.signers).toEqual([{ id: second.id, name: "Co-asegurado", strokes: true }]);
    expect(hasLoss(down.loss)).toBe(true);
  });

  it("2 → 1 con un nombre real escrito para el firmante 2 (sin trazos): tambien es trabajo", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const renamed = { ...applied, signers: applied.signers.map((s, i) => (i === 1 ? { ...s, name: "Marta Ruiz" } : s)) };
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: renamed, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.loss.signers).toEqual([{ id: applied.signers[1].id, name: "Marta Ruiz", strokes: false }]);
  });

  it("2 → 1: los trazos del firmante 1 (que se queda) NO cuentan como perdida", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const first = applied.signers[0];
    const withFirst = { ...applied, blocks: [...applied.blocks.filter((b) => b.signerId !== first.id), strokesFor(first.id)] };
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: withFirst, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.loss).toEqual(NO_LOSS);
  });

  it("los valores escritos en campos de texto que la nueva variante ya no tiene cuentan como perdida; los que se conservan, no", () => {
    const tpl = template(3);
    // La variante de 2 tiene un campo de texto extra que la de 1 no tiene.
    tpl.variants["2"].textFields = [...tpl.variants["2"].textFields, { id: "t3", pageIndex: 1, rect: R(0.1, 0.4, 0.3, 0.03), type: "text", label: "Nombre 2", required: false, source: "manual" }];
    const { plan, applied } = appliedTwoSigners({ tpl });
    const doc = docStateOf(applied.docs, "doc-1");
    const extra = doc.textFields.find((f) => f.rect.y === 0.4)!;
    const common = doc.textFields.find((f) => f.id !== extra.id)!;
    const typed = { ...applied, docs: { "doc-1": { ...doc, textValues: { [extra.id]: "Marta", [common.id]: "Contrato 7" } } } };
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: typed, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.loss.values).toBe(1);
    expect(docStateOf(down.patch.docs!, "doc-1").textFields.map((f) => f.id)).toContain(common.id);
    // Un valor vacio no es trabajo.
    const empty = { ...typed, docs: { "doc-1": { ...doc, textValues: { [extra.id]: "  " } } } };
    expect(planTemplateApplication({ template: tpl, match: null, count: 1, session: empty, docId: "doc-1", pageCount: 3, mint, previous: plan.record }).loss.values).toBe(0);
  });

  it("subir de 1 a 2 firmantes no quita nada (solo se anade el segundo)", () => {
    const one = planTemplateApplication({ template: template(3), match: null, count: 1, session: session(), docId: "doc-1", pageCount: 3, mint });
    const applied = session({ ...one.patch, mode: "multi", blocks: [strokesFor(one.patch.signers![0].id)] });
    const up = planTemplateApplication({ template: template(3), match: null, count: 2, session: applied, docId: "doc-1", pageCount: 3, mint, previous: one.record });
    expect(up.loss).toEqual(NO_LOSS);
    expect(up.patch.signers).toHaveLength(2);
  });

  it("el automapeo tambien informa de la perdida al bajar de 2 a 1 firmantes", () => {
    const auto = (fields: AutoField[]): AutoMapResult => ({ fields, pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] });
    const f = (id: string, signerIndex: 0 | 1): AutoField => ({ id, pageIndex: 0, rect: R(0.1, 0.1 + signerIndex * 0.2, 0.2, 0.04), type: "signature", signerIndex, confidence: 0.9, tier: "high", reason: "r", source: "label" });
    const result = auto([f("a", 0), f("b", 1)]);
    const roles = [{ label: "Asegurado" }, { label: "Co-asegurado" }];
    const first = planAutoMapApplication({ result, count: 2, session: session(), docId: "doc-1", roles, mint });
    const applied = session({ ...first.patch, mode: "multi", blocks: [strokesFor(first.patch.signers![1].id)] });
    const down = planAutoMapApplication({ result, count: 1, session: applied, docId: "doc-1", roles, mint, previous: first.record });
    expect(down.loss.signers.map((s) => s.name)).toEqual(["Co-asegurado"]);
    const clean = planAutoMapApplication({ result, count: 1, session: session({ ...first.patch, mode: "multi" }), docId: "doc-1", roles, mint, previous: first.record });
    expect(clean.loss).toEqual(NO_LOSS);
  });
});

describe("Deshacer solo revierte lo que puso la plantilla", () => {
  it("undoWork: nada que perder con nombres genericos y sin trazos ni valores", () => {
    const { plan, applied } = appliedTwoSigners();
    expect(undoWork(applied, "doc-1", plan.record)).toEqual(NO_LOSS);
  });

  it("undoWork: trazos de un firmante creado por la plantilla, nombre escrito y valores escritos en sus campos", () => {
    const { plan, applied } = appliedTwoSigners();
    const second = applied.signers[1];
    expect(undoWork({ ...applied, blocks: [strokesFor(second.id)] }, "doc-1", plan.record).signers).toEqual([{ id: second.id, name: "Co-asegurado", strokes: true }]);
    expect(undoWork({ ...applied, signers: applied.signers.map((s, i) => (i === 0 ? { ...s, name: "Ana" } : s)) }, "doc-1", plan.record).signers).toEqual([{ id: applied.signers[0].id, name: "Ana", strokes: false }]);
    const doc = docStateOf(applied.docs, "doc-1");
    const textId = plan.record.textFieldIds[0];
    expect(undoWork({ ...applied, docs: { "doc-1": { ...doc, textValues: { [textId]: "Mold" } } } }, "doc-1", plan.record).values).toBe(1);
  });

  it("undoWork: un firmante que ya estaba antes (no lo creo la plantilla) no cuenta: Deshacer no lo toca", () => {
    const ana = { id: "sg-ana", name: "Ana", color: "#000" };
    const plan = planTemplateApplication({ template: template(2), match: null, count: 1, session: session({ mode: "multi", signers: [ana] }), docId: "doc-1", pageCount: 2, mint });
    const applied = session({ ...plan.patch, blocks: [strokesFor("sg-ana")] });
    expect(undoWork(applied, "doc-1", plan.record)).toEqual(NO_LOSS);
    const undone = planUndo(applied, "doc-1", plan.record);
    expect(undone.signers!.map((s) => s.id)).toEqual(["sg-ana"]);
    expect(undone.blocks!.find((b) => b.signerId === "sg-ana")?.signature).toEqual(DRAFT);
  });

  it("con campos de plantilla en OTRO documento Deshacer no retira a los firmantes (los usa): sus trazos no estan en riesgo", () => {
    const { plan, applied } = appliedTwoSigners();
    const [, second] = applied.signers;
    const other = { ...EMPTY_DOC_STATE, fields: [{ id: "f-otro", signerId: second.id, pageIndex: 0, type: "signature" as const, rect: R(0.1, 0.1, 0.2, 0.05) }] };
    const shared = { ...applied, docOrder: ["doc-1", "doc-2"], docs: { ...applied.docs, "doc-2": other }, blocks: [strokesFor(second.id)] };
    // Los firmantes no se retiran con otro documento tocado: lo unico en riesgo serian valores escritos (aqui, ninguno).
    expect(undoWork(shared, "doc-1", plan.record)).toEqual(NO_LOSS);
    const undone = planUndo(shared, "doc-1", plan.record);
    expect(undone.signers!.map((s) => s.id)).toEqual(applied.signers.map((s) => s.id));
    expect(undone.mode).toBe("multi");
    expect(undone.blocks!.find((b) => b.signerId === second.id)?.signature).toEqual(DRAFT);
  });

  it("planUndo no quita un firmante creado por la plantilla que ya tiene trazos o un nombre escrito, ni cambia el modo", () => {
    const { plan, applied } = appliedTwoSigners();
    const [a, b] = applied.signers;
    const withWork = { ...applied, blocks: [strokesFor(b.id)], signers: applied.signers.map((s) => (s.id === a.id ? { ...s, name: "Ana López" } : s)) };
    const undone = planUndo(withWork, "doc-1", plan.record);
    expect(undone.signers!.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(undone.signers![0].name).toBe("Ana López");
    expect(undone.mode).toBe("multi");
    expect(undone.blocks!.find((block) => block.signerId === b.id)?.signature).toEqual(DRAFT);
    // Los campos de la plantilla si se retiran.
    expect(docStateOf(undone.docs!, "doc-1").fields).toEqual([]);
  });

  it("planUndo conserva los valores escritos y solo borra los vacios", () => {
    const { plan, applied } = appliedTwoSigners();
    const doc = docStateOf(applied.docs, "doc-1");
    const [t1, t2] = plan.record.textFieldIds;
    const typed = { ...applied, docs: { "doc-1": { ...doc, textValues: { [t1]: "Mold", [t2]: "   " } } } };
    const undone = planUndo(typed, "doc-1", plan.record);
    const values = docStateOf(undone.docs!, "doc-1").textValues;
    expect(values[t1]).toBe("Mold");
    expect(t2 in values).toBe(false);
  });

  it("planUndo sin trabajo sigue retirando los firmantes creados y devolviendo «Solo yo» (la regla de siempre)", () => {
    const { plan, applied } = appliedTwoSigners();
    const undone = planUndo(applied, "doc-1", plan.record);
    expect(undone.signers).toEqual([]);
    expect(undone.mode).toBe("single");
  });
});

/* ------------------------------------------------------------------ *
 * F2 (2ª ronda): las firmas del que se queda sobreviven al cambio de variante (F1), aplicar lo guardado no duplica
 * (F2), un firmante que otro documento usa no se retira (F3) y el trabajo con solo iniciales cuenta (F4)
 * ------------------------------------------------------------------ */

const FILE_KEY = "fp-doc-1";
/** El bloque de un firmante con su firma e iniciales y un sello VIGENTE (el que dejaria la ceremonia sobre estos huecos). */
function signedBlock(sess: Pick<SignSession, "signers" | "docs">, signerId: string, docId = "doc-1", key = FILE_KEY): SignerBlock {
  const fields = liveFields(docStateOf(sess.docs, docId), sess.signers);
  return { id: `bk-${signerId}`, signerId, appliesTo: [docId], signature: DRAFT, initials: DRAFT, stamps: { [docId]: captureStamp(key, fields, signerId) }, auto: true };
}
const withBlocks = (sess: SignSession, signerIds: string[], docId = "doc-1", key = FILE_KEY): SignSession => ({
  ...sess,
  blocks: [...sess.blocks.filter((b) => !signerIds.includes(b.signerId)), ...signerIds.map((id) => signedBlock(sess, id, docId, key))],
});
const stampOf = (blocks: readonly SignerBlock[] | undefined, signerId: string, docId = "doc-1") => blocks?.find((b) => b.signerId === signerId)?.stamps[docId];
const currentStamp = (sess: Pick<SignSession, "signers" | "docs">, signerId: string, docId = "doc-1", key = FILE_KEY) =>
  captureStamp(key, liveFields(docStateOf(sess.docs, docId), sess.signers), signerId);
const after = (sess: SignSession, patch: Partial<SignSession>): SignSession => ({ ...sess, ...patch });

describe("F1 · las firmas del firmante que se queda sobreviven al cambio de variante", () => {
  it("2 → 1 con huecos de iniciales DISTINTOS: la firma del firmante 1 sigue vigente (el sello solo lleva la huella del documento)", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const [ana, luis] = applied.signers;
    const signed = withBlocks(applied, [ana.id, luis.id]);
    const stampBefore = stampOf(signed.blocks, ana.id);
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: signed, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    const next = after(signed, down.patch);
    // Los huecos de iniciales del firmante 1 SI cambiaron de tamano (esa es la premisa)…
    const before = docStateOf(signed.docs, "doc-1").fields.filter((f) => f.signerId === ana.id && f.type === "initials");
    const now = docStateOf(next.docs, "doc-1").fields.filter((f) => f.signerId === ana.id && f.type === "initials");
    expect(now[0].rect.width).not.toBe(before[0].rect.width);
    // …y aun asi su sello coincide con el de AHORA (vigente) y con el de antes: los huecos ya no entran en el sello.
    expect(stampOf(down.patch.blocks, ana.id)).toBe(currentStamp(next, ana.id));
    expect(stampOf(down.patch.blocks, ana.id)).toBe(FILE_KEY);
    expect(stampBefore?.split("~")[0]).toBe(FILE_KEY);
    expect(down.patch.blocks!.find((b) => b.signerId === ana.id)).toMatchObject({ signature: DRAFT, initials: DRAFT });
    // Lo que se pierde es solo el firmante 2.
    expect(down.loss.signers.map((s) => s.name)).toEqual(["Co-asegurado"]);
  });

  it("1 → 2 con la firma del firmante 1 ya recogida: sigue vigente sin pedir nada (y el 2 nace sin firma)", () => {
    const one = planTemplateApplication({ template: template(3), match: null, count: 1, session: session(), docId: "doc-1", pageCount: 3, mint });
    const applied = after(session(), { ...one.patch, mode: "multi" });
    const signed = withBlocks(applied, [applied.signers[0].id]);
    const up = planTemplateApplication({ template: template(3), match: null, count: 2, session: signed, docId: "doc-1", pageCount: 3, mint, previous: one.record });
    const next = after(signed, up.patch);
    expect(up.loss).toEqual(NO_LOSS);
    expect(stampOf(up.patch.blocks, signed.signers[0].id)).toBe(currentStamp(next, signed.signers[0].id));
    expect(up.patch.blocks!.find((b) => b.signerId === signed.signers[0].id)?.signature).toEqual(DRAFT);
    const second = up.patch.signers![1];
    expect(up.patch.blocks!.find((b) => b.signerId === second.id)).toMatchObject({ signature: null, initials: null });
  });

  it("ids estables por rol, pagina y tipo: el hueco que cambia de tamano o de sitio conserva el id del firmante que se queda", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const ana = applied.signers[0];
    const idsBefore = docStateOf(applied.docs, "doc-1").fields.filter((f) => f.signerId === ana.id).map((f) => `${f.pageIndex}|${f.type}|${f.id}`).sort();
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: applied, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    const idsAfter = docStateOf(down.patch.docs!, "doc-1").fields.filter((f) => f.signerId === ana.id).map((f) => `${f.pageIndex}|${f.type}|${f.id}`).sort();
    expect(idsAfter).toEqual(idsBefore);
  });

  it("una firma de OTRO archivo (que ya no valia antes) NO se revalida con el cambio", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const [ana] = applied.signers;
    const stale: SignerBlock = { ...signedBlock(applied, ana.id), stamps: { "doc-1": "otro-archivo~algun-hueco-que-ya-no-esta" } };
    const staleSession = { ...applied, blocks: [...applied.blocks.filter((b) => b.signerId !== ana.id), stale] };
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: staleSession, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    // Sigue atada al OTRO archivo (no se re-sella con el de ahora), asi que sigue caducada.
    expect(stampOf(down.patch.blocks, ana.id)?.split("~")[0]).toBe("otro-archivo");
  });

  it("conserva la huella del documento del sello (incluidas las ediciones de texto): no tapa otro motivo de caducidad", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const [ana] = applied.signers;
    const signed = withBlocks(applied, [ana.id], "doc-1", "fp-doc-1+t2");
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: signed, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(stampOf(down.patch.blocks, ana.id)?.split("~")[0]).toBe("fp-doc-1+t2");
    expect(stampOf(down.patch.blocks, ana.id)).toBe(currentStamp(after(signed, down.patch), ana.id, "doc-1", "fp-doc-1+t2"));
  });

  it("varios documentos: solo se rehace el sello del documento que cambio; el de los demas no se toca", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const [ana] = applied.signers;
    const other = { ...EMPTY_DOC_STATE };
    const two = after(applied, { docOrder: ["doc-1", "doc-2"], docs: { ...applied.docs, "doc-2": other } });
    const block: SignerBlock = { ...signedBlock(two, ana.id), appliesTo: ["doc-1", "doc-2"], stamps: { "doc-1": currentStamp(two, ana.id), "doc-2": "fp-doc-2~x" } };
    const signed = { ...two, blocks: [...two.blocks.filter((b) => b.signerId !== ana.id), block] };
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: signed, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(stampOf(down.patch.blocks, ana.id, "doc-1")).toBe(currentStamp(after(signed, down.patch), ana.id));
    expect(stampOf(down.patch.blocks, ana.id, "doc-2")).toBe("fp-doc-2~x");
    expect(Object.keys(down.patch.blocks!.find((b) => b.signerId === ana.id)!.stamps).sort()).toEqual(["doc-1", "doc-2"]);
  });

  it("solo iniciales recogidas (sin firma) tambien se conservan", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const [ana] = applied.signers;
    const signed = withBlocks(applied, [ana.id]);
    const initialsOnly = { ...signed, blocks: signed.blocks.map((b) => (b.signerId === ana.id ? { ...b, signature: null } : b)) };
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: initialsOnly, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(stampOf(down.patch.blocks, ana.id)).toBe(currentStamp(after(initialsOnly, down.patch), ana.id));
  });

  it("el automapeo tambien conserva las firmas del firmante que se queda (huecos de 1 y de 2 distintos)", () => {
    const auto = (fields: AutoField[]): AutoMapResult => ({ fields, pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] });
    const f = (id: string, signerIndex: 0 | 1, rect: ReturnType<typeof R>): AutoField => ({ id, pageIndex: 0, rect, type: "initials", signerIndex, confidence: 0.9, tier: "high", reason: "r", source: "label" });
    const roles = [{ label: "Asegurado" }, { label: "Co-asegurado" }];
    const two = auto([f("a", 0, R(0.74, 0.885, 0.0585, 0.045)), f("b", 1, R(0.81, 0.885, 0.0585, 0.045))]);
    const one = auto([f("a", 0, R(0.74, 0.885, 0.13, 0.045))]);
    const first = planAutoMapApplication({ result: two, count: 2, session: session(), docId: "doc-1", roles, mint });
    const applied = after(session(), { ...first.patch, mode: "multi" });
    const signed = withBlocks(applied, applied.signers.map((s) => s.id));
    const down = planAutoMapApplication({ result: one, count: 1, session: signed, docId: "doc-1", roles, mint, previous: first.record });
    const next = after(signed, down.patch);
    expect(stampOf(down.patch.blocks, signed.signers[0].id)).toBe(currentStamp(next, signed.signers[0].id));
    expect(down.loss.signers.map((s) => s.name)).toEqual(["Co-asegurado"]);
    // 1 → 2 con el automapeo: lo mismo en sentido contrario.
    const back = after(next, { blocks: withBlocks(next, [signed.signers[0].id]).blocks });
    const up = planAutoMapApplication({ result: two, count: 2, session: back, docId: "doc-1", roles, mint, previous: down.record });
    expect(stampOf(up.patch.blocks, signed.signers[0].id)).toBe(currentStamp(after(back, up.patch), signed.signers[0].id));
  });
});

describe("F2 · aplicar una plantilla guardada sobre un documento con trabajo no duplica ni invalida", () => {
  it("sin registro previo y con `replaceDocument`: los 14 campos de la plantilla se reconocen por su sitio, no pasan a 28 y los sellos siguen vigentes", () => {
    const { tpl, applied } = appliedTwoSigners();
    const doc = docStateOf(applied.docs, "doc-1");
    // Como un borrador restaurado: los mismos campos pero sin ningun registro del aviso.
    const signed = withBlocks(applied, applied.signers.map((s) => s.id));
    const again = planTemplateApplication({ template: tpl, match: null, count: 2, session: signed, docId: "doc-1", pageCount: 3, mint, replaceDocument: true });
    const next = docStateOf(again.patch.docs!, "doc-1");
    expect(next.fields).toHaveLength(doc.fields.length);
    expect(next.fields.map((f) => f.id).sort()).toEqual(doc.fields.map((f) => f.id).sort());
    expect(next.textFields).toHaveLength(doc.textFields.length);
    for (const signer of signed.signers) expect(stampOf(again.patch.blocks, signer.id)).toBe(currentStamp(after(signed, again.patch), signer.id));
    expect(again.record.fieldIds.sort()).toEqual(doc.fields.map((f) => f.id).sort());
    expect(again.loss).toEqual(NO_LOSS);
  });

  it("un campo de la plantilla que cae sobre un AcroForm del PDF no se duplica: el AcroForm adopta su dato y no crece en cada ciclo", () => {
    const { tpl, applied } = appliedTwoSigners();
    const doc = docStateOf(applied.docs, "doc-1");
    const own = doc.textFields.find((f) => f.source === "manual");
    expect(own).toBeTruthy();
    const acro = { ...own!, id: "acro-1", source: "acroform" as const };
    const withAcro = { ...applied, docs: { ...applied.docs, "doc-1": { ...doc, textFields: [...doc.textFields.filter((f) => f.id !== own!.id), acro] } } };
    let session = withBlocks(withAcro, withAcro.signers.map((s) => s.id));
    for (let cycle = 0; cycle < 3; cycle++) {
      const again = planTemplateApplication({ template: tpl, match: null, count: 2, session, docId: "doc-1", pageCount: 3, mint, replaceDocument: true });
      const next = docStateOf(again.patch.docs!, "doc-1");
      expect(next.textFields).toHaveLength(doc.textFields.length);
      expect(next.textFields.filter((f) => f.source === "acroform")).toHaveLength(1);
      session = { ...session, ...again.patch } as typeof session;
    }
  });

  it("sin `replaceDocument` la forma de siempre (sin registro no se reconoce nada); la prueba de arriba falla si se ignora la opcion", () => {
    const { tpl, applied } = appliedTwoSigners();
    const again = planTemplateApplication({ template: tpl, match: null, count: 2, session: applied, docId: "doc-1", pageCount: 3, mint });
    expect(docStateOf(again.patch.docs!, "doc-1").fields).toHaveLength(docStateOf(applied.docs, "doc-1").fields.length * 2);
  });

  it("un campo que la persona movio en el editor SE REEMPLAZA (mismo id, sitio nuevo), no se queda el viejo ademas del nuevo", () => {
    const { tpl, applied } = appliedTwoSigners();
    const doc = docStateOf(applied.docs, "doc-1");
    const moved = JSON.parse(JSON.stringify(tpl)) as DocTemplate;
    const target = moved.variants["2"].fields.find((f) => f.type === "signature" && f.roleIndex === 0)!;
    target.rect = R(0.12, 0.6, 0.3, 0.05);
    const signed = withBlocks(applied, applied.signers.map((s) => s.id));
    const again = planTemplateApplication({ template: moved, match: null, count: 2, session: signed, docId: "doc-1", pageCount: 3, mint, replaceDocument: true });
    const next = docStateOf(again.patch.docs!, "doc-1");
    expect(next.fields).toHaveLength(doc.fields.length);
    const oldSignature = doc.fields.find((f) => f.type === "signature" && f.signerId === applied.signers[0].id)!;
    const newSignature = next.fields.find((f) => f.type === "signature" && f.signerId === applied.signers[0].id)!;
    expect(newSignature.id).toBe(oldSignature.id);
    expect(newSignature.rect).toEqual(R(0.12, 0.6, 0.3, 0.05));
    // Y la firma del firmante 1, que ya estaba hecha, sigue vigente sobre el hueco nuevo.
    expect(stampOf(again.patch.blocks, applied.signers[0].id)).toBe(currentStamp(after(signed, again.patch), applied.signers[0].id));
  });

  it("los valores escritos en campos de texto que no cambian de sitio se conservan (mismo id)", () => {
    const { tpl, applied } = appliedTwoSigners();
    const doc = docStateOf(applied.docs, "doc-1");
    const typed = after(applied, { docs: { "doc-1": { ...doc, textValues: { [doc.textFields[0].id]: "Mold 7" } } } });
    const again = planTemplateApplication({ template: tpl, match: null, count: 2, session: typed, docId: "doc-1", pageCount: 3, mint, replaceDocument: true });
    const next = docStateOf(again.patch.docs!, "doc-1");
    expect(next.textFields.map((f) => f.id)).toEqual(doc.textFields.map((f) => f.id));
    expect(again.loss.values).toBe(0);
  });

  it("no toca los campos de firmantes que la plantilla no cubre ni los de deteccion automatica (AcroForm)", () => {
    const { tpl, applied } = appliedTwoSigners();
    const doc = docStateOf(applied.docs, "doc-1");
    const third = { id: "fld-3", signerId: "sg-tercero", pageIndex: 0, type: "signature" as const, rect: R(0.3, 0.3, 0.2, 0.05) };
    const acro = { id: "acro-1", pageIndex: 1, rect: R(0.1, 0.1, 0.2, 0.03), source: "acroform" as const, confidence: "high" as const };
    const crowded = after(applied, { signers: [...applied.signers, { id: "sg-tercero", name: "Tercero", color: "#000" }], docs: { "doc-1": { ...doc, fields: [...doc.fields, third], textFields: [...doc.textFields, acro] } } });
    const again = planTemplateApplication({ template: tpl, match: null, count: 2, session: crowded, docId: "doc-1", pageCount: 3, mint, replaceDocument: true });
    const next = docStateOf(again.patch.docs!, "doc-1");
    expect(next.fields.map((f) => f.id)).toContain("fld-3");
    expect(next.textFields.map((f) => f.id)).toContain("acro-1");
    expect(next.fields).toHaveLength(doc.fields.length + 1);
    expect(again.record.fieldIds).not.toContain("fld-3");
    expect(again.record.textFieldIds).not.toContain("acro-1");
  });
});

describe("F3 · un firmante que usa otro documento no se retira", () => {
  const otherWithManual = (signerId: string) => ({ ...EMPTY_DOC_STATE, fields: [{ id: "fld-b", signerId, pageIndex: 0, type: "signature" as const, rect: R(0.5, 0.5, 0.2, 0.05) }] });

  it("bajar el documento A a 1 firmante mantiene al firmante 2 si el documento B tiene campos suyos, y lo dice", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const luis = applied.signers[1];
    const shared = after(applied, { docOrder: ["doc-1", "doc-2"], docs: { ...applied.docs, "doc-2": otherWithManual(luis.id) } });
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: shared, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.patch.signers!.map((s) => s.id)).toEqual(applied.signers.map((s) => s.id));
    expect(down.record.keptSigners).toEqual(["Co-asegurado"]);
    // Los campos del firmante 2 en B siguen siendo suyos y vivos.
    expect(liveFields(docStateOf(down.patch.docs!, "doc-2"), down.patch.signers!)).toHaveLength(1);
    // En A, el firmante 2 ya no tiene campos (la variante de 1 solo tiene al 1).
    expect(docStateOf(down.patch.docs!, "doc-1").fields.every((f) => f.signerId === applied.signers[0].id)).toBe(true);
  });

  it("el firmante que se queda por otro documento no cuenta como perdida aunque tenga trazos", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const luis = applied.signers[1];
    const shared = withBlocks(after(applied, { docOrder: ["doc-1", "doc-2"], docs: { ...applied.docs, "doc-2": otherWithManual(luis.id) } }), [luis.id]);
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: shared, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.loss).toEqual(NO_LOSS);
    expect(down.patch.blocks!.find((b) => b.signerId === luis.id)?.signature).toEqual(DRAFT);
  });

  it("sin campos suyos en otros documentos el firmante creado se retira como siempre (no hay `keptSigners`)", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const shared = after(applied, { docOrder: ["doc-1", "doc-2"], docs: { ...applied.docs, "doc-2": { ...EMPTY_DOC_STATE } } });
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: shared, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.patch.signers).toHaveLength(1);
    expect(down.record.keptSigners).toBeUndefined();
  });

  it("el automapeo aplica la misma regla", () => {
    const auto = (fields: AutoField[]): AutoMapResult => ({ fields, pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] });
    const f = (id: string, signerIndex: 0 | 1): AutoField => ({ id, pageIndex: 0, rect: R(0.1, 0.1 + signerIndex * 0.2, 0.2, 0.04), type: "signature", signerIndex, confidence: 0.9, tier: "high", reason: "r", source: "label" });
    const result = auto([f("a", 0), f("b", 1)]);
    const roles = [{ label: "Asegurado" }, { label: "Co-asegurado" }];
    const first = planAutoMapApplication({ result, count: 2, session: session(), docId: "doc-1", roles, mint });
    const applied = after(session(), { ...first.patch, mode: "multi" });
    const shared = after(applied, { docOrder: ["doc-1", "doc-2"], docs: { ...applied.docs, "doc-2": otherWithManual(applied.signers[1].id) } });
    const down = planAutoMapApplication({ result, count: 1, session: shared, docId: "doc-1", roles, mint, previous: first.record });
    expect(down.patch.signers).toHaveLength(2);
    expect(down.record.keptSigners).toEqual(["Co-asegurado"]);
  });
});

describe("F4 · el trabajo con SOLO iniciales (o solo firma) cuenta", () => {
  it("signerWork: un bloque con solo iniciales recogidas tiene trazos; uno con solo firma tambien; uno vacio no", () => {
    const { plan, applied } = appliedTwoSigners();
    const second = applied.signers[1];
    const block = (over: Partial<SignerBlock>): SignerBlock => ({ id: "bk-x", signerId: second.id, appliesTo: ["doc-1"], signature: null, initials: null, stamps: {}, auto: true, ...over });
    expect(signerWork({ blocks: [block({ initials: DRAFT })] }, second, plan.record).strokes).toBe(true);
    expect(signerWork({ blocks: [block({ signature: DRAFT })] }, second, plan.record).strokes).toBe(true);
    expect(signerWork({ blocks: [block({})] }, second, plan.record).strokes).toBe(false);
  });

  it("2 → 1 con solo las iniciales del firmante 2 recogidas: la perdida lo nombra, sin nombre real escrito", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const luis = applied.signers[1];
    const initialsOnly = after(applied, { blocks: [{ ...signedBlock(applied, luis.id), signature: null }] });
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: initialsOnly, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.loss.signers).toEqual([{ id: luis.id, name: "Co-asegurado", strokes: true }]);
    expect(undoWork(initialsOnly, "doc-1", plan.record).signers).toEqual([{ id: luis.id, name: "Co-asegurado", strokes: true }]);
  });
});

describe("identidad de un hueco: firmante + página + tipo", () => {
  const field = (id: string, over: Partial<{ signerId: string; pageIndex: number; type: "signature" | "initials"; rect: ReturnType<typeof R> }> = {}) => ({ id, signerId: "s1", pageIndex: 0, type: "initials" as const, rect: R(0.1, 0.1, 0.1, 0.1), ...over });

  it("reuseFieldIdsByRole: el hueco que cambio de sitio o tamano conserva el id del MISMO firmante, pagina y tipo", () => {
    const old = [field("a"), field("b", { type: "signature" })];
    const next = reuseFieldIdsByRole(old, [field("n1", { type: "signature", rect: R(0.5, 0.5, 0.3, 0.05) }), field("n2", { rect: R(0.2, 0.2, 0.3, 0.3) })]);
    expect(next.map((f) => [f.type, f.id])).toEqual([["signature", "b"], ["initials", "a"]]);
    expect(next[0].rect).toEqual(R(0.5, 0.5, 0.3, 0.05));
  });

  it("reuseFieldIdsByRole: no cruza firmantes, paginas ni tipos, y un id solo se reutiliza una vez", () => {
    const old = [field("a")];
    expect(reuseFieldIdsByRole(old, [field("n", { signerId: "s2" })])[0].id).toBe("n");
    expect(reuseFieldIdsByRole(old, [field("n", { pageIndex: 1 })])[0].id).toBe("n");
    expect(reuseFieldIdsByRole(old, [field("n", { type: "signature" })])[0].id).toBe("n");
    expect(reuseFieldIdsByRole(old, [field("n1"), field("n2")]).map((f) => f.id)).toEqual(["a", "n2"]);
  });

  it("reuseFieldIdsByRole: lo que ya reutilizo `reuseFieldIds` (mismo sitio) no se vuelve a repartir", () => {
    const old = [field("a"), field("b", { pageIndex: 0 })];
    const exact = reuseFieldIds(old, [field("n1", { rect: R(0.1, 0.1, 0.1, 0.1) }), field("n2", { rect: R(0.4, 0.4, 0.1, 0.1) })]);
    expect(exact.map((f) => f.id)).toEqual(["a", "n2"]);
    expect(reuseFieldIdsByRole(old, exact).map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("restampKeptSigners: sin sello en el documento, sin trazos o de un firmante que se fue, el bloque queda igual", () => {
    const { applied } = appliedTwoSigners();
    const [ana] = applied.signers;
    const doc = docStateOf(applied.docs, "doc-1");
    const base = signedBlock(applied, ana.id);
    const run = (block: SignerBlock, signers = applied.signers) => restampKeptSigners({ before: applied, docId: "doc-1", nextSigners: signers, nextDoc: { fields: doc.fields.slice(0, 3) }, blocks: [block] })[0];
    expect(run({ ...base, stamps: {} })).toEqual({ ...base, stamps: {} });
    expect(run({ ...base, signature: null, initials: null })).toEqual({ ...base, signature: null, initials: null });
    expect(run(base, [applied.signers[1]])).toBe(base);
    // Con huecos distintos de verdad (se quitan fields) el sello es el mismo: solo lleva la huella del documento.
    expect(run(base).stamps["doc-1"]).toBe(FILE_KEY);
  });
});

describe("F3 (más) · solo cuenta lo que usa el firmante que se retiraría", () => {
  it("campos de OTRO firmante en el documento B no impiden retirar al firmante 2 de A", () => {
    const { tpl, plan, applied } = appliedTwoSigners();
    const ana = applied.signers[0];
    const shared = after(applied, { docOrder: ["doc-1", "doc-2"], docs: { ...applied.docs, "doc-2": { ...EMPTY_DOC_STATE, fields: [{ id: "fld-b", signerId: ana.id, pageIndex: 0, type: "signature" as const, rect: R(0.5, 0.5, 0.2, 0.05) }] } } });
    const down = planTemplateApplication({ template: tpl, match: null, count: 1, session: shared, docId: "doc-1", pageCount: 3, mint, previous: plan.record });
    expect(down.patch.signers!.map((s) => s.id)).toEqual([ana.id]);
    expect(down.record.keptSigners).toBeUndefined();
  });

  it("el automapeo conserva el id del hueco del firmante que se queda cuando cambia de tamano", () => {
    const auto = (fields: AutoField[]): AutoMapResult => ({ fields, pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] });
    const f = (id: string, signerIndex: 0 | 1, rect: ReturnType<typeof R>): AutoField => ({ id, pageIndex: 0, rect, type: "initials", signerIndex, confidence: 0.9, tier: "high", reason: "r", source: "label" });
    const roles = [{ label: "Asegurado" }, { label: "Co-asegurado" }];
    const first = planAutoMapApplication({ result: auto([f("a", 0, R(0.74, 0.885, 0.0585, 0.045)), f("b", 1, R(0.81, 0.885, 0.0585, 0.045))]), count: 2, session: session(), docId: "doc-1", roles, mint });
    const applied = after(session(), { ...first.patch, mode: "multi" });
    const idBefore = docStateOf(applied.docs, "doc-1").fields.find((x) => x.signerId === applied.signers[0].id)!.id;
    const down = planAutoMapApplication({ result: auto([f("a", 0, R(0.74, 0.885, 0.13, 0.045))]), count: 1, session: applied, docId: "doc-1", roles, mint, previous: first.record });
    expect(docStateOf(down.patch.docs!, "doc-1").fields.map((x) => x.id)).toEqual([idBefore]);
  });
});
