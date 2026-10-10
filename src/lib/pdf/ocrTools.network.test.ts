import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import * as core from "@/lib/pdf/core";
import { ocrPdf } from "@/lib/pdf/ocr";
import { pdfToText } from "@/lib/pdf/pdfToText";
import { DEFAULT_OCR_FAILURE_MARKER } from "@/lib/pdf/pdfToMarkdown";

/**
 * Regresion (W6-D): ocr-pdf mostraba el generico «Algo ha fallado» cuando el motor de OCR no cargaba
 * (error de libreria sin clasificar) y no tenia limite de espera; ahora comparte `createOcrWorker`
 * (guarda de 20 s + `ocrNetworkFailure`). Y el aviso de una pagina sin OCR salia siempre en ingles.
 * pdf.js y tesseract.js se sustituyen (no arrancan en Node).
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: vi.fn(),
    renderPageToCanvas: vi.fn(async () => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement),
    closePdfDocument: vi.fn(async () => {}),
    getPdfJs: vi.fn(async () => ({ OPS: {} })),
  };
});

vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(),
  OEM: { LSTM_ONLY: 1 },
}));

function fakePage(text: string) {
  const items = text
    ? [{ str: text, width: text.length * 6, height: 12, transform: [12, 0, 0, -12, 72, 700], fontName: "F1" }]
    : [];
  return {
    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({ items, styles: {} }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    cleanup: vi.fn(),
    commonObjs: { has: () => false },
    view: [0, 0, 612, 792],
    rotate: 0,
  };
}

function fakeDocument(pages: Array<ReturnType<typeof fakePage>>) {
  return { numPages: pages.length, getPage: vi.fn(async (n: number) => pages[n - 1]), loadingTask: { destroy: vi.fn() } };
}

async function pdfFile(pages: number): Promise<File> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage([200, 200]);
  return new File([(await document.save()) as unknown as BlobPart], "doc.pdf", { type: "application/pdf" });
}

const createWorker = async () => vi.mocked((await import("tesseract.js")).createWorker);

describe("ocrPdf — el motor de OCR no carga", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sin red: error 'ocrNetworkFailure' (mensaje claro), no 'unknown'", async () => {
    vi.mocked(core.openPdfDocument).mockResolvedValue(fakeDocument([fakePage("")]) as never);
    (await createWorker()).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(ocrPdf(await pdfFile(1))).rejects.toMatchObject({ code: "ocrNetworkFailure" });
  });

  it("CDN colgada: falla a los 20 s (con temporizadores falsos) en vez de esperar sin limite", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(core.openPdfDocument).mockResolvedValue(fakeDocument([fakePage("")]) as never);
      (await createWorker()).mockImplementation(() => new Promise(() => {}));
      const outcome = ocrPdf(await pdfFile(1)).catch((error: { code?: string }) => error.code);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await outcome).toBe("ocrNetworkFailure");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pdfToText — aviso de OCR no disponible en el idioma de la interfaz", () => {
  beforeEach(() => vi.clearAllMocks());

  async function run(marker?: string) {
    // Pagina de texto + pagina-imagen cuyo OCR falla: el documento no lanza y el aviso va en el .txt.
    vi.mocked(core.openPdfDocument).mockResolvedValue(
      fakeDocument([fakePage("Texto normal de la primera pagina del documento"), fakePage("")]) as never,
    );
    (await createWorker()).mockRejectedValue(new TypeError("Failed to fetch"));
    const blob = await pdfToText(
      await pdfFile(2),
      { ocrFallback: true, pageSeparators: false },
      undefined,
      undefined,
      marker,
    );
    return blob.text();
  }

  it("usa el aviso que pasa la interfaz (es/en)", async () => {
    expect(await run("[OCR no disponible para esta página — comprueba tu conexión]")).toContain(
      "[OCR no disponible para esta página — comprueba tu conexión]",
    );
  });

  it("sin aviso propio, el de por defecto ya no es solo ingles", async () => {
    const text = await run();
    expect(text).toContain(DEFAULT_OCR_FAILURE_MARKER);
    expect(DEFAULT_OCR_FAILURE_MARKER).toContain("OCR no disponible");
  });
});
