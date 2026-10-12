import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { MAX_BLANK_PAGES, clampBlankPages, createBlankPdf } from "@/app/pdf-pro/create/blankPdf";

describe("clampBlankPages", () => {
  it("ajusta al rango 1..MAX y redondea", () => {
    expect(clampBlankPages(0)).toBe(1);
    expect(clampBlankPages(-5)).toBe(1);
    expect(clampBlankPages(3.6)).toBe(4);
    expect(clampBlankPages(MAX_BLANK_PAGES + 50)).toBe(MAX_BLANK_PAGES);
  });

  it("un valor que no es numero cae a 1", () => {
    expect(clampBlankPages(Number.NaN)).toBe(1);
    expect(clampBlankPages(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("createBlankPdf", () => {
  it("A4 vertical de 3 paginas", async () => {
    const bytes = await createBlankPdf({ size: "a4", orientation: "portrait", pages: 3 });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);
  });

  it("Carta horizontal intercambia ancho y alto", async () => {
    const bytes = await createBlankPdf({ size: "letter", orientation: "landscape", pages: 1 });
    const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
    expect(width).toBe(792);
    expect(height).toBe(612);
  });

  it("el numero de paginas se acota al maximo", async () => {
    const bytes = await createBlankPdf({ size: "a4", orientation: "portrait", pages: 5000 });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(MAX_BLANK_PAGES);
  });

  it("empieza por %PDF y no tiene texto ni imagenes", async () => {
    const bytes = await createBlankPdf({ size: "a4", orientation: "portrait", pages: 1 });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
