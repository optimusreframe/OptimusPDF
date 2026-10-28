import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setScanicImporterForTests } from "@/lib/scan/documentDetection";
import { findDocumentCorners } from "@/lib/scan/findCorners";
import type { Rgba } from "@/lib/scan/pixels";

/** Hoja con texto (220 x 260) sobre un escritorio oscuro, en una imagen de 400 x 300. */
function desk(): Rgba {
  const width = 400;
  const height = 300;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= 90 && x < 310 && y >= 20 && y < 280;
      let color = inside ? [236, 232, 224] : [55, 52, 60];
      if (inside && (y - 20) % 14 >= 5 && (y - 20) % 14 < 8 && x > 102 && x < 298 && (x - 90) % 9 < 6) color = [25, 25, 30];
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

const sheetCorners = { topLeft: { x: 90, y: 20 }, topRight: { x: 310, y: 20 }, bottomRight: { x: 310, y: 280 }, bottomLeft: { x: 90, y: 280 } };

describe("buscar el documento de una copia reducida — src/lib/scan/findCorners.ts", () => {
  beforeEach(() => {
    // El entorno de motores es Node: sin `ImageData` del DOM.
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    );
  });
  afterEach(() => {
    __setScanicImporterForTests(null);
    vi.unstubAllGlobals();
  });

  it("con scanic acertando devuelve el recorte de la hoja y cede el hilo DOS veces (tras el detector y antes de ajustar los lados)", async () => {
    __setScanicImporterForTests(async () => ({ scanDocument: async () => ({ success: true, confidence: 0.9, corners: sheetCorners }) }) as never);
    const yields = vi.fn();
    const quad = await findDocumentCorners(desk(), "document", yields);
    expect(yields).toHaveBeenCalledTimes(2);
    expect(quad).not.toBeNull();
    // La hoja, con los lados empujados como mucho unos pixeles hacia fuera.
    expect(quad!.topLeft.x).toBeLessThanOrEqual(90 / 400);
    expect(quad!.topLeft.x).toBeGreaterThan(80 / 400);
    expect(quad!.bottomRight.y).toBeGreaterThanOrEqual(280 / 300 - 0.001);
  });

  it("si la puerta rechaza el candidato devuelve null y NO llega a la segunda cesion", async () => {
    // Un cuadrilatero sobre un fondo liso no tiene bordes reales (y el detector ligero tampoco ve hoja).
    __setScanicImporterForTests(
      async () =>
        ({ scanDocument: async () => ({ success: true, confidence: 0.9, corners: { topLeft: { x: 4, y: 4 }, topRight: { x: 70, y: 4 }, bottomRight: { x: 70, y: 60 }, bottomLeft: { x: 4, y: 60 } } }) }) as never,
    );
    const yields = vi.fn();
    const flat = { data: new Uint8ClampedArray(400 * 300 * 4).fill(60), width: 400, height: 300 };
    expect(await findDocumentCorners(flat, "document", yields)).toBeNull();
    expect(yields).toHaveBeenCalledTimes(1);
  });

  it("el detector recibe una COPIA: aunque la modifique, la imagen decodificada (que reutiliza el render) queda intacta", async () => {
    __setScanicImporterForTests(
      async () =>
        ({
          scanDocument: async (source: { data: Uint8ClampedArray }) => {
            source.data.fill(0);
            return { success: false };
          },
        }) as never,
    );
    const image = desk();
    const before = Uint8ClampedArray.from(image.data);
    await findDocumentCorners(image, "document");
    expect(Array.from(image.data)).toEqual(Array.from(before));
  });

  it("un fallo del detector (sin conexion al pedir su chunk) no rompe: sin documento, o el detector ligero si lo ve", async () => {
    __setScanicImporterForTests(async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    const flat = { data: new Uint8ClampedArray(200 * 150 * 4).fill(128), width: 200, height: 150 };
    await expect(findDocumentCorners(flat, "document")).resolves.toBeNull();
  });

  it("el modo foto nunca recorta", async () => {
    __setScanicImporterForTests(async () => ({ scanDocument: async () => ({ success: true, confidence: 0.9, corners: sheetCorners }) }) as never);
    expect(await findDocumentCorners(desk(), "photo")).toBeNull();
  });
});
