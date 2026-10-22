import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  Slicer,
  abortError,
  analyzeSource,
  cropSource,
  encodeSourceAsJpeg,
  encodeSourceAsPng,
  estimatePngBytes,
  isAbortError,
  pixelSourceFor,
  readAllPixels,
  thumbSize,
} from "./imagesPixels";
import { blobBytes, decodePng } from "./images.testUtils";

const slicer = () => new Slicer();

function rgba(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  return data;
}

describe("pixelSourceFor — formas que entrega pdf.js sin canvas (Node)", () => {
  it("RGBA (kind 3): devuelve las filas tal cual y detecta el alfa", async () => {
    const data = rgba(4, 3, (x, y) => [x * 10, y * 10, 5, x === 2 && y === 1 ? 100 : 255]);
    const source = pixelSourceFor({ width: 4, height: 3, kind: 3, data }, { kind: "image" })!;
    expect(source.opaque).toBe(false);
    expect([...source.rows(1, 2)]).toEqual([...data.subarray(16, 32)]);
    const analysis = await analyzeSource(source, 256, slicer());
    expect(analysis.hasAlpha).toBe(true);
  });

  it("RGB (kind 2): expande a RGBA opaco", async () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // 2 x 2
    const source = pixelSourceFor({ width: 2, height: 2, kind: 2, data }, { kind: "image" })!;
    expect(source.opaque).toBe(true);
    expect([...source.rows(0, 2)]).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
    expect((await analyzeSource(source, 256, slicer())).hasAlpha).toBe(false);
  });

  it("gris de 1 bit (kind 1): el bit 1 es blanco y las filas se alinean a byte", () => {
    // 10 px de ancho -> 2 bytes por fila. Fila 0: 1010101010; fila 1: todo negro.
    const data = new Uint8Array([0b10101010, 0b10000000, 0, 0]);
    const source = pixelSourceFor({ width: 10, height: 2, kind: 1, data }, { kind: "image" })!;
    const rows = source.rows(0, 2);
    const lum = (x: number, y: number): number => rows[(y * 10 + x) * 4];
    expect([0, 1, 2, 3].map((x) => lum(x, 0))).toEqual([255, 0, 255, 0]);
    expect(lum(8, 0)).toBe(255);
    expect(lum(9, 0)).toBe(0);
    expect([0, 5, 9].map((x) => lum(x, 1))).toEqual([0, 0, 0]);
  });

  it("mascara de 1 bit: bit 0 = se pinta, con el color de relleno y alfa 0 / 255", () => {
    const data = new Uint8Array([0b01000000, 0b11000000]); // 2 x 2 -> filas de 1 byte
    const source = pixelSourceFor({ width: 2, height: 2, data }, { kind: "mask", fill: [200, 10, 30] })!;
    expect([...source.rows(0, 2)]).toEqual([200, 10, 30, 255, 200, 10, 30, 0, 200, 10, 30, 0, 200, 10, 30, 0]);
    expect(source.opaque).toBe(false);
  });

  it("datos incompletos (RGBA mas corto que lo declarado): lo que falta queda transparente, sin lanzar", () => {
    const data = new Uint8ClampedArray(2 * 4).fill(255); // solo 2 px de 4
    const source = pixelSourceFor({ width: 2, height: 2, kind: 3, data }, { kind: "image" })!;
    const rows = source.rows(0, 2);
    expect([...rows.subarray(0, 8)]).toEqual(new Array(8).fill(255));
    expect([...rows.subarray(8, 16)]).toEqual(new Array(8).fill(0));
  });

  it("sin datos, medidas invalidas o kind desconocido: no hay fuente", () => {
    expect(pixelSourceFor(null, { kind: "image" })).toBeNull();
    expect(pixelSourceFor({ width: 0, height: 5, kind: 3, data: new Uint8Array(0) }, { kind: "image" })).toBeNull();
    expect(pixelSourceFor({ width: 2, height: 2, kind: 9, data: new Uint8Array(16) }, { kind: "image" })).toBeNull();
    expect(pixelSourceFor({ width: 2, height: 2, kind: 3, data: null }, { kind: "image" })).toBeNull();
  });
});

