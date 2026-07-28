import { expect, test } from "@playwright/test";
import path from "node:path";
import { statSync } from "node:fs";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageSize } from "../helpers/pdf-inspection";

const FIXTURE = path.join(__dirname, "..", "fixtures", "compress-photo-heavy.pdf");
// Leido en vivo, no una constante copiada a mano: si el fixture se
// regenera con e2e/fixtures/generate-fixtures.mjs y cambia de tamano, la
// prueba sigue siendo correcta sin tocar nada aqui.
const ORIGINAL_SIZE_BYTES = statSync(FIXTURE).size;

async function runExtremeCompression(page: import("@playwright/test").Page) {
  await page.goto("/compress-pdf");
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(FIXTURE);
  await page.getByRole("radio", { name: /extrema|extreme/i }).click();
  await page.getByRole("button", { name: /procesar|process/i }).first().click();
  return downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download/i }).first().click();
  });
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
});
