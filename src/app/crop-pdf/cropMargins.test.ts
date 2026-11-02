import { describe, expect, it } from "vitest";
import { CROP_MIN_SIDE, marginsOf, withMargin } from "@/app/crop-pdf/cropMargins";

/* W-RESP-A: alternativa sin arrastrar al rectangulo de recorte (WCAG 2.5.7). */
const FULL = { x: 0, y: 0, width: 1, height: 1 };

describe("cropMargins", () => {
  it("lee los margenes en % enteros", () => {
    expect(marginsOf({ x: 0.06, y: 0.06, width: 0.88, height: 0.88 })).toEqual({ top: 6, left: 6, right: 6, bottom: 6 });
    expect(marginsOf(FULL)).toEqual({ top: 0, left: 0, right: 0, bottom: 0 });
  });

  it("cada lado mueve solo su borde y deja el contrario donde estaba", () => {
    expect(withMargin(FULL, "left", 10)).toEqual({ x: 0.1, y: 0, width: 0.9, height: 1 });
    const right = withMargin(FULL, "right", 20);
    expect(right.x).toBe(0);
    expect(right.width).toBeCloseTo(0.8, 10);
    expect(withMargin(FULL, "top", 25)).toEqual({ x: 0, y: 0.25, width: 1, height: 0.75 });
    const bottom = withMargin(FULL, "bottom", 30);
    expect(bottom.y).toBe(0);
    expect(bottom.height).toBeCloseTo(0.7, 10);
  });

  it("la seleccion nunca baja de CROP_MIN_SIDE aunque se pida un margen enorme", () => {
    const left = withMargin({ x: 0, y: 0, width: 0.5, height: 1 }, "left", 95);
    expect(left.width).toBeCloseTo(CROP_MIN_SIDE, 10);
    expect(left.x + left.width).toBeCloseTo(0.5, 10);
    const bottom = withMargin({ x: 0, y: 0.5, width: 1, height: 0.5 }, "bottom", 95);
    expect(bottom.height).toBeCloseTo(CROP_MIN_SIDE, 10);
    expect(bottom.y).toBe(0.5);
  });

  it("valores fuera de rango (negativos o > 100) se acotan", () => {
    expect(withMargin(FULL, "left", -5)).toEqual(FULL);
    const huge = withMargin(FULL, "top", 500);
    expect(huge.height).toBeGreaterThanOrEqual(CROP_MIN_SIDE - 1e-9);
    expect(huge.y + huge.height).toBeCloseTo(1, 10);
  });

  it("escribir los margenes que se leen no cambia la seleccion (idempotente en enteros)", () => {
    const rect = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };
    const m = marginsOf(rect);
    const again = withMargin(withMargin(rect, "left", m.left), "bottom", m.bottom);
    expect(marginsOf(again)).toEqual(m);
  });
});
