import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRID_OPTIONS,
  computeGrid,
  fitRotated,
  insertionIndexAt,
  insertionMarker,
  itemPosition,
  neighbourIndex,
  scrollTopToReveal,
  strictVisibleRange,
  visibleRange,
} from "@/app/pdf-pro/pages/pagesLayout";

describe("computeGrid", () => {
  it("un panel estrecho (320 px) da 2 columnas", () => {
    const metrics = computeGrid(320, 20);
    expect(metrics.columns).toBe(2);
    expect(metrics.cardWidth).toBeGreaterThanOrEqual(DEFAULT_GRID_OPTIONS.minCard - 20);
  });

  it("un telefono (375 px) da 2 columnas y nunca mas de 3 tarjetas por fila", () => {
    const metrics = computeGrid(375, 50);
    expect(metrics.columns).toBeGreaterThanOrEqual(2);
    expect(metrics.columns).toBeLessThanOrEqual(3);
  });

  it("un escritorio ancho reparte en mas columnas y la tarjeta no pasa del maximo", () => {
    const metrics = computeGrid(1280, 100);
    expect(metrics.columns).toBeGreaterThan(4);
    expect(metrics.cardWidth).toBeLessThanOrEqual(DEFAULT_GRID_OPTIONS.maxCard + 1);
  });

  it("las tarjetas caben exactamente en el ancho (sin desbordar)", () => {
    for (const width of [300, 320, 375, 414, 560, 768, 1024, 1280, 1920]) {
      const metrics = computeGrid(width, 40);
      const used = metrics.padding * 2 + metrics.columns * metrics.cardWidth + (metrics.columns - 1) * metrics.gap;
      expect(used).toBeLessThanOrEqual(width);
    }
  });

  it("calcula filas y alto total", () => {
    const metrics = computeGrid(320, 7);
    expect(metrics.rows).toBe(Math.ceil(7 / metrics.columns));
    expect(metrics.totalHeight).toBe(metrics.padding * 2 + metrics.rows * metrics.rowHeight - metrics.gap);
  });

  it("sin tarjetas el alto es solo el relleno", () => {
    const metrics = computeGrid(320, 0);
    expect(metrics.rows).toBe(0);
    expect(metrics.totalHeight).toBe(metrics.padding * 2);
  });

  it("500 paginas dan un alto total grande pero finito", () => {
    const metrics = computeGrid(320, 500);
    expect(metrics.totalHeight).toBeGreaterThan(10_000);
    expect(Number.isFinite(metrics.totalHeight)).toBe(true);
  });

  it("un ancho absurdamente pequeno respeta el minimo de columnas y de tarjeta", () => {
    const metrics = computeGrid(10, 5);
    expect(metrics.columns).toBe(DEFAULT_GRID_OPTIONS.minColumns);
    expect(metrics.cardWidth).toBeGreaterThanOrEqual(60);
  });

  it("acepta opciones propias", () => {
    const metrics = computeGrid(1000, 10, { minColumns: 4, maxColumns: 4 });
    expect(metrics.columns).toBe(4);
  });
});

describe("itemPosition / visibleRange", () => {
  const metrics = computeGrid(320, 100);

  it("la primera tarjeta empieza en el relleno", () => {
    expect(itemPosition(metrics, 0)).toEqual({ x: metrics.padding, y: metrics.padding });
  });

  it("la tarjeta de la segunda fila baja una fila", () => {
    const { y } = itemPosition(metrics, metrics.columns);
    expect(y).toBe(metrics.padding + metrics.rowHeight);
  });

  it("las columnas avanzan de tarjeta en tarjeta", () => {
    expect(itemPosition(metrics, 1).x).toBe(metrics.padding + metrics.cardWidth + metrics.gap);
  });

  it("arriba del todo se pintan las primeras filas (con margen)", () => {
    const range = visibleRange(metrics, 0, 500, 2)!;
    expect(range.first).toBe(0);
    expect(range.last).toBeGreaterThanOrEqual(metrics.columns * 2);
  });

  it("al desplazarse, el rango se mueve y no incluye lo lejano", () => {
    const range = visibleRange(metrics, 3000, 500, 1)!;
    expect(range.first).toBeGreaterThan(0);
    expect(range.last).toBeLessThan(100);
    expect(range.first % metrics.columns).toBe(0);
  });

  it("nunca pinta mas de unas decenas de tarjetas aunque haya 500", () => {
    const big = computeGrid(320, 500);
    for (const top of [0, 1000, 5000, 20_000]) {
      const range = visibleRange(big, top, 600, 2)!;
      expect(range.last - range.first + 1).toBeLessThanOrEqual(60);
    }
  });

  it("sin tarjetas no hay rango", () => {
    expect(visibleRange(computeGrid(320, 0), 0, 500)).toBeNull();
  });

  it("el rango estricto es el que se ve de verdad (sin margen)", () => {
    const strict = strictVisibleRange(metrics, 0, 300)!;
    const padded = visibleRange(metrics, 0, 300, 2)!;
    expect(strict.last).toBeLessThanOrEqual(padded.last);
  });

  it("un desplazamiento mas alla del final se acota a la ultima fila", () => {
    const range = visibleRange(metrics, 999_999, 500, 0)!;
    expect(range.last).toBe(metrics.count - 1);
  });
});

