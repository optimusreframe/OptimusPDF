import { describe, expect, it } from "vitest";
import {
  findCleanRow,
  findCut,
  groupPagesIntoBatches,
  mergeIntervals,
  planPages,
  type BreakConstraints,
  type Interval,
} from "@/lib/pdf/htmlToPdfPagination";

const NONE: BreakConstraints = { hard: [], keep: [], orphans: [] };

/** Texto sintetico: `count` lineas de `lineHeight` px con `gap` px entre una y otra, desde `start`. */
function lines(count: number, lineHeight = 20, gap = 4, start = 0): Interval[] {
  return Array.from({ length: count }, (_, index): Interval => {
    const top = start + index * (lineHeight + gap);
    return [top, top + lineHeight];
  });
}

/** Ningun corte cae dentro de un intervalo. */
function splitsAny(pages: { y: number }[], intervals: readonly Interval[]): Interval[] {
  const cuts = pages.slice(1).map((page) => page.y);
  return intervals.filter(([start, end]) => cuts.some((cut) => cut > start + 1e-6 && cut < end - 1e-6));
}

describe("mergeIntervals", () => {
  it("une los que se solapan, deja separados los que solo se tocan, ordena y descarta degenerados", () => {
    expect(mergeIntervals([[10, 20], [0, 5], [5, 8], [18, 30], [40, 40], [50, 45]])).toEqual([[0, 5], [5, 8], [10, 30]]);
    expect(mergeIntervals([])).toEqual([]);
    expect(mergeIntervals([[Number.NaN, 4]])).toEqual([]);
  });
});

describe("findCut", () => {
  const merged: Interval[] = [[0, 20], [24, 44], [48, 68]];

  it("si el borde cae en un hueco, corta ahi", () => {
    expect(findCut(merged, 0, 22)).toBe(22);
  });

  it("si el borde cae dentro de una linea, sube al hueco anterior (pegado a la linea siguiente)", () => {
    const cut = findCut(merged, 0, 30)!;
    expect(cut).toBeGreaterThan(20);
    expect(cut).toBeLessThan(24);
  });

  it("no baja de `lo`", () => {
    expect(findCut(merged, 40, 30)).toBeNull();
    expect(findCut(merged, 25, 30)).toBeNull();
  });

  it("sin intervalos corta en el borde", () => {
    expect(findCut([], 0, 100)).toBe(100);
  });

  it("el borde compartido por dos intervalos que se tocan (filas contiguas) es un corte valido", () => {
    const rows: Interval[] = [[0, 50], [50, 100], [100, 150]];
    expect(findCut(rows, 0, 120)).toBe(100);
    expect(findCut(rows, 0, 100)).toBe(100);
  });

  it("deja aire minimo respecto del contenido que acaba de terminar", () => {
    const cut = findCut([[0, 20], [40, 60]], 0, 20.2)!;
    expect(cut).toBeGreaterThanOrEqual(21);
  });
});

