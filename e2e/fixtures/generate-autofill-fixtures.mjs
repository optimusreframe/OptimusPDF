// Genera los fixtures SINTETICOS del autorrelleno (F3): e2e/fixtures/autofill-claim-en.pdf y autofill-claim-es.pdf.
// Datos 100 % inventados (telefonos 555-01xx, correos @example.com). Pagina 1: formulario «etiqueta: valor» con las diez claves;
// pagina 2: pie con telefono/correo/direccion de una empresa (senuelos que NO deben proponerse).
// No se ejecuta en CI; los PDFs SI se commitean. Re-ejecutar a mano: node e2e/fixtures/generate-autofill-fixtures.mjs
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const FORMS = {
  en: {
    file: "autofill-claim-en.pdf",
    title: "CLAIM INTAKE FORM",
    rows: [
      ["Insured", "Maria Testwell and John Testwell"],
      ["Phone", "305-555-0142"],
      ["Email", "maria.testwell@example.com"],
      ["Loss Address", "1234 Maple Ridge Dr, Miami, FL 33166"],
      ["Insurance Company", "Palmetto Mutual Insurance Company"],
      ["Policy No.", "HO3-0042817"],
      ["Claim No.", "CLM-2026-118342"],
      ["Type of Loss", "Wind"],
      ["Date of Loss", "March 14, 2026"],
    ],
    footer: ["Responsive Claims Group, LLC", "Office: (305) 555-0188   Fax: (305) 555-0189", "E-mail: info@responsive-example.com"],
  },
  es: {
    file: "autofill-claim-es.pdf",
    title: "FORMULARIO DE RECLAMO",
    rows: [
      ["Asegurado", "María Pérez y José Pérez"],
      ["Teléfono", "(787) 555-0123"],
      ["Correo electrónico", "maria.perez@example.com"],
      ["Dirección de la pérdida", "Calle Luna #123, Urb. Las Flores, San Juan, PR 00901"],
      ["Aseguradora", "Seguros Atlas del Caribe"],
      ["N.º de póliza", "HO3-0042817"],
      ["N.º de siniestro", "FL26-84705"],
      ["Tipo de pérdida", "Granizo"],
      ["Fecha de pérdida", "14 de marzo de 2026"],
    ],
    footer: ["Grupo de Reclamos Responsivo, S.A.", "Oficina: (305) 555-0188   Fax: (305) 555-0189", "Correo: info@responsive-example.com"],
  },
};

for (const form of Object.values(FORMS)) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page1 = doc.addPage([612, 792]);
  page1.drawText(form.title, { x: 60, y: 712, size: 15, font: bold });
  form.rows.forEach(([label, value], index) => page1.drawText(`${label}: ${value}`, { x: 60, y: 640 - index * 26, size: 11, font: regular }));
  // Membrete y pie de empresa en las dos paginas (senuelos).
  for (const page of [page1, doc.addPage([612, 792])]) {
    page.drawText(form.footer[0], { x: 40, y: 40, size: 9, font: bold });
    page.drawText(form.footer[1], { x: 40, y: 28, size: 8, font: regular });
    page.drawText(form.footer[2], { x: 40, y: 17, size: 8, font: regular });
  }
  writeFileSync(join(here, form.file), await doc.save());
}
