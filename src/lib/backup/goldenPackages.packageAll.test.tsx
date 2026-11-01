import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVault, listVault } from "@/app/sign-pdf/signVault";
import { listDrafts, listSessionDrafts } from "@/app/sign-pdf/signDrafts";
import { listEditDrafts } from "@/app/edit-pdf/editDrafts";
import { listProDrafts } from "@/app/pdf-pro/proDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { sha256Hex } from "@/lib/crypto/sha256";
import { __resetLibraryForTests, clearLibrary, getDocument, getDocumentBytes, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { readPackage } from "@/lib/backup/package";
import { applyEverything, defaultEverythingDecisions, readAndPlanEverything, type ApplyEverythingResult } from "@/lib/backup/globalPackage";
import { SETTINGS_WRITABLE_KEYS } from "@/lib/backup/settingsRegistry";
import { clearAllLocalDrafts, realPdf } from "@/lib/backup/__fixtures__/draftsKit";
import { GOLDEN_ALL, GOLDEN_ALL_NOW, GOLDEN_ALL_PASSWORD } from "@/lib/backup/__fixtures__/goldenAll";
import { countWrites } from "@/lib/backup/__fixtures__/libraryKit";
import { makeImage, pngPixelsSha256 } from "@/lib/backup/__fixtures__/pngFactory";
import { asFile } from "@/lib/backup/__fixtures__/testKit";

/**
 * Dorados del «OptimusPDF Package» global (`__fixtures__/packages/package-all-v1*.optimuspdf.zip`, U4.8), generados con el
 * código determinista de `__fixtures__/goldenAll.ts` y NUNCA regenerados: si una prueba de aquí falla, se rompió la
 * compatibilidad de un formato publicado (cuando exista el esquema 2 se AÑADE su dorado junto al v1). Llevan los CUATRO módulos.
 * Se importan por la vía global (`readAndPlanEverything` + `applyEverything`) y se compara el contenido exacto de cada
 * almacén. Además, la prueba de NO REGRESIÓN: los dorados de módulos sueltos de versiones anteriores siguen entrando por esa
 * misma vía. Contraseña de los cifrados: `dorada-2026`.
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");
const PASS = { validatePdf: async () => true, validateImage: async () => true, now: GOLDEN_ALL_NOW } as const;
const open = (name: string) => new Blob([new Uint8Array(readFileSync(path.join(DIR, name)))]);
const storedKeys = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i) as string).filter((key) => key !== "optimuspdf.backupReminder");

// Los dorados llevan fechas fijas (borradores que caducan a los 7 dias): el reloj se fija para que el paso del tiempo no los caduque.
const GOLDEN_NOW = new Date("2026-10-15T00:00:00.000Z");
afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: GOLDEN_NOW });
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
  window.localStorage.clear();
});

/**
 * Importa un dorado. Por defecto con «Reemplazar todos» en Ajustes (la persona lo pidió expresamente): así se comprueba el
 * contenido exacto de cada almacén, incluidos los ajustes que afectan a la privacidad (avisos «ya visto»), que con las
 * decisiones SUGERIDAS se omiten (F4-fix, H8: se prueba aparte). `defaults: true` usa las sugeridas tal cual.
 */
async function importGolden(name: string, options: { history?: boolean; defaults?: boolean } = {}) {
  const encrypted = name.includes("-encrypted");
  const read = await readAndPlanEverything(asFile(open(name)), encrypted ? GOLDEN_ALL_PASSWORD : undefined, PASS);
  if (!read.ok) throw new Error(`no se pudo leer ${name}: ${read.reason}`);
  const decisions = defaultEverythingDecisions(read.plans);
  if (!options.defaults) decisions.settings = { settings: "replace", valueHistory: "omit" };
  if (options.history) decisions.settings = { ...decisions.settings, valueHistory: "replace" };
  const applied = await applyEverything(read.plans, decisions, { now: GOLDEN_ALL_NOW });
  return { read, applied };
}

const statuses = (applied: ApplyEverythingResult) => applied.outcomes.map((o) => [o.module, o.status]);

describe("dorados package-all", () => {
  it("existen en claro y cifrado", () => {
    expect(["package-all-v1-encrypted.optimuspdf.zip", "package-all-v1.optimuspdf.zip"].every((name) => open(name).size > 0)).toBe(true);
  });

  for (const name of ["package-all-v1.optimuspdf.zip", "package-all-v1-encrypted.optimuspdf.zip"]) {
    const encrypted = name.includes("-encrypted");

    it(`${name}: trae los cuatro módulos con su esquema 1, sin avisos`, async () => {
      const read = await readPackage(open(name), encrypted ? GOLDEN_ALL_PASSWORD : undefined);
      expect(read).toMatchObject({ formatVersion: 1, encrypted, app: { version: "0.1.0", build: "golden" }, createdAt: "2026-10-15T12:00:00.000Z" });
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([
        ["signatures", 1, "ok"],
        ["library", 1, "ok"],
        ["drafts", 1, "ok"],
        ["settings", 1, "ok"],
      ]);
      expect(read.modules.map((m) => m.meta)).toMatchObject([
        { count: 3 },
        { documents: 3, templates: 2 },
        { signDocuments: 1, signSessions: 1, editDrafts: 1, proDrafts: 1, includesStrokes: true },
        { count: 10, includesValueHistory: encrypted },
      ]);
      expect(read.warnings).toEqual([]);
      expect(read.modules.flatMap((m) => [...m.files.values()]).every((f) => f.status === "ok")).toBe(true);
    });

    it(`${name}: se planifica sin escribir y todo es «Nuevo»`, async () => {
      const { writes, result } = await countWrites(() => readAndPlanEverything(asFile(open(name)), encrypted ? GOLDEN_ALL_PASSWORD : undefined, PASS));
      expect(writes).toBe(0);
      expect(storedKeys()).toEqual([]);
      if (!result.ok) throw new Error(result.reason);
      expect(result.modules.map((m) => [m.module, m.state, m.counts])).toEqual([
        ["signatures", "ok", { new: 3, identical: 0, different: 0, invalid: 0 }],
        ["library", "ok", { new: 3, identical: 0, different: 0, invalid: 0 }],
        ["drafts", "ok", { new: 4, identical: 0, different: 0, invalid: 0 }],
        ["settings", "ok", { new: 10, identical: 0, different: 0, invalid: 0 }],
      ]);
      expect(result.plans.settings?.valueHistory.status).toBe(encrypted ? "new" : "absent");
    });

    it(`${name}: se importa y cada almacén queda con el contenido exacto`, async () => {
      const { applied } = await importGolden(name, { history: encrypted });
      expect(statuses(applied)).toEqual([
        ["signatures", "applied"],
        ["library", "applied"],
        ["drafts", "applied"],
        // Los dorados v1 son anteriores a los escaneos en curso: ese módulo no venía y se salta.
        ["scanSessions", "skipped"],
        ["clientProfiles", "skipped"],
        ["settings", "applied"],
      ]);
      expect(applied.failed).toEqual([]);
      expect(applied.reloadRequired).toBe(true);

      // Firmas: ids, nombres, cargos y los PNG exactos (semillas fijas).
      const { entries } = await listVault();
      expect(entries.map((e) => e.id).sort()).toEqual(GOLDEN_ALL.signatures.map((row) => row.id).sort());
      for (const row of GOLDEN_ALL.signatures) {
        const entry = entries.find((e) => e.id === row.id)!;
        expect([entry.signerName, entry.role]).toEqual([row.name, row.role]);
        if (row.sig !== null) expect(pngPixelsSha256(entry.signature!.png)).toBe(pngPixelsSha256(makeImage({ seed: row.sig, real: true }).png));
        else expect(entry.signature).toBeNull();
        if (row.ini !== null) expect(pngPixelsSha256(entry.initials!.png)).toBe(pngPixelsSha256(makeImage({ width: 20, height: 20, seed: row.ini, real: true }).png));
        else expect(entry.initials).toBeNull();
      }
      expect(entries.find((e) => e.id === "pkgall-ana")).toMatchObject({ createdAt: "2026-10-01T10:00:00.000Z", lastUsedAt: "2026-10-05T10:00:00.000Z" });

      // Documentos y plantillas.
      expect((await listDocuments()).documents.map((d) => d.id).sort()).toEqual(GOLDEN_ALL.documents.map((d) => d.id).sort());
      for (const row of GOLDEN_ALL.documents) {
        const doc = (await getDocument(row.id))!;
        expect(doc).toMatchObject({ name: row.name, pageCount: row.pages, createdAt: "2026-10-01T10:00:00.000Z", templateIds: row.template ? [row.template] : [] });
        const bytes = (await getDocumentBytes(row.id))!;
        expect(await sha256Hex(bytes)).toBe(await sha256Hex(await realPdf(row.name, row.pages)));
        expect(doc.fingerprint.exact).toBe(await sha256Hex(bytes));
      }
      expect((await listTemplates()).templates.map((t) => [t.id, t.documentId, t.name]).sort()).toEqual([
        ["pkgall-tpl-a", "pkgall-doc-a", "Plantilla Contrato global A"],
        ["pkgall-tpl-b", "pkgall-doc-b", "Plantilla Contrato global B"],
      ]);

      // Borradores de las tres herramientas, con trazos.
      const [doc] = await listDrafts();
      expect(doc).toMatchObject({ fileName: "Poliza global.pdf", savedAt: "2026-10-14T10:00:00.000Z", expiresAt: "2026-10-21T10:00:00.000Z", rev: 1 });
      expect(Object.keys(doc.captures)).toEqual(["sg-1"]);
      const [session] = await listSessionDrafts();
      expect(session).toMatchObject({ id: "s-mgl1a-1k3v9x2a", documentCount: 2, ceremony: { signerId: "sg-2", stage: "capture" } });
      expect(session.blocks.map((b) => [b.signerId, b.signature !== null, b.initials !== null])).toEqual([["sg-1", true, true], ["sg-2", false, false]]);
      expect((await listEditDrafts()).map((d) => d.fileName)).toEqual(["Informe global.pdf"]);
      expect((await listProDrafts()).map((d) => d.fileName)).toEqual(["Pro global.pdf"]);

      // Ajustes: solo claves de la lista blanca; el historial solo si se pidió (y solo existe en el cifrado).
      expect(window.localStorage.getItem("optimuspdf.theme")).toBe("dark");
      expect(window.localStorage.getItem("optimuspdf.language")).toBe("en");
      expect(window.localStorage.getItem("optimuspdf.sidebarCollapsed")).toBe("1");
      expect(JSON.parse(window.localStorage.getItem("optimuspdf.signPdf.featureFlags") as string)).toMatchObject({ completionCertificate: true, autoApplyTemplates: false, autoDetectFields: false });
      expect(window.localStorage.getItem("optimuspdf.signPdf.featureFlags.v")).toBe("2");
      expect(JSON.parse(window.localStorage.getItem("optimuspdf.pro.layout.v1") as string)).toEqual({ thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true });
      expect(storedKeys().filter((key) => key !== "optimuspdf.valueHistory").every((key) => SETTINGS_WRITABLE_KEYS.includes(key))).toBe(true);
      if (encrypted) expect(Object.keys(JSON.parse(window.localStorage.getItem("optimuspdf.valueHistory") as string).entries).sort()).toEqual(["nombre del asegurado", "numero de poliza"]);
      else expect(window.localStorage.getItem("optimuspdf.valueHistory")).toBeNull();
    });

    it(`${name}: importarlo otra vez es «Ya lo tienes» en todo y no escribe nada`, async () => {
      await importGolden(name);
      const read = await readAndPlanEverything(asFile(open(name)), encrypted ? GOLDEN_ALL_PASSWORD : undefined, PASS);
      if (!read.ok) throw new Error(read.reason);
      expect(read.modules.map((m) => [m.module, m.counts.identical, m.counts.new, m.counts.different])).toEqual([
        ["signatures", 3, 0, 0],
        ["library", 3, 0, 0],
        ["drafts", 4, 0, 0],
        ["settings", 10, 0, 0],
      ]);
      const { writes, result } = await countWrites(() => applyEverything(read.plans, defaultEverythingDecisions(read.plans), { now: GOLDEN_ALL_NOW }));
      expect(writes).toBe(0);
      expect(statuses(result)).toEqual([["signatures", "nothing"], ["library", "nothing"], ["drafts", "nothing"], ["scanSessions", "skipped"], ["clientProfiles", "skipped"], ["settings", "nothing"]]);
    });
  }

  it("el dorado cifrado no se abre sin contraseña ni con una mala", async () => {
    await expect(readPackage(open("package-all-v1-encrypted.optimuspdf.zip"))).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(open("package-all-v1-encrypted.optimuspdf.zip"), "nope")).rejects.toMatchObject({ code: "wrongPassword" });
    expect(await readAndPlanEverything(asFile(open("package-all-v1-encrypted.optimuspdf.zip")), "nope", PASS)).toMatchObject({ ok: false, reason: "wrongPassword" });
  });

  it("por defecto el historial de valores del dorado cifrado NO se importa", async () => {
    await importGolden("package-all-v1-encrypted.optimuspdf.zip");
    expect(window.localStorage.getItem("optimuspdf.valueHistory")).toBeNull();
  });

  it("H8: con las decisiones SUGERIDAS los ajustes que afectan a la privacidad (avisos «ya visto») se omiten: 8 de 10", async () => {
    const { applied } = await importGolden("package-all-v1.optimuspdf.zip", { defaults: true });
    expect(applied.outcomes.find((o) => o.module === "settings")).toMatchObject({ status: "applied", written: 8, skipped: 2 });
    expect(window.localStorage.getItem("optimuspdf.theme")).toBe("dark");
    expect(window.localStorage.getItem("optimuspdf.sign-pdf.privacyNoticeSeen")).toBeNull();
    expect(window.localStorage.getItem("optimuspdf.edit-pdf.privacyNoticeSeen")).toBeNull();
  });
});

