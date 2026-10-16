import fs from "node:fs";
import path from "node:path";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { LIBRARY_EXPORT_SCHEMA, MAX_LIBRARY_JSON_BYTES, TEMPLATES_EXPORT_SCHEMA, deserializeLibrary, serializeLibrary, serializeLibraryJson, serializeTemplate } from "./persist";
import { __resetLibraryForTests, putDocument } from "./store";
import { createTemplate, getTemplate, importTemplates, listTemplates, saveTemplateVersion } from "./templatesStore";
import { buildContent } from "./templateSchema";
import { TEMPLATE_LIMITS, TEMPLATE_SCHEMA_VERSION, type DocTemplate } from "./templateTypes";
import { R, clock, sampleDraft, signField, variantOf } from "./testing/templateSamples";
import { sampleBytes, sampleFingerprint, sampleInput } from "./testing/sampleDocs";
import type { DocumentEntry } from "./types";

beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});

function entry(id: string, pages = 2, seed = 3): DocumentEntry {
  const fingerprint = sampleFingerprint(pages, seed);
  return { ...sampleInput(id, { fingerprint, pageCount: pages, pageSizes: fingerprint.pageSizes }), createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z", byteLength: 1234, rev: 7 } as DocumentEntry;
}

function template(id: string, documentId: string | null = "doc-1", over: Partial<DocTemplate> = {}): DocTemplate {
  const content = buildContent(sampleDraft(documentId, { name: `Plantilla ${id}` }))!;
  return { schemaVersion: TEMPLATE_SCHEMA_VERSION, id, documentId, ...content, version: 3, createdAt: "2026-03-01T10:00:00.000Z", updatedAt: "2026-03-05T10:00:00.000Z", rev: 9, ...over };
}

const FIXTURES = path.join(__dirname, "__fixtures__");

/** Las mismas entradas con las que se GENERÓ el paquete dorado (con el código de U2.1, antes de las plantillas). */
function goldenEntries(): DocumentEntry[] {
  const make = (id: string, pages: number, seed: number, over: Partial<DocumentEntry> = {}): DocumentEntry => {
    const fingerprint = sampleFingerprint(pages, seed);
    const input = sampleInput(id, { fingerprint, pageCount: pages, pageSizes: fingerprint.pageSizes });
    return { ...input, createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z", byteLength: 1234, rev: 7, ...over } as DocumentEntry;
  };
  return [make("golden-a", 2, 3), make("golden-b", 3, 8, { templateIds: ["t-1"], name: "Otro contrato" })];
}

describe("formato v1 de U2.1: retrocompatible", () => {
  const golden = fs.readFileSync(path.join(FIXTURES, "library.v1.json"), "utf8");
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, "library.v1.expected.json"), "utf8")) as { ok: true; documents: unknown[]; warnings: unknown[] };

  it("el paquete dorado (generado con el código de U2.1, antes de las plantillas) se lee igual y sin plantillas", () => {
    const back = deserializeLibrary(golden);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(JSON.parse(JSON.stringify(back.documents))).toEqual(expected.documents);
    expect(back.warnings).toEqual(expected.warnings);
    expect(back.templates).toEqual([]);
    expect(back.documents.map((document) => document.id)).toEqual(["golden-a", "golden-b"]);
  });

  it("sin plantillas, serializar produce EXACTAMENTE los mismos bytes que U2.1", () => {
    const entries = goldenEntries();
    expect(serializeLibraryJson(entries)).toBe(golden);
    expect(serializeLibraryJson(entries, [])).toBe(golden);
    expect(serializeLibrary(entries).schemaVersion).toBe(LIBRARY_EXPORT_SCHEMA);
    expect("templates" in serializeLibrary(entries)).toBe(false);
  });

  it("con plantillas, el paquete es el de U2.1 más dos claves: quitarlas devuelve el formato antiguo (un lector antiguo las ignora)", () => {
    const withTemplates = JSON.parse(serializeLibraryJson(goldenEntries(), [template("t-1")])) as Record<string, unknown>;
    expect(withTemplates.schemaVersion).toBe(1);
    expect(withTemplates.templatesSchemaVersion).toBe(TEMPLATES_EXPORT_SCHEMA);
    delete withTemplates.templates;
    delete withTemplates.templatesSchemaVersion;
    expect(JSON.stringify(withTemplates)).toBe(golden);
  });

  it("un esquema de documentos más nuevo se sigue rechazando (la versión de documentos no cambió)", () => {
    expect(deserializeLibrary({ schemaVersion: 2, documents: [] })).toEqual({ ok: false, reason: "newerVersion" });
  });
});