describe("cropSource — casilla de un atlas", () => {
  const atlas = (): ReturnType<typeof pixelSourceFor> =>
    pixelSourceFor({ width: 6, height: 4, kind: 3, data: rgba(6, 4, (x, y) => [x, y, 0, 255]) }, { kind: "image" });

  it("lee solo su casilla", () => {
    const crop = cropSource(atlas()!, { x: 2, y: 1, w: 3, h: 2 })!;
    expect([crop.width, crop.height]).toEqual([3, 2]);
    const rows = crop.rows(0, 2);
    expect([...rows.subarray(0, 4)]).toEqual([2, 1, 0, 255]);
    expect([...rows.subarray(12, 16)]).toEqual([2, 2, 0, 255]);
  });

  it("una casilla fuera del atlas o con medidas invalidas no existe", () => {
    expect(cropSource(atlas()!, { x: 4, y: 0, w: 3, h: 1 })).toBeNull();
    expect(cropSource(atlas()!, { x: -1, y: 0, w: 2, h: 1 })).toBeNull();
    expect(cropSource(atlas()!, { x: 0, y: 0, w: 0, h: 1 })).toBeNull();
    expect(cropSource(atlas()!, { x: 0, y: 0, w: Number.NaN, h: 1 })).toBeNull();
  });
});

describe("analyzeSource — miniatura, alfa y huella", () => {
  it("una imagen pequena conserva sus medidas (no se agranda) y una grande se reduce a 256 px", async () => {
    expect(thumbSize(40, 20, 256)).toEqual({ width: 40, height: 20 });
    expect(thumbSize(1000, 500, 256)).toEqual({ width: 256, height: 128 });
    expect(thumbSize(1, 5000, 256)).toEqual({ width: 1, height: 256 });
    const big = pixelSourceFor({ width: 600, height: 300, kind: 3, data: rgba(600, 300, (x) => [x % 256, 0, 0, 255]) }, { kind: "image" })!;
    const analysis = await analyzeSource(big, 256, slicer());
    expect([analysis.thumb.width, analysis.thumb.height]).toEqual([256, 128]);
    expect([analysis.width, analysis.height]).toEqual([600, 300]);
  });

  it("el promedio de la miniatura es el de los pixeles de su celda", async () => {
    // 2 x 1: negro y blanco opacos -> miniatura de 2 x 1 igual; con 1 px de destino seria gris medio (no se pide aqui).
    const source = pixelSourceFor({ width: 2, height: 1, kind: 3, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) }, { kind: "image" })!;
    const { thumb } = await analyzeSource(source, 256, slicer());
    expect([...thumb.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    const reduced = pixelSourceFor({ width: 4, height: 1, kind: 3, data: new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]) }, { kind: "image" })!;
    const two = await analyzeSource(reduced, 2, slicer());
    expect([two.thumb.width, two.thumb.height]).toEqual([2, 1]);
    expect([...two.thumb.data]).toEqual([50, 50, 50, 255, 150, 150, 150, 255]);
  });

  it("el color se pondera por el alfa: un pixel transparente no tine la miniatura", async () => {
    const source = pixelSourceFor({ width: 2, height: 1, kind: 3, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0]) }, { kind: "image" })!;
    const { thumb } = await analyzeSource(source, 1, slicer());
    expect([...thumb.data]).toEqual([255, 0, 0, 128]);
  });

  it("mismas imagenes -> misma huella; un pixel distinto o otras medidas -> otra", async () => {
    const make = (w: number, h: number, tweak = false) =>
      pixelSourceFor({ width: w, height: h, kind: 3, data: rgba(w, h, (x, y) => [x * 7, y * 3, tweak && x === 1 && y === 1 ? 99 : 5, 255]) }, { kind: "image" })!;
    const a = await analyzeSource(make(8, 8), 256, slicer());
    const b = await analyzeSource(make(8, 8), 256, slicer());
    const c = await analyzeSource(make(8, 8, true), 256, slicer());
    const d = await analyzeSource(make(16, 4), 256, slicer());
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(c.hash).not.toBe(a.hash);
    expect(d.hash).not.toBe(a.hash);
  });

  it("complejidad: un grafico plano ~0 y un degradado de fotografia ~1", async () => {
    const flat = await analyzeSource(pixelSourceFor({ width: 64, height: 64, kind: 3, data: rgba(64, 64, () => [20, 20, 20, 255]) }, { kind: "image" })!, 256, slicer());
    const photo = await analyzeSource(pixelSourceFor({ width: 64, height: 64, kind: 3, data: rgba(64, 64, (x, y) => [x * 4, y * 4, (x * y) % 256, 255]) }, { kind: "image" })!, 256, slicer());
    expect(flat.complexity).toBeLessThan(0.01);
    expect(photo.complexity).toBeGreaterThan(0.2);
  });

  it("cede el hilo entre bandas (una imagen de varios millones de pixeles no es una sola tarea)", async () => {
    const yields = vi.spyOn(globalThis, "setTimeout");
    const w = 2000;
    const h = 1500; // 3 MP -> 3 bandas
    const source = pixelSourceFor({ width: w, height: h, kind: 3, data: new Uint8ClampedArray(w * h * 4) }, { kind: "image" })!;
    let ticks = 0;
    const counting = new Slicer();
    const original = counting.tick.bind(counting);
    counting.tick = async () => {
      ticks += 1;
      await original();
    };
    await analyzeSource(source, 256, counting);
    expect(ticks).toBeGreaterThanOrEqual(3);
    yields.mockRestore();
  });

  it("se cancela entre bandas con AbortError", async () => {
    const controller = new AbortController();
    const w = 2000;
    const h = 1500;
    const source = pixelSourceFor({ width: w, height: h, kind: 3, data: new Uint8ClampedArray(w * h * 4) }, { kind: "image" })!;
    controller.abort();
    await expect(analyzeSource(source, 256, new Slicer(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(isAbortError(abortError())).toBe(true);
    expect(isAbortError(new Error("otro"))).toBe(false);
  });
});

describe("Slicer — ceder el hilo", () => {
  it("tras mas de 24 ms de trabajo cede de verdad: una tarea ya en cola corre ANTES de seguir", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const order: string[] = [];
      const slicer = new Slicer();
      setTimeout(() => order.push("temporizador"), 0);
      clock = 30;
      await slicer.tick();
      order.push("despues");
      expect(order).toEqual(["temporizador", "despues"]);
    } finally {
      now.mockRestore();
    }
  });

  it("con menos de 24 ms no cede (no se frena un trabajo corto)", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const order: string[] = [];
      const slicer = new Slicer();
      setTimeout(() => order.push("temporizador"), 0);
      clock = 10;
      await slicer.tick();
      order.push("despues");
      expect(order).toEqual(["despues"]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      now.mockRestore();
    }
  });

  it("comprueba la cancelacion en cada tick, incluso sin ceder", async () => {
    const controller = new AbortController();
    const slicer = new Slicer(controller.signal);
    await slicer.tick();
    controller.abort();
    await expect(slicer.tick()).rejects.toMatchObject({ name: "AbortError" });
    expect(() => slicer.throwIfAborted()).toThrow();
  });
});

