import { PDFDocument } from "@cantoo/pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfError } from "@/lib/pdf/core";
import {
  DEFAULT_IMPORT_OPTIONS,
  convertToPdf,
  detectImportKind,
  insertConvertedOperation,
  insertionIndex,
  planWithInsertedPages,
} from "@/app/pdf-pro/create/importConvert";

const converters = vi.hoisted(() => ({ word: vi.fn(), excel: vi.fn(), html: vi.fn() }));
vi.mock("@/lib/pdf/wordToPdf", () => ({ wordToPdf: converters.word }));
vi.mock("@/lib/pdf/excelToPdf", () => ({ excelToPdf: converters.excel }));
vi.mock("@/lib/pdf/htmlToPdf", () => ({ htmlToPdf: converters.html }));

async function pdfOf(pages: number, size: [number, number]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage(size);
  return doc.save();
}
const toBlob = (bytes: Uint8Array) => new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
const sizesOf = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPages().map((page) => `${Math.round(page.getWidth())}x${Math.round(page.getHeight())}`);

beforeEach(async () => {
  converters.word.mockReset();
  converters.excel.mockReset();
  converters.html.mockReset();
  const converted = toBlob(await pdfOf(2, [200, 200]));
  converters.word.mockResolvedValue(converted);
  converters.excel.mockResolvedValue(converted);
  converters.html.mockResolvedValue(converted);
});

const ctx = () => ({ signal: new AbortController().signal, onProgress: vi.fn(), lang: "es" as const });
const file = (name: string, type = "") => new File(["x"], name, { type });

