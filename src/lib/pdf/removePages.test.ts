import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { removePdfPages, type RemovePagesPlan } from "@/lib/pdf/removePages";
import { PdfError } from "@/lib/pdf/core";

/**
 * `removePdfPages` solo usa `@cantoo/pdf-lib` (sin pdf.js ni canvas), asi
 * que se prueba de extremo a extremo en Node.
 *
 * Igual que en `organize.test.ts`, cada pagina de la fixture tiene un
 * tamano distinto y creciente (100x100, 200x200, ...): como el motor opera
 * `removePage` sobre el propio documento (no reconstruye paginas), el
 * ancho de cada pagina superviviente confirma exactamente cual quedo y
 * cual se fue.
 */
async function documentWithSizedPages(count: number): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) {
    const side = (index + 1) * 100;
    document.addPage([side, side]);
  }
  return document;
}

async function toFile(document: PDFDocument, name = "source.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

async function loadBlob(blob: Blob): Promise<PDFDocument> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function pageSides(document: PDFDocument): number[] {
  return document.getPages().map((page) => page.getWidth());
}

describe("removePdfPages — src/lib/pdf/removePages.ts", () => {
  it("elimina exactamente la pagina pedida y conserva el resto en orden", async () => {
    const file = await toFile(await documentWithSizedPages(5));
    const plan: RemovePagesPlan = { remove: [3] };

    const blob = await removePdfPages(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(4);
    expect(pageSides(result)).toEqual([100, 200, 400, 500]);
  });

  it("elimina varias paginas no contiguas de una sola pasada", async () => {
    const file = await toFile(await documentWithSizedPages(5));
    const plan: RemovePagesPlan = { remove: [2, 4] };

    const blob = await removePdfPages(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(3);
    expect(pageSides(result)).toEqual([100, 300, 500]);
  });

  it("duplicados en la lista de eliminacion cuentan una sola vez", async () => {
    const file = await toFile(await documentWithSizedPages(5));
    const plan: RemovePagesPlan = { remove: [2, 2, 2] };

    const blob = await removePdfPages(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(4);
    expect(pageSides(result)).toEqual([100, 300, 400, 500]);
  });

  it("numeros de pagina fuera de rango (0, negativos, mayores que el total) se ignoran", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    const plan: RemovePagesPlan = { remove: [0, -1, 99, 2] };

    const blob = await removePdfPages(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(pageSides(result)).toEqual([100, 300]);
  });

  it("numeros no enteros se ignoran", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    const plan: RemovePagesPlan = { remove: [1.5, 2] };

    const blob = await removePdfPages(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(pageSides(result)).toEqual([100, 300]);
  });

  it("pedir eliminar todas las paginas lanza PdfError('empty') y no genera un PDF vacio", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    const plan: RemovePagesPlan = { remove: [1, 2, 3] };

    await expect(removePdfPages(file, plan)).rejects.toBeInstanceOf(PdfError);
    await expect(removePdfPages(file, plan)).rejects.toMatchObject({ code: "empty" });
  });

  it("pedir eliminar todas las paginas mas alguna fuera de rango tambien lanza 'empty'", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    const plan: RemovePagesPlan = { remove: [1, 2, 500] };

    await expect(removePdfPages(file, plan)).rejects.toMatchObject({ code: "empty" });
  });

  it("una lista de eliminacion vacia conserva el documento intacto", async () => {
    const file = await toFile(await documentWithSizedPages(3));

    const blob = await removePdfPages(file, { remove: [] });
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(3);
    expect(pageSides(result)).toEqual([100, 200, 300]);
  });

  it("un archivo vacio lanza PdfError('corrupt') antes de tocar ninguna pagina", async () => {
    const empty = new File([], "empty.pdf", { type: "application/pdf" });

    await expect(removePdfPages(empty, { remove: [1] })).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("reporta progreso creciente hasta 1 al terminar", async () => {
    const file = await toFile(await documentWithSizedPages(4));
    const progress: number[] = [];

    await removePdfPages(file, { remove: [2, 3] }, (value) => progress.push(value));

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]);
    }
  });
});
