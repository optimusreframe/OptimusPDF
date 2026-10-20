import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { listDrafts, listSessionDrafts } from "@/app/sign-pdf/signDrafts";
import { listEditDrafts } from "@/app/edit-pdf/editDrafts";
import { listProDrafts } from "@/app/pdf-pro/proDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetLibraryForTests, clearLibrary, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import {
  applyEverything,
  defaultEverythingDecisions,
  exportEverything,
  readAndPlanEverything,
  type EverythingPlans,
  type ModuleOutcome,
  type PackageModuleName,
} from "@/lib/backup/globalPackage";
import { outcomeLine } from "@/app/settings/packageModel";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { clearAllLocalDrafts, seedEditDraft, seedProDraft, seedSignDocument, seedSignSession } from "@/lib/backup/__fixtures__/draftsKit";
import { seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { asFile, vaultInput } from "@/lib/backup/__fixtures__/testKit";

/**
 * H7 (verificación independiente): con la cuota del navegador llena, el baúl contaba «No caben…», los borradores y los
 * ajustes decían «unavailable». Cada módulo dice ahora lo mismo y con precisión: `quota` («No hay espacio suficiente en este
 * navegador; libera espacio o exporta y borra algo») y SIGUE siendo atómico por módulo (no queda nada a medias).
 */

const PASS = { validatePdf: async () => true, validateImage: async () => true } as const;
const ALL = { signatures: true, library: true, drafts: true, settings: true } as const;

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
});
afterEach(() => vi.restoreAllMocks());

async function seedAll() {
  await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
  await seedDoc("doc-a", 1);
  await seedTemplate("doc-a", {}, "tpl-a");
  await seedSignDocument({ strokes: true });
  await seedSignSession({ strokes: true });
  await seedEditDraft({ withImage: true });
  await seedProDraft();
  window.localStorage.setItem("optimuspdf.theme", "dark");
  window.localStorage.setItem("optimuspdf.language", "en");
}

async function wipe() {
  await clearVault();
  await clearLibrary();
  await clearAllLocalDrafts();
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
}

async function plansOfFull(local: Record<string, string> = {}): Promise<EverythingPlans> {
  await seedAll();
  const exported = await exportEverything({ modules: ALL });
  if (!exported.ok) throw new Error(exported.reason);
  await wipe();
  for (const [key, value] of Object.entries(local)) window.localStorage.setItem(key, value);
  const read = await readAndPlanEverything(asFile(exported.blob), undefined, PASS);
  if (!read.ok) throw new Error(read.reason);
  return read.plans;
}

const quotaError = () => new DOMException("quota", "QuotaExceededError");

async function counts() {
  const vault = await listVault();
  const docs = await listDocuments();
  const templates = await listTemplates();
  return {
    vault: vault.entries.length,
    docs: docs.available ? docs.documents.length : -1,
    templates: templates.available ? templates.templates.length : -1,
    sign: (await listDrafts()).length + (await listSessionDrafts()).length,
    edit: (await listEditDrafts()).length,
    pro: (await listProDrafts()).length,
    settings: window.localStorage.getItem("optimuspdf.theme"),
  };
}

function outcomeOf(outcomes: ModuleOutcome[], module: PackageModuleName): ModuleOutcome {
  return outcomes.find((o) => o.module === module) as ModuleOutcome;
}

async function applyWithFullQuota(plans: EverythingPlans) {
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw quotaError();
  });
  const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw quotaError();
  });
  try {
    return await applyEverything(plans, defaultEverythingDecisions(plans));
  } finally {
    put.mockRestore();
    setItem.mockRestore();
  }
}

