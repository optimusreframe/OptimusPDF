import "fake-indexeddb/auto";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetLibraryForTests, clearLibrary, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import {
  applyLibraryImport,
  defaultLibraryDecisions,
  exportLibraryWithReport,
  loadLibraryExisting,
  planLibraryImport,
  type LibraryPlan,
} from "@/lib/backup/modules/library";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { sha256Hex } from "@/lib/crypto/sha256";

/**
 * H6 (verificación independiente): un paquete que trae el MISMO PDF bajo dos ids hacía fallar TODO el módulo `library`
 * con «changed» («tus datos cambiaron mientras revisabas»), un mensaje engañoso. Ahora el plan detecta el repetido
 * dentro del paquete: se importa una vez, el otro queda «idéntico (repetido en el paquete)» y sus plantillas se vinculan
 * al que sí se importa.
 */

const PASS = { validatePdf: async () => true };

beforeEach(async () => {
  window.localStorage.clear();
  __resetLibraryForTests();
  await clearLibrary();
});

/** Paquete con doc-a y doc-b; luego se clona doc-a como `doc-a2` (otro id, MISMO PDF) con una plantilla propia. */
async function duplicatedPackage(): Promise<Blob> {
  await seedDoc("doc-a", 1);
  await seedDoc("doc-b", 2);
  await seedTemplate("doc-a", {}, "tpl-a");
  const { module } = await exportLibraryWithReport();
  const blob = await buildPackage({ modules: [module] });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  const index = JSON.parse(await zip.file("documents/index.json")!.async("string"));
  const templatesIndex = JSON.parse(await zip.file("templates/index.json")!.async("string"));
  const a = index.find((d: { id: string }) => d.id === "doc-a");
  const bytesA = await zip.file(a.file)!.async("uint8array");
  index.push({ ...a, id: "doc-a2", file: "documents/doc-a2.pdf" });
  zip.file("documents/doc-a2.pdf", bytesA);
  manifest.files.push({ path: "documents/doc-a2.pdf", sha256: await sha256Hex(bytesA), bytes: bytesA.length, type: "application/pdf" });
  // La plantilla del clon: copia de la de doc-a pero atada a doc-a2 y con otro id.
  const tplA = JSON.parse(await zip.file(templatesIndex[0].file)!.async("string"));
  const clone = { ...tplA, id: "tpl-a2", name: "Plantilla del clon", documentId: "doc-a2" };
  const cloneBytes = new TextEncoder().encode(JSON.stringify(clone));
  zip.file("templates/tpl-a2.json", cloneBytes);
  templatesIndex.push({ id: "tpl-a2", file: "templates/tpl-a2.json" });
  manifest.files.push({ path: "templates/tpl-a2.json", sha256: await sha256Hex(cloneBytes), bytes: cloneBytes.length, type: "application/json" });
  for (const [path, value] of [["documents/index.json", index], ["templates/index.json", templatesIndex]] as const) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    zip.file(path, bytes);
    const entry = manifest.files.find((f: { path: string }) => f.path === path);
    entry.sha256 = await sha256Hex(bytes);
    entry.bytes = bytes.length;
  }
  zip.file("manifest.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "blob" });
}

async function planFor(blob: Blob): Promise<LibraryPlan> {
  return planLibraryImport(await readPackage(blob), await loadLibraryExisting(), PASS);
}

