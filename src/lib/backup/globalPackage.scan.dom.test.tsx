import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetLibraryForTests, clearLibrary } from "@/lib/docLibrary/store";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { PackageError } from "@/lib/backup/types";
import { editManifest, asFile, vaultInput } from "@/lib/backup/__fixtures__/testKit";
import { clearAllLocalDrafts, seedSignDocument } from "@/lib/backup/__fixtures__/draftsKit";
import { bytesBlob, resetScanStore, scanPage, scanSession, seedScanSession, seedSimpleSession } from "@/lib/backup/__fixtures__/scanKit";
import {
  MODULE_WIRE_NAMES,
  PACKAGE_MODULES,
  applyEverything,
  checkEverythingLimits,
  defaultEverythingDecisions,
  describeExport,
  exportEverything,
  moduleFromWireName,
  readAndPlanEverything,
  recordBackup,
} from "@/lib/backup/globalPackage";
import { LARGE_SCAN_BYTES, __setScanSessionsPackageBudgetForTests, exportScanSessions } from "@/lib/backup/modules/scanSessions";
import { markLastBackup, readLastBackup, readLastBackupParts } from "@/lib/backup/lastBackup";
import { lastBackupLine } from "@/app/settings/packageModel";
import { es } from "@/lib/locales/es";
import { listScanSessionSummaries, scanSessionStore } from "@/lib/scan/sessionStore";
import { __resetScanSessionsSizeMemoForTests } from "@/lib/backup/modules/scanSessions";
import { GOLDEN_SCAN_IDS, GOLDEN_SCAN_NOW, GOLDEN_SCAN_PASSWORD } from "@/lib/backup/__fixtures__/goldenScan";

/**
 * «OptimusPDF Package» global con el modulo «Escaneos en curso» (jsdom + fake-indexeddb sobre el almacen REAL del Escaner):
 * el resumen previo (peso, seleccion, lo que no cabe, lo grande), exportar junto a los demas modulos (cifrado), leer y aplicar
 * por la via global, el nombre del modulo en el paquete, los limites y como se anota el respaldo. Las puertas de entrada del
 * navegador (pdf.js, PNG) se sustituyen por `true`.
 */

const PASS = { validatePdf: async () => true, validateImage: async () => true } as const;
const PASSWORD = "clave de prueba 1";

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
  await resetScanStore();
  __setScanSessionsPackageBudgetForTests(undefined);
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setScanSessionsPackageBudgetForTests(undefined);
});

describe("el nombre del modulo", () => {
  it("scanSessions en la interfaz, scan-sessions en el paquete; cada modulo se reconoce por su nombre de paquete", () => {
    expect(PACKAGE_MODULES).toEqual(["signatures", "library", "drafts", "scanSessions", "clientProfiles", "settings"]);
    expect(MODULE_WIRE_NAMES.clientProfiles).toBe("client-profiles");
    expect(MODULE_WIRE_NAMES.scanSessions).toBe("scan-sessions");
    for (const name of PACKAGE_MODULES) expect(moduleFromWireName(MODULE_WIRE_NAMES[name])).toBe(name);
    expect(moduleFromWireName("scanSessions")).toBeNull();
    expect(moduleFromWireName("otro")).toBeNull();
    expect(moduleFromWireName("__proto__")).toBeNull();
  });
});

