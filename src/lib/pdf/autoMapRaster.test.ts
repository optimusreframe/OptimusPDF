import { describe, expect, it } from "vitest";
import { RASTER_MAX_LINE_FRACTION, RASTER_MIN_LINE_FRACTION, detectRasterLines, longestRuns } from "@/lib/pdf/autoMapRaster";

const W = 400;
const H = 500;

/** Pagina blanca RGBA con rayas negras (x0..x1 y y en pixeles; `rows` filas de grosor). */
function scan(lines: Array<{ x0: number; x1: number; y: number; rows?: number }>, noise = false) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const paint = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  };
  for (const l of lines) for (let r = 0; r < (l.rows ?? 2); r += 1) for (let x = l.x0; x < l.x1; x += 1) paint(x, l.y + r);
  if (noise) for (let i = 0; i < 400; i += 1) paint((i * 37) % W, (i * 91) % H);
  return { data, width: W, height: H };
}

describe("detectRasterLines", () => {
  it("encuentra una raya larga y fina", () => {
    const lines = detectRasterLines(scan([{ x0: 40, x1: 240, y: 300 }]));
    expect(lines).toHaveLength(1);
    expect(lines[0].x0).toBeCloseTo(0.1, 2);
    expect(lines[0].x1).toBeCloseTo(0.6, 2);
    expect(lines[0].y).toBeCloseTo(301 / H, 2);
  });

  it("ignora una raya mas corta que el minimo y una mas larga que el maximo", () => {
    // 400 px de ancho: minimo 64 px (16 %), maximo 280 px (70 %)
    expect(detectRasterLines(scan([{ x0: 40, x1: 40 + 56, y: 300 }]))).toHaveLength(0);
    expect(detectRasterLines(scan([{ x0: 40, x1: 40 + 72, y: 300 }]))).toHaveLength(1);
    expect(detectRasterLines(scan([{ x0: 40, x1: 40 + 270, y: 300 }]))).toHaveLength(1);
    expect(detectRasterLines(scan([{ x0: 10, x1: 10 + 290, y: 300 }]))).toHaveLength(0);
    expect(RASTER_MIN_LINE_FRACTION).toBe(0.16);
    expect(RASTER_MAX_LINE_FRACTION).toBe(0.7);
  });

  it("ignora una barra gruesa (no es una raya)", () => {
    expect(detectRasterLines(scan([{ x0: 40, x1: 240, y: 300, rows: 20 }]))).toHaveLength(0);
  });

  it("tolera un huecos pequenos de ruido dentro de la raya", () => {
    const page = scan([{ x0: 40, x1: 240, y: 300, rows: 2 }]);
    for (const y of [300, 301]) for (const x of [100, 101]) page.data[(y * W + x) * 4] = 255;
    expect(detectRasterLines(page)).toHaveLength(1);
  });

  it("varias rayas, de arriba abajo", () => {
    const lines = detectRasterLines(scan([{ x0: 40, x1: 200, y: 200 }, { x0: 40, x1: 220, y: 320 }, { x0: 100, x1: 260, y: 420 }]));
    expect(lines).toHaveLength(3);
    expect(lines[0].y).toBeLessThan(lines[lines.length - 1].y);
  });

  it("una pagina en blanco o con puntos sueltos no da rayas", () => {
    expect(detectRasterLines(scan([]))).toHaveLength(0);
    expect(detectRasterLines(scan([], true))).toHaveLength(0);
    expect(detectRasterLines({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toHaveLength(0);
  });

  it("racha mas larga por fila", () => {
    const luminance = new Float32Array(10 * 2).fill(255);
    for (let x = 2; x < 8; x += 1) luminance[x] = 0;
    const runs = longestRuns(luminance, 10, 2);
    expect(runs[0]).toEqual({ length: 6, start: 2 });
    expect(runs[1].length).toBe(0);
  });
});
