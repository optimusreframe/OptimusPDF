import { expect, test } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount } from "../helpers/pdf-inspection";

/**
 * Escanear a PDF · «Calidad de imagen» (camara falsa de Chromium, proyecto `chromium-fake-camera`): el selector esta, la
 * recomendada viene marcada, la estimacion usa «≈», se recuerda la ultima eleccion y la pantalla de resultado muestra
 * «Tus fotos → PDF». Los PDF de siempre (un fotograma de 320x240) no cambian: se prueba en `scan-to-pdf.spec.ts`.
 */

test.use({ locale: "es-ES" });

test("el selector de calidad, la estimacion y el «Antes → Despues» del resultado", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  await page.getByRole("button", { name: /activar cámara|turn camera on/i }).click();
  await expect.poll(() => page.locator("video").evaluate((el: HTMLVideoElement) => el.videoWidth > 0 && el.readyState >= 2)).toBe(true);

  const picker = page.locator("[data-image-quality]");
  await expect(picker).toBeVisible();
  for (const name of ["Original", "Alta", "Equilibrada", "Compacta"]) await expect(picker.getByRole("tab", { name, exact: true })).toBeVisible();
  await expect(picker.getByRole("tab", { name: "Equilibrada", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(picker.locator("[data-image-quality-description]")).toContainText("Recomendada");

  await page.getByRole("button", { name: /capturar página|capture page/i }).click();
  await expect(page.getByAltText(/^(Captura \d+|Capture \d+)$/i)).toHaveCount(1);
  // Sin captura todavia en deteccion: la estimacion se calcula con la foto de la tira.
  await expect(picker.locator("[data-image-quality-estimate]")).toContainText("≈", { timeout: 30_000 });

  await picker.getByRole("tab", { name: "Compacta", exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem("optimuspdf.imageQuality"))).toBe("compact");
  await expect(picker.locator("[data-image-quality-description]")).toContainText("correo");

  await page.getByRole("button", { name: /generar pdf|build pdf/i }).first().click();
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download/i }).first().click();
  });
  expect(await getPageCount(bytes)).toBe(1);
  await expect(page.locator("[data-download-summary]")).toContainText(/Tus fotos: .* → PDF: /);

  // «Empezar de nuevo»: la calidad elegida se conserva.
  await page.getByRole("button", { name: /empezar de nuevo|start over/i }).click();
  await expect(page.locator("[data-image-quality]").getByRole("tab", { name: "Compacta", exact: true })).toHaveAttribute("aria-selected", "true");
});
