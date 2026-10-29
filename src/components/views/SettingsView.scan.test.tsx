import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "@/components/views/SettingsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import * as sessionStore from "@/lib/scan/sessionStore";

/** Ajustes -> «Borrar datos locales» tambien vacia las sesiones del Escaner (otra base de IndexedDB). */

vi.mock("@/lib/scan/sessionStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scan/sessionStore")>();
  return { ...actual, clearScanSessions: vi.fn(actual.clearScanSessions) };
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(sessionStore.clearScanSessions).mockClear();
});

describe("Ajustes · Borrar datos locales y el Escaner", () => {
  it("vacia las sesiones del escaner y confirma «Datos borrados»", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
    render(
      <LanguageProvider>
        <ThemeProvider>
          <SettingsView />
        </ThemeProvider>
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: es.settings.clearData }));
    await waitFor(() => expect(screen.getByText(es.settings.cleared)).toBeTruthy());
    expect(sessionStore.clearScanSessions).toHaveBeenCalledTimes(1);
  });
});
