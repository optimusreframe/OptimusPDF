import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, openTool, runButton, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { MB, makePhotoSet, removePhotoSet, type PhotoSet } from "../helpers/photo-set";

/**
 * Imagenes a PDF · matriz de tamanos y tiempos con 39 fotos sinteticas equivalentes al caso real («Roof inspection»,
 * 39 paginas, ~8,6 MB por foto): fotos de movil de 12 / 24 / 48 MP con orientacion EXIF mezclada, con 1, 2, 4, 6, 8 y 10
 * fotos por hoja y las calidades «Original», «Alta», «Equilibrada» y «Compacta». Imprime la tabla (peso del PDF, ahorro,
 * segundos) y comprueba lo esencial: el PDF tiene las hojas esperadas, ninguna combinacion pesa mas que las fotos y mas fotos
 * por hoja nunca pesa mas con la misma calidad.
 */

test.use({ locale: "es-ES" });
test.setTimeout(900_000);

const PHOTOS = 39;
let set: PhotoSet;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  // 8,6 MB por foto como en el caso real: fotos de 24 MP y 48 MP con textura (JPEG a calidad 97).
  set = await makePhotoSet({
    name: "matrix",
    count: PHOTOS,
    size: (index) => (index % 3 === 0 ? { width: 8064, height: 6048 } : index % 3 === 1 ? { width: 5712, height: 4284 } : { width: 4284, height: 5712 }),
    distinct: 3,
    quality: 97,
  });
});
test.afterAll(() => removePhotoSet(set));

const PRESETS = ["Original", "Alta", "Equilibrada", "Compacta"] as const;
const PER_PAGE = [1, 2, 4, 6, 8, 10] as const;

test("39 fotos × fotos por hoja × calidad: pesos y tiempos", async ({ page }) => {
  const rows: string[] = [];
  const sizes = new Map<string, number>();
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(set.paths);
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByAltText(/^Imagen \d+$/)).toHaveCount(PHOTOS, { timeout: 180_000 });
  for (const perPage of PER_PAGE) {
    await page.getByRole("tablist", { name: "Fotos por página" }).getByRole("tab", { name: String(perPage), exact: true }).click();
    // «Original» no depende de las fotos por hoja (los bytes son los mismos): se mide una vez (1 por hoja) y con 10 por hoja.
    for (const preset of PRESETS.filter((name) => name !== "Original" || perPage === 1 || perPage === 10)) {
      await page.getByRole("tab", { name: preset, exact: true }).click();
      const started = Date.now();
      await runButton(page).click();
      const download = page.getByRole("button", { name: "Descargar", exact: true });
      await expect(download).toBeVisible({ timeout: 300_000 });
      const seconds = (Date.now() - started) / 1000;
      const summary = (await page.locator("[data-download-summary]").textContent()) ?? "";
      const { bytes } = await downloadFile(page, () => download.click());
      const document = await PDFDocument.load(bytes, { updateMetadata: false });
      expect(document.getPageCount()).toBe(Math.ceil(PHOTOS / perPage));
      sizes.set(`${perPage}/${preset}`, bytes.length);
      rows.push(`${String(perPage).padStart(2)} por hoja · ${preset.padEnd(11)} ${(bytes.length / MB).toFixed(1).padStart(6)} MB  ${String(Math.round((1 - bytes.length / set.totalBytes) * 100)).padStart(3)} % menos  ${seconds.toFixed(1).padStart(5)} s  hojas ${document.getPageCount()}   [${summary.trim()}]`);
      // De nuevo a las opciones: «Empezar de nuevo» devuelve la pantalla de carga, asi que se vuelve a abrir y subir.
      await page.getByRole("button", { name: "Empezar de nuevo" }).click();
      await page.locator('input[type="file"]').first().setInputFiles(set.paths);
      await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("tablist", { name: "Fotos por página" }).getByRole("tab", { name: String(perPage), exact: true }).click();
    }
  }
  console.log(`\n[matriz] ${test.info().project.name}: 39 fotos, ${(set.totalBytes / MB).toFixed(1)} MB en total (${(set.totalBytes / MB / PHOTOS).toFixed(1)} MB por foto)\n${rows.join("\n")}\n`);
  for (const perPage of [1, 10]) expect(sizes.get(`${perPage}/Original`)!).toBeGreaterThan(set.totalBytes * 0.99);
  for (const perPage of PER_PAGE) {
    for (const preset of ["Alta", "Equilibrada", "Compacta"] as const) expect(sizes.get(`${perPage}/${preset}`)!).toBeLessThan(set.totalBytes);
  }
  for (const preset of ["Equilibrada", "Compacta"] as const) {
    let previous = Infinity;
    for (const perPage of PER_PAGE) {
      const size = sizes.get(`${perPage}/${preset}`)!;
      expect(size, `${preset}: ${perPage} por hoja no pesa mas que con menos fotos por hoja`).toBeLessThanOrEqual(previous * 1.02);
      previous = size;
    }
  }
});
