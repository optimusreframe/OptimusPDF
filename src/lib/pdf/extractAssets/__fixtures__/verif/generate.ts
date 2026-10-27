/**
 * VERIFICACION INDEPENDIENTE (verif8): corpus sintetico NUEVO (no es el del constructor). Firmas con tipografias manuscritas del sistema
 * (@napi-rs/canvas), fotos con ruido/sombra, senuelos, rotaciones, CropBox, cifrado, etc.
 *
 * Copiado del verificador SIN la parte hostil. Usa tipografias del sistema de macOS (Zapfino, Snell Roundhand, Bradley Hand...): en otro
 * sistema caen a la tipografia por defecto y los PDF cambian, asi que NO lo corre ninguna prueba: los PDF generados estan guardados en
 * `pdfs/` con su verdad en `truth.json` (la lee `evaluate.ts`). Se conserva para regenerar o ampliar el corpus en un Mac.
 */
import { PDFArray, PDFDocument, PDFName, PDFRef, PDFString, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import { createCanvas, type SKRSContext2D, type Canvas } from "@napi-rs/canvas";

export const W = 612;
export const H = 792;
export type NormRect = { x: number; y: number; width: number; height: number };
export type Cls = "signature" | "initials" | "logo" | "stamp" | "watermark" | "photo" | "image";
export type Exp = { cls: Cls; page: number; rect?: NormRect; pages?: number[]; tag: string; cond: string };
export type Case = { name: string; group: string; bytes: Uint8Array; expected: Exp[]; decoys: number; note?: string };

const norm = (b: Box): NormRect => ({ x: b.x / W, y: b.y / H, width: b.width / W, height: b.height / H });
type Box = { x: number; y: number; width: number; height: number };

/* ----------------------------------------------------------------------- rasters */
function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const INK = { blue: "#1b3a8f", black: "#161616", navy: "#0c2a6e", purple: "#5a2a86", gray: "#333" };

function cv(w: number, h: number): { c: Canvas; g: SKRSContext2D } {
  const c = createCanvas(w, h);
  return { c, g: c.getContext("2d") };
}

/** Firma tipografica manuscrita sobre fondo transparente con subrayado en floritura. */
export function scriptSig(text: string, family: string, w: number, h: number, color: string, opts: { rot?: number; flourish?: boolean; seed?: number } = {}): Canvas {
  const { c, g } = cv(w, h);
  const r = rand(opts.seed ?? 1);
  g.translate(w / 2, h / 2);
  g.rotate(opts.rot ?? -0.08);
  let size = h * 0.7;
  g.font = `${size}px "${family}"`;
  const m = g.measureText(text).width;
  if (m > w * 0.9) size = size * (w * 0.9) / m;
  g.font = `${size}px "${family}"`;
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, h * 0.012);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 0, -h * 0.05);
  if (opts.flourish !== false) {
    g.lineWidth = Math.max(1.5, h * 0.025);
    g.beginPath();
    g.moveTo(-w * 0.4, h * 0.28);
    g.bezierCurveTo(-w * 0.1, h * (0.38 + r() * 0.05), w * 0.2, h * 0.18, w * 0.42, h * (0.3 + r() * 0.05));
    g.stroke();
  }
  return c;
}

/** Garabato de firma: caminata de Bezier aleatoria con trazo de ancho variable. */
export function scribbleSig(w: number, h: number, color: string, seed: number): Canvas {
  const { c, g } = cv(w, h);
  const r = rand(seed);
  g.strokeStyle = color;
  g.lineCap = "round";
  g.lineJoin = "round";
  let x = w * 0.08;
  let y = h * 0.6;
  for (let seg = 0; seg < 9; seg += 1) {
    g.lineWidth = 1.2 + r() * 2.2;
    const nx = Math.min(w * 0.95, x + w * (0.08 + r() * 0.1));
    const ny = h * (0.2 + r() * 0.6);
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x - w * 0.05, h * r(), x + w * 0.12, h * (0.1 + r() * 0.8), nx, ny);
    g.bezierCurveTo(nx + w * 0.05, ny - h * 0.3, nx - w * 0.03, ny + h * 0.35, nx + 4, ny);
    g.stroke();
    x = nx;
    y = ny;
  }
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(w * 0.1, h * 0.85);
  g.bezierCurveTo(w * 0.4, h * 0.95, w * 0.7, h * 0.7, w * 0.95, h * 0.82);
  g.stroke();
  return c;
}

export function initialsRaster(letters: string, family: string, w: number, h: number, color: string): Canvas {
  return scriptSig(letters, family, w, h, color, { rot: -0.05, flourish: false });
}

