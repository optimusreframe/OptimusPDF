import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { SettingsView } from "@/components/views/SettingsView";
import {
  DEFAULT_SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
  SIGN_TEMPLATE_FLAGS,
  readSignaturesInDraft,
} from "@/app/sign-pdf/signFeatureFlags";

beforeEach(() => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
});
afterEach(() => cleanup());

function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
  }, [language, setLanguage]);
  return null;
}

function renderSettings(language: Language) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  return render(
    <LanguageProvider>
      <UseLanguage language={language} />
      <ThemeProvider>
        <SettingsView />
      </ThemeProvider>
    </LanguageProvider>,
  );
}

describe("Ajustes: plantillas de documento", () => {
  it("los dos interruptores están ACTIVADOS por defecto y son los únicos nuevos", () => {
    expect(SIGN_TEMPLATE_FLAGS).toEqual(["autoApplyTemplates", "autoDetectFields"]);
    expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS.autoApplyTemplates).toBe(true);
    expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS.autoDetectFields).toBe(true);
    renderSettings("es");
    expect((screen.getByRole("checkbox", { name: /Aplicar plantillas automáticamente/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Detectar campos automáticamente/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("apagarlos se guarda en este navegador y no toca el resto de ajustes", () => {
    renderSettings("es");
    fireEvent.click(screen.getByRole("checkbox", { name: /Aplicar plantillas automáticamente/ }));
    const stored = JSON.parse(window.localStorage.getItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY) ?? "{}");
    expect(stored.autoApplyTemplates).toBe(false);
    expect(stored.autoDetectFields).toBe(true);
    expect(stored.signaturesInDraft).toBe(true);
    expect(readSignaturesInDraft()).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Aplicar plantillas automáticamente/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("un ajuste guardado por una versión anterior (sin las claves nuevas) las deja activadas", () => {
    window.localStorage.setItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ keyboardNav: false }));
    renderSettings("es");
    expect((screen.getByRole("checkbox", { name: /Detectar campos automáticamente/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("en inglés", () => {
    renderSettings("en");
    expect(screen.getByRole("heading", { name: "Document templates" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Apply templates automatically/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Detect fields automatically/ })).toBeTruthy();
  });
});
