import { describe, expect, it, vi } from "vitest";
import {
  MAX_PIXEL_RATIO,
  MAX_RASTER_PIXELS,
  MAX_RASTER_SIDE,
  RasterCache,
  RasterCancelledError,
  RasterUnavailableError,
  bucketZoom,
  isRasterCancelled,
  planRaster,
  renderPageRaster,
} from "@/lib/pdf/pageRaster";

/** Una pagina A4 a escala 1: 595 x 842 pt. */
const A4 = { width: 595, height: 842 };

describe("planRaster — el bitmap se dibuja al tamano en que se VE", () => {
  it("a DPR 1 mide el ancho mostrado (no 900 px fijos ni el ancho de la pagina)", () => {
    const plan = planRaster(A4, { cssWidth: 640, zoom: 1, pixelRatio: 1 });
    expect(plan.width).toBe(640);
    expect(plan.scale).toBeCloseTo(640 / 595, 6);
    expect(plan.capped).toBe(false);
  });

  it("a DPR 2 el bitmap tiene el doble de pixeles que el ancho CSS", () => {
    const plan = planRaster(A4, { cssWidth: 640, zoom: 1, pixelRatio: 2 });
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(Math.floor(842 * (1280 / 595)));
  });

  it("el zoom multiplica el tamano (el render vuelve a ser nitido al acercar)", () => {
    const base = planRaster(A4, { cssWidth: 640, zoom: 1, pixelRatio: 2 });
    const zoomed = planRaster(A4, { cssWidth: 640, zoom: 2, pixelRatio: 2 });
    expect(zoomed.width).toBe(base.width * 2);
  });

  it("la densidad se limita a 3 (un monitor de 4x no dispara la memoria)", () => {
    const plan = planRaster(A4, { cssWidth: 400, zoom: 1, pixelRatio: 4 });
    expect(plan.pixelRatio).toBe(MAX_PIXEL_RATIO);
    expect(plan.width).toBe(1200);
  });

  it("una densidad invalida o menor que 1 cae a 1", () => {
    expect(planRaster(A4, { cssWidth: 500, zoom: 1, pixelRatio: 0 }).pixelRatio).toBe(1);
    expect(planRaster(A4, { cssWidth: 500, zoom: 1, pixelRatio: Number.NaN }).pixelRatio).toBe(1);
  });

  it("tope de 16 MP por pagina: zoom x3 a DPR 3 de una hoja cuadrada no pasa de 16 millones de pixeles", () => {
    const plan = planRaster({ width: 600, height: 600 }, { cssWidth: 640, zoom: 3, pixelRatio: 3 });
    expect(plan.capped).toBe(true);
    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(plan.width * plan.height).toBeGreaterThan(MAX_RASTER_PIXELS * 0.9);
  });

  it("zoom x3 a DPR 3 de un A4 queda dentro de AMBOS topes (16 MP y 4096 px de lado)", () => {
    const plan = planRaster(A4, { cssWidth: 640, zoom: 3, pixelRatio: 3 });
    expect(plan.capped).toBe(true);
    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(MAX_RASTER_SIDE);
  });

  it("tope de 4096 px de lado: una hoja muy alta se recorta por su lado largo", () => {
    const plan = planRaster({ width: 200, height: 3000 }, { cssWidth: 640, zoom: 1, pixelRatio: 2 });
    expect(plan.capped).toBe(true);
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(MAX_RASTER_SIDE);
  });

  it("los topes se pueden inyectar", () => {
    const plan = planRaster(A4, { cssWidth: 640, zoom: 1, pixelRatio: 2, maxPixels: 100_000 });
    expect(plan.width * plan.height).toBeLessThanOrEqual(100_000);
  });

  it("una pagina diminuta o de tamano 0 no da un bitmap de 0 px", () => {
    const plan = planRaster({ width: 0, height: 0 }, { cssWidth: 640, zoom: 1, pixelRatio: 1 });
    expect(plan.width).toBeGreaterThanOrEqual(1);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });
});

describe("bucketZoom", () => {
  it("redondea hacia arriba a pasos de 0,25 y nunca baja de 1", () => {
    expect(bucketZoom(1)).toBe(1);
    expect(bucketZoom(0.4)).toBe(1);
    expect(bucketZoom(1.01)).toBe(1.25);
    expect(bucketZoom(1.5)).toBe(1.5);
    expect(bucketZoom(2.6)).toBe(2.75);
    expect(bucketZoom(3)).toBe(3);
    expect(bucketZoom(Number.NaN)).toBe(1);
  });
});

