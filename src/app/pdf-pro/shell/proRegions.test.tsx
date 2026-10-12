import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRO_REGION_ORDER,
  availableRegions,
  focusRegion,
  nextRegion,
  regionOf,
  useRegionShortcuts,
} from "@/app/pdf-pro/shell/proRegions";

afterEach(cleanup);

function Shell({ hide = [] as string[], noThumbsEntry = false }: { hide?: string[]; noThumbsEntry?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useRegionShortcuts(ref);
  return (
    <div ref={ref}>
      <div data-pro-region="top">
        <h1 tabIndex={-1}>Documento</h1>
        <button type="button">Deshacer</button>
      </div>
      <div role="tablist" data-pro-region="tabs">
        <button role="tab" aria-selected="false" tabIndex={-1} type="button">
          Uno
        </button>
        <button role="tab" aria-selected="true" tabIndex={0} type="button">
          Dos
        </button>
      </div>
      {hide.includes("thumbs") ? null : (
        <aside data-pro-region="thumbs">
          {noThumbsEntry ? null : (
            <ul role="listbox">
              <li role="option" aria-selected="false" tabIndex={-1}>
                1
              </li>
              <li role="option" aria-selected="false" tabIndex={0}>
                2
              </li>
            </ul>
          )}
        </aside>
      )}
      <div data-pro-region="viewer">
        <article tabIndex={0} aria-label="Pagina 1" />
      </div>
      <div data-pro-region="context" hidden={hide.includes("context")}>
        <button type="button">Aplicar</button>
      </div>
    </div>
  );
}

describe("funciones puras", () => {
  it("el orden de recorrido es barra, pestañas, miniaturas, visor y panel", () => {
    expect(PRO_REGION_ORDER).toEqual(["top", "tabs", "thumbs", "viewer", "context"]);
  });

  it("nextRegion avanza y retrocede dando la vuelta", () => {
    const all = [...PRO_REGION_ORDER];
    expect(nextRegion("top", 1, all)).toBe("tabs");
    expect(nextRegion("context", 1, all)).toBe("top");
    expect(nextRegion("top", -1, all)).toBe("context");
    expect(nextRegion("viewer", -1, all)).toBe("thumbs");
  });

  it("sin region actual empieza por el principio (o por el final hacia atras)", () => {
    expect(nextRegion(null, 1, ["tabs", "viewer"])).toBe("tabs");
    expect(nextRegion(null, -1, ["tabs", "viewer"])).toBe("viewer");
  });

  it("una region que ya no esta disponible se trata como ninguna", () => {
    expect(nextRegion("thumbs", 1, ["top", "viewer"])).toBe("top");
  });

  it("sin regiones devuelve null", () => {
    expect(nextRegion("top", 1, [])).toBeNull();
  });
});

describe("DOM", () => {
  it("availableRegions omite las ocultas y las ausentes", () => {
    const { container } = render(<Shell hide={["thumbs", "context"]} />);
    expect(availableRegions(container)).toEqual(["top", "tabs", "viewer"]);
  });

  it("regionOf encuentra la region de un elemento", () => {
    render(<Shell />);
    expect(regionOf(screen.getByText("Aplicar"))).toBe("context");
    expect(regionOf(screen.getByRole("tab", { name: "Dos" }))).toBe("tabs");
    expect(regionOf(document.body)).toBeNull();
    expect(regionOf(null)).toBeNull();
  });

  it("focusRegion lleva el foco al control de entrada de cada region", () => {
    const { container } = render(<Shell />);
    focusRegion(container, "top");
    expect(document.activeElement?.tagName).toBe("H1");
    focusRegion(container, "tabs");
    expect(document.activeElement?.textContent).toBe("Dos");
    focusRegion(container, "thumbs");
    expect(document.activeElement?.textContent).toBe("2");
    focusRegion(container, "viewer");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pagina 1");
    focusRegion(container, "context");
  });

  it("si la region no tiene control de entrada, el foco va a la propia region", () => {
    const { container } = render(<Shell noThumbsEntry />);
    expect(focusRegion(container, "thumbs")).toBe(true);
    expect(document.activeElement?.tagName).toBe("ASIDE");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("una region oculta o inexistente no recibe el foco", () => {
    const { container } = render(<Shell hide={["context", "thumbs"]} />);
    expect(focusRegion(container, "context")).toBe(false);
    expect(focusRegion(container, "thumbs")).toBe(false);
  });

  it("F6 pasa a la region siguiente y Mayus+F6 a la anterior", () => {
    render(<Shell />);
    screen.getByText("Deshacer").focus();
    fireEvent.keyDown(window, { key: "F6" });
    expect(regionOf(document.activeElement)).toBe("tabs");
    fireEvent.keyDown(window, { key: "F6" });
    expect(regionOf(document.activeElement)).toBe("thumbs");
    fireEvent.keyDown(window, { key: "F6", shiftKey: true });
    expect(regionOf(document.activeElement)).toBe("tabs");
  });

  it("F6 da la vuelta al llegar al final", () => {
    render(<Shell />);
    screen.getByText("Aplicar").focus();
    fireEvent.keyDown(window, { key: "F6" });
    expect(regionOf(document.activeElement)).toBe("top");
    fireEvent.keyDown(window, { key: "F6", shiftKey: true });
    expect(regionOf(document.activeElement)).toBe("context");
  });

  it("F6 se salta las regiones plegadas", () => {
    render(<Shell hide={["thumbs"]} />);
    screen.getByRole("tab", { name: "Dos" }).focus();
    fireEvent.keyDown(window, { key: "F6" });
    expect(regionOf(document.activeElement)).toBe("viewer");
  });

  it("F6 con el foco fuera de la suite entra por la primera region", () => {
    render(
      <div>
        <button type="button">fuera</button>
        <Shell />
      </div>,
    );
    screen.getByText("fuera").focus();
    fireEvent.keyDown(window, { key: "F6" });
    expect(regionOf(document.activeElement)).toBe("top");
  });

  it("F6 cancela el evento del navegador, y otras teclas no", () => {
    render(<Shell />);
    expect(fireEvent.keyDown(window, { key: "F6" })).toBe(false);
    expect(fireEvent.keyDown(window, { key: "F5" })).toBe(true);
  });

  it("F6 con Ctrl, Alt o Meta no se intercepta", () => {
    render(<Shell />);
    expect(fireEvent.keyDown(window, { key: "F6", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "F6", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "F6", metaKey: true })).toBe(true);
  });

  it("al desmontar deja de escuchar F6", () => {
    const { unmount } = render(<Shell />);
    unmount();
    expect(fireEvent.keyDown(window, { key: "F6" })).toBe(true);
    act(() => undefined);
  });
});
