import { describe, expect, it } from "vitest";
import { buildContent, own, parseContent, parseRect, parseRoles, parseStoredTemplate, parseTemplate, parseVariant } from "./templateSchema";
import { R, sampleDraft, signField, textField } from "./testing/templateSamples";
import { TEMPLATE_LIMITS, TEMPLATE_SCHEMA_VERSION, type DocTemplate } from "./templateTypes";

function validTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = buildContent(sampleDraft("doc-1"));
  if (!content) throw new Error("la muestra debe ser válida");
  return { schemaVersion: TEMPLATE_SCHEMA_VERSION, id: "tpl-1", documentId: "doc-1", ...content, version: 1, createdAt: "2026-03-01T10:00:00.000Z", updatedAt: "2026-03-01T10:00:00.000Z", rev: 1, ...overrides };
}

describe("own()", () => {
  it("solo lee propiedades PROPIAS", () => {
    const parent = { inherited: 1 };
    const child = Object.create(parent) as Record<string, unknown>;
    child.own = 2;
    expect(own(child, "own")).toBe(2);
    expect(own(child, "inherited")).toBeUndefined();
    expect(own({}, "constructor")).toBeUndefined();
    expect(own({}, "__proto__")).toBeUndefined();
  });
});

describe("parseRect", () => {
  it("acepta rectángulos dentro de 0..1 (incluido pegado al borde)", () => {
    expect(parseRect(R(0, 0, 1, 1))).toEqual(R(0, 0, 1, 1));
    expect(parseRect(R(0.79, 0.8, 0.1, 0.05))).toEqual(R(0.79, 0.8, 0.1, 0.05));
    expect(parseRect(R(0.9, 0.95, 0.1, 0.05))).not.toBeNull();
  });

  it("tolera el error de redondeo de coma flotante (0,9 + 0,1)", () => {
    expect(parseRect({ x: 0.9, y: 0.7, width: 0.1 + 1e-12, height: 0.3 })).not.toBeNull();
  });

  it("rechaza fuera de 0..1, tamaño nulo o negativo y no finitos", () => {
    const bad: unknown[] = [
      R(-0.01, 0, 0.1, 0.1),
      R(0, -0.01, 0.1, 0.1),
      R(0.95, 0, 0.1, 0.1),
      R(0, 0.95, 0.1, 0.1),
      R(0, 0, 0, 0.1),
      R(0, 0, 0.1, 0),
      R(0, 0, -0.1, 0.1),
      R(0, 0, 1.2, 0.1),
      R(NaN, 0, 0.1, 0.1),
      R(0, Infinity, 0.1, 0.1),
      { x: "0.1", y: 0, width: 0.1, height: 0.1 },
      { x: 0, y: 0, width: 0.1 },
      null,
      5,
      [],
      "x",
    ];
    for (const rect of bad) expect(parseRect(rect), JSON.stringify(rect)).toBeNull();
  });

  it("copia solo los cuatro números (lo demás no pasa)", () => {
    const out = parseRect({ x: 0.1, y: 0.1, width: 0.2, height: 0.2, extra: "<x>", __proto__: { polluted: 1 } });
    expect(out).toEqual(R(0.1, 0.1, 0.2, 0.2));
    expect(Object.keys(out!)).toEqual(["x", "y", "width", "height"]);
  });
});

describe("roles", () => {
  it("1 o 2 roles con clave y etiqueta válidas, sin repetir", () => {
    expect(parseRoles([{ key: "signer1", label: "Asegurado" }])).toHaveLength(1);
    expect(parseRoles([{ key: "signer1", label: "A" }, { key: "signer2", label: "B" }])).toHaveLength(2);
    expect(parseRoles([])).toBeNull();
    expect(parseRoles([{ key: "a", label: "x" }, { key: "b", label: "y" }, { key: "c", label: "z" }])).toBeNull();
    expect(parseRoles([{ key: "a", label: "x" }, { key: "a", label: "y" }])).toBeNull();
    expect(parseRoles([{ key: "Signer", label: "x" }])).toBeNull();
    expect(parseRoles([{ key: "ok", label: "   " }])).toBeNull();
    expect(parseRoles([{ key: "ok", label: "a‮b" }])).toBeNull();
    expect(parseRoles([{ key: "ok", label: "x".repeat(TEMPLATE_LIMITS.maxRoleLabelLength + 1) }])).toBeNull();
    expect(parseRoles("x")).toBeNull();
  });
});

