import { describe, expect, it } from "vitest";
import type { AutoMapResult } from "@/lib/pdf/autoMapTypes";
import { DEFAULT_ROLES, type TemplateSignField, type Variant } from "@/lib/docLibrary/templateTypes";
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  acceptSuggestion,
  applyDetection,
  canMatchPrevious,
  canvasSigners,
  changeKey,
  commitHistory,
  contentToDraft,
  copyVariant,
  emptyContent,
  ensureIds,
  foldSlots,
  foldTextFields,
  fullRoles,
  initialsBase,
  initialsPages,
  matchPreviousPage,
  newHistory,
  pagesWithFields,
  patchTextField,
  projectVariant,
  redoHistory,
  repeatInitialsIn,
  setRoleLabel,
  undoHistory,
  type EditorContent,
  type Minter,
} from "@/app/sign-pdf/templateEditorModel";

let n = 0;
const mint: Minter = { sign: () => `fld-${(n += 1)}`, text: () => `txt-${(n += 1)}` };
const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const roles = DEFAULT_ROLES.map((role) => ({ ...role }));

function initials(page: number, role: number, rect = R(0.74 + role * 0.07, 0.885, 0.065, 0.045), id = `i-${page}-${role}`): TemplateSignField {
  return { id, roleIndex: role, pageIndex: page, type: "initials", rect, required: true, source: "manual" };
}
function content(variants: Partial<EditorContent["variants"]> = {}): EditorContent {
  return { name: "Contrato", roles, variants: { "1": { fields: [], textFields: [] }, "2": { fields: [], textFields: [] }, ...variants } };
}
const LINE = R(0.74, 0.885, 0.13, 0.045);

describe("historial", () => {
  it("deshace y rehace, y un cambio nuevo borra lo rehacible", () => {
    let h = newHistory("a");
    h = commitHistory(h, "b", { now: 0 });
    h = commitHistory(h, "c", { now: 10_000 });
    expect(h.past).toEqual(["a", "b"]);
    h = undoHistory(h);
    expect(h.present).toBe("b");
    expect(h.future).toEqual(["c"]);
    h = redoHistory(h);
    expect(h.present).toBe("c");
    h = undoHistory(undoHistory(h));
    expect(h.present).toBe("a");
    h = commitHistory(h, "z", { now: 20_000 });
    expect(h.future).toEqual([]);
    expect(undoHistory(newHistory("x")).present).toBe("x");
    expect(redoHistory(newHistory("x")).present).toBe("x");
  });

  it("un valor igual no es un paso", () => {
    const h = newHistory("a");
    expect(commitHistory(h, "a")).toBe(h);
  });

  it("los cambios seguidos del MISMO campo (un arrastre) son un solo paso; con otra clave o tras la ventana, no", () => {
    let h = newHistory(0);
    h = commitHistory(h, 1, { key: "edit:f1", now: 1000 });
    h = commitHistory(h, 2, { key: "edit:f1", now: 1000 + COALESCE_MS - 1 });
    expect(h.past).toEqual([0]);
    expect(h.present).toBe(2);
    h = commitHistory(h, 3, { key: "edit:f2", now: 1100 });
    expect(h.past).toEqual([0, 2]);
    h = commitHistory(h, 4, { key: "edit:f2", now: 1100 + COALESCE_MS + 1 });
    expect(h.past).toEqual([0, 2, 3]);
    h = commitHistory(h, 5, { key: null, now: 1100 + COALESCE_MS + 2 });
    h = commitHistory(h, 6, { key: null, now: 1100 + COALESCE_MS + 3 });
    expect(h.past.length).toBe(5);
  });

  it("recuerda como mucho HISTORY_LIMIT pasos", () => {
    let h = newHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) h = commitHistory(h, i, { now: i * 10_000 });
    expect(h.past.length).toBe(HISTORY_LIMIT);
    expect(h.past[0]).toBe(20);
  });

  it("changeKey: UN campo cambiado es un arrastre; varios, o uno nuevo, no", () => {
    const a: Variant = { fields: [initials(0, 0), initials(1, 0)], textFields: [] };
    const moved: Variant = { fields: [{ ...a.fields[0], rect: R(0.5, 0.5, 0.06, 0.04) }, a.fields[1]], textFields: [] };
    expect(changeKey(a, moved)).toBe("edit:i-0-0");
    expect(changeKey(a, { fields: [...a.fields, initials(2, 0)], textFields: [] })).toBeNull();
    expect(changeKey(a, { fields: a.fields.map((f) => ({ ...f, rect: R(0.1, 0.1, 0.05, 0.05) })), textFields: [] })).toBeNull();
    expect(changeKey(a, a)).toBeNull();
  });
});

