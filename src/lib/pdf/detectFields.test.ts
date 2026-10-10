import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { getPageGeometry } from "@/lib/pdf/core";
import {
  detectAcroFormFields,
  detectDarkBands,
  detectVectorFieldsOnPage,
  embeddedValueFor,
  fieldTypeOf,
  formatIsoDate,
  isFieldFilled,
  nearestLabel,
  toLuminance,
  type DetectedField,
  type PdfJsOps,
} from "@/lib/pdf/detectFields";

/**
 * El detector vectorial recibe un `PDFPageProxy` de pdf.js y el objeto
 * `OPS` real: para probar la geometria de verdad (matriz acumulada,
 * `minMax` de cada trazo) hace falta un documento de pdf.js real, no uno
 * simulado a mano.
 *
 * `core.ts` carga pdf.js por `getPdfJs()` desde el paquete `"pdfjs-dist"`
 * a secas, pensado para el navegador (usa un worker servido como asset
 * estatico); en Node revienta con `DOMMatrix is not defined` (mismo
 * limite ya documentado en `core.test.ts` para `openPdfDocument`). El
 * build `"pdfjs-dist/legacy/build/pdf.mjs"` si funciona en Node sin
 * DOM alguno para *analizar* un documento (`getOperatorList`/
 * `getTextContent`, sin renderizar nada a canvas), asi que este test
 * importa esa ruta directamente — mismo paquete ya instalado, ninguna
 * dependencia nueva — solo para construir el fixture de verdad.
 */
async function loadPageForAnalysis(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes });
  const document = await task.promise;
  const page = await document.getPage(1);
  return { page, OPS: pdfjs.OPS as unknown as PdfJsOps, document };
}

describe("detectAcroFormFields — src/lib/pdf/detectFields.ts", () => {
  it("encuentra un PDFTextField y calcula su rectangulo normalizado (confianza alta)", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 400]);
    const form = document.getForm();
    const field = form.createTextField("cliente.nombre");
    // Hueco de 150x20 pt en (50, 300) [espacio de usuario, abajo-izquierda].
    field.addToPage(page, { x: 50, y: 300, width: 150, height: 20 });

    const detected = detectAcroFormFields(document);

    expect(detected).toHaveLength(1);
    expect(detected[0].source).toBe("acroform");
    expect(detected[0].confidence).toBe("high");
    expect(detected[0].pageIndex).toBe(0);
    expect(detected[0].label).toBe("cliente.nombre");

    // pdf-lib ensancha el rectangulo pedido medio punto por lado (el
    // hueco del borde por defecto): el widget real queda en
    // (49.5,299.5)-(200.5,320.5) sobre una pagina de 300x400 sin rotar.
    expect(detected[0].rect.x).toBeCloseTo(49.5 / 300, 5);
    expect(detected[0].rect.y).toBeCloseTo((400 - 320.5) / 400, 5);
    expect(detected[0].rect.width).toBeCloseTo(151 / 300, 5);
    expect(detected[0].rect.height).toBeCloseTo(21 / 400, 5);
  });

  it("un widget en una pagina rotada 90 grados sigue dando una caja recta y dentro de la vista", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 400]);
    page.setRotation(degrees(90));
    const form = document.getForm();
    const field = form.createTextField("fecha");
    field.addToPage(page, { x: 50, y: 300, width: 150, height: 20 });

    const detected = detectAcroFormFields(document);

    expect(detected).toHaveLength(1);
    const rect = detected[0].rect;
    expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
    expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("un documento sin AcroForm no lanza y devuelve una lista vacia", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]);

    expect(detectAcroFormFields(document)).toEqual([]);
  });

  it("un checkbox (no PDFTextField) se ignora sin romper la deteccion", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 400]);
    const form = document.getForm();
    form.createCheckBox("acepto").addToPage(page, { x: 10, y: 10, width: 12, height: 12 });
    const field = form.createTextField("nombre");
    field.addToPage(page, { x: 50, y: 300, width: 150, height: 20 });

    const detected = detectAcroFormFields(document);
    expect(detected).toHaveLength(1);
    expect(detected[0].label).toBe("nombre");
  });
});

