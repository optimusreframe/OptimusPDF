import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { exportBlob, freshLibrary, seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";
import { LAST_BACKUP_KEY } from "@/lib/backup/lastBackup";
import { MyDocumentsView } from "@/components/views/MyDocumentsView";
import { clearLibrary, listDocuments } from "@/lib/docLibrary/store";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { browserInputGuard } from "@/lib/pdf/inputGuard";
import { es } from "@/lib/locales/es";

/**
 * «Mis documentos» con el respaldo REAL (U4.5 + U4.2): el hueco «Próximamente» ya no existe; «Exportar plantillas y
 * documentos» e «Importar» abren sus hojas desde el panel de almacenamiento, el foco vuelve al botón al cerrar y, tras
 * importar, la lista se refresca sola con lo importado.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/documents" }));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});
vi.mock("@/lib/pdf/inputGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/inputGuard")>();
  return { ...actual, browserInputGuard: vi.fn(async () => ({ status: "ok" })) };
});

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  freshLibrary();
  vi.mocked(downloadBlob).mockClear();
  vi.mocked(browserInputGuard).mockImplementation(async () => ({ status: "ok" }));
});
afterEach(() => {
  cleanup();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

function renderView() {
  return render(
    <LanguageProvider>
      <MyDocumentsView />
    </LanguageProvider>,
  );
}

describe("Mis documentos · respaldo", () => {
  it("el panel de almacenamiento ofrece Exportar e Importar reales y dice que aún no hay respaldo", async () => {
    await seedDoc("a", 1, { name: "Contrato A" });
    renderView();
    const panel = (await screen.findByRole("heading", { name: es.documents.storageTitle })).closest("section") as HTMLElement;
    expect(within(panel).getByRole("heading", { name: es.documents.backup.title })).toBeTruthy();
    expect((within(panel).getByRole("button", { name: es.documents.backup.exportAction }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(panel).getByRole("button", { name: es.documents.backup.importAction }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(panel).getByText(es.documents.backup.lastNever)).toBeTruthy();
    expect(panel.textContent).not.toContain("Próximamente");
  });

  it("exportar: abre la hoja, crea el archivo, el panel pasa a «Último respaldo: hoy.» y el foco vuelve al botón", async () => {
    await seedDoc("a", 1, { name: "Contrato A" });
    await seedTemplate("a", {}, "tpl-a");
    renderView();
    const trigger = await screen.findByRole("button", { name: es.documents.backup.exportAction });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: es.documents.backup.exportTitle });
    await within(dialog).findByText(/Se exportará: 1 documento, 1 plantilla/);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: es.documents.backup.protect }));
    fireEvent.click(within(dialog).getByRole("button", { name: es.documents.backup.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    fireEvent.click(await within(dialog).findByRole("button", { name: es.documents.backup.doneClose }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(es.documents.backup.lastToday)).toBeTruthy();
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // La región viva única de la página anunció el resultado.
    expect(document.querySelector("[data-documents-live]")?.textContent).toContain("Respaldo creado: 1 documento, 1 plantilla.");
  });

  it("con documentos seleccionados, «Exportar seleccionados» lleva SOLO esos (y sus plantillas) y no marca un respaldo", async () => {
    await seedDoc("a", 1, { name: "Contrato A" });
    await seedDoc("b", 2, { name: "Contrato B" });
    await seedTemplate("a", {}, "tpl-a");
    await seedTemplate("b", {}, "tpl-b");
    renderView();
    const boxes = await screen.findAllByRole("checkbox");
    // Sin selección no hay botón de exportar seleccionados.
    expect(screen.queryByRole("button", { name: /Exportar seleccionados/ })).toBeNull();
    const first = boxes.find((box) => box.closest("li")?.textContent?.includes("Contrato A")) as HTMLElement;
    fireEvent.click(first);
    const trigger = await screen.findByRole("button", { name: es.documents.backup.exportSelectedAction.replace("{n}", "1") });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: es.documents.backup.exportSelectedTitle });
    await within(dialog).findByText(/Se exportará: 1 documento, 1 plantilla/);
    expect(within(dialog).getByText(es.documents.backup.exportSelectedNote)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: es.documents.backup.protect }));
    fireEvent.click(within(dialog).getByRole("button", { name: es.documents.backup.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe("OptimusPDF-seleccion.optimuspdf.zip");
    fireEvent.click(await within(dialog).findByRole("button", { name: es.documents.backup.doneClose }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Una parte no es un respaldo: «Último respaldo» no se mueve.
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    expect(screen.getByText(es.documents.backup.lastNever)).toBeTruthy();
    expect(document.querySelector("[data-documents-live]")?.textContent).toContain("Exportado: 1 documento, 1 plantilla.");
  });

  it("el menú ⋯ de un documento exporta solo ese documento y su plantilla", async () => {
    await seedDoc("a", 1, { name: "Contrato A" });
    await seedDoc("b", 2, { name: "Contrato B" });
    await seedTemplate("b", {}, "tpl-b");
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Más acciones de Contrato B" }));
    fireEvent.click(await screen.findByRole("button", { name: es.documents.exportOne }));
    const dialog = await screen.findByRole("dialog", { name: es.documents.backup.exportSelectedTitle });
    await within(dialog).findByText(/Se exportará: 1 documento, 1 plantilla/);
  });

  it("Escape cierra la hoja de exportar sin crear nada", async () => {
    await seedDoc("a", 1);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: es.documents.backup.exportAction }));
    await screen.findByRole("dialog", { name: es.documents.backup.exportTitle });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
  });

  it("«Último respaldo» cuenta ayer y los días desde la fecha guardada", async () => {
    await seedDoc("a", 1);
    window.localStorage.setItem(LAST_BACKUP_KEY, new Date(Date.now() - 86_400_000).toISOString());
    renderView();
    expect(await screen.findByText(es.documents.backup.lastYesterday)).toBeTruthy();
    cleanup();
    window.localStorage.setItem(LAST_BACKUP_KEY, new Date(Date.now() - 12 * 86_400_000).toISOString());
    renderView();
    expect(await screen.findByText("Último respaldo: hace 12 días.")).toBeTruthy();
    cleanup();
    window.localStorage.setItem(LAST_BACKUP_KEY, "no-es-una-fecha");
    renderView();
    expect(await screen.findByText(es.documents.backup.lastNever)).toBeTruthy();
  });

  it("importar: borra todo, elige el archivo y tras «Importar» la lista muestra los contratos restaurados", async () => {
    await seedDoc("a", 1, { name: "Contrato A", pages: 4 });
    await seedDoc("b", 2, { name: "Contrato B", pages: 3 });
    await seedTemplate("a", {}, "tpl-a");
    const file = asFile(await exportBlob(), "OptimusPDF-documentos.optimuspdf.zip");
    await clearLibrary();
    renderView();
    expect(await screen.findByText(es.documents.emptyTitle)).toBeTruthy();
    // Con la biblioteca vacía no hay panel de almacenamiento visible hasta cargar: el hueco vacío ofrece Importar en el panel.
    fireEvent.click(await screen.findByRole("button", { name: es.documents.backup.importAction }));
    const dialog = await screen.findByRole("dialog", { name: es.documents.backup.importTitle });
    await screen.findByRole("button", { name: es.documents.backup.pickZip });
    fireEvent.change(dialog.querySelector("[data-backup-file-input]") as HTMLInputElement, { target: { files: [file] } });
    const confirm = await waitFor(() => {
      const button = dialog.querySelector("[data-backup-confirm]") as HTMLButtonElement | null;
      if (!button) throw new Error("sin botón");
      return button;
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(dialog.querySelector("[data-backup-result]")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: es.documents.backup.doneClose }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("heading", { level: 3, name: "Contrato A" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Contrato B" })).toBeTruthy();
    expect(screen.getByText(es.documents.statusReady)).toBeTruthy();
    expect((await listDocuments()).documents).toHaveLength(2);
  });
});
