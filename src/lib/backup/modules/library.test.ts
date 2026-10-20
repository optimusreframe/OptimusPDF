import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/crypto/sha256";
import { clearLibrary, getDocument, getDocumentBytes, listDocuments, putDocument, replaceDocumentBytes } from "@/lib/docLibrary/store";
import { getTemplate, getTemplateVersions, listTemplates } from "@/lib/docLibrary/templatesStore";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { migrateLibrary } from "@/lib/backup/migrations/library";
import {
  LIBRARY_MODULE_SPEC,
  applyLibraryImport,
  checkLibraryLimits,
  defaultLibraryDecisions,
  exportLibrary,
  exportLibraryWithReport,
  libraryDecisionOptions,
  loadLibraryExisting,
  planLibraryImport,
  summarizeLibraryExport,
  type LibraryDecision,
  type LibraryPlan,
} from "@/lib/backup/modules/library";
import {
  countWrites,
  exportBlob,
  fakePdf,
  fingerprintOf,
  freshLibrary,
  planOf,
  seedDoc,
  seedTemplate,
  singleSignerDraft,
  snapshotLibrary,
} from "@/lib/backup/__fixtures__/libraryKit";

/**
 * Módulo «Plantillas + Documentos» del respaldo sobre un IndexedDB falso: exportar, ida y vuelta (con y sin
 * contraseña), estados Nuevo / Idéntico / Distinto / Inválido, decisiones, ids ocupados, vínculos, límites, atomicidad
 * y revalidación del plan.
 */

