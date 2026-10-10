import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import { deflateSync } from "node:zlib";

/*
 * PDF sinteticos para probar Firmar (W6-A): reproducen los documentos de las
 * capturas del usuario (recibo, presentacion con degradado, tabla grande,
 * pagina solo-imagen) y un formulario real con huecos genuinos.
 *
 * Solo se usa desde pruebas (Vitest en Node, scripts y Playwright): depende de
 * `node:zlib` para codificar el PNG de la pagina solo-imagen, asi que NO debe
 * importarlo codigo de la aplicacion.
 */

const GRAY = rgb(0.42, 0.45, 0.5);
const INK = rgb(0.07, 0.09, 0.13);
const RULE = rgb(0.82, 0.84, 0.87);

/** Texto pequeno (8-10 pt) donde se nota si el render esta borroso. */
export const SMALL_TEXT_LINES: readonly string[] = [
  "The quick brown fox jumps over the lazy dog 0123456789",
  "Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow.",
  "El veloz murcielago hindu comia feliz cardillo y kiwi. La cigueña tocaba el saxofon.",
  "Small print: terms and conditions apply; see section 4.2(b) for refunds & returns.",
  "iiiiiiiiii llllllllll 1111111111 rnrnrnrnrn mmmmmmmmmm WWWWWWWWWW",
];

/** Pagina A4 con texto de 8-10 pt: la referencia de nitidez. */
export async function makeSmallTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Sharpness reference page", { x: 48, y: 790, size: 14, font: bold, color: INK });
  let y = 760;
  for (let block = 0; block < 4; block += 1) {
    for (const [index, line] of SMALL_TEXT_LINES.entries()) {
      page.drawText(line, { x: 48, y, size: 8 + (index % 3), font, color: INK });
      y -= 14;
    }
    y -= 10;
  }
  return doc.save();
}

/** Recibo al estilo de las capturas: titulo, filas separadas por reglas finas, totales. */
export async function makeReceiptPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);

  page.drawText("Receipt from Acme Studio", { x: 56, y: 730, size: 22, font: bold, color: INK });
  page.drawText("Receipt #1842-7731", { x: 56, y: 710, size: 10, font, color: GRAY });
  hairline(page, 56, 556, 696, "line");

  const meta: Array<[string, string]> = [
    ["Amount paid", "$128.40"],
    ["Date paid", "October 8, 2026"],
    ["Payment method", "Visa - 4242"],
    ["Billed to", "andres@example.com"],
  ];
  let y = 672;
  for (const [index, [label, value]] of meta.entries()) {
    page.drawText(label, { x: 56, y, size: 11, font, color: GRAY });
    page.drawText(value, { x: 300, y, size: 11, font, color: INK });
    hairline(page, 56, 556, y - 10, index % 2 === 0 ? "line" : "rect");
    y -= 30;
  }

  y -= 14;
  page.drawText("Summary", { x: 56, y, size: 13, font: bold, color: INK });
  y -= 22;
  for (const header of [
    ["Description", 56],
    ["Qty", 330],
    ["Unit price", 400],
    ["Amount", 490],
  ] as const) {
    page.drawText(header[0], { x: header[1], y, size: 9, font: bold, color: GRAY });
  }
  hairline(page, 56, 556, y - 8, "rect");
  y -= 28;
  const items: Array<[string, string, string, string]> = [
    ["Design retainer - October", "1", "$90.00", "$90.00"],
    ["Hosting (annual plan)", "1", "$24.00", "$24.00"],
    ["Domain renewal", "1", "$8.40", "$8.40"],
    ["Priority support", "1", "$6.00", "$6.00"],
  ];
  for (const [description, qty, unit, amount] of items) {
    page.drawText(description, { x: 56, y, size: 10, font, color: INK });
    page.drawText(qty, { x: 330, y, size: 10, font, color: INK });
    page.drawText(unit, { x: 400, y, size: 10, font, color: INK });
    page.drawText(amount, { x: 490, y, size: 10, font, color: INK });
    hairline(page, 56, 556, y - 8, "line");
    y -= 26;
  }

  y -= 10;
  const totals: Array<[string, string]> = [
    ["Subtotal", "$128.40"],
    ["Tax (0%)", "$0.00"],
    ["Total", "$128.40"],
    ["Amount paid", "$128.40"],
  ];
  for (const [label, value] of totals) {
    page.drawText(label, { x: 340, y, size: 10, font: label === "Total" ? bold : font, color: INK });
    page.drawText(value, { x: 490, y, size: 10, font, color: INK });
    hairline(page, 340, 556, y - 8, "rect");
    y -= 24;
  }

  page.drawText("Questions? Contact billing@acme.example or call +1 555 0100.", {
    x: 56,
    y: 90,
    size: 9,
    font,
    color: GRAY,
  });
  hairline(page, 56, 556, 110, "line");
  return doc.save();
}

