import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BackupSection } from "@/app/settings/BackupSection";
import { ExportPackageSheet } from "@/app/settings/ExportPackageSheet";
import { ImportPackageSheet } from "@/app/settings/ImportPackageSheet";
import { ExportBackupSheet } from "@/app/documents/ExportBackupSheet";
import { ImportBackupSheet } from "@/app/documents/ImportBackupSheet";
import { clearVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { BACKUP_REMINDER_KEY, LAST_BACKUP_KEY, LAST_BACKUP_PARTS_KEY, readLastBackupParts } from "@/lib/backup/lastBackup";
import { readReminderState } from "@/lib/backup/backupReminder";
import { exportEverything } from "@/lib/backup/globalPackage";
import { readPackage } from "@/lib/backup/package";
import { clearAllLocalDrafts } from "@/lib/backup/__fixtures__/draftsKit";
import { seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { asFile, vaultInput } from "@/lib/backup/__fixtures__/testKit";
import { __resetLibraryForTests, clearLibrary, listDocuments } from "@/lib/docLibrary/store";
import { useEffect } from "react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/**
 * Lo visible de las correcciones tras la verificación independiente (H1, H2, H4, H5, H6, H8 y el cierre durante la
 * importación), con jsdom + fake-indexeddb sobre los almacenes REALES. Las puertas de pdf.js/PNG, la descarga y la recarga
 * se sustituyen (se ejercitan en el E2E).
 */

const gate = { hold: false, release: null as null | (() => void) };

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
vi.mock("@/lib/backup/globalPackage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backup/globalPackage")>();
  return {
    ...actual,
    // Para poder «parar» una importación a mitad y probar que la hoja no se cierra mientras se aplica.
    applyEverything: async (...args: Parameters<typeof actual.applyEverything>) => {
      if (gate.hold) await new Promise<void>((resolve) => (gate.release = resolve));
      return actual.applyEverything(...args);
    },
  };
});

const copy = es.settings.backup;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => String(values[k] ?? m));
const FLAGS_KEY = "optimuspdf.signPdf.featureFlags";
const NOTICE_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  gate.hold = false;
  gate.release = null;
  vi.mocked(downloadBlob).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const statusText = () => within(screen.getByRole("dialog")).getByRole("status").textContent ?? "";
const zipInput = () => document.querySelector("[data-backup-file-input]") as HTMLInputElement;
const moduleOf = (name: string) => document.querySelector(`[data-backup-module="${name}"]`) as HTMLElement;
const confirmButton = () => document.querySelector("[data-backup-confirm]") as HTMLButtonElement;
const rowOf = (id: string) => document.querySelector(`[data-backup-setting-row="${id}"]`) as HTMLElement;

function SetLanguage({ language }: { language: "es" | "en" }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(language), [language, setLanguage]);
  return null;
}

function renderImport(language: "es" | "en" = "es") {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <SetLanguage language={language} />
      <ImportPackageSheet open onClose={onClose} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onClose, onDone };
}
async function pickZip(file: File, pickLabel = copy.pickZip) {
  await screen.findByRole("button", { name: pickLabel });
  fireEvent.change(zipInput(), { target: { files: [file] } });
}

/** Un paquete SOLO de ajustes con `packaged` en el navegador de origen; luego el navegador local queda con `local`. */
async function settingsPackage(packaged: Record<string, string>, local: Record<string, string> = {}) {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  for (const [key, value] of Object.entries(packaged)) window.localStorage.setItem(key, value);
  const result = await exportEverything({ modules: { settings: true } });
  if (!result.ok) throw new Error(result.reason);
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  for (const [key, value] of Object.entries(local)) window.localStorage.setItem(key, value);
  return asFile(result.blob, result.filename);
}