describe("detectVectorFieldsOnPage — src/lib/pdf/detectFields.ts (geometria real de pdf.js)", () => {
  it("encuentra una raya fina y ancha y sugiere la etiqueta a su izquierda en la misma linea", async () => {
    const pdfLibDoc = await PDFDocument.create();
    const page = pdfLibDoc.addPage([400, 300]);
    const font = await pdfLibDoc.embedFont(StandardFonts.Helvetica);
    // "Cliente:" seguido de una raya fina y ancha en la misma linea.
    page.drawText("Cliente:", { x: 20, y: 150, size: 10, font });
    page.drawRectangle({ x: 90, y: 148, width: 200, height: 1.5, color: rgb(0, 0, 0) });
    const bytes = await pdfLibDoc.save();

    const { page: pdfjsPage, OPS } = await loadPageForAnalysis(bytes);
    const geometry = getPageGeometry(pdfLibDoc.getPages()[0]);

    const result = await detectVectorFieldsOnPage(pdfjsPage, 0, geometry, OPS, "vec");

    expect(result.hasText).toBe(true);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].source).toBe("heuristic-vector");
    expect(result.fields[0].confidence).toBe("medium");
    expect(result.fields[0].pageIndex).toBe(0);
    expect(result.fields[0].label).toBe("Cliente:");

    // La raya (90,148)-(290,149.5) en una pagina de 400x300: x=90/400,
    // y desde arriba = (300-149.5)/300, ancho=200/400.
    expect(result.fields[0].rect.x).toBeCloseTo(90 / 400, 4);
    expect(result.fields[0].rect.width).toBeCloseTo(200 / 400, 4);
  });

  it("ignora rectangulos gruesos (no son rayas) y los demasiado estrechos", async () => {
    const pdfLibDoc = await PDFDocument.create();
    const page = pdfLibDoc.addPage([400, 300]);
    const font = await pdfLibDoc.embedFont(StandardFonts.Helvetica);
    page.drawText("Nota:", { x: 20, y: 150, size: 10, font });
    // Bloque grueso: no es una raya.
    page.drawRectangle({ x: 90, y: 100, width: 200, height: 40, color: rgb(0.8, 0.8, 0.8) });
    // Raya demasiado corta: no es un hueco util.
    page.drawRectangle({ x: 90, y: 148, width: 5, height: 1, color: rgb(0, 0, 0) });
    const bytes = await pdfLibDoc.save();

    const { page: pdfjsPage, OPS } = await loadPageForAnalysis(bytes);
    const geometry = getPageGeometry(pdfLibDoc.getPages()[0]);

    const result = await detectVectorFieldsOnPage(pdfjsPage, 0, geometry, OPS, "vec");
    expect(result.fields).toEqual([]);
  });

  it("una pagina sin texto extraible se marca `hasText: false` (la trata el detector raster)", async () => {
    const pdfLibDoc = await PDFDocument.create();
    const page = pdfLibDoc.addPage([400, 300]);
    // Solo vector, sin texto: simula una pagina practicamente-imagen.
    page.drawRectangle({ x: 90, y: 148, width: 200, height: 1.5, color: rgb(0, 0, 0) });
    const bytes = await pdfLibDoc.save();

    const { page: pdfjsPage, OPS } = await loadPageForAnalysis(bytes);
    const geometry = getPageGeometry(pdfLibDoc.getPages()[0]);

    const result = await detectVectorFieldsOnPage(pdfjsPage, 0, geometry, OPS, "vec");
    expect(result.hasText).toBe(false);
    expect(result.fields).toEqual([]);
  });
});

describe("nearestLabel — src/lib/pdf/detectFields.ts", () => {
  it("sin ninguna etiqueta cerca no sugiere nada", () => {
    expect(
      nearestLabel([], { x: 100, y: 100, width: 50, height: 5 }),
    ).toBeUndefined();
  });
});