describe("roles y contenido", () => {
  it("fullRoles completa un solo rol y respeta el idioma", () => {
    expect(fullRoles([{ key: "signer1", label: "Cliente" }], "es")).toEqual([
      { key: "signer1", label: "Cliente" },
      { key: "signer2", label: "Co-asegurado" },
    ]);
    expect(fullRoles(undefined, "en").map((r) => r.label)).toEqual(["Insured", "Co-insured"]);
    expect(emptyContent("X", "en").roles[1].label).toBe("Co-insured");
  });

  it("ensureIds da id a lo que no lo tiene, cambia los repetidos y los que no son validos", () => {
    const v = ensureIds({ fields: [{ ...initials(0, 0), id: undefined }, initials(1, 0, undefined, "dup"), initials(2, 0, undefined, "dup"), initials(3, 0, undefined, "mal id/!")], textFields: [{ pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), type: "text", label: "", required: false, source: "manual", id: "bad id!" }] }, mint);
    const ids = [...v.fields, ...v.textFields].map((f) => f.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id ?? ""))).toBe(true);
    expect(ids).toContain("dup");
  });

  it("contentToDraft recorta nombres y copia las variantes", () => {
    const c = { ...content({ "2": { fields: [initials(0, 0)], textFields: [] } }), name: "  Mold  ", roles: [{ key: "signer1", label: " A " }, { key: "signer2", label: "B" }] };
    const draft = contentToDraft(c, "doc-1");
    expect(draft.name).toBe("Mold");
    expect(draft.roles?.[0].label).toBe("A");
    expect(draft.documentId).toBe("doc-1");
    expect(draft.variants?.["2"]?.fields?.[0]).not.toBe(c.variants["2"].fields[0]);
    expect(setRoleLabel(c, 1, "Co").roles[1].label).toBe("Co");
    expect(setRoleLabel(c, 2, "Nope")).toBe(c);
  });
});

