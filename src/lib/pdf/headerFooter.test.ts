import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import {
  DEFAULT_HEADER_FOOTER_OPTIONS,
  addHeaderFooter,
  documentBaseName,
  expandHeaderFooterTokens,
  formatBatesLabel,
  hasHeaderFooterContent,
  type HeaderFooterOptions,
} from "@/lib/pdf/headerFooter";

/** Encabezado, pie y Bates: texto estampado (leido con pdf.js «legacy»), posiciones, rangos y errores. */

const FONTS = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`;

async function makePdf(pages = 3, size: [number, number] = [300, 400], rotate = 0): Promise<File> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = document.addPage(size);
    if (rotate) page.setRotation(degrees(rotate));
  }
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], "documento.pdf", { type: "application/pdf" });
}

type Item = { str: string; x: number; y: number; width: number };

async function itemsOf(blob: Blob): Promise<Item[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), standardFontDataUrl: FONTS });
  const document = await task.promise;
  try {
    const pages: Item[][] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .filter((item): item is TextItem => "str" in item && item.str.trim().length > 0)
          .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width })),
      );
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

const base = (patch: Partial<HeaderFooterOptions>): HeaderFooterOptions => ({
  ...DEFAULT_HEADER_FOOTER_OPTIONS,
  header: { left: "", center: "", right: "" },
  footer: { left: "", center: "", right: "" },
  documentName: "informe.pdf",
  date: new Date(2026, 9, 12),
  locale: "es-ES",
  ...patch,
});

describe("marcadores", () => {
  const ctx = { current: 4, total: 9, name: "informe", dateLabel: "12/10/2026", bates: "ABC-0004" };

  it("sustituye {n}, {p}, {fecha}, {nombre} y {bates}", () => {
    expect(expandHeaderFooterTokens("{nombre} · {fecha} · {n}/{p} · {bates}", ctx)).toBe("informe · 12/10/2026 · 4/9 · ABC-0004");
  });

  it("acepta los alias en ingles {date} y {name}", () => {
    expect(expandHeaderFooterTokens("{name} {date}", ctx)).toBe("informe 12/10/2026");
  });

  it("repite un marcador y respeta el texto libre y los marcadores desconocidos", () => {
    expect(expandHeaderFooterTokens("{n}-{n} {otro}", ctx)).toBe("4-4 {otro}");
  });

  it("documentBaseName quita la extension (y solo la ultima)", () => {
    expect(documentBaseName("informe.final.pdf")).toBe("informe.final");
    expect(documentBaseName("sin-extension")).toBe("sin-extension");
    expect(documentBaseName(".oculto")).toBe(".oculto");
    expect(documentBaseName("  a.pdf ")).toBe("a");
  });

  it("formatBatesLabel rellena con ceros, limita las cifras y no admite negativos", () => {
    expect(formatBatesLabel({ prefix: "CASO-", start: 1, digits: 6 }, 123)).toBe("CASO-000123");
    expect(formatBatesLabel({ prefix: "", start: 1, digits: 2 }, 12345)).toBe("12345");
    expect(formatBatesLabel({ prefix: "X", start: 1, digits: 99 }, 5)).toBe("X000000000005");
    expect(formatBatesLabel({ prefix: "X", start: 1, digits: 0 }, 7)).toBe("X7");
    expect(formatBatesLabel({ prefix: "X", start: 1, digits: 3 }, -4)).toBe("X000");
  });

  it("hasHeaderFooterContent ignora los espacios", () => {
    expect(hasHeaderFooterContent(base({}))).toBe(false);
    expect(hasHeaderFooterContent(base({ header: { left: "  ", center: "", right: "" } }))).toBe(false);
    expect(hasHeaderFooterContent(base({ footer: { left: "", center: "x", right: "" } }))).toBe(true);
  });
});

describe("addHeaderFooter", () => {
  it("estampa pie centrado «Pagina n de p» en todas las paginas", async () => {
    const blob = await addHeaderFooter(await makePdf(3), base({ footer: { left: "", center: "Pagina {n} de {p}", right: "" } }));
    const pages = await itemsOf(blob);
    expect(pages.map((items) => items.map((i) => i.str).join(" "))).toEqual(["Pagina 1 de 3", "Pagina 2 de 3", "Pagina 3 de 3"]);
  });

  it("coloca izquierda / centro / derecha de encabezado y pie en su sitio", async () => {
    const blob = await addHeaderFooter(
      await makePdf(1),
      base({
        header: { left: "IZQ", center: "CEN", right: "DER" },
        footer: { left: "iz", center: "ce", right: "de" },
        margin: "recommended",
      }),
    );
    const [items] = await itemsOf(blob);
    const at = (text: string) => items.find((item) => item.str === text)!;
    // Encabezado arriba (y grande), pie abajo (y pequeña).
    expect(at("IZQ").y).toBeGreaterThan(300);
    expect(at("iz").y).toBeLessThan(100);
    // Izquierda < centro < derecha.
    expect(at("IZQ").x).toBeLessThan(at("CEN").x);
    expect(at("CEN").x).toBeLessThan(at("DER").x);
    // Centro: simetrico respecto al eje de la pagina (300 / 2 = 150).
    expect(at("CEN").x + at("CEN").width / 2).toBeCloseTo(150, 0);
    // Derecha: termina a un margen (34 pt) del borde.
    expect(at("DER").x + at("DER").width).toBeCloseTo(300 - 34, 0);
    // Izquierda: empieza a un margen del borde.
    expect(at("IZQ").x).toBeCloseTo(34, 0);
  });

  it("el margen pequeño y el grande cambian la distancia al borde", async () => {
    const small = await itemsOf(await addHeaderFooter(await makePdf(1), base({ footer: { left: "X", center: "", right: "" }, margin: "small" })));
    const large = await itemsOf(await addHeaderFooter(await makePdf(1), base({ footer: { left: "X", center: "", right: "" }, margin: "large" })));
    expect(small[0][0].x).toBeCloseTo(18, 0);
    expect(large[0][0].x).toBeCloseTo(56, 0);
  });

  it("respeta el rango de paginas y numera desde el primer numero indicado", async () => {
    const blob = await addHeaderFooter(
      await makePdf(4),
      base({ footer: { left: "", center: "{n}/{p}", right: "" }, fromPage: 2, toPage: 3, firstNumber: 10 }),
    );
    const pages = await itemsOf(blob);
    expect(pages[0]).toEqual([]);
    expect(pages[1].map((i) => i.str).join("")).toBe("10/11");
    expect(pages[2].map((i) => i.str).join("")).toBe("11/11");
    expect(pages[3]).toEqual([]);
  });

  it("{nombre} usa el archivo sin extension y {fecha} la fecha dada en formato local", async () => {
    const blob = await addHeaderFooter(
      await makePdf(1),
      base({ header: { left: "{nombre}", center: "", right: "{fecha}" }, documentName: "Contrato final.pdf" }),
    );
    const [items] = await itemsOf(blob);
    expect(items.map((i) => i.str)).toContain("Contrato final");
    expect(items.map((i) => i.str)).toContain("12/10/2026");
  });

  it("usa el formato de fecha del idioma (en-US: mes/dia/año)", async () => {
    const blob = await addHeaderFooter(await makePdf(1), base({ footer: { left: "{date}", center: "", right: "" }, locale: "en-US" }));
    expect((await itemsOf(blob))[0][0].str).toBe("10/12/2026");
  });

  it("Bates: un numero unico por pagina, con prefijo y ceros", async () => {
    const blob = await addHeaderFooter(
      await makePdf(3),
      base({ footer: { left: "", center: "", right: "{bates}" }, bates: { prefix: "CASO-", start: 120, digits: 6 } }),
    );
    const pages = await itemsOf(blob);
    expect(pages.map((items) => items[0].str)).toEqual(["CASO-000120", "CASO-000121", "CASO-000122"]);
  });

  it("Bates sigue el rango: empieza en la primera pagina estampada", async () => {
    const blob = await addHeaderFooter(
      await makePdf(3),
      base({ footer: { left: "", center: "{bates}", right: "" }, bates: { prefix: "B", start: 1, digits: 3 }, fromPage: 2 }),
    );
    const pages = await itemsOf(blob);
    expect(pages[0]).toEqual([]);
    expect(pages.slice(1).map((items) => items[0].str)).toEqual(["B001", "B002"]);
  });

  it("sin la opcion Bates el marcador {bates} se queda vacio y no se estampa texto vacio", async () => {
    const blob = await addHeaderFooter(await makePdf(1), base({ footer: { left: "", center: "{bates}", right: "" } }));
    expect((await itemsOf(blob))[0]).toEqual([]);
  });

  it("en una pagina girada 90° el texto queda en el borde inferior VISIBLE", async () => {
    const blob = await addHeaderFooter(await makePdf(1, [300, 400], 90), base({ footer: { left: "", center: "ABAJO", right: "" } }));
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), standardFontDataUrl: FONTS });
    const document = await task.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const item = content.items.find((candidate) => "str" in candidate && candidate.str === "ABAJO")!;
    const [vx, vy] = viewport.convertToViewportPoint((item as { transform: number[] }).transform[4], (item as { transform: number[] }).transform[5]);
    expect(viewport.width).toBe(400);
    // Abajo en la vista: y de pantalla cerca del alto (400 pt de ancho × 300 de alto girado → alto 300).
    expect(vy).toBeGreaterThan(viewport.height - 60);
    expect(vx).toBeGreaterThan(100);
    await task.destroy();
  });

  it("el tamaño y la tipografia se acotan (5..96 pt) sin fallar", async () => {
    const tiny = await addHeaderFooter(await makePdf(1), base({ footer: { left: "x", center: "", right: "" }, fontSize: 1, fontFamily: "courier" }));
    const huge = await addHeaderFooter(await makePdf(1), base({ footer: { left: "x", center: "", right: "" }, fontSize: 900, fontFamily: "times" }));
    expect((await itemsOf(tiny))[0]).toHaveLength(1);
    expect((await itemsOf(huge))[0]).toHaveLength(1);
  });

  it("caracteres fuera de WinAnsi (emoji, chino) no rompen: se sustituyen", async () => {
    const blob = await addHeaderFooter(await makePdf(1), base({ footer: { left: "", center: "Hola 😀 日本", right: "" } }));
    const [items] = await itemsOf(blob);
    expect(items.map((i) => i.str).join("")).toContain("Hola");
  });

  it("sin texto que estampar lanza «nothingSelected»", async () => {
    await expect(addHeaderFooter(await makePdf(1), base({}))).rejects.toMatchObject({ code: "nothingSelected" });
  });

  it("un archivo que no es PDF lanza un error tipado", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "x.pdf", { type: "application/pdf" });
    await expect(addHeaderFooter(file, base({ footer: { left: "x", center: "", right: "" } }))).rejects.toMatchObject({ name: "PdfError" });
  });

  it("informa del progreso de 0 a 1", async () => {
    const seen: number[] = [];
    await addHeaderFooter(await makePdf(3), base({ footer: { left: "x", center: "", right: "" } }), (value) => seen.push(value));
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("conserva el numero de paginas y su tamano", async () => {
    const blob = await addHeaderFooter(await makePdf(5, [210, 297]), base({ header: { left: "", center: "H", right: "" } }));
    const out = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
    expect(out.getPageCount()).toBe(5);
    expect(out.getPage(0).getSize()).toEqual({ width: 210, height: 297 });
  });
});