describe("limite de canvas de Safari (16 777 216 px)", () => {
  it("una imagen mayor que el limite NO se dibuja en un canvas (saldria en blanco): `jpg` avisa", async () => {
    expect(MAX_CANVAS_PIXELS).toBeLessThan(16_777_216);
    const side = 4100; // 16,81 MP; los datos vacios se leen como transparentes sin reservar la imagen entera
    const source = pixelSourceFor({ width: side, height: side, kind: 3, data: new Uint8ClampedArray(4) }, { kind: "image" })!;
    await expect(encodeSourceAsJpeg(source, slicer())).rejects.toThrow("canvas-unavailable");
  });
});

describe("estimatePngBytes", () => {
  it("crece con los pixeles, con el alfa y con la complejidad", () => {
    const flat = estimatePngBytes(100, 100, false, 0);
    const photo = estimatePngBytes(100, 100, false, 1);
    expect(photo).toBeGreaterThan(flat * 3);
    expect(estimatePngBytes(100, 100, true, 0.5)).toBeGreaterThan(estimatePngBytes(100, 100, false, 0.5));
    expect(estimatePngBytes(200, 200, false, 0.5)).toBeGreaterThan(estimatePngBytes(100, 100, false, 0.5) * 3);
    expect(estimatePngBytes(1, 1, false, 0)).toBeGreaterThanOrEqual(70);
  });
});

describe("encodeSourceAsPng / readAllPixels", () => {
  it("PNG con alfa: los pixeles vuelven iguales (sin tocar el color bajo un alfa parcial)", async () => {
    const data = rgba(5, 4, (x, y) => [x * 40, 255 - y * 40, 17, x === 0 ? 0 : x * 50]);
    const source = pixelSourceFor({ width: 5, height: 4, kind: 3, data }, { kind: "image" })!;
    const png = decodePng(await blobBytes(await encodeSourceAsPng(source, slicer())));
    expect([png.width, png.height]).toEqual([5, 4]);
    // Bajo alfa 0 el codificador conserva el color: el motor no lo borra.
    expect([...png.data]).toEqual([...data]);
  });

  it("readAllPixels(flatten) aplana el alfa sobre blanco", async () => {
    const source = pixelSourceFor({ width: 2, height: 1, kind: 3, data: new Uint8ClampedArray([0, 0, 0, 128, 10, 20, 30, 255]) }, { kind: "image" })!;
    const flat = await readAllPixels(source, slicer(), true);
    expect([...flat]).toEqual([127, 127, 127, 255, 10, 20, 30, 255]);
  });
});

