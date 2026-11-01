import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { clearVault, deleteVaultEntry, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { listDrafts, listSessionDrafts } from "@/app/sign-pdf/signDrafts";
import { listEditDrafts } from "@/app/edit-pdf/editDrafts";
import { listProDrafts } from "@/app/pdf-pro/proDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetLibraryForTests, clearLibrary, getDocumentBytes, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { PackageError } from "@/lib/backup/types";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { exportSignatures } from "@/lib/backup/modules/signatures";
import { exportSettings } from "@/lib/backup/modules/settings";
import { __setDraftsPackageBudgetForTests } from "@/lib/backup/modules/drafts";
import {
  PACKAGE_MODULES,
  applyEverything,
  checkEverythingLimits,
  defaultEverythingDecisions,
  describeExport,
  exportEverything,
  hasBackupWorthyData,
  packageFilename,
  readAndPlanEverything,
  type EverythingPlans,
} from "@/lib/backup/globalPackage";
import { clearAllLocalDrafts, seedEditDraft, seedProDraft, seedSignDocument, seedSignSession } from "@/lib/backup/__fixtures__/draftsKit";
import { hostileCorpus } from "@/lib/backup/__fixtures__/hostileCorpus";
import { countWrites, fakePdf, seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { asFile, editManifest, timed, vaultInput } from "@/lib/backup/__fixtures__/testKit";

/**
 * «OptimusPDF Package» global (U4.7), orquestación pura sobre los cuatro módulos, con `localStorage` e IndexedDB reales
 * (jsdom + fake-indexeddb). Las puertas de entrada de producción (pdf.js abre cada PDF, `validatePngForImport` decodifica
 * cada trazo) necesitan un navegador y se prueban en el E2E; aquí se sustituyen por `true`.
 */

const PASSWORD = "clave de prueba 1";
const PASS = { validatePdf: async () => true, validateImage: async () => true } as const;
const NOW = new Date(2026, 9, 20, 10, 0, 0);

const SETTINGS = {
  "optimuspdf.theme": "dark",
  "optimuspdf.language": "en",
  "optimuspdf.sidebarCollapsed": "1",
  "optimuspdf.sign-pdf.privacyNoticeSeen": "1",
};
const HISTORY = JSON.stringify({ version: 1, entries: { "nombre del asegurado": [{ value: "Ana Pérez", lastUsedAt: "2026-10-01T10:00:00.000Z" }] } });

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __setDraftsPackageBudgetForTests(undefined);
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
});

async function seedEverything(options: { history?: boolean } = {}) {
  await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2, role: "Directora" }));
  await saveVaultEntry(vaultInput("Luis Gómez", { sig: 3, ini: null }));
  await seedDoc("doc-a", 1, { pages: 3 });
  await seedDoc("doc-b", 2, { pages: 2 });
  await seedTemplate("doc-a", {}, "tpl-a");
  const signDoc = await seedSignDocument({ strokes: true });
  const session = await seedSignSession({ strokes: true, ceremony: true });
  const edit = await seedEditDraft({ withImage: true });
  const pro = await seedProDraft();
  for (const [key, value] of Object.entries(SETTINGS)) window.localStorage.setItem(key, value);
  if (options.history) window.localStorage.setItem("optimuspdf.valueHistory", HISTORY);
  return { signDoc, session, edit, pro };
}

/** Claves de `localStorage` salvo el contador del recordatorio de respaldo (cada alta de firma/documento lo suma; es de cada dispositivo). */
const storedKeys = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i) as string).filter((key) => key !== "optimuspdf.backupReminder");

async function wipeEverything() {
  await clearVault();
  await clearLibrary();
  await clearAllLocalDrafts();
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
}

const ALL = { signatures: true, library: true, drafts: true, settings: true } as const;

async function readPlans(blob: Blob, password?: string) {
  const read = await readAndPlanEverything(asFile(blob), password, PASS);
  if (!read.ok) throw new Error(`no se pudo leer: ${read.reason}`);
  return read;
}

