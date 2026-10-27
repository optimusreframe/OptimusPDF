import { describe, expect, it } from "vitest";
import { boxBlur, cropRgba, downscaleGray, downscaleRgba, fitSide, histogram256, lumaOf, otsuThreshold, percentileOf, rotateGray, rotateRgba, toGray, type Rgba } from "@/lib/scan/pixels";

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

describe("pixels — src/lib/scan/pixels.ts", () => {
  it("lumaOf pesa verde > rojo > azul y respeta los extremos", () => {
    expect(lumaOf(0, 0, 0)).toBe(0);
    expect(lumaOf(255, 255, 255)).toBe(255);
    expect(lumaOf(0, 255, 0)).toBeGreaterThan(lumaOf(255, 0, 0));
    expect(lumaOf(255, 0, 0)).toBeGreaterThan(lumaOf(0, 0, 255));
  });

  it("fitSide nunca amplia y conserva la proporcion al reducir", () => {
    expect(fitSide(100, 50, 200)).toEqual({ width: 100, height: 50, scale: 1 });
    expect(fitSide(4000, 2000, 1000)).toEqual({ width: 1000, height: 500, scale: 0.25 });
  });

  it("downscaleRgba promedia bloques y devuelve la misma imagen si ya cabe", () => {
    const checker = image(4, 4, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]));
    expect(downscaleRgba(checker, 8)).toBe(checker);
    const small = downscaleRgba(checker, 2);
    expect(small.width).toBe(2);
    expect(small.height).toBe(2);
    // Cada celda de 2x2 mezcla dos blancos y dos negros: gris medio.
    expect(Array.from(small.data.slice(0, 3)).every((v) => Math.abs(v - 127.5) < 1)).toBe(true);
  });

  it("downscaleGray promedia y conserva el alto relativo", () => {
    const gray = toGray(image(8, 4, (x) => (x < 4 ? [200, 200, 200] : [100, 100, 100])));
    const small = downscaleGray(gray, 4);
    expect([small.width, small.height]).toEqual([4, 2]);
    expect(small.data[0]).toBe(200);
    expect(small.data[3]).toBe(100);
  });

  it("boxBlur de una imagen plana la deja plana y suaviza un impulso conservando la masa", () => {
    const flat = new Float32Array(25).fill(50);
    expect(Array.from(boxBlur(flat, 5, 5, 1)).every((v) => Math.abs(v - 50) < 1e-4)).toBe(true);
    const impulse = new Float32Array(25);
    impulse[12] = 90;
    const blurred = boxBlur(impulse, 5, 5, 1);
    expect(blurred[12]).toBeCloseTo(10, 3);
    expect(blurred.reduce((s, v) => s + v, 0)).toBeCloseTo(90, 2);
  });

  it("otsuThreshold separa dos poblaciones y percentileOf da los extremos", () => {
    const hist = new Uint32Array(256);
    hist[40] = 500;
    hist[210] = 500;
    const t = otsuThreshold(hist);
    expect(t).toBeGreaterThanOrEqual(40);
    expect(t).toBeLessThan(210);
    expect(percentileOf(hist, 0.1)).toBe(40);
    expect(percentileOf(hist, 0.9)).toBe(210);
    expect(otsuThreshold(new Uint32Array(256))).toBe(128);
    expect(histogram256(new Uint8Array([1, 1, 2]))[1]).toBe(2);
  });

  it("rotateRgba gira en sentido horario y cuatro vueltas devuelven el original", () => {
    const src = image(3, 2, (x, y) => [x * 10 + y, 0, 0]);
    const once = rotateRgba(src, 1);
    expect([once.width, once.height]).toEqual([2, 3]);
    // (x=0,y=0) va a la esquina superior derecha; (2,0) a la inferior derecha.
    expect(once.data[(0 * 2 + 1) * 4]).toBe(0);
    expect(once.data[(2 * 2 + 1) * 4]).toBe(20);
    const four = rotateRgba(rotateRgba(rotateRgba(rotateRgba(src, 1), 1), 1), 1);
    expect(Array.from(four.data)).toEqual(Array.from(src.data));
    expect(rotateRgba(src, 0)).toBe(src);
    expect(rotateRgba(src, -1).width).toBe(2);
    const g = toGray(src);
    expect(rotateGray(g, 2).data[0]).toBe(g.data[5]);
  });

  it("cropRgba acota el recorte a la imagen", () => {
    const src = image(4, 4, (x, y) => [x, y, 0]);
    const crop = cropRgba(src, 2, 2, 10, 10);
    expect([crop.width, crop.height]).toEqual([2, 2]);
    expect(crop.data[0]).toBe(2);
    expect(crop.data[1]).toBe(2);
  });
});