const PACKAGED = {
  "optimuspdf.theme": "dark",
  [FLAGS_KEY]: JSON.stringify({ keyboardNav: false, signatureVault: false }),
  [NOTICE_KEY]: "1",
};
const LOCAL = {
  "optimuspdf.theme": "light",
  [FLAGS_KEY]: JSON.stringify({ keyboardNav: true, signatureVault: true }),
  "optimuspdf.language": "es",
};

/* ------------------------------------------------------------------ *
 * H8 — Ajustes: qué cambiaría
 * ------------------------------------------------------------------ */

describe("H8 — la vista previa de Ajustes lista QUÉ cambiaría", () => {
  it("una fila por ajuste con nombre legible, «Ahora → Paquete», lo sensible marcado y OMITIDO por defecto", async () => {
    renderImport();
    await pickZip(await settingsPackage(PACKAGED, LOCAL));
    await waitFor(() => expect(moduleOf("settings")).toBeTruthy());
    const rows = [...document.querySelectorAll("[data-backup-setting-row]")].map((node) => node.getAttribute("data-backup-setting-row"));
    expect(rows).toEqual(["optimuspdf.theme", `${FLAGS_KEY}#keyboardNav`, `${FLAGS_KEY}#signatureVault`, NOTICE_KEY]);

    // Nombres de persona, nunca la clave técnica.
    expect(rowOf("optimuspdf.theme").textContent).toContain("Apariencia · Tema");
    expect(rowOf("optimuspdf.theme").textContent).toContain("Ahora: Claro → Paquete: Oscuro");
    expect(rowOf(`${FLAGS_KEY}#keyboardNav`).textContent).toContain("Firmar PDF · Navegación por teclado");
    expect(rowOf(`${FLAGS_KEY}#keyboardNav`).textContent).toContain("Ahora: Activado → Paquete: Desactivado");
    expect(rowOf(`${FLAGS_KEY}#signatureVault`).textContent).toContain("Firmar PDF · Firmas guardadas");
    expect(rowOf(NOTICE_KEY).textContent).toContain("Avisos · Aviso de privacidad de Firmar ya visto");
    expect(rowOf(NOTICE_KEY).textContent).toContain("Ahora: No visto (por defecto) → Paquete: Visto");
    expect(moduleOf("settings").textContent).not.toContain("optimuspdf.");

    // Lo que afecta a la privacidad está marcado y en «Omitir»; el resto, en «Reemplazar».
    const checked = (id: string) => within(rowOf(id)).getByRole("radio", { checked: true }).getAttribute("data-decision");
    expect(rowOf(NOTICE_KEY).querySelector("[data-backup-setting-sensitive]")?.textContent).toBe(copy.settingSensitiveBadge);
    expect(rowOf(`${FLAGS_KEY}#signatureVault`).getAttribute("data-sensitive")).toBe("true");
    expect(rowOf("optimuspdf.theme").getAttribute("data-sensitive")).toBe("false");
    expect(checked(NOTICE_KEY)).toBe("omit");
    expect(checked(`${FLAGS_KEY}#signatureVault`)).toBe("omit");
    expect(checked("optimuspdf.theme")).toBe("replace");
    expect(checked(`${FLAGS_KEY}#keyboardNav`)).toBe("replace");
    expect(moduleOf("settings").querySelector("[data-backup-sensitive-note]")?.textContent).toBe(copy.settingsSensitiveNote);
    // Con las sugeridas se importan 2 ajustes (tema y el interruptor de teclado); mezcla: ninguna opción general marcada.
    expect(confirmButton().textContent).toBe(fill(copy.importConfirmMany, { n: 2 }));
    const group = within(moduleOf("settings")).getByRole("radiogroup", { name: fill(copy.decisionGroup, { name: copy.settingsAllGroup }) });
    expect(within(group).queryAllByRole("radio", { checked: true })).toHaveLength(0);
  });

  it("decidir por ajuste, «Reemplazar todos» y «Omitir todos» cambian el recuento; aplicar escribe solo lo decidido", async () => {
    renderImport();
    await pickZip(await settingsPackage(PACKAGED, LOCAL));
    await waitFor(() => expect(moduleOf("settings")).toBeTruthy());
    const all = within(moduleOf("settings")).getByRole("radiogroup", { name: fill(copy.decisionGroup, { name: copy.settingsAllGroup }) });

    fireEvent.click(within(all).getByRole("radio", { name: copy.decisionReplaceAll }));
    expect(confirmButton().textContent).toBe(fill(copy.importConfirmMany, { n: 3 }));
    expect(within(rowOf(NOTICE_KEY)).getByRole("radio", { checked: true }).getAttribute("data-decision")).toBe("replace");

    fireEvent.click(within(all).getByRole("radio", { name: copy.decisionOmitAll }));
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().textContent).toBe(copy.importNothing);

    // Solo el tema y el interruptor sensible de «Firmas guardadas».
    fireEvent.click(within(rowOf("optimuspdf.theme")).getByRole("radio", { name: copy.decisionReplace }));
    fireEvent.click(within(rowOf(`${FLAGS_KEY}#signatureVault`)).getByRole("radio", { name: copy.decisionReplace }));
    expect(confirmButton().textContent).toBe(fill(copy.importConfirmMany, { n: 2 }));
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultSettings, { n: 2 }));
    expect(window.localStorage.getItem("optimuspdf.theme")).toBe("dark");
    // El interruptor elegido cambia; el de teclado (no elegido) se queda como estaba.
    expect(JSON.parse(window.localStorage.getItem(FLAGS_KEY) as string)).toEqual({ keyboardNav: true, signatureVault: false });
    expect(window.localStorage.getItem(NOTICE_KEY)).toBeNull();
  });

  it("en inglés: nombres, estados y textos en inglés, sin español ni claves crudas", async () => {
    const file = await settingsPackage(PACKAGED, { ...LOCAL, [LANGUAGE_STORAGE_KEY]: "en" });
    renderImport("en");
    await pickZip(file, en.settings.backup.pickZip);
    await waitFor(() => expect(moduleOf("settings")).toBeTruthy());
    expect(rowOf("optimuspdf.theme").textContent).toContain("Appearance · Theme");
    expect(rowOf("optimuspdf.theme").textContent).toContain("Now: Light → Package: Dark");
    expect(rowOf(`${FLAGS_KEY}#signatureVault`).textContent).toContain("Sign PDF · ");
    expect(rowOf(NOTICE_KEY).textContent).toContain("Notices · Sign privacy notice already seen");
    expect(rowOf(NOTICE_KEY).querySelector("[data-backup-setting-sensitive]")?.textContent).toBe("Affects your privacy");
    expect(moduleOf("settings").textContent).not.toMatch(/Ahora|Paquete|Reemplazar|Omitir|optimuspdf\./);
    expect(within(rowOf(NOTICE_KEY)).getByRole("radio", { name: "Skip" }).getAttribute("aria-checked")).toBe("true");
  });

  it("un ajuste cuyos valores ya coinciden no sale en la lista", async () => {
    renderImport();
    await pickZip(await settingsPackage({ "optimuspdf.theme": "dark" }, { "optimuspdf.theme": "dark" }));
    await waitFor(() => expect(moduleOf("settings")).toBeTruthy());
    expect(document.querySelector("[data-backup-setting-row]")).toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * H4 — «El paquete no incluye esto»
 * ------------------------------------------------------------------ */

describe("H4 — el resultado distingue lo que el paquete no traía de un fallo", () => {
  it("un paquete de solo firmas: «El paquete no incluye: …» y ningún «no se importó»", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    const result = await exportEverything({ modules: { signatures: true } });
    if (!result.ok) throw new Error(result.reason);
    await clearVault();
    renderImport();
    await pickZip(asFile(result.blob));
    await waitFor(() => expect(moduleOf("signatures")).toBeTruthy());
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultSignatures, { n: 1 }));
    const lines = [...document.querySelectorAll("[data-backup-result] li")].map((node) => node.textContent);
    expect(lines).toEqual(["Firmas: 1 importadas.", "El paquete no incluye: Plantillas y documentos, Borradores, Ajustes."]);
    expect(document.querySelector("[data-backup-result]")?.textContent).not.toMatch(/no se import/i);
  });
});

