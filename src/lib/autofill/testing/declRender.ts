/**
 * BANCO DE «DECLARATION PAGES» (dibujo): convierte las operaciones de `declLayouts.ts` en
 *   (a) un PDF CON capa de texto (pdf-lib),
 *   (b) un PDF ESCANEADO (solo imagen: la pagina dibujada a ~200 dpi con un poco de ruido y giro de escaner, incrustada como JPEG),
 *   (c) una FOTO simulada (giro 2-8 grados, perspectiva suave, sombra, poca luz, ruido, desenfoque ligero y compresion JPEG),
 * con `@napi-rs/canvas` y las fuentes Liberation del repositorio (metricas de Helvetica/Times/Courier). Solo lo importan pruebas y el
 * script de medicion; nada de esto entra en la aplicacion. Todo en memoria o en una carpeta que elige quien llama.
 */

import path from "node:path";
import { GlobalFonts, createCanvas, type Canvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "@cantoo/pdf-lib";
import { composeScene } from "@/lib/scan/__fixtures__/scene";
import { makeRng } from "@/lib/scan/__fixtures__/rng";
import { PAGE_H, PAGE_W, type DOp, type DPage, type Fam } from "@/lib/autofill/testing/declLayouts";

const FONT_NAMES: Record<string, string> = {
  "sans:0": "DeclSans",
  "sans:1": "DeclSansBold",
  "serif:0": "DeclSerif",
  "serif:1": "DeclSerifBold",
  "mono:0": "DeclMono",
  "mono:1": "DeclMonoBold",
};
const FONT_FILES: Record<string, string> = {
  "sans:0": "LiberationSans-Regular.ttf",
  "sans:1": "LiberationSans-Bold.ttf",
  "serif:0": "LiberationSerif-Regular.ttf",
  "serif:1": "LiberationSerif-Bold.ttf",
  "mono:0": "LiberationMono-Regular.ttf",
  "mono:1": "LiberationMono-Bold.ttf",
};

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  for (const [key, file] of Object.entries(FONT_FILES)) GlobalFonts.registerFromPath(path.join(process.cwd(), "public", "fonts", file), FONT_NAMES[key]);
  fontsReady = true;
}

/* ------------------------------------------------------------------ *
 * (a) PDF con capa de texto
 * ------------------------------------------------------------------ */

export async function buildDeclPdf(pages: readonly DPage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const embedded: Record<string, PDFFont> = {
    "sans:0": await doc.embedFont(StandardFonts.Helvetica),
    "sans:1": await doc.embedFont(StandardFonts.HelveticaBold),
    "serif:0": await doc.embedFont(StandardFonts.TimesRoman),
    "serif:1": await doc.embedFont(StandardFonts.TimesRomanBold),
    "mono:0": await doc.embedFont(StandardFonts.Courier),
    "mono:1": await doc.embedFont(StandardFonts.CourierBold),
  };
  for (const ops of pages) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    for (const op of ops) {
      if (op.t === "text") {
        // WinAnsi: lo que la fuente estandar no tiene se sustituye (no hay caracteres fuera de WinAnsi en el banco).
        const gray = op.gray ?? 0;
        page.drawText(op.s, { x: op.x, y: PAGE_H - op.y, size: op.size, font: embedded[`${op.fam}:${op.bold ? 1 : 0}`], color: rgb(gray, gray, gray) });
      } else if (op.t === "rule") page.drawLine({ start: { x: op.x0, y: PAGE_H - op.y }, end: { x: op.x1, y: PAGE_H - op.y }, thickness: op.w ?? 0.7 });
      else if (op.t === "box") page.drawRectangle({ x: op.x, y: PAGE_H - op.y - op.h, width: op.w, height: op.h, borderWidth: 0.6 });
      else page.drawRectangle({ x: op.x, y: PAGE_H - op.y - op.h, width: op.w, height: op.h, color: rgb(op.gray, op.gray, op.gray) });
    }
  }
  return doc.save();
}

/* ------------------------------------------------------------------ *
 * Dibujo en lienzo
 * ------------------------------------------------------------------ */

