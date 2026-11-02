import { expect, test } from "@playwright/test";
import path from "node:path";
import JSZip from "jszip";
import { downloadBytes } from "../helpers/downloads";
import { readJpegDimensions } from "../helpers/jpeg-dimensions";

const FIXTURE = path.join(__dirname, "..", "fixtures", "core-rotated-pages.pdf");

/**
 * Ejercita el camino compartido de `core.ts` (`openPdfDocument` +
 * `renderPageToCanvas`) a traves de /pdf-to-jpg: worker de pdf.js, apertura
 * real, render y --lo mas especifico de este motor-- la rotacion de
 * pagina ya aplicada en el viewport antes de rasterizar.
 */
test.describe("core.ts via pdf-to-jpg (render + rotacion compartidos)", () => {
  test("renderiza 2 paginas reales, con la pagina rotada intercambiando ancho/alto", async ({ page }) => {
    await page.goto("/pdf-to-jpg");

    const input = page.locator('input[type="file"]');
    await input.setInputFiles(FIXTURE);

    await page.getByRole("button", { name: /procesar|process/i }).first().click();

    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
    });

    // 2 paginas -> el motor entrega un ZIP con una imagen por pagina.
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).sort();
    expect(names.length).toBe(2);

    const buffers = await Promise.all(
      names.map(async (name) => {
        const data = await zip.files[name].async("nodebuffer");
        return { name, data };
      }),
    );

    const dimensions = buffers.map(({ name, data }) => ({
      name,
      ...readJpegDimensions(data),
    }));

    // Ambos JPG deben ser validos y no vacios.
    for (const dim of dimensions) {
      expect(dim.width).toBeGreaterThan(0);
      expect(dim.height).toBeGreaterThan(0);
    }

    // Pagina 1: sin rotar, 400x300 -> mas ancha que alta.
    const [page1, page2] = dimensions;
    expect(page1.width).toBeGreaterThan(page1.height);

    // Pagina 2: rotada 90 grados -> el viewport ya aplica la rotacion, asi
    // que el JPG resultante sale mas alto que ancho (ratio invertido
    // respecto a la pagina 1, que comparte las mismas dimensiones base).
    expect(page2.height).toBeGreaterThan(page2.width);
  });
});