describe("describeExport: resumen previo", () => {
  it("cuenta firmas, documentos, plantillas, borradores (con trazos: sí/no), ajustes y tamaño estimado", async () => {
    await seedEverything({ history: true });
    const all = await describeExport({ modules: ALL });
    expect(all.signatures).toMatchObject({ available: true, count: 2 });
    expect(all.signatures.bytes).toBeGreaterThan(0);
    expect(all.library).toMatchObject({ available: true, documents: 2, templates: 1, withoutCopy: 0 });
    expect(all.drafts).toMatchObject({ available: true, count: 4, signCount: 2, editCount: 1, proCount: 1, withSignatureStrokes: 2, includesStrokes: true, strokesHeldBack: false, fitsInPackage: true });
    expect(all.settings).toMatchObject({ available: true, keys: 4, valueHistoryLabels: 1, valueHistoryValues: 1 });
    expect(all.willInclude).toEqual(["signatures", "library", "drafts", "settings"]);
    expect(all.willOmitEmpty).toEqual([]);
    expect(all.containsSignatureStrokes).toBe(true);
    expect(all.containsSignatures).toBe(true);
    expect(all.containsClientData).toBe(true);
    expect(all.encryptionRecommended).toBe(true);
    expect(all.estimatedBytes).toBeGreaterThan(all.signatures.bytes + all.library.bytes);
    expect(all.tooLarge).toBe(false);
    expect(all.nothingToExport).toBe(false);
  });

  it("quitar los trazos los deja fuera del resumen; solo ajustes y plantillas no piden cifrar", async () => {
    await seedEverything();
    const noStrokes = await describeExport({ modules: { drafts: true }, includeStrokes: false });
    expect(noStrokes.drafts).toMatchObject({ includesStrokes: false, strokesHeldBack: true, withSignatureStrokes: 2 });
    expect(noStrokes.containsSignatureStrokes).toBe(false);
    expect(noStrokes.encryptionRecommended).toBe(true); // los borradores llevan datos de clientes

    const light = await describeExport({ modules: { library: true, settings: true } });
    expect(light.willInclude).toEqual(["library", "settings"]);
    expect(light.containsSignatures).toBe(false);
    expect(light.containsClientData).toBe(false);
    expect(light.encryptionRecommended).toBe(false);
  });

  it("el historial de valores solo cuenta si se pide, y entonces pide cifrar", async () => {
    window.localStorage.setItem("optimuspdf.theme", "dark");
    window.localStorage.setItem("optimuspdf.valueHistory", HISTORY);
    expect((await describeExport({ modules: { settings: true } })).encryptionRecommended).toBe(false);
    const withHistory = await describeExport({ modules: { settings: true }, includeValueHistory: true });
    expect(withHistory.containsClientData).toBe(true);
    expect(withHistory.encryptionRecommended).toBe(true);
  });

  it("un módulo vacío se cuenta como «se omitirá»; sin nada que exportar lo dice", async () => {
    await seedDoc("doc-a", 1);
    const d = await describeExport({ modules: { signatures: true, library: true, drafts: true } });
    expect(d.willInclude).toEqual(["library"]);
    expect(d.willOmitEmpty).toEqual(["signatures", "drafts"]);
    const none = await describeExport({ modules: { signatures: true } });
    expect(none.nothingToExport).toBe(true);
    expect((await describeExport({ modules: {} })).nothingToExport).toBe(true);
  });

  it("los tipos de borrador se pueden recortar", async () => {
    await seedEverything();
    const onlyEdit = await describeExport({ modules: { drafts: true }, draftKinds: { sign: false, pro: false } });
    expect(onlyEdit.drafts).toMatchObject({ count: 1, editCount: 1, signCount: 0, proCount: 0 });
    expect(onlyEdit.containsSignatureStrokes).toBe(false);
  });

  it("un presupuesto de borradores superado se marca como demasiado grande", async () => {
    await seedEverything();
    __setDraftsPackageBudgetForTests(1000);
    const d = await describeExport({ modules: { drafts: true } });
    expect(d.drafts.fitsInPackage).toBe(false);
    expect(d.tooLarge).toBe(true);
  });

  it("hasBackupWorthyData: los ajustes solos no cuentan", async () => {
    window.localStorage.setItem("optimuspdf.theme", "dark");
    expect(await hasBackupWorthyData()).toBe(false);
    await seedDoc("doc-a", 1);
    expect(await hasBackupWorthyData()).toBe(true);
  });
});

