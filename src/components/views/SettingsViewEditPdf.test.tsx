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
  EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetEditPdfFeatureFlagsCacheForTests,
} from "@/app/edit-pdf/editFeatureFlags";
import {
  clearAllEditDrafts,
  listEditDrafts,
  saveEditDraft,
} from "@/app/edit-pdf/editDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { applyOp, createEditSession, newTextEdit, textItem } from "@/app/edit-pdf/editSession";

/**
 * Ajustes -> editor de PDF: interruptores (persisten), «proximamente» honesto
 * para la limpieza del stream, y «Borrar datos locales» vacia tambien los
 * borradores del editor (y dice cual falla).
 */

vi.mock("@/app/edit-pdf/editDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/edit-pdf/editDrafts")>();
  return { ...actual, clearAllEditDrafts: vi.fn(actual.clearAllEditDrafts) };
});

const ID = "cd".repeat(32);

async function seedDraft() {
  const session = applyOp(
    createEditSession(),
    {
      type: "add",
      item: textItem(
        newTextEdit({
          id: "t1",
          pageIndex: 0,
          box: { x: 1, y: 1, width: 50, height: 10 },
          fontKey: "helvetica",
          text: "hola",
        }),
      ),
    },
    0,
  );
  const result = await saveEditDraft({
    id: ID,
    fileName: "a.pdf",
    fileBytes: new Uint8Array([1, 2, 3]),
    session,
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

beforeEach(async () => {
  window.localStorage.clear();
  __resetEditPdfFeatureFlagsCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  await clearAllEditDrafts();
  vi.mocked(clearAllEditDrafts).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("Ajustes — interruptores del editor de PDF", () => {
  const copy = es.settings.editPdfFeatures;

  it("aparecen con titulo, explicacion, etiqueta y pista", () => {
    renderSettings();
    expect(screen.getByText(es.settings.editPdfFeaturesTitle)).toBeTruthy();
    expect(screen.getByText(es.settings.editPdfFeaturesBody)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: copy.editExistingText.label })).toBeTruthy();
    expect(screen.getByText(copy.editExistingText.hint)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: copy.stripOriginalText.label })).toBeTruthy();
  });

  it("editExistingText esta ACTIVO por defecto, se apaga y se PERSISTE", async () => {
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.editExistingText.label }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(JSON.parse(window.localStorage.getItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY)!)).toMatchObject({
      editExistingText: false,
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("un valor guardado se respeta al volver a abrir Ajustes", () => {
    window.localStorage.setItem(
      EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ editExistingText: false }),
    );
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.editExistingText.label }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("stripOriginalText: DESACTIVADO, deshabilitado, con «proximamente» y el motivo; clic no hace nada", () => {
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.stripOriginalText.label }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(copy.stripOriginalText.label).toMatch(/pr[oó]ximamente/i);
    expect(copy.stripOriginalText.hint).toMatch(/puede seguir existiendo/);
    expect(copy.stripOriginalText.hint).toMatch(/Aplanar p[aá]gina/);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(window.localStorage.getItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY)).toBeNull();
  });

  it("stripOriginalText sigue desmarcado aunque el almacenamiento diga true", () => {
    window.localStorage.setItem(
      EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ stripOriginalText: true }),
    );
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.stripOriginalText.label }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("en ingles aparecen los textos en ingles", async () => {
    renderSettings();
    // El idioma vive en un store de modulo: se cambia con el selector y se restaura.
    fireEvent.click(screen.getByRole("tab", { name: es.common.english }));
    try {
      expect(
        await screen.findByRole("checkbox", { name: en.settings.editPdfFeatures.editExistingText.label }),
      ).toBeTruthy();
      expect(screen.getByText(en.settings.editPdfFeaturesTitle)).toBeTruthy();
      expect(en.settings.editPdfFeatures.stripOriginalText.label).toMatch(/coming soon/i);
    } finally {
      fireEvent.click(screen.getByRole("tab", { name: en.common.spanish }));
    }
  });

  it("los dos idiomas tienen etiqueta y pista para cada flag", () => {
    for (const dictionary of [es, en]) {
      for (const flag of ["editExistingText", "stripOriginalText"] as const) {
        const item = dictionary.settings.editPdfFeatures[flag];
        expect(item.label.length).toBeGreaterThan(5);
        expect(item.hint.length).toBeGreaterThan(30);
      }
    }
  });

  it("no rompe los interruptores de Firmar PDF (siguen todos presentes)", () => {
    renderSettings();
    for (const entry of Object.values(es.settings.signPdfFeatures)) {
      expect(screen.getByRole("checkbox", { name: entry.label })).toBeTruthy();
    }
  });
});

