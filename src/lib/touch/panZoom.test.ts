import { describe, expect, it } from "vitest";
import { clampPan, panForPinch, panToCenterPoint, panWithOverflow } from "@/lib/touch/panZoom";

const SIZE = { width: 600, height: 800 };

describe("clampPan", () => {
  it("a 1x no hay recorrido", () => {
    expect(clampPan({ x: 50, y: -30 }, 1, SIZE)).toEqual({ x: 0, y: 0 });
  });

  it("el recorrido es TODA la hoja (ancho * (zoom - 1) / 2), no una cota fija de 400 px", () => {
    // 600 * (3 - 1) / 2 = 600 > el antiguo limite de 400 px; 800 * 2 / 2 = 800.
    expect(clampPan({ x: -900, y: 900 }, 3, SIZE)).toEqual({ x: -600, y: 800 });
    expect(clampPan({ x: -500, y: 0 }, 3, SIZE).x).toBe(-500);
  });
});

describe("panForPinch · el punto bajo los dedos se queda bajo los dedos", () => {
  /** Donde se ve (px de pantalla) un punto de la hoja a `p` px de su centro: `centro + pan + zoom * p`. */
  const onScreen = (layoutCenter: { x: number; y: number }, pan: { x: number; y: number }, zoom: number, p: { x: number; y: number }) => ({
    x: layoutCenter.x + pan.x + zoom * p.x,
    y: layoutCenter.y + pan.y + zoom * p.y,
  });

  it("zoom 1 -> 2.5 alrededor de un punto fuera del centro", () => {
    const layoutCenter = { x: 200, y: 400 };
    const pan0 = { x: 0, y: 0 };
    const zoom0 = 1;
    const zoom1 = 2.5;
    // Los dedos estan en (300, 520): ese punto de la hoja esta a (100, 120) px del centro.
    const mid = { x: 300, y: 520 };
    const p = { x: (mid.x - layoutCenter.x - pan0.x) / zoom0, y: (mid.y - layoutCenter.y - pan0.y) / zoom0 };
    const pan1 = panForPinch({ pan0, zoom0, zoom1, mid0: mid, mid1: mid, rectCenter0: { x: layoutCenter.x + pan0.x, y: layoutCenter.y + pan0.y } });
    const after = onScreen(layoutCenter, pan1, zoom1, p);
    expect(after.x).toBeCloseTo(mid.x, 6);
    expect(after.y).toBeCloseTo(mid.y, 6);
  });

  it("con pan previo y zoom previo, y los dedos que ademas se desplazan", () => {
    const layoutCenter = { x: 180, y: 300 };
    const pan0 = { x: -40, y: 25 };
    const zoom0 = 1.6;
    const zoom1 = 2.4;
    const mid0 = { x: 250, y: 280 };
    const mid1 = { x: 210, y: 330 };
    const p = { x: (mid0.x - layoutCenter.x - pan0.x) / zoom0, y: (mid0.y - layoutCenter.y - pan0.y) / zoom0 };
    const pan1 = panForPinch({ pan0, zoom0, zoom1, mid0, mid1, rectCenter0: { x: layoutCenter.x + pan0.x, y: layoutCenter.y + pan0.y } });
    const after = onScreen(layoutCenter, pan1, zoom1, p);
    expect(after.x).toBeCloseTo(mid1.x, 6);
    expect(after.y).toBeCloseTo(mid1.y, 6);
  });

  it("pellizcar justo en el centro de la hoja no la desplaza", () => {
    const center = { x: 300, y: 400 };
    const pan1 = panForPinch({ pan0: { x: 0, y: 0 }, zoom0: 1, zoom1: 2, mid0: center, mid1: center, rectCenter0: center });
    expect(pan1.x).toBeCloseTo(0, 9);
    expect(pan1.y).toBeCloseTo(0, 9);
  });
});

describe("panWithOverflow · lo que la hoja no absorbe sigue con la pagina", () => {
  it("dentro del recorrido, todo se absorbe", () => {
    const result = panWithOverflow({ x: 0, y: 0 }, { x: -20, y: -30 }, 2, SIZE);
    expect(result.pan).toEqual({ x: -20, y: -30 });
    expect(result.overflow).toEqual({ x: 0, y: 0 });
  });

  it("al llegar al borde, el resto del movimiento es desbordamiento (el dedo sube 50: la pagina baja 50)", () => {
    // A zoom 2 el recorrido vertical es +-400: ya en el borde de abajo (-400), subir el dedo 50 mas no cabe.
    const result = panWithOverflow({ x: 0, y: -400 }, { x: 0, y: -50 }, 2, SIZE);
    expect(result.pan.y).toBe(-400);
    expect(result.overflow.y).toBe(-50);
  });
});

describe("panToCenterPoint", () => {
  it("lleva un punto de pantalla a otro moviendo la hoja, sin salirse del recorrido", () => {
    const pan = panToCenterPoint({
      pan: { x: 0, y: 0 },
      zoom: 2,
      size: SIZE,
      point: { x: 500, y: 700 },
      target: { x: 300, y: 400 },
    });
    expect(pan).toEqual({ x: -200, y: -300 });
    const far = panToCenterPoint({
      pan: { x: 0, y: 0 },
      zoom: 2,
      size: SIZE,
      point: { x: 5000, y: 5000 },
      target: { x: 0, y: 0 },
    });
    expect(far).toEqual({ x: -300, y: -400 });
  });
});