describe("exportEverything", () => {
  it("empaqueta los cuatro módulos en un solo archivo con el nombre del día; el historial NO va por defecto", async () => {
    await seedEverything({ history: true });
    const result = await exportEverything({ modules: ALL, now: NOW });
    if (!result.ok) throw new Error(result.reason);
    expect(result.filename).toBe("OptimusPDF-paquete-2026-10-20.optimuspdf.zip");
    expect(result.encrypted).toBe(false);
    expect(result.included).toEqual(["signatures", "library", "drafts", "settings"]);
    expect(result.omitted).toEqual([]);
    expect(result.counts).toMatchObject({ signatures: 2, documents: 2, templates: 1, drafts: 4, settings: 4, valueHistory: false, strokes: true });
    const read = await readPackage(result.blob);
    expect(read.modules.map((m) => [m.name, m.status])).toEqual([
      ["signatures", "ok"],
      ["library", "ok"],
      ["drafts", "ok"],
      ["settings", "ok"],
    ]);
    expect(read.warnings).toEqual([]);
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(Object.keys(zip.files).some((name) => name.startsWith("settings/value-history"))).toBe(false);
  });

  it("con includeValueHistory el historial viaja; con includeStrokes false los borradores salen sin trazos", async () => {
    await seedEverything({ history: true });
    const withHistory = await exportEverything({ modules: { settings: true }, includeValueHistory: true });
    if (!withHistory.ok) throw new Error(withHistory.reason);
    expect(withHistory.counts.valueHistory).toBe(true);
    const zip = await JSZip.loadAsync(await withHistory.blob.arrayBuffer());
    expect(zip.file("settings/value-history.json")).not.toBeNull();

    const noStrokes = await exportEverything({ modules: { drafts: true }, includeStrokes: false });
    if (!noStrokes.ok) throw new Error(noStrokes.reason);
    expect(noStrokes.counts.strokes).toBe(false);
    const files = Object.keys((await JSZip.loadAsync(await noStrokes.blob.arrayBuffer())).files);
    expect(files.some((name) => name.endsWith(".png") && name.includes("-k"))).toBe(false);
  });

  it("con contraseña solo hay sobre y carga cifrada", async () => {
    await seedEverything();
    const result = await exportEverything({ modules: ALL, password: PASSWORD });
    if (!result.ok) throw new Error(result.reason);
    expect(result.encrypted).toBe(true);
    const names = Object.keys((await JSZip.loadAsync(await result.blob.arrayBuffer())).files).sort();
    expect(names).toEqual(["envelope.json", "payload.bin"]);
    await expect(readPackage(result.blob)).rejects.toMatchObject({ code: "needsPassword" });
  });

  it("un módulo vacío se omite con aviso y el resto sale", async () => {
    await seedDoc("doc-a", 1);
    const result = await exportEverything({ modules: ALL });
    if (!result.ok) throw new Error(result.reason);
    expect(result.included).toEqual(["library"]);
    expect(result.omitted).toEqual([
      { module: "signatures", reason: "empty" },
      { module: "drafts", reason: "empty" },
      { module: "settings", reason: "empty" },
    ]);
  });

  it("errores claros: nada elegido, todo vacío, borradores demasiado grandes, sin cifrado disponible", async () => {
    await seedDoc("doc-a", 1);
    expect(await exportEverything({ modules: {} })).toEqual({ ok: false, reason: "nothingSelected" });
    expect(await exportEverything({ modules: { signatures: true } })).toMatchObject({ ok: false, reason: "empty" });
    await seedProDraft();
    __setDraftsPackageBudgetForTests(1000);
    expect(await exportEverything({ modules: { drafts: true } })).toEqual({ ok: false, reason: "tooLarge" });
    __setDraftsPackageBudgetForTests(undefined);
    const subtle = window.crypto.subtle;
    Object.defineProperty(window.crypto, "subtle", { configurable: true, value: undefined });
    try {
      expect(await exportEverything({ modules: { library: true }, password: PASSWORD })).toEqual({ ok: false, reason: "encryptionUnavailable" });
    } finally {
      Object.defineProperty(window.crypto, "subtle", { configurable: true, value: subtle });
    }
  });

  it("packageFilename usa la fecha local y rellena los ceros", () => {
    expect(packageFilename(new Date(2026, 0, 5))).toBe("OptimusPDF-paquete-2026-01-05.optimuspdf.zip");
  });
});

