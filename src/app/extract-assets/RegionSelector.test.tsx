import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { es } from "@/lib/locales/es";
import { RegionSelector, regionPercent } from "@/app/extract-assets/RegionSelector";
import type { CropFraction } from "@/app/sign-pdf/inkImportModel";
import { useState } from "react";

/** Rectangulo de recorte: teclado (flechas mueven, Mayus + flechas redimensionan), asas de 44 px y puntero. */

const START: CropFraction = { x: 0.2, y: 0.4, width: 0.3, height: 0.1 };

function Harness({ onChange, onAnnounce }: { onChange?: (rect: CropFraction) => void; onAnnounce?: (text: string) => void }) {
  const [rect, setRect] = useState(START);
  return (
    <div data-testid="page" style={{ position: "relative", width: 1000, height: 500 }}>
      <RegionSelector
        rect={rect}
        onChange={(next) => {
          setRect(next);
          onChange?.(next);
        }}
        strings={es.extract}
        onAnnounce={onAnnounce ?? (() => {})}
      />
    </div>
  );
}

beforeEach(() => {
  // jsdom no calcula cajas: el marco mide 1000 x 500 en (0, 0).
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) } as DOMRect;
  };
});

const rectEl = () => screen.getByRole("group");
const label = () => rectEl().getAttribute("aria-label") ?? "";

describe("RegionSelector · teclado", () => {
  it("el rectangulo es enfocable y su nombre dice la posicion y como manejarlo", () => {
    render(<Harness />);
    expect(rectEl().tabIndex).toBe(0);
    expect(label()).toBe("Región a recortar: izquierda 20 %, arriba 40 %, ancho 30 %, alto 10 %. Flechas para mover, Mayús + flechas para cambiar el tamaño.");
  });

  it("las flechas MUEVEN 1 % y anuncian el valor", () => {
    const onAnnounce = vi.fn();
    render(<Harness onAnnounce={onAnnounce} />);
    fireEvent.keyDown(rectEl(), { key: "ArrowRight" });
    expect(label()).toContain("izquierda 21 %, arriba 40 %, ancho 30 %");
    fireEvent.keyDown(rectEl(), { key: "ArrowDown" });
    fireEvent.keyDown(rectEl(), { key: "ArrowDown" });
    fireEvent.keyDown(rectEl(), { key: "ArrowLeft" });
    fireEvent.keyDown(rectEl(), { key: "ArrowUp" });
    expect(label()).toContain("izquierda 20 %, arriba 41 %, ancho 30 %, alto 10 %");
    expect(onAnnounce).toHaveBeenLastCalledWith("Región: izquierda 20 %, arriba 41 %, ancho 30 %, alto 10 %");
    expect(onAnnounce).toHaveBeenCalledTimes(5);
  });

  it("Mayus + flechas cambian el TAMANO (derecha/abajo agrandan, izquierda/arriba reducen) sin mover la esquina", () => {
    render(<Harness />);
    fireEvent.keyDown(rectEl(), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(rectEl(), { key: "ArrowDown", shiftKey: true });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 31 %, alto 11 %");
    fireEvent.keyDown(rectEl(), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(rectEl(), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(rectEl(), { key: "ArrowUp", shiftKey: true });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 29 %, alto 10 %");
  });

  it("no sale de la pagina ni baja del lado minimo", () => {
    render(<Harness />);
    for (let i = 0; i < 100; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowLeft" });
    for (let i = 0; i < 100; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowUp" });
    expect(label()).toContain("izquierda 0 %, arriba 0 %");
    for (let i = 0; i < 200; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowLeft", shiftKey: true });
    expect(label()).toContain("ancho 5 %");
    for (let i = 0; i < 200; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowDown", shiftKey: true });
    expect(Number(/alto (\d+) %/.exec(label())![1])).toBeLessThanOrEqual(100);
  });

  it("otras teclas no hacen nada (y no se las traga: Tab sigue su camino)", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const prevented = !fireEvent.keyDown(rectEl(), { key: "Tab" });
    fireEvent.keyDown(rectEl(), { key: "a" });
    expect(prevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("las flechas no desplazan la pagina (preventDefault)", () => {
    render(<Harness />);
    expect(fireEvent.keyDown(rectEl(), { key: "ArrowDown" })).toBe(false);
  });
});

describe("RegionSelector · puntero", () => {
  it("cuatro asas de 44 px (clases del objetivo tactil) y ocultas para los lectores", () => {
    render(<Harness />);
    const handles = document.querySelectorAll("[data-region-handle]");
    expect(handles).toHaveLength(4);
    for (const handle of handles) {
      expect(handle.getAttribute("aria-hidden")).toBe("true");
      expect(handle.className).toContain("size-11");
      expect(handle.className).toContain("touch-none");
    }
  });

  it("arrastrar una asa mueve SOLO esa esquina (la opuesta no se mueve)", () => {
    render(<Harness />);
    const se = document.querySelector('[data-region-handle="se"]')!;
    fireEvent.pointerDown(se, { pointerId: 1, clientX: 500, clientY: 250 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 700, clientY: 300 });
    fireEvent.pointerUp(se, { pointerId: 1 });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 50 %, alto 20 %");
    const nw = document.querySelector('[data-region-handle="nw"]')!;
    fireEvent.pointerDown(nw, { pointerId: 2 });
    fireEvent.pointerMove(nw, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(nw, { pointerId: 2 });
    expect(label()).toContain("izquierda 10 %, arriba 20 %, ancho 60 %, alto 40 %");
  });

  it("arrastrar el cuerpo desplaza sin cambiar el tamano; otro puntero no interfiere", () => {
    render(<Harness />);
    fireEvent.pointerDown(rectEl(), { pointerId: 1, clientX: 350, clientY: 225 });
    fireEvent.pointerMove(rectEl(), { pointerId: 2, clientX: 900, clientY: 100 });
    expect(label()).toContain("izquierda 20 %, arriba 40 %");
    fireEvent.pointerMove(rectEl(), { pointerId: 1, clientX: 450, clientY: 275 });
    fireEvent.pointerUp(rectEl(), { pointerId: 1 });
    expect(label()).toContain("izquierda 30 %, arriba 50 %, ancho 30 %, alto 10 %");
    // Soltado: mas movimiento no cambia nada.
    fireEvent.pointerMove(rectEl(), { pointerId: 1, clientX: 800, clientY: 400 });
    expect(label()).toContain("izquierda 30 %, arriba 50 %");
  });

  it("un toque en la pagina (fuera del rectangulo) coloca su centro ahi; sobre el rectangulo no", () => {
    render(<Harness />);
    const frame = document.querySelector("[data-region-frame]")!;
    fireEvent.click(frame, { clientX: 500, clientY: 150 });
    expect(label()).toContain("izquierda 35 %, arriba 25 %");
    fireEvent.click(rectEl(), { clientX: 10, clientY: 10 });
    expect(label()).toContain("izquierda 35 %, arriba 25 %");
    // Cerca del borde: se detiene dentro de la pagina.
    fireEvent.click(frame, { clientX: 1000, clientY: 500 });
    expect(label()).toContain("izquierda 70 %, arriba 90 %");
  });
});

describe("regionPercent", () => {
  it("redondea a enteros", () => {
    expect(regionPercent({ x: 0.1234, y: 0.5, width: 0.3351, height: 0.0049 })).toEqual({ left: 12, top: 50, width: 34, height: 0 });
  });
});
