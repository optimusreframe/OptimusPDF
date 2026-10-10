/*
 * Formularios y documentos NO formulario generados a cualquier escala y tamano de letra (W6-A r3).
 *
 * La deteccion de huecos mide todo en la unidad tipografica del documento (el tamano de letra
 * tipico), no en puntos: un formulario con etiquetas de 14 pt, ampliado un 25 % o impreso en A3
 * se analiza igual que uno de 11 pt en A4. Estas funciones dibujan, con pdf-lib y sin
 * constantes en puntos absolutos (todo sale de `fontPt` y `scale`), un mismo diseno a cualquier
 * escala para comprobarlo. Solo para pruebas.
 */

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";

export type PageName = "A4" | "Letter" | "A3" | "A5";
const PAGES: Record<PageName, [number, number]> = { A4: [595, 842], Letter: [612, 792], A3: [842, 1191], A5: [420, 595] };

export type ScaleOptions = {
  /** Tamano de letra de las etiquetas, en pt, a escala 1. */
  fontPt?: number;
  /** Ampliacion de TODA la pagina (contenido y papel). */
  scale?: number;
  page?: PageName;
  /** Giro de pagina (/Rotate). */
  rotate?: 0 | 90 | 180 | 270;
  /** Tamano del texto corriente respecto a las etiquetas (1 = igual; 0,7 = texto mas pequeno). */
  bodyRatio?: number;
  /** Margen de la pagina en pt de diseno (por defecto el 10 % del ancho; 18 = 0,25 pulgadas). */
  margin?: number;
};

export type ScaleFormKind =
  | "lines-left"
  | "lines-above"
  | "boxes-left"
  | "boxes-above"
  | "dotted-marks"
  | "dashed"
  | "dots-text"
  | "survey"
  | "sign-captions"
  | "caption-cells"
  | "table-form"
  | "inline"
  | "right-labels"
  | "wide-lines"
  | "short-lines"
  | "line-then-label"
  | "box-then-label"
  | "filled-line-label";

export type ScaleNonFormKind =
  | "progress-rects"
  | "progress-lines"
  | "gantt"
  | "price-cards"
  | "chart-gridlines"
  | "totals"
  | "toc-dots"
  | "report-rules"
  | "receipt-dashed"
  | "lined-paper"
  | "table-grid"
  | "calendar"
  | "thick-lines"
  | "gantt-rows"
  | "progress-pct"
  | "cards-title-rule"
  | "schedule-leaders";

export const SCALE_FORM_KINDS: readonly ScaleFormKind[] = [
  "lines-left", "lines-above", "boxes-left", "boxes-above", "dotted-marks", "dashed", "dots-text", "survey",
  "sign-captions", "caption-cells", "table-form", "inline", "right-labels", "wide-lines", "short-lines",
  "line-then-label", "box-then-label", "filled-line-label",
];
export const SCALE_NONFORM_KINDS: readonly ScaleNonFormKind[] = [
  "progress-rects", "progress-lines", "gantt", "price-cards", "chart-gridlines", "totals", "toc-dots",
  "report-rules", "receipt-dashed", "lined-paper", "table-grid", "calendar", "thick-lines",
  "gantt-rows", "progress-pct", "cards-title-rule", "schedule-leaders",
];

const LABELS = ["Nombre completo", "Fecha de nacimiento", "Dirección", "Teléfono", "Correo electrónico", "Ocupación", "Ciudad", "Cédula", "Empresa", "Cargo"];
const BODY = "Declaro que la información suministrada es veraz y autorizo su verificación por parte de la entidad.";

type Ctx = {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  /** Ancho y alto de diseno (pt a escala 1). */
  W: number;
  H: number;
  fs: number;
  body: number;
  k: number;
  margin: number;
  labels: string[];
};

const col = (g: number) => rgb(g, g, g);