describe("describeExport con escaneos en curso", () => {
  it("cuenta sesiones, paginas y peso, y los escaneos hacen recomendar el cifrado (son fotos de documentos)", async () => {
    await seedSimpleSession("Contrato A", 3, 1);
    await seedSimpleSession("Recibo B", 2, 20);
    const all = await describeExport({ modules: { scanSessions: true } });
    expect(all.scanSessions).toMatchObject({ available: true, count: 2, selectedCount: 2, selectedPages: 5, fitsInPackage: true, large: false, unreadable: 0 });
    expect(all.scanSessions.sessions.map((s) => s.name).sort()).toEqual(["Contrato A", "Recibo B"]);
    expect(all.scanSessions.bytes).toBe(all.scanSessions.selectedBytes);
    expect(all.willInclude).toEqual(["scanSessions"]);
    expect(all.estimatedBytes).toBe(all.scanSessions.bytes);
    expect(all.containsScanSessions).toBe(true);
    expect(all.containsClientData).toBe(true);
    expect(all.encryptionRecommended).toBe(true);
    expect(all.tooLarge).toBe(false);
  });

  it("la seleccion manda: solo se cuentan las sesiones elegidas, y elegir ninguna deja el modulo vacio", async () => {
    const a = await seedSimpleSession("Contrato A", 3, 1);
    await seedSimpleSession("Recibo B", 2, 20);
    const one = await describeExport({ modules: { scanSessions: true }, scanSessionIds: [a.id] });
    expect(one.scanSessions).toMatchObject({ count: 2, selectedCount: 1, selectedPages: 3 });
    expect(one.scanSessions.selectedBytes).toBeLessThan(one.scanSessions.bytes);
    expect(one.estimatedBytes).toBe(one.scanSessions.selectedBytes);
    const none = await describeExport({ modules: { scanSessions: true }, scanSessionIds: [] });
    expect(none.willInclude).toEqual([]);
    expect(none.willOmitEmpty).toEqual(["scanSessions"]);
    expect(none.nothingToExport).toBe(true);
  });

  it("no mide ninguna sesion si quien llama no menciona el modulo (abrir «Mis documentos» no carga escaneos)", async () => {
    await seedSimpleSession("Contrato A", 2);
    const load = vi.spyOn(scanSessionStore, "load");
    const description = await describeExport({ modules: { signatures: true, library: true, drafts: true, settings: true } });
    expect(load).not.toHaveBeenCalled();
    expect(description.scanSessions).toMatchObject({ count: 0, selectedCount: 0 });
    expect(description.willInclude).not.toContain("scanSessions");
    // Mencionado pero desmarcado: se ofrece (para poder marcarlo) sin incluirlo.
    const offered = await describeExport({ modules: { scanSessions: false } });
    expect(load).toHaveBeenCalled();
    expect(offered.scanSessions.count).toBe(1);
    expect(offered.willInclude).toEqual([]);
  });

  it("lo que no cabe en un paquete marca tooLarge y lo dice con el peso; elegir menos lo arregla", async () => {
    const small = await seedSimpleSession("Pequena", 1, 1);
    await seedSimpleSession("Grande", 4, 10);
    const sizes = await describeExport({ modules: { scanSessions: true } });
    const smallBytes = sizes.scanSessions.sessions.find((s) => s.id === small.id)?.bytes ?? 0;
    __setScanSessionsPackageBudgetForTests(smallBytes + 10);
    const over = await describeExport({ modules: { scanSessions: true } });
    expect(over.scanSessions.fitsInPackage).toBe(false);
    expect(over.tooLarge).toBe(true);
    const fits = await describeExport({ modules: { scanSessions: true }, scanSessionIds: [small.id] });
    expect(fits.scanSessions.fitsInPackage).toBe(true);
    expect(fits.tooLarge).toBe(false);
    // Y exportar lo que no cabe se rechaza ANTES de leer ninguna foto.
    const read = vi.spyOn(Blob.prototype, "arrayBuffer");
    expect(await exportEverything({ modules: { scanSessions: true } })).toMatchObject({ ok: false, reason: "tooLarge" });
    expect(read).not.toHaveBeenCalled();
  });

  it("lo grande (>= 100 MB) se marca para avisar, sin bloquear", async () => {
    await seedSimpleSession("Contrato A", 2);
    const load = scanSessionStore.load;
    vi.spyOn(scanSessionStore, "load").mockImplementation(async (id) => {
      const session = await load(id);
      return session && { ...session, pages: session.pages.map((page) => ({ ...page, original: { size: LARGE_SCAN_BYTES / 2 } as unknown as Blob })) };
    });
    __resetScanSessionsSizeMemoForTests();
    const big = await describeExport({ modules: { scanSessions: true } });
    expect(big.scanSessions).toMatchObject({ large: true, fitsInPackage: true });
    expect(big.tooLarge).toBe(false);
  });

  it("sin IndexedDB el modulo no esta disponible (no lanza)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const description = await describeExport({ modules: { scanSessions: true } });
    expect(description.scanSessions.available).toBe(false);
    expect(description.unavailable).toEqual(["scanSessions"]);
  });
});