describe("variantes", () => {
  const v = (fields: unknown[], textFields: unknown[] = []) => ({ fields, textFields });
  const sign = (extra: Record<string, unknown> = {}) => ({ roleIndex: 0, pageIndex: 0, type: "signature", rect: R(0.1, 0.1, 0.2, 0.05), required: true, source: "manual", ...extra });
  const text = (extra: Record<string, unknown> = {}) => ({ pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.05), type: "text", label: "x", required: false, source: "manual", ...extra });

  it("la variante «1» solo admite el rol 0; la «2», 0 y 1; y nunca más roles de los que hay", () => {
    expect(parseVariant(v([sign({ roleIndex: 1 })]), "1", 2)).toBeNull();
    expect(parseVariant(v([sign({ roleIndex: 1 })]), "2", 2)).not.toBeNull();
    expect(parseVariant(v([sign({ roleIndex: 1 })]), "2", 1)).toBeNull();
    expect(parseVariant(v([sign({ roleIndex: 2 })]), "2", 2)).toBeNull();
    expect(parseVariant(v([sign({ roleIndex: -1 })]), "2", 2)).toBeNull();
    expect(parseVariant(v([sign({ roleIndex: 0.5 })]), "2", 2)).toBeNull();
  });

  it("el tope es de 500 campos POR VARIANTE (firmas + texto)", () => {
    const fields = Array.from({ length: 300 }, () => sign());
    const texts = Array.from({ length: 200 }, () => text());
    expect(parseVariant(v(fields, texts), "1", 2)).not.toBeNull();
    expect(parseVariant(v(fields, [...texts, text()]), "1", 2)).toBeNull();
    expect(parseVariant(v(Array.from({ length: 501 }, () => sign())), "1", 2)).toBeNull();
    expect(TEMPLATE_LIMITS.maxFieldsPerVariant).toBe(500);
  });

  it("valida cada campo: tipo, página, requerido, origen, grupo, id y confianza", () => {
    const bad: Array<[string, unknown]> = [
      ["tipo", sign({ type: "stamp" })],
      ["página negativa", sign({ pageIndex: -1 })],
      ["página decimal", sign({ pageIndex: 1.5 })],
      ["página enorme", sign({ pageIndex: TEMPLATE_LIMITS.maxPageIndex + 1 })],
      ["required no booleano", sign({ required: "yes" })],
      ["sin required", { ...sign(), required: undefined }],
      ["source raro", sign({ source: "robot" })],
      ["grupo en minúscula", sign({ group: "a" })],
      ["grupo largo", sign({ group: "ABCD" })],
      ["id con espacios", sign({ id: "a b" })],
      ["confianza > 1", sign({ confidence: 1.1 })],
      ["needsReview no booleano", sign({ needsReview: 1 })],
      ["rect fuera", sign({ rect: R(0.9, 0.9, 0.2, 0.2) })],
    ];
    for (const [name, field] of bad) expect(parseVariant(v([field]), "2", 2), name).toBeNull();
    expect(parseVariant(v([sign({ group: "AB", id: "f-1", confidence: 0.5, needsReview: true, source: "auto" })]), "2", 2)).not.toBeNull();
  });

  it("campos de texto: tipo, etiqueta, dataKey, regla", () => {
    for (const type of ["text", "date", "checkbox", "initials"]) expect(parseVariant(v([], [text({ type })]), "1", 2), type).not.toBeNull();
    expect(parseVariant(v([], [text({ type: "number" })]), "1", 2)).toBeNull();
    expect(parseVariant(v([], [text({ label: "a".repeat(TEMPLATE_LIMITS.maxFieldLabelLength + 1) })]), "1", 2)).toBeNull();
    expect(parseVariant(v([], [text({ label: "a\u0000b" })]), "1", 2)).toBeNull();
    expect(parseVariant(v([], [text({ label: 7 })]), "1", 2)).toBeNull();
    expect(parseVariant(v([], [text({ dataKey: "Insured" })]), "1", 2)).toBeNull();
    expect(parseVariant(v([], [text({ dataKey: "x".repeat(41) })]), "1", 2)).toBeNull();
    expect(parseVariant(v([], [text({ dataKey: "claimNumber" })]), "1", 2)).not.toBeNull();
    // Una clave desconocida con forma válida SE CONSERVA (F3 puede añadir claves).
    expect(parseVariant(v([], [text({ dataKey: "futureKey.v2" })]), "1", 2)?.textFields[0].dataKey).toBe("futureKey.v2");
    expect(parseVariant(v([], [text({ rule: "tomorrow" })]), "1", 2)).toBeNull();
    expect(parseVariant(v([], [text({ rule: "today" })]), "1", 2)?.textFields[0].rule).toBe("today");
  });

  it("ids repetidos dentro de la variante (entre firmas y textos) → rechazada", () => {
    expect(parseVariant(v([sign({ id: "a" }), sign({ id: "a" })]), "2", 2)).toBeNull();
    expect(parseVariant(v([sign({ id: "a" })], [text({ id: "a" })]), "2", 2)).toBeNull();
    expect(parseVariant(v([sign({ id: "a" })], [text({ id: "b" })]), "2", 2)).not.toBeNull();
  });

  it("no es un objeto bien formado → null", () => {
    for (const raw of [null, 1, "x", [], { fields: [] }, { fields: {}, textFields: [] }, { fields: [], textFields: "x" }]) expect(parseVariant(raw, "1", 2)).toBeNull();
  });
});