describe("serializeTemplate", () => {
  it("quita `rev` y el historial; conserva todo lo demás", () => {
    const original = { ...template("t-1"), history: [{ version: 1 }] } as DocTemplate;
    const out = serializeTemplate(original) as Record<string, unknown>;
    expect("rev" in out).toBe(false);
    expect("history" in out).toBe(false);
    expect(out.id).toBe("t-1");
    expect(out.version).toBe(3);
    expect(JSON.stringify(out)).not.toContain('"rev"');
    expect(original.rev).toBe(9); // la entrada no cambia
    expect("history" in original).toBe(true);
  });
});

describe("exportar → importar plantillas", () => {
  it("ida y vuelta sin pérdida (rev=1 al volver, el almacén pone la suya)", () => {
    const templates = [template("t-1"), template("t-2", null, { layout: { initials: { fromPage: 0, toPage: "all", base: R(0.79, 0.84, 0.11, 0.03), gap: 0.2, adjust: [{ page: 1, dx: 0.01, dy: -0.01 }] } }, origin: { kind: "clone", fromTemplateId: "t-1", fromDocumentId: "doc-1" } })];
    const back = deserializeLibrary(serializeLibraryJson([entry("doc-1")], templates));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.warnings).toEqual([]);
    expect(back.templates).toEqual(templates.map((t) => ({ ...t, rev: 1 })));
  });

  it("acepta también el objeto ya parseado", () => {
    const back = deserializeLibrary(serializeLibrary([entry("doc-1")], [template("t-1")]));
    expect(back.ok && back.templates).toHaveLength(1);
  });

  it("de la biblioteca real a otra (exportar, borrar, importar)", async () => {
    await putDocument(sampleInput("doc-1"), sampleBytes(32));
    const created = await createTemplate(sampleDraft("doc-1"), { newId: () => "tpl-real", now: clock() });
    const edited = await saveTemplateVersion({ ...structuredClone(created), name: "Editada" });
    const text = serializeLibraryJson([], (await listTemplates()).templates);

    __resetLibraryForTests();
    globalThis.indexedDB = new IDBFactory();
    await putDocument(sampleInput("doc-1"), sampleBytes(32));
    const back = deserializeLibrary(text);
    if (!back.ok) throw new Error("debía leerse");
    const imported = await importTemplates(back.templates);
    expect(imported.imported).toEqual(["tpl-real"]);
    const restored = (await getTemplate("tpl-real"))!;
    expect(restored).toEqual({ ...edited, rev: 1 });
  });

  it("los campos desconocidos no pasan, ni `rev`/`history` del archivo", () => {
    const data = serializeLibrary([], [template("t-1")]) as unknown as { templates: Array<Record<string, unknown>> };
    data.templates[0].extra = "<script>";
    data.templates[0].rev = 12345;
    data.templates[0].history = [{ version: 1 }];
    const back = deserializeLibrary(data);
    if (!back.ok) throw new Error("debía leerse");
    expect(back.templates[0].rev).toBe(1);
    expect("extra" in back.templates[0]).toBe(false);
    expect("history" in back.templates[0]).toBe(false);
  });
});

