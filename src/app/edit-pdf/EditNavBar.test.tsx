import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditNavBar, ZOOM_STEPS } from "@/app/edit-pdf/EditNavBar";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

const strings = EDIT_STRINGS.es;
const s = strings.inline;

function mount(props: Partial<Parameters<typeof EditNavBar>[0]> = {}) {
  const handlers = { onZoomIn: vi.fn(), onZoomOut: vi.fn(), onGoTo: vi.fn(), onToggleStrip: vi.fn() };
  render(
    <EditNavBar
      zoom={1}
      pageIndex={2}
      pageCount={12}
      stripOpen={false}
      stripId="strip"
      strings={strings}
      s={s}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...props };
}

afterEach(cleanup);
const input = () => screen.getByRole("textbox", { name: s.goToPageLabel }) as HTMLInputElement;

describe("EditNavBar: paginador", () => {
  it("muestra la pagina actual en el campo y el total, y el texto completo para lectores de pantalla", () => {
    mount();
    expect(input().value).toBe("3");
    expect(screen.getByText("/ 12")).toBeTruthy();
    expect(screen.getByText("Página 3 de 12")).toBeTruthy();
  });

  it("escribir un numero y pulsar Intro va a esa pagina (0-based)", () => {
    const { onGoTo } = mount();
    fireEvent.change(input(), { target: { value: "9" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onGoTo).toHaveBeenCalledWith(8);
  });

  it("al salir del campo tambien confirma", () => {
    const { onGoTo } = mount();
    fireEvent.change(input(), { target: { value: "4" } });
    fireEvent.blur(input());
    expect(onGoTo).toHaveBeenCalledWith(3);
  });

  it("un numero fuera de rango se recorta al primero o al ultimo", () => {
    const { onGoTo } = mount();
    fireEvent.change(input(), { target: { value: "999" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onGoTo).toHaveBeenLastCalledWith(11);
    fireEvent.change(input(), { target: { value: "0" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onGoTo).toHaveBeenLastCalledWith(0);
  });

  it("solo admite digitos y Esc descarta lo escrito", () => {
    const { onGoTo } = mount();
    fireEvent.change(input(), { target: { value: "1a2b" } });
    expect(input().value).toBe("12");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().value).toBe("3");
    fireEvent.blur(input());
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it("un campo vacio al salir no va a ninguna parte", () => {
    const { onGoTo } = mount();
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.blur(input());
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it("anterior y siguiente van a la pagina contigua", () => {
    const { onGoTo } = mount();
    fireEvent.click(screen.getByRole("button", { name: strings.previousPage }));
    expect(onGoTo).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    expect(onGoTo).toHaveBeenLastCalledWith(3);
  });

  it("en los extremos usan aria-disabled (el foco no cae a <body>) y no hacen nada", () => {
    const { onGoTo } = mount({ pageIndex: 0 });
    const prev = screen.getByRole("button", { name: strings.previousPage });
    expect(prev.getAttribute("aria-disabled")).toBe("true");
    expect(prev.hasAttribute("disabled")).toBe(false);
    fireEvent.click(prev);
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it("anuncia sus atajos de teclado", () => {
    mount();
    expect(screen.getByRole("button", { name: strings.previousPage }).getAttribute("aria-keyshortcuts")).toBe("[");
    expect(screen.getByRole("button", { name: strings.nextPage }).getAttribute("aria-keyshortcuts")).toBe("]");
    expect(screen.getByRole("button", { name: s.zoomIn }).getAttribute("aria-keyshortcuts")).toBe("+");
  });
});

describe("EditNavBar: zoom y miniaturas", () => {
  it("muestra el porcentaje y los botones llaman a sus callbacks", () => {
    const { onZoomIn } = mount({ zoom: 1.5 });
    expect(screen.getByText("150 %")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.zoomIn }));
    expect(onZoomIn).toHaveBeenCalled();
  });

  it("alejar esta agotado al 100 % y acercar al maximo", () => {
    mount({ zoom: 1 });
    expect(screen.getByRole("button", { name: s.zoomOut }).getAttribute("aria-disabled")).toBe("true");
    cleanup();
    mount({ zoom: ZOOM_STEPS[ZOOM_STEPS.length - 1] });
    expect(screen.getByRole("button", { name: s.zoomIn }).getAttribute("aria-disabled")).toBe("true");
  });

  it("el interruptor de miniaturas es un disclosure (aria-expanded) con nombre constante", () => {
    const { onToggleStrip } = mount({ stripOpen: true });
    const toggle = screen.getByRole("button", { name: s.thumbsLabel });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("strip");
    expect(toggle.getAttribute("title")).toBe(s.thumbsHide);
    fireEvent.click(toggle);
    expect(onToggleStrip).toHaveBeenCalled();
  });

  it("con una sola pagina no hay interruptor de miniaturas", () => {
    mount({ pageCount: 1, pageIndex: 0 });
    expect(screen.queryByRole("button", { name: s.thumbsLabel })).toBeNull();
  });

  it("es la barra pegajosa que la barra flotante respeta", () => {
    mount();
    expect(document.querySelector("[data-canvas-sticky]")).not.toBeNull();
  });
});

describe("EditNavBar: aplanar pagina (W5-U5)", () => {
  it("sin la accion no hay boton de aplanar", () => {
    mount();
    expect(document.querySelector("[data-flatten-toggle]")).toBeNull();
  });

  it("el boton de escritorio lleva el nombre de la accion y la ejecuta; en movil se oculta (la accion va en su fila)", () => {
    const onClick = vi.fn();
    mount({ flatten: { label: "Aplanar página", active: false, onClick } });
    const button = screen.getByRole("button", { name: "Aplanar página" });
    expect(button.closest("span")!.className).toContain("max-md:hidden");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("data-flattened")).toBe(false);
  });

  it("aplanada: el boton ofrece quitar el aplanado y lo marca", () => {
    mount({ flatten: { label: "Quitar aplanado", active: true, onClick: vi.fn() } });
    const button = screen.getByRole("button", { name: "Quitar aplanado" });
    expect(button.hasAttribute("data-flattened")).toBe(true);
  });
});

describe("EditNavBar: objetivo tactil del campo de pagina (W5-U5)", () => {
  it("el campo «Ir a la pagina» mide al menos 44 x 44 con puntero grueso", () => {
    mount();
    expect(input().className).toContain("pointer-coarse:h-11");
    expect(input().className).toContain("pointer-coarse:min-w-11");
  });
});