beforeEach(() => {
  freshLibrary();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const byKey = (plan: LibraryPlan, key: string) => {
  const item = plan.items.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`sin elemento ${key}: ${plan.items.map((i) => i.key).join(",")}`);
  return item;
};

async function seedThree() {
  await seedDoc("doc-a", 1, { name: "Contrato A", pages: 4 });
  await seedDoc("doc-b", 2, { name: "Contrato B", pages: 3 });
  await seedDoc("doc-c", 3, { name: "Contrato C", pages: 5 });
  await seedTemplate("doc-a", {}, "tpl-a");
  await seedTemplate("doc-b", singleSignerDraft, "tpl-b");
}

describe("exportar", () => {
  it("lleva documentos con su PDF, huella y plantillas; nunca rev ni templateIds", async () => {
    await seedThree();
    const { module: mod, report } = await exportLibraryWithReport();
    expect(report).toMatchObject({ documents: 3, templates: 2, skippedDocuments: 0 });
    expect(mod.name).toBe("library");
    expect(mod.meta).toEqual({ documents: 3, templates: 2 });
    const paths = mod.files.map((file) => file.path);
    expect(paths).toContain("documents/index.json");
    expect(paths).toContain("templates/index.json");
    expect(paths.filter((p) => p.endsWith(".pdf"))).toHaveLength(3);
    expect(paths.filter((p) => /^templates\/(?!index)/.test(p))).toHaveLength(2);
    const index = JSON.parse(new TextDecoder().decode(mod.files.find((f) => f.path === "documents/index.json")!.data));
    expect(index).toHaveLength(3);
    for (const doc of index) {
      expect(doc).not.toHaveProperty("rev");
      expect(doc).not.toHaveProperty("templateIds");
      expect(typeof doc.file).toBe("string");
      expect(typeof doc.fingerprint.pages[0].minhash).toBe("string");
    }
    const templateFile = mod.files.find((f) => f.path === "templates/tpl-a.json")!;
    const template = JSON.parse(new TextDecoder().decode(templateFile.data));
    expect(template).not.toHaveProperty("rev");
    expect(template).not.toHaveProperty("history");
    expect(template.documentId).toBe("doc-a");
  });

  it("omite un documento sin copia o con una copia que no corresponde a su huella, y dice cuántos", async () => {
    await seedDoc("ok", 1);
    // Sin copia (byteLength 0).
    await putDocument({
      id: "sin-copia",
      name: "Sin copia",
      docType: "x",
      fileName: "x.pdf",
      pageCount: 3,
      pageSizes: sampleFingerprint(3, 9).pageSizes,
      fingerprint: sampleFingerprint(3, 9),
      templateIds: [],
    });
    // Copia que no es la de su huella.
    await putDocument(
      {
        id: "otra-copia",
        name: "Otra copia",
        docType: "x",
        fileName: "y.pdf",
        pageCount: 3,
        pageSizes: sampleFingerprint(3, 8).pageSizes,
        fingerprint: sampleFingerprint(3, 8),
        templateIds: [],
      },
      fakePdf(77),
    );
    await seedTemplate("sin-copia", {}, "tpl-orphaned");
    const { module: mod, report } = await exportLibraryWithReport();
    expect(report).toMatchObject({ documents: 1, skippedDocuments: 2, templates: 1 });
    // La plantilla de un documento que no viaja queda «sin documento» en el paquete.
    const file = mod.files.find((f) => f.path === "templates/tpl-orphaned.json")!;
    expect(JSON.parse(new TextDecoder().decode(file.data)).documentId).toBeNull();
    const summary = await summarizeLibraryExport();
    // El resumen no lee los PDF: no puede saber que una copia no corresponde a su huella (el informe de exportar sí).
    expect(summary).toMatchObject({ available: true, documents: 2, withoutCopy: 1, templates: 1 });
  });

  it("ids con caracteres raros, mayúsculas repetidas y nombres reservados producen rutas válidas y únicas", async () => {
    await seedDoc("_raro", 1);
    await seedDoc("-guion", 2);
    await seedDoc("Doc", 3);
    await seedDoc("doc", 4);
    for (const id of ["kits", "index", "insurer-profiles", "KITS"]) await seedTemplate(null, {}, id);
    const { module: mod } = await exportLibraryWithReport();
    const lower = mod.files.map((f) => f.path.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    // Los nombres que el formato reserva (`index.json`, `kits.json`, `insurer-profiles.json`) nunca son una plantilla.
    for (const reserved of ["templates/kits.json", "templates/insurer-profiles.json"]) expect(lower).not.toContain(reserved);
    expect(mod.files.filter((f) => f.path.toLowerCase() === "templates/index.json")).toHaveLength(1);
    for (const file of mod.files) expect(file.path).toMatch(/^(documents|templates)\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    // Y el paquete se arma y se lee sin rechazos.
    const blob = await buildPackage({ modules: [mod] });
    const plan = await planLibraryImport(await readPackage(blob), { documents: [], templates: [] });
    expect(plan.counts.invalid).toBe(0);
    expect(plan.items.filter((i) => i.kind === "document")).toHaveLength(4);
    expect(plan.items.filter((i) => i.kind === "template")).toHaveLength(4);
  });

  it("sin IndexedDB lanza LibraryError(unavailable) y el resumen dice que no hay biblioteca", async () => {
    // @ts-expect-error simula un navegador sin IndexedDB
    delete globalThis.indexedDB;
    await expect(exportLibrary()).rejects.toMatchObject({ code: "unavailable" });
    expect(await summarizeLibraryExport()).toMatchObject({ available: false, documents: 0 });
  });

  it("biblioteca vacía: módulo con índices vacíos", async () => {
    const { module: mod, report } = await exportLibraryWithReport();
    expect(report).toMatchObject({ documents: 0, templates: 0 });
    expect(mod.meta).toEqual({ documents: 0, templates: 0 });
  });

  it("nunca incluye firmas ni valores de clientes: solo documents/ y templates/", async () => {
    await seedThree();
    const { module: mod } = await exportLibraryWithReport();
    for (const file of mod.files) expect(file.path).toMatch(/^(documents|templates)\//);
    const text = mod.files.filter((f) => f.path.endsWith(".json")).map((f) => new TextDecoder().decode(f.data)).join("");
    expect(text).not.toMatch(/signerName|signature\.png|sourceDocument|value-history/);
  });
});

describe("ida y vuelta", () => {
  for (const password of [undefined, "contraseña-larga-2026"]) {
    it(`exportar → borrar todo → importar ${password ? "con" : "sin"} contraseña: todo igual`, async () => {
      await seedThree();
      const before = await snapshotLibrary();
      const blob = await exportBlob(password);
      await clearLibrary();
      expect((await listDocuments()).documents).toHaveLength(0);

      const read = await readPackage(blob, password);
      expect(read.encrypted).toBe(Boolean(password));
      const plan = await planLibraryImport(read, await loadLibraryExisting());
      expect(plan.state).toBe("ok");
      expect(plan.items.map((i) => i.status)).toEqual(["new", "new", "new"]);
      const result = await applyLibraryImport(plan, defaultLibraryDecisions(plan));
      expect(result).toMatchObject({ ok: true, documents: 3, templates: 2, skipped: 0, reassigned: 0 });
      const after = await snapshotLibrary();
      // Mismos documentos (huella, fechas, bytes), mismas plantillas (contenido) y vínculos reconstruidos.
      expect(after.documents.map((d) => ({ ...d, rev: undefined }))).toEqual(before.documents.map((d) => ({ ...d, rev: undefined })));
      expect(after.templates.map((t) => ({ ...t, rev: undefined }))).toEqual(before.templates.map((t) => ({ ...t, rev: undefined })));
      expect((await getDocument("doc-a"))?.templateIds).toEqual(["tpl-a"]);
      expect((await getDocument("doc-c"))?.templateIds).toEqual([]);
    });
  }

  it("exportar de nuevo e importar sobre lo existente: todo «idéntico», sin duplicar y sin escribir", async () => {
    await seedThree();
    const blob = await exportBlob();
    const before = await snapshotLibrary();
    const { result: plan, writes: planWrites } = await countWrites(() => planOf(blob));
    expect(planWrites).toBe(0);
    expect(plan.items.map((i) => i.status)).toEqual(["identical", "identical", "identical"]);
    expect(plan.counts).toEqual({ new: 0, identical: 3, different: 0, invalid: 0 });
    const decisions = defaultLibraryDecisions(plan);
    expect(Object.values(decisions)).toEqual(["omit", "omit", "omit"]);
    const { result, writes } = await countWrites(() => applyLibraryImport(plan, decisions));
    expect(result).toMatchObject({ ok: true, documents: 0, templates: 0, skipped: 3 });
    expect(writes).toBe(0);
    expect(await snapshotLibrary()).toEqual(before);
    // Forzar «import» sobre un idéntico tampoco escribe: lo que no es coherente con el estado no se aprueba.
    const forced = Object.fromEntries(plan.items.map((i) => [i.key, "import" as LibraryDecision]));
    expect(await applyLibraryImport(plan, forced)).toMatchObject({ ok: true, documents: 0 });
    expect((await listDocuments()).documents).toHaveLength(3);
  });

  it("importar sobre una biblioteca con parte: lo que falta es «Nuevo», lo que está es «Idéntico»", async () => {
    await seedThree();
    const blob = await exportBlob();
    const { deleteDocument } = await import("@/lib/docLibrary/store");
    await deleteDocument("doc-c");
    const plan = await planOf(blob);
    expect(Object.fromEntries(plan.items.map((i) => [i.key, i.status]))).toEqual({ "doc-a": "identical", "doc-b": "identical", "doc-c": "new" });
    expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toMatchObject({ ok: true, documents: 1 });
    expect((await listDocuments()).documents).toHaveLength(3);
  });

  it("el mismo PDF con otro id ya cuenta como «Ya lo tienes»", async () => {
    await seedDoc("local-1", 5);
    const bytes = fakePdf(5);
    const fingerprint = await fingerprintOf(bytes, 3, 5);
    const doc = (await listDocuments()).documents[0];
    expect(doc.fingerprint.exact).toBe(fingerprint.exact);
    // Un paquete cuyo documento tiene otro id pero el mismo PDF.
    const { module: mod } = await exportLibraryWithReport();
    const index = JSON.parse(new TextDecoder().decode(mod.files[0].data));
    index[0].id = "otro-id";
    mod.files[0] = { ...mod.files[0], data: new Uint8Array(new TextEncoder().encode(JSON.stringify(index))) };
    const plan = await planLibraryImport(await readPackage(await buildPackage({ modules: [mod] })), await loadLibraryExisting());
    expect(plan.items[0].status).toBe("identical");
  });
});

describe("estados «Distinto» y decisiones", () => {
  it("mismo id con otro PDF: Distinto (pdf); Conservar ambos crea un documento con id nuevo y sus plantillas lo siguen", async () => {
    await seedDoc("doc-a", 1, { name: "Original" });
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    // Después de exportar, el PDF local cambia (otro contrato con el mismo id).
    await replaceDocumentBytes("doc-a", fakePdf(99), { fingerprinter: async (bytes) => ({ ...sampleFingerprint(3, 99), exact: await sha256Hex(bytes) }) });
    const plan = await planOf(blob);
    const item = byKey(plan, "doc-a");
    expect(item).toMatchObject({ status: "different", difference: "pdf" });
    expect(item.conflictWith).toMatchObject({ id: "doc-a", templates: 1 });
    expect(libraryDecisionOptions(item)).toEqual(["replace", "keepBoth", "omit"]);
    expect(defaultLibraryDecisions(plan)["doc-a"]).toBe("keepBoth");

    const result = await applyLibraryImport(plan, { "doc-a": "keepBoth" });
    expect(result).toMatchObject({ ok: true, documents: 1, templates: 1, reassigned: 2 });
    const docs = (await listDocuments()).documents;
    expect(docs).toHaveLength(2);
    const copy = docs.find((doc) => doc.id !== "doc-a")!;
    expect(copy.name).toBe("Original");
    expect(copy.templateIds).toHaveLength(1);
    expect(copy.templateIds[0]).not.toBe("tpl-a");
    expect((await getTemplate(copy.templateIds[0]))?.documentId).toBe(copy.id);
    // El original no se tocó.
    expect(await getTemplate("tpl-a")).toMatchObject({ documentId: "doc-a" });
    expect(await getDocumentBytes("doc-a")).toEqual(fakePdf(99));
  });

  it("mismo id con otro PDF: Reemplazar cambia PDF y huella, fusiona plantillas y marca desactualizadas las que se conservan", async () => {
    await seedDoc("doc-a", 1, { name: "Del paquete", pages: 4 });
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    await clearLibrary();
    // Aquí «doc-a» es OTRO contrato (otro PDF) con una plantilla propia configurada sobre él.
    const local = await seedDoc("doc-a", 99, { name: "Mío", pages: 2 });
    await seedTemplate("doc-a", singleSignerDraft, "tpl-local");
    const plan = await planOf(blob);
    const item = byKey(plan, "doc-a");
    expect(item.difference).toBe("pdf");
    const result = await applyLibraryImport(plan, { "doc-a": "replace" });
    expect(result).toMatchObject({ ok: true, documentsReplaced: 1, documents: 0, templates: 1 });
    const doc = (await getDocument("doc-a"))!;
    expect(doc.name).toBe("Del paquete");
    expect(doc.fingerprint.exact).toBe(await sha256Hex(fakePdf(1)));
    expect(doc.pageCount).toBe(4);
    expect(await getDocumentBytes("doc-a")).toEqual(fakePdf(1));
    expect(doc.templateIds.sort()).toEqual(["tpl-a", "tpl-local"]);
    // La plantilla propia se configuró sobre el PDF de antes (otro contrato): el documento queda «desactualizado».
    expect(doc.templateStale).toMatchObject({ level: "none", base: { exact: local.entry.fingerprint.exact } });
  });

  it("Reemplazar cuando las plantillas que se conservan se configuraron sobre el mismo PDF no marca nada", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    // Local: el PDF se cambió y luego se volvió al original → ya está al día.
    await seedTemplate("doc-a", singleSignerDraft, "tpl-extra");
    const other = fakePdf(99);
    await replaceDocumentBytes("doc-a", other, { fingerprinter: async () => ({ ...sampleFingerprint(3, 99), exact: await sha256Hex(other) }) });
    expect((await getDocument("doc-a"))?.templateStale).toBeDefined();
    const plan = await planOf(blob);
    expect(await applyLibraryImport(plan, { "doc-a": "replace" })).toMatchObject({ ok: true, documentsReplaced: 1 });
    // Las plantillas se configuraron sobre el PDF 1, que es el que vuelve: ya no hay aviso.
    expect((await getDocument("doc-a"))?.templateStale).toBeUndefined();
  });

  it("Reemplazar sin plantillas que se conserven no marca «desactualizada»", async () => {
    await seedDoc("doc-a", 1);
    const blob = await exportBlob();
    await replaceDocumentBytes("doc-a", fakePdf(50), { fingerprinter: async (bytes) => ({ ...sampleFingerprint(3, 50), exact: await sha256Hex(bytes) }) });
    const plan = await planOf(blob);
    await applyLibraryImport(plan, { "doc-a": "replace" });
    expect((await getDocument("doc-a"))?.templateStale).toBeUndefined();
  });

  it("mismo PDF con una plantilla NUEVA: Distinto (templates), «Añadir» solo trae lo que falta", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    await seedTemplate("doc-a", singleSignerDraft, "tpl-b");
    const blob = await exportBlob();
    const { deleteTemplate } = await import("@/lib/docLibrary/templatesStore");
    await deleteTemplate("tpl-b");
    const plan = await planOf(blob);
    const item = byKey(plan, "doc-a");
    expect(item).toMatchObject({ status: "different", difference: "templates", changesTemplates: false });
    expect(item.templates.map((row) => [row.id, row.status])).toEqual([
      ["tpl-a", "identical"],
      ["tpl-b", "new"],
    ]);
    expect(libraryDecisionOptions(item)).toEqual(["import", "omit"]);
    expect(defaultLibraryDecisions(plan)["doc-a"]).toBe("import");
    // «Reemplazar» no es coherente aquí: no se aprueba.
    expect(await applyLibraryImport(plan, { "doc-a": "replace" })).toMatchObject({ ok: true, templates: 0 });
    const result = await applyLibraryImport(plan, { "doc-a": "import" });
    expect(result).toMatchObject({ ok: true, documents: 0, templates: 1, templatesReplaced: 0 });
    expect((await getDocument("doc-a"))?.templateIds.sort()).toEqual(["tpl-a", "tpl-b"]);
  });

  it("plantilla con el mismo id y otro contenido: Reemplazar da una versión nueva; Conservar ambas hace una copia; Omitir no toca", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    const { saveTemplateVersion } = await import("@/lib/docLibrary/templatesStore");
    const current = (await getTemplate("tpl-a"))!;
    await saveTemplateVersion({ ...current, name: "Editada aquí" }, { expectedRev: current.rev });
    const plan = await planOf(blob);
    const item = byKey(plan, "doc-a");
    expect(item).toMatchObject({ status: "different", difference: "templates", changesTemplates: true });
    expect(item.templates[0]).toMatchObject({ id: "tpl-a", status: "different" });
    expect(defaultLibraryDecisions(plan)["doc-a"]).toBe("omit");

    expect(await applyLibraryImport(plan, { "doc-a": "omit" })).toMatchObject({ ok: true, templates: 0, skipped: 1 });
    expect((await getTemplate("tpl-a"))?.name).toBe("Editada aquí");

    const copied = await applyLibraryImport(plan, { "doc-a": "keepBoth" });
    expect(copied).toMatchObject({ ok: true, templates: 1, templatesReplaced: 0, reassigned: 1 });
    expect((await listTemplates()).templates).toHaveLength(2);
    expect((await getDocument("doc-a"))?.templateIds).toHaveLength(2);

    // Tras la copia, el contenido del paquete ya está: otra vez «idéntico» para esa plantilla.
    const second = await planOf(blob);
    expect(byKey(second, "doc-a").templates[0].status).toBe("identical");
  });

  it("Reemplazar una plantilla: versión nueva con la anterior en el historial", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    const { saveTemplateVersion } = await import("@/lib/docLibrary/templatesStore");
    const current = (await getTemplate("tpl-a"))!;
    await saveTemplateVersion({ ...current, name: "Editada aquí" }, { expectedRev: current.rev });
    const plan = await planOf(blob);
    expect(await applyLibraryImport(plan, { "doc-a": "replace" })).toMatchObject({ ok: true, templatesReplaced: 1, templates: 0 });
    const template = (await getTemplate("tpl-a"))!;
    expect(template.name).toBe("Contrato de servicio");
    expect(template.version).toBe(3);
    expect((await getTemplateVersions("tpl-a")).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it("plantillas sueltas («sin documento»): nuevas, idénticas y distintas", async () => {
    await seedTemplate(null, {}, "huerfana");
    const blob = await exportBlob();
    expect(await planOf(blob)).toMatchObject({ counts: { identical: 1 } });
    const { clearLibrary: clear } = await import("@/lib/docLibrary/store");
    await clear();
    const plan = await planOf(blob);
    expect(plan.items[0]).toMatchObject({ kind: "template", status: "new", key: "huerfana" });
    expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toMatchObject({ ok: true, templates: 1, documents: 0 });
    expect((await getTemplate("huerfana"))?.documentId).toBeNull();
  });

  it("un id ocupado por OTRO documento al aplicar (apareció tras la vista previa) se reasigna, no se pisa", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    await clearLibrary();
    const plan = await planOf(blob);
    // Entre la vista previa y «Importar», otra pestaña guarda OTRO documento con el mismo id y una plantilla con el mismo id.
    await seedDoc("doc-a", 42, { name: "Ajeno" });
    await seedTemplate("doc-a", singleSignerDraft, "tpl-a");
    const result = await applyLibraryImport(plan, { "doc-a": "import" });
    expect(result).toMatchObject({ ok: true, documents: 1, templates: 1, reassigned: 2 });
    expect((await getDocument("doc-a"))?.name).toBe("Ajeno");
    expect((await getTemplate("tpl-a"))?.name).toBe("Solo una firma");
    const docs = (await listDocuments()).documents;
    expect(docs).toHaveLength(2);
    const imported = docs.find((d) => d.id !== "doc-a")!;
    expect((await getTemplate(imported.templateIds[0]))?.name).toBe("Contrato de servicio");
  });

  it("si el mismo PDF ya llegó desde la vista previa, no se duplica: changed y no se escribe nada", async () => {
    await seedDoc("doc-a", 1);
    const blob = await exportBlob();
    await clearLibrary();
    const plan = await planOf(blob);
    await seedDoc("otro", 1); // mismo PDF que el del paquete
    const before = await snapshotLibrary();
    expect(await applyLibraryImport(plan, { "doc-a": "import" })).toEqual({ ok: false, reason: "changed" });
    expect(await snapshotLibrary()).toEqual(before);
  });

  it("lo que se iba a reemplazar cambió desde la vista previa: changed y nada escrito", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    await replaceDocumentBytes("doc-a", fakePdf(7), { fingerprinter: async (bytes) => ({ ...sampleFingerprint(3, 7), exact: await sha256Hex(bytes) }) });
    const plan = await planOf(blob);
    const { renameDocument } = await import("@/lib/docLibrary/store");
    await renameDocument("doc-a", "Renombrado en otra pestaña");
    const before = await snapshotLibrary();
    expect(await applyLibraryImport(plan, { "doc-a": "replace" })).toEqual({ ok: false, reason: "changed" });
    expect(await snapshotLibrary()).toEqual(before);
  });
});

describe("un destino se toca una sola vez y lo que cambió no se pisa", () => {
  it("dos elementos del archivo que reclaman el mismo documento tuyo: solo el primero reemplaza", async () => {
    // Local: el documento «x» (PDF 1) con una plantilla. Archivo: «x» con OTRO PDF (reclama a «x» por el id) y «y» con el
    // PDF 1 (reclama a «x» por el contenido) con una versión distinta de su plantilla. Dos elementos, un mismo destino.
    await seedDoc("x", 2);
    await seedDoc("y", 1);
    await seedTemplate("y", { name: "Nueva 1" }, "t1");
    const blob = await exportBlob();
    await clearLibrary();
    await seedDoc("x", 1);
    await seedTemplate("x", { name: "Vieja 1" }, "t1");
    const plan = await planOf(blob);
    expect(plan.items.map((i) => [i.key, i.status, i.difference])).toEqual([
      ["x", "different", "pdf"],
      ["y", "different", "templates"],
    ]);
    expect(plan.items.map((i) => i.conflictWith?.id)).toEqual(["x", "x"]);
    const check = checkLibraryLimits(plan, { x: "replace", y: "replace" });
    expect(check.wanted).toBe(1);
    expect(await applyLibraryImport(plan, { x: "replace", y: "replace" })).toMatchObject({ ok: true, documentsReplaced: 1, templatesReplaced: 0 });
    expect((await getTemplate("t1"))?.name).toBe("Vieja 1");
  });

  it("la plantilla que se iba a reemplazar se editó desde la vista previa: changed y nada escrito", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob();
    const { saveTemplateVersion } = await import("@/lib/docLibrary/templatesStore");
    const current = (await getTemplate("tpl-a"))!;
    await saveTemplateVersion({ ...current, name: "Editada" }, { expectedRev: current.rev });
    const plan = await planOf(blob);
    expect(byKey(plan, "doc-a")).toMatchObject({ difference: "templates", changesTemplates: true });
    const again = (await getTemplate("tpl-a"))!;
    await saveTemplateVersion({ ...again, name: "Editada otra vez" }, { expectedRev: again.rev });
    const before = await snapshotLibrary();
    expect(await applyLibraryImport(plan, { "doc-a": "replace" })).toEqual({ ok: false, reason: "changed" });
    expect(await snapshotLibrary()).toEqual(before);
  });
});