describe("importación hostil de plantillas", () => {
  const base = (): { schemaVersion: 1; documents: unknown[]; templatesSchemaVersion: 1; templates: Array<Record<string, unknown>> } =>
    JSON.parse(serializeLibraryJson([], [template("t-1"), template("t-2")])) as never;

  const warningsOf = (data: unknown) => {
    const back = deserializeLibrary(data);
    if (!back.ok) throw new Error("debía leerse");
    return { templates: back.templates, warnings: back.warnings };
  };

  it("cada plantilla inválida se omite con su índice y las demás entran", () => {
    const data = base();
    const patches: Array<Record<string, unknown>> = [{ name: "" }, { id: "../../etc" }, { schemaVersion: 2 }, { roles: [] }, { version: -1 }, { documentId: 5 }];
    const bad = patches.map((patch, index) => ({ ...data.templates[0], id: `x-${index}`, ...patch }));
    data.templates = [data.templates[0], ...bad, data.templates[1]];
    const out = warningsOf(data);
    expect(out.templates.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect(out.warnings).toEqual(bad.map((_, index) => ({ code: "invalidTemplate", index: index + 1 })));
  });

  it("rectángulos fuera de 0..1, no finitos o con tamaño nulo", () => {
    for (const rect of [R(-0.1, 0, 0.1, 0.1), R(0.95, 0.5, 0.2, 0.1), R(0, 0, 0, 0.1), { x: "0.1", y: 0, width: 0.1, height: 0.1 }, R(1e308, 0, 0.1, 0.1), null]) {
      const data = base();
      const variants = data.templates[0].variants as { "2": { fields: Array<{ rect: unknown }> } };
      variants["2"].fields[0].rect = rect;
      expect(warningsOf(data).templates.map((t) => t.id), JSON.stringify(rect)).toEqual(["t-2"]);
    }
    // NaN/Infinity no existen en JSON: llegan como null.
    const text = JSON.stringify(base()).replace('"x":0.16', '"x":1e999');
    expect(warningsOf(text).templates.map((t) => t.id)).toEqual(["t-2"]);
  });

  it("más de 500 campos en una variante", () => {
    const data = base();
    const variants = data.templates[0].variants as { "2": { fields: unknown[]; textFields: unknown[] } };
    const one = variants["2"].fields[0];
    variants["2"].textFields = [];
    variants["2"].fields = Array.from({ length: TEMPLATE_LIMITS.maxFieldsPerVariant + 1 }, () => ({ ...(one as object) }));
    expect(warningsOf(data).templates.map((t) => t.id)).toEqual(["t-2"]);
    variants["2"].fields = Array.from({ length: TEMPLATE_LIMITS.maxFieldsPerVariant }, () => ({ ...(one as object) }));
    expect(warningsOf(data).templates.map((t) => t.id)).toEqual(["t-1", "t-2"]);
  });

  it("ids repetidos y más de 200 plantillas", () => {
    const dup = base();
    dup.templates = [dup.templates[0], dup.templates[0]];
    const out = warningsOf(dup);
    expect(out.templates).toHaveLength(1);
    expect(out.warnings).toEqual([{ code: "duplicateTemplateId", index: 1 }]);

    const many = base();
    const one = many.templates[0];
    many.templates = Array.from({ length: TEMPLATE_LIMITS.maxTemplates + 5 }, (_, index) => ({ ...one, id: `m-${index}` }));
    const big = warningsOf(many);
    expect(big.templates).toHaveLength(TEMPLATE_LIMITS.maxTemplates);
    expect(big.warnings).toContainEqual({ code: "tooManyTemplates", kept: TEMPLATE_LIMITS.maxTemplates });
  });

  it("bloque `templates` mal formado o de versión rara: se ignoran las plantillas, los documentos siguen", () => {
    const docs = JSON.parse(serializeLibraryJson([entry("doc-1")], [template("t-1")])) as Record<string, unknown>;
    const newer = warningsOf({ ...docs, templatesSchemaVersion: 2 });
    expect(newer.templates).toEqual([]);
    expect(newer.warnings).toEqual([{ code: "newerTemplatesVersion" }]);
    for (const patch of [{ templates: "x" }, { templates: {} }, { templatesSchemaVersion: "1" }, { templatesSchemaVersion: 0 }, { templatesSchemaVersion: 1.5 }, { templatesSchemaVersion: undefined }]) {
      const out = warningsOf({ ...docs, ...patch });
      expect(out.templates, JSON.stringify(patch)).toEqual([]);
      expect(out.warnings, JSON.stringify(patch)).toEqual([{ code: "invalidTemplate", index: -1 }]);
    }
    const back = deserializeLibrary({ ...docs, templates: 5 });
    expect(back.ok && back.documents).toHaveLength(1);
    // Sin la clave: no hay aviso.
    delete docs.templates;
    delete docs.templatesSchemaVersion;
    expect(warningsOf(docs)).toEqual({ templates: [], warnings: [] });
  });

  it("JSON con __proto__, constructor y prototype: nada se contamina ni se interpreta", () => {
    const text = JSON.stringify(base()).replace(
      /^\{/,
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},',
    );
    const hostile = text.replace('"id":"t-1"', '"id":"t-1","__proto__":{"id":"evil","documentId":"evil","name":"evil"},"prototype":{"x":1}');
    const out = warningsOf(hostile);
    expect(out.templates.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect(out.templates[0].name).toBe("Plantilla t-1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.templates[0])).toBe(Object.prototype);
    expect(Object.hasOwn(out.templates[0], "__proto__")).toBe(false);
  });

  it("una plantilla que hereda sus campos de un prototipo (objeto ya parseado) no vale", () => {
    const proto = JSON.parse(JSON.stringify(serializeTemplate(template("inherit")))) as Record<string, unknown>;
    const child = Object.create(proto) as Record<string, unknown>;
    const out = warningsOf({ schemaVersion: 1, documents: [], templatesSchemaVersion: 1, templates: [child] });
    expect(out.templates).toEqual([]);
    expect(out.warnings).toEqual([{ code: "invalidTemplate", index: 0 }]);
  });

  it("JSON muy anidado, muy largo o con basura no lanza", () => {
    const deepArray = "[".repeat(50_000) + "]".repeat(50_000);
    expect(() => deserializeLibrary(`{"schemaVersion":1,"documents":[],"templatesSchemaVersion":1,"templates":${deepArray}}`)).not.toThrow();
    const deepObject = '{"a":'.repeat(20_000) + "1" + "}".repeat(20_000);
    expect(() => deserializeLibrary(`{"schemaVersion":1,"documents":[],"templatesSchemaVersion":1,"templates":[${deepObject}]}`)).not.toThrow();
    const long = JSON.stringify({ ...base(), templates: [{ ...base().templates[0], name: "n".repeat(5_000_000) }] });
    const out = warningsOf(long);
    expect(out.templates).toEqual([]);
    expect(deserializeLibrary("﻿" + serializeLibraryJson([entry("doc-1")]))).toEqual({ ok: false, reason: "invalidJson" });
    expect(deserializeLibrary(serializeLibraryJson([]) + "basura")).toEqual({ ok: false, reason: "invalidJson" });
    expect(deserializeLibrary("x".repeat(MAX_LIBRARY_JSON_BYTES + 1))).toEqual({ ok: false, reason: "tooLarge" });
  });

  it("claves duplicadas en el JSON: manda la última, y sigue siendo válido o se omite (nunca se mezclan)", () => {
    const text = JSON.stringify(base()).replace('"id":"t-1"', '"id":"t-1","id":"t-3"');
    expect(warningsOf(text).templates.map((t) => t.id)).toEqual(["t-3", "t-2"]);
  });

  it("importTemplates revalida: una plantilla manipulada después de leerla no entra", async () => {
    const back = warningsOf(base());
    const tampered = { ...back.templates[0], variants: { ...back.templates[0].variants, "1": { fields: [{ roleIndex: 0, pageIndex: 0, type: "signature", rect: R(5, 5, 5, 5), required: true, source: "manual" }], textFields: [] } } } as DocTemplate;
    await expect(importTemplates([tampered])).rejects.toMatchObject({ code: "invalid" });
    expect((await listTemplates()).templates).toEqual([]);
  });
});

describe("las plantillas del paquete respetan las variantes", () => {
  it("una plantilla con rol 1 en la variante «1» (manipulada) se rechaza", () => {
    const data = JSON.parse(serializeLibraryJson([], [template("t-1")])) as { templates: Array<{ variants: { "1": { fields: Array<{ roleIndex: number }> } } }> };
    data.templates[0].variants["1"].fields[0].roleIndex = 1;
    const back = deserializeLibrary(data);
    expect(back.ok && back.templates).toEqual([]);
    expect(back.ok && back.warnings).toEqual([{ code: "invalidTemplate", index: 0 }]);
  });

  it("dataKey desconocida con forma válida viaja (F3 puede añadir claves)", () => {
    const t = template("t-1", "doc-1", { variants: buildContent({ name: "x", variants: { "2": variantOf([signField()], [{ pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.02), dataKey: "futureKey" }]) } })!.variants });
    const back = deserializeLibrary(serializeLibrary([], [t]));
    expect(back.ok && back.templates[0].variants["2"].textFields[0].dataKey).toBe("futureKey");
  });
});