describe("plantilla completa", () => {
  it("acepta una plantilla válida y la copia (sin campos desconocidos)", () => {
    const raw = validTemplate({ extra: "x", history: [] });
    const out = parseTemplate(raw);
    expect(out).not.toBeNull();
    expect(out && "extra" in out).toBe(false);
    expect(out && "history" in out).toBe(false);
    expect(out?.schemaVersion).toBe(1);
  });

  it("rechaza cada campo mal formado de la cabecera", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["schemaVersion distinta", { schemaVersion: 2 }],
      ["sin schemaVersion", { schemaVersion: undefined }],
      ["id con caracteres raros", { id: "../x" }],
      ["id vacío", { id: "" }],
      ["documentId raro", { documentId: "a b" }],
      ["documentId no cadena", { documentId: 5 }],
      ["version 0", { version: 0 }],
      ["version decimal", { version: 1.5 }],
      ["rev 0", { rev: 0 }],
      ["fecha inválida", { createdAt: "ayer" }],
      ["updatedAt inválida", { updatedAt: "2026" }],
      ["nombre vacío", { name: "   " }],
      ["nombre largo", { name: "n".repeat(TEMPLATE_LIMITS.maxNameLength + 1) }],
      ["nombre con control", { name: "a\nb" }],
      ["origen raro", { origin: { kind: "otro" } }],
    ];
    for (const [name, patch] of cases) expect(parseTemplate(validTemplate(patch)), name).toBeNull();
  });

  it("documentId puede ser null (plantilla sin documento)", () => {
    expect(parseTemplate(validTemplate({ documentId: null }))?.documentId).toBeNull();
  });

  it("origen válido: local y clone", () => {
    expect(parseTemplate(validTemplate({ origin: { kind: "local", legacyId: "tpl-1-2", savedAt: "2026-01-01T00:00:00.000Z" } }))?.origin?.kind).toBe("local");
    expect(parseTemplate(validTemplate({ origin: { kind: "clone", fromTemplateId: "t-1", fromDocumentId: null } }))?.origin?.kind).toBe("clone");
    expect(parseTemplate(validTemplate({ origin: { kind: "local", legacyId: "", savedAt: "2026-01-01T00:00:00.000Z" } }))).toBeNull();
    expect(parseTemplate(validTemplate({ origin: { kind: "clone", fromTemplateId: "t 1", fromDocumentId: null } }))).toBeNull();
  });

  it("el diseño de iniciales se valida (páginas, hueco, ajustes)", () => {
    const layout = (patch: Record<string, unknown>) => ({ initials: { fromPage: 0, toPage: "all", base: R(0.79, 0.84, 0.11, 0.03), adjust: [], ...patch } });
    expect(parseTemplate(validTemplate({ layout: layout({}) }))?.layout?.initials?.toPage).toBe("all");
    expect(parseTemplate(validTemplate({ layout: layout({ toPage: 5 }) }))).not.toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ toPage: [1, 3] }) }))).not.toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ toPage: "some" }) }))).toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ toPage: [1, -2] }) }))).toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ gap: 0.6 }) }))).toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ gap: 0.2 }) }))).not.toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ adjust: [{ page: 1, dx: 0.01, dy: -0.01 }] }) }))).not.toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ adjust: [{ page: 1, dx: 5, dy: 0 }] }) }))).toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ adjust: [{ page: 1, dx: 0, dy: 0 }, { page: 1, dx: 0, dy: 0 }] }) }))).toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ base: R(0.95, 0.9, 0.2, 0.2) }) }))).toBeNull();
    expect(parseTemplate(validTemplate({ layout: layout({ fromPage: -1 }) }))).toBeNull();
    expect(parseTemplate(validTemplate({ layout: { initials: 5 } }))).toBeNull();
  });

  it("JSON hostil: __proto__, constructor y propiedades heredadas no se interpretan", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"schemaVersion":1,"id":"tpl-h","documentId":null,"name":"Hostil","roles":[{"key":"signer1","label":"A","__proto__":{"x":1}}],' +
        '"variants":{"1":{"fields":[],"textFields":[{"pageIndex":0,"rect":{"x":0.1,"y":0.1,"width":0.2,"height":0.1,"__proto__":{"y":1}},"type":"text","label":"x","required":false,"source":"manual","constructor":{"prototype":{"polluted":1}}}]},"2":{"fields":[],"textFields":[]}},' +
        '"version":1,"createdAt":"2026-03-01T10:00:00.000Z","updatedAt":"2026-03-01T10:00:00.000Z","rev":1}',
    );
    const out = parseTemplate(hostile);
    expect(out).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(out as object, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).not.toContain("polluted");
  });

  it("una propiedad HEREDADA con el nombre de un campo no cuenta", () => {
    const proto = { id: "tpl-1", schemaVersion: 1 };
    const inheriting = Object.assign(Object.create(proto) as Record<string, unknown>, { ...validTemplate(), id: undefined, schemaVersion: undefined });
    delete inheriting.id;
    delete inheriting.schemaVersion;
    expect(parseTemplate(inheriting)).toBeNull();
  });

  it("JSON muy anidado no se recorre ni lanza", () => {
    let deep: unknown = { x: 1 };
    for (let i = 0; i < 5000; i += 1) deep = { a: deep };
    // Las claves desconocidas (aunque sean un abismo de objetos) no se recorren: se ignoran.
    const ignored = parseTemplate(validTemplate({ name: "ok", layout: deep }));
    expect(ignored).not.toBeNull();
    expect(ignored?.layout).toBeUndefined();
    expect(parseTemplate(validTemplate({ layout: { initials: deep } }))).toBeNull();
    expect(parseTemplate(deep)).toBeNull();
    const arrays = JSON.parse("[".repeat(3000) + "]".repeat(3000)) as unknown;
    expect(parseTemplate(arrays)).toBeNull();
    expect(parseTemplate(validTemplate({ variants: { "1": { fields: arrays, textFields: [] }, "2": { fields: [], textFields: [] } } }))).toBeNull();
  });

  it("nunca lanza, con cualquier basura", () => {
    for (const junk of [undefined, null, NaN, () => 1, Symbol("x"), [], "x", 5, { id: {} }, new Date(), new Map()]) {
      expect(() => parseTemplate(junk)).not.toThrow();
      expect(() => parseStoredTemplate(junk)).not.toThrow();
      expect(() => parseContent(junk)).not.toThrow();
    }
  });
});

