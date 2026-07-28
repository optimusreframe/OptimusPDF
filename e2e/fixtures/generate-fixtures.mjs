// Genera los fixtures binarios de e2e/fixtures/*.pdf una sola vez.
// No se ejecuta en CI ni en cada test -- los PDFs resultantes SI se
// commitean (son pequenos y 100% sinteticos, sin contenido real de nadie).
// Re-ejecutar manualmente con: node e2e/fixtures/generate-fixtures.mjs
import { PDFDocument, StandardFonts, rgb, degrees } from "@cantoo/pdf-lib";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = (name) => join(here, name);

/* ------------------------------------------------------------------ *
 * redact-secret.pdf
 * Pagina 1: un texto secreto unico + un parche magenta solido en zonas
 * conocidas (esquina superior izquierda del renderizado). Pagina 2: un
 * marcador publico que debe seguir intacto (no se censura esa pagina).
 * ------------------------------------------------------------------ */
async function buildRedactFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

  const page1 = doc.addPage([400, 300]);
  // Texto secreto cerca del borde superior (y alto en espacio PDF = arriba
  // al renderizar). Ancho estimado ~150-190pt a 24pt Helvetica-Bold.
  page1.drawText("SECRET-7F3A9", { x: 40, y: 250, size: 24, font, color: rgb(0, 0, 0) });
  // Parche magenta solido, tambien en el area superior/izquierda.
  page1.drawRectangle({
    x: 40,
    y: 130,
    width: 120,
    height: 90,
    color: rgb(1, 0, 1),
  });
  page1.drawText("no redactar mas alla de esta zona ->", {
    x: 170,
    y: 20,
    size: 8,
    font: fontRegular,
    color: rgb(0.4, 0.4, 0.4),
  });

  const page2 = doc.addPage([400, 300]);
  page2.drawText("PUBLIC-MARKER-OK", {
    x: 40,
    y: 150,
    size: 20,
    font,
    color: rgb(0, 0, 0),
  });

  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync(out("redact-secret.pdf"), Buffer.from(bytes));
  console.log("redact-secret.pdf:", bytes.length, "bytes");
}

/* ------------------------------------------------------------------ *
 * compress-photo-heavy.pdf
 * 2 paginas, cada una con una imagen PNG de ruido pseudoaleatorio (alta
 * entropia, como una foto real) para que la recompresion JPEG a menor
 * calidad reduzca el tamano de forma medible y estable.
 * ------------------------------------------------------------------ */
function noisePng(width, height, seed) {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = seed;
  const rand = () => {
    // xorshift32, determinista: mismo fixture en cada regeneracion.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 256);
  };
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rand();
    data[i + 1] = rand();
    data[i + 2] = rand();
    data[i + 3] = 255;
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.toBuffer("image/png");
}

async function buildCompressFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < 2; i += 1) {
    const page = doc.addPage([400, 300]);
    const pngBytes = noisePng(360, 220, 0x1234 + i);
    const image = await doc.embedPng(pngBytes);
    page.drawImage(image, { x: 20, y: 60, width: 360, height: 220 });
    page.drawText(`Pagina ${i + 1} - imagen de prueba`, {
      x: 20,
      y: 20,
      size: 12,
      font,
    });
  }

  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync(out("compress-photo-heavy.pdf"), Buffer.from(bytes));
  console.log("compress-photo-heavy.pdf:", bytes.length, "bytes");
}

/* ------------------------------------------------------------------ *
 * compare-before.pdf / compare-after.pdf
 * ------------------------------------------------------------------ */
async function buildCompareFixtures() {
  const before = await PDFDocument.create();
  const fontB = await before.embedFont(StandardFonts.Helvetica);
  const p1b = before.addPage([400, 300]);
  p1b.drawText("Extracto de cuenta ficticio", { x: 40, y: 250, size: 16, font: fontB });
  p1b.drawText("saldo 100 EUR", { x: 40, y: 200, size: 14, font: fontB });
  const p2b = before.addPage([400, 300]);
  p2b.drawText("Segunda pagina sin cambios previstos", { x: 40, y: 200, size: 14, font: fontB });
  writeFileSync(out("compare-before.pdf"), Buffer.from(await before.save({ useObjectStreams: false })));

  const after = await PDFDocument.create();
  const fontA = await after.embedFont(StandardFonts.Helvetica);
  const p1a = after.addPage([400, 300]);
  p1a.drawText("Extracto de cuenta ficticio", { x: 40, y: 250, size: 16, font: fontA });
  p1a.drawText("saldo 250 EUR", { x: 40, y: 200, size: 14, font: fontA });
  const p2a = after.addPage([400, 300]);
  p2a.drawText("Segunda pagina sin cambios previstos", { x: 40, y: 200, size: 14, font: fontA });
  p2a.drawText("linea nueva agregada despues", { x: 40, y: 170, size: 14, font: fontA });
  writeFileSync(out("compare-after.pdf"), Buffer.from(await after.save({ useObjectStreams: false })));

  console.log("compare-before.pdf / compare-after.pdf listos");
}

/* ------------------------------------------------------------------ *
 * core-rotated-pages.pdf
 * 2 paginas: la primera normal, la segunda rotada 90 grados -- ejercita
 * el camino compartido de core.ts (openPdfDocument + renderPageToCanvas)
 * via /pdf-to-jpg, incluida la rotacion.
 * ------------------------------------------------------------------ */