describe("«plantilla desactualizada» al importar", () => {
  it("se recalcula: el aviso del paquete se conserva si sigue siendo válido y se descarta si ya no", async () => {
    // Documento con plantilla; el PDF se reemplaza por otro contrato → desactualizada.
    const a = await seedDoc("doc-a", 1, { pages: 3 });
    await seedTemplate("doc-a", {}, "tpl-a");
    const newBytes = fakePdf(60);
    const otherFp = { ...sampleFingerprint(3, 60), exact: await sha256Hex(newBytes) };
    await replaceDocumentBytes("doc-a", newBytes, { fingerprinter: async () => otherFp });
    const stale = (await getDocument("doc-a"))!;
    expect(stale.templateStale).toBeDefined();
    const blob = await exportBlob();
    const baseExact = a.entry.fingerprint.exact;
    expect(stale.templateStale?.base.exact).toBe(baseExact);

    await clearLibrary();
    const plan = await planOf(blob);
    await applyLibraryImport(plan, defaultLibraryDecisions(plan));
    const restored = (await getDocument("doc-a"))!;
    expect(restored.templateStale).toMatchObject({ since: stale.templateStale?.since, level: stale.templateStale?.level });
    expect(restored.templateStale?.base.exact).toBe(baseExact);
  });

  it("sin plantillas importadas no queda aviso (no hay nada que desactualizar)", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const newBytes = fakePdf(61);
    await replaceDocumentBytes("doc-a", newBytes, { fingerprinter: async () => ({ ...sampleFingerprint(3, 61), exact: await sha256Hex(newBytes) }) });
    expect((await getDocument("doc-a"))?.templateStale).toBeDefined();
    const blob = await exportBlob();
    await clearLibrary();
    // Se pierde el archivo de la plantilla dentro del paquete: el documento entra, la plantilla es inválida.
    const read = await readPackage(blob);
    read.modules[0].files.delete("templates/tpl-a.json");
    const plan = await planLibraryImport(read, await loadLibraryExisting());
    expect(plan.items.map((i) => [i.key, i.status, i.reason])).toEqual([
      ["doc-a", "new", undefined],
      ["tpl-a", "invalid", "integrity"],
    ]);
    expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toMatchObject({ ok: true, documents: 1, templates: 0 });
    const doc = (await getDocument("doc-a"))!;
    expect(doc.templateIds).toEqual([]);
    expect(doc.templateStale).toBeUndefined();
  });

  it("si el PDF del paquete vuelve a coincidir con el de la plantilla, el aviso desaparece", async () => {
    const a = await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const blob = await exportBlob(); // al día
    await clearLibrary();
    const read = await readPackage(blob);
    const plan = await planLibraryImport(read, await loadLibraryExisting());
    await applyLibraryImport(plan, defaultLibraryDecisions(plan));
    expect((await getDocument("doc-a"))?.templateStale).toBeUndefined();
    expect((await getDocument("doc-a"))?.fingerprint.exact).toBe(a.entry.fingerprint.exact);
  });
});

