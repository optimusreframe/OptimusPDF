import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@/lib/pdf/core";
import { PdfError } from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_TEXT_OPTIONS,
  buildPlainText,
  pdfToText,
} from "@/lib/pdf/pdfToText";
import type { MarkdownPage } from "@/lib/pdf/pdfToMarkdown";

/**
 * `pdfToText.ts` tiene la misma particion en capas que `pdfToWord.ts`:
 *
 *  - PURA: `buildPlainText` mapea `MarkdownPage[]` (ya extraidas) a texto
 *    plano. No toca pdf.js ni el navegador -- se prueba aqui con fixtures
 *    construidas a mano.
 *  - NAVEGADOR: `pdfToText` en si, que ademas llama a
 *    `extractMarkdownPages` (pdf.js). Mismo patron de sustitucion que
 *    `pdfToWord.test.ts`/`pdfToImages.test.ts`: se reemplazan
 *    `openPdfDocument`/`renderPageToCanvas`/`closePdfDocument` de
 *    `@/lib/pdf/core` por dobles controlados y corre el codigo real de
 *    `extractMarkdownPages`/`buildPlainText`/`pdfToText` sin tocar.
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
 * buildPlainText — mapeo puro MarkdownPage[] -> texto plano
 * ------------------------------------------------------------------ */

function textPage(pageNumber: number, itemsText: string[]): MarkdownPage {
  return {
    pageNumber,
    width: 612,
    height: 792,
    source: "text",
    items: itemsText.map((text, index) => ({
      text,
      x: 72,
      y: 100 + index * 20,
      width: text.length * 6,
      fontSize: 12,
      bold: false,
      italic: false,
      monospace: false,
    })),
  };
}

function ocrPage(
  pageNumber: number,
  ocrText: string,
  source: "ocr" | "ocrFailed" = "ocr",
): MarkdownPage {
  return {
    pageNumber,
    width: 612,
    height: 792,
    source,
    items: [],
    ocrText,
  };
}

function emptyPage(pageNumber: number): MarkdownPage {
  return {
    pageNumber,
    width: 612,
    height: 792,
    source: "empty",
    items: [],
  };
}