describe("Ajustes — «Borrar datos locales» vacia los borradores del editor", () => {
  const clearButton = () => screen.getByRole("button", { name: es.settings.clearData });

  it("borra el borrador del editor y confirma", async () => {
    await seedDraft();
    expect(await listEditDrafts()).toHaveLength(1);
    renderSettings();
    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
    expect(await listEditDrafts()).toHaveLength(0);
    expect(vi.mocked(clearAllEditDrafts)).toHaveBeenCalledTimes(1);
  });

  it("si NO se pudo vaciar, lo dice (role=status) y no afirma «borrados»; reintentar funciona", async () => {
    await seedDraft();
    vi.mocked(clearAllEditDrafts).mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    renderSettings();
    fireEvent.click(clearButton());
    const message = await screen.findByText(SIGN_STRINGS.es.vaultClearFailed(["editDrafts"]));
    expect(message.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByText(es.settings.cleared)).toBeNull();
    expect(await listEditDrafts()).toHaveLength(1);

    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
    expect(await listEditDrafts()).toHaveLength(0);
  });

  it("fallan los borradores de firmar y los del editor: se nombran los dos", () => {
    const text = SIGN_STRINGS.es.vaultClearFailed(["drafts", "editDrafts"]);
    expect(text).toMatch(/borradores/);
    expect(text).toMatch(/borradores del editor/);
    expect(SIGN_STRINGS.en.vaultClearFailed(["editDrafts"])).toMatch(/editor drafts/);
  });

  it("sin IndexedDB no hay nada que borrar: se confirma el borrado", async () => {
    vi.stubGlobal("indexedDB", undefined);
    renderSettings();
    fireEvent.click(clearButton());
    expect(await screen.findByText(es.settings.cleared)).toBeTruthy();
  });
});

describe("Privacidad — el borrador del editor se declara", () => {
  it("Ajustes y la politica (es y en) dicen que el borrador guarda el documento y las ediciones en el dispositivo", () => {
    expect(es.settings.dataBody).toMatch(/editor de PDF/);
    expect(es.settings.dataBody).toMatch(/documento completo y tus ediciones/);
    expect(en.settings.dataBody).toMatch(/PDF editor/);
    expect(en.settings.dataBody).toMatch(/whole document and your edits/);

    for (const language of ["es", "en"] as const) {
      const all = PRIVACY[language].sections.flatMap((section) => section.body).join("\n");
      expect(all).toMatch(language === "es" ? /editor de PDF/ : /PDF editor/);
      expect(all).toMatch(language === "es" ? /el PDF completo, las ediciones/ : /the full PDF, the edits/);
      expect(all).toMatch(language === "es" ? /IndexedDB/ : /IndexedDB/);
    }
  });

  it("la frase de «borrar todo» incluye los borradores del editor", () => {
    expect(PRIVACY.es.sections.flatMap((s) => s.body).join("\n")).toMatch(
      /borradores de «Firmar PDF» y del editor de PDF/,
    );
    expect(PRIVACY.en.sections.flatMap((s) => s.body).join("\n")).toMatch(
      /Sign PDF\\" and PDF editor values and drafts|"Sign PDF" and PDF editor values and drafts/,
    );
  });
});
