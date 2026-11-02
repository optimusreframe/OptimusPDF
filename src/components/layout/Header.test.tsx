import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Header } from "@/components/layout/Header";
import { closeMobileMenu } from "@/components/layout/mobileMenu";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

afterEach(() => {
  act(() => closeMobileMenu());
  cleanup();
});

function renderHeader() {
  return render(
    <ThemeProvider>
      <LanguageProvider>
        <Header />
      </LanguageProvider>
    </ThemeProvider>,
  );
}

/**
 * Cabecera de tablet (768-1023 px): el boton «Menú» sustituye al antiguo popover «Herramientas» y abre la hoja del menu
 * (mismo contenido que la barra lateral; el detalle esta en `MobileMenuSheet.test.tsx`). Aqui: el disparador y que el foco
 * nunca cae a <body> al cerrar.
 */
describe("Header — boton Menú (tablet)", () => {
  it("lleva un solo boton de menu con icono y etiqueta, y ya no existe el popover «Herramientas»", () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: es.nav.menu });
    expect(trigger.textContent).toBe(es.nav.menu);
    expect(trigger.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Herramientas" })).toBeNull();
  });

  it("Escape cierra la hoja y devuelve el foco al boton", async () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: es.nav.menu });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("elegir un enlace cierra la hoja y el foco no queda en <body>", async () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: es.nav.menu });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("link", { name: es.nav.settings }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("los enlaces secundarios de la cabecera siguen ahi (Mis documentos, Precios, Proyecto)", () => {
    renderHeader();
    for (const [name, href] of [
      [es.nav.documents, "/documents"],
      [es.nav.pricing, "/pricing"],
      [es.nav.about, "/about"],
    ] as const) {
      expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
  });
});