describe("límites", () => {
  async function bigPackage(count: number, size = 120) {
    const mod = {
      name: "library",
      schemaVersion: 1,
      files: [] as Array<{ path: string; data: Uint8Array; type: string }>,
    };
    const index: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const bytes = fakePdf(1000 + i, size);
      const fp = await fingerprintOf(bytes, 2, 1000 + i);
      const { pages, ...rest } = fp;
      index.push({
        id: `n${i}`,
        name: `Nuevo ${i}`,
        docType: "x",
        fileName: `n${i}.pdf`,
        pageCount: fp.pageCount,
        pageSizes: fp.pageSizes,
        fingerprint: { ...rest, pages: pages.map((p) => ({ textHash: p.textHash, minhash: Buffer.from(new Uint32Array(p.minhash).buffer).toString("base64") })) },
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-01T10:00:00.000Z",
        byteLength: bytes.length,
        file: `documents/n${i}.pdf`,
      });
      mod.files.push({ path: `documents/n${i}.pdf`, data: bytes, type: "application/pdf" });
    }
    mod.files.unshift({ path: "documents/index.json", data: new TextEncoder().encode(JSON.stringify(index)), type: "application/json" });
    return buildPackage({ modules: [mod] });
  }

  it("avisa cuántos caben ANTES de escribir (50 documentos) y no escribe ninguno si no caben todos", async () => {
    for (let i = 0; i < 48; i += 1) await seedDoc(`e${i}`, 2000 + i, { size: 80 });
    const plan = await planOf(await bigPackage(5));
    const decisions = defaultLibraryDecisions(plan);
    const check = checkLibraryLimits(plan, decisions);
    expect(check).toMatchObject({ wanted: 5, fits: 2, ok: false, blockedBy: "documents", documentsAfter: 50 });
    const before = await snapshotLibrary();
    expect(await applyLibraryImport(plan, decisions)).toMatchObject({ ok: false, reason: "limit", fits: 2, wanted: 5 });
    expect(await snapshotLibrary()).toEqual(before);
    // Omitiendo tres, caben.
    const fewer = { ...decisions, n2: "omit", n3: "omit", n4: "omit" } as Record<string, LibraryDecision>;
    expect(checkLibraryLimits(plan, fewer)).toMatchObject({ wanted: 2, fits: 2, ok: true });
    expect(await applyLibraryImport(plan, fewer)).toMatchObject({ ok: true, documents: 2 });
    expect((await listDocuments()).documents).toHaveLength(50);
  });

  it("espacio total (400 MiB) y espacio libre del navegador", async () => {
    await seedDoc("e0", 1, { size: 80 });
    const plan = await planOf(await bigPackage(2, 500));
    const decisions = defaultLibraryDecisions(plan);
    const tight = { ...plan, limits: { ...plan.limits, maxTotalBytes: plan.limits.currentBytes + 700 } } as LibraryPlan;
    expect(checkLibraryLimits(tight, decisions)).toMatchObject({ fits: 1, wanted: 2, blockedBy: "bytes" });
    const quota = { ...plan, limits: { ...plan.limits, browser: { usage: 900, quota: 1000 } } } as LibraryPlan;
    expect(checkLibraryLimits(quota, decisions)).toMatchObject({ fits: 0, blockedBy: "quota", addedBytes: 0 });
    const roomy = { ...plan, limits: { ...plan.limits, browser: { usage: 0, quota: 10_000 } } } as LibraryPlan;
    expect(checkLibraryLimits(roomy, decisions)).toMatchObject({ ok: true, addedBytes: 1000, addedDocuments: 2 });
  });

  it("20 plantillas por documento", async () => {
    await seedDoc("doc-a", 1);
    for (let i = 0; i < 3; i += 1) await seedTemplate("doc-a", { name: `Del paquete ${i}` }, `p${i}`);
    const blob = await exportBlob();
    await clearLibrary();
    await seedDoc("doc-a", 1);
    for (let i = 0; i < 19; i += 1) await seedTemplate("doc-a", { name: `Mía ${i}` }, `m${i}`);
    const plan = await planOf(blob);
    const item = byKey(plan, "doc-a");
    expect(item).toMatchObject({ status: "different", difference: "templates", changesTemplates: false });
    const decisions = defaultLibraryDecisions(plan);
    expect(checkLibraryLimits(plan, decisions)).toMatchObject({ wanted: 1, fits: 0, ok: false, blockedBy: "perDocument" });
    const before = await snapshotLibrary();
    expect(await applyLibraryImport(plan, decisions)).toMatchObject({ ok: false, reason: "limit" });
    expect(await snapshotLibrary()).toEqual(before);
  });

  it("200 plantillas en total", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "p0");
    const blob = await exportBlob();
    await clearLibrary();
    for (let i = 0; i < 200; i += 1) await seedTemplate(null, { name: `Suelta ${i}` }, `s${i}`);
    const plan = await planOf(blob);
    const decisions = defaultLibraryDecisions(plan);
    expect(checkLibraryLimits(plan, decisions)).toMatchObject({ fits: 0, blockedBy: "templates", templatesAfter: 200 });
    expect(await applyLibraryImport(plan, decisions)).toMatchObject({ ok: false, reason: "limit" });
    expect((await listDocuments()).documents).toHaveLength(0);
  });
});