/* ------------------------------------------------------------------ *
 * Cerrar durante la importación
 * ------------------------------------------------------------------ */

describe("cerrar la hoja mientras se aplica la importación", () => {
  it("Escape, clic fuera y la X no cierran: el resultado se conserva; al terminar se cierra con normalidad", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    const result = await exportEverything({ modules: { signatures: true } });
    if (!result.ok) throw new Error(result.reason);
    await clearVault();
    const { onClose } = renderImport();
    await pickZip(asFile(result.blob));
    await waitFor(() => expect(moduleOf("signatures")).toBeTruthy());

    gate.hold = true;
    fireEvent.click(confirmButton());
    await waitFor(() => expect(gate.release).not.toBeNull());
    await waitFor(() => expect(statusText()).toContain("Importando"));

    // Los tres intentos de cierre se ignoran y se dice por qué.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector("[data-sheet-scrim]") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: es.common.close }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: es.common.close }).getAttribute("aria-disabled")).toBe("true");
    await waitFor(() => expect(statusText()).toContain(copy.closeBusy));
    expect(document.querySelector("[data-sheet-closing]")).toBeNull();

    gate.release?.();
    await screen.findByText(fill(copy.resultSignatures, { n: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: es.common.close }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("fuera de la importación Escape cierra como siempre (elegir archivo)", async () => {
    const { onClose } = renderImport();
    await screen.findByRole("button", { name: copy.pickZip });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

/* ------------------------------------------------------------------ *
 * H2 — un respaldo parcial no presume de completo
 * ------------------------------------------------------------------ */

describe("H2 — exportar solo una parte", () => {
  async function exportOnly(keep: RegExp[]) {
    fireEvent.click(await screen.findByRole("button", { name: copy.exportAction }));
    const dialog = await screen.findByRole("dialog", { name: copy.exportTitle });
    await waitFor(() => expect(dialog.querySelector("[data-backup-summary]")?.textContent).toMatch(/Se exportará:/));
    for (const pattern of [/^Firmas guardadas/, /^Plantillas y documentos/, /^Borradores en curso/, /^Ajustes/]) {
      const box = within(dialog).getByRole("checkbox", { name: pattern }) as HTMLInputElement;
      if (box.checked && !keep.some((wanted) => wanted.source === pattern.source)) fireEvent.click(box);
    }
    const protect = within(dialog).getByRole("checkbox", { name: copy.protect }) as HTMLInputElement;
    if (protect.checked) fireEvent.click(protect);
    fireEvent.click(within(dialog).getByRole("button", { name: copy.exportConfirm }));
    await within(dialog).findByRole("button", { name: copy.doneClose });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.doneClose }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }

  async function seedWork() {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    await seedDoc("doc-a", 1);
    window.localStorage.setItem("optimuspdf.theme", "dark");
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify({ changes: 12, by: { signatures: 7, library: 5 }, since: new Date().toISOString() }));
  }

  it("solo Ajustes: no marca «último respaldo», no reinicia el contador y la línea dice «parcial»", async () => {
    await seedWork();
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <BackupSection />
      </LanguageProvider>,
    );
    await exportOnly([/^Ajustes/]);
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    expect(readLastBackupParts().settings).toBeInstanceOf(Date);
    expect(readReminderState()).toMatchObject({ changes: 12, by: { signatures: 7, library: 5 } });
    await waitFor(() => expect(document.querySelector("[data-backup-last]")?.textContent).toBe("Último respaldo parcial (Ajustes): hoy. Aún no has hecho un respaldo completo."));
    // El aviso sigue ahí: lo que de verdad importa (firmas y documentos) no está respaldado.
    expect(document.querySelector("[data-backup-reminder]")).not.toBeNull();
  });

  it("solo Firmas: descuenta solo los cambios de las firmas; añadir la biblioteca cubre lo vigilado (el aviso se calla) y todo junto es completo", async () => {
    await seedWork();
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <BackupSection />
      </LanguageProvider>,
    );
    await exportOnly([/^Firmas guardadas/]);
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    expect(readReminderState().by).toEqual({ library: 5 });
    await waitFor(() => expect(document.querySelector("[data-backup-last]")?.textContent).toBe("Último respaldo parcial (Firmas): hoy. Aún no has hecho un respaldo completo."));
    await exportOnly([/^Plantillas y documentos/]);
    // Dos respaldos parciales seguidos: cada uno descuenta lo suyo y el contador queda a cero, pero NO es «un respaldo completo».
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    expect(readReminderState().changes).toBe(0);
    await waitFor(() => expect(document.querySelector("[data-backup-last]")?.textContent).toBe("Último respaldo parcial (Firmas, Plantillas y documentos): hoy. Aún no has hecho un respaldo completo."));
    expect(document.querySelector("[data-backup-reminder]")).toBeNull();
    await exportOnly([/^Firmas guardadas/, /^Plantillas y documentos/, /^Ajustes/]);
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).not.toBeNull();
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-backup-last]")?.textContent).toBe(copy.lastToday));
  });

  it("«Mis documentos» (solo plantillas y documentos) con firmas sin respaldar: parcial; sin nada más que respaldar: completo", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    await seedDoc("doc-a", 1);
    const first = render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <ExportBackupSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    await screen.findByText(/Se exportará:/);
    fireEvent.click(await screen.findByRole("checkbox", { name: es.documents.backup.protect }));
    fireEvent.click(screen.getByRole("button", { name: es.documents.backup.exportConfirm }));
    await screen.findByRole("button", { name: es.documents.backup.doneClose });
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    expect(readLastBackupParts().library).toBeInstanceOf(Date);
    expect(readLastBackupParts().signatures).toBeUndefined();
    first.unmount();
    cleanup();

    await clearVault();
    window.localStorage.removeItem(LAST_BACKUP_PARTS_KEY);
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <ExportBackupSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    await screen.findByText(/Se exportará:/);
    fireEvent.click(await screen.findByRole("checkbox", { name: es.documents.backup.protect }));
    fireEvent.click(screen.getByRole("button", { name: es.documents.backup.exportConfirm }));
    await screen.findByRole("button", { name: es.documents.backup.doneClose });
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).not.toBeNull();
  });
});