describe("exportar junto a los demas modulos", () => {
  it("un paquete cifrado con firmas, un borrador y dos escaneos: el modulo viaja como scan-sessions, se cuenta y se anota", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    await seedSignDocument({ strokes: true });
    await seedSimpleSession("Contrato A", 2, 1);
    await seedSimpleSession("Recibo B", 1, 20);
    const result = await exportEverything({ modules: { signatures: true, drafts: true, scanSessions: true }, password: PASSWORD });
    if (!result.ok) throw new Error(result.reason);
    expect(result.encrypted).toBe(true);
    expect(result.included).toEqual(["signatures", "drafts", "scanSessions"]);
    expect(result.counts).toMatchObject({ signatures: 1, drafts: 1, scanSessions: 2, scanPages: 3 });
    expect(result.scanSkippedPages).toBe(0);
    await expect(readPackage(result.blob)).rejects.toMatchObject({ code: "needsPassword" });
    const read = await readPackage(result.blob, PASSWORD);
    expect(read.modules.map((m) => m.name)).toEqual(["signatures", "drafts", "scan-sessions"]);
    expect(read.modules[2]).toMatchObject({ declaredSchemaVersion: 1, meta: { sessions: 2, pages: 3 } });
    expect(read.warnings).toEqual([]);
    // Cifrado de verdad: ni los nombres de las sesiones ni los bytes de una foto se ven en claro.
    const raw = new TextDecoder("latin1").decode(new Uint8Array(await result.blob.arrayBuffer()));
    expect(raw.includes("Contrato A")).toBe(false);
    expect(raw.includes("scan-sessions")).toBe(false);
  });

  it("sin sesiones, el modulo se omite como «vacio»; con un modulo mas, el paquete sale igual", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    const result = await exportEverything({ modules: { signatures: true, scanSessions: true } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.included).toEqual(["signatures"]);
    expect(result.omitted).toEqual([{ module: "scanSessions", reason: "empty" }]);
    expect(await exportEverything({ modules: { scanSessions: true } })).toMatchObject({ ok: false, reason: "empty" });
  });

  it("solo las sesiones elegidas viajan y las paginas con la foto danada se cuentan aparte", async () => {
    const a = await seedSimpleSession("Contrato A", 1, 1);
    await seedSimpleSession("Recibo B", 1, 20);
    const mixed = await seedScanSession(scanSession([scanPage(40), scanPage(41, { original: bytesBlob(new TextEncoder().encode("no soy una foto")) })], { name: "Mixta" }));
    const result = await exportEverything({ modules: { scanSessions: true }, scanSessionIds: [a.id, mixed] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.counts).toMatchObject({ scanSessions: 2, scanPages: 2 });
    expect(result.scanSkippedPages).toBe(1);
  });

  it("recordBackup cuenta los escaneos vacios como respaldados (nada que perder) y un respaldo de solo escaneos es PARCIAL", async () => {
    await recordBackup(["signatures", "library", "drafts"]);
    expect(Object.keys(readLastBackupParts()).sort()).toEqual(["drafts", "library", "signatures"]);
    expect(readLastBackup()).not.toBeNull();
    window.localStorage.clear();
    // Solo escaneos: ni «último respaldo» ni las demás partes.
    markLastBackup(new Date(), { traveled: ["scanSessions"] });
    expect(readLastBackup()).toBeNull();
    expect(Object.keys(readLastBackupParts())).toEqual(["scanSessions"]);
    expect(lastBackupLine(readLastBackup(), readLastBackupParts(), es.settings.backup)).toBe("Último respaldo parcial (Escaneos en curso): hoy. Aún no has hecho un respaldo completo.");
  });

  it("los escaneos no condicionan lo «completo»: firmas, documentos y borradores respaldados bastan aunque haya escaneos sin llevar", async () => {
    await seedSimpleSession("Contrato A", 1);
    markLastBackup(new Date(), { traveled: ["signatures", "library", "drafts"] });
    expect(readLastBackup()).not.toBeNull();
  });
});