/** Diapositiva con degradado hecho de franjas finas, reglas decorativas y barras de acento. */
export async function makePresentationPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([960, 540]);

  // Degradado vertical: 108 franjas de 5 pt (cada una es una "raya" fina y ancha para el detector viejo).
  const strips = 108;
  for (let index = 0; index < strips; index += 1) {
    const t = index / (strips - 1);
    page.drawRectangle({
      x: 0,
      y: 540 - (index + 1) * 5,
      width: 960,
      height: 5,
      color: rgb(0.06 + 0.1 * t, 0.12 + 0.18 * t, 0.32 + 0.4 * t),
    });
  }
  // Barra de progreso hecha de franjas apiladas (mas estrecha que media pagina).
  for (let index = 0; index < 24; index += 1) {
    page.drawRectangle({
      x: 60,
      y: 130 + index * 4,
      width: 260,
      height: 3,
      color: rgb(0.9 - index * 0.015, 0.7, 0.2 + index * 0.02),
    });
  }

  page.drawText("Q4 Strategy Review", { x: 60, y: 400, size: 42, font: bold, color: rgb(1, 1, 1) });
  // Regla decorativa bajo el titulo (corta, gruesa) y otra a todo lo ancho.
  page.drawRectangle({ x: 60, y: 384, width: 120, height: 4, color: rgb(0.98, 0.78, 0.2) });
  page.drawRectangle({ x: 60, y: 60, width: 840, height: 1, color: rgb(1, 1, 1), opacity: 0.4 });
  page.drawText("Growth, margins and the road to next year", { x: 60, y: 356, size: 18, font, color: rgb(0.9, 0.93, 1) });
  const bullets = ["Revenue up 18% quarter on quarter", "Churn down to 2.1%", "Three new markets launched"];
  let y = 300;
  for (const bullet of bullets) {
    page.drawRectangle({ x: 400, y: y + 4, width: 40, height: 2, color: rgb(0.98, 0.78, 0.2) });
    page.drawText(bullet, { x: 450, y, size: 16, font, color: rgb(1, 1, 1) });
    y -= 34;
  }
  page.drawText("Confidential - internal use only", { x: 60, y: 40, size: 9, font, color: rgb(0.8, 0.85, 1) });
  return doc.save();
}

/** Tabla de 20 filas de datos (mas la cabecera) y 4 columnas, con cuadricula completa. */
export async function makeTablePdf(rows = 20): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const left = 40;
  const colWidth = 128;
  const rowHeight = 30;
  const top = 780;
  page.drawText("Inventory", { x: left, y: top + 20, size: 16, font: bold, color: INK });

  const headers = ["Item", "Category", "Qty", "Price"];
  const total = rows + 1;
  for (let row = 0; row < total; row += 1) {
    const y = top - row * rowHeight;
    // Borde inferior de cada celda por separado (rayas de 128 pt, no de ancho de pagina).
    for (let col = 0; col < 4; col += 1) {
      page.drawLine({
        start: { x: left + col * colWidth, y: y - rowHeight },
        end: { x: left + (col + 1) * colWidth, y: y - rowHeight },
        thickness: 0.75,
        color: INK,
      });
      const text = row === 0 ? headers[col] : cellText(row, col);
      page.drawText(text, { x: left + col * colWidth + 6, y: y - rowHeight + 11, size: 10, font: row === 0 ? bold : font, color: INK });
    }
  }
  // Bordes verticales y borde superior.
  for (let col = 0; col <= 4; col += 1) {
    page.drawLine({
      start: { x: left + col * colWidth, y: top },
      end: { x: left + col * colWidth, y: top - total * rowHeight },
      thickness: 0.75,
      color: INK,
    });
  }
  page.drawLine({ start: { x: left, y: top }, end: { x: left + 4 * colWidth, y: top }, thickness: 0.75, color: INK });
  return doc.save();
}

