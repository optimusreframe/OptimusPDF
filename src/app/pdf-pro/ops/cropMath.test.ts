import { describe, expect, it } from "vitest";
import {
  hasAnyMargin,
  marginsToRect,
  mmToPoints,
  pointsToMm,
  rectToMargins,
  roundMm,
  sanitizeMargins,
  uniformMargins,
} from "@/app/pdf-pro/ops/cropMath";

const A4 = { width: 210, height: 297 };

describe("conversion mm ⇄ puntos", () => {
  it("25,4 mm son 72 puntos y viceversa", () => {
    expect(mmToPoints(25.4)).toBeCloseTo(72, 10);
    expect(pointsToMm(72)).toBeCloseTo(25.4, 10);
    expect(pointsToMm(mmToPoints(10))).toBeCloseTo(10, 10);
  });

  it("A4 en puntos (595,28 × 841,89) mide 210 × 297 mm", () => {
    expect(pointsToMm(595.2756)).toBeCloseTo(210, 2);
    expect(pointsToMm(841.8898)).toBeCloseTo(297, 2);
  });
});

describe("marginsToRect", () => {
  it("sin margenes conserva toda la pagina", () => {
    expect(marginsToRect(uniformMargins(0), A4)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("margenes iguales de 10 mm sobre A4", () => {
    const rect = marginsToRect(uniformMargins(10), A4);
    expect(rect.x).toBeCloseTo(10 / 210, 12);
    expect(rect.y).toBeCloseTo(10 / 297, 12);
    expect(rect.width).toBeCloseTo(1 - 20 / 210, 12);
    expect(rect.height).toBeCloseTo(1 - 20 / 297, 12);
  });

  it("cada lado actua sobre el suyo (origen arriba-izquierda)", () => {
    const rect = marginsToRect({ top: 21, right: 0, bottom: 0, left: 42 }, A4);
    expect(rect.x).toBeCloseTo(0.2, 12);
    expect(rect.width).toBeCloseTo(0.8, 12);
    expect(rect.y).toBeCloseTo(21 / 297, 12);
    expect(rect.height).toBeCloseTo(1 - 21 / 297, 12);
  });

  it("ignora margenes negativos, NaN e infinitos", () => {
    expect(marginsToRect({ top: -5, right: Number.NaN, bottom: Number.POSITIVE_INFINITY, left: 0 }, A4)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("puede dar ancho o alto <= 0 si los margenes se comen la pagina (quien llama lo comprueba)", () => {
    expect(marginsToRect(uniformMargins(120), A4).width).toBeLessThan(0);
  });

  it("una pagina de tamano 0 no divide por cero", () => {
    const rect = marginsToRect(uniformMargins(1), { width: 0, height: 0 });
    expect(Number.isFinite(rect.x) && Number.isFinite(rect.width)).toBe(true);
  });
});

describe("rectToMargins (inversa)", () => {
  it("ida y vuelta con margenes distintos", () => {
    const margins = { top: 12, right: 7.5, bottom: 30, left: 4 };
    const back = rectToMargins(marginsToRect(margins, A4), A4);
    expect(back.top).toBeCloseTo(12, 9);
    expect(back.right).toBeCloseTo(7.5, 9);
    expect(back.bottom).toBeCloseTo(30, 9);
    expect(back.left).toBeCloseTo(4, 9);
  });

  it("un rectangulo arrastrado en el visor se traduce a margenes", () => {
    const margins = rectToMargins({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, { width: 100, height: 200 });
    expect(margins.left).toBeCloseTo(10, 9);
    expect(margins.top).toBeCloseTo(40, 9);
    expect(margins.right).toBeCloseTo(40, 9);
    expect(margins.bottom).toBeCloseTo(60, 9);
  });
});

describe("utilidades", () => {
  it("roundMm redondea a una decima", () => {
    expect(roundMm(10.04)).toBe(10);
    expect(roundMm(10.06)).toBe(10.1);
    expect(roundMm(-0.04)).toBe(-0);
  });

  it("sanitizeMargins deja >= 0 y hasAnyMargin lo refleja", () => {
    expect(sanitizeMargins({ top: -1, right: 2, bottom: Number.NaN, left: 0 })).toEqual({ top: 0, right: 2, bottom: 0, left: 0 });
    expect(hasAnyMargin(uniformMargins(0))).toBe(false);
    expect(hasAnyMargin({ top: 0, right: 0, bottom: 0.1, left: 0 })).toBe(true);
    expect(hasAnyMargin({ top: -3, right: 0, bottom: 0, left: 0 })).toBe(false);
  });
});