describe("H2 — el aviso por días cuando solo hubo respaldos parciales", () => {
  it("dice «Aún no has hecho un respaldo completo…» (no «ningún respaldo»), y con uno completo, el de siempre", async () => {
    await seedDoc("doc-a", 1);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    window.localStorage.setItem(LAST_BACKUP_PARTS_KEY, JSON.stringify({ settings: old }));
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify({ changes: 0, since: old }));
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <BackupSection />
      </LanguageProvider>,
    );
    const reminder = await waitFor(() => {
      const node = document.querySelector("[data-backup-reminder]") as HTMLElement | null;
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(reminder.textContent).toContain("Aún no has hecho un respaldo completo y ya han pasado 31 días.");
    expect(reminder.textContent).not.toContain("ningún respaldo");
  });
});

/* ------------------------------------------------------------------ *
 * H5 — documentos sin copia del PDF
 * ------------------------------------------------------------------ */

/** Borra la copia del PDF (la fila del documento sigue diciendo que la tiene): el caso «la copia se perdió». */
async function dropBlob(id: string) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("optimuspdf-doc-library");
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("blobs", "readwrite");
      tx.objectStore("blobs").delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("H5 — se avisa de los documentos que no viajan, antes y después de exportar", () => {
  it("Ajustes: antes («no se incluirá»), el resumen no los cuenta y después («no se incluyó») queda dicho", async () => {
    await seedDoc("doc-a", 1, { name: "Contrato A" });
    await seedDoc("doc-b", 2, { name: "Contrato B" });
    await seedTemplate("doc-a", {}, "tpl-a");
    await dropBlob("doc-b");
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <ExportPackageSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: copy.exportTitle });
    await waitFor(() => expect(dialog.querySelector("[data-backup-summary]")?.textContent).toMatch(/Se exportará: 1 documento, 1 plantilla/));
    expect(dialog.querySelector("[data-backup-without-copy]")?.textContent).toBe("1 documento no se incluirá porque falta su copia del PDF.");
    expect(within(dialog).getByRole("checkbox", { name: /^Plantillas y documentos \(1 documento, 1 plantilla\)/ })).toBeTruthy();

    const protect = within(dialog).getByRole("checkbox", { name: copy.protect }) as HTMLInputElement;
    if (protect.checked) fireEvent.click(protect);
    fireEvent.click(within(dialog).getByRole("button", { name: copy.exportConfirm }));
    await within(dialog).findByRole("button", { name: copy.doneClose });
    expect(dialog.querySelector("[data-backup-note]")?.textContent).toBe("1 documento no se incluyó porque falta su copia del PDF.");
    const [blob] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    const read = await readPackage(blob);
    expect(read.modules.find((m) => m.name === "library")?.meta).toMatchObject({ documents: 1, templates: 1 });
  });

  it("Mis documentos: el aviso de después también está", async () => {
    await seedDoc("doc-a", 1);
    await seedDoc("doc-b", 2);
    await dropBlob("doc-b");
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <ExportBackupSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    await screen.findByText(/Se exportará: 1 documento/);
    expect(screen.getByText(/1 documento no tiene copia del PDF y no se incluirá\./)).toBeTruthy();
    fireEvent.click(await screen.findByRole("checkbox", { name: es.documents.backup.protect }));
    fireEvent.click(screen.getByRole("button", { name: es.documents.backup.exportConfirm }));
    await screen.findByRole("button", { name: es.documents.backup.doneClose });
    expect(document.querySelector("[data-backup-note]")?.textContent).toBe("1 documento no se incluyó porque falta su copia del PDF.");
  });

  it("en inglés", async () => {
    await seedDoc("doc-a", 1);
    await seedDoc("doc-b", 2);
    await dropBlob("doc-b");
    render(
      <LanguageProvider>
        <SetLanguage language="en" />
        <ExportPackageSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: en.settings.backup.exportTitle });
    await waitFor(() => expect(dialog.querySelector("[data-backup-without-copy]")).not.toBeNull());
    expect(dialog.querySelector("[data-backup-without-copy]")?.textContent).toBe("1 document will not be included because its PDF copy is missing.");
  });
});

