import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NoticeFold } from "@/components/ui/NoticeFold";

/**
 * B1: varios avisos plegados en UNA linea resumen expandible. Contrato: el texto completo sigue en el documento
 * (para lectores de pantalla) aunque este plegado, el boton lleva `aria-expanded`/`aria-controls`, el foco no se
 * mueve al abrir ni al cerrar, Escape cierra y no sale de donde se esta, y NO es una region viva.
 */

afterEach(cleanup);

function renderFold(props: { onParentKeyDown?: () => void; defaultOpen?: boolean; dense?: boolean } = {}) {
  return render(
    <div onKeyDown={props.onParentKeyDown}>
      <NoticeFold summary="2 avisos" defaultOpen={props.defaultOpen} dense={props.dense} data-test-fold="">
        {(open) => (
          <ul aria-label="Avisos">
            <li data-open={String(open)}>Primer aviso completo</li>
            <li>Segundo aviso completo</li>
          </ul>
        )}
      </NoticeFold>
    </div>,
  );
}

const button = () => screen.getByRole("button", { name: /2 avisos/ });
const panel = () => document.querySelector<HTMLElement>("[data-notice-fold-panel]")!;

describe("NoticeFold", () => {
  it("plegado: una linea con el resumen; el texto completo sigue en el documento solo para lectores de pantalla", () => {
    renderFold();
    expect(button().textContent).toBe("2 avisos");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(panel().className).toContain("sr-only");
    // Sigue ahi, entero, para quien lee con lector de pantalla.
    expect(panel().textContent).toContain("Primer aviso completo");
    expect(panel().textContent).toContain("Segundo aviso completo");
    expect(screen.getAllByRole("listitem", { hidden: true })).toHaveLength(2);
    expect(document.querySelector('[data-open="false"]')).not.toBeNull();
  });

  it("el boton controla el panel por `aria-controls`", () => {
    renderFold();
    expect(button().getAttribute("aria-controls")).toBe(panel().id);
    expect(panel().id).not.toBe("");
  });

  it("al pulsar se expande: el panel se ve y recibe `open`; el foco se queda en el boton", () => {
    renderFold();
    button().focus();
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(panel().className).not.toContain("sr-only");
    expect(document.querySelector('[data-open="true"]')).not.toBeNull();
    expect(document.activeElement).toBe(button());
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(panel().className).toContain("sr-only");
    expect(document.activeElement).toBe(button());
  });

  it("expandido ocupa toda la fila (`basis-full`) y plegado no", () => {
    renderFold();
    const root = document.querySelector<HTMLElement>("[data-notice-fold]")!;
    expect(root.className).not.toContain("basis-full");
    fireEvent.click(button());
    expect(root.className).toContain("basis-full");
  });

  it("Escape con el desplegable abierto lo cierra, devuelve el foco al boton y NO sale hacia el contenedor", () => {
    const parent = vi.fn();
    renderFold({ onParentKeyDown: parent, defaultOpen: true });
    const second = screen.getByText("Segundo aviso completo");
    const event = fireEvent.keyDown(second, { key: "Escape" });
    expect(event).toBe(false); // preventDefault
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button());
    expect(parent).not.toHaveBeenCalled();
  });

  it("Escape con el desplegable cerrado no se toca: llega al contenedor (salir de la pantalla, etc.)", () => {
    const parent = vi.fn();
    renderFold({ onParentKeyDown: parent });
    fireEvent.keyDown(button(), { key: "Escape" });
    expect(parent).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("otras teclas con el desplegable abierto no lo cierran ni se detienen", () => {
    const parent = vi.fn();
    renderFold({ onParentKeyDown: parent, defaultOpen: true });
    fireEvent.keyDown(button(), { key: "ArrowDown" });
    expect(parent).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-expanded")).toBe("true");
  });

  it("no es una region viva: ni `role=status`/`alert` ni `aria-live`, ni plegado ni expandido", () => {
    renderFold();
    for (const open of [false, true]) {
      if (open) fireEvent.click(button());
      expect(document.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    }
  });

  it("el boton mide 44 px (o 24 en la variante densa, que con puntero grueso vuelve a 44)", () => {
    renderFold();
    expect(button().className).toContain("min-h-11");
    cleanup();
    renderFold({ dense: true });
    expect(button().className).toContain("min-h-6");
    expect(button().className).toContain("pointer-coarse:min-h-11");
    expect(button().className).not.toMatch(/(^|\s)min-h-11(\s|$)/);
  });

  it("los iconos son decorativos (aria-hidden) y el nombre accesible es solo el resumen", () => {
    renderFold();
    expect(button().querySelectorAll("svg[aria-hidden='true']").length).toBeGreaterThanOrEqual(2);
    expect(button().getAttribute("aria-label")).toBeNull();
  });
});
