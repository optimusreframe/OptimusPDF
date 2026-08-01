import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ExcelJS from "exceljs";
import * as core from "@/lib/pdf/core";
import { PdfError } from "@/lib/pdf/core";
import {
  EXCEL_MAX_COLUMNS,
  MAX_CELL_CHARS,
  MAX_DOCUMENT_TEXT_CHARS,
  MAX_TABLES_PER_DOCUMENT,
  blocksToWorkbook,
  pdfToExcel,
  DEFAULT_PDF_TO_EXCEL_OPTIONS,
  type TruncationCounter,
} from "@/lib/pdf/pdfToExcel";
import type { DocBlock } from "@/lib/pdf/pdfToMarkdown";

/**
 * `pdfToExcel.ts` reutiliza por completo `extractDocumentBlocks` de
 * `pdfToMarkdown.ts` (que a su vez usa pdf.js), asi que esta suite sigue
 * el mismo patron de sustitucion que `pdfToImages.test.ts` y las pruebas
 * de `extractMarkdownPages` en `pdfToMarkdown.test.ts`: se sustituyen
 * `openPdfDocument`/`renderPageToCanvas`/`closePdfDocument` de
 * `@/lib/pdf/core` por dobles controlados y corre el codigo REAL de
 * `pdfToMarkdown.ts` (deteccion de tablas incluida) y de `pdfToExcel.ts`
 * sobre paginas de pdf.js falsas con la geometria minima necesaria para
 * que las heuristicas de tabla de `pdfToMarkdown.ts` reconozcan (o no)
 * una tabla de verdad.
 *
 * La capa `blocksToWorkbook` (pura salvo el import perezoso de `exceljs`)
 * se prueba aparte, en aislamiento, con `DocBlock[]` construidos a mano:
 * no hace falta pdf.js para verificar el mapeo bloques -> hojas, los
 * presupuestos ni la defensa contra inyeccion de formulas.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: vi.fn(),
    renderPageToCanvas: vi.fn(),
    closePdfDocument: vi.fn(async () => {}),
  };
});

const openPdfDocumentMock = vi.mocked(core.openPdfDocument);
const closePdfDocumentMock = vi.mocked(core.closePdfDocument);

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ *
 * blocksToWorkbook — aislado, sin pdf.js
 * ------------------------------------------------------------------ */

/** Reconstruye un workbook `exceljs` a partir de los bytes generados. */
async function rereadWorkbook(workbook: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buffer = await workbook.xlsx.writeBuffer();
  const reread = new ExcelJS.Workbook();
  // Ver el OJO junto a `workbook.xlsx.load` en `excelToPdf.ts`: el `Buffer`
  // ambiental que fusiona el `index.d.ts` de exceljs 4.4.0 choca con el
  // `Buffer` de @types/node recientes; en runtime ambos son el mismo
  // Buffer de Node y `load` lo acepta sin problema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await reread.xlsx.load(buffer as any);
  return reread;
}

function makeFilledTable(rows: number, cols: number): DocBlock {
  const rowsArr: string[][] = [];
  for (let r = 0; r < rows; r += 1) {
    rowsArr.push(new Array(cols).fill("x"));
  }
  return { type: "table", rows: rowsArr };
}