describe("lienzo <-> variante", () => {
  it("canvasSigners: un rol por firmante de la variante, con la key del rol como id", () => {
    expect(canvasSigners(roles, "1").map((s) => s.id)).toEqual(["signer1"]);
    expect(canvasSigners(roles, "2").map((s) => [s.id, s.name])).toEqual([
      ["signer1", "Asegurado"],
      ["signer2", "Co-asegurado"],
    ]);
    expect(canvasSigners(roles, "2")[0].color).not.toBe(canvasSigners(roles, "2")[1].color);
  });

  it("projectVariant -> foldSlots/foldTextFields sin tocar nada devuelve LOS MISMOS objetos", () => {
    const variant: Variant = {
      fields: [initials(0, 0), initials(0, 1), { ...initials(1, 0), type: "signature", id: "s1" }],
      textFields: [{ id: "t1", pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.03), type: "date", label: "Fecha", dataKey: "today", rule: "today", required: false, source: "auto", confidence: 0.8 }],
    };
    const view = projectVariant(variant, roles);
    expect(view.slots.map((s) => [s.id, s.signerId])).toEqual([["i-0-0", "signer1"], ["i-0-1", "signer2"], ["s1", "signer1"]]);
    expect(view.textFields[0]).toMatchObject({ id: "t1", type: "date", label: "Fecha", source: "manual" });
    const same = foldSlots(variant, view.slots, roles);
    expect(same.fields[0]).toBe(variant.fields[0]);
    expect(foldTextFields(variant, view.textFields).textFields[0]).toBe(variant.textFields[0]);
  });

  it("mover un campo automatico lo hace manual y quita la confianza; uno manual no cambia de origen", () => {
    const auto: TemplateSignField = { ...initials(0, 0), source: "auto", confidence: 0.9, needsReview: true };
    const variant: Variant = { fields: [auto, initials(1, 0)], textFields: [] };
    const view = projectVariant(variant, roles);
    const moved = foldSlots(variant, view.slots.map((s) => (s.id === "i-0-0" ? { ...s, rect: R(0.5, 0.5, 0.06, 0.04) } : s)), roles);
    expect(moved.fields[0]).toMatchObject({ source: "manual", rect: R(0.5, 0.5, 0.06, 0.04) });
    expect(moved.fields[0].confidence).toBeUndefined();
    expect(moved.fields[0].needsReview).toBeUndefined();
    expect(moved.fields[1]).toBe(variant.fields[1]);
  });

  it("un hueco nuevo del lienzo entra como manual y requerido; uno de un firmante desconocido se descarta", () => {
    const variant: Variant = { fields: [], textFields: [] };
    const out = foldSlots(variant, [
      { id: "n1", signerId: "signer2", pageIndex: 2, type: "signature", rect: R(0.1, 0.1, 0.2, 0.05) },
      { id: "n2", signerId: "ghost", pageIndex: 2, type: "signature", rect: R(0.1, 0.1, 0.2, 0.05) },
    ], roles);
    expect(out.fields).toEqual([{ id: "n1", roleIndex: 1, pageIndex: 2, type: "signature", rect: R(0.1, 0.1, 0.2, 0.05), required: true, source: "manual" }]);
  });

  it("un campo de texto que CAMBIA a fecha estrena la regla «hoy» (y uno con origen propio lo conserva)", () => {
    const text = { id: "t1", pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), type: "text" as const, label: "Cuando", required: false, source: "manual" as const };
    const variant: Variant = { fields: [], textFields: [text] };
    const asDate = (field: Variant["textFields"][number]) => ({ id: field.id!, pageIndex: 0, rect: field.rect, label: field.label, source: "manual" as const, confidence: "high" as const, type: "date" as const });
    expect(foldTextFields(variant, [asDate(text)]).textFields[0]).toMatchObject({ type: "date", rule: "today", dataKey: "today" });
    const withKey = { ...text, dataKey: "lossDate" };
    const kept = foldTextFields({ fields: [], textFields: [withKey] }, [asDate(withKey)]).textFields[0];
    expect(kept).toMatchObject({ type: "date", dataKey: "lossDate" });
    expect(kept.rule).toBeUndefined();
  });

  it("un campo de texto nuevo de tipo fecha estrena la regla «hoy»; dejar de ser fecha la quita", () => {
    const base: Variant = { fields: [], textFields: [] };
    const created = foldTextFields(base, [{ id: "t1", pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), source: "manual", confidence: "high", type: "date" }]);
    expect(created.textFields[0]).toMatchObject({ type: "date", rule: "today", dataKey: "today", required: false, source: "manual" });
    const back = foldTextFields(created, [{ id: "t1", pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), source: "manual", confidence: "high" }]);
    expect(back.textFields[0].rule).toBeUndefined();
    expect(back.textFields[0].dataKey).toBeUndefined();
    expect(back.textFields[0].type).toBe("text");
  });

  it("patchTextField: etiqueta, origen del dato y regla; vaciar el origen lo quita", () => {
    const c = content({ "2": { fields: [], textFields: [{ id: "t1", pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), type: "date", label: "", required: false, source: "auto", confidence: 0.7 }] } });
    const patched = patchTextField(c, "2", "t1", { label: "Fecha de firma", dataKey: "today", rule: "today" });
    expect(patched.variants["2"].textFields[0]).toMatchObject({ label: "Fecha de firma", dataKey: "today", rule: "today", source: "manual" });
    const cleared = patchTextField(patched, "2", "t1", { dataKey: null, rule: null });
    expect(cleared.variants["2"].textFields[0].dataKey).toBeUndefined();
    expect(cleared.variants["2"].textFields[0].rule).toBeUndefined();
    expect(patchTextField(c, "2", "t1", { label: "x".repeat(300) }).variants["2"].textFields[0].label.length).toBe(120);
    expect(patchTextField(c, "2", "otro", { label: "x" }).variants["2"].textFields[0].label).toBe("");
  });
});

