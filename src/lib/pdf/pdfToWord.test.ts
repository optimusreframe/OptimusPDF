import { beforeEach, describe, expect, it, vi } from "vitest";
import mammoth from "mammoth";
import { Document, Packer } from "docx";
import JSZip from "jszip";
import * as core from "@/lib/pdf/core";
import { PdfError } from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_WORD_OPTIONS,
  blocksToDocxChildren,
  pdfToWord,
} from "@/lib/pdf/pdfToWord";
import type { DocBlock } from "@/lib/pdf/pdfToMarkdown";

/**
 * `pdfToWord.ts` tiene la misma partición en capas que `pdfToMarkdown.ts`:
 *
 *  - PURA: `blocksToDocxChildren` mapea `DocBlock[]` (ya extraídos) a los
 *    nodos de `docx` equivalentes. No toca pdf.js ni el navegador — se
 *    prueba aquí con fixtures construidas a mano.
 *  - NAVEGADOR: `pdfToWord` en sí, que además llama a
 *    `extractDocumentBlocks` (pdf.js). Mismo patrón de sustitución que
 *    `pdfToMarkdown.test.ts`/`pdfToImages.test.ts`: se reemplazan
 *    `openPdfDocument`/`renderPageToCanvas`/`closePdfDocument` de
 *    `@/lib/pdf/core` por dobles controlados y corre el código real de
 *    `extractMarkdownPages`/`buildDocument`/`pdfToWord` sin tocar.
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

/* ------------------------------------------------------------------ *
 * blocksToDocxChildren — mapeo puro DocBlock[] -> nodos de docx
 * ------------------------------------------------------------------ */

/** Bytes de un Blob de docx -> Buffer, para el build de mammoth en Node. */
async function blobToBuffer(blob: Blob): Promise<Buffer> {
  return Buffer.from(new Uint8Array(await blob.arrayBuffer()));
}

async function packAndReread(blocks: DocBlock[]): Promise<string> {
  const children = blocksToDocxChildren(blocks);
  const document = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(document);
  const buffer = await blobToBuffer(blob);
  const result = await mammoth.convertToHtml({ buffer } as never);
  return result.value;
}

