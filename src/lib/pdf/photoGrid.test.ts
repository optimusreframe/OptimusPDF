import { describe, expect, it } from "vitest";
import {
  GRID_GUTTER,
  PHOTOS_PER_PAGE_OPTIONS,
  containInCell,
  gridShape,
  isPhotosPerPage,
  layoutPhotoGrid,
  pageDimensions,
  pixelsNeededForRect,
  sheetCount,
  sheetRange,
  type PhotoGridOptions,
  type PhotoSize,
  type PhotosPerPage,
  type Rect,
  type SheetLayout,
} from "@/lib/pdf/photoGrid";

/**
 * Geometria de «Fotos por pagina»: simetria exacta, nada fuera de la hoja ni solapado, proporcion conservada, margenes y
 * gutters iguales, ultima hoja incompleta, vertical/horizontal, A4/Carta y fotos verticales, horizontales y panoramicas.
 */

const EPS = 1e-6;
const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };
const MARGINS = [0, 24, 56];
/** Proporciones (ancho x alto) de fotos: vertical, horizontal, panoramica, cuadrada, 16:9 y vertical alargada. */
const SHAPES: PhotoSize[] = [
  { width: 3, height: 4 },
  { width: 4, height: 3 },
  { width: 3000, height: 800 },
  { width: 1, height: 1 },
  { width: 16, height: 9 },
  { width: 9, height: 16 },
];

function mixed(count: number, offset = 0): PhotoSize[] {
  return Array.from({ length: count }, (_, index) => SHAPES[(index + offset) % SHAPES.length]);
}

function bounds(rect: Rect) {
  return { left: rect.x, right: rect.x + rect.width, bottom: rect.y, top: rect.y + rect.height };
}

function overlap(a: Rect, b: Rect): boolean {
  const p = bounds(a);
  const q = bounds(b);
  return p.left < q.right - EPS && q.left < p.right - EPS && p.bottom < q.top - EPS && q.bottom < p.top - EPS;
}

function inside(inner: Rect, outer: Rect): boolean {
  const i = bounds(inner);
  const o = bounds(outer);
  return i.left >= o.left - EPS && i.right <= o.right + EPS && i.bottom >= o.bottom - EPS && i.top <= o.top + EPS;
}

function usableBox(sheet: SheetLayout): Rect {
  return {
    x: sheet.margin,
    y: sheet.margin,
    width: sheet.pageWidth - sheet.margin * 2,
    height: sheet.pageHeight - sheet.margin * 2,
  };
}

function checkSheetInvariants(sheet: SheetLayout, photos: PhotoSize[], options: PhotoGridOptions): void {
  const box = usableBox(sheet);
  expect(sheet.photoCount).toBe(sheet.photos.length);
  expect(sheet.photos.length).toBeLessThanOrEqual(options.perPage);
  for (const placed of sheet.photos) {
    // Dentro de la hoja y del area util.
    expect(inside(placed.rect, box), `foto ${placed.index} dentro del area util`).toBe(true);
    expect(inside(placed.rect, { x: 0, y: 0, width: sheet.pageWidth, height: sheet.pageHeight })).toBe(true);
    // Dentro de su celda y con su proporcion (sin recortar ni deformar).
    expect(inside(placed.rect, placed.cell), `foto ${placed.index} dentro de su celda`).toBe(true);
    const source = photos[placed.index];
    expect(placed.rect.width / placed.rect.height).toBeCloseTo(source.width / source.height, 6);
    expect(placed.rect.width).toBeGreaterThan(0);
    expect(placed.rect.height).toBeGreaterThan(0);
    // Simetria respecto al eje vertical de la hoja: cada foto esta centrada en su celda y la celda... (ver tests de rejilla).
    expect(placed.rect.x + placed.rect.width / 2).toBeCloseTo(placed.cell.x + placed.cell.width / 2, 6);
  }
  for (let i = 0; i < sheet.photos.length; i += 1) {
    for (let j = i + 1; j < sheet.photos.length; j += 1) {
      expect(overlap(sheet.photos[i].rect, sheet.photos[j].rect), `fotos ${sheet.photos[i].index} y ${sheet.photos[j].index} no se solapan`).toBe(false);
    }
  }
  // Orden: de izquierda a derecha y de arriba abajo (por celdas).
  const indices = sheet.photos.map((placed) => placed.index);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
  for (let k = 1; k < sheet.photos.length; k += 1) {
    const previous = sheet.photos[k - 1].cell;
    const current = sheet.photos[k].cell;
    const sameRow = Math.abs(previous.y - current.y) < EPS;
    if (sameRow) expect(current.x).toBeGreaterThan(previous.x);
    else expect(current.y).toBeLessThan(previous.y);
  }
}

