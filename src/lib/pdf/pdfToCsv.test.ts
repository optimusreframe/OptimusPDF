import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@/lib/pdf/core";
import { PdfError } from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_CSV_OPTIONS,
  blocksToText,
  pdfToCsv,
  tablesToCsv,
  tablesToJson,
} from "@/lib/pdf/pdfToCsv";
import type { DocBlock } from "@/lib/pdf/pdfToMarkdown";

/**
 * `pdfToCsv.ts` reutiliza `extractDocumentBlocks` de `pdfToMarkdown.ts`
 * (que a su vez usa pdf.js) y `extractValidatedTables` de `pdfToExcel.ts`,
 * asi que esta suite sigue el mismo patron de sustitucion que
 * `pdfToExcel.test.ts`: se sustituyen `openPdfDocument`/
 * `renderPageToCanvas`/`closePdfDocument` de `@/lib/pdf/core` por dobles
 * controlados y corre el codigo REAL de `pdfToMarkdown.ts` (deteccion de
 * tablas incluida) y de `pdfToCsv.ts` sobre paginas de pdf.js falsas.
 *
 * La capa `blocksToText`/`tablesToCsv`/`tablesToJson` (pura, sin pdf.js)
 * se prueba aparte, en aislamiento, con `DocBlock[]`/tablas construidas a
 * mano.
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
 * Parser CSV minimo, solo para verificar en los tests que el escapado
 * de tablesToCsv/pdfToCsv se puede re-parsear sin perder datos (RFC 4180:
 * comillas dobles que envuelven un valor con coma/comilla/salto de linea,
 * comillas internas duplicadas).
 * ------------------------------------------------------------------ */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/* ------------------------------------------------------------------ *
 * tablesToCsv / tablesToJson / blocksToText — aislado, sin pdf.js
 * ------------------------------------------------------------------ */

