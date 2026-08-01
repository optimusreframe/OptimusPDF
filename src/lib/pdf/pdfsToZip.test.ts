import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PdfError } from "@/lib/pdf/core";
import {
  MAX_ZIP_FILES,
  MAX_ZIP_TOTAL_BYTES,
  pdfsToZip,
} from "@/lib/pdf/pdfsToZip";

/**
 * `pdfsToZip` no toca pdf.js ni el DOM (solo `File`/`Blob` + jszip, que
 * funciona igual en Node), asi que este archivo prueba el motor real de
 * punta a punta: no hace falta sustituir nada de `@/lib/pdf/core`.
 */

function pdfFile(name: string, content = "%PDF-1.4 contenido de prueba"): File {
  return new File([content], name, { type: "application/pdf" });
}

describe("pdfsToZip — src/lib/pdf/pdfsToZip.ts", () => {
  it("empaqueta 2+ PDF: el ZIP contiene cada archivo con su nombre y contenido byte a byte identico", async () => {
    const a = pdfFile("a.pdf", "contenido A");
    const b = pdfFile("b.pdf", "contenido B distinto");

    const blob = await pdfsToZip([a, b]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    expect(Object.keys(zip.files).sort()).toEqual(["a.pdf", "b.pdf"]);

    const rereadA = await zip.file("a.pdf")?.async("string");
    const rereadB = await zip.file("b.pdf")?.async("string");
    expect(rereadA).toBe("contenido A");
    expect(rereadB).toBe("contenido B distinto");
  });

  it("nombres duplicados: ambos archivos sobreviven en el zip con nombres distintos", async () => {
    const first = pdfFile("informe.pdf", "version original");
    const second = pdfFile("informe.pdf", "version duplicada");

    const blob = await pdfsToZip([first, second]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["informe (1).pdf", "informe.pdf"]);

    const original = await zip.file("informe.pdf")?.async("string");
    const duplicated = await zip.file("informe (1).pdf")?.async("string");
    expect(original).toBe("version original");
    expect(duplicated).toBe("version duplicada");
  });

  it("tres archivos con el mismo nombre: cada uno recibe un sufijo distinto", async () => {
    const files = [
      pdfFile("doc.pdf", "1"),
      pdfFile("doc.pdf", "2"),
      pdfFile("doc.pdf", "3"),
    ];

    const blob = await pdfsToZip(files);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    expect(Object.keys(zip.files).sort()).toEqual([
      "doc (1).pdf",
      "doc (2).pdf",
      "doc.pdf",
    ]);
  });

  it("con un solo archivo, lanza PdfError('needTwo')", async () => {
    const only = pdfFile("a.pdf");
    await expect(pdfsToZip([only])).rejects.toMatchObject({ code: "needTwo" });
  });

  it("sin archivos, lanza PdfError('empty')", async () => {
    await expect(pdfsToZip([])).rejects.toMatchObject({ code: "empty" });
  });

  it("un archivo que no parece PDF (mime/extension) lanza PdfError('invalidType')", async () => {
    const pdf = pdfFile("a.pdf");
    const notPdf = new File(["hola"], "b.txt", { type: "text/plain" });
    await expect(pdfsToZip([pdf, notPdf])).rejects.toMatchObject({
      code: "invalidType",
    });
  });

  it("cancelacion via AbortSignal: lanza PdfError('cancelled') y no termina de generar el zip", async () => {
    const controller = new AbortController();
    controller.abort();
    const a = pdfFile("a.pdf");
    const b = pdfFile("b.pdf");

    await expect(
      pdfsToZip([a, b], undefined, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reporta progreso creciente hasta 1", async () => {
    const values: number[] = [];
    const a = pdfFile("a.pdf");
    const b = pdfFile("b.pdf");
    const c = pdfFile("c.pdf");

    await pdfsToZip([a, b, c], (value) => values.push(value));

    expect(values.length).toBeGreaterThan(0);
    expect(values[values.length - 1]).toBe(1);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it("mas archivos que MAX_ZIP_FILES lanza PdfError('tooLarge')", async () => {
    const files = Array.from({ length: MAX_ZIP_FILES + 1 }, (_, index) =>
      pdfFile(`f${index}.pdf`, "x"),
    );
    await expect(pdfsToZip(files)).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("tamano total por encima de MAX_ZIP_TOTAL_BYTES lanza PdfError('tooLarge')", async () => {
    const big = "x".repeat(MAX_ZIP_TOTAL_BYTES);
    const a = pdfFile("a.pdf", big);
    const b = pdfFile("b.pdf", "y");
    await expect(pdfsToZip([a, b])).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("PdfError se propaga tal cual (no se envuelve en 'unknown')", async () => {
    const only = pdfFile("a.pdf");
    try {
      await pdfsToZip([only]);
      expect.unreachable("deberia haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
    }
  });
});
