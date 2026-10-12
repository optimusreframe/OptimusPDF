import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ShortcutsSheet } from "@/app/pdf-pro/shell/ShortcutsSheet";
import { SetLanguage } from "@/app/pdf-pro/viewer/viewerTestUtils";
import { SHORTCUT_LAYOUT } from "@/app/pdf-pro/viewer/viewerStrings";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(cleanup);

describe("hoja de atajos de teclado", () => {
  it("cerrada no se pinta", () => {
    render(
      <LanguageProvider>
        <ShortcutsSheet open={false} onClose={() => undefined} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("abierta lista cada atajo con su accion, en tres grupos", async () => {
    render(
      <LanguageProvider>
        <ShortcutsSheet open onClose={() => undefined} />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    const S = PRO_STRINGS.es.shell;
    for (const group of SHORTCUT_LAYOUT) {
      // Cada grupo es un `group` (no un `region` con nombre: «Documento» repetia el de la region del visor, `landmark-unique`).
      const region = within(dialog).getByRole("group", { name: S.shortcutGroups[group.id] });
      for (const item of group.items) expect(within(region).getByText(S.shortcutActions[item.id])).toBeTruthy();
    }
  });

  it("incluye el atajo de la paleta y el de cambio de zona", async () => {
    render(
      <LanguageProvider>
        <ShortcutsSheet open onClose={() => undefined} />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Ctrl/⌘ K")).toBeTruthy();
    expect(within(dialog).getByText("F6")).toBeTruthy();
  });

  it("las teclas que se llaman distinto salen en cada idioma", async () => {
    render(
      <LanguageProvider>
        <SetLanguage language="en" />
        <ShortcutsSheet open onClose={() => undefined} />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Page Down / Page Up")).toBeTruthy();
    expect(within(dialog).getByText("Shift F6")).toBeTruthy();
    expect(within(dialog).getByText(PRO_STRINGS.en.shell.shortcutActions.palette)).toBeTruthy();
  });

  it("todos los atajos tienen texto de accion en los dos idiomas", () => {
    for (const language of ["es", "en"] as const) {
      for (const group of SHORTCUT_LAYOUT) {
        for (const item of group.items) {
          expect(PRO_STRINGS[language].shell.shortcutActions[item.id].length).toBeGreaterThan(3);
          const keys = typeof item.keys === "string" ? item.keys : item.keys[language];
          expect(keys.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
