import { describe, expect, it } from "vitest";
import { findSpine } from "@/lib/scan/spine";
import type { Gray } from "@/lib/scan/pixels";

function spread(spineAt: number, depth = 90, width = 400, height = 300): Gray {
  const data = new Uint8Array(width * height);
  const center = spineAt * width;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.abs(x - center);
      const shade = d < 40 ? depth * (1 - d / 40) ** 1.5 : 0;
      // Texto: textura de lineas suave (no debe confundir).
      const text = y % 14 < 3 && x % 6 < 4 ? 40 : 0;
      data[y * width + x] = Math.max(0, 235 - shade - text);
    }
  }
  return { data, width, height };
}

describe("lomo del libro — src/lib/scan/spine.ts", () => {
  it("lo encuentra en el centro y desplazado, con confianza", () => {
    const centred = findSpine(spread(0.5));
    expect(centred.position).toBeCloseTo(0.5, 1);
    expect(centred.confidence).toBeGreaterThan(0.4);
    const left = findSpine(spread(0.42));
    expect(left.position).toBeCloseTo(0.42, 1);
    const right = findSpine(spread(0.58));
    expect(right.position).toBeCloseTo(0.58, 1);
  });

  it("sin franja oscura devuelve el centro con confianza baja (parte por la mitad)", () => {
    const flat: Gray = { data: new Uint8Array(400 * 300).fill(230), width: 400, height: 300 };
    expect(findSpine(flat)).toEqual({ position: 0.5, confidence: 0 });
    const weak = findSpine(spread(0.5, 6));
    expect(weak.position).toBe(0.5);
    expect(weak.confidence).toBeLessThan(0.4);
  });

  it("una sombra en el borde de la ventana de busqueda no es un lomo; una imagen diminuta tampoco", () => {
    // Una franja oscura justo en el borde de la ventana de busqueda (30 % del ancho) no es el lomo.
    const edge = findSpine(spread(0.3, 150));
    expect(edge.position).toBe(0.5);
    expect(edge.confidence).toBe(0);
    expect(findSpine({ data: new Uint8Array(100), width: 10, height: 10 })).toEqual({ position: 0.5, confidence: 0 });
  });
});
