import { test, type Page } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount } from "../helpers/pdf-inspection";
import { docJpeg, expect, fakeControls, importPhotos, installScanFakes, pageIds, waitIdle, TEST_TIMEOUT, USE_REAL_ENGINE } from "../helpers/scan-ui";

/**
 * Escaner · CONTRATO de integracion interfaz <-> motor/almacen. Usa documentos SINTETICOS sin etiquetas en el nombre: lo que se
 * detecta sale de los PIXELES (hoja en blanco, copia exacta), asi que el mismo spec pasa con el motor FALSO (por defecto) y con
 * el REAL (`SCAN_REAL=1 npx playwright test e2e/specs/scan-ui-contract.spec.ts`): es la prueba de que el motor real cumple lo que
 * la interfaz da por hecho. Si falla con el real, el defecto esta en el motor o en el almacen, no en la interfaz.
 */
test.use({ locale: "es-ES" });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
});

const tiles = (page: Page) => page.locator("[data-page-grid] [data-page-id]");
const file = (name: string, buffer: Buffer) => ({ name, mimeType: "image/jpeg", buffer });

async function load(page: Page) {
  await page.goto("/scan-to-pdf");
  const text1 = docJpeg({ seed: 1, width: 900, height: 1200 });
  const text2 = docJpeg({ seed: 2, width: 900, height: 1200 });
  await importPhotos(page, [
    file("hoja-1.jpg", text1),
    file("hoja-2.jpg", docJpeg({ variant: "blank", width: 900, height: 1200 })),
    file("hoja-3.jpg", text2),
    file("hoja-4.jpg", text1), // copia exacta de la primera
  ]);
  await expect(tiles(page)).toHaveCount(4, { timeout: 60_000 });
  await waitIdle(page, 120_000);
  // Los avisos llegan en segundo plano (analisis de la sesion).
  await expect(page.locator('[data-quality-chip="blank"]')).toHaveCount(1, { timeout: 60_000 });
}

test("el motor marca la hoja en blanco y la copia exacta; la interfaz ofrece quitarlas", async ({ page }) => {
  await load(page);
  await expect(tiles(page).nth(1).locator('[data-quality-chip="blank"]')).toHaveCount(1);
  await expect(tiles(page).nth(3).locator('[data-quality-chip="duplicate"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(tiles(page).nth(2).locator('[data-quality-chip="blank"]')).toHaveCount(0);
  await page.getByRole("button", { name: /Quitar hojas en blanco \(1\)/ }).click();
  await page.getByRole("dialog", { name: "Quitar hojas en blanco" }).getByRole("button", { name: "Quitar 1 hoja" }).click();
  await expect(tiles(page)).toHaveCount(3);
});

test("cada pagina trae miniatura procesada y se guarda en el almacen: recargar la recupera en el mismo orden", async ({ page }) => {
  await load(page);
  await expect(page.locator("[data-save-status]")).toHaveText("Guardado ✓", { timeout: 60_000 });
  const ids = await pageIds(page);
  await page.reload();
  await expect(tiles(page)).toHaveCount(4, { timeout: 30_000 });
  await waitIdle(page, 60_000);
  expect(await pageIds(page)).toEqual(ids);
  // Las miniaturas son imagenes de verdad (no vacias).
  const sizes = await page.locator("[data-page-grid] img").evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).naturalWidth));
  expect(sizes.length).toBeGreaterThan(0);
  for (const width of sizes) expect(width).toBeGreaterThan(8);
});

test("nombre propuesto con el formato acordado y PDF con una pagina por hoja, descargable", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: /Guardar PDF \(4\)/ }).click();
  const name = page.locator("#scan-name");
  await expect.poll(async () => name.inputValue(), { timeout: 30_000 }).toMatch(/^(Escaneo \d{4}-\d{2}-\d{2} \d{2}[:.]\d{2}|.+ · \d{4}-\d{2}-\d{2})$/);
  await expect(page.locator("[data-image-quality-estimate]")).toContainText("≈");
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 120_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download/i }).first().click();
  });
  expect(await getPageCount(bytes)).toBe(4);
  await expect(page.locator("[data-download-summary]")).toContainText(/Tus fotos: .* → PDF: /);
});

test("cancelar la creacion no pierde las paginas", async ({ page }) => {
  await load(page);
  // Con el motor falso se alarga la creacion para poder cancelarla; con el real, su propio ritmo (si acaba antes, se comprueba el resultado).
  if (!USE_REAL_ENGINE) await fakeControls(page, (c) => (c.buildDelayMs = 600));
  await page.getByRole("button", { name: /Guardar PDF \(4\)/ }).click();
  await page.locator('[data-save-action="create"]').click();
  const cancel = page.getByRole("button", { name: /cancelar|cancel/i });
  // Con el motor real el boton puede desaparecer entre la comprobacion y el clic (la creacion ya acabo): se trata como «ya termino».
  const cancelled = (await cancel.isVisible().catch(() => false)) && (await cancel.click({ timeout: 2_000 }).then(() => true, () => false));
  if (cancelled) {
    await expect(page.locator("[data-save-error]")).toBeVisible();
    await page.getByRole("button", { name: "Volver a revisar" }).click();
    await expect(tiles(page)).toHaveCount(4);
  } else {
    // Un motor tan rapido que ya termino: el resultado existe y las paginas siguen en la sesion guardada.
    await expect(page.locator("[data-result]")).toBeVisible({ timeout: 60_000 });
  }
});