describe("fila guardada (con historial)", () => {
  const snapshot = (version: number) => {
    const content = buildContent(sampleDraft("doc-1"))!;
    return { ...content, version, updatedAt: "2026-03-01T10:00:00.000Z" };
  };

  it("el historial admite hasta maxVersions - 1 versiones anteriores, con números distintos y menores", () => {
    const base = validTemplate({ version: 6 });
    expect(parseStoredTemplate({ ...base, history: [snapshot(5), snapshot(4), snapshot(3), snapshot(2)] })?.history).toHaveLength(4);
    expect(parseStoredTemplate({ ...base, history: [snapshot(5), snapshot(4), snapshot(3), snapshot(2), snapshot(1)] })).toBeNull();
    expect(parseStoredTemplate({ ...base, history: [snapshot(5), snapshot(5)] })).toBeNull();
    expect(parseStoredTemplate({ ...base, history: [snapshot(6)] })).toBeNull();
    expect(parseStoredTemplate({ ...base, history: [snapshot(7)] })).toBeNull();
    expect(parseStoredTemplate({ ...base, history: "x" })).toBeNull();
    expect(parseStoredTemplate(base)).toBeNull();
  });

  it("una versión anterior dañada invalida la fila", () => {
    const base = validTemplate({ version: 2 });
    const broken = { ...snapshot(1), name: "" };
    expect(parseStoredTemplate({ ...base, history: [broken] })).toBeNull();
  });
});

