import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExportPackageSheet } from "@/app/settings/ExportPackageSheet";
import { ImportPackageSheet } from "@/app/settings/ImportPackageSheet";
import { reloadPage } from "@/app/settings/pageReload";
import { clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { listDrafts } from "@/app/sign-pdf/signDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests, setSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { BACKUP_REMINDER_KEY, LAST_BACKUP_KEY } from "@/lib/backup/lastBackup";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { exportSignatures } from "@/lib/backup/modules/signatures";
import { exportEverything } from "@/lib/backup/globalPackage";
import { hostileCorpus } from "@/lib/backup/__fixtures__/hostileCorpus";
import { clearAllLocalDrafts, seedEditDraft, seedProDraft, seedSignDocument, seedSignSession } from "@/lib/backup/__fixtures__/draftsKit";
import { countWrites, seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { asFile, vaultInput } from "@/lib/backup/__fixtures__/testKit";
import { __resetLibraryForTests, clearLibrary, listDocuments } from "@/lib/docLibrary/store";
import { useEffect } from "react";
import { LanguageProvider, useI18n } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/**
 * Hojas «Exportar mi paquete» e «Importar paquete» (U4.7), jsdom + fake-indexeddb sobre los almacenes REALES. Solo se
 * simulan la descarga del navegador, la recarga de la página y las puertas de entrada del navegador (pdf.js y la decodificación
 * de PNG no corren en jsdom; sus versiones reales las ejercita el E2E).
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});
vi.mock("@/lib/pdf/inputGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/inputGuard")>();
  return { ...actual, browserInputGuard: vi.fn(async () => ({ status: "ok" })) };
});
vi.mock("@/lib/image/pngImportGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image/pngImportGuard")>();
  return { ...actual, validatePngForImport: vi.fn(async () => ({ ok: true })) };
});
vi.mock("@/app/settings/pageReload", () => ({ reloadPage: vi.fn() }));

const copy = es.settings.backup;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => String(values[k] ?? m));
const SETTINGS = { "optimuspdf.theme": "dark", "optimuspdf.language": "es", "optimuspdf.sidebarCollapsed": "1" };
const HISTORY = JSON.stringify({ version: 1, entries: { "nombre del asegurado": [{ value: "Ana Pérez", lastUsedAt: "2026-10-01T10:00:00.000Z" }] } });

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
  window.localStorage.clear();
  vi.mocked(downloadBlob).mockClear();
  vi.mocked(reloadPage).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function seedEverything(options: { history?: boolean } = {}) {
  await saveVaultEntry(vaultInput("Ana Pérez", { sig: 1, ini: 2, role: "Directora" }));
  await saveVaultEntry(vaultInput("Luis Gómez", { sig: 3, ini: null }));
  await seedDoc("doc-a", 1, { name: "Contrato A", pages: 3 });
  await seedDoc("doc-b", 2, { name: "Contrato B", pages: 2 });
  await seedTemplate("doc-a", {}, "tpl-a");
  await seedSignDocument({ strokes: true });
  await seedSignSession({ strokes: true, ceremony: true });
  await seedEditDraft({ withImage: true });
  await seedProDraft();
  for (const [key, value] of Object.entries(SETTINGS)) window.localStorage.setItem(key, value);
  if (options.history) window.localStorage.setItem("optimuspdf.valueHistory", HISTORY);
}

async function wipeEverything() {
  await clearVault();
  await clearLibrary();
  await clearAllLocalDrafts();
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
}

const statusText = () => within(screen.getByRole("dialog")).getByRole("status").textContent ?? "";
const storedKeys = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i) as string).filter((key) => key !== BACKUP_REMINDER_KEY);

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

function renderExport() {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <ExportPackageSheet open onClose={onClose} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onClose, onDone };
}

const typePassword = (value: string, repeat = value) => {
  fireEvent.change(screen.getByLabelText(copy.password), { target: { value } });
  fireEvent.change(screen.getByLabelText(copy.confirmPassword), { target: { value: repeat } });
};
const box = (name: string | RegExp) => screen.findByRole("checkbox", { name }) as Promise<HTMLInputElement>;
const summary = () => document.querySelector("[data-backup-summary]")?.textContent ?? "";
const waitSummary = (pattern: RegExp) => waitFor(() => expect(summary()).toMatch(pattern));

describe("Exportar mi paquete", () => {
  it("una casilla por módulo con su recuento, todo marcado salvo el historial de valores, y contraseña marcada", async () => {
    await seedEverything({ history: true });
    renderExport();
    expect((await box(/^Firmas guardadas \(2 firmas\)/)).checked).toBe(true);
    expect((await box(/^Plantillas y documentos \(2 documentos, 1 plantilla\)/)).checked).toBe(true);
    expect((await box(/^Borradores en curso \(4 borradores\)/)).checked).toBe(true);
    expect((await box(/^Ajustes \(3 ajustes\)/)).checked).toBe(true);
    // El historial de valores existe pero NO está marcado.
    expect((await box(/^Incluir el historial de valores \(1 etiqueta\)/)).checked).toBe(false);
    expect((await box(copy.protect)).checked).toBe(true);
    await waitSummary(/^Se exportará: 2 firmas, 2 documentos, 1 plantilla, 4 borradores \(firmas dibujadas en los de Firmar: sí\), ajustes\. Tamaño aproximado: /);
    // Los borradores con trazos lo dicen con claridad.
    expect(document.querySelector("[data-backup-strokes-warning]")?.textContent).toBe(copy.strokesWarning);
  });

  it("sin contraseña avisa más fuerte cuando hay firmas o datos de clientes; con solo documentos, no", async () => {
    await seedEverything();
    renderExport();
    await waitSummary(/Se exportará:/);
    fireEvent.click(await box(copy.protect));
    expect(document.querySelector("[data-backup-plain-warning]")?.getAttribute("data-backup-plain-warning")).toBe("sensitive");
    expect(screen.getByText(copy.plainWarningSensitive)).toBeTruthy();
    fireEvent.click(await box(/^Firmas guardadas/));
    fireEvent.click(await box(/^Borradores en curso/));
    await waitFor(() => expect(document.querySelector("[data-backup-plain-warning]")?.getAttribute("data-backup-plain-warning")).toBe("plain"));
    expect(screen.getByText(copy.plainWarning)).toBeTruthy();
  });

  it("solo plantillas y documentos: la contraseña NO viene marcada por defecto y se puede exportar sin ella", async () => {
    await seedDoc("doc-a", 1, { name: "Contrato A" });
    renderExport();
    await waitSummary(/^Se exportará: 1 documento\./);
    expect((await box(copy.protect)).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    expect((await readPackage(blob)).modules.map((m) => m.name)).toEqual(["library"]);
  });

  it("contraseña corta o que no coincide: error claro y no se exporta nada", async () => {
    await seedEverything();
    renderExport();
    await waitSummary(/Se exportará:/);
    typePassword("corta");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(statusText()).toBe(copy.passwordTooShort));
    typePassword("una-clave-larga", "otra-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(statusText()).toBe(copy.passwordMismatch));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
  });

  it("con contraseña: descarga OptimusPDF-paquete-AAAA-MM-DD cifrado con los cuatro módulos, anota el respaldo y reinicia el recordatorio", async () => {
    await seedEverything();
    expect(JSON.parse(window.localStorage.getItem(BACKUP_REMINDER_KEY) as string).changes).toBeGreaterThan(0);
    const { onDone } = renderExport();
    await waitSummary(/Se exportará:/);
    typePassword("una-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    expect(filename).toMatch(/^OptimusPDF-paquete-\d{4}-\d{2}-\d{2}\.optimuspdf\.zip$/);
    await expect(readPackage(blob)).rejects.toMatchObject({ code: "needsPassword" });
    const read = await readPackage(blob, "una-clave-larga");
    expect(read.modules.map((m) => m.name)).toEqual(["signatures", "library", "drafts", "settings"]);
    expect(read.modules.find((m) => m.name === "settings")?.meta).toMatchObject({ includesValueHistory: false });
    const done = fill(copy.doneEncrypted, { parts: "2 firmas, 2 documentos, 1 plantilla, 4 borradores, ajustes" });
    await waitFor(() => expect(document.querySelector("[data-backup-result]")?.textContent).toBe(`${done} ${fill(copy.doneFile, { name: filename })}`));
    expect(onDone).toHaveBeenCalledWith(fill(copy.announceExported, { parts: "2 firmas, 2 documentos, 1 plantilla, 4 borradores, ajustes" }));
    expect(Date.parse(window.localStorage.getItem(LAST_BACKUP_KEY) ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
  });

  it("el historial de valores solo viaja si se marca (y entonces el resumen lo dice)", async () => {
    await seedEverything({ history: true });
    renderExport();
    await waitSummary(/ajustes\./);
    fireEvent.click(await box(/^Incluir el historial de valores/));
    await waitSummary(/ajustes, historial de valores\./);
    typePassword("una-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    const read = await readPackage(blob, "una-clave-larga");
    expect(read.modules.find((m) => m.name === "settings")?.meta).toMatchObject({ includesValueHistory: true });
  });

  it("quitar «las firmas dibujadas en los borradores» las deja fuera del paquete y del resumen", async () => {
    await seedEverything();
    renderExport();
    fireEvent.click(await box(/^Incluir las firmas dibujadas en los borradores/));
    await waitSummary(/firmas dibujadas en los de Firmar: no\)/);
    expect(document.querySelector("[data-backup-strokes-warning]")).toBeNull();
    typePassword("una-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    const read = await readPackage(blob, "una-clave-larga");
    expect(read.modules.find((m) => m.name === "drafts")?.meta).toMatchObject({ includesStrokes: false });
  });

  it("desmarcar módulos cambia el resumen; sin ninguno, el botón se bloquea y lo dice", async () => {
    await seedEverything();
    renderExport();
    await waitSummary(/2 firmas/);
    for (const label of [/^Firmas guardadas/, /^Plantillas y documentos/, /^Borradores en curso/, /^Ajustes/]) fireEvent.click(await box(label));
    await waitSummary(new RegExp(`^${copy.summaryNothing.replace(".", "\\.")}$`));
    expect((screen.getByRole("button", { name: copy.exportConfirm }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await box(/^Ajustes/));
    await waitSummary(/^Se exportará: ajustes\./);
    expect((screen.getByRole("button", { name: copy.exportConfirm }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("un módulo vacío tiene su casilla deshabilitada y desmarcada, con su explicación", async () => {
    await seedDoc("doc-a", 1);
    renderExport();
    await waitSummary(/^Se exportará: 1 documento/);
    const signatures = await box(/^Firmas guardadas/);
    expect(signatures.disabled).toBe(true);
    expect(signatures.checked).toBe(false);
    expect(signatures.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(signatures.getAttribute("aria-describedby") as string)?.textContent).toBe(copy.moduleEmpty);
    expect((await box(/^Borradores en curso/)).disabled).toBe(true);
  });

  it("nada que respaldar: lo dice y «Crear paquete» queda deshabilitado", async () => {
    renderExport();
    await waitSummary(new RegExp(copy.summaryNothing.replace(".", "\\.")));
    expect((screen.getByRole("button", { name: copy.exportConfirm }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sin WebCrypto (http): la contraseña queda desmarcada y deshabilitada con su explicación", async () => {
    await seedEverything();
    const subtle = window.crypto.subtle;
    Object.defineProperty(window.crypto, "subtle", { configurable: true, value: undefined });
    try {
      renderExport();
      const protect = await box(copy.protect);
      expect(protect.checked).toBe(false);
      expect(protect.disabled).toBe(true);
      expect(screen.getByText(copy.encryptionUnavailable)).toBeTruthy();
    } finally {
      Object.defineProperty(window.crypto, "subtle", { configurable: true, value: subtle });
    }
  });

  it("una sola región de estado", async () => {
    await seedEverything();
    renderExport();
    await waitSummary(/Se exportará:/);
    expect(within(screen.getByRole("dialog")).getAllByRole("status")).toHaveLength(1);
  });

  describe("iPad: hoja de compartir del sistema", () => {
    function stubTouchShare(share: ReturnType<typeof vi.fn>) {
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: coarse"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
      vi.stubGlobal("navigator", { ...navigator, share, canShare: () => true });
    }
    async function toReady() {
      await seedEverything();
      const view = renderExport();
      await waitSummary(/Se exportará:/);
      typePassword("una-clave-larga");
      fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
      await screen.findByRole("button", { name: copy.shareButton });
      return view;
    }

    it("primero «archivo listo» y comparte en un segundo toque; cerrar la hoja sin elegir NO cuenta como exportado", async () => {
      const share = vi.fn().mockRejectedValueOnce(new DOMException("cancel", "AbortError")).mockResolvedValue(undefined);
      stubTouchShare(share);
      await toReady();
      expect(downloadBlob).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(statusText()).toBe(copy.shareCancelled));
      expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
      const data = share.mock.calls[1][0] as { files: File[] };
      expect(data.files[0].name).toMatch(/^OptimusPDF-paquete-\d{4}-\d{2}-\d{2}\.optimuspdf\.zip$/);
      await screen.findByRole("button", { name: copy.doneClose });
      expect(window.localStorage.getItem(LAST_BACKUP_KEY)).not.toBeNull();
    });

    it("si compartir falla de verdad cae a la descarga", async () => {
      stubTouchShare(vi.fn().mockRejectedValue(new DOMException("no", "NotAllowedError")));
      await toReady();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    });
  });
});

/* ------------------------------------------------------------------ *
 * Importar
 * ------------------------------------------------------------------ */

function renderImport() {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <ImportPackageSheet open onClose={onClose} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onClose, onDone };
}

const zipInput = () => document.querySelector("[data-backup-file-input]") as HTMLInputElement;
async function pickZip(file: File) {
  await screen.findByRole("button", { name: copy.pickZip });
  fireEvent.change(zipInput(), { target: { files: [file] } });
}
const itemOf = (key: string) => document.querySelector(`[data-backup-item="${key}"]`) as HTMLElement;
const moduleOf = (name: string) => document.querySelector(`[data-backup-module="${name}"]`) as HTMLElement;
const confirmButton = () => document.querySelector("[data-backup-confirm]") as HTMLButtonElement;

async function packageThenWipe(options: { password?: string; modules?: Parameters<typeof exportEverything>[0]["modules"] } = {}) {
  const result = await exportEverything({ modules: options.modules ?? { signatures: true, library: true, drafts: true, settings: true }, password: options.password });
  if (!result.ok) throw new Error(result.reason);
  await wipeEverything();
  return asFile(result.blob, result.filename);
}

describe("Importar paquete", () => {
  it("vista previa por módulo con el estado de cada elemento; al confirmar, un resultado por módulo y todo restaurado", async () => {
    await seedEverything();
    const file = await packageThenWipe({ password: "una-clave-larga" });
    const { onDone } = renderImport();
    await pickZip(file);
    fireEvent.change(await screen.findByLabelText(copy.passwordLabel), { target: { value: "mala" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));
    await waitFor(() => expect(statusText()).toBe(copy.wrongPassword));
    expect((await listVault()).entries).toHaveLength(0);
    expect(storedKeys()).toEqual([]);
    fireEvent.change(screen.getByLabelText(copy.passwordLabel), { target: { value: "una-clave-larga" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));

    await waitFor(() => expect(moduleOf("signatures")).toBeTruthy());
    expect(document.querySelector("[data-backup-preview-intro]")?.textContent).toBe(
      "El paquete trae: 2 firmas, 2 documentos, 1 plantilla, 4 borradores, 3 ajustes (estaba cifrado).",
    );
    expect([...document.querySelectorAll("[data-backup-module]")].map((node) => node.getAttribute("data-backup-module"))).toEqual(["signatures", "library", "drafts", "settings"]);
    for (const name of ["signatures", "library", "drafts"]) {
      for (const card of moduleOf(name).querySelectorAll("[data-backup-item]")) expect(card.getAttribute("data-status"), name).toBe("new");
    }
    expect(within(moduleOf("signatures")).getAllByText(copy.statusNew).length).toBe(2);
    expect(within(moduleOf("library")).getByText("Contrato A")).toBeTruthy();
    expect(within(moduleOf("drafts")).getAllByText(copy.draftHasStrokes).length).toBe(2);
    expect(itemOf("settings").getAttribute("data-status")).toBe("new");
    expect(confirmButton().textContent).toBe(fill(copy.importConfirmMany, { n: 11 }));
    // Nada se ha escrito todavía.
    expect((await listVault()).entries).toHaveLength(0);
    expect((await listDocuments()).documents).toHaveLength(0);

    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultSignatures, { n: 2 }));
    const lines = [...document.querySelectorAll("[data-backup-result] li")].map((node) => node.textContent);
    expect(lines).toEqual([
      "Firmas: 2 importadas.",
      "Plantillas y documentos: 2 documentos, 1 plantilla.",
      "Borradores: 4 importados.",
      "Ajustes: 3 aplicados.",
      // Este paquete no trae escaneos en curso: se dice aparte, en una línea (no es un fallo).
      "El paquete no incluye: Escaneos en curso.",
    ]);
    expect(onDone).toHaveBeenCalledWith(copy.announceImported);
    expect((await listVault()).entries).toHaveLength(2);
    expect((await listDocuments()).documents).toHaveLength(2);
    expect(await listDrafts()).toHaveLength(1);
    expect(window.localStorage.getItem("optimuspdf.theme")).toBe("dark");
    // Aviso de recarga con su botón.
    expect(document.querySelector("[data-backup-reload]")?.textContent).toContain(copy.reloadNotice);
    fireEvent.click(screen.getByRole("button", { name: copy.reloadButton }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("importar sobre lo mismo: «Ya lo tienes», sin duplicar y con el botón deshabilitado", async () => {
    await seedEverything();
    const result = await exportEverything({ modules: { signatures: true, library: true, drafts: true, settings: true } });
    if (!result.ok) throw new Error(result.reason);
    renderImport();
    await pickZip(asFile(result.blob));
    await waitFor(() => expect(moduleOf("library")).toBeTruthy());
    for (const name of ["signatures", "library", "drafts", "settings"]) {
      for (const card of moduleOf(name).querySelectorAll("[data-backup-item]")) expect(card.getAttribute("data-status"), name).toBe("identical");
    }
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().textContent).toBe(copy.importNothing);
    expect((await listVault()).entries).toHaveLength(2);
  });

  it("un paquete de solo firmas entra por la misma hoja", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    const blob = await buildPackage({ modules: [await exportSignatures()] });
    await clearVault();
    renderImport();
    await pickZip(asFile(blob, "OptimusPDF-firmas.optimuspdf.zip"));
    await waitFor(() => expect(moduleOf("signatures")).toBeTruthy());
    expect(document.querySelectorAll("[data-backup-module]")).toHaveLength(1);
    expect(confirmButton().textContent).toBe(copy.importConfirmOne);
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultSignatures, { n: 1 }));
    expect(document.querySelector("[data-backup-reload]")).toBeNull();
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("omitir un elemento no lo escribe; el historial de valores nace en «Omitir»", async () => {
    await seedEverything({ history: true });
    const withHistory = await exportEverything({ modules: { signatures: true, settings: true }, includeValueHistory: true });
    if (!withHistory.ok) throw new Error(withHistory.reason);
    await wipeEverything();
    renderImport();
    await pickZip(asFile(withHistory.blob));
    await waitFor(() => expect(itemOf("valueHistory")).toBeTruthy());
    expect(within(itemOf("valueHistory")).getByRole("radio", { name: copy.decisionOmit }).getAttribute("aria-checked")).toBe("true");
    const first = moduleOf("signatures").querySelector("[data-backup-item]") as HTMLElement;
    fireEvent.click(within(first).getByRole("radio", { name: copy.decisionOmit }));
    expect(confirmButton().textContent).toBe(fill(copy.importConfirmMany, { n: 4 }));
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultSignatures, { n: 1 }));
    expect((await listVault()).entries).toHaveLength(1);
    expect(window.localStorage.getItem("optimuspdf.valueHistory")).toBeNull();
  });

  it("el historial de valores solo entra si se elige «Reemplazar»", async () => {
    await seedEverything({ history: true });
    const withHistory = await exportEverything({ modules: { settings: true }, includeValueHistory: true });
    if (!withHistory.ok) throw new Error(withHistory.reason);
    await wipeEverything();
    renderImport();
    await pickZip(asFile(withHistory.blob));
    await waitFor(() => expect(itemOf("valueHistory")).toBeTruthy());
    fireEvent.click(within(itemOf("valueHistory")).getByRole("radio", { name: copy.decisionReplace }));
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultSettingsHistory, { n: 3 }));
    expect(window.localStorage.getItem("optimuspdf.valueHistory")).not.toBeNull();
  });

  it("límites comprobados ANTES: borradores que no caben bloquean el botón hasta omitir", async () => {
    await seedEverything();
    const file = await packageThenWipe();
    for (let i = 0; i < 10; i += 1) await seedSignDocument({ label: `Local ${i}` });
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("drafts")).toBeTruthy());
    expect(confirmButton().disabled).toBe(true);
    expect(document.querySelector("[data-backup-blocked]")?.textContent).toBe(fill(copy.limitBlocked, { names: "Borradores" }));
    expect(document.querySelector('[data-backup-limits="drafts"]')?.textContent).toContain("Omite alguno");
    for (const radio of within(moduleOf("drafts")).getAllByRole("radio", { name: copy.decisionOmit })) fireEvent.click(radio);
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(document.querySelector("[data-backup-blocked]")).toBeNull();
    expect(document.querySelector('[data-backup-limits="drafts"]')?.textContent).toBe(copy.limitDrafts);
  });

  it("zips hostiles: error claro, vuelve a elegir archivo y no se escribe nada", async () => {
    renderImport();
    const { writes } = await countWrites(async () => {
      for (const sample of hostileCorpus().slice(0, 4)) {
        await pickZip(asFile(new Blob([sample.bytes as BlobPart]), "malo.optimuspdf.zip"));
        await waitFor(() => expect(statusText()).not.toBe(""));
        expect(screen.getByRole("button", { name: copy.pickZip })).toBeTruthy();
        expect(Object.values(copy.readErrors)).toContain(statusText());
      }
    });
    expect(writes).toBe(0);
    expect(storedKeys()).toEqual([]);
  });

  it("un archivo que no es un paquete conocido (otro módulo) se dice con claridad", async () => {
    renderImport();
    await pickZip(asFile(new Blob(["no soy un zip"]), "x.zip"));
    await waitFor(() => expect(statusText()).toBe(copy.readErrors.badFile));
  });

  it("una sola región de estado", async () => {
    renderImport();
    await screen.findByRole("button", { name: copy.pickZip });
    expect(within(screen.getByRole("dialog")).getAllByRole("status")).toHaveLength(1);
  });

  it("los nombres con HTML se ven como texto (sin innerHTML)", async () => {
    await seedDoc("doc-x", 1, { name: '<img src=x onerror="window.__pwn=1">' });
    const result = await exportEverything({ modules: { library: true } });
    if (!result.ok) throw new Error(result.reason);
    await wipeEverything();
    renderImport();
    await pickZip(asFile(result.blob));
    await waitFor(() => expect(moduleOf("library")).toBeTruthy());
    expect(moduleOf("library").querySelector("img")).toBeNull();
    expect(moduleOf("library").textContent).toContain("<img src=x");
  });

  it("con los trazos desactivados en este navegador la tarjeta del borrador lo avisa", async () => {
    await seedEverything();
    const file = await packageThenWipe({ modules: { drafts: true } });
    setSignPdfFeatureFlag("signaturesInDraft", false);
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("drafts")).toBeTruthy());
    expect(within(moduleOf("drafts")).getAllByText(copy.draftStrokesDropped).length).toBeGreaterThan(0);
  });
});

