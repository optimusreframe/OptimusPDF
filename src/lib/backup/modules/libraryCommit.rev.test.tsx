import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetLibraryForTests, clearLibrary, listDocuments, renameDocument } from "@/lib/docLibrary/store";
import { listTemplates, saveTemplateVersion } from "@/lib/docLibrary/templatesStore";
import {
  applyLibraryImport,
  defaultLibraryDecisions,
  exportLibraryWithReport,
  loadLibraryExisting,
  planLibraryImport,
  type LibraryDecision,
} from "@/lib/backup/modules/library";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import type { DocTemplate } from "@/lib/docLibrary/templateTypes";

/**
 * H9b (verificación independiente): si `rev` NO subía al reemplazar una plantilla por una importada, ninguna prueba fallaba
 * y una pestaña con la `rev` vieja podía pisar sin aviso la plantilla importada. La `rev` es el candado de concurrencia
 * entre pestañas: cada escritura de la importación la sube, y guardar con la anterior da `conflict`.
 */

const PASS = { validatePdf: async () => true };

beforeEach(async () => {
  window.localStorage.clear();
  __resetLibraryForTests();
  await clearLibrary();
});

const save = (template: DocTemplate, rev: number, name: string) =>
  saveTemplateVersion({ id: template.id, rev, name, roles: template.roles, variants: template.variants, layout: template.layout });

async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no-conflict";
  } catch (error) {
    return (error as { code?: string }).code ?? "otro";
  }
}

/** Paquete con la plantilla `tpl-1` llamada «VERSION DEL PAQUETE»; luego el navegador local la cambia a otra cosa. */
async function packageWithNewerTemplateThenLocalEdit() {
  await seedDoc("doc-a", 1);
  await seedTemplate("doc-a", {}, "tpl-1");
  const first = (await listTemplates()).templates[0];
  await save(first, first.rev, "Plantilla VERSION DEL PAQUETE");
  const { module } = await exportLibraryWithReport();
  const blob = await buildPackage({ modules: [module] });
  const middle = (await listTemplates()).templates[0];
  await save(middle, middle.rev, "Mi version local");
  return blob;
}

describe("H9b — la importación sube la `rev` de lo que reemplaza (candado entre pestañas)", () => {
  it("reemplazar una plantilla: rev + 1, y guardar con la rev anterior da `conflict` (no la pisa a ciegas)", async () => {
    const blob = await packageWithNewerTemplateThenLocalEdit();
    const staleRev = (await listTemplates()).templates[0].rev;
    const plan = await planLibraryImport(await readPackage(blob), await loadLibraryExisting(), PASS);
    const decisions: Record<string, LibraryDecision> = { ...defaultLibraryDecisions(plan) };
    for (const key of Object.keys(decisions)) if (decisions[key] !== "omit" || plan.items.find((i) => i.key === key)?.status === "different") decisions[key] = "replace";
    const result = await applyLibraryImport(plan, decisions);
    expect(result).toMatchObject({ ok: true, templatesReplaced: 1 });
    const after = (await listTemplates()).templates[0];
    expect(after.name).toBe("Plantilla VERSION DEL PAQUETE");
    expect(after.rev).toBe(staleRev + 1);
    expect(await code(() => save(after, staleRev, "Edicion de la pestana vieja"))).toBe("conflict");
    expect((await listTemplates()).templates[0].name).toBe("Plantilla VERSION DEL PAQUETE");
    // con la rev nueva sí se puede guardar
    expect(await code(() => save(after, after.rev, "Edicion con la rev al dia"))).toBe("no-conflict");
  });

  it("reemplazar el PDF de un documento sube la `rev` del documento: renombrarlo con la rev vieja da `conflict`", async () => {
    await seedDoc("doc-a", 1, { name: "Contrato A" });
    const { module } = await exportLibraryWithReport();
    const blob = await buildPackage({ modules: [module] });
    // Local: el mismo id con otro PDF -> «Distinto» (PDF) -> Reemplazar.
    await clearLibrary();
    await seedDoc("doc-a", 2, { name: "Contrato A local" });
    const staleRev = (await listDocuments()).documents[0].rev;
    const plan = await planLibraryImport(await readPackage(blob), await loadLibraryExisting(), PASS);
    expect(plan.items[0]).toMatchObject({ status: "different", difference: "pdf" });
    const result = await applyLibraryImport(plan, { [plan.items[0].key]: "replace" });
    expect(result).toMatchObject({ ok: true, documentsReplaced: 1 });
    const after = (await listDocuments()).documents[0];
    expect(after.rev).toBe(staleRev + 1);
    expect(await code(() => renameDocument("doc-a", "Pestana vieja", { expectedRev: staleRev }))).toBe("conflict");
  });

  it("añadir plantillas a un documento que ya tienes (mismo PDF) también sube la `rev` del documento", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-1");
    const { module } = await exportLibraryWithReport();
    const blob = await buildPackage({ modules: [module] });
    // Local: el mismo PDF sin la plantilla -> el paquete trae una plantilla nueva para un PDF que ya tienes.
    await clearLibrary();
    await seedDoc("doc-a", 1);
    const staleRev = (await listDocuments()).documents[0].rev;
    const plan = await planLibraryImport(await readPackage(blob), await loadLibraryExisting(), PASS);
    expect(plan.items[0]).toMatchObject({ status: "different", difference: "templates" });
    const result = await applyLibraryImport(plan, { [plan.items[0].key]: "import" });
    expect(result).toMatchObject({ ok: true, templates: 1 });
    const after = (await listDocuments()).documents[0];
    expect(after.rev).toBe(staleRev + 1);
    expect(after.templateIds).toEqual(["tpl-1"]);
    expect(await code(() => renameDocument("doc-a", "Pestana vieja", { expectedRev: staleRev }))).toBe("conflict");
  });

  it("si la plantilla cambió en otra pestaña entre la vista previa y «Reemplazar», no se escribe nada (`changed`)", async () => {
    const blob = await packageWithNewerTemplateThenLocalEdit();
    const plan = await planLibraryImport(await readPackage(blob), await loadLibraryExisting(), PASS);
    const current = (await listTemplates()).templates[0];
    await save(current, current.rev, "Otra pestana la cambio mientras revisabas");
    const decisions: Record<string, LibraryDecision> = {};
    for (const item of plan.items) decisions[item.key] = item.status === "different" ? "replace" : "omit";
    expect(await applyLibraryImport(plan, decisions)).toMatchObject({ ok: false, reason: "changed" });
    expect((await listTemplates()).templates[0].name).toBe("Otra pestana la cambio mientras revisabas");
  });
});