describe("H6 — el mismo PDF bajo dos ids dentro del paquete", () => {
  it("el plan marca el repetido como idéntico (repetido en el paquete) y le pasa sus plantillas al primero", async () => {
    const blob = await duplicatedPackage();
    await clearLibrary();
    const plan = await planFor(blob);
    const byId = Object.fromEntries(plan.items.map((item) => [item.id, item]));
    expect(byId["doc-a"].status).toBe("new");
    expect(byId["doc-a2"]).toMatchObject({ status: "identical", duplicateOf: { key: "doc-a", name: byId["doc-a"].name } });
    expect(byId["doc-a2"].templates).toEqual([]);
    expect(byId["doc-a"].templates.map((row) => row.id).sort()).toEqual(["tpl-a", "tpl-a2"]);
    // El repetido no suma a ningún recuento («ya lo tienes» sería falso): 2 elementos reales.
    expect(plan.counts).toEqual({ new: 2, identical: 0, different: 0, invalid: 0 });
  });

  it("aplicar con las decisiones por defecto importa UNA vez el PDF, con las plantillas de ambos, y no falla con «changed»", async () => {
    const blob = await duplicatedPackage();
    await clearLibrary();
    const plan = await planFor(blob);
    const result = await applyLibraryImport(plan, defaultLibraryDecisions(plan));
    expect(result).toMatchObject({ ok: true, documents: 2, templates: 2 });
    const docs = await listDocuments();
    expect(docs.documents.map((d) => d.id).sort()).toEqual(["doc-a", "doc-b"]);
    const templates = (await listTemplates()).templates;
    expect(templates.map((t) => [t.id, t.documentId]).sort()).toEqual([["tpl-a", "doc-a"], ["tpl-a2", "doc-a"]]);
    const owner = docs.documents.find((d) => d.id === "doc-a");
    expect([...(owner?.templateIds ?? [])].sort()).toEqual(["tpl-a", "tpl-a2"]);
  });

  it("si el repetido se omite no se escribe nada de él; elegirlo explícitamente tampoco lo importa (no hay decisión que ofrecer)", async () => {
    const blob = await duplicatedPackage();
    await clearLibrary();
    const plan = await planFor(blob);
    const decisions = { ...defaultLibraryDecisions(plan), "doc-a2": "import" as const };
    const result = await applyLibraryImport(plan, decisions);
    expect(result).toMatchObject({ ok: true, documents: 2 });
    expect((await listDocuments()).documents).toHaveLength(2);
  });

  it("repetido de un PDF que YA tienes en la biblioteca: los dos del paquete quedan idénticos y se añaden sus plantillas al que tienes", async () => {
    const blob = await duplicatedPackage();
    await clearLibrary();
    await seedDoc("doc-a", 1);
    const plan = await planFor(blob);
    const byId = Object.fromEntries(plan.items.map((item) => [item.id, item]));
    expect(byId["doc-a2"].status).toBe("identical");
    expect(byId["doc-a"].templates.map((row) => row.id).sort()).toEqual(["tpl-a", "tpl-a2"]);
    const result = await applyLibraryImport(plan, defaultLibraryDecisions(plan));
    expect(result.ok).toBe(true);
    expect((await listDocuments()).documents.map((d) => d.id).sort()).toEqual(["doc-a", "doc-b"]);
    expect((await listTemplates()).templates).toHaveLength(2);
  });

  it("si el PDF repetido no pasa la puerta de entrada, sus dos copias quedan inválidas y no se escribe nada", async () => {
    const blob = await duplicatedPackage();
    await clearLibrary();
    const read = await readPackage(blob);
    const plan = await planLibraryImport(read, await loadLibraryExisting(), {
      validatePdf: async (bytes) => {
        const sha = await sha256Hex(bytes);
        return sha !== (await sha256Hex(await firstPdf(blob)));
      },
    });
    const byId = Object.fromEntries(plan.items.map((item) => [item.id, item]));
    expect(byId["doc-a"].status).toBe("invalid");
    expect(byId["doc-a2"].status).toBe("invalid");
    expect(byId["doc-b"].status).toBe("new");
    const result = await applyLibraryImport(plan, defaultLibraryDecisions(plan));
    expect(result).toMatchObject({ ok: true, documents: 1 });
  });
});

async function firstPdf(blob: Blob): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const index = JSON.parse(await zip.file("documents/index.json")!.async("string"));
  const a = index.find((d: { id: string }) => d.id === "doc-a");
  return zip.file(a.file)!.async("uint8array");
}