describe("blocksToDocxChildren — src/lib/pdf/pdfToWord.ts (mapeo en aislamiento)", () => {
  it("mapea heading/paragraph con bold/lista ordenada+no ordenada anidada/tabla/codeBlock/pageBreak-antes-de-tabla, y todo sobrevive releído con mammoth", async () => {
    const blocks: DocBlock[] = [
      { type: "heading", level: 1, text: "Titulo Principal De Prueba" },
      {
        type: "paragraph",
        text: "Parrafo normal sin negrita XK1.",
        bold: false,
      },
      {
        type: "paragraph",
        text: "Parrafo completo en negrita XK2.",
        bold: true,
      },
      {
        type: "list",
        items: [
          { level: 0, ordered: true, number: 1, text: "Primer paso ordenado XK3" },
          { level: 1, ordered: false, number: 0, text: "Sub punto sin orden XK4" },
          { level: 0, ordered: true, number: 2, text: "Segundo paso ordenado XK5" },
        ],
      },
      { type: "table", rows: [["CeldaA1", "CeldaB1"], ["CeldaA2", "CeldaB2"]] },
      { type: "codeBlock", lines: ["const x = 1;", "  const y = 2;"] },
      { type: "pageBreak" },
      { type: "table", rows: [["CeldaC1", "CeldaC2"], ["CeldaC3", "CeldaC4"]] },
    ];

    const html = await packAndReread(blocks);

    // Titulo: sobrevive como encabezado real (mammoth reconoce el estilo
    // "heading 1" que `docx` asigna a HeadingLevel.HEADING_1).
    expect(html).toMatch(/<h1[^>]*>Titulo Principal De Prueba<\/h1>/);

    // Parrafos: el texto sobrevive, y el que era bold en el DocBlock sale
    // envuelto en <strong> (el que no, no).
    expect(html).toContain("Parrafo normal sin negrita XK1.");
    expect(html).not.toMatch(/<strong>[^<]*Parrafo normal sin negrita XK1/);
    expect(html).toMatch(/<strong>[^<]*Parrafo completo en negrita XK2\.[^<]*<\/strong>/);

    // Lista: el texto de los 3 items sobrevive (la numeracion "1. "/"2. "
    // de los ordenados es texto literal, no numeracion nativa de Word,
    // tal y como especifica el spec de este workstream).
    expect(html).toContain("1. Primer paso ordenado XK3");
    expect(html).toContain("2. Segundo paso ordenado XK5");
    expect(html).toContain("Sub punto sin orden XK4");

    // Tabla: el contenido de las celdas de AMBAS tablas (antes y despues
    // del pageBreak) sobrevive dentro de un <table>.
    expect(html).toMatch(/<table>[\s\S]*CeldaA1[\s\S]*CeldaB1[\s\S]*<\/table>/);
    expect(html).toContain("CeldaA2");
    expect(html).toContain("CeldaB2");
    expect(html).toMatch(/<table>[\s\S]*CeldaC1[\s\S]*CeldaC2[\s\S]*<\/table>/);
    expect(html).toContain("CeldaC3");
    expect(html).toContain("CeldaC4");

    // codeBlock: cada linea sobrevive como texto (con su sangria literal).
    expect(html).toContain("const x = 1;");
    expect(html).toContain("const y = 2;");
  });

  it("una lista vacia no rompe el mapeo (defensivo, aunque buildDocument nunca produce este caso)", () => {
    const blocks: DocBlock[] = [{ type: "list", items: [] }];
    expect(blocksToDocxChildren(blocks)).toEqual([]);
  });

  describe("presupuesto MAX_TABLE_CELLS acumulado sobre TODAS las tablas", () => {
    it("cada tabla individualmente esta bajo el tope, pero la suma combinada lo supera -> PdfError('tooLarge')", () => {
      const columns = 500;
      const rowsPerTable = 250; // 500 x 250 = 125.000 por tabla (bajo 200.000)
      const row = Array.from({ length: columns }, (_, index) => `c${index}`);
      const blocks: DocBlock[] = [
        { type: "table", rows: Array.from({ length: rowsPerTable }, () => row) },
        { type: "table", rows: Array.from({ length: rowsPerTable }, () => row) },
      ];
      // 125.000 x 2 = 250.000 > 200.000 (MAX_TABLE_CELLS).

      expect(() => blocksToDocxChildren(blocks)).toThrowError(
        expect.objectContaining({ code: "tooLarge" }),
      );
    });

    it("lanza el error ANTES de construir ningun nodo (no a medio construir)", () => {
      const columns = 500;
      const rowsPerTable = 250;
      const row = Array.from({ length: columns }, (_, index) => `c${index}`);
      const blocks: DocBlock[] = [
        { type: "heading", level: 1, text: "Este titulo nunca deberia mapearse" },
        { type: "table", rows: Array.from({ length: rowsPerTable }, () => row) },
        { type: "table", rows: Array.from({ length: rowsPerTable }, () => row) },
      ];

      let caught: unknown;
      try {
        blocksToDocxChildren(blocks);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PdfError);
      expect((caught as PdfError).code).toBe("tooLarge");
    });

    it("una tabla normal (pocas filas/columnas) no se ve afectada por el tope", () => {
      const blocks: DocBlock[] = [
        { type: "table", rows: [["A1", "B1"], ["A2", "B2"], ["A3", "B3"]] },
      ];
      expect(() => blocksToDocxChildren(blocks)).not.toThrow();
      expect(blocksToDocxChildren(blocks)).toHaveLength(1);
    });
  });

  describe("sanitizeXmlText aplicado antes de construir nodos docx (Hallazgo 1: XML invalido)", () => {
    /** Extrae `word/document.xml` en crudo de un Blob de docx via jszip. */
    async function extractDocumentXml(blob: Blob): Promise<string> {
      const buffer = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
      const zip = await JSZip.loadAsync(buffer);
      const entry = zip.file("word/document.xml");
      if (!entry) throw new Error("word/document.xml no encontrado en el docx");
      return entry.async("string");
    }

    it("elimina NUL/U+000B/surrogates sueltos (alto y bajo) del XML interno, pero preserva un emoji real (par de surrogates valido) intacto", async () => {
      const nul = String.fromCharCode(0x00);
      const verticalTab = String.fromCharCode(0x0b);
      const loneHighSurrogate = String.fromCharCode(0xd800);
      const loneLowSurrogate = String.fromCharCode(0xdc00);
      // Emoji real (par de surrogates valido: high 0xD83D + low 0xDE00).
      const emoji = String.fromCharCode(0xd83d) + String.fromCharCode(0xde00);

      // Importante: el high y el low surrogate sueltos van separados por
      // "X" para que NO se lean como un par valido -- 0xD800 seguido
      // directamente de 0xDC00 SI formaria un par valido (U+10000), asi
      // que concatenarlos sin nada en medio no probaria el caso "suelto".
      const text =
        `Antes${nul}${verticalTab}${loneHighSurrogate}X${loneLowSurrogate}${emoji}Despues`;

      const blocks: DocBlock[] = [
        { type: "heading", level: 1, text },
        { type: "paragraph", text, bold: false },
        {
          type: "list",
          items: [{ level: 0, ordered: false, number: 0, text }],
        },
        { type: "table", rows: [[text]] },
        { type: "codeBlock", lines: [text] },
      ];

      const children = blocksToDocxChildren(blocks);
      const document = new Document({ sections: [{ children }] });
      const blob = await Packer.toBlob(document);
      const xml = await extractDocumentXml(blob);

      expect(xml).not.toContain(nul);
      expect(xml).not.toContain(verticalTab);
      expect(xml).not.toContain(loneHighSurrogate);
      expect(xml).not.toContain(loneLowSurrogate);

      // El texto que rodea a los caracteres invalidos sobrevive intacto, y
      // el emoji (par valido) NO se destruye junto con los surrogates
      // sueltos -- sobrevive como par completo.
      expect(xml).toContain("Antes");
      expect(xml).toContain("Despues");
      expect(xml).toContain(emoji);

      // Releido con mammoth (recorrido de lectura real, no solo XML crudo):
      // el emoji sigue presente y ningun caracter de control sobrevive.
      const buffer = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
      const html = (await mammoth.convertToHtml({ buffer } as never)).value;
      expect(html).toContain(emoji);
      expect(html).not.toContain(nul);
      expect(html).not.toContain(verticalTab);
    });

    it("elimina los noncharacters U+FFFE/U+FFFF (Ronda 2 de Codex), pero preserva DEL (U+007F), que XML 1.0 SI permite", async () => {
      const nonCharFFFE = String.fromCharCode(0xfffe);
      const nonCharFFFF = String.fromCharCode(0xffff);
      const del = String.fromCharCode(0x7f);
      const text = `Antes${nonCharFFFE}${nonCharFFFF}${del}Despues`;

      const blocks: DocBlock[] = [{ type: "paragraph", text, bold: false }];
      const children = blocksToDocxChildren(blocks);
      const document = new Document({ sections: [{ children }] });
      const blob = await Packer.toBlob(document);
      const xml = await extractDocumentXml(blob);

      expect(xml).not.toContain(nonCharFFFE);
      expect(xml).not.toContain(nonCharFFFF);
      expect(xml).toContain(del);
      expect(xml).toContain("Antes");
      expect(xml).toContain("Despues");
    });
  });

  describe("presupuesto MAX_DOCUMENT_CHARACTERS sobre TODO el texto del documento (Hallazgo 2)", () => {
    it("un documento cuyo volumen total de texto supera el limite -> PdfError('tooLarge'), sin construir ningun nodo docx", () => {
      // Un unico parrafo gigante ya excede el limite el solo: no depende
      // de tablas (a diferencia del presupuesto MAX_TABLE_CELLS de arriba),
      // que es justo el vacio que cubre este hallazgo.
      const hugeText = "x".repeat(5_000_001);
      const blocks: DocBlock[] = [
        { type: "heading", level: 1, text: "Este titulo nunca deberia mapearse" },
        { type: "paragraph", text: hugeText, bold: false },
      ];

      let caught: unknown;
      try {
        blocksToDocxChildren(blocks);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PdfError);
      expect((caught as PdfError).code).toBe("tooLarge");
    });

    it("el volumen se acumula sobre TODOS los bloques (heading + paragraph + list + table + codeBlock), no solo uno", () => {
      const chunk = "y".repeat(1_000_001);
      const blocks: DocBlock[] = [
        { type: "paragraph", text: chunk, bold: false },
        {
          type: "list",
          items: [{ level: 0, ordered: false, number: 0, text: chunk }],
        },
        { type: "table", rows: [[chunk]] },
        { type: "codeBlock", lines: [chunk] },
        { type: "paragraph", text: chunk, bold: false },
      ];
      // 5 x 1.000.001 = 5.000.005 > 5.000.000.

      expect(() => blocksToDocxChildren(blocks)).toThrowError(
        expect.objectContaining({ code: "tooLarge" }),
      );
    });

    it("un documento con texto normal (bien bajo el limite) no se ve afectado", () => {
      const blocks: DocBlock[] = [
        { type: "paragraph", text: "Texto normal de un documento real.", bold: false },
      ];
      expect(() => blocksToDocxChildren(blocks)).not.toThrow();
    });
  });
});

