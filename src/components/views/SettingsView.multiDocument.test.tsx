import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "@/components/views/SettingsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import {
  DEFAULT_SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";

/** Interruptor «Varios documentos a la vez» (Wave 4): activo por defecto y apagable desde Ajustes. */

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
});

function renderSettings() {
  return render(
    <LanguageProvider>
      <ThemeProvider>
        <SettingsView />
      </ThemeProvider>
    </LanguageProvider>,
  );
}

describe("Ajustes — interruptor «Varios documentos a la vez»", () => {
  it("existe en la lista de interruptores y esta activo por defecto", () => {
    expect(SIGN_PDF_FEATURE_FLAGS).toContain("multiDocument");
    expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS.multiDocument).toBe(true);
  });

  it("cada interruptor de la lista tiene su propio texto en espanol e ingles", () => {
    for (const flag of SIGN_PDF_FEATURE_FLAGS) {
      for (const dictionary of [es, en]) {
        const copy = dictionary.settings.signPdfFeatures[flag];
        expect(copy.label.length).toBeGreaterThan(3);
        expect(copy.hint.length).toBeGreaterThan(20);
      }
    }
  });

  it("aparece en Ajustes marcado y se puede apagar; la preferencia queda guardada", async () => {
    renderSettings();
    const toggle = screen.getByRole("checkbox", {
      name: es.settings.signPdfFeatures.multiDocument.label,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    const stored = JSON.parse(
      window.localStorage.getItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY) ?? "{}",
    ) as Record<string, boolean>;
    expect(stored.multiDocument).toBe(false);
  });

  it("un valor guardado antes de existir el interruptor no lo apaga: queda activo", () => {
    window.localStorage.setItem(
      SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ keyboardNav: false }),
    );
    __resetSignPdfFeatureFlagsCacheForTests();
    renderSettings();
    const toggle = screen.getByRole("checkbox", {
      name: es.settings.signPdfFeatures.multiDocument.label,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });
});
