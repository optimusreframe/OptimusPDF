import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import { PdfError } from "@/lib/pdf/core";
import { splitPdf } from "@/lib/pdf/split";

/**
 * Test de humo (no exhaustivo): `splitPdf` ya se verifico manualmente en
 * el pasado. Aqui solo se confirma la regresion basica: dividir por rango
 * da el numero correcto de paginas.
 */
async function documentWithPages(count: number): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) {
    document.addPage([200, 200]);
  }
  return document;
}

async function toFile(document: PDFDocument, name = "source.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

describe("splitPdf — src/lib/pdf/split.ts (humo)", () => {
  it("dividir por un unico rango da un PDF con el numero correcto de paginas", async () => {
    const file = await toFile(await documentWithPages(6));

    const output = await splitPdf(
      file,
      { mode: "ranges", ranges: [{ from: 2, to: 4 }], merge: true },
      "source",
    );

    expect(output.kind).toBe("pdf");
    expect(output.parts).toBe(1);

    const bytes = new Uint8Array(await output.blob.arrayBuffer());
    const result = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(result.getPageCount()).toBe(3);
  });

  it("dividir por rangos separados (sin merge) produce un ZIP con un documento por rango", async () => {
    const file = await toFile(await documentWithPages(6));

    const output = await splitPdf(
      file,
      {
        mode: "ranges",
        ranges: [
          { from: 1, to: 2 },
          { from: 3, to: 6 },
        ],
        merge: false,
      },
      "source",
    );

    expect(output.kind).toBe("zip");
    expect(output.parts).toBe(2);
  });

  it("dos tramos iguales no se pisan en el ZIP: el segundo se llama «… (2).pdf»", async () => {
    const file = await toFile(await documentWithPages(4));
    const output = await splitPdf(
      file,
      {
        mode: "ranges",
        ranges: [
          { from: 1, to: 2 },
          { from: 1, to: 2 },
        ],
        merge: false,
      },
      "source",
    );
    expect(output.kind).toBe("zip");
    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["source-1-2 (2).pdf", "source-1-2.pdf"]);
  });

  it("un plan sin rangos falla con 'nothingSelected', no con 'empty' (el archivo si se cargo)", async () => {
    const file = await toFile(await documentWithPages(6));

    const attempt = splitPdf(
      file,
      { mode: "ranges", ranges: [], merge: true },
      "source",
    );

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => error instanceof PdfError && error.code === "nothingSelected",
    );
  });
});