describe("iniciales en todas las paginas", () => {
  it("2 firmantes: la linea se parte en dos, el firmante 1 a la IZQUIERDA, en todas las paginas", () => {
    const c = content({ "2": { fields: [initials(0, 0, LINE, "base")], textFields: [] } });
    const out = repeatInitialsIn(c, "2", { basePage: 0, pageCount: 6 });
    if ("error" in out) throw new Error(out.error);
    expect(out.pages).toEqual([0, 1, 2, 3, 4, 5]);
    const fields = out.content.variants["2"].fields;
    expect(fields).toHaveLength(12);
    for (let page = 0; page < 6; page += 1) {
      const left = fields.find((f) => f.pageIndex === page && f.roleIndex === 0)!;
      const right = fields.find((f) => f.pageIndex === page && f.roleIndex === 1)!;
      expect(left.rect.x).toBeLessThan(right.rect.x);
      expect(left.rect.x + left.rect.width).toBeLessThanOrEqual(right.rect.x);
      expect(left.rect.y).toBe(right.rect.y);
      expect(right.rect.x + right.rect.width).toBeCloseTo(LINE.x + LINE.width, 5);
    }
    expect(out.content.layout).toMatchObject({ fromPage: 0, toPage: "all", base: LINE });
  });

  it("1 firmante: las iniciales ocupan la linea entera; repetir de nuevo no duplica", () => {
    const c = content({ "1": { fields: [initials(0, 0, LINE, "base")], textFields: [] } });
    const first = repeatInitialsIn(c, "1", { basePage: 0, pageCount: 4 });
    if ("error" in first) throw new Error(first.error);
    expect(first.content.variants["1"].fields.map((f) => f.rect.width)).toEqual([LINE.width, LINE.width, LINE.width, LINE.width]);
    const again = repeatInitialsIn(first.content, "1", { basePage: 1, pageCount: 4 });
    if ("error" in again) throw new Error(again.error);
    expect(again.content.variants["1"].fields).toHaveLength(4);
  });

  it("repetir DESDE la pagina de 2 mitades da la misma linea (idempotente)", () => {
    const c = content({ "2": { fields: [initials(0, 0, LINE, "base")], textFields: [] } });
    const first = repeatInitialsIn(c, "2", { basePage: 0, pageCount: 3 });
    if ("error" in first) throw new Error(first.error);
    expect(initialsBase(first.content.variants["2"], 2, 2)).toEqual(expect.objectContaining({ x: LINE.x }));
    const second = repeatInitialsIn(first.content, "2", { basePage: 2, pageCount: 3 });
    if ("error" in second) throw new Error(second.error);
    expect(second.content.variants["2"].fields.map((f) => [f.pageIndex, f.roleIndex, f.rect.x])).toEqual(first.content.variants["2"].fields.map((f) => [f.pageIndex, f.roleIndex, f.rect.x]));
  });

  it("un rango «de la N a la M» solo toca esas paginas", () => {
    const c = content({ "2": { fields: [initials(0, 0, LINE, "base")], textFields: [] } });
    const out = repeatInitialsIn(c, "2", { basePage: 0, fromPage: 2, toPage: 4, pageCount: 8 });
    if ("error" in out) throw new Error(out.error);
    expect(initialsPages(out.content.variants["2"], 2)).toEqual([0, 2, 3, 4]);
  });

  it("errores: sin linea colocada, rango invertido o fuera del documento", () => {
    const empty = content();
    expect(repeatInitialsIn(empty, "2", { basePage: 0, pageCount: 3 })).toEqual({ error: "noBase" });
    const c = content({ "2": { fields: [initials(0, 0, LINE, "base")], textFields: [] } });
    expect(repeatInitialsIn(c, "2", { basePage: 0, fromPage: 3, toPage: 1, pageCount: 6 })).toEqual({ error: "range" });
    expect(repeatInitialsIn(c, "2", { basePage: 0, fromPage: 9, toPage: "all", pageCount: 6 })).toEqual({ error: "range" });
  });

  it("no toca firmas, textos ni las iniciales de otro rol de la variante de 1 firmante", () => {
    const sign: TemplateSignField = { id: "s1", roleIndex: 0, pageIndex: 3, type: "signature", rect: R(0.1, 0.5, 0.3, 0.05), required: true, source: "manual" };
    const text = { id: "t1", pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), type: "text" as const, label: "N", required: false, source: "manual" as const };
    const c = content({ "2": { fields: [initials(0, 0, LINE, "base"), sign], textFields: [text] } });
    const out = repeatInitialsIn(c, "2", { basePage: 0, pageCount: 4 });
    if ("error" in out) throw new Error(out.error);
    expect(out.content.variants["2"].fields.find((f) => f.id === "s1")).toEqual(sign);
    expect(out.content.variants["2"].textFields).toEqual([text]);
  });

  it("«Igualar a la pagina anterior» copia posiciones y reemplaza las de la pagina; sin iniciales antes, nada", () => {
    const c = content({ "2": { fields: [initials(0, 0, R(0.7, 0.88, 0.06, 0.04), "a"), initials(0, 1, R(0.78, 0.88, 0.06, 0.04), "b"), initials(1, 0, R(0.5, 0.5, 0.06, 0.04), "c")], textFields: [] } });
    expect(canMatchPrevious(c, "2", 1)).toBe(true);
    expect(canMatchPrevious(c, "2", 0)).toBe(false);
    expect(canMatchPrevious(c, "2", 2)).toBe(true);
    const out = matchPreviousPage(c, "2", 1)!;
    const page1 = out.variants["2"].fields.filter((f) => f.pageIndex === 1);
    expect(page1.map((f) => [f.roleIndex, f.rect.x])).toEqual([[0, 0.7], [1, 0.78]]);
    expect(matchPreviousPage(c, "2", 0)).toBeNull();
    expect(matchPreviousPage(content(), "2", 3)).toBeNull();
  });
});