describe("H7 — cuota llena: mensaje preciso en cada módulo y nada a medias", () => {
  it("firmas, biblioteca, borradores y ajustes fallan con `quota` (no `limit` ni `unavailable`) y no escriben nada", async () => {
    const plans = await plansOfFull();
    const before = await counts();
    const result = await applyWithFullQuota(plans);
    for (const name of ["signatures", "library", "drafts", "settings"] as const) {
      expect(outcomeOf(result.outcomes, name), name).toMatchObject({ status: "failed", reason: "quota" });
    }
    expect(result.failed).toEqual(["signatures", "library", "drafts", "settings"]);
    expect(await counts()).toEqual(before);
    expect(result.reloadRequired).toBe(false);
  });

  it("cada almacén por separado: el que se queda sin sitio dice `quota` y los demás se aplican bien", async () => {
    const dbOf = {
      signatures: ["optimuspdf-signature-vault"],
      library: ["optimuspdf-doc-library"],
      drafts: ["optimuspdf-sign-drafts", "optimuspdf-edit-drafts", "optimuspdf-pro-drafts"],
    } as const;
    for (const failing of ["signatures", "library", "drafts"] as const) {
      await wipe();
      const plans = await plansOfFull();
      const realPut = IDBObjectStore.prototype.put;
      const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
        if ((dbOf[failing] as readonly string[]).includes(this.transaction?.db.name ?? "")) throw quotaError();
        return realPut.apply(this, args);
      });
      let result;
      try {
        result = await applyEverything(plans, defaultEverythingDecisions(plans));
      } finally {
        spy.mockRestore();
      }
      expect(outcomeOf(result.outcomes, failing), failing).toMatchObject({ status: "failed", reason: "quota" });
      for (const other of ["signatures", "library", "drafts"] as const) {
        if (other !== failing) expect(outcomeOf(result.outcomes, other), `${failing} -> ${other}`).toMatchObject({ status: "applied" });
      }
    }
  });

  it("borradores: si la cuota se agota en el almacén de Editar o en el de PDF Pro (ya escrito el de Firmar), `quota` y el de Firmar se DESHACE", async () => {
    for (const failing of ["optimuspdf-edit-drafts", "optimuspdf-pro-drafts"]) {
      await wipe();
      const plans = await plansOfFull();
      const before = await counts();
      const realPut = IDBObjectStore.prototype.put;
      const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
        if (this.transaction?.db.name === failing) throw quotaError();
        return realPut.apply(this, args);
      });
      let result;
      try {
        result = await applyEverything({ ...plans, signatures: null, library: null, settings: null }, defaultEverythingDecisions(plans));
      } finally {
        spy.mockRestore();
      }
      expect(outcomeOf(result.outcomes, "drafts"), failing).toMatchObject({ status: "failed", reason: "quota" });
      expect((await counts()).sign, failing).toBe(before.sign);
      expect(await counts(), failing).toEqual(before);
    }
  });

  it("el ajuste que falla restaura lo que ya había escrito (atómico) y dice `quota`", async () => {
    const plans = await plansOfFull({ "optimuspdf.language": "es" });
    let calls = 0;
    const real = window.localStorage.setItem.bind(window.localStorage);
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation((key: string, value: string) => {
      calls += 1;
      if (key === "optimuspdf.language") throw quotaError();
      return real(key, value);
    });
    let result;
    try {
      result = await applyEverything({ ...plans, signatures: null, library: null, drafts: null }, defaultEverythingDecisions(plans));
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThan(0);
    expect(outcomeOf(result.outcomes, "settings")).toMatchObject({ status: "failed", reason: "quota" });
    expect(window.localStorage.getItem("optimuspdf.language")).toBe("es");
    // lo que se había escrito antes de fallar (el tema) se devolvió a como estaba: no hay clave
    expect(window.localStorage.getItem("optimuspdf.theme")).toBeNull();
  });
});

describe("H7 — el texto que ve la persona", () => {
  const quota: ModuleOutcome = { module: "drafts", status: "failed", reason: "quota" };

  it("ES: «No hay espacio suficiente en este navegador; libera espacio o exporta y borra algo»", () => {
    const line = outcomeLine(quota, es.settings.backup);
    expect(line?.tone).toBe("error");
    expect(line?.text).toMatch(/No hay espacio suficiente en este navegador; libera espacio o exporta y borra algo/i);
    expect(line?.text).not.toMatch(/No caben|unavailable/i);
  });

  it("EN: equivalente, sin «don't fit»", () => {
    const line = outcomeLine(quota, en.settings.backup);
    expect(line?.text).toMatch(/not enough space in this browser/i);
    expect(line?.text).not.toMatch(/fit|unavailable/i);
  });

  it("las hojas por módulo (firmas y documentos) usan el mismo texto", () => {
    expect(es.documents.backup.applyFailed.quota).toMatch(/No hay espacio suficiente en este navegador; libera espacio o exporta y borra algo/);
    expect(en.documents.backup.applyFailed.quota).toMatch(/not enough space in this browser/i);
  });
});