/* ------------------------------------------------------------------ *
 * pdfToWord — motor completo con PDF sintetico (pdf.js sustituido)
 * ------------------------------------------------------------------ */

type FakePdfPage = {
  getViewport: (opts: {
    scale: number;
  }) => { width: number; height: number; transform: number[] };
  getTextContent: () => Promise<{
    items: unknown[];
    styles?: Record<string, unknown>;
  }>;
  cleanup: ReturnType<typeof vi.fn>;
  commonObjs: { has: (name: string) => boolean };
};

type FakePdfDocument = {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
  loadingTask: { destroy: ReturnType<typeof vi.fn> };
};

/** Pagina con una unica linea de texto real (suficiente para no disparar OCR). */
function makeFakePdfPage(text: string): FakePdfPage {
  return {
    getViewport: () => ({
      width: 612,
      height: 792,
      transform: [1, 0, 0, -1, 0, 792],
    }),
    getTextContent: async () => ({
      items: [
        {
          str: text,
          width: text.length * 6,
          height: 12,
          transform: [12, 0, 0, -12, 72, 700],
          fontName: "F1",
        },
      ],
      styles: {},
    }),
    cleanup: vi.fn(),
    commonObjs: { has: () => false },
  };
}

function makeFakePdfDocument(pages: FakePdfPage[]): FakePdfDocument {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => pages[number - 1]),
    loadingTask: { destroy: vi.fn(async () => {}) },
  };
}

