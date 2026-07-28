import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { organizePdf, type OrganizePage } from "@/lib/pdf/organize";
import { PdfError } from "@/lib/pdf/core";

/**
 * `organizePdf` no toca pdf.js ni canvas (solo `@cantoo/pdf-lib`), asi que
 * se puede probar de extremo a extremo en Node, igual que
 * `unlock.test.ts` / `protect.test.ts`.
 *
 * Las paginas de las fixtures usan tamanos DISTINTOS y crecientes
 * (100x100, 200x200, ...) para servir de "identidad" verificable: como
 * `organizePdf` nunca redimensiona, el tamano de cada pagina de salida
 * delata de que pagina original viene, sin depender de extraccion de
 * texto (que pdf-lib no ofrece).
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

/** Lado (ancho) de cada pagina, en el orden en que aparecen en el documento. */
function pageSides(document: PDFDocument): number[] {
  return document.getPages().map((page) => page.getWidth());
}

describe("organizePdf — src/lib/pdf/organize.ts", () => {
  it("reordena paginas segun el plan (orden invertido de 2 de 3)", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    const plan: OrganizePage[] = [
      { page: 3, rotation: 0 },
      { page: 1, rotation: 0 },
    ];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(pageSides(result)).toEqual([300, 100]);
  });

  it("un plan vacio deja el documento intacto, en el orden original", async () => {
    const file = await toFile(await documentWithSizedPages(3));

    const blob = await organizePdf(file, []);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(3);
    expect(pageSides(result)).toEqual([100, 200, 300]);
  });

  it("omitir un numero de pagina del plan la elimina del resultado", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    // Solo se listan las paginas 1 y 3: la 2 (200x200) queda fuera.
    const plan: OrganizePage[] = [
      { page: 1, rotation: 0 },
      { page: 3, rotation: 0 },
    ];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(pageSides(result)).toEqual([100, 300]);
  });

  it("duplicar un numero de pagina en el plan la duplica en la salida", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    const plan: OrganizePage[] = [
      { page: 1, rotation: 0 },
      { page: 1, rotation: 0 },
    ];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(pageSides(result)).toEqual([100, 100]);
  });

  it("la rotacion del plan se SUMA a la rotacion original de la pagina", async () => {
    const document = await documentWithSizedPages(1);
    document.getPage(0).setRotation(degrees(90));
    const file = await toFile(document);

    const blob = await organizePdf(file, [{ page: 1, rotation: 90 }]);
    const result = await loadBlob(blob);

    expect(result.getPage(0).getRotation().angle).toBe(180);
  });

  it("una rotacion de 0 grados no toca la rotacion original", async () => {
    const document = await documentWithSizedPages(1);
    document.getPage(0).setRotation(degrees(270));
    const file = await toFile(document);

    const blob = await organizePdf(file, [{ page: 1, rotation: 0 }]);
    const result = await loadBlob(blob);

    expect(result.getPage(0).getRotation().angle).toBe(270);
  });

  it("numeros de pagina fuera de rango (0, negativos, mayores que el total) se descartan del plan", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    const plan: OrganizePage[] = [
      { page: 0, rotation: 0 },
      { page: -1, rotation: 0 },
      { page: 99, rotation: 0 },
      { page: 2, rotation: 0 },
    ];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(1);
    expect(pageSides(result)).toEqual([200]);
  });

  it("un plan cuyas paginas son TODAS invalidas lanza PdfError('empty')", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    const plan: OrganizePage[] = [
      { page: 0, rotation: 0 },
      { page: 99, rotation: 0 },
    ];

    await expect(organizePdf(file, plan)).rejects.toMatchObject({ code: "empty" });
  });

  it("un archivo vacio lanza PdfError('corrupt') antes de tocar ninguna pagina", async () => {
    const empty = new File([], "empty.pdf", { type: "application/pdf" });

    await expect(organizePdf(empty, [])).rejects.toBeInstanceOf(PdfError);
    await expect(organizePdf(empty, [])).rejects.toMatchObject({ code: "corrupt" });
  });

  it("reporta progreso creciente hasta 1 al terminar", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    const progress: number[] = [];

    await organizePdf(
      file,
      [
        { page: 1, rotation: 0 },
        { page: 2, rotation: 0 },
      ],
      (value) => progress.push(value),
    );

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]);
    }
  });
});
