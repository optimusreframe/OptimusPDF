import { expect, test } from "@playwright/test";
import path from "node:path";
import { statSync } from "node:fs";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { downloadBytes } from "../helpers/downloads";
import {
  getPageCount,
  getPageOperatorCounts,
  getPageSize,
  getPageText,
} from "../helpers/pdf-inspection";
import { makeImage } from "../helpers/test-files";

const FIXTURE = path.join(__dirname, "..", "fixtures", "compress-photo-heavy.pdf");
// Leido en vivo, no una constante copiada a mano: si el fixture se
// regenera con e2e/fixtures/generate-fixtures.mjs y cambia de tamano, la
// prueba sigue siendo correcta sin tocar nada aqui.
const ORIGINAL_SIZE_BYTES = statSync(FIXTURE).size;

const FLATTEN_LABEL = /aplanar documento escaneado|flatten scanned/i;

/** La casilla es sr-only con su etiqueta encima (zona de toque de 44 px): se marca como el usuario, por la etiqueta. */
async function enableFlatten(page: import("@playwright/test").Page) {
  await page.locator("label", { hasText: FLATTEN_LABEL }).click();
  await expect(page.getByRole("checkbox", { name: FLATTEN_LABEL })).toBeChecked();
}

/**
 * Desde `a5ace43` el modo por defecto es «recompress» (conserva el texto y solo
 * recomprime JPEG): rasterizar paginas es una decision EXPLICITA del usuario,
 * la casilla «Aplanar documento escaneado». Sin marcarla, «Extrema» no
 * rasteriza, asi que el spec la marca antes de elegir el nivel.
 */
async function runExtremeCompression(page: import("@playwright/test").Page) {
  await page.goto("/compress-pdf");
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(FIXTURE);
  await enableFlatten(page);
  await page.getByRole("radio", { name: /extrema|extreme/i }).click();
  await page.getByRole("button", { name: /procesar|process/i }).first().click();
  return downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
  });
}

/** PDF de 2 paginas con texto + una foto JPEG de ruido (calidad alta) por pagina: el caso real de «recompress». */
async function buildJpegPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 2; index += 1) {
    const page = document.addPage([400, 300]);
    const jpeg = await document.embedJpg(makeImage("jpeg", 800, 560, 40 + index, 97));
    page.drawImage(jpeg, { x: 10, y: 50, width: 380, height: 240 });
    page.drawText(`TEXTO-CONSERVADO-${index}`, { x: 20, y: 20, size: 14, font });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

test.describe("compress-pdf", () => {
  test("nivel extremo produce un PDF valido, mas liviano, con las paginas rasterizadas", async ({ page }) => {
    const bytes = await runExtremeCompression(page);

    // El motor documenta que un PDF de solo texto puede pesar MAS
    // comprimido: este fixture es deliberadamente pesado en imagenes de
    // ruido para que la reduccion sea real y medible, no un caso limite.
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(ORIGINAL_SIZE_BYTES);

    const pageCount = await getPageCount(bytes);
    expect(pageCount).toBe(2);

    for (const pageNumber of [1, 2]) {
      const size = await getPageSize(bytes, pageNumber);
      // El motor preserva el tamano de pagina original (400x300) exacto.
      expect(size.width).toBeCloseTo(400, 0);
      expect(size.height).toBeCloseTo(300, 0);

      const ops = await getPageOperatorCounts(bytes, pageNumber);
      expect(ops.textPaintOps).toBe(0);
      expect(ops.imagePaintOps).toBeGreaterThan(0);
    }
  });

  test("la interfaz muestra el porcentaje de reduccion REAL, calculado sobre los bytes de verdad", async ({ page }) => {
    const bytes = await runExtremeCompression(page);

    // Mismo calculo que reductionPercent() en lib/pdf/compress.ts: no
    // basta con que aparezca CUALQUIER porcentaje con signo (un "-1%" fijo
    // pasaria esa prueba laxa) -- tiene que ser el numero real.
    const expectedReduction = Math.round(
      ((ORIGINAL_SIZE_BYTES - bytes.length) / ORIGINAL_SIZE_BYTES) * 100,
    );
    expect(expectedReduction).toBeGreaterThan(0);

    const expectedText = new RegExp(`[−-]${expectedReduction}%`);
    await expect(page.getByText(expectedText)).toBeVisible({ timeout: 30_000 });
  });

  test("modo por defecto (recompress): PDF valido, mas liviano, paginas intactas y el texto SE CONSERVA", async ({ page }) => {
    const original = await buildJpegPdf();
    await page.goto("/compress-pdf");
    await page.locator('input[type="file"]').setInputFiles({
      name: "fotos con texto.pdf",
      mimeType: "application/pdf",
      buffer: original,
    });
    // Sin tocar nada: la casilla de aplanar esta apagada (modo por defecto).
    await expect(
      page.getByRole("checkbox", { name: /aplanar documento escaneado|flatten scanned/i }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: /procesar|process/i }).first().click();
    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
    });

    // Valido y mas liviano que el original.
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(original.length);
    expect(await getPageCount(bytes)).toBe(2);

    for (const pageNumber of [1, 2]) {
      // Paginas intactas: mismo tamano, la foto sigue ahi y el texto es texto de verdad.
      const size = await getPageSize(bytes, pageNumber);
      expect(size.width).toBeCloseTo(400, 0);
      expect(size.height).toBeCloseTo(300, 0);
      const ops = await getPageOperatorCounts(bytes, pageNumber);
      expect(ops.textPaintOps).toBeGreaterThan(0);
      expect(ops.imagePaintOps).toBeGreaterThan(0);
      expect(await getPageText(bytes, pageNumber)).toContain(`TEXTO-CONSERVADO-${pageNumber}`);
    }

    // La reduccion que declara la interfaz es la de los bytes reales.
    const expected = Math.round(((original.length - bytes.length) / original.length) * 100);
    expect(expected).toBeGreaterThan(0);
    await expect(page.getByText(new RegExp(`[−-]${expected}%`))).toBeVisible({ timeout: 30_000 });
  });

  test("«Extrema» sin aplanar NO rasteriza: el texto se conserva; con aplanar, 0 operadores de texto", async ({ page }) => {
    // Sin aplanar: el nivel solo cambia la calidad de las fotos, nunca el texto.
    await page.goto("/compress-pdf");
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await page.getByRole("radio", { name: /extrema|extreme/i }).click();
    await page.getByRole("button", { name: /procesar|process/i }).first().click();
    const kept = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
    });
    expect(await getPageCount(kept)).toBe(2);
    expect((await getPageOperatorCounts(kept, 1)).textPaintOps).toBeGreaterThan(0);
    expect(await getPageText(kept, 1)).toContain("Pagina 1");

    // Aplanando: texto rasterizado.
    const flat = await runExtremeCompression(page);
    expect(await getPageCount(flat)).toBe(2);
    expect((await getPageOperatorCounts(flat, 1)).textPaintOps).toBe(0);
    expect(await getPageText(flat, 1)).toBe("");
  });
});
