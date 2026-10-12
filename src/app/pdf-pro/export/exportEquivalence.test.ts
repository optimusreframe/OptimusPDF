import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@/lib/pdf/core";
import { PdfError, withSuffix } from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/imagesToPdf";
import { pdfToCsv } from "@/lib/pdf/pdfToCsv";
import { pdfToExcel } from "@/lib/pdf/pdfToExcel";
import { pdfToImages } from "@/lib/pdf/pdfToImages";
import { pdfToJson } from "@/lib/pdf/pdfToJson";
import { pdfToMarkdown } from "@/lib/pdf/pdfToMarkdown";
import { pdfToPowerpoint } from "@/lib/pdf/pdfToPowerpoint";
import { pdfToText } from "@/lib/pdf/pdfToText";
import { pdfToWord } from "@/lib/pdf/pdfToWord";
import { PDF_TO_CSV_STRINGS } from "@/app/pdf-to-csv/strings";
import { PDF_TO_EXCEL_STRINGS } from "@/app/pdf-to-excel/strings";
import { STRINGS as PDF_TO_JPG_STRINGS } from "@/app/pdf-to-jpg/strings";
import { PDF_TO_JSON_STRINGS } from "@/app/pdf-to-json/strings";
import { PDF_TO_MARKDOWN_STRINGS } from "@/app/pdf-to-markdown/strings";
import { STRINGS as PDF_TO_POWERPOINT_STRINGS } from "@/app/pdf-to-powerpoint/strings";
import { PDF_TO_TEXT_STRINGS } from "@/app/pdf-to-text/strings";
import { STRINGS as PDF_TO_WORD_STRINGS } from "@/app/pdf-to-word/strings";
import { defaultExportOptions } from "@/app/pdf-pro/export/exportDefaults";
import { runExportFormat } from "@/app/pdf-pro/export/exportRunners";
import type { ExportFormatId, ImagesExportOptions } from "@/app/pdf-pro/export/exportTypes";

/**
 * EQUIVALENCIA: cada exportacion de PDF Pro produce LO MISMO que su herramienta suelta (`/pdf-to-*`) con las mismas
 * opciones sobre el mismo PDF: mismo contenido y mismo nombre de archivo. El PDF se sustituye por uno sintetico (pdf.js
 * y el canvas no existen en Node, igual que en las pruebas de cada motor) y los motores corren de verdad. Aqui "la
 * herramienta suelta" es lo que cada `*Client.tsx` llama: el motor con las opciones por defecto o las elegidas, y
 * `withSuffix(nombre, sufijo del idioma, extension)`.
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
vi.mock("@/lib/pdf/imagesToPdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/imagesToPdf")>();
  return { ...actual, canvasToBlob: vi.fn() };
});

const openPdfDocumentMock = vi.mocked(core.openPdfDocument);
const renderPageToCanvasMock = vi.mocked(core.renderPageToCanvas);
const canvasToBlobMock = vi.mocked(canvasToBlob);

type FakeItem = { str: string; width: number; height: number; transform: number[]; fontName: string };
const item = (text: string, x: number, viewY: number, fontSize = 11): FakeItem => ({
  str: text,
  width: text.length * fontSize * 0.5,
  height: fontSize,
  transform: [fontSize, 0, 0, -fontSize, x, 792 - viewY],
  fontName: "F1",
});

/** Pagina con un parrafo y una tabla de 2 columnas (la misma geometria que usan las pruebas de Excel y CSV). */
function page(label: string) {
  const items = [
    item(`Titulo ${label}`, 72, 60, 18),
    item(`Texto de ${label} para comprobar la equivalencia.`, 72, 90),
    item("Nombre", 72, 140),
    item("Valor", 300, 140),
    item(`ProductoUnoXYZ${label}`, 72, 170),
    item("7", 300, 170),
    item(`ProductoDosXYZ${label}`, 72, 200),
    item("5", 300, 200),
  ];
  return {
    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({ items, styles: {} }),
    cleanup: vi.fn(),
    commonObjs: { has: () => false },
  };
}

function fakeDocument(pages = 3) {
  const list = Array.from({ length: pages }, (_, index) => page(`P${index + 1}`));
  return {
    numPages: pages,
    getPage: vi.fn(async (number: number) => list[number - 1]),
    loadingTask: { destroy: vi.fn(async () => {}) },
  };
}