const PER_PAGE = PHOTOS_PER_PAGE_OPTIONS;
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 20];

describe("photoGrid: formas y numeros de hojas", () => {
  it("el gutter por defecto son 12 puntos (~4 mm) y separa de verdad las celdas", () => {
    expect(GRID_GUTTER).toBe(12);
    const sheet = layoutPhotoGrid(mixed(2), { perPage: 4, pageSize: A4, orientation: "auto", margin: 0 })[0];
    const [a, b] = sheet.photos.map((placed) => placed.cell);
    expect(b.x - (a.x + a.width)).toBeCloseTo(12, 9);
  });

  it("la forma de la cuadricula: 2 por hoja es una columna de 2 filas; de 4 en adelante, 2 columnas x N/2 filas (maximo 5)", () => {
    expect(gridShape(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridShape(2)).toEqual({ cols: 1, rows: 2 });
    expect(gridShape(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(6)).toEqual({ cols: 2, rows: 3 });
    expect(gridShape(8)).toEqual({ cols: 2, rows: 4 });
    expect(gridShape(10)).toEqual({ cols: 2, rows: 5 });
  });

  it("isPhotosPerPage solo admite 1, 2, 4, 6, 8 y 10", () => {
    for (const value of [1, 2, 4, 6, 8, 10]) expect(isPhotosPerPage(value)).toBe(true);
    for (const value of [0, 3, 5, 7, 9, 11, -1, 2.5, "4", null, undefined]) expect(isPhotosPerPage(value)).toBe(false);
  });

  it("numero de hojas y rangos: 39 fotos a 4 por hoja son 10 hojas, la ultima con 3", () => {
    expect(sheetCount(0, 4)).toBe(0);
    expect(sheetCount(39, 1)).toBe(39);
    expect(sheetCount(39, 2)).toBe(20);
    expect(sheetCount(39, 4)).toBe(10);
    expect(sheetCount(39, 6)).toBe(7);
    expect(sheetCount(39, 8)).toBe(5);
    expect(sheetCount(39, 10)).toBe(4);
    expect(sheetRange(9, 39, 4)).toEqual({ first: 36, last: 38 });
    expect(sheetRange(0, 39, 10)).toEqual({ first: 0, last: 9 });
  });

  it("contain: ajusta sin deformar ni ampliar mas que la celda y centra", () => {
    const cell = { x: 10, y: 20, width: 200, height: 100 };
    const wide = containInCell({ width: 4, height: 1 }, cell);
    expect(wide.width).toBeCloseTo(200);
    expect(wide.height).toBeCloseTo(50);
    expect(wide.y).toBeCloseTo(45);
    const tall = containInCell({ width: 1, height: 4 }, cell);
    expect(tall.height).toBeCloseTo(100);
    expect(tall.width).toBeCloseTo(25);
    expect(tall.x).toBeCloseTo(97.5);
  });

  it("dimensiones de hoja: automatica y vertical = vertical; horizontal gira", () => {
    expect(pageDimensions(A4, "auto")).toEqual({ width: A4.width, height: A4.height });
    expect(pageDimensions(A4, "portrait")).toEqual({ width: A4.width, height: A4.height });
    expect(pageDimensions(A4, "landscape")).toEqual({ width: A4.height, height: A4.width });
  });

  it("pixeles necesarios de una celda: lado largo a la densidad pedida", () => {
    expect(pixelsNeededForRect({ x: 0, y: 0, width: 72, height: 36 }, 250)).toBe(250);
    expect(pixelsNeededForRect({ x: 0, y: 0, width: 36, height: 144 }, 200)).toBe(400);
  });

  it("sin fotos no hay hojas", () => {
    expect(layoutPhotoGrid([], { perPage: 4, pageSize: A4, orientation: "auto", margin: 0 })).toEqual([]);
  });
});

describe("photoGrid: invariantes en todas las combinaciones", () => {
  for (const perPage of PER_PAGE) {
    for (const [sizeName, pageSize] of [["A4", A4], ["Carta", LETTER]] as const) {
      for (const orientation of ["auto", "portrait", "landscape"] as const) {
        it(`${perPage} por hoja, ${sizeName}, ${orientation}: todas dentro, sin solapes, proporcion intacta`, () => {
          for (const margin of MARGINS) {
            for (const count of COUNTS) {
              for (const offset of [0, 2]) {
                const photos = mixed(count, offset);
                const options: PhotoGridOptions = { perPage: perPage as PhotosPerPage, pageSize, orientation, margin };
                const sheets = layoutPhotoGrid(photos, options);
                expect(sheets).toHaveLength(sheetCount(count, perPage as PhotosPerPage));
                const placedIndices = sheets.flatMap((sheet) => sheet.photos.map((placed) => placed.index));
                expect(placedIndices).toEqual(Array.from({ length: count }, (_, index) => index));
                const portraitPage = orientation !== "landscape";
                for (const sheet of sheets) {
                  expect(sheet.pageWidth < sheet.pageHeight).toBe(portraitPage);
                  expect(sheet.margin).toBe(margin);
                  checkSheetInvariants(sheet, photos, options);
                }
              }
            }
          }
        });
      }
    }
  }
});

describe("photoGrid: cuadricula de 2 columnas (4, 6, 8 y 10)", () => {
  for (const perPage of [4, 6, 8, 10] as const) {
    it(`${perPage} por hoja: celdas iguales, simetria exacta, margenes y gutters uniformes`, () => {
      for (const pageSize of [A4, LETTER]) {
        for (const orientation of ["auto", "landscape"] as const) {
          for (const margin of MARGINS) {
            const photos = mixed(perPage * 2);
            const sheets = layoutPhotoGrid(photos, { perPage, pageSize, orientation, margin });
            const { rows } = gridShape(perPage);
            const sheet = sheets[0];
            expect(sheet.cols).toBe(2);
            expect(sheet.rows).toBe(rows);
            expect(sheet.photos).toHaveLength(perPage);
            const cells = sheet.photos.map((placed) => placed.cell);
            // Celdas iguales.
            for (const cell of cells) {
              expect(cell.width).toBeCloseTo(cells[0].width, 9);
              expect(cell.height).toBeCloseTo(cells[0].height, 9);
            }
            const box = usableBox(sheet);
            // Margenes: el borde izquierdo, derecho y superior de la cuadricula coinciden con el margen en cada lado.
            const lefts = cells.map((cell) => cell.x);
            const rights = cells.map((cell) => cell.x + cell.width);
            expect(Math.min(...lefts)).toBeCloseTo(box.x, 9);
            expect(Math.max(...rights)).toBeCloseTo(box.x + box.width, 9);
            expect(Math.max(...cells.map((cell) => cell.y + cell.height))).toBeCloseTo(box.y + box.height, 9);
            expect(Math.min(...cells.map((cell) => cell.y))).toBeCloseTo(box.y, 9);
            // Gutter horizontal entre columnas y vertical entre filas: iguales a GRID_GUTTER.
            for (let row = 0; row < rows; row += 1) {
              const left = cells[row * 2];
              const right = cells[row * 2 + 1];
              expect(right.x - (left.x + left.width)).toBeCloseTo(GRID_GUTTER, 9);
              expect(left.y).toBeCloseTo(right.y, 9);
              if (row > 0) {
                const above = cells[(row - 1) * 2];
                expect(above.y - (left.y + left.height)).toBeCloseTo(GRID_GUTTER, 9);
              }
              // Simetria: la columna izquierda es la imagen especular de la derecha respecto al eje vertical de la hoja.
              const axis = sheet.pageWidth / 2;
              expect(axis - left.x).toBeCloseTo(right.x + right.width - axis, 9);
              expect(left.x + left.width / 2 + (right.x + right.width / 2)).toBeCloseTo(sheet.pageWidth, 9);
            }
          }
        }
      }
    });
  }

  it("una foto que ocupa toda la celda toca los bordes de la celda (contain, no se encoge de mas)", () => {
    const sheet = layoutPhotoGrid(mixed(4), { perPage: 4, pageSize: A4, orientation: "auto", margin: 24 })[0];
    for (const placed of sheet.photos) {
      const touchesWidth = Math.abs(placed.rect.width - placed.cell.width) < EPS;
      const touchesHeight = Math.abs(placed.rect.height - placed.cell.height) < EPS;
      expect(touchesWidth || touchesHeight).toBe(true);
    }
  });

  it("ultima hoja con una sola foto en la ultima fila: queda centrada en la fila y con el mismo tamano de celda", () => {
    for (const perPage of [4, 6, 8, 10] as const) {
      for (const count of [perPage + 1, perPage + 3, perPage * 2 - 1]) {
        const options: PhotoGridOptions = { perPage, pageSize: A4, orientation: "auto", margin: 24 };
        const sheets = layoutPhotoGrid(mixed(count), options);
        const full = sheets[0].photos[0].cell;
        const last = sheets[sheets.length - 1];
        const remaining = count - perPage * (sheets.length - 1);
        expect(last.photos).toHaveLength(remaining);
        for (const placed of last.photos) {
          expect(placed.cell.width).toBeCloseTo(full.width, 9);
          expect(placed.cell.height).toBeCloseTo(full.height, 9);
        }
        if (remaining % 2 === 1) {
          const alone = last.photos[last.photos.length - 1];
          expect(alone.cell.x + alone.cell.width / 2).toBeCloseTo(last.pageWidth / 2, 9);
          // Esta en la fila correspondiente (la fila que le toca, contada desde arriba).
          const row = Math.floor((remaining - 1) / 2);
          expect(alone.cell.y).toBeCloseTo(sheets[0].photos[row * 2].cell.y, 9);
        }
        // La hoja sigue simetrica: el centro de cada fila esta en el eje vertical.
        for (let row = 0; row < Math.ceil(remaining / 2); row += 1) {
          const inRow = last.photos.filter((placed) => Math.abs(placed.cell.y - last.photos[row * 2].cell.y) < EPS);
          const centre = (Math.min(...inRow.map((p) => p.cell.x)) + Math.max(...inRow.map((p) => p.cell.x + p.cell.width))) / 2;
          expect(centre).toBeCloseTo(last.pageWidth / 2, 9);
        }
      }
    }
  });

  it("ultima hoja con filas que faltan: las celdas no se agrandan y las fotos siguen arriba", () => {
    const options: PhotoGridOptions = { perPage: 10, pageSize: A4, orientation: "auto", margin: 0 };
    const sheets = layoutPhotoGrid(mixed(11), options);
    expect(sheets).toHaveLength(2);
    expect(sheets[1].photos).toHaveLength(1);
    expect(sheets[1].photos[0].cell.width).toBeCloseTo(sheets[0].photos[0].cell.width, 9);
    expect(sheets[1].photos[0].cell.height).toBeCloseTo(sheets[0].photos[0].cell.height, 9);
    expect(sheets[1].photos[0].cell.y).toBeCloseTo(sheets[0].photos[0].cell.y, 9);
  });

  it("horizontal: la cuadricula sigue siendo de 2 columnas", () => {
    const sheet = layoutPhotoGrid(mixed(6), { perPage: 6, pageSize: A4, orientation: "landscape", margin: 24 })[0];
    expect(sheet.pageWidth).toBeGreaterThan(sheet.pageHeight);
    expect(sheet.cols).toBe(2);
    const xs = new Set(sheet.photos.map((placed) => placed.cell.x.toFixed(6)));
    expect(xs.size).toBe(2);
  });
});

describe("photoGrid: 2 por hoja (una arriba, una abajo)", () => {
  const options = (margin = 0, orientation: "auto" | "landscape" = "auto"): PhotoGridOptions => ({
    perPage: 2,
    pageSize: A4,
    orientation,
    margin,
  });

  it("dos fotos horizontales: las dos al ancho util completo, una arriba y otra abajo, espacio repartido por igual", () => {
    const sheet = layoutPhotoGrid([{ width: 16, height: 9 }, { width: 2, height: 1 }], options(24))[0];
    const box = usableBox(sheet);
    const [first, second] = sheet.photos.map((placed) => placed.rect);
    expect(first.width).toBeCloseTo(box.width, 9);
    expect(second.width).toBeCloseTo(box.width, 9);
    expect(first.y).toBeGreaterThan(second.y);
    // Espacio arriba = espacio entre = espacio abajo.
    const top = box.y + box.height - (first.y + first.height);
    const middle = first.y - (second.y + second.height);
    const bottom = second.y - box.y;
    expect(top).toBeCloseTo(middle, 6);
    expect(middle).toBeCloseTo(bottom, 6);
    expect(middle).toBeGreaterThanOrEqual(GRID_GUTTER - EPS);
    // Centradas en el eje vertical.
    for (const rect of [first, second]) expect(rect.x + rect.width / 2).toBeCloseTo(sheet.pageWidth / 2, 9);
  });

  it("dos fotos verticales no caben a todo el ancho: las dos se reducen por igual hasta llenar el alto", () => {
    const sheet = layoutPhotoGrid([{ width: 3, height: 4 }, { width: 3, height: 4 }], options(24))[0];
    const box = usableBox(sheet);
    const [first, second] = sheet.photos.map((placed) => placed.rect);
    expect(first.width).toBeLessThan(box.width);
    expect(first.width).toBeCloseTo(second.width, 9);
    // Alto total + gutter = alto util (sin espacio libre extra).
    expect(first.height + second.height + GRID_GUTTER).toBeCloseTo(box.height, 6);
    expect(first.y - (second.y + second.height)).toBeCloseTo(GRID_GUTTER, 6);
  });

  it("las dos franjas (celdas) se reparten TODA el area util: se tocan, no se solapan y cada foto cabe en la suya", () => {
    for (const margin of [0, 24]) {
      const sheet = layoutPhotoGrid([{ width: 16, height: 9 }, { width: 3, height: 2 }], options(margin))[0];
      const box = usableBox(sheet);
      const [first, second] = sheet.photos.map((placed) => placed.cell);
      expect(first.y).toBeCloseTo(second.y + second.height, 9);
      expect(first.y + first.height).toBeCloseTo(box.y + box.height, 9);
      expect(second.y).toBeCloseTo(box.y, 9);
      for (const cell of [first, second]) {
        expect(cell.x).toBeCloseTo(box.x, 9);
        expect(cell.width).toBeCloseTo(box.width, 9);
      }
    }
  });

  it("una panoramica y una vertical: mismo ancho, y siempre caben", () => {
    const sheet = layoutPhotoGrid([{ width: 3000, height: 800 }, { width: 3, height: 4 }], options(0))[0];
    checkSheetInvariants(sheet, [{ width: 3000, height: 800 }, { width: 3, height: 4 }], options(0));
    expect(sheet.photos[0].rect.width).toBeCloseTo(sheet.photos[1].rect.width, 9);
  });

  it("ultima hoja con una sola foto: va en la mitad superior y no se agranda", () => {
    const sheets = layoutPhotoGrid(mixed(3), options(24));
    expect(sheets).toHaveLength(2);
    const alone = sheets[1].photos[0];
    expect(alone.cell.y + alone.cell.height).toBeCloseTo(sheets[0].photos[0].cell.y + sheets[0].photos[0].cell.height, 9);
    expect(alone.rect.x + alone.rect.width / 2).toBeCloseTo(sheets[1].pageWidth / 2, 9);
    expect(inside(alone.rect, alone.cell)).toBe(true);
  });

  it("horizontal: sigue siendo una arriba y otra abajo (columna) y cabe", () => {
    const photos = [{ width: 4, height: 3 }, { width: 3, height: 4 }];
    const sheet = layoutPhotoGrid(photos, options(24, "landscape"))[0];
    expect(sheet.pageWidth).toBeGreaterThan(sheet.pageHeight);
    checkSheetInvariants(sheet, photos, options(24, "landscape"));
    expect(sheet.photos[0].rect.y).toBeGreaterThan(sheet.photos[1].rect.y);
  });
});

describe("photoGrid: 1 por hoja y datos raros", () => {
  it("una foto ocupa toda el area util segun su proporcion", () => {
    const sheet = layoutPhotoGrid([{ width: 4, height: 3 }], { perPage: 1, pageSize: A4, orientation: "auto", margin: 24 })[0];
    const box = usableBox(sheet);
    expect(sheet.photos[0].rect.width).toBeCloseTo(box.width, 9);
    expect(sheet.photos[0].rect.x).toBeCloseTo(box.x, 9);
  });

  it("dimensiones degeneradas (0, negativas, NaN) no rompen la composicion", () => {
    const sheets = layoutPhotoGrid(
      [{ width: 0, height: 5 }, { width: -4, height: 3 }, { width: Number.NaN, height: 1 }, { width: 5, height: Number.POSITIVE_INFINITY }],
      { perPage: 4, pageSize: A4, orientation: "auto", margin: 24 },
    );
    for (const placed of sheets[0].photos) {
      expect(Number.isFinite(placed.rect.x + placed.rect.y + placed.rect.width + placed.rect.height)).toBe(true);
      expect(placed.rect.width).toBeGreaterThan(0);
    }
  });

  it("un margen absurdo se acota: siempre queda area util", () => {
    const sheet = layoutPhotoGrid(mixed(4), { perPage: 4, pageSize: A4, orientation: "auto", margin: 10_000 })[0];
    expect(sheet.margin).toBeLessThanOrEqual(A4.width / 4);
    for (const placed of sheet.photos) expect(placed.rect.width).toBeGreaterThan(0);
  });

  it("el gutter se puede cambiar", () => {
    const sheet = layoutPhotoGrid(mixed(4), { perPage: 4, pageSize: A4, orientation: "auto", margin: 0, gutter: 30 })[0];
    const [a, b] = sheet.photos.map((placed) => placed.cell);
    expect(b.x - (a.x + a.width)).toBeCloseTo(30, 9);
  });
});