describe("leer y aplicar por la via global", () => {
  async function packageThenWipe(modules: Parameters<typeof exportEverything>[0]["modules"], password?: string) {
    const result = await exportEverything({ modules, password });
    if (!result.ok) throw new Error(result.reason);
    await resetScanStore();
    await clearVault();
    return result.blob;
  }

  it("un paquete con escaneos y firmas: cada modulo tiene su plan y se aplican en orden (los escaneos antes que los ajustes)", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    const a = await seedSimpleSession("Contrato A", 2, 1);
    const blob = await packageThenWipe({ signatures: true, scanSessions: true }, PASSWORD);
    const read = await readAndPlanEverything(asFile(blob), PASSWORD, PASS);
    if (!read.ok) throw new Error(read.reason);
    expect(read.modules.map((m) => [m.module, m.state, m.counts.new])).toEqual([
      ["signatures", "ok", 1],
      ["scanSessions", "ok", 1],
    ]);
    expect(read.plans.absent).toEqual(["library", "drafts", "clientProfiles", "settings"]);
    const decisions = defaultEverythingDecisions(read.plans);
    expect(Object.values(decisions.scanSessions)).toEqual(["import"]);
    const limits = checkEverythingLimits(read.plans, decisions);
    expect(limits.wantedBy.scanSessions).toBe(1);
    expect(limits.scanSessions).toMatchObject({ ok: true, wanted: 1 });
    expect(limits.ok).toBe(true);
    vi.stubGlobal("Blob", NodeBlob);
    const applied = await applyEverything(read.plans, decisions);
    expect(applied.outcomes.map((o) => [o.module, o.status])).toEqual([
      ["signatures", "applied"],
      ["library", "skipped"],
      ["drafts", "skipped"],
      ["scanSessions", "applied"],
      ["clientProfiles", "skipped"],
      ["settings", "skipped"],
    ]);
    expect(applied.outcomes[3]).toMatchObject({ module: "scanSessions", written: 1, saved: [{ id: a.id }] });
    expect((await scanSessionStore.load(a.id))?.pages).toHaveLength(2);
  });

  it("un paquete de solo escaneos entra por la misma vía; reimportarlo es «ya lo tienes» y no escribe nada", async () => {
    await seedSimpleSession("Contrato A", 2, 1);
    const blob = await packageThenWipe({ scanSessions: true });
    const read = await readAndPlanEverything(asFile(blob), undefined, PASS);
    if (!read.ok) throw new Error(read.reason);
    expect(read.plans.absent).toEqual(["signatures", "library", "drafts", "clientProfiles", "settings"]);
    vi.stubGlobal("Blob", NodeBlob);
    await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
    const before = (await listScanSessionSummaries()).map((s) => [s.id, s.savedAt]);
    const again = await readAndPlanEverything(asFile(blob), undefined, PASS);
    if (!again.ok) throw new Error(again.reason);
    expect(again.modules[0].counts).toMatchObject({ new: 0, identical: 1 });
    const second = await applyEverything(again.plans, defaultEverythingDecisions(again.plans));
    expect(second.outcomes.find((o) => o.module === "scanSessions")).toMatchObject({ status: "nothing" });
    expect((await listScanSessionSummaries()).map((s) => [s.id, s.savedAt])).toEqual(before);
  });

  it("una versión más nueva del módulo se rechaza (newerVersion) y no se lee; uno dañado se dice «damaged»", async () => {
    await seedSimpleSession("Contrato A", 1);
    const blob = await packageThenWipe({ scanSessions: true });
    const newer = await editManifest(blob, (manifest) => {
      manifest.modules["scan-sessions"].schemaVersion = 99;
    });
    const read = await readAndPlanEverything(asFile(newer), undefined, PASS);
    if (!read.ok) throw new Error(read.reason);
    expect(read.modules[0]).toMatchObject({ module: "scanSessions", state: "newerVersion", importable: false });
    const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
    expect(applied.outcomes.find((o) => o.module === "scanSessions")).toMatchObject({ status: "skipped", why: "newerVersion" });
    expect(await listScanSessionSummaries()).toEqual([]);

    const damaged = await buildPackage({ modules: [{ ...(await exportScanSessions()), files: [{ path: "scan-sessions/index.json", data: new TextEncoder().encode("no es json"), type: "application/json" }] }] }).catch(() => null);
    if (damaged) {
      const again = await readAndPlanEverything(asFile(damaged), undefined, PASS);
      if (!again.ok) throw new Error(again.reason);
      expect(again.modules[0]).toMatchObject({ module: "scanSessions", state: "damaged" });
    }
  });

  it("si el almacen no puede guardar NINGUNA sesion el modulo falla con su motivo y no se escribe nada; los demas modulos siguen", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    await seedSimpleSession("Contrato A", 1, 1);
    const blob = await packageThenWipe({ signatures: true, scanSessions: true });
    const read = await readAndPlanEverything(asFile(blob), undefined, PASS);
    if (!read.ok) throw new Error(read.reason);
    vi.stubGlobal("Blob", NodeBlob);
    const { __setScanStoreLimitsForTests } = await import("@/lib/scan/sessionStore");
    __setScanStoreLimitsForTests({ maxSessionBytes: 10 });
    try {
      const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
      expect(applied.applied).toEqual(["signatures"]);
      expect(applied.failed).toEqual(["scanSessions"]);
      expect(applied.outcomes.find((o) => o.module === "scanSessions")).toMatchObject({ status: "failed", failedReason: "tooBig" });
    } finally {
      __setScanStoreLimitsForTests();
    }
    expect(await listScanSessionSummaries()).toEqual([]);
  });

  it("si cabe parte: lo guardado cuenta, lo que no se dice (applied con failed > 0), y el PackageError del contenedor no se cuela", async () => {
    await seedSimpleSession("Pequena", 1, 1);
    await seedSimpleSession("Grande", 4, 10);
    const blob = await packageThenWipe({ scanSessions: true });
    const read = await readAndPlanEverything(asFile(blob), undefined, PASS);
    if (!read.ok) throw new Error(read.reason);
    const plan = read.plans.scanSessions!;
    const smallest = Math.min(...plan.items.map((item) => item.bytes));
    vi.stubGlobal("Blob", NodeBlob);
    const { __setScanStoreLimitsForTests } = await import("@/lib/scan/sessionStore");
    __setScanStoreLimitsForTests({ maxSessionBytes: smallest + 600 + 1200 + 10 });
    try {
      const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
      expect(applied.outcomes.find((o) => o.module === "scanSessions")).toMatchObject({ status: "applied", written: 1, failed: 1, failedReason: "tooBig" });
    } finally {
      __setScanStoreLimitsForTests();
    }
    expect((await listScanSessionSummaries()).map((s) => s.name)).toEqual(["Pequena"]);
    expect(PackageError).toBeDefined();
  });
});

