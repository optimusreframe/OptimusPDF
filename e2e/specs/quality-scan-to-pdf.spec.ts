import { expect, test } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount } from "../helpers/pdf-inspection";
import { importPhotos, installScanFakes, waitIdle, waitVideoReady, widthCodedFiles } from "../helpers/scan-ui";

/**
 * Escanear a PDF · «Calidad de imagen» (camara falsa de Chromium, proyecto `chromium-fake-camera`): al guardar, el selector esta, la
 * recomendada viene marcada, la estimacion usa «≈», se recuerda la ultima eleccion y la pantalla de resultado muestra
 * «Tus fotos → PDF». Los PDF de siempre (un fotograma de 320x240) no cambian: se prueba en `scan-to-pdf.spec.ts`.
 */

test.use({ locale: "es-ES" });

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
});

test("el selector de calidad, la estimacion y el «Antes → Despues» del resultado", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  await page.getByRole("button", { name: /activar cámara|turn camera on/i }).click();
  await waitVideoReady(page);
  await page.locator('[data-camera-action="auto"]').click();
  await page.getByRole("button", { name: /capturar página|capture page/i }).click();
  await expect(page.locator("[data-camera-count]")).toHaveText(/^1 (página|page)$/);
  await page.getByRole("button", { name: /revisar \(1\)|review \(1\)/i }).click();
  await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(1);
  await waitIdle(page);
  await page.getByRole("button", { name: /guardar pdf|save pdf/i }).click();

  const picker = page.locator("[data-image-quality]");
  await expect(picker).toBeVisible();
  for (const name of ["Original", "Alta", "Equilibrada", "Compacta"]) await expect(picker.getByRole("tab", { name, exact: true })).toBeVisible();
  await expect(picker.getByRole("tab", { name: "Equilibrada", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(picker.locator("[data-image-quality-description]")).toContainText("Recomendada");
  // La estimacion se calcula con la foto capturada.
  await expect(picker.locator("[data-image-quality-estimate]")).toContainText("≈", { timeout: 30_000 });

  await picker.getByRole("tab", { name: "Compacta", exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem("optimuspdf.imageQuality"))).toBe("compact");
  await expect(picker.locator("[data-image-quality-description]")).toContainText("correo");

  await page.locator('[data-save-action="create"]').click();
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
  });
  expect(await getPageCount(bytes)).toBe(1);
  await expect(page.locator("[data-download-summary]")).toContainText(/Tus fotos: .* → PDF: /);

  // «Empezar de nuevo»: la calidad elegida se conserva en el siguiente escaneo.
  await page.getByRole("button", { name: /empezar de nuevo|start over/i }).click();
  await importPhotos(page, widthCodedFiles(1));
  await waitIdle(page);
  await page.getByRole("button", { name: /guardar pdf|save pdf/i }).click();
  await expect(page.locator("[data-image-quality]").getByRole("tab", { name: "Compacta", exact: true })).toHaveAttribute("aria-selected", "true");
});
