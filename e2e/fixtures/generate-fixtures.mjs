// Genera los fixtures binarios de e2e/fixtures/*.pdf una sola vez.
// No se ejecuta en CI ni en cada test -- los PDFs resultantes SI se
// commitean (son pequenos y 100% sinteticos, sin contenido real de nadie).
// Re-ejecutar manualmente con: node e2e/fixtures/generate-fixtures.mjs
import { PDFDocument, StandardFonts, rgb, degrees } from "@cantoo/pdf-lib";
import { PNG } from "pngjs";
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
  const png = new PNG({ width, height });
  let state = seed;
  const rand = () => {
    // xorshift32, determinista: mismo fixture en cada regeneracion.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 256);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      png.data[idx] = rand();
      png.data[idx + 1] = rand();
      png.data[idx + 2] = rand();
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
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

await buildRedactFixture();
await buildCompressFixture();
await buildCompareFixtures();
await buildCoreFixture();