describe("detectImportKind", () => {
  it("por extension", () => {
    expect(detectImportKind(file("a.docx"))).toBe("word");
    expect(detectImportKind(file("a.xlsx"))).toBe("excel");
    expect(detectImportKind(file("a.html"))).toBe("html");
    expect(detectImportKind(file("a.htm"))).toBe("html");
  });

  it("sin distinguir mayusculas", () => {
    expect(detectImportKind(file("A.DOCX"))).toBe("word");
    expect(detectImportKind(file("Hoja.XLSX"))).toBe("excel");
    expect(detectImportKind(file("Pagina.HTML"))).toBe("html");
  });

  it("por tipo MIME cuando el nombre no ayuda", () => {
    expect(detectImportKind(file("sin-extension", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe("word");
    expect(detectImportKind(file("sin-extension", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))).toBe("excel");
    expect(detectImportKind(file("sin-extension", "text/html"))).toBe("html");
  });

  it("los formatos antiguos o ajenos no se reconocen (el motor explica el .doc/.xls)", () => {
    expect(detectImportKind(file("a.doc"))).toBeNull();
    expect(detectImportKind(file("a.xls"))).toBeNull();
    expect(detectImportKind(file("a.pdf", "application/pdf"))).toBeNull();
    expect(detectImportKind(file("a.png", "image/png"))).toBeNull();
    expect(detectImportKind(file("docx"))).toBeNull();
  });
});

describe("insertionIndex", () => {
  it("al principio, al final y despues de una pagina", () => {
    expect(insertionIndex({ at: "start" }, 5)).toBe(0);
    expect(insertionIndex({ at: "end" }, 5)).toBe(5);
    expect(insertionIndex({ at: "after", pageIndex: 1 }, 5)).toBe(2);
  });

  it("se acota al documento", () => {
    expect(insertionIndex({ at: "after", pageIndex: 99 }, 5)).toBe(5);
    expect(insertionIndex({ at: "after", pageIndex: -9 }, 5)).toBe(0);
  });
});

describe("planWithInsertedPages", () => {
  it("el plan conserva las paginas del documento y mete las nuevas en su hueco", () => {
    const plan = planWithInsertedPages(3, 2, 1);
    expect(plan.map((entry) => entry.kind)).toEqual(["existing", "external", "external", "existing", "existing"]);
  });

  it("sin paginas que insertar es un error claro", () => {
    expect(() => planWithInsertedPages(3, 0, 1)).toThrow(PdfError);
  });
});

describe("convertToPdf: cada tipo usa el motor de su herramienta suelta", () => {
  it("word, excel y html", async () => {
    const out = await convertToPdf("word", file("a.docx"), DEFAULT_IMPORT_OPTIONS);
    expect(out.byteLength).toBeGreaterThan(100);
    expect(converters.word).toHaveBeenCalledTimes(1);
    await convertToPdf("excel", file("a.xlsx"), DEFAULT_IMPORT_OPTIONS);
    expect(converters.excel).toHaveBeenCalledTimes(1);
    await convertToPdf("html", file("a.html"), DEFAULT_IMPORT_OPTIONS);
    expect(converters.html).toHaveBeenCalledTimes(1);
  });

  it("las opciones de cada herramienta llegan a su motor", async () => {
    await convertToPdf("excel", file("a.xlsx"), { ...DEFAULT_IMPORT_OPTIONS, excel: { pageSize: "letter", orientation: "portrait", sheet: "first" } });
    expect(converters.excel.mock.calls[0][1]).toEqual({ pageSize: "letter", orientation: "portrait", sheet: "first" });
    await convertToPdf("word", file("a.docx"), { ...DEFAULT_IMPORT_OPTIONS, word: { pageSize: "letter", orientation: "landscape", margin: "large" } });
    expect(converters.word.mock.calls[0][1]).toEqual({ pageSize: "letter", orientation: "landscape", margin: "large" });
  });

  it("los valores por defecto coinciden con los de las herramientas sueltas", async () => {
    const { DEFAULT_WORD_TO_PDF_OPTIONS } = await vi.importActual<typeof import("@/lib/pdf/wordToPdf")>("@/lib/pdf/wordToPdf");
    const { DEFAULT_EXCEL_TO_PDF_OPTIONS } = await vi.importActual<typeof import("@/lib/pdf/excelToPdf")>("@/lib/pdf/excelToPdf");
    const { DEFAULT_HTML_TO_PDF_OPTIONS } = await vi.importActual<typeof import("@/lib/pdf/htmlToPdf")>("@/lib/pdf/htmlToPdf");
    expect(DEFAULT_IMPORT_OPTIONS.word).toEqual(DEFAULT_WORD_TO_PDF_OPTIONS);
    expect(DEFAULT_IMPORT_OPTIONS.excel).toEqual(DEFAULT_EXCEL_TO_PDF_OPTIONS);
    expect(DEFAULT_IMPORT_OPTIONS.html).toEqual(DEFAULT_HTML_TO_PDF_OPTIONS);
  });
});

describe("archivos vacios", () => {
  it("un archivo de 0 bytes es `emptyFile` en los tres tipos, sin llamar al motor", async () => {
    for (const kind of ["word", "excel", "html"] as const) {
      await expect(convertToPdf(kind, new File([], `a.${kind}`), DEFAULT_IMPORT_OPTIONS)).rejects.toMatchObject({ code: "emptyFile" });
    }
    expect(converters.word).not.toHaveBeenCalled();
    expect(converters.excel).not.toHaveBeenCalled();
    expect(converters.html).not.toHaveBeenCalled();
  });
});

describe("insertConvertedOperation", () => {
  async function run(position: Parameters<typeof insertionIndex>[0], kind: "word" | "excel" | "html" = "word") {
    const original = await pdfOf(3, [300, 400]);
    const result = await insertConvertedOperation.run(
      original,
      { file: file("a.docx"), kind, options: DEFAULT_IMPORT_OPTIONS, position, pageCount: 3 },
      ctx(),
    );
    return { result, sizes: await sizesOf(result.bytes) };
  }

  it("al final: 3 paginas del documento y luego las 2 convertidas", async () => {
    const { result, sizes } = await run({ at: "end" });
    expect(sizes).toEqual(["300x400", "300x400", "300x400", "200x200", "200x200"]);
    expect(result.pageCount).toBe(5);
    expect(result.report).toEqual({ added: 2 });
  });

  it("al principio", async () => {
    expect((await run({ at: "start" })).sizes).toEqual(["200x200", "200x200", "300x400", "300x400", "300x400"]);
  });

  it("despues de la pagina 2 (indice 1)", async () => {
    expect((await run({ at: "after", pageIndex: 1 })).sizes).toEqual(["300x400", "300x400", "200x200", "200x200", "300x400"]);
  });

  it("funciona igual con las conversiones de Excel y de HTML", async () => {
    expect((await run({ at: "end" }, "excel")).result.pageCount).toBe(5);
    expect((await run({ at: "end" }, "html")).result.pageCount).toBe(5);
  });

  it("es una operacion de paginas del historial con etiqueta propia", () => {
    expect(insertConvertedOperation).toMatchObject({ id: "insert-converted", kind: "pages", labelKey: "insertConverted" });
  });

  it("el progreso avanza hasta casi el final (el commit lo cierra) y nunca retrocede", async () => {
    const original = await pdfOf(1, [300, 400]);
    const context = ctx();
    await insertConvertedOperation.run(original, { file: file("a.docx"), kind: "word", options: DEFAULT_IMPORT_OPTIONS, position: { at: "end" }, pageCount: 1 }, context);
    const values = context.onProgress.mock.calls.map((call) => call[0] as number);
    expect(values.length).toBeGreaterThan(1);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values[values.length - 1]).toBeLessThanOrEqual(1);
  });

  it("un archivo cifrado o antiguo falla con el error del motor (sin tocar el documento)", async () => {
    converters.word.mockRejectedValueOnce(new PdfError("legacyOfficeFormat"));
    const original = await pdfOf(1, [300, 400]);
    await expect(
      insertConvertedOperation.run(original, { file: file("a.doc"), kind: "word", options: DEFAULT_IMPORT_OPTIONS, position: { at: "end" }, pageCount: 1 }, ctx()),
    ).rejects.toMatchObject({ code: "legacyOfficeFormat" });
  });

  it("una conversion que no devuelve nada es `corrupt`", async () => {
    converters.html.mockResolvedValueOnce(new Blob([]));
    const original = await pdfOf(1, [300, 400]);
    await expect(
      insertConvertedOperation.run(original, { file: file("a.html"), kind: "html", options: DEFAULT_IMPORT_OPTIONS, position: { at: "end" }, pageCount: 1 }, ctx()),
    ).rejects.toMatchObject({ code: "corrupt" });
  });
});