async function buildCoreFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const page1 = doc.addPage([400, 300]);
  page1.drawText("Pagina normal", { x: 40, y: 250, size: 18, font });
  page1.drawRectangle({ x: 40, y: 40, width: 100, height: 60, color: rgb(0, 0.4, 0.8) });

  const page2 = doc.addPage([400, 300]);
  page2.drawText("Pagina rotada", { x: 40, y: 250, size: 18, font });
  page2.drawRectangle({ x: 40, y: 40, width: 100, height: 60, color: rgb(0.8, 0.2, 0) });
  page2.setRotation(degrees(90));

  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync(out("core-rotated-pages.pdf"), Buffer.from(bytes));
  console.log("core-rotated-pages.pdf:", bytes.length, "bytes");
}

/* ------------------------------------------------------------------ *
 * fake-camera.y4m
 * Video sintetico sin audio para `--use-file-for-fake-video-capture`
 * (camara falsa de Chromium): 4 cuadrantes de color solido y distinto,
 * reconocibles pixel a pixel en la pagina que produce scan-to-pdf, para
 * probar captura + orientacion real sin hardware ni ffmpeg. El contenido
 * es identico en todos los frames -- no hay movimiento que provoque
 * flakiness segun el instante exacto de la captura, y Chromium repite el
 * archivo en bucle si la prueba tarda mas que su duracion.
 * ------------------------------------------------------------------ */
const CAMERA_WIDTH = 320;
const CAMERA_HEIGHT = 240;
const CAMERA_FPS = 10;
const CAMERA_FRAMES = 10; // 1 segundo; de sobra si Chromium hace loop.

// Colores muy separados entre si en los 3 canales: incluso con la deriva
// de color de YUV420 (submuestreo de croma) + la recompresion JPEG que
// aplica captureFrame(), siguen siendo inconfundibles entre si.
const QUADRANT_COLORS = {
  topLeft: [230, 25, 25], // rojo
  topRight: [25, 200, 60], // verde
  bottomLeft: [30, 90, 230], // azul
  bottomRight: [235, 210, 20], // amarillo
};

function clamp8(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * YCbCr de rango completo (0-255), formulas JPEG/JFIF. "C420jpeg" en la
 * cabecera Y4M describe el sub-muestreo y la ubicacion de las muestras de
 * croma (4:2:0), no el rango de valores -- Chromium puede interpretar el
 * I420 con la conversion BT.601 de rango limitado habitual en video. La
 * tolerancia de color del spec (< 40 por canal) absorbe esa diferencia sin
 * confundir un cuadrante con otro.
 */
function rgbToYuvFullRange(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const u = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
  const v = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  return [clamp8(y), clamp8(u), clamp8(v)];
}

function buildFakeCameraFrameRgba() {
  const canvas = createCanvas(CAMERA_WIDTH, CAMERA_HEIGHT);
  const ctx = canvas.getContext("2d");
  const halfW = CAMERA_WIDTH / 2;
  const halfH = CAMERA_HEIGHT / 2;
  const paint = (x, y, w, h, [r, g, b]) => {
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(x, y, w, h);
  };
  paint(0, 0, halfW, halfH, QUADRANT_COLORS.topLeft);
  paint(halfW, 0, halfW, halfH, QUADRANT_COLORS.topRight);
  paint(0, halfH, halfW, halfH, QUADRANT_COLORS.bottomLeft);
  paint(halfW, halfH, halfW, halfH, QUADRANT_COLORS.bottomRight);
  return ctx.getImageData(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT).data;
}

/** Empaqueta un fotograma RGBA como planos Y/U/V 4:2:0 planos (I420). */
function rgbaToYuv420Planes(rgba, width, height) {
  const yPlane = Buffer.alloc(width * height);
  const cWidth = width / 2;
  const cHeight = height / 2;
  const uPlane = Buffer.alloc(cWidth * cHeight);
  const vPlane = Buffer.alloc(cWidth * cHeight);

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const idx = (py * width + px) * 4;
      const [y] = rgbToYuvFullRange(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
      yPlane[py * width + px] = y;
    }
  }

  // El contenido es plano solido dentro de cada cuadrante: tomar el pixel
  // superior-izquierdo de cada bloque 2x2 basta, no hace falta promediar.
  for (let cy = 0; cy < cHeight; cy += 1) {
    for (let cx = 0; cx < cWidth; cx += 1) {
      const idx = (cy * 2 * width + cx * 2) * 4;
      const [, u, v] = rgbToYuvFullRange(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
      uPlane[cy * cWidth + cx] = u;
      vPlane[cy * cWidth + cx] = v;
    }
  }

  return Buffer.concat([yPlane, uPlane, vPlane]);
}

function buildFakeCameraY4m() {
  const rgba = buildFakeCameraFrameRgba();
  const framePlanes = rgbaToYuv420Planes(rgba, CAMERA_WIDTH, CAMERA_HEIGHT);

  const header = Buffer.from(
    `YUV4MPEG2 W${CAMERA_WIDTH} H${CAMERA_HEIGHT} F${CAMERA_FPS}:1 Ip A1:1 C420jpeg\n`,
    "ascii",
  );
  const frameHeader = Buffer.from("FRAME\n", "ascii");

  const chunks = [header];
  for (let i = 0; i < CAMERA_FRAMES; i += 1) {
    chunks.push(frameHeader, framePlanes);
  }

  const bytes = Buffer.concat(chunks);
  writeFileSync(out("fake-camera.y4m"), bytes);
  console.log("fake-camera.y4m:", bytes.length, "bytes");
}

await buildRedactFixture();
await buildCompressFixture();
await buildCompareFixtures();
await buildCoreFixture();
buildFakeCameraY4m();
