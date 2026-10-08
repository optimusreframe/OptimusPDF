import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Header } from "@/components/layout/Header";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

function renderHeader(extra?: ReactNode) {
  return render(
    <LanguageProvider>
      <Header />
      {extra}
    </LanguageProvider>,
  );
}

/** Deja pasar el setTimeout(0) con el que el menu decide donde queda el foco. */
const afterMouseDown = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Menu "Herramientas" (tablet): el foco nunca cae a <body> al cerrarlo. */
describe("Header — menu Herramientas", () => {
  it("Escape cierra el menu y devuelve el foco al disparador", () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "Herramientas" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const link = screen.getByRole("link", { name: "Unir PDF" });
    link.focus();
    expect(document.activeElement).toBe(link);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("clic fuera en una zona no enfocable (el foco cae a body) lo devuelve al disparador", async () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "Herramientas" });
    fireEvent.click(trigger);
    screen.getByRole("link", { name: "Unir PDF" }).focus();

    // `true` = nadie cancelo el mousedown (ver el test del buscador).
    expect(fireEvent.mouseDown(document.body)).toBe(true);
    // jsdom no ejecuta la accion por defecto del mousedown: en un navegador,
    // pulsar algo no enfocable desenfoca el elemento activo y deja el foco en body.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("clic en un campo de texto con el foco dentro del menu: no se cancela el mousedown y el campo conserva el foco", async () => {
    // Regresion: el mousedown llamaba a preventDefault y el navegador no
    // enfocaba el buscador de Home, asi que no se podia escribir.
    renderHeader(<input aria-label="Buscar herramienta" />);
    const trigger = screen.getByRole("button", { name: "Herramientas" });
    fireEvent.click(trigger);
    screen.getByRole("link", { name: "Unir PDF" }).focus();
    const search = screen.getByRole("textbox", { name: "Buscar herramienta" });

    // `true` = ningun manejador llamo a preventDefault: el navegador enfocara el campo.
    expect(fireEvent.mouseDown(search)).toBe(true);
    // Accion por defecto del navegador (jsdom no la ejecuta): enfocar lo pulsado.
    search.focus();
    expect(document.activeElement).toBe(search);

    // Pasado el mousedown el menu NO le roba el foco al campo.
    await afterMouseDown();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(search);
  });

  it("clic fuera con el foco en otro sitio no lo roba", async () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "Herramientas" });
    fireEvent.click(trigger);
    const other = screen.getByRole("link", { name: "Precios" });
    other.focus();
    fireEvent.mouseDown(other);
    await afterMouseDown();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(other);
  });
});
