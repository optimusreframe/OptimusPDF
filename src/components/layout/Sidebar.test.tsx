import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

vi.mock("next/navigation", () => ({ usePathname: () => "/merge-pdf" }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

function renderSidebar() {
  render(
    <LanguageProvider>
      <Sidebar />
    </LanguageProvider>,
  );
  return screen.getByRole("searchbox", { name: "Buscar herramienta…" });
}

/*
 * W6-C · D10: axe `aria-valid-attr-value` (critico) fallaba en 30 de 31
 * herramientas porque el buscador del Sidebar apuntaba con `aria-controls` a
 * un id que NO existe mientras no se busca (la region de resultados solo se
 * monta con texto). Contrato: `aria-controls` solo cuando el controlado existe.
 */
describe("Sidebar — aria-controls del buscador", () => {
  it("sin texto no hay aria-controls (el elemento controlado no existe)", () => {
    const search = renderSidebar();
    expect(search.hasAttribute("aria-controls")).toBe(false);
  });

  it("con texto apunta a un id que EXISTE: la región de resultados", () => {
    const search = renderSidebar();
    fireEvent.change(search, { target: { value: "unir" } });
    const id = search.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    const target = document.getElementById(id!);
    expect(target).not.toBeNull();
    expect(target?.getAttribute("role")).toBe("region");
    expect(target?.textContent).toContain("Unir PDF");
  });

  it("al borrar el texto vuelve a quitarse (nunca queda un idref colgado)", () => {
    const search = renderSidebar();
    fireEvent.change(search, { target: { value: "unir" } });
    expect(search.hasAttribute("aria-controls")).toBe(true);
    fireEvent.change(search, { target: { value: "" } });
    expect(search.hasAttribute("aria-controls")).toBe(false);
  });

  it("con texto sin coincidencias también apunta a la región (muestra «Sin resultados»)", () => {
    const search = renderSidebar();
    fireEvent.change(search, { target: { value: "zzzzqq" } });
    const id = search.getAttribute("aria-controls")!;
    expect(document.getElementById(id)?.textContent).toContain("Sin resultados");
  });

  it("Escape limpia la búsqueda y retira aria-controls", () => {
    const search = renderSidebar();
    fireEvent.change(search, { target: { value: "unir" } });
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(search.hasAttribute("aria-controls")).toBe(false);
  });

  it("cada idref de aria-controls del Sidebar resuelve a un elemento en todo momento", () => {
    const search = renderSidebar();
    for (const value of ["", "u", "unir", "", "comp"]) {
      fireEvent.change(search, { target: { value } });
      for (const el of document.querySelectorAll("[aria-controls]")) {
        for (const id of (el.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean)) {
          expect(document.getElementById(id), `${value}: ${id}`).not.toBeNull();
        }
      }
    }
  });
});

/*
 * M5 · N10: con la barra plegada (72 px) el boton «Expandir barra lateral» media 39 px de ancho: su contenedor llevaba `px-4` y
 * `px-0` a la vez (gana el que la hoja de estilos escribe despues: `px-4`) y dejaba 40 px al boton de 44. Se elige UNA de las dos.
 */
describe("Sidebar — boton de plegar/expandir de 44 px (M5 · N10)", () => {
  it("expandida el contenedor lleva px-4 y plegada px-0, nunca las dos (el boton conserva sus 44 px)", () => {
    renderSidebar();
    const collapse = screen.getByRole("button", { name: "Colapsar barra lateral" });
    const header = collapse.parentElement!;
    expect(header.className).toContain("px-4");
    expect(header.className).not.toContain("px-0");
    fireEvent.click(collapse);
    const expand = screen.getByRole("button", { name: "Expandir barra lateral" });
    const folded = expand.parentElement!;
    expect(folded.className).toContain("px-0");
    expect(folded.className).not.toContain("px-4");
    expect(expand.className).toContain("size-11");
  });
});