describe("atomicidad", () => {
  it("un fallo de cuota a mitad de la transacción no deja NADA escrito", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    await seedDoc("doc-b", 2);
    const blob = await exportBlob();
    await clearLibrary();
    await seedDoc("local", 9);
    const plan = await planOf(blob);
    expect(plan.counts.new).toBe(2);
    const before = await snapshotLibrary();
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      calls += 1;
      if (calls === 4) throw new DOMException("sin espacio", "QuotaExceededError");
      return original.apply(this, args);
    };
    try {
      expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toEqual({ ok: false, reason: "quota" });
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(await snapshotLibrary()).toEqual(before);
    // Y reintentando sin el fallo, entra todo.
    expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toMatchObject({ ok: true, documents: 2, templates: 1 });
  });

  it("sin IndexedDB al aplicar: unavailable", async () => {
    await seedDoc("doc-a", 1);
    const blob = await exportBlob();
    await clearLibrary();
    const plan = await planOf(blob);
    const { __resetLibraryForTests } = await import("@/lib/docLibrary/store");
    __resetLibraryForTests();
    // @ts-expect-error simula un navegador sin IndexedDB
    delete globalThis.indexedDB;
    expect(await applyLibraryImport(plan, { "doc-a": "import" })).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("el plan no se puede falsificar", () => {
  it("rechaza objetos que no salieron de planLibraryImport", async () => {
    await seedDoc("doc-a", 1);
    const plan = await planOf(await exportBlob());
    await clearLibrary();
    const forged = JSON.parse(JSON.stringify(plan)) as LibraryPlan;
    expect(await applyLibraryImport(forged, { "doc-a": "import" })).toEqual({ ok: false, reason: "invalid" });
    expect(await applyLibraryImport({ ...plan }, { "doc-a": "import" })).toEqual({ ok: false, reason: "invalid" });
    // @ts-expect-error entrada absurda
    expect(await applyLibraryImport(null, {})).toEqual({ ok: false, reason: "invalid" });
  });

  it("el plan emitido está congelado: no se le puede cambiar el PDF ni los elementos", async () => {
    await seedDoc("doc-a", 1);
    const blob = await exportBlob();
    await clearLibrary();
    const plan = await planOf(blob);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.items)).toBe(true);
    expect(Object.isFrozen(plan.items[0])).toBe(true);
    expect(() => {
      "use strict";
      (plan.items[0] as { status: string }).status = "identical";
    }).toThrow();
  });

  it("si los bytes del PDF del plan se alteran en memoria, no se escribe (SHA-256 revalidado)", async () => {
    await seedDoc("doc-a", 1);
    const blob = await exportBlob();
    await clearLibrary();
    const plan = await planOf(blob);
    const pdf = plan.items[0].pdf as Uint8Array;
    pdf[pdf.length - 1] ^= 0xff;
    expect(await applyLibraryImport(plan, { "doc-a": "import" })).toEqual({ ok: false, reason: "invalid" });
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("decisiones desconocidas, heredadas o incoherentes no aprueban nada", async () => {
    await seedDoc("doc-a", 1);
    const blob = await exportBlob();
    await clearLibrary();
    const plan = await planOf(blob);
    for (const decisions of [{}, { "doc-a": "omit" }, { "doc-a": "replace" }, { "doc-a": "keepBoth" }, { "doc-a": "borrar-todo" }, Object.create({ "doc-a": "import" })]) {
      expect(await applyLibraryImport(plan, decisions as Record<string, LibraryDecision>)).toMatchObject({ ok: true, documents: 0 });
    }
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("un plan sin biblioteca (módulo ausente / versión más nueva / dañado) se bloquea", async () => {
    await seedDoc("doc-a", 1);
    const blob = await exportBlob();
    const read = await readPackage(blob);
    const absent = await planLibraryImport({ ...read, modules: [] }, { documents: [], templates: [] });
    expect(absent.state).toBe("absent");
    expect(await applyLibraryImport(absent, {})).toEqual({ ok: false, reason: "blocked" });
    const newer = await planLibraryImport({ ...read, modules: [{ ...read.modules[0], status: "newerVersion", message: "Creado con una versión más nueva de OptimusPDF; actualiza la página.", files: new Map() }] }, { documents: [], templates: [] });
    expect(newer).toMatchObject({ state: "newerVersion", message: expect.stringContaining("versión más nueva") });
  });
});

describe("migraciones", () => {
  it("v1 → v1 es identidad y una versión sin paso falla", () => {
    const raw = { documents: [], templateIndex: [], templates: new Map() };
    expect(migrateLibrary(raw, 1)).toBe(raw);
    expect(() => migrateLibrary(raw, 2)).toThrow();
    expect(() => migrateLibrary(raw, 0)).toThrow();
  });

  it("la spec del registro declara sus carpetas", () => {
    expect(LIBRARY_MODULE_SPEC).toMatchObject({ name: "library", schemaVersion: 1, folders: ["documents", "templates"] });
  });
});
