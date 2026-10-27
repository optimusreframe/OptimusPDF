import { describe, expect, it } from "vitest";
import { estimateScanSize } from "@/lib/scan/estimate";
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
});
