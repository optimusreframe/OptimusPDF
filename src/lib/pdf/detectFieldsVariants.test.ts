import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  detectFieldsFromSources,
  type DetectedField,
  type PdfJsOps,
} from "@/lib/pdf/detectFields";
import { makeDetectionVariants } from "@/lib/pdf/testing/signSyntheticPdfs";

/**
 * Recall y precision de la deteccion de huecos (W6-A r2) con formularios de varios
 * estilos y con documentos que NO lo son: rayas con etiqueta a la izquierda o encima,
 * cajas vacias (rectangulos, `<input>` de Chromium, `<textarea>`), 1 a 3 columnas,
 * bloques de firma, y recibos, tablas, graficas, calendarios, indices y barras de Gantt.
 * Criterio: recall >= 90 % y precision >= 95 % en formularios; 0 sugeridos fuera de ellos.
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

/** Empareja los huecos hallados con las etiquetas esperadas. */
function score(found: DetectedField[], labels: string[]) {
  const want = labels.map(norm);
  const used = new Set<number>();
  let tp = 0;
  const extra: string[] = [];
  for (const field of found) {
    const label = norm(field.label ?? "");
    const index = want.findIndex(
      (candidate, i) => !used.has(i) && (label === candidate || label.startsWith(candidate) || label.endsWith(candidate)),
    );
    if (index >= 0) {
      used.add(index);
      tp += 1;
    } else extra.push(field.label ?? "?");
  }
  return { tp, fp: found.length - tp, missing: want.filter((_, i) => !used.has(i)), extra };
}

const fixture = (name: string) => new Uint8Array(readFileSync(path.resolve(__dirname, "testing/fixtures", name)));

describe("variantes sinteticas (pdf-lib)", () => {
  it("cada formulario encuentra todos sus huecos y ninguno de mas; cada no-formulario, ninguno", async () => {
    const variants = await makeDetectionVariants();
    expect(variants.length).toBeGreaterThanOrEqual(17);
    let tp = 0;
    let fp = 0;
    let gt = 0;
    const failures: string[] = [];
    for (const item of variants) {
      const found = await detect(item.bytes);
      if (item.kind === "form") {
        const result = score(found, item.labels);
        tp += result.tp;
        fp += result.fp;
        gt += item.labels.length;
        if (result.missing.length || result.extra.length) {
          failures.push(`${item.name}: faltan [${result.missing}] sobran [${result.extra}]`);
        }
      } else if (found.length > 0) {
        failures.push(`${item.name}: ${found.length} sugeridos [${found.map((f) => f.label)}]`);
      }
    }
    expect(failures).toEqual([]);
    expect(tp / gt).toBeGreaterThanOrEqual(0.9);
    expect(tp / Math.max(1, tp + fp)).toBeGreaterThanOrEqual(0.95);
  });
});

describe("PDF reales de Chromium y pdfkit", () => {
  const forms: Array<[string, string[]]> = [
    ["chromium-input-underline.pdf", ["Nombre", "Apellido", "Cedula", "Telefono", "Correo"]],
    ["chromium-boxed-inputs.pdf", ["Nombre", "Apellido", "Cedula", "Telefono", "Correo"]],
    ["chromium-label-above.pdf", ["Nombre", "Apellido", "Direccion", "Telefono"]],
    ["chromium-invoice-signature.pdf", ["Firma"]],
    ["chromium-textareas.pdf", ["Observaciones", "Antecedentes", "Notas adicionales"]],
    ["chromium-fieldset.pdf", ["Nombre", "Apellido", "Cedula", "Telefono", "Correo"]],
    ["pdfkit-lines.pdf", ["Nombre", "Apellido", "Cedula", "Direccion", "Telefono"]],
  ];
  for (const [file, labels] of forms) {
    it(`${file}: encuentra sus ${labels.length} huecos sin sobrantes`, async () => {
      const result = score(await detect(fixture(file)), labels);
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual([]);
    });
  }

  for (const file of ["chromium-table.pdf", "chromium-cards-hr.pdf", "chromium-hr-sections.pdf"]) {
    it(`${file}: no sugiere nada (tabla, tarjetas con <hr>, secciones con <hr>)`, async () => {
      expect(await detect(fixture(file))).toEqual([]);
    });
  }

  it("la caja de un <input> de Chromium (fondo + borde inferior) cuenta UNA vez, no caja y raya", async () => {
    const found = await detect(fixture("chromium-input-underline.pdf"));
    expect(found).toHaveLength(5);
    // Es la caja (alto de campo), no la raya de 1 pt.
    expect(found.every((field) => field.rect.height > 0.012)).toBe(true);
  });
});