const FILE = () => new File(["pdf"], "informe.pdf", { type: "application/pdf" });

beforeEach(() => {
  vi.resetAllMocks();
  openPdfDocumentMock.mockImplementation(async () => fakeDocument() as never);
  vi.mocked(core.closePdfDocument).mockImplementation(async () => {});
  renderPageToCanvasMock.mockImplementation(async () => ({ width: 612, height: 792, toDataURL: () => `data:image/jpeg;base64,${"A".repeat(200)}` }) as unknown as HTMLCanvasElement);
  canvasToBlobMock.mockImplementation(async (_canvas, type, quality) => new TextEncoder().encode(`${type}:${quality ?? "-"}`) as unknown as Blob);
});

async function textOf(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

const DATES = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g;

/** Un paquete OOXML/ZIP como mapa nombre -> contenido (las fechas de creacion se igualan: cambian en cada llamada). */
async function zipContents(blob: Blob): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files).sort()) {
    if (zip.files[name].dir) continue;
    const text = await zip.file(name)!.async("string");
    out[name] = text.replace(DATES, "<fecha>");
  }
  return out;
}

const language = "es" as const;
const run = <K extends ExportFormatId>(id: K, options = defaultExportOptions(id)) =>
  runExportFormat(id, { file: FILE(), name: "informe.pdf", language, options, pageCount: 3 });

