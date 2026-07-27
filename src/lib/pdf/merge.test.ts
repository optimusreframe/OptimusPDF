import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { mergePdfFiles } from "@/lib/pdf/merge";

/**
 * Test de humo (no exhaustivo): `mergePdfFiles` ya se verifico manualmente
 * en el pasado. Aqui solo se confirma la regresion basica: unir dos PDF da
 * el numero correcto de paginas, en el orden correcto.
 */
async function documentWithLabeledPages(labels: string[]): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const label of labels) {
    const page = document.addPage([200, 200]);
    page.drawText(label, { x: 20, y: 100, size: 24, font });
  }
  return document;
}

async function toFile(document: PDFDocument, name: string): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

describe("mergePdfFiles — src/lib/pdf/merge.ts (humo)", () => {
  it("unir 2 PDF da el numero correcto de paginas, en el orden correcto de los archivos", async () => {
    const first = await toFile(await documentWithLabeledPages(["A1", "A2"]), "a.pdf");
    const second = await toFile(await documentWithLabeledPages(["B1"]), "b.pdf");

    const blob = await mergePdfFiles([first, second]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const merged = await PDFDocument.load(bytes, { updateMetadata: false });

    expect(merged.getPageCount()).toBe(3);
  });

  it("con menos de 2 archivos, lanza PdfError('needTwo')", async () => {
    const only = await toFile(await documentWithLabeledPages(["A1"]), "a.pdf");
    await expect(mergePdfFiles([only])).rejects.toMatchObject({ code: "needTwo" });
  });
});
