import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@/lib/pdf/core";
import { PdfError } from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_JSON_OPTIONS,
  pdfToJson,
} from "@/lib/pdf/pdfToJson";
import {
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  extractDocumentBlocks,
} from "@/lib/pdf/pdfToMarkdown";

/**
 * `pdfToJson.ts` no tiene capa PURA propia: reutiliza
 * `extractDocumentBlocks` de `pdfToMarkdown.ts` tal cual y solo serializa
 * el `DocumentBuildResult` resultante con `JSON.stringify`. Por eso esta
 * suite no reinventa la heuristica de extraccion (eso ya lo prueba
 * `pdfToMarkdown.test.ts`): compara el JSON producido directamente contra
 * lo que produce `extractDocumentBlocks` para el MISMO PDF sintetico.
 *
 * Mismo patron de mockeo que `pdfToWord.test.ts`/`pdfToText.test.ts`:
 * `openPdfDocument`/`renderPageToCanvas`/`closePdfDocument` de
 * `@/lib/pdf/core` sustituidos por dobles controlados, y el codigo real de
 * `extractMarkdownPages`/`buildDocument`/`pdfToJson` corre sin tocar.
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

/** Fabrica una pagina sintetica con lineas de texto ya posicionadas. */
function makeFakePdfPage(
  items: {
    text: string;
    x: number;
    y: number;
    size?: number;
    bold?: boolean;
  }[],
): FakePdfPage {
  return {
    getViewport: () => ({
      width: 612,
      height: 792,
      transform: [1, 0, 0, -1, 0, 792],
    }),
    getTextContent: async () => ({
      items: items.map((item) => {
        const size = item.size ?? 11;
        return {
          str: item.text,
          width: item.text.length * size * 0.5,
          height: size,
          transform: [size, 0, 0, -size, item.x, 792 - item.y],
          fontName: item.bold ? "Bold" : "Normal",
        };
      }),
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

describe("pdfToJson — src/lib/pdf/pdfToJson.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("un PDF con titulo/parrafo/lista/tabla produce un JSON valido cuyo array `blocks` coincide con lo que produce extractDocumentBlocks para el mismo input", async () => {
    // Titulo (cuerpo grande), parrafo, dos items de lista, y una tabla
    // regular de 3 filas x 2 columnas -- suficiente para disparar cada
    // rama de `pageBlocks`.
    const page = makeFakePdfPage([
      { text: "Titulo Principal", x: 72, y: 40, size: 24 },
      {
        text: "Este es un parrafo de prueba con texto real de sobra para superar el umbral minimo de pagina de texto del extractor y que no se confunda con un titulo.",
        x: 72,
        y: 100,
        size: 11,
      },
      { text: "- Primer item de lista", x: 72, y: 140, size: 11 },
      { text: "- Segundo item de lista", x: 72, y: 160, size: 11 },
      { text: "ColA", x: 72, y: 200, size: 11 },
      { text: "ColB", x: 300, y: 200, size: 11 },
      { text: "Fila1A", x: 72, y: 220, size: 11 },
      { text: "Fila1B", x: 300, y: 220, size: 11 },
      { text: "Fila2A", x: 72, y: 240, size: 11 },
      { text: "Fila2B", x: 300, y: 240, size: 11 },
    ]);
    const documentA = makeFakePdfDocument([page]);
    const documentB = makeFakePdfDocument([page]);

    openPdfDocumentMock.mockResolvedValueOnce(documentA as never);
    const blob = await pdfToJson(pdfFile(), DEFAULT_PDF_TO_JSON_OPTIONS);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");

    const text = await blob.text();
    const parsed = JSON.parse(text) as { blocks: unknown[]; stats: unknown };
    expect(Array.isArray(parsed.blocks)).toBe(true);
    expect(parsed.blocks.length).toBeGreaterThan(0);

    // Comparacion directa contra lo que produciria extractDocumentBlocks
    // para el MISMO PDF sintetico (mismo mock, invocado por separado).
    openPdfDocumentMock.mockResolvedValueOnce(documentB as never);
    const expected = await extractDocumentBlocks(
      pdfFile(),
      { ...DEFAULT_PDF_TO_MARKDOWN_OPTIONS, ocrFallback: true },
    );
    expect(parsed).toEqual(JSON.parse(JSON.stringify(expected)));

    // Tipos esperados presentes: titulo, parrafo, lista y tabla.
    const types = (parsed.blocks as { type: string }[]).map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("list");
    expect(types).toContain("table");

    expect(closePdfDocumentMock).toHaveBeenCalledWith(documentA);
  });

  it("reporta progreso hasta 1 al terminar, siempre entre 0 y 1", async () => {
    const page = makeFakePdfPage([
      {
        text: "Parrafo con texto real de sobra para superar el umbral minimo de pagina de texto.",
        x: 72,
        y: 100,
        size: 11,
      },
    ]);
    openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([page]) as never);
    const seen: number[] = [];

    await pdfToJson(pdfFile(), DEFAULT_PDF_TO_JSON_OPTIONS, (value) =>
      seen.push(value),
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("un documento completamente vacio (sin paginas) da PdfError('empty')", async () => {
    const document = makeFakePdfDocument([]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);

    await expect(
      pdfToJson(pdfFile(), DEFAULT_PDF_TO_JSON_OPTIONS),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("un PDF con una unica pagina sin ningun texto da PdfError('empty')", async () => {
    const page = makeFakePdfPage([]);
    openPdfDocumentMock.mockResolvedValueOnce(
      makeFakePdfDocument([page]) as never,
    );

    await expect(
      pdfToJson(pdfFile(), { ocrFallback: false }),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("un PDF cifrado (rechazado por pdf.js al abrirlo) propaga PdfError('encrypted')", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("encrypted"));

    await expect(
      pdfToJson(pdfFile(), DEFAULT_PDF_TO_JSON_OPTIONS),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("un PDF corrupto (rechazado por pdf.js al abrirlo) propaga PdfError('corrupt')", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new PdfError("corrupt"));

    await expect(
      pdfToJson(pdfFile(), DEFAULT_PDF_TO_JSON_OPTIONS),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("una senal ya abortada da PdfError('cancelled') antes de abrir el documento", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pdfToJson(
        pdfFile(),
        DEFAULT_PDF_TO_JSON_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(openPdfDocumentMock).not.toHaveBeenCalled();
  });

  it("el JSON producido es valido y re-parseable incluso con comillas, backslashes y saltos de linea en el texto", async () => {
    const tricky =
      'Texto con "comillas", una \\barra invertida\\ y un\nsalto de linea real, mas de sobra para superar el umbral minimo de pagina de texto del extractor.';
    const page = makeFakePdfPage([{ text: tricky, x: 72, y: 100, size: 11 }]);
    openPdfDocumentMock.mockResolvedValueOnce(
      makeFakePdfDocument([page]) as never,
    );

    const blob = await pdfToJson(pdfFile(), DEFAULT_PDF_TO_JSON_OPTIONS);
    const text = await blob.text();

    // JSON.parse no debe lanzar: confirma que el JSON no quedo truncado ni
    // corrompido por los caracteres especiales del texto original.
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text) as { blocks: { text?: string }[] };
    const paragraph = parsed.blocks.find((block) => block.text);
    expect(paragraph?.text).toContain('"comillas"');
    expect(paragraph?.text).toContain("barra invertida");
  });
});
