import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "@/components/views/SettingsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import {
  SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";

/**
 * F0-U0.5: en Ajustes, «Registro de firmas (página final)» y «Incluir registro .json aparte» nacen apagados, con textos
 * ES/EN que dicen que no es una firma certificada, y lo que la persona active se respeta tras recargar.
 */

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

const toggleFor = (label: string) => screen.getByRole("checkbox", { name: label }) as HTMLInputElement;

beforeEach(() => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
});

describe("Ajustes — registro de firmas", () => {
  it("el nuevo interruptor existe en la lista y justo despues del registro de firmas", () => {
    const flags = [...SIGN_PDF_FEATURE_FLAGS];
    expect(flags).toContain("signingRecordFile");
    expect(flags.indexOf("signingRecordFile")).toBe(flags.indexOf("completionCertificate") + 1);
  });

  it("ES: la pagina final se llama «Registro de firmas», no «Certificado», y aclara que no es una firma certificada", () => {
    const copy = es.settings.signPdfFeatures.completionCertificate;
    expect(copy.label).toContain("Registro de firmas");
    expect(`${copy.label} ${copy.hint}`).not.toMatch(/certificado de finalizaci/i);
    expect(copy.hint).toContain("No es una firma certificada: solo registra quién firmó y cuándo");
    expect(es.settings.signPdfFeatures.signingRecordFile.label).toBe("Incluir registro .json aparte");
  });

  it("EN: «Signature record», no «Completion certificate», con la aclaracion de que no es una firma certificada", () => {
    const copy = en.settings.signPdfFeatures.completionCertificate;
    expect(copy.label).toContain("Signature record");
    expect(`${copy.label} ${copy.hint}`).not.toMatch(/completion certificate/i);
    expect(copy.hint).toContain("not a certified signature");
    expect(en.settings.signPdfFeatures.signingRecordFile.label).toBe("Include a separate .json record");
  });

  it("ambos interruptores aparecen DESMARCADOS por defecto", () => {
    renderSettings();
    expect(toggleFor(es.settings.signPdfFeatures.completionCertificate.label).checked).toBe(false);
    expect(toggleFor(es.settings.signPdfFeatures.signingRecordFile.label).checked).toBe(false);
  });

  it("en ingles tambien aparecen desmarcados y con su texto, sin claves crudas", async () => {
    // El idioma vive en un almacen de modulo: se cambia con el control real de Ajustes y se devuelve a espanol al terminar.
    renderSettings();
    fireEvent.click(screen.getByRole("tab", { name: es.common.english }));
    try {
      const record = (await screen.findByRole("checkbox", {
        name: en.settings.signPdfFeatures.completionCertificate.label,
      })) as HTMLInputElement;
      expect(record.checked).toBe(false);
      expect(toggleFor(en.settings.signPdfFeatures.signingRecordFile.label).checked).toBe(false);
      expect(document.body.textContent).not.toMatch(/signPdfFeatures|signingRecordFile|completionCertificate/);
    } finally {
      fireEvent.click(screen.getByRole("tab", { name: en.common.spanish }));
    }
  });

  it("al activar «Incluir registro .json aparte» queda guardado y se respeta tras recargar", async () => {
    const first = renderSettings();
    fireEvent.click(toggleFor(es.settings.signPdfFeatures.signingRecordFile.label));
    await waitFor(() => expect(toggleFor(es.settings.signPdfFeatures.signingRecordFile.label).checked).toBe(true));
    first.unmount();

    __resetSignPdfFeatureFlagsCacheForTests(); // «recargar»
    renderSettings();
    expect(toggleFor(es.settings.signPdfFeatures.signingRecordFile.label).checked).toBe(true);
    expect(toggleFor(es.settings.signPdfFeatures.completionCertificate.label).checked).toBe(false);
  });

  it("usuario con ajustes ANTIGUOS (certificado a true): Ajustes lo muestra apagado; si lo activa, se respeta tras recargar", async () => {
    const all: Record<string, boolean> = {};
    for (const flag of SIGN_PDF_FEATURE_FLAGS) all[flag] = true;
    window.localStorage.setItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(all));
    expect(window.localStorage.getItem(SIGN_PDF_FEATURE_FLAGS_VERSION_KEY)).toBeNull();

    const first = renderSettings();
    const label = es.settings.signPdfFeatures.completionCertificate.label;
    expect(toggleFor(label).checked).toBe(false);
    fireEvent.click(toggleFor(label));
    await waitFor(() => expect(toggleFor(label).checked).toBe(true));
    first.unmount();

    __resetSignPdfFeatureFlagsCacheForTests();
    renderSettings();
    expect(toggleFor(label).checked).toBe(true);
  });
});