describe("tablesToCsv/tablesToJson — src/lib/pdf/pdfToCsv.ts (serializacion pura)", () => {
  it("una sola tabla se serializa como CSV plano, sin encabezado '# Tabla N' extra", () => {
    const rows = [
      ["Nombre", "Valor"],
      ["Manzana", "7"],
      ["Pera", "5"],
    ];
    const csv = tablesToCsv([rows]);

    expect(csv).not.toContain("# Tabla");
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("2+ tablas construidas a mano -> CSV resultante, re-parseado, coincide con los valores originales (cada tabla precedida de '# Tabla N')", () => {
    const table1 = [
      ["Nombre", "Valor"],
      ["ManzanaXYZ", "7"],
      ["PerasXYZ", "5"],
    ];
    const table2 = [
      ["ColA", "ColB", "ColC"],
      ["r1a", "r1b", "r1c"],
    ];
    const table3 = [["Solo"], ["Uno"], ["Fila"]];

    const csv = tablesToCsv([table1, table2, table3]);
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe("# Tabla 1");
    // Bloque de la tabla 1.
    const table1End = 1 + table1.length;
    expect(parseCsv(lines.slice(1, table1End).join("\r\n"))).toEqual(table1);
    // Linea en blanco entre bloques.
    expect(lines[table1End]).toBe("");
    expect(lines[table1End + 1]).toBe("# Tabla 2");
    const table2Start = table1End + 2;
    const table2End = table2Start + table2.length;
    expect(parseCsv(lines.slice(table2Start, table2End).join("\r\n"))).toEqual(
      table2,
    );
    expect(lines[table2End]).toBe("");
    expect(lines[table2End + 1]).toBe("# Tabla 3");
    const table3Start = table2End + 2;
    expect(parseCsv(lines.slice(table3Start).join("\r\n"))).toEqual(table3);
  });

  it("mismo caso en formato JSON -> JSON.parse del resultado coincide con los valores originales", () => {
    const table1 = [
      ["Nombre", "Valor"],
      ["ManzanaXYZ", "7"],
    ];
    const table2 = [["ColA", "ColB"], ["r1a", "r1b"]];

    const json = tablesToJson([table1, table2]);
    const parsed = JSON.parse(json);

    expect(parsed).toEqual([
      { table: 1, rows: table1 },
      { table: 2, rows: table2 },
    ]);
  });

  it("celda con coma, comilla doble y salto de linea se escapa correctamente: re-parseando el CSV se recupera el valor exacto", () => {
    const rows = [
      ["texto con, coma", 'texto con "comillas"', "texto con\nsalto de linea"],
      ["normal", "tambien normal", "otro mas"],
    ];
    const csv = tablesToCsv([rows]);

    // El campo con coma debe quedar entre comillas.
    expect(csv).toContain('"texto con, coma"');
    // Las comillas internas se duplican.
    expect(csv).toContain('"texto con ""comillas"""');

    expect(parseCsv(csv)).toEqual(rows);
  });

  it("celda con coma/comilla/salto de linea tambien sobrevive intacta en JSON (JSON.parse no necesita escapado CSV)", () => {
    const rows = [["a,b", 'c"d', "e\nf"]];
    const json = tablesToJson([rows]);
    const parsed = JSON.parse(json);

    expect(parsed).toEqual([{ table: 1, rows }]);
  });

  it("cero tablas (blocksToText) lanza PdfError('noTablesFound')", () => {
    const blocks: DocBlock[] = [
      { type: "heading", level: 1, text: "Solo texto" },
      { type: "paragraph", text: "Sin tablas en este documento.", bold: false },
    ];

    expect(() => blocksToText(blocks, "csv")).toThrow(PdfError);
    try {
      blocksToText(blocks, "csv");
      throw new Error("deberia haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
      expect((error as PdfError).code).toBe("noTablesFound");
    }
  });

  it("un array de bloques vacio tambien lanza PdfError('noTablesFound')", () => {
    try {
      blocksToText([], "json");
      throw new Error("deberia haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
      expect((error as PdfError).code).toBe("noTablesFound");
    }
  });

  it("blocksToText con format 'json' produce JSON valido y parseable que coincide con las tablas del documento", () => {
    const blocks: DocBlock[] = [
      { type: "heading", level: 1, text: "Encabezado ignorado" },
      {
        type: "table",
        rows: [
          ["Nombre", "Valor"],
          ["ManzanaXYZ", "7"],
        ],
      },
      { type: "paragraph", text: "parrafo ignorado", bold: false },
    ];

    const json = blocksToText(blocks, "json");
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toEqual([
      {
        table: 1,
        rows: [
          ["Nombre", "Valor"],
          ["ManzanaXYZ", "7"],
        ],
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * pdfToCsv — motor completo, pdf.js sustituido
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
 * datos): misma geometria que `pdfToExcel.test.ts` usa para que
 * `tryTable` en `pdfToMarkdown.ts` la reconozca como tabla de verdad.
 */
function makeTablePage() {
  const col1 = 72;
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

function makeParagraphOnlyPage() {
  return makeFakePage([
    makeCellItem(
      "Este documento tiene texto corrido normal pero ninguna tabla detectable en absoluto.",
      72,
      100,
    ),
  ]);
}

function makeScannedPage() {
  return makeFakePage([]);
}

describe("pdfToCsv — src/lib/pdf/pdfToCsv.ts (motor completo, con pdf.js sustituido)", () => {
  it("un PDF sintetico con una tabla real detectable produce un CSV con esa tabla (format 'csv', default)", async () => {
    const document = makeFakeDocument([makeTablePage()]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    const blob = await pdfToCsv(
      new File(["pdf"], "tabla.pdf", { type: "application/pdf" }),
      DEFAULT_PDF_TO_CSV_OPTIONS,
    );

    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(blob.size).toBeGreaterThan(0);

    const text = await blob.text();
    expect(parseCsv(text)).toEqual([
      ["Nombre", "Valor"],
      ["ProductoUnoXYZ", "7"],
      ["ProductoDosXYZ", "5"],
    ]);
    expect(closePdfDocumentMock).toHaveBeenCalledWith(document);
  });

  it("un PDF sintetico con una tabla real detectable produce JSON valido con esa tabla (format 'json')", async () => {
    const document = makeFakeDocument([makeTablePage()]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    const blob = await pdfToCsv(
      new File(["pdf"], "tabla.pdf", { type: "application/pdf" }),
      { format: "json", stripRepeated: true },
    );

    expect(blob.type).toBe("application/json;charset=utf-8");

    const text = await blob.text();
    expect(JSON.parse(text)).toEqual([
      {
        table: 1,
        rows: [
          ["Nombre", "Valor"],
          ["ProductoUnoXYZ", "7"],
          ["ProductoDosXYZ", "5"],
        ],
      },
    ]);
  });

  it("un PDF sintetico sin ninguna tabla (solo texto corrido) lanza PdfError('noTablesFound')", async () => {
    const document = makeFakeDocument([makeParagraphOnlyPage()]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    await expect(
      pdfToCsv(
        new File(["pdf"], "sin-tablas.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_CSV_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "noTablesFound" });
  });

  it("un PDF enteramente escaneado (sin capa de texto en ninguna pagina) lanza PdfError('noTablesFound'), no el 'empty' generico", async () => {
    const document = makeFakeDocument([makeScannedPage(), makeScannedPage()]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    await expect(
      pdfToCsv(
        new File(["pdf"], "escaneado.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_CSV_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "noTablesFound" });
  });

  it("un PDF cifrado (openPdfDocument rechaza con PdfError('encrypted')) se propaga tal cual", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("encrypted"));

    await expect(
      pdfToCsv(
        new File(["pdf"], "protegido.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_CSV_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("un PDF corrupto (openPdfDocument rechaza con PdfError('corrupt')) se propaga tal cual", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("corrupt"));

    await expect(
      pdfToCsv(
        new File(["pdf"], "basura.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_CSV_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("una senal ya cancelada lanza PdfError('cancelled') sin llegar a abrir el documento", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pdfToCsv(
        new File(["pdf"], "cancelado.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_CSV_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });

    expect(openPdfDocumentMock).not.toHaveBeenCalled();
  });

  it("PdfError es instanceof PdfError (sanity del tipo de error)", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("corrupt"));
    try {
      await pdfToCsv(
        new File(["pdf"], "basura2.pdf", { type: "application/pdf" }),
        DEFAULT_PDF_TO_CSV_OPTIONS,
      );
      throw new Error("deberia haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
    }
  });
});