function makeApi(c: Ctx) {
  const { page, k, H } = c;
  return {
    text: (x: number, y: number, str: string, size = c.fs, opts: { bold?: boolean; mono?: boolean; gray?: number } = {}) => {
      const font = opts.mono ? c.mono : opts.bold ? c.bold : c.font;
      page.drawText(str, { x: x * k, y: (H - y) * k, size: size * k, font, color: col(opts.gray ?? 0) });
      return font.widthOfTextAtSize(str, size);
    },
    width: (str: string, size = c.fs, mono = false) => (mono ? c.mono : c.font).widthOfTextAtSize(str, size),
    line: (x0: number, x1: number, y: number, th = 0.8, o: { dash?: number[]; gray?: number } = {}) =>
      page.drawLine({
        start: { x: x0 * k, y: (H - y) * k },
        end: { x: x1 * k, y: (H - y) * k },
        thickness: th * k,
        color: col(o.gray ?? 0),
        dashArray: o.dash?.map((d) => d * k),
      }),
    rect: (x: number, y: number, w: number, h: number, o: { th?: number; fill?: number | [number, number, number]; gray?: number } = {}) =>
      page.drawRectangle({
        x: x * k,
        y: (H - y - h) * k,
        width: w * k,
        height: h * k,
        borderWidth: o.th ? o.th * k : 0,
        borderColor: o.th ? col(o.gray ?? 0) : undefined,
        color: o.fill === undefined ? undefined : Array.isArray(o.fill) ? rgb(...o.fill) : col(o.fill),
      }),
    vline: (x: number, y0: number, y1: number, th = 0.8) =>
      page.drawLine({ start: { x: x * k, y: (H - y0) * k }, end: { x: x * k, y: (H - y1) * k }, thickness: th * k, color: col(0) }),
  };
}

