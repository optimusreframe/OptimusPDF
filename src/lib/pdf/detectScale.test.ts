import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { detectFieldsFromSources, type DetectedField, type PdfJsOps } from "@/lib/pdf/detectFields";
import {
  SCALE_FORM_KINDS,
  SCALE_NONFORM_KINDS,
  makeScaleForm,
  makeScaleNonForm,
  type PageName,
  type ScaleFormKind,
  type ScaleNonFormKind,
  type ScaleOptions,
} from "@/lib/pdf/testing/scaleVariants";

/**
 * Invariancia a la escala de la deteccion de huecos (W6-A r3).
 *
 * La verificacion V-F midio recall 77,8 % con formularios nuevos: la deteccion usaba
 * constantes en PUNTOS absolutos (hueco etiqueta-raya <= 90 pt, rayas de mas de media pagina solo
 * con etiquetas de <= 13 pt, ...) y un formulario con etiquetas de 14 pt o ampliado un 25 % daba
 * 0 de 5 huecos. Ahora todo se mide en la unidad tipografica del documento. Estas pruebas dibujan
 * cada diseno a distintas escalas, tamanos de letra, papeles y giros y exigen el MISMO resultado.
 */

const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function detect(bytes: Uint8Array): Promise<DetectedField[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfLib = await PDFDocument.load(bytes);
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const fields = await detectFieldsFromSources({ pdfLib, pdfjs: doc as never, OPS: pdfjs.OPS as unknown as PdfJsOps });
    return fields.filter((field) => field.source !== "acroform");
  } finally {
    await task.destroy();
  }
}

/** Cada etiqueta esperada aparece en algun hueco y no hay huecos de mas. */
function check(found: DetectedField[], labels: string[]) {
  const want = labels.map(norm);
  const used = new Set<number>();
  const missing: string[] = [];
  for (const candidate of want) {
    const index = found.findIndex((field, i) => !used.has(i) && norm(field.label ?? "").includes(candidate));
    if (index >= 0) used.add(index);
    else missing.push(candidate);
  }
  const extra = found.filter((_, i) => !used.has(i)).map((field) => field.label ?? "?");
  return { missing, extra };
}

const SCALES = [0.7, 0.8, 1, 1.25, 1.5, 2];

describe("formularios: mismo resultado a cualquier escala (x0,7 a x2)", () => {
  for (const kind of SCALE_FORM_KINDS) {
    for (const scale of SCALES) {
      it(`${kind} a x${scale}: todos los huecos y ninguno de mas`, async () => {
        const form = await makeScaleForm(kind, { fontPt: 11, scale });
        const { missing, extra } = check(await detect(form.bytes), form.labels);
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });
    }
  }

  for (const scale of [0.4, 0.5, 2, 3]) {
    for (const kind of ["lines-left", "short-lines", "boxes-left", "caption-cells", "table-form"] as ScaleFormKind[]) {
      it(`${kind} a x${scale} (paginas muy pequenas o muy grandes)`, async () => {
        const form = await makeScaleForm(kind, { fontPt: 11, scale });
        const { missing, extra } = check(await detect(form.bytes), form.labels);
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });
    }
  }

  it("margenes de 0,25 pulgadas (lineas de casi borde a borde): el hueco se detecta igual a cualquier escala", async () => {
    for (const kind of ["lines-above", "lines-left", "boxes-left", "wide-lines", "line-then-label", "sign-captions"] as ScaleFormKind[]) {
      for (const scale of SCALES) {
        const form = await makeScaleForm(kind, { fontPt: 12, scale, margin: 18 });
        const { missing, extra } = check(await detect(form.bytes), form.labels);
        expect({ kind, scale, missing, extra }).toEqual({ kind, scale, missing: [], extra: [] });
      }
    }
  });

  it("el resultado no cambia con la escala (mismas etiquetas, mismo numero) para todos los disenos", async () => {
    for (const kind of SCALE_FORM_KINDS) {
      const results: string[] = [];
      for (const scale of SCALES) {
        const form = await makeScaleForm(kind, { fontPt: 12, scale });
        results.push((await detect(form.bytes)).map((field) => norm(field.label ?? "")).join("|"));
      }
      expect(new Set(results).size, `${kind}: ${results.join(" // ")}`).toBe(1);
    }
  });
});

describe("el hueco que se ofrece sobre una raya escala con el documento", () => {
  it("el alto relativo de cada campo es el mismo a x0,8, x1 y x1,5 (antes eran 14 pt fijos)", async () => {
    const heights: number[][] = [];
    for (const scale of [0.8, 1, 1.5]) {
      const form = await makeScaleForm("lines-left", { fontPt: 11, scale });
      heights.push((await detect(form.bytes)).map((field) => field.rect.height));
    }
    expect(heights[0]).toHaveLength(6);
    heights[0].forEach((value, i) => {
      expect(heights[1][i]).toBeCloseTo(value, 3);
      expect(heights[2][i]).toBeCloseTo(value, 3);
    });
  });
});