/* ------------------------------------------------------------------ *
 * H1 — lo que no cabe se dice ANTES, con el motivo y cuánto sobra
 * ------------------------------------------------------------------ */

async function inflateDocumentRows(bytes: number) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("optimuspdf-doc-library");
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("documents", "readwrite");
      const store = tx.objectStore("documents");
      const all = store.getAll();
      all.onsuccess = () => {
        for (const row of all.result) store.put({ ...row, byteLength: bytes });
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("H1 — límite de exportación coherente con el de importación", () => {
  it("Ajustes: si no cabe lo dice ANTES de exportar con cuánto pesa, el máximo y cuánto sobra, y no deja crear el paquete", async () => {
    await seedDoc("doc-a", 1);
    await seedDoc("doc-b", 2);
    await seedDoc("doc-c", 3);
    await inflateDocumentRows(99 * 1024 * 1024); // 3 × 99 MiB = 297 MiB > 242 MiB
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <ExportPackageSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: copy.exportTitle });
    const message = await waitFor(() => {
      const node = dialog.querySelector("[data-backup-too-large]");
      expect(node).not.toBeNull();
      return node?.textContent ?? "";
    });
    expect(message).toMatch(/Lo elegido pesa 297 MB y no cabe en un solo paquete: el máximo es 242 MB y sobran 55 MB\./);
    expect((within(dialog).getByRole("button", { name: copy.exportConfirm }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Mis documentos: el error dice cuánto sobra", async () => {
    await seedDoc("doc-a", 1);
    await seedDoc("doc-b", 2);
    await seedDoc("doc-c", 3);
    await inflateDocumentRows(99 * 1024 * 1024);
    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <ExportBackupSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    await screen.findByText(/Se exportará:/);
    fireEvent.click(await screen.findByRole("checkbox", { name: es.documents.backup.protect }));
    fireEvent.click(screen.getByRole("button", { name: es.documents.backup.exportConfirm }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toMatch(/Sobran 55 MB\./));
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * H6 — el PDF repetido dentro del paquete (hoja de «Mis documentos»)
 * ------------------------------------------------------------------ */

describe("H6 — PDF repetido dentro del paquete", () => {
  it("la tarjeta dice «Repetido en el paquete», con la explicación, sin ofrecer decisión, y no se cuenta como otro documento", async () => {
    const { default: JSZip } = await import("jszip");
    const { exportLibraryWithReport } = await import("@/lib/backup/modules/library");
    const { buildPackage } = await import("@/lib/backup/package");
    const { sha256Hex } = await import("@/lib/crypto/sha256");
    await seedDoc("doc-a", 1, { name: "Contrato A" });
    const { module } = await exportLibraryWithReport();
    const zip = await JSZip.loadAsync(await (await buildPackage({ modules: [module] })).arrayBuffer());
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const index = JSON.parse(await zip.file("documents/index.json")!.async("string"));
    const bytes = await zip.file(index[0].file)!.async("uint8array");
    index.push({ ...index[0], id: "doc-a-copia", name: "Contrato A (copia)", file: "documents/doc-a-copia.pdf" });
    zip.file("documents/doc-a-copia.pdf", bytes);
    manifest.files.push({ path: "documents/doc-a-copia.pdf", sha256: await sha256Hex(bytes), bytes: bytes.length, type: "application/pdf" });
    const idx = new TextEncoder().encode(JSON.stringify(index));
    zip.file("documents/index.json", idx);
    const entry = manifest.files.find((f: { path: string }) => f.path === "documents/index.json");
    entry.sha256 = await sha256Hex(idx);
    entry.bytes = idx.length;
    zip.file("manifest.json", JSON.stringify(manifest));
    const blob = await zip.generateAsync({ type: "blob" });
    await clearLibrary();

    render(
      <LanguageProvider>
        <SetLanguage language="es" />
        <ImportBackupSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    await pickZip(asFile(blob), es.documents.backup.pickZip);
    await waitFor(() => expect(document.querySelector('[data-backup-item="doc-a-copia"]')).not.toBeNull());
    const dup = document.querySelector('[data-backup-item="doc-a-copia"]') as HTMLElement;
    expect(dup.getAttribute("data-status")).toBe("identical");
    expect(dup.textContent).toContain(es.documents.backup.statusDuplicate);
    expect(dup.textContent).toContain("Es el mismo PDF que «Contrato A» del propio paquete");
    expect(within(dup).queryAllByRole("radio")).toHaveLength(0);
    expect(document.querySelector("[data-backup-import]")?.textContent).toContain("El archivo trae 1 documento");
    fireEvent.click(document.querySelector("[data-backup-confirm]") as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-backup-result]")).not.toBeNull());
    expect((await listDocuments()).documents.map((d) => d.id)).toEqual(["doc-a"]);
  });
});