describe("no regresión: los dorados de módulos sueltos de cada familia siguen entrando por la vía global", () => {
  const families: Array<{ prefix: string; module: string; counts: Record<string, number> }> = [
    { prefix: "signatures-v1", module: "signatures", counts: { new: 3 } },
    { prefix: "library-v1", module: "library", counts: { new: 3 } },
    { prefix: "drafts-v1", module: "drafts", counts: { new: 4 } },
    { prefix: "settings-v1", module: "settings", counts: { new: 10 } },
  ];
  for (const family of families) {
    for (const suffix of ["", "-encrypted"]) {
      const name = `${family.prefix}${suffix}.optimuspdf.zip`;
      it(`${name}: un solo módulo, se planifica y se importa`, async () => {
        const encrypted = suffix !== "";
        const read = await readAndPlanEverything(asFile(open(name)), encrypted ? GOLDEN_ALL_PASSWORD : undefined, PASS);
        if (!read.ok) throw new Error(read.reason);
        expect(read.encrypted).toBe(encrypted);
        expect(read.modules.map((m) => [m.module, m.state])).toEqual([[family.module, "ok"]]);
        expect(read.modules[0].counts).toMatchObject(family.counts);
        const decisions = defaultEverythingDecisions(read.plans);
        // «Reemplazar todos» (incluidos los avisos de privacidad, que por defecto se omiten): así «otra vez» es «Ya lo tienes».
        if (family.module === "settings") decisions.settings = { settings: "replace", valueHistory: "omit" };
        const applied = await applyEverything(read.plans, decisions, { now: GOLDEN_ALL_NOW });
        expect(applied.failed).toEqual([]);
        expect(applied.applied).toEqual([family.module]);
        expect(applied.outcomes.filter((o) => o.status === "skipped").map((o) => o.module)).toEqual(["signatures", "library", "drafts", "scanSessions", "clientProfiles", "settings"].filter((m) => m !== family.module));
        // Y volver a importarlo es «Ya lo tienes».
        const again = await readAndPlanEverything(asFile(open(name)), encrypted ? GOLDEN_ALL_PASSWORD : undefined, PASS);
        if (!again.ok) throw new Error(again.reason);
        expect(again.modules[0].counts.new).toBe(0);
        expect(again.modules[0].counts.identical).toBe(family.counts.new);
      });
    }
  }
});
