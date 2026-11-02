import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CropMarginFields } from "@/app/crop-pdf/CropMarginFields";
import { CROP_STRINGS } from "@/app/crop-pdf/strings";

/*
 * W-RESP-A: la seleccion de recorte se puede cambiar SIN arrastrar (WCAG 2.5.7): cuatro campos numericos (uno por lado) con el mismo efecto
 * que los tiradores, en ES y EN, con el teclado numerico en iOS y fuente de 16 px con el dedo.
 */
const RECT = { x: 0.06, y: 0.06, width: 0.88, height: 0.88 };

describe("CropMarginFields", () => {
  it("muestra los 4 margenes actuales con su etiqueta (ES)", () => {
    render(<CropMarginFields rect={RECT} onRectChange={() => {}} strings={CROP_STRINGS.es} />);
    expect(screen.getByRole("group", { name: "Márgenes a recortar (%)" })).toBeTruthy();
    for (const label of ["Arriba", "Abajo", "Izquierda", "Derecha"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.value).toBe("6");
      expect(input.getAttribute("inputmode")).toBe("numeric");
    }
  });

  it("escribir un margen devuelve la seleccion nueva (solo ese borde cambia)", () => {
    const onRectChange = vi.fn();
    render(<CropMarginFields rect={RECT} onRectChange={onRectChange} strings={CROP_STRINGS.en} />);
    fireEvent.change(screen.getByLabelText("Left"), { target: { value: "20" } });
    expect(onRectChange).toHaveBeenCalledTimes(1);
    const next = onRectChange.mock.calls[0][0] as typeof RECT;
    expect(next.x).toBeCloseTo(0.2, 10);
    expect(next.x + next.width).toBeCloseTo(0.94, 10);
    expect(next.y).toBe(RECT.y);
    expect(next.height).toBe(RECT.height);
  });
});
