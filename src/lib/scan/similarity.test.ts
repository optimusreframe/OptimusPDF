import { describe, expect, it } from "vitest";
import { areDuplicates, areDuplicatesYielding, comparePages, comparePagesBothWays, computeSignature, dHashOf, hamming } from "@/lib/scan/similarity";
import type { Rgba } from "@/lib/scan/pixels";

/** Pagina de texto sintetica: lineas de «palabras» cuya distribucion depende de la semilla. */
function sheet(seed: number, options: { shiftX?: number; shiftY?: number; noise?: number; width?: number; height?: number } = {}): Rgba {
  const width = options.width ?? 420;
  const height = options.height ?? 560;
  const data = new Uint8ClampedArray(width * height * 4).fill(240);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  let s = seed * 7919 + 13;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const set = (x: number, y: number, v: number) => {
    const px = Math.round(x + (options.shiftX ?? 0));
    const py = Math.round(y + (options.shiftY ?? 0));
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    data.set([v, v, v], (py * width + px) * 4);
  };
  for (let top = 40; top < height - 50; top += 24) {
    let x = 30;
    while (x < width - 50) {
      const word = 14 + Math.floor(rand() * 46);
      for (let dx = 0; dx < word; dx += 1) for (let dy = 0; dy < 8; dy += 1) set(x + dx, top + dy, 25);
      x += word + 8;
    }
  }
  if (options.noise) {
    for (let i = 0; i < width * height; i += 1) {
      const n = (rand() - 0.5) * options.noise;
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.max(0, Math.min(255, data[i * 4] + n));
    }
  }
  return { data, width, height };
}

describe("similitud de paginas — src/lib/scan/similarity.ts", () => {
  it("dHash: identico para la misma pagina, distancia pequena con ruido y mayor con otra pagina", () => {
    const a = dHashOf(sheet(1));
    expect(hamming(a, dHashOf(sheet(1)))).toBe(0);
    expect(hamming(a, dHashOf(sheet(1, { noise: 6 })))).toBeLessThanOrEqual(8);
    expect(hamming(a, a)).toBe(0);
    expect(hamming(new Uint32Array([0xffffffff, 0]), new Uint32Array([0, 0]))).toBe(32);
  });

  it("la misma hoja capturada dos veces (desplazada unos pixeles y con ruido) es repetida", () => {
    const a = computeSignature(sheet(1));
    const b = computeSignature(sheet(1, { shiftX: 3, shiftY: -2, noise: 8 }));
    expect(areDuplicates(a, b)).toBe(true);
    expect(areDuplicates(b, a)).toBe(true);
    expect(areDuplicates(a, a)).toBe(true);
  });

  it("dos paginas DISTINTAS con la misma maqueta (mismos margenes y lineas) NO son repetidas", () => {
    expect(areDuplicates(computeSignature(sheet(1)), computeSignature(sheet(2)))).toBe(false);
    expect(areDuplicates(computeSignature(sheet(3)), computeSignature(sheet(4, { shiftX: 2 })))).toBe(false);
  });

  it("las hojas en blanco nunca se marcan como repetidas (tienen su propio aviso)", () => {
    const blank = (): Rgba => ({ data: new Uint8ClampedArray(420 * 560 * 4).fill(240), width: 420, height: 560 });
    const a = computeSignature(blank());
    expect(a.blank).toBe(true);
    expect(areDuplicates(a, computeSignature(blank()))).toBe(false);
  });

  it("proporciones muy distintas no se comparan", () => {
    expect(areDuplicates(computeSignature(sheet(1)), computeSignature(sheet(1, { width: 420, height: 300 })))).toBe(false);
  });

  it("comparePages da todos los bloques con tinta y una fraccion cercana a 1 para la misma hoja", () => {
    const a = computeSignature(sheet(5));
    const same = comparePages(a, computeSignature(sheet(5, { shiftX: 2 })));
    expect(same.considered).toBeGreaterThan(30);
    expect(same.fraction).toBeGreaterThan(0.9);
    expect(same.explained).toBeGreaterThan(0.95);
    const other = comparePages(a, computeSignature(sheet(6)));
    // Barras solidas por «palabra»: dos paginas distintas siguen coincidiendo en parte, pero claramente menos.
    expect(other.fraction).toBeLessThan(same.fraction - 0.1);
    expect(other.explained).toBeLessThan(same.explained - 0.05);
    expect(other.bad).toBeGreaterThan(same.bad);
    // Los dos sentidos: el peor de ambos.
    const both = comparePagesBothWays(a, computeSignature(sheet(5, { shiftX: 2 })));
    expect(both.explained).toBeGreaterThan(0.95);
    expect(comparePagesBothWays(a, computeSignature(sheet(6))).explained).toBeLessThan(0.9);
  });

  it("la firma es serializable (sin la dilatacion, que se calcula al comparar) y tiene el tamano canonico", () => {
    const sig = computeSignature(sheet(1));
    expect(sig.dilated).toBeUndefined();
    expect(sig.ink.length).toBe(384 * 512);
    expect(sig.inkCount).toBeGreaterThan(1000);
    expect(JSON.parse(JSON.stringify({ aspect: sig.aspect, blank: sig.blank })).blank).toBe(false);
  });
});

describe("comparacion que reparte el trabajo — areDuplicatesYielding", () => {
  it("da el MISMO resultado que areDuplicates (repetidas, distintas y con desplazamiento) y cede el hilo muchas veces (cada pocos miles de operaciones)", async () => {
    const pairs: Array<[Rgba, Rgba]> = [
      [sheet(1), sheet(1, { shiftX: 3, shiftY: 2, noise: 6 })],
      [sheet(2), sheet(3)],
      [sheet(4), sheet(4)],
      [sheet(5), sheet(6, { shiftX: 2 })],
    ];
    let pauses = 0;
    for (const [left, right] of pairs) {
      const a = computeSignature(left);
      const b = computeSignature(right);
      expect(await areDuplicatesYielding(a, b, async () => { pauses += 1; })).toBe(areDuplicates(a, b));
    }
    // Una pareja parecida pasa por decenas de bloques y cada bloque cede varias veces: nunca es UNA sola tarea larga.
    expect(pauses).toBeGreaterThan(100);
  });

  it("si no hay nada que comparar (en blanco, otro formato) no cede ni una vez", async () => {
    const blank = computeSignature({ data: new Uint8ClampedArray(420 * 560 * 4).fill(255), width: 420, height: 560 });
    let pauses = 0;
    expect(await areDuplicatesYielding(blank, computeSignature(sheet(1)), async () => { pauses += 1; })).toBe(false);
    expect(pauses).toBe(0);
  });
});
