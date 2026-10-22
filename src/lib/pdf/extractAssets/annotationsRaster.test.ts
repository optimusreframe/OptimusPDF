import { describe, expect, it } from "vitest";
import {
  alphaBounds,
  cropImage,
  countVisible,
  diffLayers,
  estimatePngBytes,
  fitInto,
  fitScale,
  normalizeViewRect,
  pngBlob,
  renderRegion,
  round3,
  shortHash,
  thumbBlob,
  trimTransparent,
} from "./annotationsRaster";
import { AnnotationRenderError, MAX_RENDER_PIXELS, MAX_RENDER_SIDE, type RasterImage } from "./annotationsTypes";
import { decodePng, isPng, napiSurfaceFactory, withLegacyDocument } from "./__fixtures__/annots/nodeEnv";
import { makeInkMulti } from "./__fixtures__/annots/generate";

function blank(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function setPixel(image: RasterImage, x: number, y: number, rgba: [number, number, number, number]): void {
  image.data.set(rgba, (y * image.width + x) * 4);
}

function pixel(image: RasterImage, x: number, y: number): number[] {
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
}

describe("diffLayers", () => {
  it("devuelve el pixel nuevo tal cual donde la base estaba vacia", () => {
    const base = blank(2, 1);
    const over = blank(2, 1);
    setPixel(over, 1, 0, [200, 10, 10, 255]);
    const diff = diffLayers(base, over);
    expect(pixel(diff, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(diff, 1, 0)).toEqual([200, 10, 10, 255]);
  });

  it("donde la pagina ya pintaba, solo cuenta lo que cambia mas alla de la tolerancia", () => {
    const base = blank(3, 1);
    const over = blank(3, 1);
    for (let x = 0; x < 3; x += 1) setPixel(base, x, 0, [100, 100, 100, 255]);
    setPixel(over, 0, 0, [100, 100, 100, 255]); // igual
    setPixel(over, 1, 0, [102, 100, 100, 255]); // dentro de la tolerancia (3)
    setPixel(over, 2, 0, [140, 100, 100, 255]); // cambia
    const diff = diffLayers(base, over);
    expect(pixel(diff, 0, 0)[3]).toBe(0);
    expect(pixel(diff, 1, 0)[3]).toBe(0);
    expect(pixel(diff, 2, 0)).toEqual([140, 100, 100, 255]);
  });

  it("un pixel que la anotacion no cubre queda transparente aunque la pagina pinte debajo", () => {
    const base = blank(1, 1);
    setPixel(base, 0, 0, [0, 0, 0, 255]);
    expect(pixel(diffLayers(base, blank(1, 1)), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("rechaza capas de distinto tamano", () => {
    expect(() => diffLayers(blank(2, 2), blank(3, 2))).toThrow(AnnotationRenderError);
  });
});

describe("recortes y medidas", () => {
  it("cropImage copia la zona y deja transparente lo que cae fuera", () => {
    const image = blank(4, 4);
    setPixel(image, 3, 3, [1, 2, 3, 255]);
    const crop = cropImage(image, 2, 2, 4, 4);
    expect(crop.width).toBe(4);
    expect(pixel(crop, 1, 1)).toEqual([1, 2, 3, 255]);
    expect(pixel(crop, 3, 3)).toEqual([0, 0, 0, 0]);
    const negative = cropImage(image, -2, -2, 3, 3);
    expect(negative.data.some((v) => v !== 0)).toBe(false);
  });

  it("alphaBounds, trimTransparent y countVisible respetan el alfa minimo", () => {
    const image = blank(10, 10);
    setPixel(image, 3, 4, [0, 0, 0, 255]);
    setPixel(image, 6, 7, [0, 0, 0, 40]);
    setPixel(image, 9, 9, [0, 0, 0, 3]);
    expect(alphaBounds(image, 8)).toEqual({ x: 3, y: 4, width: 4, height: 4 });
    expect(alphaBounds(blank(3, 3))).toBeNull();
    expect(countVisible(image, 8)).toBe(2);
    const trimmed = trimTransparent(image, 1, 8);
    expect(trimmed?.rect).toEqual({ x: 3, y: 4, width: 4, height: 4 });
    expect(trimmed?.image.width).toBe(6);
  });

  it("fitScale respeta el tope de pixeles y de lado y nunca amplia por encima de lo pedido", () => {
    expect(fitScale(100, 50, 3)).toBe(3);
    const huge = fitScale(2000, 2000, 4);
    expect(2000 * huge * 2000 * huge).toBeLessThanOrEqual(MAX_RENDER_PIXELS * 1.001);
    expect(fitScale(10_000, 10, 4) * 10_000).toBeLessThanOrEqual(MAX_RENDER_SIDE + 1);
    expect(fitScale(0, 0, 2)).toBeGreaterThan(0);
  });

  it("normalizeViewRect recorta a la pagina y redondea", () => {
    expect(normalizeViewRect({ x: -10, y: 50, width: 200, height: 1000 }, 100, 200)).toEqual({ x: 0, y: 0.25, width: 1, height: 0.75 });
    expect(round3(0.123456)).toBe(0.123);
  });

  it("shortHash es estable, de 8 cifras y distingue entradas", () => {
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
  });

  it("estimatePngBytes crece con el area y nunca baja del tamano de la miniatura", () => {
    expect(estimatePngBytes(1000, 100, 100)).toBe(1000);
    expect(estimatePngBytes(1000, 100, 10_000)).toBeGreaterThan(1000);
    expect(estimatePngBytes(1000, 100, 40_000)).toBeGreaterThan(estimatePngBytes(1000, 100, 10_000));
    expect(estimatePngBytes(500, 0, 1000)).toBe(500);
  });
});

describe("PNG y miniaturas", () => {
  it("pngBlob da un PNG que se decodifica a los mismos pixeles", async () => {
    const image = blank(3, 2);
    setPixel(image, 1, 1, [10, 200, 30, 180]);
    const blob = await pngBlob(image);
    expect(await isPng(blob)).toBe(true);
    const back = await decodePng(blob);
    expect(back.width).toBe(3);
    const p = pixel(back, 1, 1);
    expect(p[3]).toBe(180);
    expect(Math.abs(p[1] - 200)).toBeLessThanOrEqual(2);
  });

  it("thumbBlob nunca pasa de 256 px y no amplia lo pequeno", async () => {
    const big = blank(1000, 400);
    setPixel(big, 500, 200, [0, 0, 0, 255]);
    const thumb = await decodePng(await thumbBlob(big));
    expect(Math.max(thumb.width, thumb.height)).toBe(256);
    expect(thumb.width / thumb.height).toBeCloseTo(2.5, 1);
    const small = await decodePng(await thumbBlob(blank(40, 20)));
    expect([small.width, small.height]).toEqual([40, 20]);
    expect(fitInto(big, 2000)).toBe(big);
  });
});

describe("renderRegion con pdf.js", () => {
  it("renderizar solo una region equivale a recortar el render completo (offsets de la vista)", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      const full = await renderRegion({ page, region: { x: 0, y: 0, width: 612, height: 792 }, scale: 1, annotationMode: 1, createSurface: napiSurfaceFactory });
      const region = { x: 90, y: 560, width: 200, height: 90 };
      const part = await renderRegion({ page, region, scale: 1, annotationMode: 1, createSurface: napiSurfaceFactory });
      const expected = cropImage(full, 90, 560, 200, 90);
      let different = 0;
      for (let i = 0; i < part.data.length; i += 4) {
        if (Math.abs(part.data[i + 3] - expected.data[i + 3]) > 24) different += 1;
      }
      expect(part.width).toBe(200);
      expect(part.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
      expect(different / (part.width * part.height)).toBeLessThan(0.01);
    });
  });

  it("con annotationMode 0 no pinta las anotaciones y con 1 si; el fondo por defecto es transparente", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      const region = { x: 90, y: 590, width: 220, height: 80 };
      const without = await renderRegion({ page, region, scale: 1, annotationMode: 0, createSurface: napiSurfaceFactory });
      const withAnnots = await renderRegion({ page, region, scale: 1, annotationMode: 1, createSurface: napiSurfaceFactory });
      expect(countVisible(without, 8)).toBe(0);
      expect(countVisible(withAnnots, 8)).toBeGreaterThan(200);
    });
  });

  it("rechaza regiones fuera de los topes y cancela con la senal", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      await expect(renderRegion({ page, region: { x: 0, y: 0, width: 612, height: 792 }, scale: 40, annotationMode: 1, createSurface: napiSurfaceFactory })).rejects.toMatchObject({ code: "too-large" });
      const controller = new AbortController();
      controller.abort();
      await expect(renderRegion({ page, region: { x: 0, y: 0, width: 50, height: 50 }, scale: 1, annotationMode: 1, createSurface: napiSurfaceFactory, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    });
  });

  it("libera la superficie aunque el render falle", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      let released = 0;
      const factory = (width: number, height: number) => ({ ...napiSurfaceFactory(width, height), release: () => (released += 1) });
      await renderRegion({ page, region: { x: 0, y: 0, width: 30, height: 30 }, scale: 1, annotationMode: 1, createSurface: factory });
      const broken = { getViewport: () => ({}), render: () => ({ promise: Promise.reject(new Error("fallo de render")), cancel: () => undefined }) } as never;
      await expect(renderRegion({ page: broken, region: { x: 0, y: 0, width: 30, height: 30 }, scale: 1, annotationMode: 1, createSurface: factory })).rejects.toThrow("fallo de render");
      expect(released).toBe(2);
    });
  });
});
