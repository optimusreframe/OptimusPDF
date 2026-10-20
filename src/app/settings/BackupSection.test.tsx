import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BackupSection } from "@/app/settings/BackupSection";
import { SettingsView } from "@/components/views/SettingsView";
import { MyDocumentsView } from "@/components/views/MyDocumentsView";
import { BACKUP_REMINDER_KEY, LAST_BACKUP_KEY } from "@/lib/backup/lastBackup";
import { readReminderState } from "@/lib/backup/backupReminder";
import { saveVaultEntry, clearVault } from "@/app/sign-pdf/signVault";
import { __resetLibraryForTests, clearLibrary } from "@/lib/docLibrary/store";
import { seedDoc } from "@/lib/backup/__fixtures__/libraryKit";
import { vaultInput } from "@/lib/backup/__fixtures__/testKit";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";

/**
 * Ajustes ➜ «Respaldo y traslado» y el recordatorio (U4.7): botones, «Último respaldo», motivo de Safari, «Añadir a la
 * pantalla de inicio», y el aviso a los 30 días / 10 cambios con «Respaldar ahora» y «Recordármelo luego» (7 días), también
 * en «Mis documentos». Con el reloj real movido (`Date`), IndexedDB y `localStorage` reales.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/settings" }));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

const copy = es.settings.backup;
const DAY = 86_400_000;

beforeEach(async () => {
  window.localStorage.clear();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const renderSection = () =>
  render(
    <LanguageProvider>
      <BackupSection />
    </LanguageProvider>,
  );

describe("sección «Respaldo y traslado»", () => {
  it("título, motivo (Safari borra tras 7 días), «Añadir a la pantalla de inicio», dos botones de 44 px y «aún no has hecho un respaldo»", async () => {
    renderSection();
    const section = document.querySelector("[data-settings-backup]") as HTMLElement;
    expect(within(section).getByRole("heading", { name: copy.title, level: 2 })).toBeTruthy();
    expect(section.querySelector("[data-backup-why]")?.textContent).toMatch(/Safari puede borrar los datos de un sitio web después de 7 días/);
    expect(section.querySelector("[data-backup-a2hs]")?.textContent).toContain("Añadir a la pantalla de inicio");
    const exportButton = within(section).getByRole("button", { name: copy.exportAction }) as HTMLButtonElement;
    const importButton = within(section).getByRole("button", { name: copy.importAction }) as HTMLButtonElement;
    expect(exportButton.disabled || importButton.disabled).toBe(false);
    for (const button of [exportButton, importButton]) expect(button.className).toMatch(/min-h-11|h-11/);
    await waitFor(() => expect(section.querySelector("[data-backup-last]")?.textContent).toBe(copy.lastNever));
    expect(section.querySelector("[data-backup-reminder]")).toBeNull();
  });

  it("«Último respaldo: hoy / ayer / hace N días» según la fecha guardada", async () => {
    window.localStorage.setItem(LAST_BACKUP_KEY, new Date(Date.now() - 3 * DAY).toISOString());
    renderSection();
    await waitFor(() => expect(document.querySelector("[data-backup-last]")?.textContent).toBe("Último respaldo: hace 3 días."));
  });

  it("Exportar e Importar abren sus hojas y Escape las cierra devolviendo el foco", async () => {
    renderSection();
    const exportButton = screen.getByRole("button", { name: copy.exportAction });
    fireEvent.click(exportButton);
    expect(await screen.findByRole("dialog", { name: copy.exportTitle })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: copy.importAction }));
    expect(await screen.findByRole("dialog", { name: copy.importTitle })).toBeTruthy();
  });
});

describe("recordatorio de respaldo", () => {
  async function dueByChanges() {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify({ changes: 12, since: new Date().toISOString() }));
  }

  it("a los 10 cambios aparece, con el motivo y los dos botones", async () => {
    await dueByChanges();
    renderSection();
    const reminder = await waitFor(() => {
      const node = document.querySelector("[data-backup-reminder]") as HTMLElement | null;
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(reminder.getAttribute("data-backup-reminder")).toBe("changes");
    expect(within(reminder).getByRole("heading", { name: copy.reminderTitle, level: 3 })).toBeTruthy();
    expect(reminder.textContent).toContain("Has hecho 12 cambios");
    // El motivo ya está en la sección, justo encima: el aviso no lo repite (en «Mis documentos» sí lo lleva).
    expect(reminder.textContent).not.toContain("Safari");
    expect(within(reminder).getByRole("button", { name: copy.reminderNow })).toBeTruthy();
    expect(within(reminder).getByRole("button", { name: copy.reminderLater })).toBeTruthy();
  });

  it("con 9 cambios no aparece", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify({ changes: 9, since: new Date().toISOString() }));
    renderSection();
    await waitFor(() => expect(document.querySelector("[data-backup-last]")?.textContent).toBe(copy.lastNever));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector("[data-backup-reminder]")).toBeNull();
  });

  it("a los 30 días del último respaldo aparece por «días»", async () => {
    await seedDoc("doc-a", 1);
    window.localStorage.setItem(LAST_BACKUP_KEY, new Date(Date.now() - 31 * DAY).toISOString());
    renderSection();
    const reminder = await waitFor(() => {
      const node = document.querySelector("[data-backup-reminder]") as HTMLElement | null;
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(reminder.getAttribute("data-backup-reminder")).toBe("days");
    expect(reminder.textContent).toContain("Han pasado 31 días desde tu último respaldo.");
  });

  it("sin nada que respaldar no avisa aunque hayan pasado los días (solo ajustes no cuentan)", async () => {
    window.localStorage.setItem("optimuspdf.theme", "dark");
    window.localStorage.setItem(LAST_BACKUP_KEY, new Date(Date.now() - 90 * DAY).toISOString());
    renderSection();
    await waitFor(() => expect(document.querySelector("[data-backup-last]")?.textContent).toBe("Último respaldo: hace 90 días."));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(document.querySelector("[data-backup-reminder]")).toBeNull();
  });

  it("quien nunca respaldó y no tiene ancla recibe una desde hoy (no avisa de inmediato)", async () => {
    await seedDoc("doc-a", 1);
    window.localStorage.removeItem(BACKUP_REMINDER_KEY);
    renderSection();
    await waitFor(() => expect(readReminderState().since).toBeTruthy());
    expect(document.querySelector("[data-backup-reminder]")).toBeNull();
  });

  it("«Recordármelo luego»: se oculta 7 días, lo anuncia y devuelve el foco al contenedor", async () => {
    await dueByChanges();
    renderSection();
    const later = await screen.findByRole("button", { name: copy.reminderLater });
    later.focus();
    fireEvent.click(later);
    await waitFor(() => expect(document.querySelector("[data-backup-reminder]")).toBeNull());
    expect(document.querySelector("[data-backup-live]")?.textContent).toBe(copy.reminderLaterDone);
    expect(document.activeElement?.getAttribute("data-backup-reminder-host")).toBe("");
    const state = readReminderState();
    expect(Date.parse(state.snoozeUntil as string) - Date.now()).toBeGreaterThan(6.99 * DAY);
    expect(Date.parse(state.snoozeUntil as string) - Date.now()).toBeLessThanOrEqual(7 * DAY);
    expect(state.changes).toBe(12);
  });

  it("«Respaldar ahora» abre «Exportar mi paquete»", async () => {
    await dueByChanges();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: copy.reminderNow }));
    expect(await screen.findByRole("dialog", { name: copy.exportTitle })).toBeTruthy();
  });

  it("exportar de verdad reinicia el recordatorio y deja de verse", async () => {
    await dueByChanges();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: copy.reminderNow }));
    await screen.findByText(/Se exportará:/);
    fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(window.localStorage.getItem(LAST_BACKUP_KEY)).not.toBeNull());
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-backup-reminder]")).toBeNull());
  });
});

describe("integración en las pantallas", () => {
  it("Ajustes incluye la sección y «Mis documentos» el aviso discreto con «Respaldar ahora»", async () => {
    await seedDoc("doc-a", 1, { name: "Contrato A" });
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify({ changes: 15, since: new Date().toISOString() }));
    const settings = render(
      <ThemeProvider>
        <LanguageProvider>
          <SettingsView />
        </LanguageProvider>
      </ThemeProvider>,
    );
    expect(screen.getByRole("heading", { name: copy.title, level: 2 })).toBeTruthy();
    expect(await screen.findByText(copy.reminderTitle)).toBeTruthy();
    settings.unmount();

    render(
      <LanguageProvider>
        <MyDocumentsView />
      </LanguageProvider>,
    );
    const reminder = await waitFor(() => {
      const node = document.querySelector("[data-backup-reminder]") as HTMLElement | null;
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    // En «Mis documentos» el aviso NO añade región viva: usa la de la página.
    expect(reminder.querySelector('[role="status"]')).toBeNull();
    expect(within(reminder).getByRole("heading", { name: copy.reminderTitle, level: 2 })).toBeTruthy();
    expect(reminder.textContent).toContain("Safari puede borrar los datos de un sitio web");
    fireEvent.click(within(reminder).getByRole("button", { name: copy.reminderNow }));
    expect(await screen.findByRole("dialog", { name: copy.exportTitle })).toBeTruthy();
  });

  it("en «Mis documentos» posponer anuncia por la región viva de la página", async () => {
    await seedDoc("doc-a", 1, { name: "Contrato A" });
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify({ changes: 15, since: new Date().toISOString() }));
    render(
      <LanguageProvider>
        <MyDocumentsView />
      </LanguageProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: copy.reminderLater }));
    await waitFor(() => expect(document.querySelector("[data-documents-live]")?.textContent).toBe(copy.reminderLaterDone));
    expect(document.querySelector("[data-backup-reminder]")).toBeNull();
  });
});
