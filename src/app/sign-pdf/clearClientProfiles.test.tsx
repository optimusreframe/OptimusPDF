import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrivacyNotice } from "@/app/sign-pdf/PrivacyNotice";
import { clearLocalSignData } from "@/app/sign-pdf/clearLocalSignData";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SettingsView } from "@/components/views/SettingsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import { CLIENT_PROFILES_STORAGE_KEY, __resetClientProfilesCacheForTests, listClientProfiles, saveClientProfile } from "@/lib/clientProfile/store";

/**
 * «Borrar datos» borra tambien los PERFILES DE CLIENTE (PII del autorrelleno): el boton de Firmar PDF (`PrivacyNotice`), el de
 * Ajustes («Borrar datos locales») y `clearLocalSignData`. Solo se dice «borrado» si de verdad no queda ninguno.
 */

const strings = SIGN_STRINGS.es;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetClientProfilesCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const seed = () => saveClientProfile({ name: "Pérez, Ana", values: { insuredName1: "Ana Pérez", phone: "555-0100" } });

describe("clearLocalSignData", () => {
  it("vacia los perfiles y no cuenta como fallo", async () => {
    seed();
    expect(listClientProfiles()).toHaveLength(1);
    expect(await clearLocalSignData()).toEqual([]);
    expect(listClientProfiles()).toEqual([]);
    expect(window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBeNull();
  });

  it("con el almacenamiento bloqueado lo dice (nunca afirma un borrado que no ocurrio)", async () => {
    seed();
    vi.stubGlobal("localStorage", new Proxy({}, { get: () => () => { throw new Error("bloqueado"); } }));
    expect(await clearLocalSignData()).toContain("clientProfiles");
  });
});

describe("PrivacyNotice (Firmar PDF)", () => {
  async function confirmClear() {
    fireEvent.click(screen.getByRole("button", { name: strings.privacyClearData }));
    const dialog = await screen.findByRole("dialog", { name: strings.privacyClearDataTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.privacyClearData }));
  }

  it("«Borrar datos» elimina los perfiles y despues dice «Datos borrados»", async () => {
    seed();
    render(<PrivacyNotice strings={strings} />);
    await confirmClear();
    expect(await screen.findByText(strings.privacyDataCleared)).toBeTruthy();
    expect(listClientProfiles()).toEqual([]);
  });

  it("si los perfiles no se pueden borrar, NO dice «Datos borrados» y nombra lo que fallo", async () => {
    seed();
    const real = window.localStorage;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => real.setItem(key, value),
      removeItem: (key: string) => {
        if (key === CLIENT_PROFILES_STORAGE_KEY) throw new Error("bloqueado");
        real.removeItem(key);
      },
    });
    render(<PrivacyNotice strings={strings} />);
    await confirmClear();
    expect(await screen.findByText(strings.vaultClearFailed(["clientProfiles"]))).toBeTruthy();
    expect(screen.queryByText(strings.privacyDataCleared)).toBeNull();
  });

  it("el aviso de privacidad y la confirmacion de borrado hablan de los perfiles de cliente (ES y EN)", () => {
    for (const language of ["es", "en"] as const) {
      const copy = SIGN_STRINGS[language];
      expect(copy.privacyNoticeBody).toMatch(language === "es" ? /Rellenar con datos del cliente[\s\S]*Guardar como perfil[\s\S]*hasta 20 perfiles/ : /Fill with client data[\s\S]*Save as profile[\s\S]*up to 20 profiles/);
      expect(copy.privacyClearDataBody).toMatch(language === "es" ? /perfiles de cliente/ : /client profiles/);
      expect(copy.vaultClearFailed(["clientProfiles"])).toMatch(language === "es" ? /perfiles de cliente/ : /client profiles/);
    }
  });
});

describe("Ajustes · Borrar datos locales", () => {
  it("elimina los perfiles y confirma «Datos locales borrados»", async () => {
    seed();
    render(
      <LanguageProvider>
        <ThemeProvider>
          <SettingsView />
        </ThemeProvider>
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: es.settings.clearData }));
    await waitFor(() => expect(screen.getByText(es.settings.cleared)).toBeTruthy());
    expect(listClientProfiles()).toEqual([]);
    expect(window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBeNull();
  });

  it("el texto de «Datos locales» dice que los perfiles se guardan aqui y que el boton los elimina", () => {
    expect(es.settings.dataBody).toMatch(/Rellenar con datos del cliente[\s\S]*perfil[\s\S]*Borrar datos locales/);
  });
});