describe("planPages", () => {
  it("un documento que cabe en una pagina es una sola pagina", () => {
    const { pages, forcedBreaks } = planPages(800, 1000, { ...NONE, hard: lines(30) });
    expect(pages).toEqual([{ y: 0, height: 800 }]);
    expect(forcedBreaks).toBe(0);
  });

  it("las paginas son contiguas, cubren todo el documento y ninguna pasa de la altura", () => {
    const hard = lines(400);
    const total = 400 * 24;
    const { pages } = planPages(total, 1000, { ...NONE, hard });
    let cursor = 0;
    for (const page of pages) {
      expect(page.y).toBeCloseTo(cursor, 6);
      expect(page.height).toBeGreaterThan(0);
      expect(page.height).toBeLessThanOrEqual(1000 + 1);
      cursor += page.height;
    }
    expect(cursor).toBeCloseTo(total, 6);
  });

  it("NINGUNA linea queda partida (articulo largo) y no hay cortes a ciegas", () => {
    const hard = lines(900, 19, 5);
    const { pages, forcedBreaks } = planPages(900 * 24, 1056, { ...NONE, hard });
    expect(splitsAny(pages, hard)).toEqual([]);
    expect(forcedBreaks).toBe(0);
    // Las paginas se llenan: ninguna (salvo la ultima) deja mas de ~una linea de blanco.
    for (const page of pages.slice(0, -1)) expect(page.height).toBeGreaterThan(1056 - 60);
  });

  it("con parrafos separados por huecos, corta en el hueco aunque haya que dejar blanco", () => {
    // Bloques de 300 px con 40 px de hueco: la pagina de 1000 px no cierra justo en un hueco.
    const blocks: Interval[] = Array.from({ length: 12 }, (_, index): Interval => [index * 340, index * 340 + 300]);
    const { pages, forcedBreaks } = planPages(12 * 340, 1000, { ...NONE, hard: blocks });
    expect(splitsAny(pages, blocks)).toEqual([]);
    expect(forcedBreaks).toBe(0);
  });

  it("una imagen no se parte: pasa entera a la pagina siguiente", () => {
    const text = lines(40, 20, 4); // 0..956
    const image: Interval = [980, 1500]; // cruza el borde de la pagina 1 (1056)
    const { pages } = planPages(1500 + 24, 1056, { ...NONE, hard: [...text, image] });
    expect(splitsAny(pages, [image])).toEqual([]);
    expect(pages[1].y).toBeLessThanOrEqual(980);
    expect(pages[1].y).toBeGreaterThan(956);
  });

  it("tabla con filas CONTIGUAS (sin hueco): se corta en el borde entre filas, nunca dentro de una", () => {
    const rows: Interval[] = Array.from({ length: 80 }, (_, index): Interval => [index * 37, (index + 1) * 37]);
    const { pages, forcedBreaks } = planPages(80 * 37, 1000, { ...NONE, hard: rows });
    expect(splitsAny(pages, rows)).toEqual([]);
    expect(forcedBreaks).toBe(0);
    for (const page of pages.slice(1)) expect(page.y % 37).toBeCloseTo(0, 6);
  });

  it("una fila de tabla no se parte", () => {
    const rows: Interval[] = Array.from({ length: 60 }, (_, index): Interval => [index * 50, index * 50 + 48]);
    const { pages, forcedBreaks } = planPages(60 * 50, 1000, { ...NONE, hard: rows });
    expect(splitsAny(pages, rows)).toEqual([]);
    expect(forcedBreaks).toBe(0);
  });

  it("un encabezado no acaba una pagina: se lleva consigo su primera linea", () => {
    // Pagina de 1000. Texto hasta 940; encabezado 960-990; parrafo 1004-1100.
    const text = lines(39, 20, 4); // 0..932
    const heading: Interval = [960, 990];
    const para = lines(5, 20, 4, 1004);
    const hard = [...text, heading, ...para];
    const keep: Interval[] = [[960, para[0][1]]];
    const withKeep = planPages(1130, 1000, { hard, keep, orphans: [] });
    expect(withKeep.pages[1].y).toBeLessThanOrEqual(960); // el encabezado empieza la pagina 2
    const without = planPages(1130, 1000, { hard, keep: [], orphans: [] });
    expect(without.pages[1].y).toBeGreaterThan(990); // sin la regla, el encabezado se queda abajo y su texto pasa
  });

  it("viudas y huerfanas: no deja una sola linea de un parrafo arriba o abajo", () => {
    // Un parrafo de 10 lineas empieza a 940; la pagina 1 acaba en 1000 -> 3 lineas caben abajo.
    const before = lines(38, 20, 4); // 0..908
    const para = lines(10, 20, 4, 940);
    const orphans: Interval[] = [[para[0][0], para[1][1]], [para[8][0], para[9][1]]];
    const result = planPages(940 + 240 + 20, 1000, { hard: [...before, ...para], keep: [], orphans });
    expect(splitsAny(result.pages, orphans)).toEqual([]);
  });

  it("si no hay hueco valido pero si en la fraccion minima, relaja (nunca parte una linea antes de dejar blanco)", () => {
    // Un bloque monolitico de 700 px (no cabe en el 60 % inferior) justo antes del borde.
    const block: Interval = [400, 1100];
    const above = lines(16, 20, 4); // 0..380
    const { pages, forcedBreaks } = planPages(1500, 1000, { ...NONE, hard: [...above, block] });
    expect(splitsAny(pages, [block])).toEqual([]);
    expect(forcedBreaks).toBe(0);
    expect(pages[1].y).toBeLessThan(400);
  });

  it("un bloque mas alto que la pagina obliga a un corte a ciegas y se cuenta", () => {
    const { pages, forcedBreaks } = planPages(3000, 1000, { ...NONE, hard: [[0, 3000]] });
    expect(forcedBreaks).toBeGreaterThan(0);
    expect(pages.length).toBe(3);
    expect(pages[0].height).toBeLessThanOrEqual(1001);
  });

  it("el resto de menos de 1 px por el redondeo del alto no crea una pagina extra", () => {
    const { pages } = planPages(1000.4, 1000, NONE);
    expect(pages).toHaveLength(1);
  });

  it("entradas degeneradas no se cuelgan ni devuelven NaN", () => {
    for (const [total, page] of [[0, 0], [-5, 1000], [10, -3], [Number.NaN, 100]] as const) {
      const { pages } = planPages(total, page, NONE);
      expect(pages.length).toBeGreaterThanOrEqual(1);
      expect(pages.every((p) => Number.isFinite(p.y) && Number.isFinite(p.height))).toBe(true);
    }
  });

  it("rendimiento: 200 paginas con 20 000 lineas en bien menos de un segundo", () => {
    const hard = lines(20_000, 18, 6);
    const started = Date.now();
    const { pages } = planPages(20_000 * 24, 1056, { ...NONE, hard });
    expect(pages.length).toBeGreaterThan(150);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("groupPagesIntoBatches", () => {
  it("agrupa paginas contiguas en lotes que caben en el lienzo y empiezan en un limite de pagina", () => {
    const pages = [0, 1, 2, 3, 4, 5, 6].map((index) => ({ y: index * 900, height: 900 }));
    const batches = groupPagesIntoBatches(pages, 2000);
    expect(batches.map((batch) => batch.pages.length)).toEqual([2, 2, 2, 1]);
    for (const batch of batches) {
      expect(batch.y).toBe(batch.pages[0].y);
      expect(batch.height).toBe(batch.pages.reduce((sum, page) => sum + page.height, 0));
    }
  });

  it("si ni una pagina cabe, emite una pagina por lote", () => {
    const batches = groupPagesIntoBatches([{ y: 0, height: 900 }, { y: 900, height: 900 }], 100);
    expect(batches).toHaveLength(2);
  });
});

describe("findCleanRow (ajuste fino sobre pixeles)", () => {
  const WIDTH = 400;

  /** `rows` filas de `WIDTH` px: del color de fondo, salvo `textRows` (tinta en media fila) y `barColumns` (filete vertical en todas las filas). */
  function image(rows: number, textRows: number[], background: [number, number, number] = [255, 255, 255], barColumns: number[] = []) {
    const data = new Uint8ClampedArray(rows * WIDTH * 4);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < WIDTH; column += 1) {
        const index = (row * WIDTH + column) * 4;
        const dark = (textRows.includes(row) && column >= 20 && column < 220) || barColumns.includes(column);
        data[index] = dark ? 0 : background[0];
        data[index + 1] = dark ? 0 : background[1];
        data[index + 2] = dark ? 0 : background[2];
        data[index + 3] = 255;
      }
    }
    return data;
  }
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it("si el corte ya cae en blanco lo deja donde esta", () => {
    expect(findCleanRow(image(100, [10, 11, 12]), WIDTH, 100, 50, 20, 0, 99)).toBe(50);
  });

  it("si cae sobre una linea de texto, se desplaza a la banda sin texto mas cercana", () => {
    const text = range(44, 55);
    const row = findCleanRow(image(100, text), WIDTH, 100, 50, 20, 0, 99)!;
    expect(row).not.toBeNull();
    for (const covered of [row - 1, row, row + 1]) expect(text).not.toContain(covered);
  });

  it("prefiere bajar cuando hay empate", () => {
    const row = findCleanRow(image(100, [49, 50, 51]), WIDTH, 100, 50, 20, 0, 99)!;
    expect(row).toBeGreaterThan(50);
  });

  it("un filete vertical (borde de una cita) NO impide el corte entre lineas", () => {
    const row = findCleanRow(image(100, range(40, 60), [255, 255, 255], [8, 9, 10, 11]), WIDTH, 100, 50, 30, 0, 99)!;
    expect(row).not.toBeNull();
    expect(range(40, 60)).not.toContain(row);
  });

  it("respeta los limites y devuelve null si no hay banda sin texto dentro de la ventana", () => {
    expect(findCleanRow(image(100, range(0, 99)), WIDTH, 100, 50, 20, 0, 99)).toBeNull();
    expect(findCleanRow(image(100, [50]), WIDTH, 100, 50, 20, 60, 99)).toBeGreaterThanOrEqual(61);
  });

  it("tambien vale una banda de otro color de fondo (fondo de color entre lineas)", () => {
    const row = findCleanRow(image(100, range(46, 54), [20, 40, 120]), WIDTH, 100, 50, 20, 0, 99);
    expect(row).not.toBeNull();
    expect(range(46, 54)).not.toContain(row!);
  });

  it("una imagen (filas con mucho contenido distinto) no se atraviesa nunca por error", () => {
    expect(findCleanRow(image(100, range(30, 70)), WIDTH, 100, 50, 10, 0, 99)).toBeNull();
  });
});
