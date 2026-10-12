import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "@/components/views/SettingsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { STRINGS as PRIVACY } from "@/app/privacy/strings";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  PRO_FEATURE_FLAGS,
  PRO_FEATURE_FLAGS_STORAGE_KEY,
  __resetProFeatureFlagsCacheForTests,
} from "@/app/pdf-pro/proFeatureFlags";
import { __resetEditPdfFeatureFlagsCacheForTests } from "@/app/edit-pdf/editFeatureFlags";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import * as proDrafts from "@/app/pdf-pro/proDrafts";
import { clearHandoff, hasHandoff, setHandoff } from "@/app/pdf-pro/proHandoff";
import { fakeBytes, fakeFile } from "@/app/pdf-pro/proTestUtils";

/**
 * Ajustes -> PDF Pro: interruptores (es/en, persisten) y «Borrar datos locales» vacia los
 * borradores de PDF Pro (y dice cual falla). La politica de privacidad declara lo que se guarda.
 */

vi.mock("@/app/pdf-pro/proDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/pdf-pro/proDrafts")>();
  return { ...actual, clearLocalProData: vi.fn(actual.clearLocalProData) };
});

const ID = "ab".repeat(32);

async function seedProDraft() {
  const result = await proDrafts.saveProDraft({
    id: ID,
    fileName: "informe.pdf",
    bytes: fakeBytes(50),
    snapshotId: "s1",
    history: [{ label: "Original", createdAt: 1, source: "open" }],
    pageCount: 2,
  });
  expect(result.ok).toBe(true);
}

function renderSettings() {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  return render(
    <LanguageProvider>
      <ThemeProvider>
        <SettingsView />
      </ThemeProvider>
    </LanguageProvider>,
  );
}

const clearButton = () => screen.getByRole("button", { name: es.settings.clearData });

beforeEach(async () => {
  window.localStorage.clear();
  __resetProFeatureFlagsCacheForTests();
  __resetEditPdfFeatureFlagsCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  clearHandoff();
  await proDrafts.clearAllProDrafts();
  vi.mocked(proDrafts.clearLocalProData).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("Ajustes — interruptores de PDF Pro", () => {
  const copy = es.settings.proFeatures;

  it("aparece la tarjeta con titulo, explicacion y una casilla por flag", () => {
    renderSettings();
    expect(screen.getByText(es.settings.proFeaturesTitle)).toBeTruthy();
    expect(screen.getByText(es.settings.proFeaturesBody)).toBeTruthy();
    for (const flag of PRO_FEATURE_FLAGS) {
      expect(screen.getByRole("checkbox", { name: copy[flag].label })).toBeTruthy();
      expect(screen.getByText(copy[flag].hint)).toBeTruthy();
    }
  });

  it("los dos flags estan ACTIVOS por defecto", () => {
    renderSettings();
    for (const flag of PRO_FEATURE_FLAGS) {
      expect((screen.getByRole("checkbox", { name: copy[flag].label }) as HTMLInputElement).checked).toBe(true);
    }
  });

  it("apagar proAutosave se PERSISTE y se puede volver a encender", async () => {
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.proAutosave.label }) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(JSON.parse(window.localStorage.getItem(PRO_FEATURE_FLAGS_STORAGE_KEY)!)).toEqual({ proAutosave: false });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("el interruptor del visor continuo ya no se ofrece en Ajustes", () => {
    renderSettings();
    expect(screen.queryByRole("checkbox", { name: /continuo|continuous/i })).toBeNull();
  });

  it("un valor guardado se respeta al volver a abrir Ajustes", () => {
    window.localStorage.setItem(PRO_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ proAutosave: false }));
    renderSettings();
    expect((screen.getByRole("checkbox", { name: copy.proAutosave.label }) as HTMLInputElement).checked).toBe(false);
  });

  it("en ingles aparecen los textos en ingles", async () => {
    renderSettings();
    // El idioma vive en un store de modulo: se cambia con el selector y se restaura.
    fireEvent.click(screen.getByRole("tab", { name: es.common.english }));
    try {
      expect(await screen.findByText(en.settings.proFeaturesTitle)).toBeTruthy();
      for (const flag of PRO_FEATURE_FLAGS) {
        expect(screen.getByRole("checkbox", { name: en.settings.proFeatures[flag].label })).toBeTruthy();
      }
    } finally {
      fireEvent.click(screen.getByRole("tab", { name: en.common.spanish }));
    }
  });

  it("es y en tienen etiqueta y pista razonables para cada flag, y el texto del editor no se repite", () => {
    for (const dictionary of [es, en]) {
      for (const flag of PRO_FEATURE_FLAGS) {
        expect(dictionary.settings.proFeatures[flag].label.length).toBeGreaterThan(8);
        expect(dictionary.settings.proFeatures[flag].hint.length).toBeGreaterThan(40);
      }
      expect(dictionary.settings.proFeaturesBody).not.toBe(dictionary.settings.editPdfFeaturesBody);
    }
  });

  it("no rompe las tarjetas de Firmar PDF ni del editor", () => {
    renderSettings();
    for (const entry of Object.values(es.settings.signPdfFeatures)) {
      expect(screen.getByRole("checkbox", { name: entry.label })).toBeTruthy();
    }
    expect(screen.getByText(es.settings.editPdfFeaturesTitle)).toBeTruthy();
  });
});