/** Dibuja una pagina a `scale` pixeles por punto sobre fondo blanco. */
export function drawPage(ops: DPage, scale: number): Canvas {
  ensureFonts();
  const canvas = createCanvas(Math.round(PAGE_W * scale), Math.round(PAGE_H * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "alphabetic";
  for (const op of ops) drawOp(ctx as unknown as CanvasRenderingContext2D, op, scale);
  return canvas;
}

function drawOp(ctx: CanvasRenderingContext2D, op: DOp, s: number): void {
  if (op.t === "text") {
    const fam: Fam = op.fam;
    ctx.font = `${op.size * s}px ${FONT_NAMES[`${fam}:${op.bold ? 1 : 0}`]}`;
    const g = Math.round((op.gray ?? 0) * 255);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillText(op.s, op.x * s, op.y * s);
  } else if (op.t === "rule") {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = (op.w ?? 0.7) * s;
    ctx.beginPath();
    ctx.moveTo(op.x0 * s, op.y * s);
    ctx.lineTo(op.x1 * s, op.y * s);
    ctx.stroke();
  } else if (op.t === "box") {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 0.6 * s;
    ctx.strokeRect(op.x * s, op.y * s, op.w * s, op.h * s);
  } else {
    const g = Math.round(op.gray * 255);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(op.x * s, op.y * s, op.w * s, op.h * s);
  }
}

/* ------------------------------------------------------------------ *
 * (b) PDF escaneado
 * ------------------------------------------------------------------ */

export type ScanParams = { dpi: number; skewDeg: number; noise: number; jpegQuality: number };

export function scanParams(seed: number): ScanParams {
  const rng = makeRng(seed);
  return { dpi: rng.pick([150, 200, 200, 300]), skewDeg: rng.range(-0.8, 0.8), noise: rng.range(2, 6), jpegQuality: rng.pick([55, 70, 80]) };
}

/** Una pagina «escaneada»: gris, con un poco de giro, ruido y motas; devuelve el JPEG y su tamano en pixeles. */
export function scanPageJpeg(ops: DPage, params: ScanParams, seed: number): { jpeg: Uint8Array; width: number; height: number } {
  const scale = params.dpi / 72;
  const base = drawPage(ops, scale);
  const out = createCanvas(base.width, base.height);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#f4f4f2";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((params.skewDeg * Math.PI) / 180);
  ctx.drawImage(base, -base.width / 2, -base.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const rng = makeRng(seed);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = (data[i] + data[i + 1] + data[i + 2]) / 3 + rng.gauss() * params.noise;
    const v = Math.max(0, Math.min(255, gray));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  // Motas del cristal del escaner.
  for (let n = 0; n < 40; n += 1) {
    const cx = rng.int(0, out.width - 1);
    const cy = rng.int(0, out.height - 1);
    for (let k = 0; k < 6; k += 1) {
      const x = Math.min(out.width - 1, cx + rng.int(0, 2));
      const y = Math.min(out.height - 1, cy + rng.int(0, 2));
      const o = (y * out.width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 60;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { jpeg: new Uint8Array(out.toBuffer("image/jpeg", params.jpegQuality)), width: out.width, height: out.height };
}

export async function buildScanPdf(pages: readonly DPage[], seed: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const params = scanParams(seed);
  for (const [index, ops] of pages.entries()) {
    const { jpeg } = scanPageJpeg(ops, params, seed + index);
    const image = await doc.embedJpg(jpeg);
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawImage(image, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  }
  return doc.save();
}

/* ------------------------------------------------------------------ *
 * (c) Foto simulada
 * ------------------------------------------------------------------ */

export type PhotoParams = { angleDeg: number; keystone: number; shadow: number; light: number; noise: number; blur: number; quality: number; desk: "dark" | "wood" | "light" | "blue"; scale: number };

export function photoParams(seed: number): PhotoParams {
  const rng = makeRng(seed);
  return {
    angleDeg: (rng.chance(0.5) ? 1 : -1) * rng.range(2, 8),
    keystone: rng.range(-0.05, 0.05),
    shadow: rng.range(0.08, 0.4),
    light: rng.range(0.62, 1),
    noise: rng.range(2, 4.5),
    blur: rng.pick([0, 0, 1]),
    quality: rng.pick([60, 70, 80]),
    desk: rng.pick(["dark", "wood", "light", "blue"] as const),
    scale: rng.range(0.74, 0.86),
  };
}

/** Fotos DIFICILES: poca luz, desenfoque, ruido fuerte, inclinacion y perspectiva marcadas y JPEG muy comprimido (para probar el reintento del OCR). */
export function hardPhotoParams(seed: number): PhotoParams {
  const rng = makeRng(seed);
  return {
    angleDeg: (rng.chance(0.5) ? 1 : -1) * rng.range(5, 9),
    keystone: rng.range(-0.07, 0.07),
    shadow: rng.range(0.25, 0.45),
    light: rng.range(0.5, 0.65),
    noise: rng.range(4.5, 6.5),
    blur: 1,
    quality: rng.pick([40, 50]),
    desk: rng.pick(["dark", "wood", "light", "blue"] as const),
    scale: rng.range(0.7, 0.8),
  };
}

export const PHOTO_WIDTH = 2100;
export const PHOTO_HEIGHT = 2800;

/** Una foto del documento sobre un escritorio, ya comprimida como JPEG. */
export function photoJpeg(ops: DPage, params: PhotoParams, seed: number): { jpeg: Uint8Array; width: number; height: number } {
  const page = drawPage(ops, 2.9);
  const scene = composeScene(page, {
    seed,
    width: PHOTO_WIDTH,
    height: PHOTO_HEIGHT,
    desk: params.desk,
    scale: params.scale,
    angleDeg: params.angleDeg,
    keystone: params.keystone,
    shadow: params.shadow,
    noise: params.noise,
    blur: params.blur,
    light: params.light,
    glare: null,
  });
  const canvas = createCanvas(scene.image.width, scene.image.height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(scene.image.width, scene.image.height);
  image.data.set(scene.image.data);
  ctx.putImageData(image, 0, 0);
  return { jpeg: new Uint8Array(canvas.toBuffer("image/jpeg", params.quality)), width: canvas.width, height: canvas.height };
}