describe("equivalencia con la herramienta suelta (mismo PDF, mismas opciones)", () => {
  it("texto: mismo contenido y nombre", async () => {
    const s = PDF_TO_TEXT_STRINGS[language];
    const loose = await pdfToText(FILE(), defaultExportOptions("text"), () => {}, undefined, s.ocrFailureMarker);
    const pro = await run("text");
    expect(await textOf(pro.blob)).toBe(await textOf(loose));
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "txt"));
    expect(pro.filename).toBe("informe-texto.txt");
  });

  it("texto con separadores de pagina: la opcion llega al motor", async () => {
    const pro = await run("text", { ocrFallback: true, pageSeparators: true });
    expect(await textOf(pro.blob)).toContain("\f");
    const loose = await pdfToText(FILE(), { ocrFallback: true, pageSeparators: true });
    expect(await textOf(pro.blob)).toBe(await textOf(loose));
  });

  it("markdown: mismo contenido y nombre", async () => {
    const s = PDF_TO_MARKDOWN_STRINGS[language];
    const loose = await pdfToMarkdown(FILE(), defaultExportOptions("markdown"), () => {}, undefined, s.ocrFailureMarker);
    const pro = await run("markdown");
    expect(await textOf(pro.blob)).toBe(await textOf(loose.blob));
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "md"));
  });

  it("markdown con otras opciones (sin titulos, con regla entre paginas)", async () => {
    const options = { ...defaultExportOptions("markdown"), detectHeadings: false, pageSeparators: true };
    const pro = await run("markdown", options);
    const loose = await pdfToMarkdown(FILE(), options, () => {}, undefined, PDF_TO_MARKDOWN_STRINGS[language].ocrFailureMarker);
    expect(await textOf(pro.blob)).toBe(await textOf(loose.blob));
    expect(await textOf(pro.blob)).toContain("---");
  });

  it("json: mismo contenido y nombre", async () => {
    const s = PDF_TO_JSON_STRINGS[language];
    const loose = await pdfToJson(FILE(), defaultExportOptions("json"));
    const pro = await run("json");
    expect(JSON.parse(await textOf(pro.blob))).toEqual(JSON.parse(await textOf(loose)));
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "json"));
  });

  it("csv: mismo contenido, nombre y extension segun el formato", async () => {
    const s = PDF_TO_CSV_STRINGS[language];
    const loose = await pdfToCsv(FILE(), defaultExportOptions("csv"));
    const pro = await run("csv");
    expect(await textOf(pro.blob)).toBe(await textOf(loose));
    expect(await textOf(pro.blob)).toContain("ProductoUnoXYZP1");
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "csv"));
    const asJson = await run("csv", { format: "json", stripRepeated: true });
    expect(asJson.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "json"));
    const jsonText = await textOf(asJson.blob);
    expect(() => JSON.parse(jsonText)).not.toThrow();
  });

  it("excel: mismo paquete .xlsx (hojas y celdas) y nombre", async () => {
    const s = PDF_TO_EXCEL_STRINGS[language];
    const loose = await pdfToExcel(FILE(), defaultExportOptions("excel"));
    const pro = await run("excel");
    expect(await zipContents(pro.blob)).toEqual(await zipContents(loose));
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "xlsx"));
  });

  it("word: mismo paquete .docx (texto y tablas) y nombre", async () => {
    const s = PDF_TO_WORD_STRINGS[language];
    const loose = await pdfToWord(FILE(), defaultExportOptions("word"), () => {}, undefined, s.ocrFailureMarker);
    const pro = await run("word");
    expect(await zipContents(pro.blob)).toEqual(await zipContents(loose));
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "docx"));
  });

  it("powerpoint: mismas diapositivas y nombre", async () => {
    const s = PDF_TO_POWERPOINT_STRINGS[language];
    const loose = await pdfToPowerpoint(FILE(), defaultExportOptions("powerpoint"));
    const pro = await run("powerpoint");
    const a = await zipContents(pro.blob);
    const b = await zipContents(loose);
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(Object.keys(a).filter((name) => /ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3);
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "pptx"));
  });

  it("imagenes (JPG por defecto): mismas imagenes, nombres y zip", async () => {
    const s = PDF_TO_JPG_STRINGS[language];
    const loose = await pdfToImages(new Blob(["pdf"]), { quality: 0.92, scale: 2, namePrefix: s.filePrefix });
    const pro = await run("images");
    expect(await zipContents(pro.blob)).toEqual(await zipContents(loose.blob));
    expect(Object.keys(await zipContents(pro.blob))).toEqual(["pagina-1.jpg", "pagina-2.jpg", "pagina-3.jpg"]);
    expect(pro.filename).toBe(withSuffix("informe.pdf", s.filenameSuffix, "zip"));
  });

  it("todos los formatos con el idioma ingles usan los sufijos y prefijos en ingles", async () => {
    const english = (id: ExportFormatId) => runExportFormat(id, { file: FILE(), name: "report.pdf", language: "en", options: defaultExportOptions(id), pageCount: 3 });
    expect((await english("text")).filename).toBe("report-text.txt");
    expect((await english("word")).filename).toBe("report-word.docx");
    expect((await english("excel")).filename).toBe("report-pdf-to-excel.xlsx");
    expect((await english("csv")).filename).toBe("report-tables.csv");
    expect((await english("markdown")).filename).toBe("report-markdown.md");
    expect((await english("json")).filename).toBe("report-json.json");
    expect((await english("powerpoint")).filename).toBe("report-presentation.pptx");
    const images = await english("images");
    expect(images.filename).toBe("report-images.zip");
    expect(Object.keys(await zipContents(images.blob))).toEqual(["page-1.jpg", "page-2.jpg", "page-3.jpg"]);
  });
});

