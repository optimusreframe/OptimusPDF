import { describe, expect, it } from "vitest";
import { geometryOf } from "./classify";

/** H3: la geometria lleva la altura respecto al LADO LARGO de la pagina (no sesga las apaisadas). */

const rect = { x: 0.1, y: 0.4, width: 0.28, height: 0.087 };

describe("geometryOf · longHeightFrac", () => {
  it("pagina vertical (612 x 792): el lado largo es el alto, igual que `heightFrac`", () => {
    const g = geometryOf([{ pageIndex: 0, rect: { ...rect, height: 0.067 } }], () => ({ width: 612, height: 792 }), 0)!;
    expect(g.heightFrac).toBeCloseTo(0.067, 6);
    expect(g.longHeightFrac).toBeCloseTo(0.067, 6);
  });
  it("pagina apaisada (792 x 612): 53 pt son el 8,7 % del alto pero el 6,7 % del lado largo", () => {
    const g = geometryOf([{ pageIndex: 0, rect }], () => ({ width: 792, height: 612 }), 0)!;
    expect(g.heightFrac).toBeCloseTo(0.087, 6);
    expect(g.heightPt).toBeCloseTo(53.2, 1);
    expect(g.longHeightFrac).toBeCloseTo(53.244 / 792, 4);
    expect(g.longHeightFrac!).toBeLessThan(0.08);
  });
  it("cuadrada: el lado largo es cualquiera de los dos", () => {
    const g = geometryOf([{ pageIndex: 0, rect }], () => ({ width: 600, height: 600 }), 0)!;
    expect(g.longHeightFrac).toBeCloseTo(g.heightFrac, 6);
  });
});
