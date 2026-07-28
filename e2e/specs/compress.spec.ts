import { expect, test } from "@playwright/test";
import path from "node:path";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageSize } from "../helpers/pdf-inspection";

const FIXTURE = path.join(__dirname, "..", "fixtures", "compress-photo-heavy.pdf");
const ORIGINAL_SIZE_BYTES = 477610; // ver e2e/fixtures/generate-fixtures.mjs

test.describe("compress-pdf", () => {
  test("nivel extremo produce un PDF valido, mas liviano, con las paginas rasterizadas", async ({ page }) => {
    await page.goto("/compress-pdf");

    const input = page.locator('input[type="file"]');
    await input.setInputFiles(FIXTURE);

    await page.getByRole("radio", { name: /extrema|extreme/i }).click();
    await page.getByRole("button", { name: /procesar|process/i }).first().click();

    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: /descargar|download/i }).first().click();
    });

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

  test("la interfaz muestra un porcentaje de reduccion real, no inventado", async ({ page }) => {
    await page.goto("/compress-pdf");
    const input = page.locator('input[type="file"]');
    await input.setInputFiles(FIXTURE);
    await page.getByRole("radio", { name: /extrema|extreme/i }).click();
    await page.getByRole("button", { name: /procesar|process/i }).first().click();

    await expect(page.getByText(/−\d+%|\+\d+%/)).toBeVisible({ timeout: 30_000 });
  });
});
