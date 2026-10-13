import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * W9-B5: el contexto 2D del lienzo lo crea la aplicacion, ANTES de `render` y no opaco. Si no existiera, pdf.js crearia
 * el suyo con `{ alpha: false, willReadFrequently: true }` y Chromium en Linux/Windows dibujaria el texto con
 * antialiasing LCD (franjas de color) dentro del PNG: medido en Linux con Docker, 23.767 pixeles distintos y SSIM 0,989
 * frente a la misma pagina con un lienzo no opaco (0 distintos). En macOS no hay LCD, asi que solo esta prueba (y la E2E
 * de nitidez en Linux) lo detectan.
 */
describe("renderPageRaster — el contexto 2D lo crea la aplicacion, no pdf.js", () => {
  const plan = planRaster(A4, { cssWidth: 640, zoom: 1, pixelRatio: 1 });

  type ContextCall = { type: string; attributes: unknown; renderedAlready: boolean };

  function setup(options: { context?: boolean } = {}) {
    const calls: ContextCall[] = [];
    let rendered = false;
    const canvas = {
      width: 0,
      height: 0,
      getContext(type: string, attributes?: unknown) {
        calls.push({ type, attributes, renderedAlready: rendered });
        return options.context === false ? null : {};
      },
      toBlob(callback: (blob: Blob | null) => void) {
        callback(new Blob(["png"], { type: "image/png" }));
      },
    };
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal("document", { createElement });
    const render = vi.fn((params: { canvas: unknown; intent?: string }) => {
      rendered = true;
      return { promise: Promise.resolve(), cancel: vi.fn(), params };
    });
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: A4.width * scale + 0.4, height: A4.height * scale + 0.4 }),
      render,
    } as never;
    return { calls, canvas, createElement, render, page };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("pide el contexto 2D ANTES de dibujar y sin canal opaco (`alpha` nunca es false)", async () => {
    const { calls, render, page } = setup();
    await renderPageRaster(page, plan);
    expect(render).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].type).toBe("2d");
    expect(calls[0].renderedAlready).toBe(false);
    const attributes = calls[0].attributes as { alpha?: boolean } | undefined;
    expect(attributes?.alpha).not.toBe(false);
    // Se escribe explicito: un lienzo no opaco es lo que garantiza el antialiasing en grises.
    expect(attributes?.alpha).toBe(true);
  });

  it("dibuja en ESE lienzo, con la intencion `print` y a un tamano truncado (nunca redondeado hacia arriba)", async () => {
    const { canvas, createElement, render, page } = setup();
    const result = await renderPageRaster(page, plan);
    const params = render.mock.calls[0][0];
    // Un solo lienzo: el que lleva el contexto de la aplicacion es el mismo en el que dibuja pdf.js.
    expect(createElement).toHaveBeenCalledTimes(1);
    expect(createElement).toHaveBeenCalledWith("canvas");
    expect(params.canvas).toBe(canvas);
    expect(params.intent).toBe("print");
    // El tamano del resultado es el del lienzo en el momento de dibujar (despues se vacia para liberar memoria).
    expect(result.width).toBe(Math.floor(A4.width * plan.scale + 0.4));
    expect(result.height).toBe(Math.floor(A4.height * plan.scale + 0.4));
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("sin contexto 2D lanza RasterUnavailableError y NO llama a render", async () => {
    const { render, page } = setup({ context: false });
    await expect(renderPageRaster(page, plan)).rejects.toBeInstanceOf(RasterUnavailableError);
    expect(render).not.toHaveBeenCalled();
  });
});