describe("buildPlainText — src/lib/pdf/pdfToText.ts (mapeo en aislamiento)", () => {
  it("una pagina de texto normal con varias lineas se concatena sin ningun artefacto de Markdown", () => {
    const pages: MarkdownPage[] = [
      textPage(1, ["# esto no es un titulo"]),
      textPage(2, ["- esto no es una lista"]),
    ];
    // Dos lineas en filas distintas (y separadas mas de la tolerancia de
    // linea base) para forzar que `buildLines` las trate como lineas
    // independientes dentro de la misma pagina.
    pages[0].items.push({
      text: "| esto tampoco es una tabla |",
      x: 72,
      y: 300,
      width: 200,
      fontSize: 12,
      bold: false,
      italic: false,
      monospace: false,
    });

    const text = buildPlainText(pages, DEFAULT_PDF_TO_TEXT_OPTIONS);

    // El texto literal del PDF (que por casualidad empieza con
    // caracteres que Markdown trataria como sintaxis) sobrevive TAL CUAL,
    // sin que el motor lo escape como haria `escapeInline` en
    // `pdfToMarkdown.ts`.
    expect(text).toContain("# esto no es un titulo");
    expect(text).toContain("- esto no es una lista");
    expect(text).toContain("| esto tampoco es una tabla |");
    expect(text).not.toContain("\\#");
    expect(text).not.toContain("\\-");
    // El motor no debe SINTETIZAR estructura Markdown propia: nada de
    // fila separadora de tabla GFM ni valla de bloque de codigo, que es
    // justo lo que las heuristicas de `pdfToMarkdown.ts` generarian a
    // partir de la misma geometria.
    expect(text).not.toMatch(/^\s*\|?\s*-{3,}\s*\|/m);
    expect(text).not.toMatch(/^\s*```/m);
  });

  it("paginas de texto normal en varias paginas -> el texto de cada una aparece en el resultado", () => {
    const pages: MarkdownPage[] = [
      textPage(1, ["Contenido de la primera pagina."]),
      textPage(2, ["Contenido de la segunda pagina."]),
      textPage(3, ["Contenido de la tercera pagina."]),
    ];

    const text = buildPlainText(pages, DEFAULT_PDF_TO_TEXT_OPTIONS);

    expect(text).toContain("Contenido de la primera pagina.");
    expect(text).toContain("Contenido de la segunda pagina.");
    expect(text).toContain("Contenido de la tercera pagina.");
    // Orden preservado.
    expect(text.indexOf("primera")).toBeLessThan(text.indexOf("segunda"));
    expect(text.indexOf("segunda")).toBeLessThan(text.indexOf("tercera"));
  });

  it("paginas OCR (source 'ocr') usan ocrText tal cual, sin pasar por buildLines", () => {
    const pages: MarkdownPage[] = [
      ocrPage(1, "Texto reconocido por OCR en la pagina uno."),
    ];
    const text = buildPlainText(pages, DEFAULT_PDF_TO_TEXT_OPTIONS);
    expect(text).toContain("Texto reconocido por OCR en la pagina uno.");
  });

  it("paginas 'ocrFailed' usan el aviso de fallo tal cual", () => {
    const pages: MarkdownPage[] = [
      ocrPage(1, "[OCR unavailable for this page]", "ocrFailed"),
    ];
    const text = buildPlainText(pages, DEFAULT_PDF_TO_TEXT_OPTIONS);
    expect(text).toContain("[OCR unavailable for this page]");
  });

  it("pageSeparators: false -> las paginas se unen con un doble salto de linea, sin separador visible", () => {
    const pages: MarkdownPage[] = [
      textPage(1, ["Pagina uno."]),
      textPage(2, ["Pagina dos."]),
    ];
    const text = buildPlainText(pages, {
      ...DEFAULT_PDF_TO_TEXT_OPTIONS,
      pageSeparators: false,
    });
    expect(text).toBe("Pagina uno.\n\nPagina dos.");
  });

  it("pageSeparators: true -> aparece un separador de form feed entre paginas", () => {
    const pages: MarkdownPage[] = [
      textPage(1, ["Pagina uno."]),
      textPage(2, ["Pagina dos."]),
    ];
    const text = buildPlainText(pages, {
      ...DEFAULT_PDF_TO_TEXT_OPTIONS,
      pageSeparators: true,
    });
    expect(text).toContain("\f");
    expect(text).toBe("Pagina uno.\fPagina dos.");
  });

  it("una pagina vacia en medio del documento no rompe nada: no aporta texto, las paginas alrededor sobreviven", () => {
    const pages: MarkdownPage[] = [
      textPage(1, ["Antes de la pagina vacia."]),
      emptyPage(2),
      textPage(3, ["Despues de la pagina vacia."]),
    ];
    const text = buildPlainText(pages, DEFAULT_PDF_TO_TEXT_OPTIONS);
    expect(text).toContain("Antes de la pagina vacia.");
    expect(text).toContain("Despues de la pagina vacia.");
  });

  it("un documento sin ninguna pagina produce cadena vacia (pdfToText es quien decide lanzar PdfError('empty'))", () => {
    expect(buildPlainText([], DEFAULT_PDF_TO_TEXT_OPTIONS)).toBe("");
    expect(buildPlainText([emptyPage(1)], DEFAULT_PDF_TO_TEXT_OPTIONS)).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * pdfToText — motor completo con PDF sintetico (pdf.js sustituido)
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

/** Pagina sin ningun contenido de texto real (por debajo del umbral de pagina de texto). */
function makeFakeBlankPdfPage(): FakePdfPage {
  return {
    getViewport: () => ({
      width: 612,
      height: 792,
      transform: [1, 0, 0, -1, 0, 792],
    }),
    getTextContent: async () => ({ items: [], styles: {} }),
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

describe("pdfToText — src/lib/pdf/pdfToText.ts (motor completo, pdf.js sustituido)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extrae y concatena un PDF sintetico de varias paginas: produce un Blob de texto plano con el contenido esperado", async () => {
    const document = makeFakePdfDocument([
      makeFakePdfPage(
        "Este es un parrafo de prueba con texto real de sobra para superar el umbral minimo de pagina de texto del extractor.",
      ),
      makeFakePdfPage(
        "Segunda pagina con su propio texto real de sobra para superar el umbral minimo tambien.",
      ),
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    const blob = await pdfToText(pdfFile(), DEFAULT_PDF_TO_TEXT_OPTIONS);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(closePdfDocumentMock).toHaveBeenCalledWith(document);

    const text = await blob.text();
    expect(text).toContain("Este es un parrafo de prueba");
    expect(text).toContain("Segunda pagina con su propio texto");
    // Nada de sintaxis Markdown introducida por el motor.
    expect(text).not.toMatch(/^#{1,6}\s/m);
    expect(text).not.toMatch(/^\s*\|.*\|\s*$/m);
  });

  it("pageSeparators: true propaga el separador de form feed hasta el Blob final", async () => {
    const document = makeFakePdfDocument([
      makeFakePdfPage(
        "Primera pagina con texto real de sobra para superar el umbral minimo del extractor.",
      ),
      makeFakePdfPage(
        "Segunda pagina con texto real de sobra para superar el umbral minimo tambien.",
      ),
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    const blob = await pdfToText(pdfFile(), {
      ...DEFAULT_PDF_TO_TEXT_OPTIONS,
      pageSeparators: true,
    });
    const text = await blob.text();
    expect(text).toContain("\f");
  });

  it("una pagina en blanco en medio del documento (sin OCR) no rompe la conversion: las demas paginas siguen presentes", async () => {
    const document = makeFakePdfDocument([
      makeFakePdfPage(
        "Contenido real de la primera pagina, de sobra para superar el umbral minimo.",
      ),
      makeFakeBlankPdfPage(),
      makeFakePdfPage(
        "Contenido real de la tercera pagina, de sobra para superar el umbral minimo.",
      ),
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    const blob = await pdfToText(pdfFile(), {
      ...DEFAULT_PDF_TO_TEXT_OPTIONS,
      ocrFallback: false,
    });
    const text = await blob.text();
    expect(text).toContain("Contenido real de la primera pagina");
    expect(text).toContain("Contenido real de la tercera pagina");
  });

  it("un documento completamente vacio (todas las paginas en blanco, sin OCR) da PdfError('empty')", async () => {
    const document = makeFakePdfDocument([
      makeFakeBlankPdfPage(),
      makeFakeBlankPdfPage(),
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    await expect(
      pdfToText(pdfFile(), { ...DEFAULT_PDF_TO_TEXT_OPTIONS, ocrFallback: false }),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("un PDF sin paginas da PdfError('empty')", async () => {
    const document = makeFakePdfDocument([]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    await expect(
      pdfToText(pdfFile(), DEFAULT_PDF_TO_TEXT_OPTIONS),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("un PDF cifrado (rechazado por pdf.js al abrirlo) propaga PdfError('encrypted')", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("encrypted"));

    await expect(
      pdfToText(pdfFile(), DEFAULT_PDF_TO_TEXT_OPTIONS),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("un PDF corrupto (rechazado por pdf.js al abrirlo) propaga PdfError('corrupt')", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("corrupt"));

    await expect(
      pdfToText(pdfFile(), DEFAULT_PDF_TO_TEXT_OPTIONS),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("una senal ya abortada da PdfError('cancelled') antes de abrir el documento", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pdfToText(
        pdfFile(),
        DEFAULT_PDF_TO_TEXT_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(openPdfDocumentMock).not.toHaveBeenCalled();
  });

  it("reporta progreso hasta 1 al terminar, siempre entre 0 y 1", async () => {
    const document = makeFakePdfDocument([
      makeFakePdfPage(
        "Un parrafo con texto real de sobra para superar el umbral minimo de pagina de texto.",
      ),
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const seen: number[] = [];

    await pdfToText(pdfFile(), DEFAULT_PDF_TO_TEXT_OPTIONS, (value) =>
      seen.push(value),
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