describe("imagenes: opciones propias de PDF Pro", () => {
  it("PNG: el motor rasteriza a image/png, con extension .png dentro del zip", async () => {
    const pro = await run("images", { ...defaultExportOptions("images"), format: "png" });
    const contents = await zipContents(pro.blob);
    expect(Object.keys(contents)).toEqual(["pagina-1.png", "pagina-2.png", "pagina-3.png"]);
    expect(contents["pagina-1.png"]).toBe("image/png:-");
  });

  it("una sola pagina sale como imagen suelta (.png o .jpg), no como zip", async () => {
    const png = await runExportFormat("images", {
      file: FILE(),
      name: "informe.pdf",
      language,
      options: { ...defaultExportOptions("images"), format: "png", scope: "range", range: "2" },
      pageCount: 3,
    });
    expect(png.filename).toBe("informe-imagenes.png");
    const jpg = await runExportFormat("images", {
      file: FILE(),
      name: "informe.pdf",
      language,
      options: { ...defaultExportOptions("images"), scope: "range", range: "3" },
      pageCount: 3,
    });
    expect(jpg.filename).toBe("informe-imagenes.jpg");
  });

  it("rango: solo esas paginas, con sus numeros reales en el nombre", async () => {
    const pro = await runExportFormat("images", {
      file: FILE(),
      name: "informe.pdf",
      language,
      options: { ...defaultExportOptions("images"), scope: "range", range: "1, 3" },
      pageCount: 3,
    });
    expect(Object.keys(await zipContents(pro.blob))).toEqual(["pagina-1.jpg", "pagina-3.jpg"]);
  });

  it("seleccionadas: las que se pasan (base 0)", async () => {
    const pro = await runExportFormat("images", {
      file: FILE(),
      name: "informe.pdf",
      language,
      options: { ...defaultExportOptions("images"), scope: "selected" },
      selectedPages: [2, 0],
      pageCount: 3,
    });
    expect(Object.keys(await zipContents(pro.blob))).toEqual(["pagina-1.jpg", "pagina-3.jpg"]);
  });

  it("DPI: la escala llega a render y la calidad al JPEG", async () => {
    await runExportFormat("images", {
      file: FILE(),
      name: "informe.pdf",
      language,
      options: { ...defaultExportOptions("images"), scale: 3, quality: 0.7, scope: "range", range: "1" },
      pageCount: 3,
    });
    expect(renderPageToCanvasMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scale: 3, intent: "print" }));
    expect(canvasToBlobMock).toHaveBeenCalledWith(expect.anything(), "image/jpeg", 0.7);
  });

  it("un rango invalido o una seleccion vacia fallan con invalidConfig (la interfaz lo explica antes)", async () => {
    const bad = (options: ImagesExportOptions) =>
      runExportFormat("images", { file: FILE(), name: "informe.pdf", language, options, selectedPages: [], pageCount: 3 });
    await expect(bad({ ...defaultExportOptions("images"), scope: "range", range: "9" })).rejects.toMatchObject({ code: "invalidConfig" });
    await expect(bad({ ...defaultExportOptions("images"), scope: "selected" })).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("cancelar entre pagina y pagina corta con cancelled y no deja imagenes a medias", async () => {
    const controller = new AbortController();
    renderPageToCanvasMock.mockImplementation(async () => {
      controller.abort();
      return { width: 1, height: 1 } as unknown as HTMLCanvasElement;
    });
    await expect(
      runExportFormat("images", { file: FILE(), name: "informe.pdf", language, options: defaultExportOptions("images"), pageCount: 3, signal: controller.signal }),
    ).rejects.toBeInstanceOf(PdfError);
    expect(renderPageToCanvasMock).toHaveBeenCalledTimes(1);
  });
});

describe("errores y cancelacion de los motores", () => {
  it("un PDF sin tablas da `noTablesFound` en Excel y CSV (igual que la herramienta suelta)", async () => {
    openPdfDocumentMock.mockImplementation(async () => {
      const paragraph = {
        getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
        getTextContent: async () => ({ items: [item("Solo un parrafo de texto corrido normal y nada mas aqui.", 72, 100)], styles: {} }),
        cleanup: vi.fn(),
        commonObjs: { has: () => false },
      };
      return { numPages: 1, getPage: vi.fn(async () => paragraph), loadingTask: { destroy: vi.fn(async () => {}) } } as never;
    });
    await expect(run("excel")).rejects.toMatchObject({ code: "noTablesFound" });
    await expect(run("csv")).rejects.toMatchObject({ code: "noTablesFound" });
  });

  it("una señal ya abortada cancela texto, word, excel, csv, markdown, json y powerpoint", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const id of ["text", "word", "excel", "csv", "markdown", "json", "powerpoint"] as const) {
      await expect(
        runExportFormat(id, { file: FILE(), name: "informe.pdf", language, options: defaultExportOptions(id), pageCount: 3, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "cancelled" });
    }
  });

  it("el progreso llega al final (1) en cada formato que lo informa", async () => {
    for (const id of ["text", "word", "excel", "csv", "markdown", "json", "powerpoint", "images"] as const) {
      const seen: number[] = [];
      await runExportFormat(id, { file: FILE(), name: "informe.pdf", language, options: defaultExportOptions(id), pageCount: 3, onProgress: (value) => seen.push(value) });
      expect(seen.length, id).toBeGreaterThan(0);
      expect(Math.max(...seen), id).toBeCloseTo(1, 5);
    }
  });
});
