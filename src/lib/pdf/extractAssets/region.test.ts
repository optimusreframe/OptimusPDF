import { describe, expect, it, vi } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { InkError, type InkImage } from "@/lib/image/inkCore";
import {
  REGION_DEFAULT_DPI,
  REGION_MAX_PIXELS,
  clampDpi,
  clampRegion,
  cropRegionWith,
  planRegion,
  type RegionRenderer,
} from "@/lib/pdf/extractAssets/region";

/** Recorte manual de una region: planificacion del render (ppp, tope de pixeles, enteros) y limpieza con `inkExtract`. */

describe("clampDpi", () => {
  it("limita a 300-600 y usa 400 sin valor o con basura", () => {
    expect(clampDpi(undefined)).toBe(REGION_DEFAULT_DPI);
    expect(clampDpi(Number.NaN)).toBe(REGION_DEFAULT_DPI);
    expect(clampDpi(Number.POSITIVE_INFINITY)).toBe(REGION_DEFAULT_DPI);
    expect(clampDpi(72)).toBe(300);
    expect(clampDpi(300)).toBe(300);
    expect(clampDpi(450.4)).toBe(450);
    expect(clampDpi(2400)).toBe(600);
  });
});

describe("clampRegion", () => {
  it("deja la region dentro de la pagina y con lado minimo", () => {
    expect(clampRegion({ x: -0.5, y: 0.9, width: 2, height: 0.5 })).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(clampRegion({ x: 0.2, y: 0.2, width: 0, height: -1 })).toMatchObject({ width: 0.002, height: 0.002 });
    expect(clampRegion({ x: 0.9, y: 0.9, width: 0.3, height: 0.3 })).toEqual({ x: 0.7, y: 0.7, width: 0.3, height: 0.3 });
  });
  it("rechaza valores que no son numeros", () => {
    expect(() => clampRegion({ x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow(RangeError);
    expect(() => clampRegion({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 })).toThrow(RangeError);
    expect(() => clampRegion(null as never)).toThrow(RangeError);
  });
});

describe("planRegion", () => {
  it("a 300 ppp una region de 40 % x 12 % de una carta mide 1020 x 396 px y su esquina cae en pixeles enteros", () => {
    const plan = planRegion(612, 792, { x: 0.12, y: 0.66, width: 0.4, height: 0.12 }, 300);
    expect(plan.scale).toBeCloseTo(300 / 72, 10);
    expect(plan.dpi).toBe(300);
    expect(plan.reduced).toBe(false);
    expect(plan.width).toBe(1020);
    expect(plan.height).toBe(396);
    expect(plan.left).toBe(Math.round(0.12 * 612 * (300 / 72)));
    expect(plan.top).toBe(Math.round(0.66 * 792 * (300 / 72)));
    for (const value of [plan.left, plan.top, plan.width, plan.height]) expect(Number.isInteger(value)).toBe(true);
  });
  it("600 ppp da el doble de pixeles por lado que 300", () => {
    const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };
    const low = planRegion(612, 792, rect, 300);
    const high = planRegion(612, 792, rect, 600);
    expect(high.width / low.width).toBeCloseTo(2, 1);
    expect(high.height / low.height).toBeCloseTo(2, 1);
  });
  it("una region enorme baja los ppp para no pasar de 16 millones de pixeles (nunca los sube)", () => {
    const plan = planRegion(2000, 3000, { x: 0, y: 0, width: 1, height: 1 }, 600);
    expect(plan.reduced).toBe(true);
    expect(plan.width * plan.height).toBeLessThanOrEqual(REGION_MAX_PIXELS * 1.001);
    expect(plan.dpi).toBeLessThan(600);
    const small = planRegion(612, 792, { x: 0, y: 0, width: 0.2, height: 0.1 }, 300);
    expect(small.reduced).toBe(false);
    expect(small.dpi).toBe(300);
  });
  it("una region diminuta mide al menos 1 x 1 px y las paginas sin tamano se rechazan", () => {
    const plan = planRegion(612, 792, { x: 0.5, y: 0.5, width: 0.0001, height: 0.0001 }, 300);
    expect(plan.width).toBeGreaterThanOrEqual(1);
    expect(plan.height).toBeGreaterThanOrEqual(1);
    expect(() => planRegion(0, 792, { x: 0, y: 0, width: 1, height: 1 })).toThrow(RangeError);
    expect(() => planRegion(612, Number.NaN, { x: 0, y: 0, width: 1, height: 1 })).toThrow(RangeError);
  });
});

/** Papel blanco con una firma azul (trazo de 6 px) y, opcionalmente, una sombra gris. */
function paper(width: number, height: number, withInk = true): InkImage {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  if (withInk) {
    context.strokeStyle = "rgb(20,48,138)";
    context.lineWidth = 6;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(width * 0.2, height * 0.6);
    for (let step = 0; step <= 40; step += 1) {
      const t = step / 40;
      context.lineTo(width * (0.2 + t * 0.6), height * (0.5 + Math.sin(t * Math.PI * 5) * 0.2));
    }
    context.stroke();
  }
  const { data } = context.getImageData(0, 0, width, height);
  return { width, height, data };
}

async function decode(png: Blob) {
  const image = await loadImage(Buffer.from(await png.arrayBuffer()));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

describe("cropRegionWith", () => {
  const rect = { x: 0.1, y: 0.6, width: 0.4, height: 0.1 };

  it("pasa al renderizador la region acotada, la pagina y los ppp (300-600)", async () => {
    const render = vi.fn<RegionRenderer>(async () => ({ image: paper(600, 200), dpi: 300 }));
    await cropRegionWith(render, new Uint8Array([1]), 3, { x: -1, y: 0.2, width: 0.3, height: 0.1 }, { dpi: 9000 });
    expect(render).toHaveBeenCalledTimes(1);
    const [, page, region, dpi] = render.mock.calls[0];
    expect(page).toBe(3);
    expect(region.x).toBe(0);
    expect(dpi).toBe(600);
    await cropRegionWith(render, new Uint8Array([1]), 0, rect);
    expect(render.mock.calls[1][3]).toBe(REGION_DEFAULT_DPI);
  });

  it("limpia el fondo: PNG transparente recortado a la tinta, de color azul y con las esquinas transparentes", async () => {
    const render: RegionRenderer = async () => ({ image: paper(900, 300), dpi: 300 });
    const out = await cropRegionWith(render, new Uint8Array([1]), 0, rect);
    expect(out.png.type).toBe("image/png");
    const decoded = await decode(out.png);
    expect(decoded.width).toBe(out.width);
    expect(decoded.height).toBe(out.height);
    // Recortado a la tinta (con un margen): mas pequeno que la region renderizada.
    expect(out.width).toBeLessThan(900);
    expect(out.height).toBeLessThan(300);
    const corner = (x: number, y: number) => decoded.data[(y * decoded.width + x) * 4 + 3];
    expect([corner(0, 0), corner(decoded.width - 1, 0), corner(0, decoded.height - 1), corner(decoded.width - 1, decoded.height - 1)]).toEqual([0, 0, 0, 0]);
    let opaque = 0;
    let blue = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      if (decoded.data[i + 3] >= 200) {
        opaque += 1;
        if (decoded.data[i + 2] > decoded.data[i] + 40) blue += 1;
      }
    }
    expect(opaque).toBeGreaterThan(500);
    expect(blue / opaque).toBeGreaterThan(0.95);
  });

  it("con cleanBackground:false devuelve la region tal cual, opaca y sin recortar", async () => {
    const render: RegionRenderer = async () => ({ image: paper(500, 120), dpi: 300 });
    const out = await cropRegionWith(render, new Uint8Array([1]), 0, rect, { cleanBackground: false });
    expect([out.width, out.height]).toEqual([500, 120]);
    const decoded = await decode(out.png);
    expect(decoded.data[3]).toBe(255);
    expect(Array.from(decoded.data.subarray(0, 3))).toEqual([255, 255, 255]);
  });

  it("una region en blanco da el error «no-ink» del motor de tinta", async () => {
    const render: RegionRenderer = async () => ({ image: paper(400, 120, false), dpi: 300 });
    await expect(cropRegionWith(render, new Uint8Array([1]), 0, rect)).rejects.toMatchObject({ name: "InkError", code: "no-ink" });
  });

  it("una region muy oscura da «too-dark»", async () => {
    const dark: InkImage = { width: 200, height: 100, data: new Uint8ClampedArray(200 * 100 * 4).map((_, index) => (index % 4 === 3 ? 255 : 10)) };
    const render: RegionRenderer = async () => ({ image: dark, dpi: 300 });
    await expect(cropRegionWith(render, new Uint8Array([1]), 0, rect)).rejects.toMatchObject({ code: "too-dark" });
  });

  it("cancelar antes de empezar o mientras se renderiza rechaza con «aborted» y no llama al motor despues", async () => {
    const before = new AbortController();
    before.abort();
    const render = vi.fn<RegionRenderer>(async () => ({ image: paper(400, 120), dpi: 300 }));
    await expect(cropRegionWith(render, new Uint8Array([1]), 0, rect, { signal: before.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(render).not.toHaveBeenCalled();
    const during = new AbortController();
    const slow: RegionRenderer = async () => {
      during.abort();
      return { image: paper(400, 120), dpi: 300 };
    };
    await expect(cropRegionWith(slow, new Uint8Array([1]), 0, rect, { signal: during.signal })).rejects.toBeInstanceOf(InkError);
  });

  it("propaga los fallos del renderizador y rechaza regiones no validas antes de renderizar", async () => {
    const render = vi.fn<RegionRenderer>(async () => {
      throw new Error("pagina rota");
    });
    await expect(cropRegionWith(render, new Uint8Array([1]), 0, rect)).rejects.toThrow("pagina rota");
    await expect(cropRegionWith(render, new Uint8Array([1]), 0, { x: Number.NaN, y: 0, width: 1, height: 1 })).rejects.toBeInstanceOf(RangeError);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
