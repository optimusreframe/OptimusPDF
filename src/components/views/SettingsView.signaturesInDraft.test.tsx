import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "@/components/views/SettingsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
  readSignaturesInDraft,
} from "@/app/sign-pdf/signFeatureFlags";

/** Ajustes — «Guardar las firmas recogidas en el borrador» (F0 · U0.4): encendido por defecto, persistente y con el plazo dicho. */

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
});

/** Fija el idioma activo (el estado de i18n vive en el modulo, no en el arbol). */
function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
  }, [language, setLanguage]);
  return null;
}

function renderSettings(language: Language = "es") {
  return render(
    <LanguageProvider>
      <UseLanguage language={language} />
      <ThemeProvider>
        <SettingsView />
      </ThemeProvider>
    </LanguageProvider>,
  );
}

afterEach(() => cleanup());

const copy = es.settings.signPdfFeatures.signaturesInDraft;

describe("Ajustes — «Guardar las firmas recogidas en el borrador»", () => {
  it("aparece MARCADO por defecto, con su explicacion (7 dias, solo en este dispositivo)", () => {
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.label }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(copy.hint).toContain("7 días");
    expect(copy.hint).toContain("solo en este dispositivo");
    // Lo que no hace: no toca los borradores ya guardados, y lo dice.
    expect(copy.hint).toMatch(/ya guardados conservan sus firmas/);
    expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("se puede apagar: la preferencia queda guardada y la lee quien escribe el borrador", async () => {
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.label }) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(JSON.parse(window.localStorage.getItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY) ?? "{}").signaturesInDraft).toBe(false);
    expect(readSignaturesInDraft()).toBe(false);
  });

  it("al volver a Ajustes (recarga) sigue apagado; y se puede volver a encender", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("checkbox", { name: copy.label }));
    cleanup();
    __resetSignPdfFeatureFlagsCacheForTests();
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: copy.label }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(readSignaturesInDraft()).toBe(true);
  });

  it("en ingles sale con su texto en ingles", () => {
    renderSettings("en");
    const english = en.settings.signPdfFeatures.signaturesInDraft;
    expect(screen.getByRole("checkbox", { name: english.label })).toBeTruthy();
    expect(english.hint).toContain("7 days");
    expect(document.body.textContent).not.toMatch(/signaturesInDraft/);
  });

  it("el texto del interruptor dice que lo ya guardado se queda hasta que caduque o se quite (F0-fix2, N2)", () => {
    expect(copy.hint).toContain("caduquen o las quites");
    expect(en.settings.signPdfFeatures.signaturesInDraft.hint).toContain("expire or you remove them");
  });

  it("trae, justo debajo del interruptor, el boton «Quitar ahora las firmas de los borradores guardados», que pide confirmacion", async () => {
    const { container } = renderSettings();
    const privacy = SIGN_STRINGS.es.draftPrivacy;
    const toggle = screen.getByRole("checkbox", { name: copy.label });
    const button = screen.getByRole("button", { name: privacy.clearStrokesButton });
    expect(button.className).toContain("min-h-11");
    // Junto al interruptor: comparten el mismo bloque, no estan en otra tarjeta.
    expect(toggle.closest("[class*='space-y-4'] > div")?.contains(button)).toBe(true);
    expect(container.querySelectorAll("[data-strip-signatures]")).toHaveLength(1);
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: privacy.clearStrokesTitle })).toBeTruthy();
  });

  it("en ingles el boton sale en ingles", () => {
    renderSettings("en");
    expect(screen.getByRole("button", { name: SIGN_STRINGS.en.draftPrivacy.clearStrokesButton })).toBeTruthy();
  });
});