describe("copiar de una variante a otra", () => {
  it("1 -> 2: las iniciales se reparten en dos mitades y la firma pasa tal cual", () => {
    const sign: TemplateSignField = { id: "s1", roleIndex: 0, pageIndex: 2, type: "signature", rect: R(0.1, 0.5, 0.3, 0.05), required: true, source: "manual" };
    const c = content({ "1": { fields: [initials(0, 0, LINE, "a"), initials(1, 0, LINE, "b"), sign], textFields: [] } });
    const out = copyVariant(c, "1", "2", 3)!;
    const v2 = out.variants["2"];
    expect(v2.fields.filter((f) => f.type === "initials")).toHaveLength(4);
    expect(v2.fields.filter((f) => f.type === "initials" && f.roleIndex === 1).every((f) => f.rect.x > LINE.x + LINE.width / 2 - 1e-9)).toBe(true);
    expect(v2.fields.find((f) => f.type === "signature")).toMatchObject({ pageIndex: 2, roleIndex: 0 });
  });

  it("las iniciales de paginas que el documento no tiene no se copian", () => {
    const c = content({ "1": { fields: [initials(0, 0, LINE, "a"), initials(5, 0, LINE, "far")], textFields: [] } });
    const out = copyVariant(c, "1", "2", 3)!;
    expect([...new Set(out.variants["2"].fields.map((f) => f.pageIndex))]).toEqual([0]);
  });

  it("2 -> 1: solo lo del firmante 1; las iniciales vuelven a la linea entera; sin origen, nada", () => {
    const c = content({
      "2": {
        fields: [initials(0, 0, R(0.74, 0.885, 0.06, 0.045), "a"), initials(0, 1, R(0.81, 0.885, 0.06, 0.045), "b"), { id: "s2", roleIndex: 1, pageIndex: 1, type: "signature", rect: R(0.5, 0.5, 0.3, 0.05), required: true, source: "manual" }],
        textFields: [{ id: "t", pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03), type: "text", label: "Co", required: false, source: "manual", dataKey: "insuredName2" }],
      },
    });
    const out = copyVariant(c, "2", "1", 3)!;
    expect(out.variants["1"].fields.map((f) => [f.type, f.roleIndex])).toEqual([["initials", 0]]);
    expect(out.variants["1"].fields[0].rect.width).toBeCloseTo(0.13, 5);
    expect(out.variants["1"].textFields).toHaveLength(0);
    expect(copyVariant(content(), "1", "2", 3)).toBeNull();
    expect(copyVariant(c, "2", "2", 3)).toBeNull();
  });
});

