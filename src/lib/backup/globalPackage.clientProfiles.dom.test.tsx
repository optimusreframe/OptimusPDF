import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetLibraryForTests, clearLibrary } from "@/lib/docLibrary/store";
import {
  PACKAGE_MODULES,
  applyEverything,
  checkEverythingLimits,
  defaultEverythingDecisions,
  describeExport,
  exportEverything,
  readAndPlanEverything,
  recordBackup,
} from "@/lib/backup/globalPackage";
import { MAX_CLIENT_PROFILES as MODULE_MAX } from "@/lib/backup/modules/clientProfiles";
import { markLastBackup, readLastBackup, readLastBackupParts } from "@/lib/backup/lastBackup";
import { kitProfile, seedProfiles, wipeProfiles } from "@/lib/backup/__fixtures__/clientProfilesKit";
import { clearAllLocalDrafts } from "@/lib/backup/__fixtures__/draftsKit";
import { asFile, vaultInput } from "@/lib/backup/__fixtures__/testKit";
import { lastBackupLine } from "@/app/settings/packageModel";
import { MAX_CLIENT_PROFILES, listClientProfiles } from "@/lib/clientProfile/store";
import { es } from "@/lib/locales/es";

/**
 * «OptimusPDF Package» global con el modulo «Perfiles de cliente» (jsdom): el resumen previo (que cuenta, que se recomienda),
 * exportar junto a otros modulos (con y sin contrasena), la seleccion por perfil, leer y aplicar por la via global y como se anota
 * el respaldo. Los perfiles son PII: el paquete cifrado se recomienda y el recordatorio NO los cuenta.
 */

const PASS = { validatePdf: async () => true, validateImage: async () => true } as const;
const PASSWORD = "clave de prueba 1";
const ANA = () => kitProfile("cp-ana", "Pérez, Ana");
const LUIS = () => kitProfile("cp-luis", "Gómez, Luis", { claimNumber: "CLM-0001" }, "2026-10-21T10:00:00.000Z");

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
  wipeProfiles();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("el modulo", () => {
  it("es parte del paquete, justo antes de Ajustes, y el tope es el del almacen", () => {
    expect(PACKAGE_MODULES).toEqual(["signatures", "library", "drafts", "scanSessions", "clientProfiles", "settings"]);
    expect(MAX_CLIENT_PROFILES).toBe(MODULE_MAX);
    expect(MAX_CLIENT_PROFILES).toBe(20);
  });
});

describe("resumen previo", () => {
  it("cuenta los perfiles, los ofrece sin sus valores y recomienda cifrar (datos de clientes)", async () => {
    seedProfiles([ANA(), LUIS()]);
    const description = await describeExport({ modules: { clientProfiles: true } });
    expect(description.clientProfiles).toMatchObject({ available: true, count: 2, selectedCount: 2 });
    expect(description.clientProfiles.profiles.map((p) => [p.id, p.valueCount]).sort()).toEqual([["cp-ana", 2], ["cp-luis", 3]]);
    expect(JSON.stringify(description)).not.toContain("555-0100");
    expect(description.willInclude).toEqual(["clientProfiles"]);
    expect(description.containsClientData).toBe(true);
    expect(description.encryptionRecommended).toBe(true);
    expect(description.estimatedBytes).toBeGreaterThan(0);
    expect(description.nothingToExport).toBe(false);
  });

  it("elegir solo algunos perfiles cambia lo que se incluye; elegir ninguno lo deja vacio", async () => {
    seedProfiles([ANA(), LUIS()]);
    expect((await describeExport({ modules: { clientProfiles: true }, clientProfileIds: ["cp-luis"] })).clientProfiles.selectedCount).toBe(1);
    const none = await describeExport({ modules: { clientProfiles: true }, clientProfileIds: [] });
    expect(none.willOmitEmpty).toEqual(["clientProfiles"]);
    expect(none.nothingToExport).toBe(true);
  });

  it("sin perfiles: el modulo pedido se omite por vacio y no hay datos de clientes", async () => {
    const description = await describeExport({ modules: { clientProfiles: true } });
    expect(description.willOmitEmpty).toEqual(["clientProfiles"]);
    expect(description.containsClientData).toBe(false);
  });
});

