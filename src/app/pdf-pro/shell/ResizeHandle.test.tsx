import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle, type ResizeHandleProps } from "@/app/pdf-pro/shell/ResizeHandle";

afterEach(cleanup);

function setup(props: Partial<ResizeHandleProps> = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const onReset = vi.fn();
  render(
    <ResizeHandle
      label="Cambiar el ancho"
      value={200}
      min={100}
      max={300}
      direction={1}
      onChange={onChange}
      onCommit={onCommit}
      onReset={onReset}
      {...props}
    />,
  );
  return { onChange, onCommit, onReset, handle: screen.getByRole("separator", { name: "Cambiar el ancho" }) };
}

describe("ResizeHandle (separador vertical WAI-ARIA)", () => {
  it("expone sus limites y su valor", () => {
    const { handle } = setup({ controls: "panel" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe("100");
    expect(handle.getAttribute("aria-valuemax")).toBe("300");
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
    expect(handle.getAttribute("aria-controls")).toBe("panel");
    expect(handle.tabIndex).toBe(0);
  });

  it("las flechas cambian 16 px y Mayus 64 px, y guardan en cada pulsacion", () => {
    const { handle, onChange, onCommit } = setup();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(216);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(184);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(264);
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it("en un panel de la derecha (direction -1) la flecha izquierda lo agranda", () => {
    const { handle, onChange } = setup({ direction: -1 });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(216);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(184);
  });

  it("nunca pasa de los limites", () => {
    const { handle, onChange } = setup({ value: 296 });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(300);
  });

  it("Inicio y Fin van al minimo y al maximo", () => {
    const { handle, onChange } = setup();
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(300);
  });

  it("Intro restablece el ancho por defecto", () => {
    const { handle, onReset } = setup();
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("un doble clic tambien restablece", () => {
    const { handle, onReset } = setup();
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("otras teclas no se interceptan", () => {
    const { handle, onChange } = setup();
    expect(fireEvent.keyDown(handle, { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(handle, { key: "ArrowUp" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("arrastrar con el puntero cambia el ancho en proporcion y guarda al soltar", () => {
    const { handle, onChange, onCommit } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 540 });
    expect(onChange).toHaveBeenLastCalledWith(240);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450 });
    expect(onChange).toHaveBeenLastCalledWith(150);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("al arrastrar un panel de la derecha, moverse a la izquierda lo agranda", () => {
    const { handle, onChange } = setup({ direction: -1 });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 460 });
    expect(onChange).toHaveBeenLastCalledWith(240);
  });

  it("el arrastre se acota a los limites", () => {
    const { handle, onChange } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 5000 });
    expect(onChange).toHaveBeenLastCalledWith(300);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -5000 });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("sin pulsar no hay arrastre, y otro puntero no lo mueve", () => {
    const { handle, onChange } = setup();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 100 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("solo arrastra con el boton principal", () => {
    const { handle, onChange } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancelar el gesto tambien guarda y termina el arrastre", () => {
    const { handle, onChange, onCommit } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 50 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("no se pinta en movil (clase hidden y md:block)", () => {
    const { handle } = setup();
    expect(handle.className).toContain("hidden");
    expect(handle.className).toContain("md:block");
  });
});

describe("ResizeHandle · area de agarre (M5 · VI-05)", () => {
  it("mide 24 px con raton y 44 px con el dedo, sin ocupar ancho en el reparto (margen negativo igual a la mitad)", () => {
    const { handle } = setup();
    // Antes `w-3` (12 px): por debajo de los 24 px de WCAG 2.5.8 y de los 44 px de un dedo.
    expect(handle.className).toContain("w-6");
    expect(handle.className).toContain("-mx-3");
    expect(handle.className).toContain("pointer-coarse:w-11");
    expect(handle.className).toContain("pointer-coarse:-mx-[22px]");
    expect(handle.className).not.toMatch(/(^|\s)w-3(\s|$)/);
    // Lo que se ve sigue siendo una linea de 1 px: solo crece lo que se puede tocar.
    expect(handle.querySelector("span")!.className).toContain("w-px");
  });
});