describe("ida y vuelta: exportar → borrar todo → importar", () => {
  it("devuelve firmas, documentos, plantillas, borradores y ajustes; pide recargar", async () => {
    const seeded = await seedEverything();
    const before = {
      vault: (await listVault()).entries.map((e) => [e.id, e.signerName, e.role, e.signature?.png.byteLength, e.initials?.png.byteLength]).sort(),
      bytesA: Array.from((await getDocumentBytes("doc-a")) ?? []),
    };
    const exported = await exportEverything({ modules: ALL, password: PASSWORD });
    if (!exported.ok) throw new Error(exported.reason);
    await wipeEverything();
    expect((await listVault()).entries).toHaveLength(0);

    // Contraseña mala: se rechaza y no se escribe nada.
    const { writes } = await countWrites(async () => {
      expect(await readAndPlanEverything(asFile(exported.blob), "mala", PASS)).toMatchObject({ ok: false, reason: "wrongPassword" });
      expect(await readAndPlanEverything(asFile(exported.blob), undefined, PASS)).toMatchObject({ ok: false, reason: "needsPassword" });
    });
    expect(writes).toBe(0);
    expect(storedKeys()).toEqual([]);

    // Leer y planificar NO escribe nada.
    const planned = await countWrites(() => readPlans(exported.blob, PASSWORD));
    expect(planned.writes).toBe(0);
    expect(storedKeys()).toEqual([]);
    const read = planned.result;
    expect(read.encrypted).toBe(true);
    expect(read.modules.map((m) => [m.module, m.state, m.importable, m.counts.new])).toEqual([
      ["signatures", "ok", true, 2],
      ["library", "ok", true, 2],
      ["drafts", "ok", true, 4],
      ["settings", "ok", true, 4],
    ]);

    const decisions = defaultEverythingDecisions(read.plans);
    // H8: el aviso de privacidad «ya visto» afecta a la privacidad: con las decisiones SUGERIDAS se omite (3 de 4 ajustes).
    expect(checkEverythingLimits(read.plans, decisions).wantedBy.settings).toBe(3);
    // La persona pide «Reemplazar todos» en Ajustes: entran los 4.
    decisions.settings = { settings: "replace", valueHistory: "omit" };
    const limits = checkEverythingLimits(read.plans, decisions);
    expect(limits).toMatchObject({ ok: true, blocked: [], wantedBy: { signatures: 2, library: 2, drafts: 4, settings: 4 }, wanted: 12 });

    const applied = await applyEverything(read.plans, decisions);
    expect(applied.failed).toEqual([]);
    expect(applied.applied).toEqual(["signatures", "library", "drafts", "settings"]);
    expect(applied.reloadRequired).toBe(true);
    expect(applied.outcomes.map((o) => o.module)).toEqual(["signatures", "library", "drafts", "scanSessions", "clientProfiles", "settings"]);

    // Firmas
    expect((await listVault()).entries.map((e) => [e.id, e.signerName, e.role, e.signature?.png.byteLength, e.initials?.png.byteLength]).sort()).toEqual(before.vault);
    // Documentos y plantillas
    expect((await listDocuments()).documents.map((d) => d.id).sort()).toEqual(["doc-a", "doc-b"]);
    expect(Array.from((await getDocumentBytes("doc-a")) ?? [])).toEqual(before.bytesA);
    expect((await listTemplates()).templates.map((t) => t.id)).toEqual(["tpl-a"]);
    // Borradores de las tres herramientas, con trazos
    const [doc] = await listDrafts();
    expect(doc.id).toBe(seeded.signDoc.id);
    expect(Object.keys(doc.captures)).toEqual(["sg-1"]);
    expect((await listSessionDrafts())[0].id).toBe(seeded.session.id);
    expect((await listEditDrafts()).map((d) => d.id)).toEqual([seeded.edit.id]);
    expect((await listProDrafts()).map((d) => d.id)).toEqual([seeded.pro.id]);
    // Ajustes
    for (const [key, value] of Object.entries(SETTINGS)) expect(window.localStorage.getItem(key), key).toBe(value);
    // Una segunda importación no duplica nada ni toca nada.
    const again = await readPlans(exported.blob, PASSWORD);
    expect(again.modules.map((m) => [m.module, m.counts.identical, m.counts.new])).toEqual([
      ["signatures", 2, 0],
      ["library", 2, 0],
      ["drafts", 4, 0],
      ["settings", 4, 0],
    ]);
    const second = await countWrites(() => applyEverything(again.plans, defaultEverythingDecisions(again.plans)));
    expect(second.writes).toBe(0);
    // Los escaneos en curso no iban en este paquete: se saltan (no es «nada que importar»).
    expect(second.result.outcomes.map((o) => o.status)).toEqual(["nothing", "nothing", "nothing", "skipped", "skipped", "nothing"]);
    expect(second.result.reloadRequired).toBe(false);
    expect((await listVault()).entries).toHaveLength(2);
    expect((await listDocuments()).documents).toHaveLength(2);
  });

  it("añadir una firma, reexportar e importar sobre lo existente fusiona sin duplicar", async () => {
    await seedEverything();
    const first = await exportEverything({ modules: ALL, password: PASSWORD });
    if (!first.ok) throw new Error(first.reason);
    await wipeEverything();
    const plans = await readPlans(first.blob, PASSWORD);
    await applyEverything(plans.plans, defaultEverythingDecisions(plans.plans));
    await saveVaultEntry(vaultInput("Marta Ruiz", { sig: 7, ini: null }));
    const second = await exportEverything({ modules: ALL, password: PASSWORD });
    if (!second.ok) throw new Error(second.reason);
    expect(second.counts.signatures).toBe(3);

    // Sobre un navegador con SOLO el primer paquete: la fusión añade únicamente lo nuevo.
    await deleteVaultEntry((await listVault()).entries.find((e) => e.signerName === "Marta Ruiz")!.id);
    const merge = await readPlans(second.blob, PASSWORD);
    expect(merge.modules.find((m) => m.module === "signatures")?.counts).toEqual({ new: 1, identical: 2, different: 0, invalid: 0 });
    expect(merge.modules.find((m) => m.module === "library")?.counts).toMatchObject({ new: 0, identical: 2 });
    expect(merge.modules.find((m) => m.module === "drafts")?.counts).toMatchObject({ new: 0, identical: 4 });
    const applied = await applyEverything(merge.plans, defaultEverythingDecisions(merge.plans));
    expect(applied.outcomes.map((o) => o.status)).toEqual(["applied", "nothing", "nothing", "skipped", "skipped", "nothing"]);
    expect((await listVault()).entries.map((e) => e.signerName).sort()).toEqual(["Ana Pérez", "Luis Gómez", "Marta Ruiz"]);
    expect((await listDocuments()).documents).toHaveLength(2);
    expect(await listDrafts()).toHaveLength(1);
  });

  it("el historial de valores solo entra si se decide «Reemplazar» a propósito", async () => {
    window.localStorage.setItem("optimuspdf.theme", "dark");
    window.localStorage.setItem("optimuspdf.valueHistory", HISTORY);
    const exported = await exportEverything({ modules: { settings: true }, includeValueHistory: true });
    if (!exported.ok) throw new Error(exported.reason);
    window.localStorage.clear();
    const read = await readPlans(exported.blob);
    const decisions = defaultEverythingDecisions(read.plans);
    expect(decisions.settings).toEqual({ settings: "replace", valueHistory: "omit" });
    await applyEverything(read.plans, decisions);
    expect(window.localStorage.getItem("optimuspdf.valueHistory")).toBeNull();
    const again = await readPlans(exported.blob);
    const chosen = await applyEverything(again.plans, { ...defaultEverythingDecisions(again.plans), settings: { settings: "omit", valueHistory: "replace" } });
    expect(chosen.outcomes[5]).toMatchObject({ module: "settings", status: "applied", valueHistory: true });
    expect(window.localStorage.getItem("optimuspdf.valueHistory")).not.toBeNull();
  });
});