/** Convierte un raster transparente en una «foto»: fondo de papel, ruido, sombra, JPEG. */
export function photoize(src: Canvas, opts: { bg: [number, number, number]; noise: number; shadow?: number; seed: number }): Canvas {
  const { c, g } = cv(src.width, src.height);
  g.fillStyle = `rgb(${opts.bg[0]},${opts.bg[1]},${opts.bg[2]})`;
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0);
  const r = rand(opts.seed);
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 2 * opts.noise;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
  if (opts.shadow) {
    const grad = g.createLinearGradient(0, 0, c.width, c.height * 0.4);
    grad.addColorStop(0, `rgba(0,0,0,${opts.shadow})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

export const pngOf = (c: Canvas): Uint8Array => new Uint8Array(c.toBuffer("image/png"));
export const jpgOf = (c: Canvas, q = 80): Uint8Array => new Uint8Array(c.toBuffer("image/jpeg", q));

/* decoys */
export function gridTable(w: number, h: number, rows = 5, cols = 4): Canvas {
  const { c, g } = cv(w, h);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#222";
  g.lineWidth = 1.5;
  for (let i = 0; i <= rows; i += 1) { g.beginPath(); g.moveTo(0, (i * (h - 2)) / rows + 1); g.lineTo(w, (i * (h - 2)) / rows + 1); g.stroke(); }
  for (let j = 0; j <= cols; j += 1) { g.beginPath(); g.moveTo((j * (w - 2)) / cols + 1, 0); g.lineTo((j * (w - 2)) / cols + 1, h); g.stroke(); }
  g.fillStyle = "#333";
  g.font = `${h / rows * 0.4}px sans-serif`;
  for (let i = 0; i < rows; i += 1) for (let j = 0; j < cols; j += 1) g.fillText(String(10 + i * cols + j), (j * w) / cols + 8, ((i + 0.65) * h) / rows);
  return c;
}
export function barChart(w: number, h: number, seed: number): Canvas {
  const { c, g } = cv(w, h);
  const r = rand(seed);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  const cols = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626"];
  for (let i = 0; i < 8; i += 1) {
    g.fillStyle = cols[i % 4];
    const bh = (0.2 + r() * 0.7) * (h - 20);
    g.fillRect(12 + i * (w - 24) / 8, h - 10 - bh, (w - 24) / 8 - 8, bh);
  }
  g.strokeStyle = "#444";
  g.beginPath(); g.moveTo(8, 6); g.lineTo(8, h - 10); g.lineTo(w - 6, h - 10); g.stroke();
  return c;
}
export function lineChart(w: number, h: number, seed: number): Canvas {
  const { c, g } = cv(w, h);
  const r = rand(seed);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#1d4ed8";
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 20; i += 1) { const x = 8 + (i * (w - 16)) / 20; const y = h * (0.2 + 0.6 * r()); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
  g.stroke();
  g.strokeStyle = "#999"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(8, 4); g.lineTo(8, h - 6); g.lineTo(w - 4, h - 6); g.stroke();
  return c;
}
export function qrCode(n: number, cell: number, seed: number): Canvas {
  const s = n * cell;
  const { c, g } = cv(s, s);
  const r = rand(seed);
  g.fillStyle = "#fff"; g.fillRect(0, 0, s, s);
  g.fillStyle = "#000";
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (r() > 0.5) g.fillRect(i * cell, j * cell, cell, cell);
  for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    g.fillStyle = "#fff"; g.fillRect(fx * cell, fy * cell, 7 * cell, 7 * cell);
    g.fillStyle = "#000"; g.fillRect(fx * cell, fy * cell, 7 * cell, 7 * cell);
    g.fillStyle = "#fff"; g.fillRect((fx + 1) * cell, (fy + 1) * cell, 5 * cell, 5 * cell);
    g.fillStyle = "#000"; g.fillRect((fx + 2) * cell, (fy + 2) * cell, 3 * cell, 3 * cell);
  }
  return c;
}
export function barcode(w: number, h: number, seed: number): Canvas {
  const { c, g } = cv(w, h);
  const r = rand(seed);
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#000";
  let x = 6;
  while (x < w - 6) { const bw = 1 + Math.floor(r() * 4); if (r() > 0.4) g.fillRect(x, 4, bw, h - 8); x += bw + 1; }
  return c;
}
export function photoRaster(w: number, h: number, seed: number): Canvas {
  const { c, g } = cv(w, h);
  const r = rand(seed);
  const gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, "#5b8fd9"); gr.addColorStop(0.5, "#d9b35b"); gr.addColorStop(1, "#3f7a4a");
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i += 1) {
    g.fillStyle = `hsla(${Math.floor(r() * 360)},60%,${30 + r() * 40}%,0.6)`;
    g.beginPath(); g.arc(r() * w, r() * h, 6 + r() * 30, 0, Math.PI * 2); g.fill();
  }
  return c;
}
export function checkIcon(s: number): Canvas {
  const { c, g } = cv(s, s);
  g.strokeStyle = "#15803d"; g.lineWidth = s * 0.14; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath(); g.moveTo(s * 0.2, s * 0.55); g.lineTo(s * 0.42, s * 0.75); g.lineTo(s * 0.8, s * 0.25); g.stroke();
  return c;
}
export function arrowIcon(w: number, h: number): Canvas {
  const { c, g } = cv(w, h);
  g.fillStyle = "#b91c1c";
  g.beginPath(); g.moveTo(0, h * 0.3); g.lineTo(w * 0.6, h * 0.3); g.lineTo(w * 0.6, 0); g.lineTo(w, h / 2); g.lineTo(w * 0.6, h); g.lineTo(w * 0.6, h * 0.7); g.lineTo(0, h * 0.7); g.closePath(); g.fill();
  return c;
}
export function typedName(text: string, w: number, h: number): Canvas {
  const { c, g } = cv(w, h);
  g.fillStyle = "#111"; g.font = `${h * 0.5}px Helvetica`; g.textBaseline = "middle"; g.fillText(text, 4, h / 2);
  return c;
}
export function banner(w: number, h: number): Canvas {
  const { c, g } = cv(w, h);
  const gr = g.createLinearGradient(0, 0, w, 0);
  gr.addColorStop(0, "#1e3a8a"); gr.addColorStop(1, "#38bdf8");
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  return c;
}
export function pieChart(s: number): Canvas {
  const { c, g } = cv(s, s);
  const cols = ["#2563eb", "#f59e0b", "#16a34a", "#dc2626"];
  let a = 0;
  for (let i = 0; i < 4; i += 1) { g.fillStyle = cols[i]; g.beginPath(); g.moveTo(s / 2, s / 2); g.arc(s / 2, s / 2, s * 0.47, a, a + (Math.PI / 2) * (0.6 + i * 0.3)); g.closePath(); g.fill(); a += (Math.PI / 2) * (0.6 + i * 0.3); }
  return c;
}
export function shadedBox(w: number, h: number): Canvas {
  const { c, g } = cv(w, h);
  g.fillStyle = "#e5e7eb"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "#9ca3af"; g.strokeRect(0.5, 0.5, w - 1, h - 1);
  return c;
}
export function textScan(w: number, h: number, seed: number): Canvas {
  const { c, g } = cv(w, h);
  const r = rand(seed);
  g.fillStyle = "#fbfbf8"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#222";
  for (let y = 8; y < h - 6; y += 9) { let x = 6; while (x < w - 10) { const ww = 6 + r() * 30; g.fillRect(x, y, ww, 3.2); x += ww + 4; } }
  return c;
}
export function logoWide(w: number, h: number, text: string, color: string): Canvas {
  const { c, g } = cv(w, h);
  g.fillStyle = color; g.beginPath(); g.arc(h / 2, h / 2, h * 0.42, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#fff"; g.font = `bold ${h * 0.4}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text[0], h / 2, h / 2);
  g.fillStyle = color; g.textAlign = "left"; g.font = `bold ${h * 0.5}px sans-serif`; g.fillText(text, h * 1.05, h / 2);
  return c;
}
export function logoSquare(s: number, color: string): Canvas {
  const { c, g } = cv(s, s);
  g.fillStyle = color; g.fillRect(s * 0.1, s * 0.1, s * 0.8, s * 0.8);
  g.fillStyle = "#fff"; g.beginPath(); g.moveTo(s * 0.3, s * 0.7); g.lineTo(s * 0.5, s * 0.25); g.lineTo(s * 0.7, s * 0.7); g.closePath(); g.fill();
  return c;
}
export function sealRound(s: number, color: string, text: string): Canvas {
  const { c, g } = cv(s, s);
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = s * 0.04;
  g.beginPath(); g.arc(s / 2, s / 2, s * 0.46, 0, Math.PI * 2); g.stroke();
  g.lineWidth = s * 0.015;
  g.beginPath(); g.arc(s / 2, s / 2, s * 0.38, 0, Math.PI * 2); g.stroke();
  g.font = `bold ${s * 0.16}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, s / 2, s / 2);
  return c;
}
export function stampRect(w: number, h: number, color: string, text: string): Canvas {
  const { c, g } = cv(w, h);
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = h * 0.08;
  g.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12);
  g.font = `bold ${h * 0.5}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, w / 2, h / 2);
  return c;
}
export function wmImage(w: number, h: number): Canvas {
  const { c, g } = cv(w, h);
  g.fillStyle = "#6b7280"; g.font = `bold ${h * 0.4}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("ACME", w / 2, h / 2);
  g.strokeStyle = "#6b7280"; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20);
  return c;
}
export function doodle(w: number, h: number): Canvas {
  const { c, g } = cv(w, h);
  g.strokeStyle = "#111"; g.lineWidth = 3;
  g.beginPath(); g.arc(w / 2, h / 2, Math.min(w, h) * 0.4, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(w * 0.38, h * 0.4, 3, 0, 7); g.arc(w * 0.62, h * 0.4, 3, 0, 7); g.stroke();
  g.beginPath(); g.arc(w / 2, h * 0.55, Math.min(w, h) * 0.2, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
  return c;
}
export function scanFullPage(sig: Canvas | null, seed: number): Canvas {
  const { c, g } = cv(1275, 1650);
  const r = rand(seed);
  g.fillStyle = "#f4f3ee"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#222";
  for (let i = 0; i < 28; i += 1) { let x = 120; while (x < 1100) { const ww = 20 + r() * 90; g.fillRect(x, 200 + i * 34, ww, 9); x += ww + 12; } }
  g.fillStyle = "#222"; g.fillRect(120, 1380, 520, 3);
  g.font = "28px sans-serif"; g.fillText("Firma:", 120, 1420);
  if (sig) g.drawImage(sig, 140, 1250, 440, 140);
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) { const n = (r() - 0.5) * 16; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  return c;
}

/* ----------------------------------------------------------------------- pdf builder */
export type B = { doc: PDFDocument; font: PDFFont; bold: PDFFont; expected: Exp[]; decoys: number };
export async function newB(): Promise<B> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  return { doc, font: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), expected: [], decoys: 0 };
}
const BODY = [
  "This agreement is entered into by the parties for the services described in the schedule below.",
  "Payment shall be made within thirty days of the invoice date unless otherwise agreed in writing.",
  "The supplier warrants that all work will be performed with reasonable care and skill at all times.",
  "Either party may terminate this agreement on written notice if the other party breaches a material term.",
  "El presente contrato se rige por las leyes aplicables y las partes se someten a los tribunales competentes.",
  "Cualquier modificacion debera constar por escrito y estar firmada por ambas partes interesadas.",
];
export function pageOf(b: B, title: string, lines = 14, top = 90): PDFPage {
  const page = b.doc.addPage([W, H]);
  page.drawText(title, { x: 56, y: H - top, size: 15, font: b.bold });
  for (let i = 0; i < lines; i += 1) page.drawText(BODY[i % BODY.length], { x: 56, y: H - (top + 30 + i * 17), size: 9.5, font: b.font, color: rgb(0.15, 0.15, 0.18) });
  return page;
}
export function lab(b: B, page: PDFPage, text: string, x: number, top: number, size = 10): void {
  page.drawText(text, { x, y: H - top - size * 0.85, size, font: b.font });
}
export function hline(page: PDFPage, x0: number, x1: number, top: number): void {
  page.drawLine({ start: { x: x0, y: H - top }, end: { x: x1, y: H - top }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
}
export async function img(b: B, page: PDFPage, data: Uint8Array, kind: "png" | "jpg", box: Box): Promise<void> {
  const im = kind === "png" ? await b.doc.embedPng(data) : await b.doc.embedJpg(data);
  page.drawImage(im, { x: box.x, y: H - box.y - box.height, width: box.width, height: box.height });
}
export function exp(b: B, cls: Cls, page: number, box: Box | null, tag: string, cond: string, pages?: number[]): void {
  b.expected.push({ cls, page, rect: box ? norm(box) : undefined, pages, tag, cond });
}
export const finish = async (b: B, name: string, group: string, extra: Partial<Case> = {}): Promise<Case> => ({ name, group, bytes: await b.doc.save({ useObjectStreams: false }), expected: b.expected, decoys: b.decoys, ...extra });

/** Bloque de firma: variantes de colocacion de la etiqueta. */
type Layout = "left" | "above" | "below-line" | "none" | "far";
async function sigBlock(b: B, page: PDFPage, pageIdx: number, sig: { data: Uint8Array; kind: "png" | "jpg"; ratio: number }, layout: Layout, labelText: string, opts: { width?: number; top?: number; x?: number; cls?: Cls; cond?: string; tag?: string } = {}): Promise<Box> {
  const width = opts.width ?? 170;
  const height = width / sig.ratio;
  const top = opts.top ?? 560;
  const x = opts.x ?? 150;
  let box: Box;
  if (layout === "left") { lab(b, page, labelText, 56, top + height * 0.6); hline(page, 56, 420, top + height + 4); box = { x, y: top, width, height }; }
  else if (layout === "above") { lab(b, page, labelText, 56, top - 16); box = { x: 56, y: top, width, height }; hline(page, 56, 56 + width + 60, top + height + 4); }
  else if (layout === "below-line") { box = { x: 70, y: top, width, height }; hline(page, 56, 360, top + height + 3); lab(b, page, labelText, 56, top + height + 8); }
  else if (layout === "far") { box = { x: 56, y: top, width, height }; lab(b, page, labelText, 56, top - 200); }
  else { box = { x: 330, y: top, width, height }; }
  await img(b, page, sig.data, sig.kind, box);
  exp(b, opts.cls ?? "signature", pageIdx, box, opts.tag ?? "firma", opts.cond ?? layout);
  return box;
}
const SIG = (text: string, family: string, color: string, seed = 1, w = 480, h = 150) => ({ data: pngOf(scriptSig(text, family, w, h, color, { seed })), kind: "png" as const, ratio: w / h });

/* ----------------------------------------------------------------------- vector helpers */
function svgSig(page: PDFPage, x: number, top: number, w: number, h: number, seed: number, color = rgb(0.1, 0.15, 0.55)): void {
  // cursiva con bucles: trocoides encadenados (x retrocede en cada bucle) + trazo final
  const r = rand(seed);
  const pts: Array<[number, number]> = [];
  const letters = 6;
  for (let l = 0; l < letters; l += 1) {
    const cx = (l + 0.5) * (w / letters);
    const rad = (h / 2) * (0.35 + 0.3 * r());
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const a = t * 2 * Math.PI;
      pts.push([cx + rad * 0.9 * Math.sin(a) - (w / letters) * 0.35 * Math.cos(a) + (w / letters) * 0.3 * t, h / 2 - rad * Math.cos(a) + (r() - 0.5) * 2]);
    }
  }
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i + 2 < pts.length; i += 3) d += ` C ${pts[i][0]} ${pts[i][1]}, ${pts[i + 1][0]} ${pts[i + 1][1]}, ${pts[i + 2][0]} ${pts[i + 2][1]}`;
  d += ` C ${w * 0.5} ${h * 0.95}, ${w * 0.8} ${h * 0.7}, ${w} ${h * 0.8}`;
  page.drawSvgPath(d, { x, y: H - top, borderColor: color, borderWidth: 1.6 });
}

/* ----------------------------------------------------------------------- low-level helpers */
export function addAnnot(doc: PDFDocument, page: PDFPage, dict: Record<string, unknown>): PDFRef {
  const ref = doc.context.register(doc.context.obj(dict as never));
  const existing = page.node.lookup(PDFName.of("Annots"));
  if (existing instanceof PDFArray) existing.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  return ref;
}
export function formXObject(doc: PDFDocument, bbox: number[], content: string, resources: Record<string, unknown> = {}): PDFRef {
  const stream = doc.context.stream(content, { Type: "XObject", Subtype: "Form", BBox: bbox, Resources: resources as never });
  return doc.context.register(stream);
}

/* ----------------------------------------------------------------------- cases */
export async function buildCases(): Promise<Case[]> {
  const cases: Case[] = [];

  /* ---------- firmas como imagen ---------- */
  const labelVariants: Array<[string, string, string]> = [
    ["Signature:", "left", "Zapfino"], ["Firma:", "above", "Snell Roundhand"], ["Firma del cliente", "below-line", "Bradley Hand"],
    ["Signed by:", "left", "Savoye LET"], ["Firmado por:", "left", "Apple Chancery"], ["Signatory", "above", "Noteworthy"],
    ["Authorized signature", "below-line", "Brush Script MT"], ["Firma autorizada", "below-line", "Zapfino"], ["Name & Signature", "left", "Snell Roundhand"],
    ["Nombre y firma", "above", "Bradley Hand"], ["Applicant's signature", "below-line", "Savoye LET"], ["Firma del titular", "left", "Apple Chancery"],
    ["Customer Signature", "above", "Noteworthy"], ["Sign here", "left", "Brush Script MT"], ["Rubrica", "left", "Zapfino"], ["Date / Signature", "below-line", "Snell Roundhand"],
    ["Assinatura", "left", "Bradley Hand"], ["Unterschrift", "left", "Savoye LET"], ["Customer:", "left", "Apple Chancery"], ["Witness", "left", "Noteworthy"],
  ];
  {
    // una pagina por variante de etiqueta; firmas distintas por pagina
    for (let k = 0; k < labelVariants.length; k += 1) {
      const [text, layout, fam] = labelVariants[k];
      const b = await newB();
      const page = pageOf(b, `Label variant: ${text}`);
      await sigBlock(b, page, 0, SIG(["Maria Lopez", "John R. Smith", "A. Fernandez", "Chen Wei", "Olga Petrova"][k % 5], fam, [INK.blue, INK.black, INK.navy, INK.purple][k % 4], k + 3), layout as Layout, text, { cond: `label:${text}` });
      cases.push(await finish(b, `s-label-${k.toString().padStart(2, "0")}-${text.replace(/[^a-z]/gi, "").toLowerCase()}`, "sig-label"));
    }
  }
  // sin etiqueta
  for (const [i, fam] of ["Zapfino", "Snell Roundhand", "Bradley Hand", "Savoye LET"].entries()) {
    const b = await newB();
    const page = pageOf(b, "Agreement without a signature label");
    await sigBlock(b, page, 0, SIG(["Laura Gomez", "T. Nakamura", "Ahmed K.", "Sofia Rossi"][i], fam, INK.blue, 40 + i), "none", "", { cond: "no-label" });
    cases.push(await finish(b, `s-nolabel-${i}`, "sig-nolabel"));
  }
  // etiqueta lejos
  {
    const b = await newB();
    const page = pageOf(b, "Far label");
    await sigBlock(b, page, 0, SIG("D. Alvarez", "Snell Roundhand", INK.navy, 77), "far", "Signature", { cond: "far-label" });
    cases.push(await finish(b, "s-far-label", "sig-nolabel"));
  }
  // JPEG blanco / gris / sombra / baja resolucion
  const photoVariants: Array<[string, [number, number, number], number, number, number, number]> = [
    ["jpeg-white", [252, 252, 250], 6, 0, 85, 480], ["jpeg-gray-scan", [205, 205, 203], 18, 0, 70, 480], ["jpeg-shadow", [240, 238, 232], 8, 0.35, 75, 480],
    ["jpeg-yellowish", [236, 226, 190], 10, 0.1, 70, 480], ["jpeg-lowres", [250, 250, 250], 6, 0, 50, 150], ["jpeg-dark-photo", [150, 150, 148], 22, 0.45, 60, 480],
  ];
  for (const [i, [tag, bg, noise, shadow, q, w]] of photoVariants.entries()) {
    for (const withLabel of [true, false]) {
      const b = await newB();
      const page = pageOf(b, `Photo of signature ${tag}`);
      const raster = photoize(scriptSig("Carlos Mendez", ["Zapfino", "Bradley Hand", "Snell Roundhand"][i % 3], w, w / 3.2, INK.blue, { seed: 9 + i }), { bg, noise, shadow, seed: 100 + i });
      await sigBlock(b, page, 0, { data: jpgOf(raster, q), kind: "jpg", ratio: 3.2 }, withLabel ? "left" : "none", "Signature:", { cond: `${tag}${withLabel ? "+label" : "+nolabel"}` });
      cases.push(await finish(b, `s-photo-${tag}-${withLabel ? "label" : "nolabel"}`, withLabel ? "sig-photo-label" : "sig-photo-nolabel"));
    }
  }
  // PNG opaco con papel blanco (escaneo transparente-no)
  {
    const b = await newB();
    const page = pageOf(b, "PNG opaque white background");
    const raster = photoize(scriptSig("R. Vega", "Apple Chancery", 480, 150, INK.black, { seed: 5 }), { bg: [255, 255, 255], noise: 0, seed: 1 });
    await sigBlock(b, page, 0, { data: pngOf(raster), kind: "png", ratio: 3.2 }, "above", "Firma:", { cond: "png-opaque-white+label" });
    cases.push(await finish(b, "s-png-opaque-white", "sig-photo-label"));
  }
  // garabato bezier
  for (const [i, color] of [INK.blue, INK.black, INK.purple].entries()) {
    const b = await newB();
    const page = pageOf(b, "Scribble signature");
    await sigBlock(b, page, 0, { data: pngOf(scribbleSig(480, 150, color, 200 + i)), kind: "png", ratio: 3.2 }, "left", "Signature:", { cond: `scribble${i}` });
    cases.push(await finish(b, `s-scribble-${i}`, "sig-label"));
  }
  // grande, tipo DocuSign X ___
  {
    const b = await newB();
    const page = pageOf(b, "Large signature");
    await sigBlock(b, page, 0, SIG("Isabella Montoya", "Zapfino", INK.navy, 12, 900, 300), "left", "Signature:", { width: 300, cond: "large>8%height", top: 500 });
    cases.push(await finish(b, "s-large", "sig-large"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "X line");
    page.drawText("X", { x: 56, y: H - 600, size: 14, font: b.bold });
    hline(page, 70, 360, 600);
    await img(b, page, SIG("Yuki Tanaka", "Brush Script MT", INK.black, 3).data, "png", { x: 90, y: 560, width: 150, height: 47 });
    exp(b, "signature", 0, { x: 90, y: 560, width: 150, height: 47 }, "firma", "x-line-no-word");
    cases.push(await finish(b, "s-x-line", "sig-nolabel"));
  }
  // firma en tabla (celda)
  {
    const b = await newB();
    const page = pageOf(b, "Signature in a table cell", 6);
    for (const y of [300, 360, 460]) page.drawLine({ start: { x: 56, y: H - y }, end: { x: 556, y: H - y }, thickness: 1 });
    for (const x of [56, 306, 556]) page.drawLine({ start: { x, y: H - 300 }, end: { x, y: H - 460 }, thickness: 1 });
    lab(b, page, "Client signature", 64, 310); lab(b, page, "Date", 314, 310);
    const box = { x: 90, y: 340 + 4, width: 150, height: 47 };
    await img(b, page, SIG("Peter Hall", "Snell Roundhand", INK.blue, 8).data, "png", box);
    exp(b, "signature", 0, box, "firma", "table-cell+label");
    cases.push(await finish(b, "s-table-cell", "sig-label"));
  }
  // firma + nombre impreso debajo
  {
    const b = await newB();
    const page = pageOf(b, "Signature with typed name below");
    const box = await sigBlock(b, page, 0, SIG("Nora Haddad", "Bradley Hand", INK.navy, 21), "below-line", "Signature");
    lab(b, page, "Nora Haddad, CEO", 56, box.y + box.height + 26);
    cases.push(await finish(b, "s-typed-name-below", "sig-label"));
  }
  // rotaciones, cropbox
  for (const rot of [90, 180, 270]) {
    // pagina con /Rotate: el contenido esta dibujado girado para que se VEA derecho (lo habitual en escaneos y horizontales)
    const b = await newB();
    const page = b.doc.addPage([W, H]);
    page.setRotation(degrees(rot));
    const VW = rot === 180 ? W : H, VH = rot === 180 ? H : W; // tamano visible
    const toContent = (vx: number, vy: number): [number, number] => (rot === 90 ? [vy, vx] : rot === 270 ? [W - vy, H - vx] : [W - vx, vy]);
    const txt = (t: string, vx: number, vy: number, size: number, font: PDFFont): void => { const [x, y] = toContent(vx, vy + size * 0.85); page.drawText(t, { x, y, size, font, rotate: degrees(rot === 90 ? 90 : rot === 270 ? 270 : 180) }); };
    txt("Landscape agreement /Rotate " + rot, 50, 40, 15, b.bold);
    for (let i = 0; i < 12; i += 1) txt(BODY[i % BODY.length], 50, 70 + i * 17, 9.5, b.font);
    txt("Signature:", 50, 380, 10, b.font);
    const sw = 170, sh = 53, vx0 = 130, vy0 = 365;
    const [cx, cy] = (() => {
      if (rot === 90) return [vy0 + sh, vx0];
      if (rot === 270) return [W - vy0 - sh, H - vx0];
      return [W - vx0, vy0 + sh];
    })();
    const im = await b.doc.embedPng(SIG("Ana Torres", "Zapfino", INK.blue, 31 + rot).data);
    page.drawImage(im, { x: cx, y: cy, width: sw, height: sh, rotate: degrees(rot === 90 ? 90 : rot === 270 ? 270 : 180) });
    b.expected.push({ cls: "signature", page: 0, rect: { x: vx0 / VW, y: vy0 / VH, width: sw / VW, height: sh / VH }, tag: "firma", cond: `rotate${rot}-upright` });
    cases.push(await finish(b, `s-rotate-${rot}`, "sig-rotate"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "CropBox smaller than MediaBox");
    page.setCropBox(36, 120, 540, 600);
    const box = await sigBlock(b, page, 0, SIG("Hans Muller", "Savoye LET", INK.black, 55), "left", "Unterschrift / Signature:", { cond: "cropbox", top: 400, width: 140 });
    // expected rect is relative to CropBox (visible page): x from 36, y from top (792-720=72)
    b.expected[b.expected.length - 1].rect = { x: (box.x - 36) / 540, y: (box.y - 72) / 600, width: box.width / 540, height: box.height / 600 };
    cases.push(await finish(b, "s-cropbox", "sig-rotate", { note: "expected rect normalised to CropBox" }));
  }
  // dos firmantes con signPdfMulti (propias)
  {
    const { signPdfMulti } = await import("@/lib/pdf/sign");
    const b = await newB();
    for (let p = 0; p < 4; p += 1) {
      const page = pageOf(b, `Policy page ${p + 1}`);
      lab(b, page, "Initials:", 480, 748, 9);
      lab(b, page, "Initials:", 380, 748, 9);
    }
    const p4 = b.doc.getPage(3);
    hline(p4, 56, 280, 500); lab(b, p4, "Signature of the Insured", 56, 506);
    hline(p4, 330, 556, 500); lab(b, p4, "Signature of the Co-Insured", 330, 506);
    const original = await b.doc.save({ useObjectStreams: false });
    const sigA = pngOf(scriptSig("Ines Duarte", "Snell Roundhand", 480, 150, INK.navy, { seed: 71 }));
    const sigB = pngOf(scriptSig("Tomas Duarte", "Zapfino", 480, 150, INK.black, { seed: 72 }));
    const iniA = pngOf(initialsRaster("ID", "Bradley Hand", 200, 130, INK.navy));
    const iniB = pngOf(initialsRaster("TD", "Noteworthy", 200, 130, INK.black));
    const sigBoxA = { x: 60, y: 450, width: 170, height: 53 };
    const sigBoxB = { x: 335, y: 450, width: 170, height: 53 };
    const iniBoxA = { x: 520, y: 722, width: 40, height: 26 };
    const iniBoxB = { x: 420, y: 722, width: 40, height: 26 };
    const places: Array<{ kind: "image"; png: Uint8Array; pageIndex: number; rect: NormRect }> = [
      { kind: "image", png: sigA, pageIndex: 3, rect: norm(sigBoxA) }, { kind: "image", png: sigB, pageIndex: 3, rect: norm(sigBoxB) },
      ...[0, 1, 2, 3].flatMap((p) => [
        { kind: "image" as const, png: iniA, pageIndex: p, rect: norm(iniBoxA) },
        { kind: "image" as const, png: iniB, pageIndex: p, rect: norm(iniBoxB) },
      ]),
    ];
    const blob = await signPdfMulti(new File([original as unknown as BlobPart], "p.pdf", { type: "application/pdf" }), { placements: places });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const exps: Exp[] = [
      { cls: "signature", page: 3, rect: norm(sigBoxA), tag: "firma A", cond: "signPdfMulti" },
      { cls: "signature", page: 3, rect: norm(sigBoxB), tag: "firma B", cond: "signPdfMulti" },
      { cls: "initials", page: 0, rect: norm(iniBoxA), pages: [0, 1, 2, 3], tag: "iniciales A", cond: "signPdfMulti-footer" },
      { cls: "initials", page: 0, rect: norm(iniBoxB), pages: [0, 1, 2, 3], tag: "iniciales B", cond: "signPdfMulti-footer" },
    ];
    cases.push({ name: "s-optimus-4pages-2signers-mine", group: "sig-optimus", bytes, expected: exps, decoys: 0 });
  }

  /* ---------- iniciales ---------- */
  for (const [i, [family, letters, color, label]] of ([
    ["Bradley Hand", "AB", INK.blue, "Initials:"], ["Noteworthy", "MR", INK.black, "Rubrica:"], ["Zapfino", "JS", INK.navy, "Initial here"],
    ["Snell Roundhand", "LG", INK.purple, "Iniciales"], ["Brush Script MT", "DK", INK.blue, "Initials"],
  ] as Array<[string, string, string, string]>).entries()) {
    for (const mode of ["png-label", "jpg-label", "png-nolabel"]) {
      const b = await newB();
      const pagesN = 3;
      const raster = initialsRaster(letters, family, 200, 130, color);
      const data = mode.startsWith("jpg") ? jpgOf(photoize(raster, { bg: [250, 250, 248], noise: 6, seed: 5 + i }), 80) : pngOf(raster);
      for (let p = 0; p < pagesN; p += 1) {
        const page = pageOf(b, `Page ${p + 1}`);
        if (mode.endsWith("-label")) lab(b, page, label, 430, 750, 8);
        const box = { x: 485, y: 728, width: 44, height: 28 };
        await img(b, page, data, mode.startsWith("jpg") ? "jpg" : "png", box);
      }
      exp(b, "initials", 0, { x: 485, y: 728, width: 44, height: 28 }, `iniciales ${letters}`, mode, [0, 1, 2]);
      cases.push(await finish(b, `i-${i}-${mode}`, mode.endsWith("nolabel") ? "ini-nolabel" : "ini-label"));
    }
  }
  // iniciales + firma en la misma pagina, iniciales al margen de pagina unica
  {
    const b = await newB();
    const page = pageOf(b, "Single page initials");
    lab(b, page, "Initials:", 56, 300, 9);
    const box = { x: 110, y: 290, width: 38, height: 25 };
    await img(b, page, pngOf(initialsRaster("PQ", "Noteworthy", 200, 130, INK.blue)), "png", box);
    exp(b, "initials", 0, box, "iniciales una pagina", "single-page+label");
    cases.push(await finish(b, "i-single-page", "ini-label"));
  }

  /* ---------- logos ---------- */
  {
    const b = await newB();
    const logo = pngOf(logoWide(520, 130, "Northwind", "#0f766e"));
    for (let p = 0; p < 4; p += 1) { const page = pageOf(b, `Report page ${p + 1}`, 14, 120); await img(b, page, logo, "png", { x: 56, y: 28, width: 130, height: 32.5 }); }
    exp(b, "logo", 0, { x: 56, y: 28, width: 130, height: 32.5 }, "logo cabecera", "header-x4", [0, 1, 2, 3]);
    cases.push(await finish(b, "l-header-4", "logo"));
  }
  {
    const b = await newB();
    const logo = pngOf(logoSquare(200, "#7c3aed"));
    for (let p = 0; p < 5; p += 1) { const page = pageOf(b, `Doc ${p + 1}`); await img(b, page, logo, "png", { x: 520, y: 742, width: 36, height: 36 }); }
    exp(b, "logo", 0, { x: 520, y: 742, width: 36, height: 36 }, "logo pie", "footer-x5", [0, 1, 2, 3, 4]);
    cases.push(await finish(b, "l-footer-5", "logo"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Letterhead only first page", 12, 130);
    await img(b, page, pngOf(logoWide(600, 160, "Contoso Ltd", "#1d4ed8")), "png", { x: 56, y: 36, width: 160, height: 42.7 });
    exp(b, "logo", 0, { x: 56, y: 36, width: 160, height: 42.7 }, "logo p1", "first-page-only");
    pageOf(b, "Second page");
    cases.push(await finish(b, "l-first-page", "logo"));
  }
  {
    const b = await newB();
    const a = pngOf(logoWide(420, 110, "Alpha", "#b45309"));
    const c = pngOf(logoSquare(160, "#047857"));
    for (let p = 0; p < 3; p += 1) {
      const page = pageOf(b, `Two logos ${p + 1}`, 14, 120);
      await img(b, page, a, "png", { x: 56, y: 24, width: 110, height: 28.8 });
      await img(b, page, c, "png", { x: 500, y: 20, width: 40, height: 40 });
    }
    exp(b, "logo", 0, { x: 56, y: 24, width: 110, height: 28.8 }, "logo izq", "two-logos", [0, 1, 2]);
    exp(b, "logo", 0, { x: 500, y: 20, width: 40, height: 40 }, "logo der", "two-logos", [0, 1, 2]);
    cases.push(await finish(b, "l-two-logos", "logo"));
  }
  {
    // logo JPEG con fondo blanco repetido arriba
    const b = await newB();
    const { c } = { c: photoize(logoWide(420, 110, "Delta", "#be123c"), { bg: [255, 255, 255], noise: 3, seed: 8 }) };
    const data = jpgOf(c, 85);
    for (let p = 0; p < 3; p += 1) { const page = pageOf(b, `P${p}`, 14, 120); await img(b, page, data, "jpg", { x: 56, y: 24, width: 110, height: 28.8 }); }
    exp(b, "logo", 0, { x: 56, y: 24, width: 110, height: 28.8 }, "logo jpg", "jpg-header", [0, 1, 2]);
    cases.push(await finish(b, "l-header-jpg", "logo"));
  }

  /* ---------- sellos (imagen) ---------- */
  {
    const b = await newB();
    const page = pageOf(b, "Round seal");
    const box = { x: 380, y: 560, width: 100, height: 100 };
    await img(b, page, pngOf(sealRound(400, "#c0392b", "PAID")), "png", box);
    exp(b, "stamp", 0, box, "sello redondo rojo", "round-red");
    cases.push(await finish(b, "st-round-red", "stamp"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Rect stamp");
    const box = { x: 300, y: 540, width: 160, height: 56 };
    await img(b, page, pngOf(stampRect(480, 168, "#1d4ed8", "APPROVED")), "png", box);
    exp(b, "stamp", 0, box, "sello rect azul", "rect-blue");
    cases.push(await finish(b, "st-rect-blue", "stamp"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Seal beside Signature label");
    lab(b, page, "Signature:", 56, 560); hline(page, 56, 300, 580);
    const box = { x: 320, y: 535, width: 90, height: 90 };
    await img(b, page, pngOf(sealRound(360, "#1d4ed8", "SEAL")), "png", box);
    exp(b, "stamp", 0, box, "sello junto a Signature", "stamp-near-label");
    cases.push(await finish(b, "st-near-label", "stamp"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Stamp annotation");
    const ap = formXObject(b.doc, [0, 0, 120, 40], "1 0 0 RG 3 w 4 4 112 32 re S", {});
    addAnnot(b.doc, page, { Type: "Annot", Subtype: "Stamp", Rect: [300, 300, 420, 340], Name: "Approved", F: 4, AP: { N: ap } });
    exp(b, "stamp", 0, { x: 300, y: H - 340, width: 120, height: 40 }, "Stamp annot", "annot");
    cases.push(await finish(b, "st-annot", "stamp"));
  }

  /* ---------- marcas de agua ---------- */
  {
    const b = await newB();
    for (let p = 0; p < 5; p += 1) {
      const page = pageOf(b, `Confidential page ${p + 1}`);
      page.drawText("CONFIDENTIAL", { x: 110, y: 250, size: 90, font: b.bold, color: rgb(0.6, 0.6, 0.6), opacity: 0.15, rotate: degrees(45) });
    }
    exp(b, "watermark", 0, null, "CONFIDENTIAL", "text-diag-all");
    cases.push(await finish(b, "w-text-diagonal", "watermark"));
  }
  {
    const b = await newB();
    for (let p = 0; p < 6; p += 1) {
      const page = pageOf(b, `Borrador ${p + 1}`);
      page.drawText("BORRADOR", { x: 60, y: 380, size: 120, font: b.bold, color: rgb(0.8, 0.1, 0.1), opacity: 0.12 });
    }
    exp(b, "watermark", 0, null, "BORRADOR", "text-horizontal-all");
    cases.push(await finish(b, "w-text-horizontal", "watermark"));
  }
  {
    const b = await newB();
    const wm = await b.doc.embedPng(pngOf(wmImage(900, 600)));
    for (let p = 0; p < 4; p += 1) {
      const page = pageOf(b, `Image WM ${p + 1}`);
      page.drawImage(wm, { x: 106, y: 250, width: 400, height: 266.7, opacity: 0.1 });
    }
    exp(b, "watermark", 0, { x: 106, y: H - 250 - 266.7, width: 400, height: 266.7 }, "imagen translucida", "image-wm-all");
    cases.push(await finish(b, "w-image", "watermark"));
  }
  {
    // marca de agua solo en 1 de 6 paginas: NO debe ser marca de agua (no repetida)
    const b = await newB();
    for (let p = 0; p < 6; p += 1) {
      const page = pageOf(b, `Page ${p + 1}`);
      if (p === 2) page.drawText("DRAFT", { x: 120, y: 300, size: 110, font: b.bold, color: rgb(0.5, 0.5, 0.5), opacity: 0.15, rotate: degrees(40) });
    }
    b.decoys = 1;
    cases.push(await finish(b, "w-decoy-1of6", "watermark-decoy"));
  }
  {
    const b = await newB();
    for (let p = 0; p < 3; p += 1) {
      const page = pageOf(b, `Hostile watermark ${p + 1}`);
      page.drawText("<img src=x onerror=alert(1)>", { x: 40, y: 300, size: 38, font: b.font, color: rgb(0.5, 0.5, 0.5), opacity: 0.15, rotate: degrees(20) });
    }
    exp(b, "watermark", 0, null, "xss text", "text-xss");
    cases.push(await finish(b, "w-xss-text", "watermark"));
  }

  /* ---------- anotaciones ---------- */
  {
    const b = await newB();
    const page = pageOf(b, "Ink annotation with AP");
    const ap = formXObject(b.doc, [0, 0, 180, 60], "0 0 0.6 RG 2 w 5 10 m 40 55 60 5 90 40 c 120 70 140 0 175 35 c S", {});
    addAnnot(b.doc, page, { Type: "Annot", Subtype: "Ink", Rect: [100, 300, 280, 360], InkList: [Array.from({ length: 70 }, (_, i) => [105 + i * 2.4, 335 + 28 * Math.sin(i / 4) * Math.cos(i / 9)]).flat()], C: [0, 0, 0.6], BS: { W: 2 }, F: 4, AP: { N: ap } });
    exp(b, "signature", 0, { x: 100, y: H - 360, width: 180, height: 60 }, "ink annot (firma a mano)", "ink-ap");
    cases.push(await finish(b, "a-ink-ap", "annot", { note: "kind may be 'drawing' by design" }));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Ink annotation without AP");
    addAnnot(b.doc, page, { Type: "Annot", Subtype: "Ink", Rect: [100, 300, 280, 360], InkList: [Array.from({ length: 70 }, (_, i) => [105 + i * 2.4, 335 + 28 * Math.sin(i / 4) * Math.cos(i / 9)]).flat()], C: [0, 0.4, 0], BS: { W: 2.5 }, F: 4 });
    exp(b, "signature", 0, { x: 100, y: H - 360, width: 180, height: 60 }, "ink annot sin AP", "ink-noap");
    cases.push(await finish(b, "a-ink-noap", "annot", { note: "kind may be 'drawing' by design" }));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Sig widget with AP");
    const ap = formXObject(b.doc, [0, 0, 200, 60], "0.05 0.1 0.5 RG 1.8 w 8 20 m 40 55 70 -5 100 35 c 130 60 150 5 190 30 c S", {});
    const fld = { Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature1"), Rect: [320, 300, 520, 360], F: 4, AP: { N: ap }, V: undefined };
    delete (fld as Record<string, unknown>).V;
    addAnnot(b.doc, page, fld);
    exp(b, "signature", 0, { x: 320, y: H - 360, width: 200, height: 60 }, "campo /Sig con apariencia", "sig-widget");
    cases.push(await finish(b, "a-sig-widget", "annot"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Empty Sig widget (decoy)");
    addAnnot(b.doc, page, { Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature1"), Rect: [320, 300, 520, 360], F: 4 });
    b.decoys = 1;
    cases.push(await finish(b, "a-sig-widget-empty", "annot-decoy"));
  }

  /* ---------- vectoriales ---------- */
  for (let i = 0; i < 3; i += 1) {
    const b = await newB();
    const page = pageOf(b, "Vector signature with label");
    lab(b, page, i === 1 ? "Firma:" : "Signature:", 56, 560); hline(page, 56, 360, 612);
    svgSig(page, 130 + i * 10, 575, 180, 38, 300 + i);
    exp(b, "signature", 0, { x: 130 + i * 10, y: 575, width: 180, height: 38 }, "firma vectorial", `vector-label${i}`);
    cases.push(await finish(b, `v-sig-label-${i}`, "vector"));
  }
  for (let i = 0; i < 2; i += 1) {
    const b = await newB();
    const page = pageOf(b, "Vector scribble without label (decoy)");
    svgSig(page, 130, 575, 180, 38, 400 + i);
    b.decoys = 1;
    cases.push(await finish(b, `v-decoy-scribble-${i}`, "vector-decoy"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Vector charts (decoys)");
    // grafico de linea con 40 puntos
    let d = "M 0 20";
    const r = rand(9);
    for (let i = 1; i <= 40; i += 1) d += ` L ${i * 6} ${20 + (r() - 0.5) * 40}`;
    page.drawSvgPath(d, { x: 100, y: H - 500, borderColor: rgb(0.1, 0.2, 0.6), borderWidth: 1.2 });
    // sinusoide suave (ornamento)
    let s = "M 0 0";
    for (let i = 1; i <= 30; i += 1) s += ` C ${i * 8 - 4} ${i % 2 ? 12 : -12}, ${i * 8 - 2} ${i % 2 ? 12 : -12}, ${i * 8} 0`;
    page.drawSvgPath(s, { x: 100, y: H - 560, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    lab(b, page, "Signature:", 56, 600);
    b.decoys = 2;
    cases.push(await finish(b, "v-decoy-charts-with-label-elsewhere", "vector-decoy"));
  }

  /* ---------- senuelos ---------- */
  const decoy = async (name: string, build: (b: B, page: PDFPage) => Promise<number>): Promise<void> => {
    const b = await newB();
    const page = pageOf(b, name);
    b.decoys = await build(b, page);
    cases.push(await finish(b, name, "decoy"));
  };
  await decoy("d-table-grid-near-label", async (b, page) => { lab(b, page, "Signature:", 56, 400); await img(b, page, pngOf(gridTable(500, 180)), "png", { x: 150, y: 380, width: 250, height: 90 }); return 1; });
  await decoy("d-bar-chart-near-label", async (b, page) => { lab(b, page, "Firma:", 56, 400); await img(b, page, pngOf(barChart(520, 200, 3)), "png", { x: 150, y: 380, width: 260, height: 100 }); return 1; });
  await decoy("d-line-chart", async (b, page) => { await img(b, page, pngOf(lineChart(520, 160, 4)), "png", { x: 150, y: 420, width: 260, height: 80 }); return 1; });
  await decoy("d-qr", async (b, page) => { lab(b, page, "Signature", 56, 560); await img(b, page, pngOf(qrCode(25, 8, 5)), "png", { x: 150, y: 520, width: 100, height: 100 }); return 1; });
  await decoy("d-barcode", async (b, page) => { lab(b, page, "Initials:", 56, 600); await img(b, page, pngOf(barcode(420, 130, 6)), "png", { x: 150, y: 590, width: 150, height: 46 }); return 1; });
  await decoy("d-photo-near-label", async (b, page) => { lab(b, page, "Signature:", 56, 560); await img(b, page, jpgOf(photoRaster(400, 130, 7), 80), "jpg", { x: 150, y: 540, width: 170, height: 55 }); return 1; });
  await decoy("d-empty-signature-line", async (b, page) => { lab(b, page, "Signature:", 56, 560); hline(page, 130, 360, 580); lab(b, page, "Initials:", 400, 560); hline(page, 450, 520, 580); return 2; });
  await decoy("d-check-icon-near-label", async (b, page) => { lab(b, page, "Signature:", 56, 560); await img(b, page, pngOf(checkIcon(120)), "png", { x: 150, y: 545, width: 40, height: 40 }); return 1; });
  await decoy("d-arrow-sign-here", async (b, page) => { lab(b, page, "Sign here", 56, 560); await img(b, page, pngOf(arrowIcon(200, 70)), "png", { x: 130, y: 545, width: 80, height: 28 }); return 1; });
  await decoy("d-wide-banner", async (b, page) => { lab(b, page, "Signature", 56, 560); await img(b, page, pngOf(banner(800, 120)), "png", { x: 150, y: 540, width: 300, height: 45 }); return 1; });
  await decoy("d-pie-near-initials", async (b, page) => { lab(b, page, "Initials:", 56, 560); await img(b, page, pngOf(pieChart(180)), "png", { x: 110, y: 540, width: 50, height: 50 }); return 1; });
  await decoy("d-shaded-box-near-label", async (b, page) => { lab(b, page, "Signature:", 56, 560); await img(b, page, pngOf(shadedBox(500, 150)), "png", { x: 130, y: 530, width: 250, height: 75 }); return 1; });
  await decoy("d-text-scan-near-label", async (b, page) => { lab(b, page, "Signature", 56, 560); await img(b, page, pngOf(textScan(400, 100, 8)), "png", { x: 130, y: 540, width: 200, height: 50 }); return 1; });
  await decoy("d-logo-near-signature-label", async (b, page) => { lab(b, page, "Signature:", 56, 560); await img(b, page, pngOf(logoWide(520, 130, "Fabrikam", "#0e7490")), "png", { x: 130, y: 545, width: 160, height: 40 }); return 1; });
  await decoy("d-checkbox-icons-near-initials", async (b, page) => { lab(b, page, "Initials:", 56, 560); for (let i = 0; i < 5; i += 1) await img(b, page, pngOf(checkIcon(64)), "png", { x: 110 + i * 24, y: 548, width: 20, height: 20 }); return 5; });
  await decoy("d-gray-photo-jpg-no-label", async (b, page) => { await img(b, page, jpgOf(photoRaster(500, 160, 11), 80), "jpg", { x: 300, y: 560, width: 200, height: 64 }); return 1; });
  // senuelos extra (transparentes y adornos)
  await decoy("d-qr-transparent-near-label", async (b, page) => {
    const q = qrCode(25, 8, 15); const { c, g } = cv(q.width, q.height); g.drawImage(q, 0, 0);
    const im = g.getImageData(0, 0, c.width, c.height); for (let i = 0; i < im.data.length; i += 4) { if (im.data[i] > 200) im.data[i + 3] = 0; } g.putImageData(im, 0, 0);
    lab(b, page, "Signature", 56, 560); await img(b, page, pngOf(c), "png", { x: 150, y: 520, width: 90, height: 90 }); return 1; });
  await decoy("d-barcode-transparent-near-initials", async (b, page) => {
    const q = barcode(420, 120, 16); const { c, g } = cv(q.width, q.height); g.drawImage(q, 0, 0);
    const im = g.getImageData(0, 0, c.width, c.height); for (let i = 0; i < im.data.length; i += 4) { if (im.data[i] > 200) im.data[i + 3] = 0; } g.putImageData(im, 0, 0);
    lab(b, page, "Initials:", 56, 580); await img(b, page, pngOf(c), "png", { x: 110, y: 570, width: 100, height: 28 }); return 1; });
  await decoy("d-swash-ornament-no-label", async (b, page) => {
    const { c, g } = cv(600, 80); g.strokeStyle = "#222"; g.lineWidth = 3; g.beginPath(); g.moveTo(10, 40); g.bezierCurveTo(120, 5, 200, 75, 300, 40); g.bezierCurveTo(400, 5, 480, 75, 590, 40); g.stroke();
    g.beginPath(); g.arc(300, 40, 6, 0, 7); g.fill(); await img(b, page, pngOf(c), "png", { x: 150, y: 440, width: 300, height: 40 }); return 1; });
  await decoy("d-swash-ornament-near-label", async (b, page) => {
    const { c, g } = cv(600, 80); g.strokeStyle = "#222"; g.lineWidth = 3; g.beginPath(); g.moveTo(10, 40); g.bezierCurveTo(120, 5, 200, 75, 300, 40); g.bezierCurveTo(400, 5, 480, 75, 590, 40); g.stroke();
    lab(b, page, "Signature:", 56, 560); await img(b, page, pngOf(c), "png", { x: 130, y: 540, width: 200, height: 27 }); return 1; });
  await decoy("d-pen-icon-sign-here", async (b, page) => {
    const { c, g } = cv(160, 160); g.fillStyle = "#1d4ed8"; g.save(); g.translate(80, 80); g.rotate(-0.8); g.fillRect(-14, -70, 28, 110); g.beginPath(); g.moveTo(-14, 40); g.lineTo(14, 40); g.lineTo(0, 70); g.fill(); g.restore();
    lab(b, page, "Sign here", 56, 560); await img(b, page, pngOf(c), "png", { x: 130, y: 540, width: 45, height: 45 }); return 1; });
  await decoy("d-script-wordmark-header-x3", async (b, page) => {
    // logo manuscrito repetido en cabecera de 3 paginas (se anade aqui a la pagina 1; las 2 restantes aparte)
    const wm = pngOf(scriptSig("Bella Casa", "Snell Roundhand", 520, 120, "#7a1f3d", { seed: 3, flourish: true }));
    await img(b, page, wm, "png", { x: 56, y: 24, width: 140, height: 32 });
    for (let p = 0; p < 2; p += 1) { const pg = pageOf(b, `Extra ${p}`, 14, 120); await img(b, pg, wm, "png", { x: 56, y: 24, width: 140, height: 32 }); }
    return 1; });
  await decoy("d-gray-xbox-placeholder", async (b, page) => {
    const { c, g } = cv(500, 130); g.fillStyle = "#f3f4f6"; g.fillRect(0, 0, 500, 130); g.strokeStyle = "#6b7280"; g.lineWidth = 3; g.strokeRect(2, 2, 496, 126); g.font = "bold 70px sans-serif"; g.fillStyle = "#6b7280"; g.fillText("X", 20, 90);
    lab(b, page, "Signature", 56, 560); await img(b, page, pngOf(c), "png", { x: 130, y: 540, width: 200, height: 52 }); return 1; });
  // ambiguos, se informan aparte
  {
    const b = await newB();
    const page = pageOf(b, "Typed name image near label (ambiguous)");
    lab(b, page, "Signature:", 56, 560);
    await img(b, page, pngOf(typedName("Maria Lopez", 400, 100)), "png", { x: 130, y: 545, width: 160, height: 40 });
    b.decoys = 1;
    cases.push(await finish(b, "amb-typed-name-image", "ambiguous"));
  }
  {
    const b = await newB();
    const page = pageOf(b, "Doodle smiley near no label (ambiguous)");
    await img(b, page, pngOf(doodle(200, 120)), "png", { x: 330, y: 560, width: 100, height: 60 });
    b.decoys = 1;
    cases.push(await finish(b, "amb-doodle", "ambiguous"));
  }

  /* ---------- paginas escaneadas ---------- */
  {
    const b = await newB();
    const page = b.doc.addPage([W, H]);
    const sig = scriptSig("Elena Ruiz", "Bradley Hand", 440, 140, "#1a2a6c", { seed: 14 });
    const im = await b.doc.embedJpg(jpgOf(scanFullPage(sig, 2), 70));
    page.drawImage(im, { x: 0, y: 0, width: W, height: H });
    b.expected.push({ cls: "image", page: 0, tag: "pagina escaneada", cond: "scan" });
    cases.push(await finish(b, "sc-scanned-page", "scan", { note: "expect scannedPages=[0]" }));
  }

  /* ---------- robustez (generadas en otro archivo) ---------- */
  return cases;
}

