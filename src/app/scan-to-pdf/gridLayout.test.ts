import { describe, expect, it } from "vitest";
import { ACTIONS_H, GRID_GAP, MIN_TILE, STRIP_H, computeLayout, insertionIndexAt, insertionMarker, tilePosition, totalHeight, visibleRange } from "@/app/scan-to-pdf/gridLayout";

describe("columnas y tamano de tarjeta", () => {
  it("siempre hay al menos 2 columnas y la tarjeta nunca baja de ~138 px en un telefono de 320 px", () => {
    const narrow = computeLayout(288);
    expect(narrow.cols).toBe(2);
    expect(narrow.tileW).toBeGreaterThanOrEqual(138);
    expect(computeLayout(10).cols).toBe(2);
  });

  it("las columnas crecen con el ancho de la pantalla (320 -> 1194)", () => {
    const cols = [288, 343, 361, 712, 802, 1152].map((width) => computeLayout(width).cols);
    expect(cols).toEqual([2, 2, 2, 4, 5, 7].map((n, i) => (i === 2 ? 2 : n)));
    for (let i = 1; i < cols.length; i += 1) expect(cols[i]).toBeGreaterThanOrEqual(cols[i - 1]);
  });

  it("las tarjetas llenan el ancho exacto (sin sobrar ni faltar un pixel)", () => {
    for (const width of [288, 343, 361, 712, 802, 1152]) {
      const layout = computeLayout(width);
      expect(layout.cols * layout.tileW + (layout.cols - 1) * GRID_GAP).toBeCloseTo(width, 5);
      expect(layout.tileW).toBeGreaterThanOrEqual(MIN_TILE - 12);
    }
  });

  it("la miniatura es 3:4 y la fila de acciones tiene alto fijo", () => {
    const layout = computeLayout(343);
    expect(layout.thumbH).toBe(Math.round((layout.tileW * 4) / 3));
    // Franja superior (numero y asa) sobre la miniatura: nada tapa la foto.
    expect(layout.boxH).toBe(layout.thumbH + STRIP_H);
    expect(layout.tileH).toBe(layout.boxH + ACTIONS_H);
    expect(layout.rowH).toBe(layout.tileH + GRID_GAP);
  });

  it("a 320 px (y con letra grande) caben las tres acciones de 44 px en la tarjeta", () => {
    const layout = computeLayout(320 - 32);
    expect(layout.tileW).toBeGreaterThanOrEqual(3 * 44);
  });
});

describe("posiciones, alto total y ventana visible", () => {
  const layout = computeLayout(343); // 2 columnas

  it("posicion de cada tarjeta por fila y columna", () => {
    expect(tilePosition(layout, 0)).toEqual({ x: 0, y: 0 });
    expect(tilePosition(layout, 1)).toEqual({ x: layout.tileW + GRID_GAP, y: 0 });
    expect(tilePosition(layout, 2)).toEqual({ x: 0, y: layout.rowH });
    expect(tilePosition(layout, 5).y).toBe(2 * layout.rowH);
  });

  it("alto total: filas completas sin el hueco final", () => {
    expect(totalHeight(layout, 0)).toBe(0);
    expect(totalHeight(layout, 1)).toBe(layout.tileH);
    expect(totalHeight(layout, 2)).toBe(layout.tileH);
    expect(totalHeight(layout, 3)).toBe(2 * layout.rowH - GRID_GAP);
    expect(totalHeight(layout, 100)).toBe(50 * layout.rowH - GRID_GAP);
  });

  it("visibleRange pinta las filas a la vista mas el margen, y nunca se sale de la lista", () => {
    expect(visibleRange(layout, 0, 0, 800)).toBeNull();
    expect(visibleRange(layout, 100, 0, 800, 0)).toEqual({ first: 0, last: (Math.floor(800 / layout.rowH) + 1) * 2 - 1 });
    const middle = visibleRange(layout, 100, 5000, 800, 1)!;
    expect(middle.first % 2).toBe(0);
    // El margen existe por los DOS lados: una fila mas arriba y una mas abajo de lo visible.
    expect(middle.first).toBe((Math.floor(5000 / layout.rowH) - 1) * 2);
    expect(middle.last).toBe((Math.floor(5800 / layout.rowH) + 2) * 2 - 1);
    expect(middle.first).toBeLessThanOrEqual(Math.floor(5000 / layout.rowH) * 2);
    expect(middle.last).toBeGreaterThanOrEqual(Math.floor(5800 / layout.rowH) * 2);
    const end = visibleRange(layout, 100, 1e9, 800)!;
    expect(end.last).toBe(99);
    // Con 100 paginas nunca se piden todas (la virtualizacion existe para esto).
    expect(middle.last - middle.first).toBeLessThan(30);
  });
});

describe("hueco de un arrastre", () => {
  const layout = computeLayout(343);

  it("mitad izquierda de una tarjeta = antes de ella; mitad derecha = despues", () => {
    expect(insertionIndexAt(layout, 6, 5, 10)).toBe(0);
    expect(insertionIndexAt(layout, 6, layout.tileW - 5, 10)).toBe(1);
    expect(insertionIndexAt(layout, 6, layout.tileW + GRID_GAP + 5, 10)).toBe(1);
    expect(insertionIndexAt(layout, 6, layout.tileW + GRID_GAP + layout.tileW - 5, 10)).toBe(2);
  });

  it("filas siguientes y limites: nunca fuera de 0..n", () => {
    expect(insertionIndexAt(layout, 6, 5, layout.rowH + 10)).toBe(2);
    expect(insertionIndexAt(layout, 6, 99999, 99999)).toBe(6);
    expect(insertionIndexAt(layout, 6, -50, -50)).toBe(0);
    expect(insertionIndexAt(layout, 0, 5, 5)).toBe(0);
  });

  it("marcador: a la izquierda del hueco o, al final, a la derecha de la ultima", () => {
    const first = insertionMarker(layout, 6, 0);
    expect(first.x).toBe(0);
    expect(first.height).toBe(layout.tileH);
    const mid = insertionMarker(layout, 6, 3);
    expect(mid.y).toBe(layout.rowH);
    const end = insertionMarker(layout, 6, 6);
    expect(end.y).toBe(2 * layout.rowH);
    expect(end.x).toBeGreaterThan(layout.tileW);
  });
});
