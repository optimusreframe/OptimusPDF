import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_TRUST_CONFIDENCE, MAX_TRUSTED_QUAD_AREA, __setScanicImporterForTests, chooseCorners, detectDocumentCorners, edgeSupport } from "@/lib/scan/documentDetection";
import type { QuadCorners } from "@/lib/scan/perspective";

const rect = (x0: number, y0: number, x1: number, y1: number): QuadCorners => ({ topLeft: { x: x0, y: y0 }, topRight: { x: x1, y: y0 }, bottomRight: { x: x1, y: y1 }, bottomLeft: { x: x0, y: y1 } });

/** Imagen 200 x 200: fondo oscuro y una hoja clara en (40..160) x (40..160). */
function scene(): { data: Uint8ClampedArray; width: number; height: number } {
  const width = 200;
  const height = 200;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(x >= 40 && x < 160 && y >= 40 && y < 160 ? [240, 238, 230, 255] : [50, 52, 60, 255], (y * width + x) * 4);
  return { data, width, height };
}

describe("elegir el cuadrilatero del documento — src/lib/scan/documentDetection.ts", () => {
  const truth = rect(0.2, 0.2, 0.8, 0.8);

  it("el contorno real tiene casi todos sus lados apoyados en un salto de color; uno sobre el fondo liso, no", () => {
    const image = scene();
    expect(edgeSupport(image, truth)).toBeGreaterThan(0.95);
    expect(edgeSupport(image, rect(0.05, 0.05, 0.15, 0.95))).toBeLessThan(0.3);
    // Tolera un contorno desplazado unos pixeles (los detectores no clavan el borde).
    expect(edgeSupport(image, rect(0.215, 0.215, 0.785, 0.785))).toBeGreaterThan(0.9);
  });

  it("sin cuadrilatero de ninguno -> null; si solo hay uno, ese", () => {
    expect(chooseCorners(null, null)).toBeNull();
    expect(chooseCorners(truth, null)).toBe(truth);
    expect(chooseCorners(null, truth)).toBe(truth);
  });

  it("un cuadrilatero que ocupa casi todo el encuadre (o la imagen entera) no se acepta: equivale a «sin documento»", () => {
    expect(MAX_TRUSTED_QUAD_AREA).toBeLessThan(1);
    expect(chooseCorners(rect(0.02, 0.02, 0.98, 0.98), null)).toBeNull();
    expect(chooseCorners(rect(0, 0, 1, 1), truth)).toBe(truth);
    // Degenerado (cruzado) tampoco.
    const crossed: QuadCorners = { topLeft: { x: 0.2, y: 0.2 }, topRight: { x: 0.8, y: 0.8 }, bottomRight: { x: 0.8, y: 0.2 }, bottomLeft: { x: 0.2, y: 0.8 } };
    expect(chooseCorners(crossed, null)).toBeNull();
  });

  it("si coinciden (IoU >= 0,85) gana scanic, el preciso", () => {
    const scanic = rect(0.2, 0.2, 0.8, 0.8);
    const live = rect(0.21, 0.21, 0.79, 0.79);
    expect(chooseCorners(scanic, live, scene(), 1)).toBe(scanic);
  });

  it("si discrepan gana el que tiene mas apoyo de borde en la imagen", () => {
    const image = scene();
    const wrong = rect(0.3, 0.05, 0.95, 0.4);
    expect(chooseCorners(wrong, truth, image, 0.5)).toBe(truth);
    expect(chooseCorners(truth, wrong, image, 1)).toBe(truth);
  });

  it("con apoyo parecido el ligero desempata solo si esta MUY seguro; si no, scanic", () => {
    const a = rect(0.1, 0.1, 0.5, 0.5);
    const b = rect(0.5, 0.5, 0.9, 0.9);
    const flat = { data: new Uint8ClampedArray(200 * 200 * 4).fill(128), width: 200, height: 200 };
    expect(chooseCorners(a, b, flat, LIVE_TRUST_CONFIDENCE)).toBe(b);
    expect(chooseCorners(a, b, flat, LIVE_TRUST_CONFIDENCE - 0.01)).toBe(a);
    // Sin imagen para medir el apoyo se decide solo por la confianza.
    expect(chooseCorners(a, b, undefined, 0.99)).toBe(b);
    expect(chooseCorners(a, b)).toBe(a);
  });
});

describe("carga de scanic sin conexion — src/lib/scan/documentDetection.ts", () => {
  afterEach(() => __setScanicImporterForTests(null));

  const image = { data: new Uint8ClampedArray(40 * 40 * 4), width: 40, height: 40 } as unknown as ImageData;

  it("un fallo al cargar el modulo (sin conexion) devuelve null, NO se guarda el rechazo y la siguiente captura lo reintenta", async () => {
    let calls = 0;
    const scanDocument = vi.fn(async () => ({
      success: true,
      confidence: 0.9,
      corners: { topLeft: { x: 4, y: 4 }, topRight: { x: 30, y: 4 }, bottomRight: { x: 30, y: 30 }, bottomLeft: { x: 4, y: 30 } },
    }));
    __setScanicImporterForTests(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module");
      return { scanDocument } as never;
    });
    expect(await detectDocumentCorners(image)).toBeNull();
    expect(calls).toBe(1);
    const second = await detectDocumentCorners(image);
    expect(calls).toBe(2);
    expect(second?.corners.topLeft.x).toBeCloseTo(4 / 40, 6);
    // Ya cargado: no se vuelve a pedir.
    await detectDocumentCorners(image);
    expect(calls).toBe(2);
  });
});