describe("textos ES/EN de settings.backup", () => {
  const paths = (value: unknown, prefix = ""): string[] =>
    typeof value === "string" ? [prefix] : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
  const read = (root: unknown, path: string): string => path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as string;

  it("mismas claves y mismos marcadores en español e inglés, y ninguna vacía", () => {
    const esPaths = paths(es.settings.backup).sort();
    expect(paths(en.settings.backup).sort()).toEqual(esPaths);
    const markers = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const path of esPaths) {
      expect(markers(read(en.settings.backup, path)), path).toEqual(markers(read(es.settings.backup, path)));
      expect(read(en.settings.backup, path).trim().length, path).toBeGreaterThan(0);
      expect(read(es.settings.backup, path).trim().length, path).toBeGreaterThan(0);
    }
  });

  it("los motivos de fallo y de rechazo de borradores cubren todos los códigos", () => {
    expect(Object.keys(es.settings.backup.applyFailed).sort()).toEqual(["blocked", "changed", "failed", "invalid", "limit", "quota", "unavailable"]);
    expect(Object.keys(es.settings.backup.draftInvalidReasons).sort()).toEqual(
      ["duplicateId", "expired", "fingerprint", "integrity", "invalidEntry", "invalidImage", "invalidPdf", "tooLarge", "tooMany"],
    );
  });

  it("el inglés se ve en las hojas", async () => {
    await seedDoc("doc-a", 1);
    render(
      <LanguageProvider>
        <SetLanguage language="en" />
        <ExportPackageSheet open onClose={() => {}} />
      </LanguageProvider>,
    );
    expect((await screen.findAllByText(en.settings.backup.exportIntro)).length).toBeGreaterThan(0);
    await waitFor(() => expect(summary()).toMatch(/^Will be exported: 1 document, settings\. Approximate size: /));
  });
});

function SetLanguage({ language }: { language: "es" | "en" }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(language), [language, setLanguage]);
  return null;
}