describe("buildContent (borrador → contenido completo)", () => {
  it("rellena los valores por defecto", () => {
    const content = buildContent({ name: "X", variants: { "1": { fields: [{ roleIndex: 0, pageIndex: 0, type: "initials", rect: R(0.8, 0.8, 0.1, 0.03) }], textFields: [{ pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.03) }] } } })!;
    expect(content.roles.map((role) => role.key)).toEqual(["signer1", "signer2"]);
    expect(content.variants["2"]).toEqual({ fields: [], textFields: [] });
    expect(content.variants["1"].fields[0]).toMatchObject({ required: true, source: "manual" });
    expect(content.variants["1"].textFields[0]).toMatchObject({ type: "text", label: "", required: false, source: "manual" });
  });

  it("respeta lo que se da (required false, source auto) y rechaza lo inválido", () => {
    const content = buildContent({ name: "X", variants: { "2": { fields: [signField({ required: false, source: "auto" })] } } })!;
    expect(content.variants["2"].fields[0]).toMatchObject({ required: false, source: "auto" });
    expect(buildContent({ name: "", variants: {} })).toBeNull();
    expect(buildContent({ name: "X", variants: { "1": { fields: [signField({ rect: R(2, 0, 1, 1) })] } } })).toBeNull();
    expect(buildContent({ name: "X", variants: { "1": { fields: "x" as never } } })).toBeNull();
    expect(buildContent({ name: "X", variants: { "1": { textFields: [textField({ type: "zzz" as never })] } } })).toBeNull();
    expect(buildContent(null as never)).toBeNull();
  });
});

describe("tipos coherentes", () => {
  it("DocTemplate de la muestra pasa parseTemplate y vuelve igual", () => {
    const raw = validTemplate();
    const out = parseTemplate(raw) as DocTemplate;
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(raw)));
  });
});