function cellText(row: number, col: number): string {
  switch (col) {
    case 0:
      return `Part ${1000 + row}`;
    case 1:
      return ["Fasteners", "Cables", "Housings", "Sensors"][row % 4];
    case 2:
      return String(10 + ((row * 7) % 90));
    default:
      return `$${(row * 3.25 + 2).toFixed(2)}`;
  }
}

/** Una pagina que es SOLO una imagen (sin texto extraible): una foto con rayas oscuras. */
export async function makeImageOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const width = 640;
  const height = 880;
  const png = encodePng(width, height, (x, y) => {
    // Cielo en degradado + "suelo" + unas rayas oscuras horizontales (lo que engaña a la heuristica raster).
    const base = 90 + Math.round((y / height) * 120);
    const stripe = y % 110 < 3 && x > 40 && x < width - 40;
    if (stripe) return [20, 20, 24, 255];
    const noise = ((x * 31 + y * 17) % 23) - 11;
    return [clamp8(base + noise), clamp8(base + 20 + noise), clamp8(base + 60 + noise), 255];
  });
  const image = await doc.embedPng(png);
  const page = doc.addPage([595.28, 841.89]);
  page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return doc.save();
}

export type FormFieldSpec = { label: string; x: number; y: number };

/**
 * Formulario real: rayas de relleno con su etiqueta a la izquierda ("Nombre: ____"),
 * dos con la etiqueta encima y una con guiones bajos de texto. Devuelve cuantos huecos
 * genuinos hay (la medida del 90 % de aciertos) y una cabecera con regla a todo lo ancho
 * que NO es un hueco.
 */
export async function makeFormPdf(): Promise<{ bytes: Uint8Array; genuine: number }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Membership application", { x: 50, y: 790, size: 18, font: bold, color: INK });
  page.drawLine({ start: { x: 50, y: 776 }, end: { x: 545, y: 776 }, thickness: 1, color: INK });

  let genuine = 0;
  const underlined = (label: string, y: number, from = 50, to = 300) => {
    page.drawText(label, { x: from, y, size: 11, font, color: INK });
    const labelWidth = font.widthOfTextAtSize(label, 11);
    page.drawLine({
      start: { x: from + labelWidth + 6, y: y - 2 },
      end: { x: to, y: y - 2 },
      thickness: 0.8,
      color: INK,
    });
    genuine += 1;
  };
  underlined("Nombre:", 730);
  underlined("Apellidos:", 700);
  underlined("DNI:", 670, 50, 200);
  underlined("Direccion:", 640);
  underlined("Telefono:", 610, 50, 250);
  underlined("Email:", 580);
  underlined("Fecha:", 550, 50, 220);
  // Segunda columna.
  underlined("Ciudad:", 730, 320, 540);
  underlined("Provincia:", 700, 320, 540);
  underlined("Codigo postal:", 670, 320, 480);

  // Etiqueta ENCIMA de la raya (firma).
  page.drawText("Firma del solicitante", { x: 50, y: 470, size: 9, font, color: GRAY });
  page.drawLine({ start: { x: 50, y: 440 }, end: { x: 250, y: 440 }, thickness: 0.8, color: INK });
  genuine += 1;
  page.drawText("Firma del tutor", { x: 320, y: 470, size: 9, font, color: GRAY });
  page.drawLine({ start: { x: 320, y: 440 }, end: { x: 520, y: 440 }, thickness: 0.8, color: INK });
  genuine += 1;

  // Guiones bajos de texto.
  page.drawText("Observaciones: ________________________________", { x: 50, y: 380, size: 11, font, color: INK });
  genuine += 1;
  page.drawText("Referido por: ____________________", { x: 50, y: 350, size: 11, font, color: INK });
  genuine += 1;

  // Cosas que NO son huecos: una caja con texto y una regla decorativa de pie.
  page.drawRectangle({ x: 50, y: 200, width: 495, height: 90, borderColor: INK, borderWidth: 0.8 });
  page.drawText("Reserved for office use only. Do not write below this line.", { x: 60, y: 270, size: 9, font, color: GRAY });
  page.drawLine({ start: { x: 50, y: 90 }, end: { x: 545, y: 90 }, thickness: 0.5, color: GRAY });
  page.drawText("Page 1 of 1", { x: 270, y: 74, size: 8, font, color: GRAY });
  return { bytes: await doc.save(), genuine };
}

