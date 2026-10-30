import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetLibraryForTests, clearLibrary } from "@/lib/docLibrary/store";
import {
  applyEverything,
  defaultEverythingDecisions,
  exportEverything,
  readAndPlanEverything,
  type EverythingPlans,
} from "@/lib/backup/globalPackage";
import { outcomeLines } from "@/app/settings/packageModel";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { clearAllLocalDrafts } from "@/lib/backup/__fixtures__/draftsKit";
import { editManifest, asFile, vaultInput } from "@/lib/backup/__fixtures__/testKit";

/**
 * H4 (verificación independiente): al importar un paquete que no traía todos los módulos, el resultado decía «no se
 * importó» de los que NUNCA estuvieron (el plan nulo se leía como `unavailable`). Ahora «el paquete no lo incluye»
 * (`absent`) es distinto de un fallo real (`unavailable`, `damaged`, `newerVersion`), en el resumen y en la interfaz ES/EN.
 */

const PASS = { validatePdf: async () => true, validateImage: async () => true } as const;

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
});

async function signaturesOnlyPlans(): Promise<EverythingPlans> {
  await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
  const exported = await exportEverything({ modules: { signatures: true } });
  if (!exported.ok) throw new Error(exported.reason);
  await clearVault();
  const read = await readAndPlanEverything(asFile(exported.blob), undefined, PASS);
  if (!read.ok) throw new Error(read.reason);
  return read.plans;
}

describe("H4 — «el paquete no lo incluye» no es un fallo", () => {
  it("un paquete de solo firmas: los demás módulos quedan `absent`, no `unavailable`", async () => {
    const plans = await signaturesOnlyPlans();
    expect(plans.absent).toEqual(["library", "drafts", "scanSessions", "settings"]);
    const result = await applyEverything(plans, defaultEverythingDecisions(plans));
    expect(result.outcomes.map((o) => [o.module, o.status, o.status === "skipped" ? o.why : null])).toEqual([
      ["signatures", "applied", null],
      ["library", "skipped", "absent"],
      ["drafts", "skipped", "absent"],
      ["scanSessions", "skipped", "absent"],
      ["settings", "skipped", "absent"],
    ]);
  });

  it("ES: una sola línea «El paquete no incluye: …» y ningún «no se importó» de lo que no venía", async () => {
    const plans = await signaturesOnlyPlans();
    const result = await applyEverything(plans, defaultEverythingDecisions(plans));
    const lines = outcomeLines(result.outcomes, es.settings.backup).map((l) => l.text);
    expect(lines).toEqual(["Firmas: 1 importadas.", "El paquete no incluye: Plantillas y documentos, Borradores, Escaneos en curso, Ajustes."]);
    expect(lines.join(" ")).not.toMatch(/no se import/i);
  });

  it("EN: lo mismo en inglés", async () => {
    const plans = await signaturesOnlyPlans();
    const result = await applyEverything(plans, defaultEverythingDecisions(plans));
    const lines = outcomeLines(result.outcomes, en.settings.backup).map((l) => l.text);
    expect(lines[1]).toBe("The package does not include: Templates and documents, Drafts, Scans in progress, Settings.");
    expect(lines.join(" ")).not.toMatch(/not imported/i);
  });

  it("un módulo que SÍ venía pero no se pudo leer sigue diciendo «no se importó» (fallo real, distinto de ausente)", async () => {
    const plans = await signaturesOnlyPlans();
    // El paquete traía `library` (no está en `absent`) pero no hay plan: no se pudo leer.
    const broken: EverythingPlans = { ...plans, absent: ["drafts", "scanSessions", "settings"] };
    const result = await applyEverything(broken, defaultEverythingDecisions(broken));
    expect(result.outcomes[1]).toMatchObject({ module: "library", status: "skipped", why: "unavailable" });
    const lines = outcomeLines(result.outcomes, es.settings.backup).map((l) => l.text);
    expect(lines).toContain("Plantillas y documentos: no se importó.");
    expect(lines).toContain("El paquete no incluye: Borradores, Escaneos en curso, Ajustes.");
  });

  it("versión más nueva y módulo dañado conservan su motivo (no se confunden con ausente)", async () => {
    window.localStorage.setItem("optimuspdf.theme", "dark");
    const exported = await (async () => {
      await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
      const r = await exportEverything({ modules: { signatures: true, settings: true } });
      if (!r.ok) throw new Error(r.reason);
      return r.blob;
    })();
    const blob = await editManifest(exported, (manifest) => {
      manifest.modules.settings.schemaVersion = 99;
    });
    await clearVault();
    const read = await readAndPlanEverything(asFile(blob), undefined, PASS);
    if (!read.ok) throw new Error(read.reason);
    const result = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
    expect(result.outcomes[4]).toMatchObject({ module: "settings", status: "skipped", why: "newerVersion" });
    expect(result.outcomes[1]).toMatchObject({ status: "skipped", why: "absent" });
    const lines = outcomeLines(result.outcomes, es.settings.backup).map((l) => l.text);
    expect(lines).toContain("Ajustes: no se importó.");
  });
});