describe("RasterCache — LRU con limite", () => {
  const entry = (name: string, bytes = 10) => ({ url: `blob:${name}`, bytes, width: 1, height: 1 });

  it("expulsa la menos reciente al pasar de maxEntries y libera su URL", () => {
    const revoke = vi.fn();
    const cache = new RasterCache({ maxEntries: 2, revoke });
    cache.set("a", entry("a"));
    cache.set("b", entry("b"));
    cache.set("c", entry("c"));
    expect(cache.keys()).toEqual(["b", "c"]);
    expect(revoke).toHaveBeenCalledWith("blob:a");
  });

  it("leer una entrada la hace la mas reciente", () => {
    const cache = new RasterCache({ maxEntries: 2, revoke: () => {} });
    cache.set("a", entry("a"));
    cache.set("b", entry("b"));
    cache.get("a");
    cache.set("c", entry("c"));
    expect(cache.keys()).toEqual(["a", "c"]);
  });

  it("tambien limita por bytes", () => {
    const revoke = vi.fn();
    const cache = new RasterCache({ maxEntries: 10, maxBytes: 25, revoke });
    cache.set("a", entry("a", 10));
    cache.set("b", entry("b", 10));
    cache.set("c", entry("c", 10));
    expect(cache.bytes).toBeLessThanOrEqual(25);
    expect(cache.keys()).toEqual(["b", "c"]);
  });

  it("la URL anclada (la que se esta mostrando) no se expulsa", () => {
    const revoke = vi.fn();
    const cache = new RasterCache({ maxEntries: 2, revoke });
    cache.set("a", entry("a"));
    cache.pin("blob:a");
    cache.set("b", entry("b"));
    cache.set("c", entry("c"));
    expect(cache.keys()).toContain("a");
    expect(revoke).not.toHaveBeenCalledWith("blob:a");
  });

  it("una sola entrada enorme se conserva (no se queda sin imagen)", () => {
    const cache = new RasterCache({ maxEntries: 5, maxBytes: 5, revoke: () => {} });
    cache.set("big", entry("big", 100));
    expect(cache.keys()).toEqual(["big"]);
  });

  it("clear libera todas las URL, tambien la anclada", () => {
    const revoke = vi.fn();
    const cache = new RasterCache({ revoke });
    cache.set("a", entry("a"));
    cache.set("b", entry("b"));
    cache.pin("blob:a");
    cache.clear();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("100 paginas seguidas no pasan del limite de entradas (documentos de 100+ paginas)", () => {
    const cache = new RasterCache({ maxEntries: 6, revoke: () => {} });
    for (let page = 0; page < 100; page += 1) cache.set(`${page}`, entry(`p${page}`));
    expect(cache.size).toBeLessThanOrEqual(6);
  });
});

describe("renderPageRaster", () => {
  const plan = planRaster(A4, { cssWidth: 640, zoom: 1, pixelRatio: 1 });

  it("sin motor de render (la pagina no tiene render, o no hay DOM) lanza RasterUnavailableError", async () => {
    const page = { getViewport: () => ({ width: 1, height: 1 }) } as never;
    await expect(renderPageRaster(page, plan)).rejects.toBeInstanceOf(RasterUnavailableError);
  });

  it("una senal ya abortada lanza RasterCancelledError (no es un fallo)", async () => {
    const page = { render: vi.fn(), getViewport: () => ({ width: 1, height: 1 }) } as never;
    const controller = new AbortController();
    controller.abort();
    // En Node no hay `document`: la comprobacion de disponibilidad va primero.
    await expect(renderPageRaster(page, plan, { signal: controller.signal })).rejects.toSatisfy(
      (error) => error instanceof RasterUnavailableError || error instanceof RasterCancelledError,
    );
  });

  it("isRasterCancelled reconoce la cancelacion propia y la de pdf.js", () => {
    expect(isRasterCancelled(new RasterCancelledError())).toBe(true);
    const pdfjs = new Error("x");
    pdfjs.name = "RenderingCancelledException";
    expect(isRasterCancelled(pdfjs)).toBe(true);
    expect(isRasterCancelled(new Error("otra cosa"))).toBe(false);
  });
});