describe("blocksToWorkbook — src/lib/pdf/pdfToExcel.ts (mapeo bloques -> xlsx en aislamiento)", () => {
  it("crea una hoja 'Tabla N' por cada bloque table (en orden), ignora el resto de bloques, y los valores sobreviven al releer con exceljs", async () => {
    const blocks: DocBlock[] = [
      { type: "heading", level: 1, text: "Encabezado ignorado" },
      {
        type: "table",
        rows: [
          ["Nombre", "Valor"],
          ["ManzanaXYZ", "7"],
          ["PerasXYZ", "5"],
        ],
      },
      { type: "paragraph", text: "parrafo ignorado", bold: false },
      {
        type: "table",
        rows: [
          ["ColA", "ColB", "ColC"],
          ["r1a", "r1b", "r1c"],
        ],
      },
      {
        type: "list",
        items: [{ level: 0, ordered: false, number: 0, text: "item ignorado" }],
      },
      { type: "table", rows: [["Solo"], ["Uno"], ["Fila"]] },
      { type: "pageBreak" },
    ];

    const workbook = await blocksToWorkbook(blocks);
    const reread = await rereadWorkbook(workbook);

    expect(reread.worksheets.map((ws) => ws.name)).toEqual([
      "Tabla 1",
      "Tabla 2",
      "Tabla 3",
    ]);

    const sheet1 = reread.worksheets[0];
    expect(sheet1.getRow(1).getCell(1).value).toBe("Nombre");
    expect(sheet1.getRow(1).getCell(2).value).toBe("Valor");
    expect(sheet1.getRow(2).getCell(1).value).toBe("ManzanaXYZ");
    expect(sheet1.getRow(3).getCell(2).value).toBe("5");

    const sheet2 = reread.worksheets[1];
    expect(sheet2.getRow(1).getCell(3).value).toBe("ColC");
    expect(sheet2.getRow(2).getCell(2).value).toBe("r1b");

    const sheet3 = reread.worksheets[2];
    expect(sheet3.getRow(3).getCell(1).value).toBe("Fila");
  });

  it(
    "una celda cuyo texto empieza con '=', '+', '-' o '@' se escribe como STRING PLANO, nunca como formula viva " +
      "[test defensivo obligatorio del spec: se verifica releyendo con exceljs que cell.type no es Formula y que cell.value es el literal exacto, prefijo incluido]",
    async () => {
      const blocks: DocBlock[] = [
        {
          type: "table",
          rows: [
            ["=SUM(A1:A2)", "+1+1", "-1+2", "@SUM(1)"],
            ["fila2col1", "fila2col2", "fila2col3", "fila2col4"],
          ],
        },
      ];

      const workbook = await blocksToWorkbook(blocks);
      const reread = await rereadWorkbook(workbook);
      const row1 = reread.worksheets[0].getRow(1);

      const dangerousCells = [
        { cell: row1.getCell(1), expected: "=SUM(A1:A2)" },
        { cell: row1.getCell(2), expected: "+1+1" },
        { cell: row1.getCell(3), expected: "-1+2" },
        { cell: row1.getCell(4), expected: "@SUM(1)" },
      ];

      for (const { cell, expected } of dangerousCells) {
        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.value).toBe(expected);
      }
    },
  );

  it(`una celda que supera ${MAX_CELL_CHARS} caracteres se trunca a ese limite con un sufijo "…" honesto, en vez de dejarlo tal cual`, async () => {
    const longText = "L".repeat(40_000);
    const blocks: DocBlock[] = [
      {
        type: "table",
        rows: [
          ["corta", longText],
          ["r2c1", "r2c2"],
        ],
      },
    ];

    const workbook = await blocksToWorkbook(blocks);
    const reread = await rereadWorkbook(workbook);
    const truncated = reread.worksheets[0].getRow(1).getCell(2).value as string;

    expect(truncated.length).toBe(MAX_CELL_CHARS);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.startsWith("L".repeat(100))).toBe(true);
  });

  it("el truncado NO parte un par subrogado UTF-16 a la mitad (Ronda 2 de Codex: un emoji justo en el limite ya no deja un high surrogate suelto)", async () => {
    // Emoji real de 2 code units (high 0xD83D + low 0xDE00) colocado a
    // proposito para que el corte "ingenuo" en MAX_CELL_CHARS-1 caiga
    // justo entre el high y el low surrogate.
    const emoji = String.fromCharCode(0xd83d) + String.fromCharCode(0xde00);
    const filler = "L".repeat(MAX_CELL_CHARS - 2);
    const longText = `${filler}${emoji}MASTEXTO`;
    const blocks: DocBlock[] = [{ type: "table", rows: [[longText]] }];

    const workbook = await blocksToWorkbook(blocks);
    const reread = await rereadWorkbook(workbook);
    const truncated = reread.worksheets[0].getRow(1).getCell(1).value as string;

    // Nunca debe terminar (antes de la elipsis) en un high surrogate
    // suelto (0xD800-0xDBFF) sin su low surrogate emparejado.
    const beforeEllipsis = truncated.slice(0, -1);
    const lastCode = beforeEllipsis.charCodeAt(beforeEllipsis.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    expect(truncated).not.toContain("�");
    expect(truncated.endsWith("…")).toBe(true);
  });

  it(`el volumen ACUMULADO de caracteres de celda por encima de MAX_DOCUMENT_TEXT_CHARS lanza PdfError('tooLarge') (Ronda 2 de Codex: cierra el hueco de MAX_TABLE_CELLS x MAX_CELL_CHARS sin presupuesto de texto real)`, async () => {
    // Muchas celdas, cada una justo en MAX_CELL_CHARS, en cantidad
    // suficiente para superar MAX_DOCUMENT_TEXT_CHARS sin superar
    // MAX_TABLE_CELLS (que solo cuenta CELDAS, no caracteres).
    const cellText = "X".repeat(MAX_CELL_CHARS);
    const rowsNeeded = Math.ceil(MAX_DOCUMENT_TEXT_CHARS / MAX_CELL_CHARS) + 1;
    const rows = Array.from({ length: rowsNeeded }, () => [cellText]);
    const blocks: DocBlock[] = [{ type: "table", rows }];

    await expect(blocksToWorkbook(blocks)).rejects.toMatchObject({
      code: "tooLarge",
    });
  });

  it("sin ningun bloque table lanza PdfError('noTablesFound')", async () => {
    const blocks: DocBlock[] = [
      { type: "heading", level: 1, text: "Solo texto" },
      { type: "paragraph", text: "Sin tablas en este documento.", bold: false },
    ];

    await expect(blocksToWorkbook(blocks)).rejects.toMatchObject({
      code: "noTablesFound",
    });
  });

  it("un array de bloques vacio tambien lanza PdfError('noTablesFound')", async () => {
    await expect(blocksToWorkbook([])).rejects.toMatchObject({
      code: "noTablesFound",
    });
  });

  it(
    "el presupuesto MAX_TABLE_CELLS (200.000) se aplica al TOTAL acumulado de todas las tablas combinadas, no por hoja: dos tablas que combinadas lo superan lanzan PdfError('tooLarge') " +
      "[espejo del mismo caso en excelToPdf.test.ts]",
    async () => {
      const blocks: DocBlock[] = [
        makeFilledTable(300, 500), // 150.000 celdas
        makeFilledTable(300, 300), // + 90.000 = 240.000 > 200.000 combinado
      ];

      await expect(blocksToWorkbook(blocks)).rejects.toMatchObject({
        code: "tooLarge",
      });
    },
  );

  it(`mas de MAX_TABLES_PER_DOCUMENT (${MAX_TABLES_PER_DOCUMENT}) tablas lanza PdfError('tooLarge') aunque cada una sea diminuta y el total de celdas quede muy por debajo de MAX_TABLE_CELLS`, async () => {
    const blocks: DocBlock[] = Array.from(
      { length: MAX_TABLES_PER_DOCUMENT + 1 },
      () => ({
        type: "table" as const,
        rows: [
          ["a", "b"],
          ["c", "d"],
          ["e", "f"],
        ],
      }),
    );

    await expect(blocksToWorkbook(blocks)).rejects.toMatchObject({
      code: "tooLarge",
    });
  });

  it(
    `una fila con mas de EXCEL_MAX_COLUMNS (${EXCEL_MAX_COLUMNS}) columnas lanza PdfError('tooLarge') en vez de dejar pasar la excepcion cruda, sin tipar, que lanza exceljs ` +
      "(\"N is out of bounds. Excel supports columns from 1 to 16384\") al llegar a worksheet.addRow " +
      "[hallazgo real de revision adversarial, reproducido por Codex con exceljs real]",
    async () => {
      const tooWideRow = new Array(EXCEL_MAX_COLUMNS + 1).fill("x");
      const blocks: DocBlock[] = [{ type: "table", rows: [tooWideRow] }];

      await expect(blocksToWorkbook(blocks)).rejects.toMatchObject({
        code: "tooLarge",
      });
    },
  );

  it(
    "una fila de exactamente EXCEL_MAX_COLUMNS columnas (el limite, no por encima) se escribe sin problema: la validacion es '> limite', no '>= limite'",
    async () => {
      const exactRow = new Array(EXCEL_MAX_COLUMNS).fill("x");
      const blocks: DocBlock[] = [{ type: "table", rows: [exactRow] }];

      const workbook = await blocksToWorkbook(blocks);
      const reread = await rereadWorkbook(workbook);
      expect(reread.worksheets[0].getRow(1).getCell(EXCEL_MAX_COLUMNS).value).toBe(
        "x",
      );
    },
  );

  it(
    "el contador de truncados (TruncationCounter) refleja EXACTAMENTE cuantas celdas superaron MAX_CELL_CHARS, ni mas ni menos: algunas celdas largas por debajo del limite, otras por encima, en varias tablas " +
      "[hallazgo real de revision: el truncado silencioso no dejaba ninguna senal agregada verificable]",
    async () => {
      const longEnough = "L".repeat(MAX_CELL_CHARS + 1); // supera el limite -> se trunca
      const exactlyAtLimit = "E".repeat(MAX_CELL_CHARS); // en el limite -> NO se trunca
      const belowLimit = "B".repeat(100); // muy por debajo -> NO se trunca

      const blocks: DocBlock[] = [
        {
          type: "table",
          rows: [
            [longEnough, belowLimit],
            [exactlyAtLimit, longEnough],
          ],
        },
        {
          type: "table",
          rows: [[belowLimit, belowLimit, longEnough]],
        },
      ];

      const counter: TruncationCounter = { count: 0 };
      await blocksToWorkbook(blocks, counter);

      // 2 celdas superan el limite en la primera tabla + 1 en la segunda = 3.
      expect(counter.count).toBe(3);
    },
  );

  it("sin ninguna celda que supere MAX_CELL_CHARS, el contador de truncados queda en 0", async () => {
    const blocks: DocBlock[] = [
      { type: "table", rows: [["corta", "tambien corta"]] },
    ];

    const counter: TruncationCounter = { count: 0 };
    await blocksToWorkbook(blocks, counter);

    expect(counter.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * pdfToExcel — motor completo, pdf.js sustituido
 * ------------------------------------------------------------------ */

type FakeTextItem = {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
};

/** Un fragmento de texto en la posicion de vista (x, viewY) dada, cuerpo `fontSize`. */
function makeCellItem(text: string, x: number, viewY: number, fontSize = 11): FakeTextItem {
  return {
    str: text,
    width: text.length * fontSize * 0.5,
    height: fontSize,
    // viewport.transform de la pagina falsa es [1,0,0,-1,0,792] (identidad
    // en x, voltea y): point.y = 792 - transform[5], asi que transform[5]
    // = 792 - viewY reproduce la posicion de vista deseada.
    transform: [fontSize, 0, 0, -fontSize, x, 792 - viewY],
    fontName: "F1",
  };
}

function makeFakePage(items: FakeTextItem[]) {
  return {
    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({ items, styles: {} }),
    cleanup: vi.fn(),
    commonObjs: { has: () => false },
  };
}

function makeFakeDocument(pages: ReturnType<typeof makeFakePage>[]) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => pages[number - 1]),
    loadingTask: { destroy: vi.fn(async () => {}) },
  };
}

/**
 * Pagina con una tabla real de 2 columnas x 3 filas (cabecera + 2 filas de
 * datos): mismo tipo de geometria (columnas alineadas, huecos que superan
 * `CELL_GAP_RATIO`) que reconoce `tryTable` en `pdfToMarkdown.ts`. No es un
 * doble de la deteccion de tablas — es geometria real que el codigo REAL
 * de `pdfToMarkdown.ts` procesa y reconoce como tabla.
 */
function makeTablePage() {
  const col1 = 72;
  // Bastante mas lejos que cualquier ancho de texto de la columna 1 (la
  // celda mas larga, "ProductoUnoXYZ", ocupa hasta x=149): el hueco real
  // (borde derecho del texto de la columna 1 hasta col2) tiene que superar
  // `CELL_GAP_RATIO * fontSize` (13.2pt) para que `makeLine` la reconozca
  // como una columna nueva y no como un simple espacio entre palabras.
  const col2 = 300;
  return makeFakePage([
    makeCellItem("Nombre", col1, 100),
    makeCellItem("Valor", col2, 100),
    makeCellItem("ProductoUnoXYZ", col1, 130),
    makeCellItem("7", col2, 130),
    makeCellItem("ProductoDosXYZ", col1, 160),
    makeCellItem("5", col2, 160),
  ]);
}

/** Pagina con texto corrido normal, sin ninguna rejilla de columnas: no produce una tabla. */
function makeParagraphOnlyPage() {
  return makeFakePage([
    makeCellItem(
      "Este documento tiene texto corrido normal pero ninguna tabla detectable en absoluto.",
      72,
      100,
    ),
  ]);
}

/**
 * Pagina de un PDF enteramente escaneado: sin ningun `TextItem` (capa de
 * texto vacia). `pdfToExcel` fuerza siempre `ocrFallback: false` (ver el
 * OJO del doc-comment del modulo), asi que `extractMarkdownPages` marca
 * esta pagina con `source: "empty"` (nunca "ocr" — el reconocimiento ni
 * siquiera se intenta) y `buildDocument` no produce ningun bloque para
 * ella: el documento entero queda sin bloques y `extractDocumentBlocks`
 * lanza `PdfError("empty")` el ANTES de que `pdfToExcel` llegue a
 * `blocksToWorkbook`.
 */
function makeScannedPage() {
  return makeFakePage([]);
}

async function rereadBlobAsWorkbook(blob: Blob): Promise<ExcelJS.Workbook> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(bytes as any);
  return workbook;
}