describe("detectDarkBands / toLuminance — heuristica raster (src/lib/pdf/detectFields.ts)", () => {
  /** Construye un buffer de luminancia width*height, 255 = blanco. */
  function makeCanvas(width: number, height: number): Float32Array {
    return new Float32Array(width * height).fill(255);
  }

  function paintRow(buffer: Float32Array, width: number, row: number, colStart: number, colEnd: number, value: number) {
    for (let x = colStart; x < colEnd; x += 1) buffer[row * width + x] = value;
  }

  it("encuentra una banda oscura, fina y ancha (candidata a raya escaneada)", () => {
    const width = 200;
    const height = 100;
    const buffer = makeCanvas(width, height);
    // Raya oscura de 2 filas, de la columna 20 a la 180 (80% del ancho).
    paintRow(buffer, width, 60, 20, 180, 10);
    paintRow(buffer, width, 61, 20, 180, 10);

    const bands = detectDarkBands(buffer, width, height);

    expect(bands).toHaveLength(1);
    expect(bands[0].rowStart).toBe(60);
    expect(bands[0].rowEnd).toBe(61);
    expect(bands[0].colStart).toBe(20);
    expect(bands[0].colEnd).toBe(179);
  });

  it("ignora un bloque oscuro grueso (no es una raya fina)", () => {
    const width = 200;
    const height = 100;
    const buffer = makeCanvas(width, height);
    for (let row = 30; row < 60; row += 1) {
      paintRow(buffer, width, row, 20, 180, 10);
    }

    expect(detectDarkBands(buffer, width, height)).toEqual([]);
  });

  it("ignora una raya demasiado corta (ruido, no un hueco util)", () => {
    const width = 200;
    const height = 100;
    const buffer = makeCanvas(width, height);
    paintRow(buffer, width, 60, 20, 30, 10);

    expect(detectDarkBands(buffer, width, height)).toEqual([]);
  });

  it("una pagina completamente blanca no produce ninguna banda", () => {
    const buffer = makeCanvas(100, 100);
    expect(detectDarkBands(buffer, 100, 100)).toEqual([]);
  });

  it("toLuminance calcula el promedio ponderado RGB de un ImageData-like RGBA", () => {
    // Un pixel negro opaco y uno blanco opaco.
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const luminance = toLuminance(rgba);
    expect(luminance[0]).toBeCloseTo(0, 5);
    expect(luminance[1]).toBeCloseTo(255, 5);
  });
});

describe("fieldTypeOf / isFieldFilled / embeddedValueFor — src/lib/pdf/detectFields.ts (Recomendacion #5)", () => {
  const base: Omit<DetectedField, "type"> = {
    id: "txt-1",
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    source: "manual",
    confidence: "high",
  };

  it("un campo sin `type` (borrador/export de antes de esta funcion) se lee como texto libre", () => {
    expect(fieldTypeOf(base)).toBe("text");
  });

  it("un campo con `type` explicito respeta ese tipo", () => {
    expect(fieldTypeOf({ ...base, type: "checkbox" })).toBe("checkbox");
  });

  it("una casilla cuenta como rellena en cuanto se coloca, marcada o no", () => {
    const checkbox: DetectedField = { ...base, type: "checkbox" };
    expect(isFieldFilled(checkbox, "")).toBe(true);
    expect(isFieldFilled(checkbox, "true")).toBe(true);
    expect(isFieldFilled(checkbox, undefined)).toBe(true);
  });

  it("texto, fecha e inicial siguen la regla de siempre: vacio = no relleno", () => {
    for (const type of ["text", "date", "initials"] as const) {
      const field: DetectedField = { ...base, type };
      expect(isFieldFilled(field, "")).toBe(false);
      expect(isFieldFilled(field, "   ")).toBe(false);
      expect(isFieldFilled(field, "x")).toBe(true);
    }
  });

  it("una casilla marcada se empotra como \"X\" (ASCII), nunca un simbolo de check", () => {
    const checkbox: DetectedField = { ...base, type: "checkbox" };
    expect(embeddedValueFor(checkbox, "true", "es")).toBe("X");
  });

  it("una casilla sin marcar no empotra nada", () => {
    const checkbox: DetectedField = { ...base, type: "checkbox" };
    expect(embeddedValueFor(checkbox, "", "es")).toBe("");
  });

  it("una fecha se empotra formateada segun el idioma activo", () => {
    const date: DetectedField = { ...base, type: "date" };
    expect(embeddedValueFor(date, "2026-08-12", "es")).toContain("2026");
    expect(embeddedValueFor(date, "2026-08-12", "es")).not.toBe("2026-08-12");
  });

  it("texto e inicial se empotran tal cual, sin transformar", () => {
    expect(embeddedValueFor({ ...base, type: "text" }, "Ana Perez", "es")).toBe(
      "Ana Perez",
    );
    expect(embeddedValueFor({ ...base, type: "initials" }, "AP", "es")).toBe(
      "AP",
    );
  });
});

describe("formatIsoDate — src/lib/pdf/detectFields.ts", () => {
  it("formatea una fecha ISO en espanol", () => {
    expect(formatIsoDate("2026-08-12", "es")).toContain("2026");
  });

  it("formatea una fecha ISO en ingles", () => {
    expect(formatIsoDate("2026-08-12", "en")).toContain("2026");
  });

  it("una cadena vacia no revienta: devuelve vacio", () => {
    expect(formatIsoDate("", "es")).toBe("");
  });

  it("una fecha invalida se devuelve tal cual en vez de reventar", () => {
    expect(formatIsoDate("no-es-una-fecha", "es")).toBe("no-es-una-fecha");
  });
});
