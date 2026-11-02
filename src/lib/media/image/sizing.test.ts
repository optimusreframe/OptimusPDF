import { describe, expect, it } from "vitest";
import {
  BMP_MAX_PIXELS,
  DESKTOP_LIMITS,
  IOS_LIMITS,
  canvasPixelsFor,
  computeOutputSize,
  limitsFor,
  megapixels,
} from "@/lib/media/image/sizing";

const open = { maxPixels: 1e9, maxSide: 1e6 };

describe("computeOutputSize", () => {
  it("original: no cambia nada", () => {
    expect(computeOutputSize(4000, 3000, { mode: "original" }, open)).toEqual({ width: 4000, height: 3000, resized: false, capped: false });
  });

  it("ancho maximo: reduce conservando la proporcion", () => {
    expect(computeOutputSize(4000, 3000, { mode: "maxWidth", maxWidth: 1000 }, open)).toEqual({ width: 1000, height: 750, resized: true, capped: false });
    // Vertical: el ancho es el lado corto, el alto sale proporcional.
    expect(computeOutputSize(3000, 4000, { mode: "maxWidth", maxWidth: 1500 }, open)).toEqual({ width: 1500, height: 2000, resized: true, capped: false });
  });

  it("ancho maximo: NUNCA amplia una imagen mas estrecha", () => {
    expect(computeOutputSize(800, 600, { mode: "maxWidth", maxWidth: 1920 }, open)).toEqual({ width: 800, height: 600, resized: false, capped: false });
    expect(computeOutputSize(800, 600, { mode: "maxWidth", maxWidth: 800 }, open).resized).toBe(false);
  });

  it("porcentaje: escala y nunca pasa del 100 %", () => {
    expect(computeOutputSize(1000, 500, { mode: "percent", percent: 50 }, open)).toEqual({ width: 500, height: 250, resized: true, capped: false });
    expect(computeOutputSize(1000, 500, { mode: "percent", percent: 200 }, open)).toEqual({ width: 1000, height: 500, resized: false, capped: false });
  });

  it("valores no validos dejan la imagen como esta", () => {
    for (const resize of [
      { mode: "maxWidth", maxWidth: 0 },
      { mode: "maxWidth", maxWidth: Number.NaN },
      { mode: "percent", percent: -5 },
      { mode: "percent", percent: Number.NaN },
    ] as const) {
      expect(computeOutputSize(640, 480, resize, open)).toEqual({ width: 640, height: 480, resized: false, capped: false });
    }
  });

  it("una imagen muy estrecha no se queda en 0 px", () => {
    const size = computeOutputSize(2000, 3, { mode: "maxWidth", maxWidth: 100 }, open);
    expect(size.width).toBe(100);
    expect(size.height).toBe(1);
  });

  it("el limite del lienzo reduce MAS de lo pedido y lo avisa con `capped`", () => {
    // 8000 x 6000 = 48 Mpx; el tope de iOS es 16 Mpx.
    const size = computeOutputSize(8000, 6000, { mode: "original" }, { maxPixels: IOS_LIMITS.maxCanvasPixels, maxSide: IOS_LIMITS.maxCanvasSide });
    expect(size.capped).toBe(true);
    expect(size.resized).toBe(true);
    expect(size.width).toBeLessThanOrEqual(IOS_LIMITS.maxCanvasSide);
    expect(size.width * size.height).toBeLessThanOrEqual(IOS_LIMITS.maxCanvasPixels);
    expect(size.width / size.height).toBeCloseTo(8000 / 6000, 1);
  });

  it("si lo pedido ya cabe en el lienzo, no se avisa de reduccion extra", () => {
    const size = computeOutputSize(8000, 6000, { mode: "maxWidth", maxWidth: 1000 }, { maxPixels: IOS_LIMITS.maxCanvasPixels, maxSide: IOS_LIMITS.maxCanvasSide });
    expect(size).toEqual({ width: 1000, height: 750, resized: true, capped: false });
  });

  it("el lado maximo del lienzo tambien acota (una panoramica)", () => {
    const size = computeOutputSize(20000, 1000, { mode: "original" }, { maxPixels: 1e9, maxSide: 16384 });
    expect(size.width).toBe(16384);
    expect(size.capped).toBe(true);
  });
});

describe("limites por dispositivo", () => {
  it("iPhone/iPad es mas estricto que un ordenador en todo", () => {
    expect(limitsFor(true)).toBe(IOS_LIMITS);
    expect(limitsFor(false)).toBe(DESKTOP_LIMITS);
    for (const key of Object.keys(DESKTOP_LIMITS) as Array<keyof typeof DESKTOP_LIMITS>) expect(IOS_LIMITS[key]).toBeLessThan(DESKTOP_LIMITS[key]);
  });

  it("el BMP se acota antes que los demas formatos", () => {
    expect(canvasPixelsFor("bmp", DESKTOP_LIMITS)).toBe(BMP_MAX_PIXELS);
    expect(canvasPixelsFor("jpeg", DESKTOP_LIMITS)).toBe(DESKTOP_LIMITS.maxCanvasPixels);
    expect(canvasPixelsFor("bmp", IOS_LIMITS)).toBe(IOS_LIMITS.maxCanvasPixels);
  });

  it("megapixels redondea a un decimal", () => {
    expect(megapixels(4000, 3000)).toBe(12);
    expect(megapixels(8064, 6048)).toBe(48.8);
  });
});