/** Documento largo (16 paginas) con texto y reglas: la queja de «157 Field N». */
export async function makeLongReportPdf(pages = 16): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Section ${index + 1}`, { x: 50, y: 790, size: 16, font: bold, color: INK });
    page.drawRectangle({ x: 50, y: 780, width: 80, height: 3, color: INK });
    let y = 750;
    for (let line = 0; line < 20; line += 1) {
      page.drawText(`Line ${line + 1} of the quarterly report with figures ${line * 13}.`, { x: 50, y, size: 10, font, color: INK });
      // Cada pocas lineas, una regla fina tipo separador de fila.
      if (line % 2 === 0) page.drawRectangle({ x: 50, y: y - 6, width: 495, height: 0.5, color: RULE });
      y -= 30;
    }
  }
  return doc.save();
}

/** Regla fina horizontal, dibujada como linea o como rectangulo relleno (los dos modos de los PDF reales). */
function hairline(page: PDFPage, from: number, to: number, y: number, mode: "line" | "rect"): void {
  if (mode === "line") {
    page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness: 0.5, color: RULE });
  } else {
    page.drawRectangle({ x: from, y, width: to - from, height: 0.5, color: RULE });
  }
}

/** Nombre y bytes de los cinco documentos para scripts y E2E. */
export async function allSyntheticPdfs(): Promise<Record<string, Uint8Array>> {
  const form = await makeFormPdf();
  return {
    "recibo.pdf": await makeReceiptPdf(),
    "presentacion.pdf": await makePresentationPdf(),
    "tabla.pdf": await makeTablePdf(),
    "solo-imagen.pdf": await makeImageOnlyPdf(),
    "formulario.pdf": form.bytes,
    "texto-pequeno.pdf": await makeSmallTextPdf(),
  };
}

/* ------------------------------------------------------------------ *
 * PNG minimo (RGBA 8 bits, sin filtro)
 * ------------------------------------------------------------------ */

function clamp8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Codifica una imagen RGBA 8 bits a PNG. */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // profundidad
  header[9] = 6; // RGBA
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const parts = [signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}



/* ------------------------------------------------------------------ *
 * Variantes para medir la deteccion de huecos (W6-A r2)
 * ------------------------------------------------------------------ */

export type DetectionVariant = {
  name: string;
  bytes: Uint8Array;
  /** `form`: los huecos son `labels`; el resto no debe sugerir NADA. */
  kind: "form" | "nonform" | "table";
  labels: string[];
};

type Draw = (page: PDFPage, font: PDFFont, bold: PDFFont) => void;

async function variant(
  name: string,
  kind: DetectionVariant["kind"],
  labels: string[],
  draw: Draw,
  size: [number, number] = [595, 842],
): Promise<DetectionVariant> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  draw(doc.addPage(size), font, bold);
  return { name, kind, labels, bytes: await doc.save() };
}

const BLACK = rgb(0, 0, 0);
function rule(page: PDFPage, x0: number, x1: number, y: number, thickness = 0.8, dash?: number[]) {
  page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color: BLACK, ...(dash ? { dashArray: dash } : {}) });
}

/** Formularios con rayas, cajas, rotulos a la izquierda o encima, en 1 a 3 columnas, y documentos que NO lo son. */
export async function makeDetectionVariants(): Promise<DetectionVariant[]> {
  const out: DetectionVariant[] = [];
  const fieldNames = ["Nombre", "Apellidos", "Direccion", "Telefono", "Correo", "Observaciones"];

  out.push(
    await variant("form-lines-label-above", "form", fieldNames, (page, font) => {
      fieldNames.forEach((label, index) => {
        const y = 735 - index * 50;
        page.drawText(label, { x: 60, y: y + 16, size: 8, font });
        rule(page, 60, 330, y, 0.5);
      });
    }),
    await variant("form-boxes-label-left", "form", fieldNames.slice(0, 5), (page, font) => {
      fieldNames.slice(0, 5).forEach((label, index) => {
        const y = 720 - index * 40;
        page.drawText(label, { x: 60, y: y + 8, size: 10, font });
        page.drawRectangle({ x: 160, y, width: 250, height: 22, borderColor: BLACK, borderWidth: 0.8 });
      });
    }),
    await variant("form-boxes-label-above-3col", "form", ["Dia", "Mes", "Ano", "Nombre", "Apellido", "Cargo"], (page, font) => {
      [["Dia", "Mes", "Ano"], ["Nombre", "Apellido", "Cargo"]].forEach((row, r) =>
        row.forEach((label, c) => {
          const x = 50 + c * 170;
          const y = 700 - r * 80;
          page.drawText(label, { x, y: y + 30, size: 9, font });
          page.drawRectangle({ x, y, width: 150, height: 24, borderColor: BLACK, borderWidth: 0.8 });
        }),
      );
    }),
    await variant("form-lines-2col-label-left", "form", ["Nombre", "Ciudad", "Apellido", "Provincia"], (page, font) => {
      [["Nombre", "Ciudad"], ["Apellido", "Provincia"]].forEach(([a, c], index) => {
        const y = 740 - index * 36;
        page.drawText(`${a}:`, { x: 50, y, size: 11, font });
        rule(page, 50 + font.widthOfTextAtSize(`${a}:`, 11) + 6, 270, y - 2);
        page.drawText(`${c}:`, { x: 310, y, size: 11, font });
        rule(page, 310 + font.widthOfTextAtSize(`${c}:`, 11) + 6, 545, y - 2);
      });
    }),
    await variant("form-lines-long-label-left", "form", ["Nombre y apellidos", "Domicilio completo", "Motivo de la solicitud"], (page, font) => {
      ["Nombre y apellidos", "Domicilio completo", "Motivo de la solicitud"].forEach((label, index) => {
        const y = 740 - index * 40;
        page.drawText(`${label}:`, { x: 50, y, size: 11, font });
        rule(page, 50 + font.widthOfTextAtSize(`${label}:`, 11) + 6, 545, y - 2);
      });
    }),
    await variant("form-boxes-tall-and-wide", "form", ["Asunto", "Detalle"], (page, font) => {
      [["Asunto", 24], ["Detalle", 90]].forEach(([label, height], index) => {
        const y = 720 - index * 130;
        page.drawText(String(label), { x: 50, y: y + Number(height) + 8, size: 10, font });
        page.drawRectangle({ x: 50, y, width: 430, height: Number(height), borderColor: BLACK, borderWidth: 0.8 });
      });
    }),
    await variant("form-signature-blocks", "form", ["Firma del cliente", "Firma del vendedor", "Fecha", "Testigo"], (page, font) => {
      page.drawText("Acuerdo firmado por las partes en la fecha indicada.", { x: 50, y: 700, size: 11, font });
      [["Firma del cliente", 50, 560], ["Firma del vendedor", 320, 560], ["Fecha", 50, 440], ["Testigo", 320, 440]].forEach(([label, x, y]) => {
        rule(page, Number(x), Number(x) + 200, Number(y));
        page.drawText(String(label), { x: Number(x), y: Number(y) - 14, size: 9, font });
      });
    }),
    await variant("form-invoice-notes-box", "form", ["Observaciones"], (page, font) => {
      for (let i = 0; i < 6; i += 1) {
        const y = 720 - i * 18;
        page.drawText(`Concepto ${i}`, { x: 60, y, size: 10, font });
        page.drawText((10 + i).toFixed(2), { x: 480, y, size: 10, font });
        rule(page, 55, 540, y - 4, 0.4);
      }
      page.drawText("Observaciones", { x: 55, y: 560, size: 10, font });
      page.drawRectangle({ x: 55, y: 480, width: 485, height: 70, borderColor: BLACK, borderWidth: 0.7 });
    }),
    await variant("form-chromium-like-inputs", "form", ["Nombre", "Apellido", "Cedula"], (page, font) => {
      // Un <input> de Chromium: caja de fondo + borde inferior, la raya pegada al borde de la caja.
      ["Nombre", "Apellido", "Cedula"].forEach((label, index) => {
        const y = 780 - index * 26;
        page.drawText(`${label}:`, { x: 6, y: y + 3, size: 12, font });
        page.drawRectangle({ x: 56, y, width: 195, height: 13.5, color: rgb(1, 1, 1) });
        rule(page, 56, 251, y, 0.7);
      });
    }),
    // ---- NO son formularios ----
    await variant("not-totals-underline", "nonform", [], (page, font) => {
      ["Subtotal", "IVA 16%", "TOTAL"].forEach((label, index) => {
        const y = 600 - index * 22;
        page.drawText(label, { x: 380, y: y + 4, size: 10, font });
        if (index < 2) page.drawText((100 + index * 7).toFixed(2), { x: 500, y: y + 4, size: 10, font });
      });
      // Raya de la columna de importes, a la derecha del rotulo de totales.
      page.drawText("Subtotal", { x: 400, y: 400, size: 10, font });
      rule(page, 440, 535, 396, 0.5);
    }),
    await variant("not-gantt-bars", "nonform", [], (page, font) => {
      for (let i = 0; i < 12; i += 1) {
        const y = 760 - i * 28;
        page.drawText(`Tarea ${i + 1}`, { x: 60, y, size: 9, font });
        page.drawRectangle({ x: 140 + i * 18, y: y - 1.5, width: 120, height: 5, color: rgb(0.2, 0.4, 0.8) });
      }
    }),
    await variant("not-leader-lines", "nonform", [], (page, font) => {
      for (let i = 0; i < 10; i += 1) {
        const y = 760 - i * 22;
        page.drawText(`Capitulo ${i + 1}`, { x: 60, y, size: 11, font });
        rule(page, 150, 480, y + 2, 0.8, [1, 3]);
        page.drawText(String(i * 10 + 3), { x: 500, y, size: 11, font });
      }
    }),
    await variant("not-table-3col-row-lines", "table", [], (page, font) => {
      for (let i = 0; i < 22; i += 1) {
        const y = 780 - i * 24;
        [`Producto ${i}`, String(i * 3), `$${i * 5}`].forEach((text, c) => page.drawText(text, { x: 60 + c * 170, y: y + 8, size: 10, font }));
        rule(page, 55, 300, y, 0.5);
        rule(page, 310, 400, y, 0.5);
        rule(page, 410, 540, y, 0.5);
      }
    }),
    await variant("not-calendar-grid", "nonform", [], (page, font) => {
      for (let r = 0; r < 5; r += 1) {
        for (let c = 0; c < 7; c += 1) {
          page.drawRectangle({ x: 50 + c * 70, y: 700 - r * 60, width: 70, height: 60, borderColor: BLACK, borderWidth: 0.6 });
          page.drawText(String(r * 7 + c + 1), { x: 56 + c * 70, y: 740 - r * 60, size: 9, font });
        }
      }
    }),
    await variant("not-org-chart-boxes", "nonform", [], (page, font) => {
      [[250, 700], [100, 600], [250, 600], [400, 600]].forEach(([x, y], index) => {
        page.drawRectangle({ x, y, width: 100, height: 36, borderColor: BLACK, borderWidth: 0.8 });
        page.drawText(`Area ${index}`, { x: x + 25, y: y + 12, size: 10, font });
      });
      rule(page, 150, 450, 660);
    }),
    await variant("not-columns-text-with-rules", "nonform", [], (page, font) => {
      for (let i = 0; i < 8; i += 1) {
        const y = 760 - i * 80;
        [`Titulo corto ${i}`, `Otro titulo ${i}`].forEach((text, c) => {
          const x = 50 + c * 260;
          page.drawText(text, { x, y, size: 12, font });
          rule(page, x, x + 220, y - 6, 0.5);
          page.drawText("Texto de la columna con una frase completa de ejemplo.", { x, y: y - 20, size: 9, font });
        });
      }
    }),
    await variant("not-headings-underlined", "nonform", [], (page, font, bold) => {
      ["Introduccion", "Metodos", "Resultados", "Discusion"].forEach((text, i) => {
        const y = 760 - i * 150;
        page.drawText(text, { x: 60, y, size: 16, font: bold });
        rule(page, 60, 60 + bold.widthOfTextAtSize(text, 16), y - 3, 1);
        rule(page, 60, 200, y - 10, 2);
        for (let k = 0; k < 4; k += 1) page.drawText(`Linea de texto del apartado numero ${k + 1} con contenido.`, { x: 60, y: y - 30 - k * 14, size: 10, font });
      });
    }),
  );
  return out;
}