function pdfFile(name = "documento.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, {
    type: "application/pdf",
  });
}

describe("pdfToWord — src/lib/pdf/pdfToWord.ts (motor completo, pdf.js sustituido)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extrae, mapea y empaqueta un PDF sintetico de punta a punta: produce un Blob de docx valido y no vacio", async () => {
    const document = makeFakePdfDocument([
      makeFakePdfPage(
        "Este es un parrafo de prueba con texto real de sobra para superar el umbral minimo de pagina de texto del extractor.",
      ),
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    const blob = await pdfToWord(pdfFile(), DEFAULT_PDF_TO_WORD_OPTIONS);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(closePdfDocumentMock).toHaveBeenCalledWith(document);

    // El contenido real tiene que sobrevivir hasta el docx final, no solo
    // "el blob no esta vacio": se relee con mammoth igual que el bloque de
    // pruebas de mapeo de mas arriba.
    const buffer = await blobToBuffer(blob);
    const html = (await mammoth.convertToHtml({ buffer } as never)).value;
    expect(html).toContain("Este es un parrafo de prueba");
  });

  it("reporta progreso hasta 1 al terminar, siempre entre 0 y 1", async () => {
    const document = makeFakePdfDocument([
      makeFakePdfPage(
        "Otro parrafo con texto real de sobra para superar el umbral minimo de pagina de texto.",
      ),
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const seen: number[] = [];

    await pdfToWord(pdfFile(), DEFAULT_PDF_TO_WORD_OPTIONS, (value) =>
      seen.push(value),
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("un PDF sin paginas da PdfError('empty')", async () => {
    const document = makeFakePdfDocument([]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    await expect(
      pdfToWord(pdfFile(), DEFAULT_PDF_TO_WORD_OPTIONS),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("un PDF cifrado (rechazado por pdf.js al abrirlo) propaga PdfError('encrypted')", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("encrypted"));

    await expect(
      pdfToWord(pdfFile(), DEFAULT_PDF_TO_WORD_OPTIONS),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("un PDF corrupto (rechazado por pdf.js al abrirlo) propaga PdfError('corrupt')", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("corrupt"));

    await expect(
      pdfToWord(pdfFile(), DEFAULT_PDF_TO_WORD_OPTIONS),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("una senal ya abortada da PdfError('cancelled') antes de abrir el documento", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pdfToWord(
        pdfFile(),
        DEFAULT_PDF_TO_WORD_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(openPdfDocumentMock).not.toHaveBeenCalled();
  });

  it("DEFAULT_PDF_TO_WORD_OPTIONS: vacio a proposito (Word reflowea, no hay tamano/orientacion/margen que configurar)", () => {
    expect(DEFAULT_PDF_TO_WORD_OPTIONS).toEqual({});
  });
});