describe("los dorados de escaneos en curso entran por la vía global", () => {
  for (const name of ["scan-sessions-v1.optimuspdf.zip", "scan-sessions-v1-encrypted.optimuspdf.zip"]) {
    it(`${name}: se planifica, se importa y no deja escrito nada más`, async () => {
      const file = new File([new Uint8Array(readFileSync(path.resolve(__dirname, "__fixtures__/packages", name)))], name);
      const read = await readAndPlanEverything(file, name.includes("encrypted") ? GOLDEN_SCAN_PASSWORD : undefined, { ...PASS, now: GOLDEN_SCAN_NOW });
      if (!read.ok) throw new Error(read.reason);
      expect(read.modules.map((m) => [m.module, m.state, m.counts.new])).toEqual([["scanSessions", "ok", 2]]);
      vi.stubGlobal("Blob", NodeBlob);
      const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans), { now: GOLDEN_SCAN_NOW });
      expect(applied.applied).toEqual(["scanSessions"]);
      expect(applied.failed).toEqual([]);
      expect((await listScanSessionSummaries()).map((s) => s.id).sort()).toEqual([GOLDEN_SCAN_IDS.contract, GOLDEN_SCAN_IDS.receipt]);
      expect(window.localStorage.length).toBeLessThanOrEqual(1); // solo el contador del recordatorio, si lo hubiera
    });
  }
});
