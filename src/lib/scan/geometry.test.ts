import { describe, expect, it } from "vitest";
import { maxCornerShift, orderCorners, polygonArea, quadArea, quadCentroid, quadIntersectionArea, quadIoU } from "@/lib/scan/geometry";
import type { QuadCorners } from "@/lib/scan/perspective";

const square = (x0: number, y0: number, x1: number, y1: number): QuadCorners => ({
  topLeft: { x: x0, y: y0 },
  topRight: { x: x1, y: y0 },
  bottomRight: { x: x1, y: y1 },
  bottomLeft: { x: x0, y: y1 },
});

describe("geometry — src/lib/scan/geometry.ts", () => {
  it("el area del cordon es positiva en cualquier sentido", () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }, { x: 0, y: 3 }])).toBe(6);
    expect(polygonArea([{ x: 0, y: 3 }, { x: 2, y: 3 }, { x: 2, y: 0 }, { x: 0, y: 0 }])).toBe(6);
  });

  it("IoU: identicos 1, disjuntos 0, solapamiento parcial el valor exacto", () => {
    expect(quadIoU(square(0, 0, 1, 1), square(0, 0, 1, 1))).toBeCloseTo(1, 6);
    expect(quadIoU(square(0, 0, 1, 1), square(2, 2, 3, 3))).toBe(0);
    // Mitad desplazada: interseccion 0,5 / union 1,5.
    expect(quadIoU(square(0, 0, 1, 1), square(0.5, 0, 1.5, 1))).toBeCloseTo(1 / 3, 6);
    expect(quadIntersectionArea(square(0, 0, 1, 1), square(0.5, 0, 1.5, 1))).toBeCloseTo(0.5, 6);
    expect(quadIoU(square(0, 0, 0, 0), square(0, 0, 1, 1))).toBe(0);
  });

  it("IoU es simetrica y funciona con un cuadrilatero inclinado", () => {
    const tilted: QuadCorners = { topLeft: { x: 0.1, y: 0 }, topRight: { x: 1, y: 0.1 }, bottomRight: { x: 0.9, y: 1 }, bottomLeft: { x: 0, y: 0.9 } };
    const a = quadIoU(tilted, square(0, 0, 1, 1));
    expect(a).toBeCloseTo(quadIoU(square(0, 0, 1, 1), tilted), 6);
    expect(a).toBeGreaterThan(0.7);
    expect(a).toBeLessThan(1);
  });

  it("area, centroide y desplazamiento maximo de esquina", () => {
    expect(quadArea(square(0, 0, 0.5, 0.5))).toBeCloseTo(0.25, 9);
    expect(quadCentroid(square(0, 0, 1, 1))).toEqual({ x: 0.5, y: 0.5 });
    const moved = square(0, 0, 1, 1);
    moved.bottomRight = { x: 1.03, y: 1.04 };
    expect(maxCornerShift(square(0, 0, 1, 1), moved)).toBeCloseTo(0.05, 9);
  });

  it("orderCorners devuelve TL, TR, BR, BL aunque lleguen desordenadas", () => {
    const ordered = orderCorners([{ x: 9, y: 9 }, { x: 0, y: 0 }, { x: 0, y: 9 }, { x: 9, y: 0 }]);
    expect(ordered.topLeft).toEqual({ x: 0, y: 0 });
    expect(ordered.topRight).toEqual({ x: 9, y: 0 });
    expect(ordered.bottomRight).toEqual({ x: 9, y: 9 });
    expect(ordered.bottomLeft).toEqual({ x: 0, y: 9 });
  });
});
