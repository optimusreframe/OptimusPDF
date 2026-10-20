import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listAllDrafts, listDrafts, listSessionDrafts, loadSessionDraft } from "@/app/sign-pdf/signDrafts";
import { listEditDrafts, loadEditDraft } from "@/app/edit-pdf/editDrafts";
import { listProDrafts, loadProDraft } from "@/app/pdf-pro/proDrafts";
import { sha256Hex } from "@/lib/crypto/sha256";
import { readPackage } from "@/lib/backup/package";
import { applyDraftsImport, defaultDraftDecisions, planDraftsImport } from "@/lib/backup/modules/drafts";
import { pngBytesFromDataUrl } from "@/lib/backup/modules/draftsPng";
import { applySettingsImport, defaultSettingsDecisions, planSettingsImport } from "@/lib/backup/modules/settings";
import { SETTINGS_WRITABLE_KEYS } from "@/lib/backup/settingsRegistry";
import { MemoryStorage } from "@/lib/backup/__fixtures__/memoryStorage";
import { clearAllLocalDrafts } from "@/lib/backup/__fixtures__/draftsKit";
import { makeRealPng } from "@/lib/backup/__fixtures__/pngFactory";

/**
 * Dorados de «Ajustes» y «Borradores» (`__fixtures__/packages/settings-v1*.zip`, `drafts-v1*.zip`), generados con el codigo
 * de U4.6 y NUNCA regenerados: si una prueba de aqui falla, se rompio la compatibilidad de un formato publicado (cuando
 * exista el esquema 2 se AÑADE su dorado junto al v1). Contrasena de los cifrados: `dorada-2026`. El contenido general
 * (se abren, sin avisos) lo cubre `goldenPackages.test.ts`, que itera TODOS los dorados.
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");
const PASSWORD = "dorada-2026";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const open = (name: string) => new Blob([new Uint8Array(readFileSync(path.join(DIR, name)))]);

beforeEach(async () => {
  await clearAllLocalDrafts();
});

describe("dorados de ajustes", () => {
  for (const name of ["settings-v1.optimuspdf.zip", "settings-v1-encrypted.optimuspdf.zip"]) {
    it(`${name}: diez ajustes validos que se importan y quedan en la lista blanca`, async () => {
      const encrypted = name.includes("encrypted");
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([["settings", 1, "ok"]]);
      expect(read.modules[0].meta).toEqual({ count: 10, includesValueHistory: !encrypted });
      const storage = new MemoryStorage();
      const plan = planSettingsImport(read, { storage });
      expect(plan.counts).toEqual({ new: 10, identical: 0, different: 0, invalid: 0 });
      expect(plan.ignoredKeys).toBe(0);
      expect(plan.valueHistory.status).toBe(encrypted ? "absent" : "new");
      const result = await applySettingsImport(plan, { settings: "replace", valueHistory: "replace" }, { storage });
      expect(result).toMatchObject({ ok: true, written: 10, valueHistory: !encrypted });
      expect(storage.getItem("optimuspdf.theme")).toBe("dark");
      expect(storage.getItem("optimuspdf.language")).toBe("en");
      expect(JSON.parse(storage.getItem("optimuspdf.signPdf.featureFlags") as string)).toMatchObject({ completionCertificate: true, autoApplyTemplates: false, autoDetectFields: false });
      expect(storage.getItem("optimuspdf.signPdf.featureFlags.v")).toBe("2");
      expect(JSON.parse(storage.getItem("optimuspdf.pro.layout.v1") as string)).toEqual({ thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true });
      const valueKeys = storage.keys().filter((key) => key !== "optimuspdf.valueHistory");
      expect(valueKeys.every((key) => SETTINGS_WRITABLE_KEYS.includes(key))).toBe(true);
      if (!encrypted) {
        const history = JSON.parse(storage.getItem("optimuspdf.valueHistory") as string);
        expect(Object.keys(history.entries).sort()).toEqual(["nombre del asegurado", "numero de poliza"]);
      } else {
        expect(storage.getItem("optimuspdf.valueHistory")).toBeNull();
      }
    });
  }

  it("el dorado cifrado no se abre sin contraseña ni con una mala", async () => {
    await expect(readPackage(open("settings-v1-encrypted.optimuspdf.zip"))).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(open("settings-v1-encrypted.optimuspdf.zip"), "nope")).rejects.toMatchObject({ code: "wrongPassword" });
  });

  it("por defecto el historial de valores NO se importa", async () => {
    const read = await readPackage(open("settings-v1.optimuspdf.zip"));
    const storage = new MemoryStorage();
    const plan = planSettingsImport(read, { storage });
    await applySettingsImport(plan, defaultSettingsDecisions(plan), { storage });
    expect(storage.getItem("optimuspdf.valueHistory")).toBeNull();
  });
});

describe("dorados de borradores", () => {
  for (const name of ["drafts-v1.optimuspdf.zip", "drafts-v1-encrypted.optimuspdf.zip"]) {
    it(`${name}: cuatro borradores (documento, sesion, Editar, PDF Pro) con trazos que se importan y se pueden retomar`, async () => {
      const encrypted = name.includes("encrypted");
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([["drafts", 1, "ok"]]);
      expect(read.modules[0].meta).toMatchObject({ signDocuments: 1, signSessions: 1, editDrafts: 1, proDrafts: 1, includesStrokes: true });
      const plan = await planDraftsImport(read, { now: NOW, keepStrokes: true });
      expect(plan.state).toBe("ok");
      expect(plan.items.map((i) => [i.kind, i.status, i.fileName, i.documents, i.hasStrokes])).toEqual([
        ["sign-document", "new", "Poliza.pdf", 1, true],
        ["sign-session", "new", "Contrato A.pdf", 2, true],
        ["edit", "new", "Informe.pdf", 1, false],
        ["pro", "new", "Pro.pdf", 1, false],
      ]);
      expect(plan.includesStrokes).toBe(true);
      const result = await applyDraftsImport(plan, defaultDraftDecisions(plan), { keepStrokes: true, now: NOW });
      expect(result).toMatchObject({ ok: true, written: 4 });

      // Firmar: documento suelto
      const [doc] = await listDrafts();
      expect(doc).toMatchObject({ fileName: "Poliza.pdf", savedAt: "2026-10-14T10:00:00.000Z", expiresAt: "2026-10-21T10:00:00.000Z", rev: 1 });
      expect(doc.id).toMatch(/^[0-9a-f]{32}(ab){16}$/);
      expect(doc.fingerprint).toBe(doc.id.slice(0, 32) + doc.fingerprint!.slice(32));
      const signature = doc.captures["sg-1"].signature!;
      expect(await sha256Hex(pngBytesFromDataUrl(signature.dataUrl)!)).toBe(await sha256Hex(makeRealPng({ width: 60, height: 24, seed: 11 })));
      expect(signature.ratio).toBeCloseTo(0.4, 5);
      // Firmar: sesion con dos documentos y turno
      const [session] = await listSessionDrafts();
      expect(session).toMatchObject({ id: "s-mgl1g-1k3v9x2a", documentCount: 2, step: "sign", ceremony: { signerId: "sg-2", stage: "capture" } });
      expect(session.blocks.map((b) => [b.signerId, b.signature !== null, b.initials !== null, Object.keys(b.stamps).length])).toEqual([
        ["sg-1", true, true, 2],
        ["sg-2", false, false, 0],
      ]);
      const loaded = await loadSessionDraft(session.id);
      expect(loaded?.files.map((f) => f.fileName)).toEqual(["Contrato A.pdf", "Anexo B.pdf"]);
      // Editar y PDF Pro
      const [edit] = await listEditDrafts();
      expect(edit).toMatchObject({ fileName: "Informe.pdf", pendingCount: 2, pageCount: 2, currentPage: 1 });
      const editBack = await loadEditDraft(edit.id);
      expect(editBack.ok && Object.keys(editBack.draft.session.assets)).toEqual(["im1"]);
      const [pro] = await listProDrafts();
      expect(pro).toMatchObject({ fileName: "Pro.pdf", steps: 1, pageCount: 3, currentPage: 2 });
      const proBack = await loadProDraft(pro.id);
      expect(proBack.ok && proBack.draft.history.map((h) => h.label)).toEqual(["Original", "Rotar todas las páginas 90°"]);
      expect(await listAllDrafts()).toHaveLength(2);
    });
  }

  it("el dorado cifrado no se abre sin contraseña ni con una mala", async () => {
    await expect(readPackage(open("drafts-v1-encrypted.optimuspdf.zip"))).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(open("drafts-v1-encrypted.optimuspdf.zip"), "nope")).rejects.toMatchObject({ code: "wrongPassword" });
  });

  it("con los trazos desactivados el dorado entra sin firmas", async () => {
    const read = await readPackage(open("drafts-v1.optimuspdf.zip"));
    const plan = await planDraftsImport(read, { now: NOW, keepStrokes: false });
    await applyDraftsImport(plan, defaultDraftDecisions(plan), { keepStrokes: false, now: NOW });
    expect((await listDrafts())[0].captures).toEqual({});
    expect((await listSessionDrafts())[0].signaturesOmitted).toBe(true);
  });

  it("pasada la semana de caducidad de los trazos, los borradores con firmas se rechazan (los demas entran)", async () => {
    const read = await readPackage(open("drafts-v1.optimuspdf.zip"));
    const plan = await planDraftsImport(read, { now: Date.parse("2026-10-25T12:00:00.000Z"), keepStrokes: true });
    expect(plan.items.map((i) => `${i.kind}:${i.status}${i.reason ? `:${i.reason}` : ""}`)).toEqual([
      "sign-document:invalid:expired",
      "sign-session:invalid:expired",
      "edit:new",
      "pro:new",
    ]);
  });
});