describe("exportar y volver a importar", () => {
  it("junto a las firmas: se incluye, se cuenta y se importa por la via global con cifrado", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    seedProfiles([ANA(), LUIS()]);
    const result = await exportEverything({ modules: { signatures: true, clientProfiles: true }, password: PASSWORD });
    if (!result.ok) throw new Error(result.reason);
    expect(result.included).toEqual(["signatures", "clientProfiles"]);
    expect(result.counts).toMatchObject({ signatures: 1, clientProfiles: 2 });
    expect(result.encrypted).toBe(true);
    await clearVault();
    wipeProfiles();
    const read = await readAndPlanEverything(asFile(result.blob), PASSWORD, PASS);
    if (!read.ok) throw new Error(read.reason);
    expect(read.modules.map((m) => [m.module, m.state, m.counts.new])).toEqual([["signatures", "ok", 1], ["clientProfiles", "ok", 2]]);
    expect(read.plans.absent).toEqual(["library", "drafts", "scanSessions", "settings"]);
    const decisions = defaultEverythingDecisions(read.plans);
    expect(Object.values(decisions.clientProfiles)).toEqual(["import", "import"]);
    expect(checkEverythingLimits(read.plans, decisions)).toMatchObject({ ok: true, wanted: 3, wantedBy: { signatures: 1, clientProfiles: 2 } });
    const applied = await applyEverything(read.plans, decisions);
    expect(applied.failed).toEqual([]);
    expect(applied.applied).toEqual(["signatures", "clientProfiles"]);
    expect(applied.outcomes.map((o) => [o.module, o.status])).toEqual([["signatures", "applied"], ["library", "skipped"], ["drafts", "skipped"], ["scanSessions", "skipped"], ["clientProfiles", "applied"], ["settings", "skipped"]]);
    expect(listClientProfiles().map((p) => p.id).sort()).toEqual(["cp-ana", "cp-luis"]);
  });

  it("solo los perfiles elegidos viajan", async () => {
    seedProfiles([ANA(), LUIS()]);
    const result = await exportEverything({ modules: { clientProfiles: true }, clientProfileIds: ["cp-ana"] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.counts.clientProfiles).toBe(1);
    wipeProfiles();
    const read = await readAndPlanEverything(asFile(result.blob), undefined, PASS);
    if (!read.ok) throw new Error(read.reason);
    expect(read.plans.clientProfiles?.items.map((i) => i.id)).toEqual(["cp-ana"]);
  });

  it("un modulo vacio se omite con aviso y, si es lo unico pedido, no hay paquete", async () => {
    expect(await exportEverything({ modules: { clientProfiles: true } })).toMatchObject({ ok: false, reason: "empty", omitted: [{ module: "clientProfiles", reason: "empty" }] });
  });

  it("20 locales + los del paquete que no caben: el limite bloquea el modulo y NO se escribe nada", async () => {
    seedProfiles([ANA()]);
    const result = await exportEverything({ modules: { clientProfiles: true } });
    if (!result.ok) throw new Error(result.reason);
    seedProfiles(Array.from({ length: MAX_CLIENT_PROFILES }, (_, i) => kitProfile(`cp-local-${i}`, `Local ${i}`)));
    const read = await readAndPlanEverything(asFile(result.blob), undefined, PASS);
    if (!read.ok) throw new Error(read.reason);
    expect(read.plans.clientProfiles).toMatchObject({ state: "ok", local: { count: MAX_CLIENT_PROFILES } });
    const limits = checkEverythingLimits(read.plans, defaultEverythingDecisions(read.plans));
    expect(limits.ok).toBe(false);
    expect(limits.blocked).toEqual(["clientProfiles"]);
    const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
    expect(applied.outcomes.find((o) => o.module === "clientProfiles")).toMatchObject({ status: "failed", reason: "limit" });
    expect(listClientProfiles()).toHaveLength(MAX_CLIENT_PROFILES);
  });
});

describe("como se anota el respaldo", () => {
  it("con firmas sin respaldar, un respaldo solo de perfiles es «parcial (Perfiles de cliente)»: no cuenta como completo", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    seedProfiles([ANA()]);
    expect(await recordBackup(["clientProfiles"], new Date(2026, 9, 20))).toBe(true);
    expect(readLastBackup()).toBeNull();
    expect(Object.keys(readLastBackupParts())).toEqual(["clientProfiles"]);
    const line = lastBackupLine(readLastBackup(), readLastBackupParts(), es.settings.backup, new Date(2026, 9, 20, 12));
    expect(line).toContain("Perfiles de cliente");
  });

  it("un respaldo completo anota tambien los perfiles", () => {
    markLastBackup(new Date(2026, 9, 20));
    expect(Object.keys(readLastBackupParts()).sort()).toContain("clientProfiles");
  });
});