describe("pdfToExcel — src/lib/pdf/pdfToExcel.ts (motor completo, con pdf.js sustituido)", () => {
  it("un PDF sintetico con una tabla real detectable produce un .xlsx con esa tabla en 'Tabla 1'", async () => {
    const document = makeFakeDocument([makeTablePage()]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    const blob = await pdfToExcel(
      new File(["pdf"], "tabla.pdf", { type: "application/pdf" }),
      DEFAULT_PDF_TO_EXCEL_OPTIONS,
    );

    expect(blob.type).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(blob.size).toBeGreaterThan(0);

    const workbook = await rereadBlobAsWorkbook(blob);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["Tabla 1"]);

    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).getCell(1).value).toBe("Nombre");
    expect(sheet.getRow(1).getCell(2).value).toBe("Valor");
    expect(sheet.getRow(2).getCell(1).value).toBe("ProductoUnoXYZ");
    expect(sheet.getRow(2).getCell(2).value).toBe("7");
    expect(sheet.getRow(3).getCell(1).value).toBe("ProductoDosXYZ");
    expect(sheet.getRow(3).getCell(2).value).toBe("5");
    expect(closePdfDocumentMock).toHaveBeenCalledWith(document);
  });

  it("un PDF sintetico sin ninguna tabla (solo texto corrido) lanza PdfError('noTablesFound')", async () => {
    const document = makeFakeDocument([makeParagraphOnlyPage()]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    await expect(
      pdfToExcel(
        new File(["pdf"], "sin-tablas.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_EXCEL_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "noTablesFound" });
  });

  it(
    "un PDF enteramente escaneado (sin capa de texto en ninguna pagina) lanza PdfError('noTablesFound'), NO el 'empty' generico que lanzaria extractDocumentBlocks por su cuenta " +
      "[hallazgo real de revision: antes de este fix, este caso concreto — el principal para el que existe noTablesFound — nunca lo disparaba de verdad]",
    async () => {
      const document = makeFakeDocument([makeScannedPage(), makeScannedPage()]);
      openPdfDocumentMock.mockResolvedValueOnce(document as never);

      await expect(
        pdfToExcel(
          new File(["pdf"], "escaneado.pdf", { type: "application/pdf" }),
          DEFAULT_PDF_TO_EXCEL_OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "noTablesFound" });
    },
  );

  it("un PDF cifrado (openPdfDocument rechaza con PdfError('encrypted')) se propaga tal cual", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("encrypted"));

    await expect(
      pdfToExcel(
        new File(["pdf"], "protegido.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_EXCEL_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("un PDF corrupto (openPdfDocument rechaza con PdfError('corrupt')) se propaga tal cual", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("corrupt"));

    await expect(
      pdfToExcel(
        new File(["pdf"], "basura.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_EXCEL_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("una senal ya cancelada lanza PdfError('cancelled') sin llegar a abrir el documento", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pdfToExcel(
        new File(["pdf"], "cancelado.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_EXCEL_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });

    expect(openPdfDocumentMock).not.toHaveBeenCalled();
  });

  it("PdfError es instanceof PdfError (sanity del tipo de error)", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("corrupt"));
    try {
      await pdfToExcel(
        new File(["pdf"], "basura2.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_EXCEL_OPTIONS,
      );
      throw new Error("deberia haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
    }
  });
});
