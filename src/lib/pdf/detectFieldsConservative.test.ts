import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import {
  MAX_SLOTS_PER_DOCUMENT,
  capSuggested,
  detectFieldsFromSources,
  isSuggestedField,
  type DetectedField,
  type PdfJsOps,
} from "@/lib/pdf/detectFields";
import {
  makeFormPdf,
  makeImageOnlyPdf,
  makeLongReportPdf,
  makePresentationPdf,
  makeReceiptPdf,
  makeTablePdf,
} from "@/lib/pdf/testing/signSyntheticPdfs";

/**
 * Deteccion CONSERVADORA con PDF sinteticos (W6-A): los documentos de las
 * capturas del usuario (recibo, presentacion con degradado, tabla grande,
 * pagina solo-imagen, informe largo) NO deben llenarse de «Field N», y un
 * formulario real conserva sus huecos genuinos. Se usa el build «legacy» de
 * pdf.js en Node para analizar de verdad la lista de operadores.
 */

async function detect(bytes: Uint8Array, options?: { raster?: boolean }): Promise<DetectedField[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfLib = await PDFDocument.load(bytes);
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    return await detectFieldsFromSources(
      { pdfLib, pdfjs: doc as never, OPS: pdfjs.OPS as unknown as PdfJsOps },
      options,
    );
  } finally {
    await task.destroy();
  }
}

const DEFAULT_LIMIT = 8;

describe("deteccion conservadora — documentos que NO son formularios", () => {
  it("un recibo (reglas finas entre filas, a ancho completo y de totales) no sugiere ningun hueco", async () => {
    const fields = await detect(await makeReceiptPdf());
    expect(fields.length).toBeLessThanOrEqual(DEFAULT_LIMIT);
    expect(fields).toEqual([]);
  });

  it("una presentacion con degradado de franjas, barras y reglas decorativas no sugiere nada", async () => {
    const fields = await detect(await makePresentationPdf());
    expect(fields.length).toBeLessThanOrEqual(DEFAULT_LIMIT);
    expect(fields).toEqual([]);
  });

  it("una tabla de 20 filas por 4 columnas con cuadricula no sugiere nada", async () => {
    const fields = await detect(await makeTablePdf(20));
    expect(fields).toEqual([]);
  });

  it("una pagina solo-imagen no sugiere nada (el raster NO corre por defecto)", async () => {
    const fields = await detect(await makeImageOnlyPdf());
    expect(fields).toEqual([]);
  });

  it("un informe de 16 paginas con separadores de fila no suma «Field N» (antes: 176)", async () => {
    const fields = await detect(await makeLongReportPdf(16));
    expect(fields).toEqual([]);
  });

  it("una tabla enorme (200 filas) tampoco", async () => {
    const fields = await detect(await makeTablePdf(200));
    expect(fields).toEqual([]);
  });
});

describe("deteccion conservadora — un formulario real", () => {
  it("encuentra al menos el 90 % de los huecos genuinos y ninguno de mas", async () => {
    const { bytes, genuine } = await makeFormPdf();
    const fields = await detect(bytes);
    expect(fields.length).toBeGreaterThanOrEqual(Math.ceil(genuine * 0.9));
    // La cabecera con regla a todo lo ancho, la caja de uso interno y el pie NO son huecos.
    expect(fields.length).toBeLessThanOrEqual(genuine);
    const labels = fields.map((field) => field.label);
    for (const expected of ["Nombre:", "Apellidos:", "DNI:", "Direccion:", "Ciudad:", "Observaciones:", "Referido por:"]) {
      expect(labels).toContain(expected);
    }
    expect(labels).toContain("Firma del solicitante");
    expect(fields.every((field) => field.source === "heuristic-vector")).toBe(true);
    expect(fields.every(isSuggestedField)).toBe(true);
  });

  it("los huecos caen sobre su raya (rect normalizado coherente con la pagina)", async () => {
    const { bytes } = await makeFormPdf();
    const fields = await detect(bytes);
    const nombre = fields.find((field) => field.label === "Nombre:");
    expect(nombre).toBeDefined();
    // Raya de «Nombre:» en y=728 pt de una pagina de 841,89: justo debajo de la linea base del texto.
    expect(nombre!.rect.y).toBeGreaterThan(0.1);
    expect(nombre!.rect.y).toBeLessThan(0.14);
    expect(nombre!.rect.x).toBeGreaterThan(0.1);
    expect(nombre!.rect.width).toBeGreaterThan(0.2);
    expect(nombre!.rect.height).toBeGreaterThan(0.01);
  });

  it("un formulario con las rayas dibujadas como rectangulos finos y la base del texto desplazada 2 pt tambien se detecta", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    const labels = ["Name", "Surname", "Passport no.", "Nationality", "Occupation"];
    labels.forEach((label, index) => {
      const y = 700 - index * 36;
      page.drawText(label, { x: 60, y: y + 2, size: 10, font });
      page.drawRectangle({ x: 150, y, width: 250, height: 0.8, color: rgb(0, 0, 0) });
    });
    const fields = await detect(await doc.save());
    expect(fields.map((field) => field.label).sort()).toEqual([...labels].sort());
  });

  it("los campos AcroForm reales siguen yendo siempre, tambien en un documento sin rayas", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const form = doc.getForm();
    form.createTextField("cliente").addToPage(page, { x: 50, y: 200, width: 150, height: 20 });
    const fields = await detect(await doc.save());
    expect(fields).toHaveLength(1);
    expect(fields[0].source).toBe("acroform");
    expect(isSuggestedField(fields[0])).toBe(false);
  });
});

describe("tope por documento", () => {
  it("un formulario de 5 paginas con 20 huecos cada una queda en el tope de 60", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let p = 0; p < 5; p += 1) {
      const page = doc.addPage([595, 842]);
      for (let i = 0; i < 20; i += 1) {
        const y = 800 - i * 36;
        page.drawText(`Campo ${p}-${i}:`, { x: 50, y, size: 10, font });
        page.drawLine({ start: { x: 150, y: y - 2 }, end: { x: 400, y: y - 2 }, thickness: 0.8 });
      }
    }
    const fields = await detect(await doc.save());
    expect(fields).toHaveLength(MAX_SLOTS_PER_DOCUMENT);
  });

  it("capSuggested conserva los de mayor confianza y respeta el orden original", () => {
    const fields = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, label: String(i) }) as unknown as DetectedField);
    const scores = [1, 9, 2, 8, 3, 7, 4, 6, 5, 0];
    const kept = capSuggested(fields, scores, 3);
    expect(kept.map((field) => field.id)).toEqual(["f1", "f3", "f5"]);
    expect(capSuggested(fields, scores, 20)).toHaveLength(10);
  });
});
