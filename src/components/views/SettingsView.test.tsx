import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "@/components/views/SettingsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { clearAllDrafts, listDrafts, saveDraft } from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  __resetSignTemplatesCacheForTests,
  listTemplates,
  saveTemplate,
} from "@/app/sign-pdf/signTemplates";
import {
  SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  DEFAULT_SIGN_PDF_FEATURE_FLAGS,
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";
import { clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import { clearValueHistory, recordValue, suggestValues } from "@/lib/valueHistory";

/**
 * «Borrar datos locales» de Ajustes: borra TODO lo que guarda la app en el
 * navegador, incluidas las plantillas (hueco preexistente: sobrevivian) y el
 * baul de firmas (W3), este o no activo su flag.
 */

vi.mock("@/app/sign-pdf/signDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signDrafts")>();
  return { ...actual, clearAllDrafts: vi.fn(actual.clearAllDrafts) };
});

vi.mock("@/app/sign-pdf/signVault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signVault")>();
  return { ...actual, clearVault: vi.fn(actual.clearVault) };
});

async function seedEverything() {
  recordValue("nombre", "Ana Perez");
  saveTemplate({
    name: "Contrato tipo",
    pageCount: 2,
    signers: [{ id: "sg-1", name: "Ana Pérez", color: "#0d4bff" }],
    fields: [],
    textFields: [],
  });
  await saveDraft({
    id: "doc-1",
    fileBytes: new Uint8Array([1, 2, 3]),
    fileName: "doc-1.pdf",
    manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
  });
  const saved = await saveVaultEntry(vaultInput("Ana Pérez"));
  expect(saved.ok).toBe(true);
}

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignTemplatesCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  clearValueHistory();
  await clearAllDrafts();
  await clearVault();
  vi.mocked(clearVault).mockClear();
  vi.mocked(clearAllDrafts).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

function renderSettings() {
  return render(
    <LanguageProvider>
      <ThemeProvider>
        <SettingsView />
      </ThemeProvider>
    </LanguageProvider>,
  );
}

const clearButton = () =>
  screen.getByRole("button", { name: es.settings.clearData });

describe("SettingsView — «Borrar datos locales»", () => {
  it("borra valores, borradores, PLANTILLAS y firmas guardadas", async () => {
    await seedEverything();
    expect(listTemplates()).toHaveLength(1);
    expect(suggestValues("nombre", "")).not.toHaveLength(0);
    renderSettings();

    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();

    expect(listTemplates()).toHaveLength(0);
    expect(suggestValues("nombre", "")).toHaveLength(0);
    expect(await listDrafts()).toHaveLength(0);
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("borra el baul aunque su flag este apagado", async () => {
    window.localStorage.setItem(
      SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ signatureVault: false }),
    );
    __resetSignPdfFeatureFlagsCacheForTests();
    await seedEverything();
    renderSettings();
    fireEvent.click(clearButton());
    await screen.findByText(es.settings.cleared);
    expect((await listVault()).entries).toHaveLength(0);
    expect(vi.mocked(clearVault)).toHaveBeenCalledTimes(1);
  });

  it("solo afirma «borrados» cuando el baul termino de borrarse (no antes)", async () => {
    await seedEverything();
    let release: () => void = () => {};
    const actual = await vi.importActual<typeof import("@/app/sign-pdf/signVault")>(
      "@/app/sign-pdf/signVault",
    );
    vi.mocked(clearVault).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => void actual.clearVault().then(resolve);
        }),
    );
    renderSettings();
    fireEvent.click(clearButton());
    // Los borrados sincronos ya se hicieron, pero el aviso espera al asincrono.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(es.settings.cleared)).toBeNull();
    expect((await listVault()).entries).toHaveLength(1);

    release();
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("la region de estado esta montada desde el principio (vacia)", () => {
    renderSettings();
    const status = screen.getAllByRole("status");
    expect(status.some((node) => node.textContent === "")).toBe(true);
  });

  it("el texto de datos locales menciona las firmas guardadas y el archivo exportado (es y en)", () => {
    for (const dictionary of [es, en]) {
      const body = dictionary.settings.dataBody;
      expect(body).toMatch(/IndexedDB/);
      expect(body).toMatch(/(firma|signature)/i);
      expect(body).toMatch(/(claro|in the clear)/);
    }
  });
});

describe("SettingsView — si el borrado falla NO se dice «borrados»", () => {
  const strings = SIGN_STRINGS.es;

  it("baul bloqueado: muestra el error (role=status), no el exito, y el boton sirve para reintentar", async () => {
    await seedEverything();
    vi.mocked(clearVault).mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    renderSettings();
    fireEvent.click(clearButton());

    const message = await screen.findByText(strings.vaultClearFailed(["vault"]));
    expect(message.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByText(es.settings.cleared)).toBeNull();
    // La firma sigue ahi: no se mintio.
    expect((await listVault()).entries).toHaveLength(1);

    // Reintento: ahora si.
    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
    expect(screen.queryByText(strings.vaultClearFailed(["vault"]))).toBeNull();
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("borradores que no se pueden borrar: tambien se dice", async () => {
    vi.mocked(clearAllDrafts).mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    renderSettings();
    fireEvent.click(clearButton());
    expect(await screen.findByText(strings.vaultClearFailed(["drafts"]))).toBeTruthy();
    expect(screen.queryByText(es.settings.cleared)).toBeNull();
  });

  it("fallan los dos: se nombran los dos", async () => {
    vi.mocked(clearAllDrafts).mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    vi.mocked(clearVault).mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    renderSettings();
    fireEvent.click(clearButton());
    expect(
      await screen.findByText(strings.vaultClearFailed(["drafts", "vault"])),
    ).toBeTruthy();
  });

  it("sin IndexedDB en el navegador no hay nada que borrar y se confirma el borrado", async () => {
    vi.stubGlobal("indexedDB", undefined);
    renderSettings();
    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
  });

  it("el mensaje de fallo existe en espanol e ingles y nombra el almacen", () => {
    for (const language of ["es", "en"] as const) {
      const copy = SIGN_STRINGS[language];
      expect(copy.vaultClearFailed(["vault"])).toMatch(/(firmas guardadas|saved signatures)/);
      expect(copy.vaultClearFailed(["drafts"])).toMatch(/(borradores|drafts)/);
    }
  });
});

describe("Ajustes — interruptor «Firmas guardadas»", () => {
  it("existe, esta activo por defecto y se puede apagar", async () => {
    expect(SIGN_PDF_FEATURE_FLAGS).toContain("signatureVault");
    expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS.signatureVault).toBe(true);
    renderSettings();
    const toggle = screen.getByRole("checkbox", {
      name: es.settings.signPdfFeatures.signatureVault.label,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
  });

  it("tiene texto en espanol e ingles", () => {
    for (const dictionary of [es, en]) {
      const copy = dictionary.settings.signPdfFeatures.signatureVault;
      expect(copy.label.length).toBeGreaterThan(3);
      expect(copy.hint.length).toBeGreaterThan(20);
    }
  });
});