describe("fuente con ImageBitmap (navegador) simulada con un canvas de mentira", () => {
  const original = { OffscreenCanvas: (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas };
  afterEach(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = original.OffscreenCanvas;
  });

  /** Un `OffscreenCanvas` que "dibuja" el pixel RGBA que lleva el bitmap falso. */
  function installFakeCanvas(): { created: number } {
    const stats = { created: 0 };
    class FakeCanvas {
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.pixels = new Uint8ClampedArray(width * height * 4);
        stats.created += 1;
      }
      getContext(): unknown {
        const canvas: { width: number; pixels: Uint8ClampedArray } = { width: this.width, pixels: this.pixels };
        return {
          clearRect: () => canvas.pixels.fill(0),
          // drawImage(bitmap, dx, dy) o drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh).
          drawImage: (bitmap: { data: Uint8ClampedArray; width?: number }, ...a: number[]) => {
            const w = canvas.width;
            if (a.length === 2) {
              canvas.pixels.set(bitmap.data.subarray(0, canvas.pixels.length));
              return;
            }
            const [, sy, , sh, , dy] = a;
            for (let r = 0; r < sh; r += 1) canvas.pixels.set(bitmap.data.subarray((sy + r) * w * 4, (sy + r + 1) * w * 4), (dy + r) * w * 4);
          },
          getImageData: (x: number, y: number, w: number, h: number) => ({ data: canvas.pixels.slice(y * canvas.width * 4, (y + h) * canvas.width * 4) }),
        };
      }
      convertToBlob(): Promise<Blob> {
        return Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
      }
    }
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeCanvas;
    return stats;
  }

  it("lee el bitmap por bandas a traves del canvas", () => {
    installFakeCanvas();
    const data = rgba(3, 2, (x, y) => [x, y, 9, 200]);
    const source = pixelSourceFor({ width: 3, height: 2, bitmap: { data } }, { kind: "image" })!;
    expect([...source.rows(1, 2)]).toEqual([...data.subarray(12, 24)]);
    source.close();
  });

  it("lee por BANDAS: el canvas de lectura tiene la altura de la banda, no la de la imagen", () => {
    const stats = installFakeCanvas();
    const data = rgba(3, 10, (x, y) => [x, y, 1, 255]);
    const source = pixelSourceFor({ width: 3, height: 10, bitmap: { data } }, { kind: "image" })!;
    const first = source.rows(0, 4);
    const second = source.rows(4, 8);
    expect([...first]).toEqual([...data.subarray(0, 48)]);
    expect([...second]).toEqual([...data.subarray(48, 96)]);
    const last = source.rows(8, 10);
    expect([...last]).toEqual([...data.subarray(96, 120)]);
    // Un solo canvas de lectura (de 4 filas), reutilizado en todas las bandas.
    expect(stats.created).toBe(1);
  });

  it("una mascara en bitmap recibe el color de relleno y conserva su alfa", () => {
    installFakeCanvas();
    const data = rgba(2, 1, (x) => [0, 0, 0, x === 0 ? 255 : 0]);
    const source = pixelSourceFor({ width: 2, height: 1, bitmap: { data } }, { kind: "mask", fill: [9, 8, 7] })!;
    expect([...source.rows(0, 1)]).toEqual([9, 8, 7, 255, 9, 8, 7, 0]);
  });

  it("el PNG de un bitmap se pide al canvas nativo (sin copiar los pixeles a JS)", async () => {
    installFakeCanvas();
    const source = pixelSourceFor({ width: 2, height: 1, bitmap: { data: rgba(2, 1, () => [1, 2, 3, 255]) } }, { kind: "image" })!;
    const blob = await encodeSourceAsPng(source, slicer());
    expect([...(await blobBytes(blob))]).toEqual([137, 80, 78, 71]);
  });

  it("cerrar la fuente NO cierra el ImageBitmap de pdf.js (lo libera page.cleanup)", () => {
    installFakeCanvas();
    const close = vi.fn();
    const source = pixelSourceFor({ width: 1, height: 1, bitmap: { data: rgba(1, 1, () => [0, 0, 0, 255]), close } }, { kind: "image" })!;
    source.rows(0, 1);
    source.close();
    expect(close).not.toHaveBeenCalled();
  });
});