describe("un paquete de UN solo módulo entra por la misma vía", () => {
  it("el paquete de solo firmas (U4.4)", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    const blob = await buildPackage({ modules: [await exportSignatures()] });
    await clearVault();
    const read = await readPlans(blob);
    expect(read.modules.map((m) => m.module)).toEqual(["signatures"]);
    expect(read.plans.library).toBeNull();
    const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
    expect(applied.outcomes.map((o) => [o.module, o.status])).toEqual([
      ["signatures", "applied"],
      ["library", "skipped"],
      ["drafts", "skipped"],
      ["scanSessions", "skipped"],
      ["clientProfiles", "skipped"],
      ["settings", "skipped"],
    ]);
    expect(applied.reloadRequired).toBe(false);
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("el paquete de solo ajustes pide recargar", async () => {
    window.localStorage.setItem("optimuspdf.theme", "dark");
    const blob = await buildPackage({ modules: [await exportSettings()] });
    window.localStorage.clear();
    const read = await readPlans(blob);
    const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
    expect(applied.reloadRequired).toBe(true);
    expect(window.localStorage.getItem("optimuspdf.theme")).toBe("dark");
  });
});

describe("un módulo que falla no deshace los que ya se aplicaron", () => {
  it("borradores sin sitio (10 locales): firmas, documentos y ajustes entran; borradores falla y se dice", async () => {
    await seedEverything();
    const exported = await exportEverything({ modules: ALL });
    if (!exported.ok) throw new Error(exported.reason);
    await wipeEverything();
    // El almacén de Firmar ya está lleno con 10 borradores distintos: el paquete trae 2 más.
    for (let i = 0; i < 10; i += 1) await seedSignDocument({ label: `Local ${i}` });
    const read = await readPlans(exported.blob);
    const decisions = defaultEverythingDecisions(read.plans);
    const limits = checkEverythingLimits(read.plans, decisions);
    expect(limits.ok).toBe(false);
    expect(limits.blocked).toEqual(["drafts"]);

    const applied = await applyEverything(read.plans, decisions);
    expect(applied.outcomes.map((o) => [o.module, o.status])).toEqual([
      ["signatures", "applied"],
      ["library", "applied"],
      ["drafts", "failed"],
      ["scanSessions", "skipped"],
      ["clientProfiles", "skipped"],
      ["settings", "applied"],
    ]);
    expect(applied.outcomes[2]).toMatchObject({ reason: "limit" });
    expect(applied.failed).toEqual(["drafts"]);
    expect(applied.applied).toEqual(["signatures", "library", "settings"]);
    expect((await listVault()).entries).toHaveLength(2);
    expect((await listDocuments()).documents).toHaveLength(2);
    expect(window.localStorage.getItem("optimuspdf.theme")).toBe("dark");
    expect(await listDrafts()).toHaveLength(10); // nada de borradores se escribió ni se expulsó
  });

  it("si lo omites, el resto se importa; un módulo sin nada aprobado no se toca", async () => {
    await seedEverything();
    const exported = await exportEverything({ modules: ALL });
    if (!exported.ok) throw new Error(exported.reason);
    await wipeEverything();
    const read = await readPlans(exported.blob);
    const decisions = defaultEverythingDecisions(read.plans);
    const omitDrafts = Object.fromEntries(Object.keys(decisions.drafts).map((key) => [key, "omit" as const]));
    const applied = await applyEverything(read.plans, { ...decisions, drafts: omitDrafts, settings: { settings: "omit", valueHistory: "omit" } });
    expect(applied.outcomes.map((o) => [o.module, o.status])).toEqual([
      ["signatures", "applied"],
      ["library", "applied"],
      ["drafts", "nothing"],
      ["scanSessions", "skipped"],
      ["clientProfiles", "skipped"],
      ["settings", "nothing"],
    ]);
    expect(await listDrafts()).toHaveLength(0);
    expect(storedKeys()).toEqual([]);
    expect(applied.reloadRequired).toBe(false);
  });
});

describe("estados de módulo", () => {
  it("un módulo de versión más nueva se rechaza y los demás se importan", async () => {
    await seedEverything();
    const exported = await exportEverything({ modules: { signatures: true, settings: true } });
    if (!exported.ok) throw new Error(exported.reason);
    const blob = await editManifest(exported.blob, (manifest) => {
      manifest.modules.settings.schemaVersion = 99;
    });
    await wipeEverything();
    const read = await readPlans(blob);
    expect(read.modules.map((m) => [m.module, m.state, m.importable])).toEqual([
      ["signatures", "ok", true],
      ["settings", "newerVersion", false],
    ]);
    expect(read.modules[1].message).toMatch(/versión más nueva/);
    const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
    expect(applied.outcomes.map((o) => [o.module, o.status])).toEqual([
      ["signatures", "applied"],
      ["library", "skipped"],
      ["drafts", "skipped"],
      ["scanSessions", "skipped"],
      ["clientProfiles", "skipped"],
      ["settings", "skipped"],
    ]);
    expect(applied.outcomes[5]).toMatchObject({ why: "newerVersion" });
    expect(storedKeys()).toEqual([]);
  });

  it("un paquete sin ningún módulo conocido se dice con claridad", async () => {
    await seedDoc("doc-a", 1);
    const exported = await exportEverything({ modules: { library: true } });
    if (!exported.ok) throw new Error(exported.reason);
    const blob = await editManifest(exported.blob, (manifest) => {
      manifest.modules = { otro: manifest.modules.library };
    });
    expect(await readAndPlanEverything(asFile(blob), undefined, PASS)).toMatchObject({ ok: false, reason: "noModules" });
  });

  it("los módulos se aplican siempre en el mismo orden y ajustes va el último", () => {
    expect(PACKAGE_MODULES).toEqual(["signatures", "library", "drafts", "scanSessions", "clientProfiles", "settings"]);
  });

  it("una vista previa vacía (todo idéntico) no tiene nada que importar", async () => {
    await seedEverything();
    const exported = await exportEverything({ modules: ALL });
    if (!exported.ok) throw new Error(exported.reason);
    const read = await readPlans(exported.blob);
    expect(checkEverythingLimits(read.plans, defaultEverythingDecisions(read.plans)).wanted).toBe(0);
  });
});

describe("paquetes hostiles", () => {
  it("cada zip hostil del corpus se rechaza en menos de 2 s, sin escribir nada", async () => {
    const { writes } = await countWrites(async () => {
      for (const sample of hostileCorpus()) {
        const result = await timed(() => readAndPlanEverything(asFile(new Blob([sample.bytes as BlobPart])), undefined, PASS));
        expect(result.ok, sample.name).toBe(false);
      }
    });
    expect(writes).toBe(0);
    expect(storedKeys()).toEqual([]);
  });

  it("PackageError inesperado o un archivo que no es zip", async () => {
    expect(await readAndPlanEverything(asFile(new Blob(["hola"])), undefined, PASS)).toMatchObject({ ok: false, reason: "badFile" });
    expect(PackageError).toBeDefined();
  });
});

describe("applyEverything con un plan manipulado", () => {
  it("un plan de otro estado se salta y no escribe nada", async () => {
    const plans: EverythingPlans = { signatures: null, library: null, drafts: null, scanSessions: null, clientProfiles: null, settings: null };
    const applied = await applyEverything(plans, { signatures: {}, library: {}, drafts: {}, scanSessions: {}, clientProfiles: {}, settings: { settings: "omit" } });
    expect(applied.outcomes.every((o) => o.status === "skipped")).toBe(true);
    expect(applied.applied).toEqual([]);
  });

  it("lo no aprobado explícitamente no se escribe (decisiones vacías)", async () => {
    await seedEverything();
    const exported = await exportEverything({ modules: ALL });
    if (!exported.ok) throw new Error(exported.reason);
    await wipeEverything();
    const read = await readPlans(exported.blob);
    const { writes, result } = await countWrites(() => applyEverything(read.plans, { signatures: {}, library: {}, drafts: {}, scanSessions: {}, clientProfiles: {}, settings: { settings: "omit", valueHistory: "omit" } }));
    expect(writes).toBe(0);
    // El paquete no traía escaneos en curso: ese módulo se salta (no es «nada que importar»).
    expect(result.outcomes.map((o) => o.status)).toEqual(["nothing", "nothing", "nothing", "skipped", "skipped", "nothing"]);
    expect(fakePdf(1).length).toBeGreaterThan(0);
  });
});