describe("formularios: etiquetas de 9 a 16 pt (el repro de V-F: etiquetas de 14 pt y raya de 300 pt daba 0/5)", () => {
  const FONT_KINDS: ScaleFormKind[] = ["lines-left", "lines-above", "boxes-above", "sign-captions", "wide-lines", "dots-text", "caption-cells"];
  for (const kind of FONT_KINDS) {
    for (const fontPt of [9, 10, 12, 14, 16]) {
      it(`${kind} con letra de ${fontPt} pt`, async () => {
        const form = await makeScaleForm(kind, { fontPt });
        const { missing, extra } = check(await detect(form.bytes), form.labels);
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });
    }
  }

  it("A4 con etiquetas de 14 pt y rayas de 300 pt: 5 de 5 (antes 0 de 5), tambien ampliado un 25 %", async () => {
    for (const scale of [1, 1.25]) {
      const form = await makeScaleForm("lines-above", { fontPt: 14, scale });
      const found = await detect(form.bytes);
      expect(found).toHaveLength(5);
      expect(check(found, form.labels).missing).toEqual([]);
    }
  });

  it("texto corriente mas pequeno que las etiquetas (70 %): la unidad no se confunde", async () => {
    for (const kind of ["lines-left", "lines-above", "boxes-left", "sign-captions", "inline"] as ScaleFormKind[]) {
      const form = await makeScaleForm(kind, { fontPt: 14, bodyRatio: 0.7 });
      const { missing, extra } = check(await detect(form.bytes), form.labels);
      expect({ kind, missing, extra }).toEqual({ kind, missing: [], extra: [] });
    }
  });
});

describe("formularios: papeles y giros de pagina", () => {
  const cases: Array<{ kind: ScaleFormKind; page: PageName; rotate?: ScaleOptions["rotate"] }> = [
    { kind: "lines-left", page: "A3" },
    { kind: "lines-left", page: "Letter" },
    { kind: "lines-left", page: "A5" },
    { kind: "lines-left", page: "A4", rotate: 90 },
    { kind: "lines-left", page: "A4", rotate: 270 },
    { kind: "boxes-above", page: "A3" },
    { kind: "boxes-above", page: "A4", rotate: 90 },
    { kind: "caption-cells", page: "Letter" },
    { kind: "caption-cells", page: "A4", rotate: 180 },
    { kind: "lines-above", page: "A5" },
    { kind: "table-form", page: "A3", rotate: 270 },
  ];
  for (const item of cases) {
    it(`${item.kind} en ${item.page}${item.rotate ? ` girado ${item.rotate} grados` : ""}`, async () => {
      const form = await makeScaleForm(item.kind, { page: item.page, rotate: item.rotate, fontPt: 12 });
      const { missing, extra } = check(await detect(form.bytes), form.labels);
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });
  }
});

describe("documentos que NO son formularios: ningun hueco a ninguna escala", () => {
  for (const kind of SCALE_NONFORM_KINDS) {
    for (const scale of SCALES) {
      it(`${kind} a x${scale}: 0 sugeridos`, async () => {
        const found = await detect(await makeScaleNonForm(kind, { fontPt: 11, scale }));
        expect(found.map((field) => field.label)).toEqual([]);
      });
    }
    for (const fontPt of [9, 14, 16]) {
      it(`${kind} con letra de ${fontPt} pt: 0 sugeridos`, async () => {
        const found = await detect(await makeScaleNonForm(kind, { fontPt }));
        expect(found.map((field) => field.label)).toEqual([]);
      });
    }
  }

  it("barras de progreso, Gantt con etiqueta, tarjetas de precios y graficas: 0 con el texto corriente mas pequeno", async () => {
    for (const kind of ["progress-rects", "progress-lines", "gantt", "price-cards", "chart-gridlines"] as ScaleNonFormKind[]) {
      const found = await detect(await makeScaleNonForm(kind, { fontPt: 14, bodyRatio: 0.7 }));
      expect(found.map((field) => field.label), kind).toEqual([]);
    }
  });
});

describe("PDF reales (Chromium) a escalas y tamanos de letra distintos", () => {
  const fixture = (name: string) => new Uint8Array(readFileSync(path.resolve(__dirname, "testing/fixtures", name)));
  const forms: Array<{ file: string; count: number; labels?: string[] }> = [
    { file: "scale-dotted-chromium.pdf", count: 5, labels: ["Oficina", "Ocupación actual", "contacto", "Empresa", "Persona a visitar"] },
    { file: "scale-survey-chromium.pdf", count: 4, labels: ["Cómo conoció nuestro servicio", "Qué mejoraría", "Nos recomendaría"] },
    { file: "scale-table-form-shaded.pdf", count: 4, labels: ["Código postal", "Teléfono", "Apellidos", "Número de documento"] },
    { file: "scale-official-cells.pdf", count: 6, labels: ["Nombre", "Apellido", "Cédula", "Dirección", "Ciudad", "Teléfono"] },
    { file: "scale-exam-lines.pdf", count: 5, labels: ["Nombre", "Grupo", "entropía"] },
    { file: "scale-certificate.pdf", count: 4, labels: ["reconocimiento", "curso", "Director", "Secretaria"] },
    { file: "scale-inline-sentence.pdf", count: 5 },
    { file: "scale-right-labels.pdf", count: 4, labels: ["Fecha", "Lugar", "Asunto", "Responsable"] },
  ];
  for (const item of forms) {
    it(`${item.file}: ${item.count} huecos`, async () => {
      const found = await detect(fixture(item.file));
      expect(found).toHaveLength(item.count);
      if (item.labels) expect(check(found, item.labels).missing).toEqual([]);
    });
  }
  for (const file of ["scale-progress-chromium.pdf", "scale-gantt-chromium.pdf", "scale-recipe-leaders.pdf"]) {
    it(`${file} no es un formulario: 0 sugeridos`, async () => {
      expect(await detect(fixture(file))).toEqual([]);
    });
  }
});