async function setup(opts: ScaleOptions): Promise<{ pdf: PDFDocument; c: Ctx; api: ReturnType<typeof makeApi> }> {
  const pdf = await PDFDocument.create();
  const [W, H] = PAGES[opts.page ?? "A4"];
  const k = opts.scale ?? 1;
  const page = pdf.addPage([W * k, H * k]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const fs = opts.fontPt ?? 11;
  const c: Ctx = { page, font, bold, mono, W, H, fs, body: fs * (opts.bodyRatio ?? 1), k, margin: opts.margin ?? Math.round(W * 0.1), labels: [] };
  return { pdf, c, api: makeApi(c) };
}

function header(c: Ctx, api: ReturnType<typeof makeApi>, title: string, withBody: boolean): number {
  let y = c.margin + c.fs * 1.6;
  api.text(c.margin, y, title, c.fs * 1.6, { bold: true });
  y += c.fs * 2.4;
  if (withBody) {
    // Texto corriente largo: fija la unidad tipografica del documento.
    let line = "";
    const words = `${BODY} ${BODY}`.split(" ");
    const maxWidth = c.W - 2 * c.margin;
    const lines: string[] = [];
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (api.width(next, c.body) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
    for (const text of lines.slice(0, 4)) {
      api.text(c.margin, y, text, c.body);
      y += c.body * 1.4;
    }
    y += c.fs * 1.4;
  }
  return y;
}

export type ScaleForm = { bytes: Uint8Array; labels: string[] };

/** Un formulario del tipo pedido a la escala, letra y papel pedidos. Devuelve las etiquetas de sus huecos. */
export async function makeScaleForm(kind: ScaleFormKind, opts: ScaleOptions = {}): Promise<ScaleForm> {
  const { pdf, c, api } = await setup(opts);
  const { fs, margin, W } = c;
  let y = header(c, api, "Solicitud", kind !== "dots-text" || true);
  const content = W - 2 * margin;
  const labels: string[] = [];

  if (kind === "lines-left" || kind === "dashed" || kind === "dotted-marks" || kind === "dots-text") {
    const names = LABELS.slice(0, 6);
    const labW = Math.max(...names.map((n) => api.width(`${n}:`, fs)));
    for (const name of names) {
      const text = `${name}:`;
      const w = api.text(margin, y, text, fs);
      const x0 = margin + labW + fs * 0.8;
      const x1 = margin + content;
      const ly = y + fs * 0.3;
      if (kind === "dashed") api.line(x0, x1, ly, 0.8, { dash: [fs * 0.35, fs * 0.25] });
      else if (kind === "dotted-marks") for (let x = x0; x < x1 - 1; x += fs * 0.3) api.rect(x, ly - 0.4, fs * 0.09, fs * 0.09, { fill: 0 });
      else if (kind === "dots-text") api.text(x0, y, ".".repeat(Math.floor((x1 - x0) / api.width(".", fs))), fs);
      else api.line(x0, x1, ly, 0.8);
      labels.push(name);
      void w;
      y += fs * 3;
    }
  } else if (kind === "lines-above") {
    for (const name of LABELS.slice(0, 5)) {
      api.text(margin, y, name, fs * 0.9);
      api.line(margin, margin + content, y + fs * 2.2, 0.8);
      labels.push(name);
      y += fs * 4.2;
    }
  } else if (kind === "wide-lines") {
    // Lineas de respuesta de borde a borde con el enunciado encima (encuesta / examen).
    for (const [index, name] of ["¿Cómo conoció el servicio?", "¿Qué mejoraría?", "Comentarios adicionales:"].entries()) {
      api.text(margin, y, `${index + 1}. ${name}`, fs);
      api.line(margin, margin + content, y + fs * 2.6, 0.7);
      labels.push(name);
      y += fs * 4.6;
    }
  } else if (kind === "short-lines") {
    // Rayas CORTAS (cinco em): a escalas pequenas miden menos de 30 pt absolutos y deben contar igual.
    const w = fs * 5;
    for (const row of [["Edad", "Sexo", "Talla"], ["Peso", "Zona", "Grupo"]]) {
      let x = margin;
      for (const name of row) {
        const tw = api.text(x, y, `${name}:`, fs);
        api.line(x + tw + fs * 0.5, x + tw + fs * 0.5 + w, y + fs * 0.3, 0.8);
        labels.push(name);
        x += tw + w + fs * 3;
      }
      y += fs * 3;
    }
  } else if (kind === "line-then-label" || kind === "box-then-label" || kind === "filled-line-label") {
    // Raya (o caja, o fondo + raya) con la LEYENDA DEBAJO, en dos columnas, despues de un parrafo: la primera fila cuenta igual que las demas.
    const cols = 2;
    const gap = fs * 2;
    const cw = (content - gap * (cols - 1)) / cols;
    LABELS.slice(0, 6).forEach((name, i) => {
      const cx = margin + (i % cols) * (cw + gap);
      const ly = y + fs * 2.2 + Math.floor(i / cols) * fs * 4.8;
      const hb = fs * 1.9;
      if (kind === "box-then-label") api.rect(cx, ly - hb, cw, hb, { th: 0.8 });
      else {
        if (kind === "filled-line-label") api.rect(cx, ly - hb, cw, hb, { fill: 0.94 });
        api.line(cx, cx + cw, ly, kind === "filled-line-label" ? 1.5 : 0.8);
      }
      api.text(cx + (cw - api.width(name, fs * 0.85)) / 2, ly + fs * 1.2, name, fs * 0.85);
      labels.push(name);
    });
  } else if (kind === "survey") {
    for (const [index, name] of ["¿Cómo conoció nuestro servicio?", "¿Qué mejoraría?", "¿Nos recomendaría? ¿Por qué?"].entries()) {
      api.text(margin, y, `${index + 1}. ${name}`, fs);
      api.line(margin, margin + content * 0.85, y + fs * 2.8, 0.7);
      labels.push(name);
      y += fs * 5;
    }
  } else if (kind === "boxes-left") {
    const names = LABELS.slice(0, 5);
    const labW = Math.max(...names.map((n) => api.width(`${n}:`, fs)));
    for (const name of names) {
      const hb = fs * 2;
      api.text(margin, y + hb / 2 + fs * 0.3, `${name}:`, fs);
      api.rect(margin + labW + fs, y, content - labW - fs, hb, { th: 0.8 });
      labels.push(name);
      y += hb + fs * 1.1;
    }
  } else if (kind === "boxes-above") {
    // Cuadricula de 3 columnas, cajas SEPARADAS con su rotulo encima.
    const cols = 3;
    const gap = fs * 1.6;
    const cw = (content - gap * (cols - 1)) / cols;
    LABELS.slice(0, 9).forEach((name, i) => {
      const cx = margin + (i % cols) * (cw + gap);
      const cy = y + Math.floor(i / cols) * fs * 5;
      api.text(cx, cy + fs * 0.8, name, fs * 0.85);
      api.rect(cx, cy + fs, cw, fs * 2, { th: 0.8 });
      labels.push(name);
    });
  } else if (kind === "sign-captions") {
    const cols = 3;
    const gap = fs * 2;
    const cw = (content - gap * (cols - 1)) / cols;
    for (const [row, names] of [["Firma del solicitante", "Nombre y apellidos", "Documento de identidad"], ["Fecha", "Testigo", "Sello"]].entries()) {
      const ly = y + fs * 3.5 + row * fs * 7;
      names.forEach((name, i) => {
        const cx = margin + i * (cw + gap);
        api.line(cx, cx + cw, ly, 0.8);
        api.text(cx, ly + fs * 1.1, name, fs * 0.85);
        labels.push(name);
      });
    }
  } else if (kind === "caption-cells") {
    // Formulario oficial: celdas pegadas con un rotulo pequeno arriba y el sitio para escribir debajo.
    const rows = [["1 Nombre", "2 Apellido"], ["3 Dirección", "4 Ciudad"], ["5 Teléfono", "6 Correo"]];
    const ch = fs * 4.2;
    rows.forEach((names, row) => {
      names.forEach((name, i) => {
        const cx = margin + (i * content) / 2;
        const cy = y + row * ch;
        api.rect(cx, cy, content / 2, ch, { th: 0.8 });
        api.text(cx + fs * 0.4, cy + fs * 1.1, name, fs * 0.8);
        labels.push(name);
      });
    });
  } else if (kind === "table-form") {
    const names = LABELS.slice(0, 5);
    const lw = content * 0.32;
    const rh = fs * 2.3;
    for (const name of names) {
      api.rect(margin, y, lw, rh, { fill: 0.88 });
      api.rect(margin, y, lw, rh, { th: 0.7 });
      api.rect(margin + lw, y, content - lw, rh, { th: 0.7 });
      api.text(margin + fs * 0.5, y + rh / 2 + fs * 0.33, name, fs);
      labels.push(name);
      y += rh;
    }
  } else if (kind === "inline") {
    const lh = fs * 2.6;
    let x = margin;
    const parts: Array<[string, number]> = [["Yo,", 14], ["con documento No.", 9], [", solicito permiso desde el día", 7], ["hasta el día", 7]];
    for (const [text, blank] of parts) {
      const w = api.width(`${text} `, fs);
      const bw = blank * fs;
      if (x + w + bw > margin + content) {
        x = margin;
        y += lh;
      }
      api.text(x, y, text, fs);
      x += w;
      api.line(x, x + bw, y + fs * 0.2, 0.8);
      labels.push(text.replace(/[,.]/g, "").trim());
      x += bw + fs * 0.5;
    }
  } else if (kind === "right-labels") {
    for (const name of ["Fecha", "Lugar", "Asunto", "Responsable"]) {
      const lx1 = margin + content * 0.7;
      api.line(margin, lx1, y + fs * 0.3, 0.8);
      api.text(lx1 + fs * 0.6, y, name, fs * 0.9, { gray: 0.35 });
      labels.push(name);
      y += fs * 3;
    }
  }
  const bytes = await finish(pdf, opts.rotate);
  return { bytes, labels };
}

async function finish(pdf: PDFDocument, rotate?: number): Promise<Uint8Array> {
  if (rotate) for (const page of pdf.getPages()) page.setRotation(degrees(rotate));
  return await pdf.save();
}

/** Un documento que NO es un formulario: no debe producir ninguna sugerencia a ninguna escala. */
export async function makeScaleNonForm(kind: ScaleNonFormKind, opts: ScaleOptions = {}): Promise<Uint8Array> {
  const { pdf, c, api } = await setup(opts);
  const { fs, margin, W } = c;
  const content = W - 2 * margin;
  let y = header(c, api, "Informe", true);

  if (kind === "progress-rects" || kind === "progress-lines") {
    const names = ["Diseño", "Desarrollo", "Pruebas", "Despliegue", "Soporte"];
    const lw = fs * 7;
    const tw = content - lw - fs * 4;
    names.forEach((name, i) => {
      api.text(margin, y + fs * 0.8, name, fs);
      const p = 0.3 + i * 0.15;
      if (kind === "progress-rects") {
        const bh = fs * 0.9;
        api.rect(margin + lw, y, tw, bh, { fill: 0.9 });
        api.rect(margin + lw, y, tw * p, bh, { fill: [0.1, 0.4, 0.8] });
        api.text(margin + lw + tw + fs * 0.6, y + fs * 0.8, `${Math.round(p * 100)}%`, fs);
      } else {
        api.line(margin + lw, margin + lw + tw, y + fs * 0.4, fs * 0.28, { gray: 0.85 });
        api.line(margin + lw, margin + lw + tw * p, y + fs * 0.4, fs * 0.28, { gray: 0.2 });
      }
      y += fs * 2.8;
    });
  } else if (kind === "gantt") {
    const names = ["Diseño", "Desarrollo", "Pruebas", "Despliegue"];
    const lw = fs * 8;
    const gw = content - lw;
    names.forEach((name, i) => {
      api.text(margin, y + fs * 0.9, name, fs);
      api.rect(margin + lw + (gw / 10) * i * 1.5, y + fs * 0.2, (gw / 10) * 3, fs * 0.8, { fill: [0.2, 0.6, 0.3] });
      api.line(margin, margin + content, y + fs * 1.6, 0.4, { gray: 0.8 });
      y += fs * 2.2;
    });
  } else if (kind === "price-cards") {
    const n = 3;
    const gap = fs * 1.5;
    const cw = (content - gap * (n - 1)) / n;
    ["Básico", "Pro", "Equipo"].forEach((name, i) => {
      const cx = margin + i * (cw + gap);
      api.rect(cx, y, cw, fs * 15, { th: 0.8 });
      api.text(cx + fs, y + fs * 2, name, fs * 1.2, { bold: true });
      api.text(cx + fs, y + fs * 4.4, `$${(i + 1) * 9}/mes`, fs * 1.6, { bold: true });
      api.line(cx + fs, cx + cw - fs, y + fs * 5.6, 0.6, { gray: 0.5 });
      ["Usuarios ilimitados", "Soporte 24/7", "10 GB"].forEach((feature, j) => {
        api.text(cx + fs, y + fs * (7.4 + j * 1.9), feature, fs * 0.95);
        api.line(cx + fs, cx + cw - fs, y + fs * (8.1 + j * 1.9), 0.4, { gray: 0.8 });
      });
    });
  } else if (kind === "chart-gridlines") {
    const gx = margin + fs * 3;
    const gw = content - fs * 3;
    const gh = fs * 18;
    for (let t = 0; t <= 4; t += 1) {
      const gy = y + gh - (gh / 4) * t;
      api.text(margin, gy + fs * 0.3, String(t * 20), fs * 0.85);
      api.line(gx, gx + gw, gy, 0.4, { gray: 0.8 });
    }
    [0.4, 0.7, 0.5, 0.9].forEach((h, i) => api.rect(gx + (gw / 4) * i + gw * 0.05, y + gh - gh * h, (gw / 4) * 0.5, gh * h, { fill: [0.2, 0.4, 0.8] }));
  } else if (kind === "totals") {
    const x1 = W - margin;
    for (const label of ["Subtotal", "IVA 19%", "Total a pagar"]) {
      const amount = "1.240,00";
      api.text(x1 - api.width(amount, fs), y, amount, fs);
      api.text(x1 - fs * 12, y, label, fs, { bold: label.startsWith("Total") });
      api.line(x1 - fs * 6, x1, y + fs * 0.3, 0.7);
      y += fs * 2;
    }
  } else if (kind === "toc-dots") {
    ["Introducción", "Antecedentes", "Metodología", "Resultados", "Conclusiones"].forEach((name, i) => {
      const w = api.text(margin, y, `${i + 1}. ${name}`, fs);
      const num = String((i + 1) * 12);
      const nw = api.width(num, fs);
      const dots = ".".repeat(Math.floor((content - w - nw - fs) / api.width(".", fs)));
      api.text(margin + w + fs * 0.4, y, dots, fs);
      api.text(W - margin - nw, y, num, fs);
      y += fs * 2;
    });
  } else if (kind === "report-rules") {
    for (const name of ["Resumen ejecutivo", "Resultados", "Conclusiones"]) {
      api.text(margin, y + fs, name, fs * 1.4, { bold: true });
      api.line(margin, W - margin, y + fs * 1.7, 1);
      y += fs * 2.6;
      api.text(margin, y, BODY, c.body);
      y += c.body * 2.2;
    }
    api.line(margin, W - margin, c.H - margin * 0.7, 0.5);
    api.text(margin, c.H - margin * 0.7 + fs * 1.3, "Página 1 de 1", fs * 0.8);
  } else if (kind === "receipt-dashed") {
    const w = Math.min(content, fs * 24);
    const x0 = (W - w) / 2;
    api.text(x0 + w / 2 - fs * 3, y, "TIENDA LA 14", fs * 1.2, { bold: true });
    y += fs * 1.8;
    api.line(x0, x0 + w, y, 0.8, { dash: [3, 2] });
    y += fs * 1.8;
    for (const item of ["Pan", "Leche", "Arroz"]) {
      api.text(x0, y, item, fs);
      api.text(x0 + w - api.width("12,50", fs), y, "12,50", fs);
      y += fs * 1.6;
    }
    api.line(x0, x0 + w, y, 0.8, { dash: [3, 2] });
    y += fs * 1.8;
    api.text(x0, y, "TOTAL", fs, { bold: true });
    api.text(x0 + w - api.width("37,50", fs), y, "37,50", fs, { bold: true });
    y += fs * 1.6;
    api.line(x0, x0 + w, y, 0.8, { dash: [3, 2] });
  } else if (kind === "lined-paper") {
    while (y + fs * 2 < c.H - margin) {
      api.line(margin * 0.7, W - margin * 0.7, y, 0.6, { gray: 0.7 });
      y += fs * 2.1;
    }
  } else if (kind === "table-grid") {
    const cols = 4;
    const cw = content / cols;
    const rh = fs * 1.9;
    for (let r = 0; r < 12; r += 1) {
      for (let col2 = 0; col2 < cols; col2 += 1) {
        api.rect(margin + col2 * cw, y, cw, rh, { th: 0.6 });
        api.text(margin + col2 * cw + fs * 0.4, y + rh / 2 + fs * 0.33, r === 0 ? `Col ${col2 + 1}` : col2 ? `${r * 37},50` : `Item ${r}`, fs);
      }
      y += rh;
    }
  } else if (kind === "gantt-rows") {
    const lw = fs * 7;
    const gw = content - lw;
    const rh = fs * 2.6;
    const y0 = y;
    ["Análisis", "Diseño", "Desarrollo", "Pruebas", "Entrega"].forEach((name, i) => {
      api.rect(margin + lw, y, gw, rh, { fill: 0.93 });
      api.text(margin + fs * 0.6, y + rh / 2 + fs * 0.3, name, fs);
      api.rect(margin + lw + gw * (0.05 + i * 0.14), y + rh * 0.25, gw * 0.3, rh * 0.5, { fill: [0.17, 0.54, 0.24] });
      api.line(margin, margin + content, y + rh, 0.5, { gray: 0.8 });
      y += rh;
    });
    api.rect(margin, y0, content, y - y0, { th: 0.7 });
  } else if (kind === "progress-pct") {
    const lw = fs * 8;
    const tw = content - lw;
    ["Diseño", "Desarrollo", "Pruebas", "Despliegue"].forEach((name, i) => {
      const bh = fs * 1.5;
      const p = 0.1 + i * 0.25;
      api.text(margin, y + bh / 2 + fs * 0.3, name, fs);
      api.rect(margin + lw, y, tw, bh, { fill: 0.9 });
      api.rect(margin + lw + 0.7, y + 0.7, (tw - 1.4) * p, bh - 1.4, { fill: [0.1, 0.4, 0.8] });
      api.text(margin + lw + tw - fs * 3, y + bh / 2 + fs * 0.3, `${Math.round(p * 100)}%`, fs * 0.9);
      y += bh + fs * 1.6;
    });
  } else if (kind === "cards-title-rule") {
    const n = 3;
    const gap = fs * 1.6;
    const cw = (content - gap * (n - 1)) / n;
    ["Gratis", "Plus", "Max"].forEach((name, i) => {
      const x = margin + i * (cw + gap);
      const ts = fs * 1.7;
      api.rect(x - fs * 0.5, y, cw + fs, fs * 14, { th: 0.8 });
      api.text(x + fs * 0.4, y + ts * 1.2, name, ts, { bold: true });
      api.line(x + fs * 0.4, x + cw - fs * 0.4, y + ts * 1.2 + ts * 0.6, 1);
      ["1 usuario", "Soporte básico", "10 GB"].forEach((feature, j) => api.text(x + fs * 0.4, y + ts * 2.8 + j * fs * 1.9, feature, fs));
    });
  } else if (kind === "schedule-leaders") {
    ["Registro", "Conferencia magistral", "Mesa redonda", "Comida", "Talleres", "Cierre"].forEach((event, i) => {
      const time = `${String(9 + i).padStart(2, "0")}:00`;
      const tw = api.text(margin, y, time, fs);
      const ew = api.width(event, fs);
      const x0 = margin + tw + fs * 0.5;
      const x1 = W - margin - ew - fs * 0.5;
      if (i % 2) api.line(x0, x1, y - fs * 0.15, 0.8, { dash: [1.5, 2.5] });
      else api.text(x0, y, ".".repeat(Math.floor((x1 - x0) / api.width(".", fs))), fs);
      api.text(W - margin - ew, y, event, fs);
      y += fs * 2.3;
    });
  } else if (kind === "thick-lines") {
    // Habilidades: cada barra es UNA raya gruesa trazada (no un rectangulo) con su etiqueta a la izquierda.
    ["JavaScript", "Python", "SQL", "Diseño"].forEach((name, i) => {
      api.text(margin, y + fs * 0.4, name, fs);
      api.line(margin + fs * 8, margin + fs * 8 + (content - fs * 8) * (0.5 + i * 0.12), y + fs * 0.1, fs * 0.3, { gray: 0.2 });
      y += fs * 2.4;
    });
  } else if (kind === "calendar") {
    const cw = content / 7;
    const ch = fs * 4;
    for (let r = 0; r < 5; r += 1) {
      for (let col2 = 0; col2 < 7; col2 += 1) {
        api.rect(margin + col2 * cw, y, cw, ch, { th: 0.6 });
        api.text(margin + col2 * cw + 3, y + fs * 1.1, String(r * 7 + col2 + 1), fs * 0.85);
      }
      y += ch;
    }
  }
  return await finish(pdf, opts.rotate);
}
