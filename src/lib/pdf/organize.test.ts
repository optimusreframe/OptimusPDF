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
      { kind: "existing", page: 3, rotation: 0 },
      { kind: "existing", page: 1, rotation: 0 },
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
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "existing", page: 3, rotation: 0 },
    ];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(pageSides(result)).toEqual([100, 300]);
  });

  it("duplicar un numero de pagina en el plan la duplica en la salida", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    const plan: OrganizePage[] = [
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "existing", page: 1, rotation: 0 },
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

    const blob = await organizePdf(file, [{ kind: "existing", page: 1, rotation: 90 }]);
    const result = await loadBlob(blob);

    expect(result.getPage(0).getRotation().angle).toBe(180);
  });

  it("una rotacion de 0 grados no toca la rotacion original", async () => {
    const document = await documentWithSizedPages(1);
    document.getPage(0).setRotation(degrees(270));
    const file = await toFile(document);

    const blob = await organizePdf(file, [{ kind: "existing", page: 1, rotation: 0 }]);
    const result = await loadBlob(blob);

    expect(result.getPage(0).getRotation().angle).toBe(270);
  });

  it("numeros de pagina fuera de rango (0, negativos, mayores que el total) se descartan del plan", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    const plan: OrganizePage[] = [
      { kind: "existing", page: 0, rotation: 0 },
      { kind: "existing", page: -1, rotation: 0 },
      { kind: "existing", page: 99, rotation: 0 },
      { kind: "existing", page: 2, rotation: 0 },
    ];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(1);
    expect(pageSides(result)).toEqual([200]);
  });

  it("un plan cuyas paginas son TODAS invalidas lanza PdfError('empty')", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    const plan: OrganizePage[] = [
      { kind: "existing", page: 0, rotation: 0 },
      { kind: "existing", page: 99, rotation: 0 },
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
        { kind: "existing", page: 1, rotation: 0 },
        { kind: "existing", page: 2, rotation: 0 },
      ],
      (value) => progress.push(value),
    );

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]);
    }
  });

  /* ------------------------------------------------------------------ *
   * Paginas en blanco (A6)
   * ------------------------------------------------------------------ */

  it("un plan con blancos intercalados respeta el orden y hereda el tamano de la existing mas cercana (anterior -> siguiente)", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    // [blank, existing p3, blank, existing p1 rotado 90, blank]
    const plan: OrganizePage[] = [
      { kind: "blank" },
      { kind: "existing", page: 3, rotation: 0 },
      { kind: "blank" },
      { kind: "existing", page: 1, rotation: 90 },
      { kind: "blank" },
    ];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(5);

    // Posicion 0: blanco sin "anterior" en el plan -> hereda de la
    // "siguiente" mas cercana (existing p3, 300x300, sin rotacion extra).
    expect(result.getPage(0).getWidth()).toBe(300);
    expect(result.getPage(0).getHeight()).toBe(300);

    // Posicion 1: existing p3, 300x300, sin rotacion.
    expect(result.getPage(1).getWidth()).toBe(300);
    expect(result.getPage(1).getHeight()).toBe(300);

    // Posicion 2: blanco entre existing p3 (anterior) y existing p1
    // rotada 90 (siguiente) -> hereda de la ANTERIOR mas cercana (p3,
    // 300x300).
    expect(result.getPage(2).getWidth()).toBe(300);
    expect(result.getPage(2).getHeight()).toBe(300);

    // Posicion 3: existing p1 (100x100) rotada 90 grados.
    expect(result.getPage(3).getRotation().angle).toBe(90);

    // Posicion 4: blanco tras existing p1 rotada 90 -> hereda el tamano
    // VISUAL rotado (100x100 sigue siendo cuadrado, asi que se confirma
    // por separado con paginas no cuadradas mas abajo). Aqui basta con
    // que sea 100x100 (ancho/alto de la pagina 1 original).
    expect(result.getPage(4).getWidth()).toBe(100);
    expect(result.getPage(4).getHeight()).toBe(100);
  });

  it("un plan todo-blancos NO lanza error y produce paginas del tamano de la pagina 1 original", async () => {
    const file = await toFile(await documentWithSizedPages(3));
    const plan: OrganizePage[] = [{ kind: "blank" }, { kind: "blank" }, { kind: "blank" }];

    const blob = await organizePdf(file, plan);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(3);
    for (const page of result.getPages()) {
      expect(page.getWidth()).toBe(100);
      expect(page.getHeight()).toBe(100);
    }
  });

  it("regresion: el guard de plan vacio tras filtrar sigue lanzando PdfError('empty') exactamente como antes", async () => {
    const file = await toFile(await documentWithSizedPages(2));
    // Sin este guard, `PDFDocument.create()` + `save()` sobre 0 paginas
    // no lanzaria y produciria un PDF vacio silencioso (verificado).
    const plan: OrganizePage[] = [
      { kind: "existing", page: 0, rotation: 0 },
      { kind: "existing", page: 99, rotation: 0 },
    ];

    await expect(organizePdf(file, plan)).rejects.toBeInstanceOf(PdfError);
    await expect(organizePdf(file, plan)).rejects.toMatchObject({ code: "empty" });
  });

  it("addPage recibe la tupla [width, height], no un objeto {width, height}", async () => {
    // Documento con una unica pagina NO cuadrada (150x400): si el motor
    // pasara {width, height} en vez de [width, height] a `addPage`,
    // pdf-lib lanzaria un TypeError real y esta asercion de dimensiones
    // exactas nunca se alcanzaria (el test fallaria en vez de pasar en
    // silencio como si fuera un PdfError("unknown") generico).
    const document = await PDFDocument.create();
    document.addPage([150, 400]);
    const file = await toFile(document, "rect.pdf");

    const blob = await organizePdf(file, [
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "blank" },
    ]);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(result.getPage(1).getWidth()).toBe(150);
    expect(result.getPage(1).getHeight()).toBe(400);
  });

  it("un blanco hereda el tamano VISUAL (rotado), no el MediaBox crudo", async () => {
    // Pagina apaisada (400x200) con /Rotate 90 real: el tamano visual
    // efectivo es 200x400 (ancho/alto intercambiados).
    const document = await PDFDocument.create();
    const page = document.addPage([400, 200]);
    page.setRotation(degrees(90));
    const file = await toFile(document, "rotated.pdf");

    const blob = await organizePdf(file, [
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "blank" },
    ]);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    // La existing conserva su MediaBox crudo (400x200) con /Rotate 90.
    expect(result.getPage(0).getWidth()).toBe(400);
    expect(result.getPage(0).getHeight()).toBe(200);
    expect(result.getPage(0).getRotation().angle).toBe(90);
    // El blanco hereda el tamano VISUAL: 200x400 (intercambiado).
    expect(result.getPage(1).getWidth()).toBe(200);
    expect(result.getPage(1).getHeight()).toBe(400);
  });

  it("un blanco hereda tambien la rotacion EXTRA del plan (no solo la del documento), sobre una pagina no cuadrada", async () => {
    // Pagina vertical (150x400) SIN /Rotate en el documento: la unica
    // rotacion es la que suma el plan (90 grados). El tamano visual
    // efectivo debe intercambiar ancho/alto igual que con /Rotate real
    // -- cubre la rama `extraRotation` de `visualSize` que el test
    // anterior no ejercita (ese usa rotation: 0 en el plan).
    const document = await PDFDocument.create();
    document.addPage([150, 400]);
    const file = await toFile(document, "plan-rotated.pdf");

    const blob = await organizePdf(file, [
      { kind: "existing", page: 1, rotation: 90 },
      { kind: "blank" },
    ]);
    const result = await loadBlob(blob);

    expect(result.getPageCount()).toBe(2);
    expect(result.getPage(0).getRotation().angle).toBe(90);
    // El blanco hereda el tamano visual con la rotacion del PLAN aplicada:
    // 400x150 (intercambiado), no el 150x400 crudo del MediaBox.
    expect(result.getPage(1).getWidth()).toBe(400);
    expect(result.getPage(1).getHeight()).toBe(150);
  });
});