describe("insertionIndexAt", () => {
  const metrics = computeGrid(320, 6);
  const centre = (index: number) => {
    const { x, y } = itemPosition(metrics, index);
    return { x: x + metrics.cardWidth / 2, y: y + metrics.cardHeight / 2 };
  };

  it("la mitad izquierda de una tarjeta inserta ANTES de ella", () => {
    const { x, y } = itemPosition(metrics, 3);
    expect(insertionIndexAt(metrics, x + 5, y + 20)).toBe(3);
  });

  it("la mitad derecha inserta DESPUES", () => {
    const { x, y } = itemPosition(metrics, 3);
    expect(insertionIndexAt(metrics, x + metrics.cardWidth - 5, y + 20)).toBe(4);
  });

  it("el hueco entre dos columnas cae en un lado u otro, nunca fuera", () => {
    const first = itemPosition(metrics, 0);
    const between = insertionIndexAt(metrics, first.x + metrics.cardWidth + metrics.gap / 2, first.y + 10);
    expect([1, 2]).toContain(between);
  });

  it("debajo de todo inserta al final", () => {
    expect(insertionIndexAt(metrics, 100, 999_999)).toBe(metrics.count);
  });

  it("por encima de todo inserta al principio", () => {
    expect(insertionIndexAt(metrics, 0, -50)).toBe(0);
  });

  it("a la derecha de la ultima tarjeta de la ultima fila (hueco vacio) inserta al final", () => {
    const partial = computeGrid(320, 5);
    const lastRow = Math.floor(4 / partial.columns);
    const y = partial.padding + lastRow * partial.rowHeight + 10;
    expect(insertionIndexAt(partial, 319, y)).toBe(5);
  });

  it("el centro de una tarjeta cae antes o despues, siempre dentro del rango", () => {
    for (let index = 0; index < metrics.count; index += 1) {
      const { x, y } = centre(index);
      const at = insertionIndexAt(metrics, x, y);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(metrics.count);
    }
  });

  it("sin tarjetas es 0", () => {
    expect(insertionIndexAt(computeGrid(320, 0), 50, 50)).toBe(0);
  });
});

describe("insertionMarker", () => {
  const metrics = computeGrid(320, 6);

  it("antes de la tarjeta 2 se pinta pegada a su borde izquierdo", () => {
    const marker = insertionMarker(metrics, 2);
    const at = itemPosition(metrics, 2);
    expect(marker.x).toBeCloseTo(at.x - metrics.gap / 2);
    expect(marker.y).toBe(at.y);
    expect(marker.height).toBe(metrics.cardHeight);
  });

  it("al final se pinta tras la ultima tarjeta", () => {
    const marker = insertionMarker(metrics, 6);
    const last = itemPosition(metrics, 5);
    expect(marker.x).toBeGreaterThan(last.x + metrics.cardWidth);
    expect(marker.y).toBe(last.y);
  });

  it("acota posiciones fuera de rango", () => {
    expect(insertionMarker(metrics, -3)).toEqual(insertionMarker(metrics, 0));
    expect(insertionMarker(metrics, 99)).toEqual(insertionMarker(metrics, 6));
  });
});

