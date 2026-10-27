import { describe, expect, it } from "vitest";
import { blendKeepRule, estimateScanSize } from "@/lib/scan/estimate";
import type { ScanPage } from "@/lib/scan/types";

/**
 * La estimacion respeta la regla del 15 % de `prepareForPdf` (recodificar solo si ahorra >= 15 %): con un ahorro previsto cerca
 * del umbral el resultado real depende del codificador del navegador, asi que se estima el valor esperado (ni el extremo
 * optimista ni el original entero); con un ahorro claro (Equilibrada, Compacta) se estima la recodificacion.
 */

const BYTES = 3_000_000;

function photo(): ScanPage {
  return {
    id: "p-est-1-aaaa",
    createdAt: "2026-10-26T14:32:00.000Z",
    source: "library",
    original: { size: BYTES, type: "image/jpeg" } as unknown as Blob,
    originalWidth: 4000,
    originalHeight: 3000,
    corners: null,
    rotation: 0,
    filter: "original",
    adjust: { brightness: 0, contrast: 0 },
    processed: null,
    thumb: null,
    flags: {},
    mode: "photo",
  } as unknown as ScanPage;
}

const bytes = (preset: string) => estimateScanSize([photo()], { preset, searchable: false }).bytes - 2048;

describe("estimacion de peso — regla del 15 % (src/lib/scan/estimate.ts)", () => {
  it("Original: el archivo tal cual", () => {
    expect(bytes("original")).toBe(BYTES);
  });

  it("Alta (ahorro previsto cerca del umbral): entre lo recodificado y el original, nunca el extremo optimista", () => {
    const high = bytes("high");
    expect(high).toBeGreaterThan(BYTES * 0.88);
    expect(high).toBeLessThan(BYTES * 0.98);
  });

  it("Equilibrada y Compacta (ahorro claro): se estima la recodificacion, y el orden es honesto", () => {
    expect(bytes("balanced")).toBeLessThan(BYTES * 0.7);
    expect(bytes("compact")).toBeLessThan(bytes("balanced"));
    expect(bytes("high")).toBeLessThan(bytes("original"));
  });

  it("blendKeepRule: ahorro claro = lo recodificado, sin ahorro = el original, cerca del umbral del 15 % = un punto intermedio", () => {
    expect(blendKeepRule(1000, 600)).toBe(600);
    expect(blendKeepRule(1000, 1000)).toBe(1000);
    expect(blendKeepRule(1000, 1200)).toBe(1000);
    // Con ahorro de solo ~5 % (muy por encima del umbral) se conserva el original, no se mezcla.
    expect(blendKeepRule(1000, 950)).toBe(1000);
    expect(blendKeepRule(1000, 950, { below: 0.04, above: 0.04 })).toBe(1000);
    const near = blendKeepRule(1000, 850);
    expect(near).toBeGreaterThan(850);
    expect(near).toBeLessThan(1000);
  });
});

/**
 * Paginas PROCESADAS (filtro documento, recortadas): se estima con el peso medido a la calidad de CADA preset en los parches de la
 * propia pagina. En un texto casi digital (muy poco que ahorrar) Equilibrada pesa lo mismo que Original, y la estimacion lo dice.
 */
describe("estimacion de paginas procesadas con muestra — src/lib/scan/estimate.ts", () => {
  const processed = (qualityRatio: Record<string, number>, bytesPerPixel = 0.3): ScanPage =>
    ({
      id: "p-est-2-aaaa",
      createdAt: "2026-10-26T14:32:00.000Z",
      source: "library",
      original: { size: 5_000_000, type: "image/jpeg" } as unknown as Blob,
      originalWidth: 3000,
      originalHeight: 2000,
      corners: { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.1 }, bottomRight: { x: 0.9, y: 0.9 }, bottomLeft: { x: 0.1, y: 0.9 } },
      rotation: 0,
      filter: "enhance",
      resolvedFilter: "enhance",
      adjust: { brightness: 0, contrast: 0 },
      processed: null,
      thumb: null,
      flags: {},
      mode: "document",
      jpegSample: { side: 128, bytesPerPixel, qualityRatio },
    }) as unknown as ScanPage;
  const total = (page: ScanPage, preset: string) => estimateScanSize([page], { preset, searchable: false }).bytes - 2048;

  it("texto casi digital: re-codificar apenas ahorra, asi que Equilibrada y Alta pesan como Original; Compacta si baja", () => {
    const page = processed({ "0.92": 1.1, "0.87": 0.93, "0.8": 0.7 });
    const original = total(page, "original");
    expect(total(page, "high")).toBe(original);
    expect(total(page, "balanced")).toBeGreaterThan(original * 0.97);
    expect(total(page, "compact")).toBeLessThan(original * 0.85);
  });

  it("una pagina que ya pesa poco por pixel se conserva si ya cabe en el preset (regla «ya es pequena» de prepareForPdf)", () => {
    const light = processed({ "0.92": 1.1, "0.87": 0.6, "0.8": 0.4 }, 0.05);
    expect(total(light, "balanced")).toBe(total(light, "original"));
    expect(total(light, "high")).toBe(total(light, "original"));
  });

  it("foto detallada: cada preset baja de peso con su calidad medida", () => {
    const page = processed({ "0.92": 1.1, "0.87": 0.6, "0.8": 0.4 });
    expect(total(page, "balanced")).toBeLessThan(total(page, "original") * 0.75);
    expect(total(page, "compact")).toBeLessThan(total(page, "balanced"));
  });
});