describe("Ajustes — «Borrar datos locales» y PDF Pro", () => {
  it("vacia los borradores de PDF Pro y confirma", async () => {
    await seedProDraft();
    expect(await proDrafts.listProDrafts()).toHaveLength(1);
    renderSettings();
    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
    expect(await proDrafts.listProDrafts()).toHaveLength(0);
    expect(vi.mocked(proDrafts.clearLocalProData)).toHaveBeenCalledTimes(1);
  });

  it("descarta tambien el archivo que esperaba en el traspaso (memoria)", async () => {
    setHandoff(fakeFile(), "merge-pdf");
    renderSettings();
    fireEvent.click(clearButton());
    await screen.findByText(es.settings.cleared);
    expect(hasHandoff()).toBe(false);
  });

  it("si los borradores de PDF Pro no se pueden borrar NO dice «borrados» y nombra cual falla", async () => {
    await seedProDraft();
    vi.mocked(proDrafts.clearLocalProData).mockResolvedValueOnce(["proDrafts"]);
    renderSettings();
    fireEvent.click(clearButton());
    const message = await screen.findByText(SIGN_STRINGS.es.vaultClearFailed(["proDrafts"]));
    expect(message.textContent).toMatch(/borradores de PDF Pro/);
    expect(screen.queryByText(es.settings.cleared)).toBeNull();
    // El boton sigue sirviendo para reintentar.
    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
    expect(await proDrafts.listProDrafts()).toHaveLength(0);
  });

  it("si fallan a la vez los de PDF Pro y los del editor, se nombran los dos", () => {
    const text = SIGN_STRINGS.es.vaultClearFailed(["editDrafts", "proDrafts"]);
    expect(text).toMatch(/borradores del editor y borradores de PDF Pro/);
    expect(SIGN_STRINGS.en.vaultClearFailed(["proDrafts"])).toMatch(/PDF Pro drafts/);
  });

  it("sin IndexedDB no hay nada que borrar: se confirma el borrado", async () => {
    vi.stubGlobal("indexedDB", undefined);
    renderSettings();
    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
  });
});

describe("Privacidad — PDF Pro se declara", () => {
  it("el texto de datos locales de Ajustes (es y en) menciona PDF Pro, su base propia y el borrado", () => {
    expect(es.settings.dataBody).toMatch(/PDF Pro/);
    expect(es.settings.dataBody).toMatch(/base propia/);
    expect(en.settings.dataBody).toMatch(/PDF Pro/);
    expect(en.settings.dataBody).toMatch(/own database/);
  });

  it("la politica (es y en) describe que guarda: PDF actual, historial ligero, huella, limites, cifrados y el traspaso en memoria", () => {
    const es_ = PRIVACY.es.sections.flatMap((s) => s.body).join("\n");
    const en_ = PRIVACY.en.sections.flatMap((s) => s.body).join("\n");
    for (const pattern of [/«PDF Pro»/, /IndexedDB/, /huella/, /10 borradores/, /150 MB por borrador/, /protegidos con contraseña/, /Abrir en PDF Pro/, /memoria de la pestaña/, /400 MB/]) {
      expect(es_).toMatch(pattern);
    }
    for (const pattern of [/\"PDF Pro\"/, /fingerprint/, /10 drafts/, /150 MB per draft/, /password-protected/, /Open in PDF Pro/, /memory/, /400 MB/]) {
      expect(en_).toMatch(pattern);
    }
  });

  it("la frase de «borrar todo» sigue mencionando Firmar y el editor, y anade PDF Pro", () => {
    const es_ = PRIVACY.es.sections.flatMap((s) => s.body).join("\n");
    expect(es_).toMatch(/borradores de «Firmar PDF» y del editor de PDF incluidos, y también los de «PDF Pro»/);
    const en_ = PRIVACY.en.sections.flatMap((s) => s.body).join("\n");
    expect(en_).toMatch(/and the \\"PDF Pro\\" ones too|and the "PDF Pro" ones too/);
  });

  it("dice que ningun dato se envia a un servidor y que se puede apagar el autoguardado", () => {
    const es_ = PRIVACY.es.sections.flatMap((s) => s.body).join("\n");
    expect(es_).toMatch(/Puedes apagar el autoguardado en «Ajustes»/);
    expect(PRIVACY.en.sections.flatMap((s) => s.body).join("\n")).toMatch(/turn autosave off in/);
  });
});