describe("detectar campos", () => {
  const field = (id: string, over: Partial<AutoMapResult["fields"][number]>): AutoMapResult["fields"][number] => ({
    id, pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.04), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "r", source: "label", ...over,
  });
  const result = (fields: AutoMapResult["fields"]): AutoMapResult => ({ fields, pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] });

  it("coloca los de confianza alta y deja los de revision como sugerencias", () => {
    const out = applyDetection(content(), "2", result([field("am-0-1", {}), field("am-0-2", { signerIndex: 1, rect: R(0.4, 0.1, 0.2, 0.04) }), field("am-1-1", { tier: "review", pageIndex: 1, confidence: 0.5 }), field("am-2-1", { tier: "ignore" })]));
    expect(out.placed).toBe(2);
    expect(out.suggested).toBe(1);
    expect(out.content.variants["2"].fields.map((f) => f.roleIndex).sort()).toEqual([0, 1]);
    expect(out.suggestions[0]).toMatchObject({ variant: "2", field: { kind: "sign" } });
    expect(out.suggestions[0].field.value.needsReview).toBe(true);
  });

  it("no duplica lo que la persona ya puso en el mismo sitio", () => {
    const mine = content({ "2": { fields: [{ ...initials(0, 0, R(0.1, 0.1, 0.2, 0.04), "mine") }], textFields: [] } });
    const out = applyDetection(mine, "2", result([field("am-0-1", {})]));
    expect(out.placed).toBe(0);
    expect(out.content.variants["2"].fields).toHaveLength(1);
  });

  it("aceptar una sugerencia la pasa a la variante sin la marca de revision y con id propio", () => {
    const out = applyDetection(content(), "1", result([field("am-1-1", { tier: "review", pageIndex: 1 }), field("am-1-2", { tier: "review", type: "date", signerIndex: undefined, label: "Date" })]));
    expect(out.suggestions).toHaveLength(2);
    const accepted = acceptSuggestion(out.content, out.suggestions[0], mint);
    expect(accepted.variants["1"].fields).toHaveLength(1);
    expect(accepted.variants["1"].fields[0].needsReview).toBeUndefined();
    expect(accepted.variants["1"].fields[0].id).toBeTruthy();
    const both = acceptSuggestion(accepted, out.suggestions[1], mint);
    expect(both.variants["1"].textFields[0]).toMatchObject({ type: "date", rule: "today" });
    expect(pagesWithFields(both.variants["1"])).toBe(2);
  });

  it("con 1 firmante el firmante 2 no entra", () => {
    const out = applyDetection(content(), "1", result([field("a", {}), field("b", { signerIndex: 1 })]));
    expect(out.content.variants["1"].fields).toHaveLength(1);
    expect(out.ignored).toBe(1);
  });
});