describe("scrollTopToReveal", () => {
  const metrics = computeGrid(320, 200);

  it("no mueve si la tarjeta ya se ve entera", () => {
    expect(scrollTopToReveal(metrics, 0, 0, 600)).toBe(0);
  });

  it("sube si la tarjeta esta por encima", () => {
    const top = scrollTopToReveal(metrics, 0, 2000, 600);
    expect(top).toBeLessThan(2000);
  });

  it("baja lo justo si la tarjeta esta por debajo", () => {
    const index = 100;
    const next = scrollTopToReveal(metrics, index, 0, 600);
    const { y } = itemPosition(metrics, index);
    expect(next + 600).toBeGreaterThanOrEqual(y + metrics.cardHeight);
    expect(next).toBeLessThan(y);
  });

  it("nunca devuelve negativos", () => {
    expect(scrollTopToReveal(metrics, 0, 50, 600)).toBeGreaterThanOrEqual(0);
  });
});

describe("neighbourIndex", () => {
  const metrics = computeGrid(320, 10);
  const columns = metrics.columns;

  it("izquierda y derecha", () => {
    expect(neighbourIndex(metrics, 4, "left")).toBe(3);
    expect(neighbourIndex(metrics, 4, "right")).toBe(5);
  });

  it("arriba y abajo saltan una fila", () => {
    expect(neighbourIndex(metrics, columns + 1, "up")).toBe(1);
    expect(neighbourIndex(metrics, 1, "down")).toBe(1 + columns);
  });

  it("en los extremos no hay vecino", () => {
    expect(neighbourIndex(metrics, 0, "left")).toBeNull();
    expect(neighbourIndex(metrics, 9, "right")).toBeNull();
    expect(neighbourIndex(metrics, 0, "up")).toBeNull();
    expect(neighbourIndex(metrics, 9, "down")).toBeNull();
  });

  it("inicio y fin", () => {
    expect(neighbourIndex(metrics, 5, "home")).toBe(0);
    expect(neighbourIndex(metrics, 2, "end")).toBe(9);
  });

  it("RePag/AvPag saltan varias filas y se acotan al documento", () => {
    expect(neighbourIndex(metrics, 9, "pageUp", 2)).toBe(Math.max(0, 9 - columns * 2));
    expect(neighbourIndex(metrics, 0, "pageDown", 100)).toBe(9);
  });

  it("sin tarjetas no hay vecino", () => {
    expect(neighbourIndex(computeGrid(320, 0), 0, "right")).toBeNull();
  });
});

describe("fitRotated", () => {
  it("sin giro, una pagina vertical cabe por alto y una horizontal por ancho", () => {
    const portrait = fitRotated(100, 130, 0.75, 0);
    expect(portrait.height).toBeCloseTo(130);
    expect(portrait.width).toBeCloseTo(97.5);
    const landscape = fitRotated(100, 130, 1.5, 0);
    expect(landscape.width).toBeCloseTo(100);
    expect(landscape.height).toBeCloseTo(66.67, 1);
  });

  it("a 90 grados el elemento SIN girar es la pagina vertical que, girada, llena el ancho del cuadro", () => {
    const rotated = fitRotated(100, 130, 0.75, 90);
    expect(rotated.width).toBeCloseTo(75);
    expect(rotated.height).toBeCloseTo(100);
  });

  it("tras girar 90, la pagina cabe en el cuadro (lado a lado intercambiados)", () => {
    const { width, height } = fitRotated(100, 130, 0.75, 90);
    expect(height).toBeLessThanOrEqual(100 + 0.01);
    expect(width).toBeLessThanOrEqual(130 + 0.01);
  });

  it("180 y 0 dan el mismo tamano; 90 y 270 tambien", () => {
    expect(fitRotated(80, 100, 0.7, 180)).toEqual(fitRotated(80, 100, 0.7, 0));
    expect(fitRotated(80, 100, 0.7, 270)).toEqual(fitRotated(80, 100, 0.7, 90));
  });

  it("proporcion invalida no rompe (usa una vertical por defecto)", () => {
    const out = fitRotated(100, 130, Number.NaN, 0);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it("rotaciones no multiplo de 90 se redondean al cuarto mas cercano", () => {
    expect(fitRotated(100, 130, 0.75, 85)).toEqual(fitRotated(100, 130, 0.75, 90));
    expect(fitRotated(100, 130, 0.75, -90)).toEqual(fitRotated(100, 130, 0.75, 270));
  });
});
