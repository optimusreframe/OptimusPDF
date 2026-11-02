import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Page } from "@playwright/test";
import { expect, openTool, runButton, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { makePhotoSet, removePhotoSet, type PhotoSet } from "../helpers/photo-set";

/**
 * Imagenes a PDF · una foto mala NO aborta todo el PDF ni se cuela rota, y se nombra.
 *
 * Fotos de prueba: 3 buenas, un `.jpg` con basura, un `.png` que es texto y un JPEG cortado a la mitad (descarga interrumpida).
 * Antes: «No se pudo completar. Ese formato no sirve» sin decir cual (y se perdian las buenas) y el JPEG truncado se
 * incrustaba roto sin aviso. Ahora: aviso previo con el NOMBRE de cada una, «Quitar y continuar», y si no se quitan se omiten al
 * procesar y el resultado las nombra. Tambien HEIC: se acepta en el selector y, donde el navegador no lo abre, se dice con claridad.
 */

test.use({ locale: "es-ES" });

const DIR = path.resolve(process.cwd(), ".evidence", "img-bad-tmp");
let good: PhotoSet;
let garbage = "";
let textPng = "";
let truncated = "";
let fakeHeic = "";
const HEIC_FIXTURE = path.resolve(process.cwd(), "e2e", "fixtures", "small-o6.heic");

test.beforeAll(async () => {
  test.setTimeout(120_000);
  good = await makePhotoSet({ name: "bad-good", count: 3, size: () => ({ width: 1600, height: 1200 }), distinct: 3, quality: 88 });
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  garbage = path.join(DIR, "foto-04-basura.jpg");
  const noise = Buffer.alloc(4096);
  for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 131 + 7) & 255;
  noise[0] = 0x12;
  writeFileSync(garbage, noise);
  textPng = path.join(DIR, "foto-05-notas.png");
  writeFileSync(textPng, "Esto no es una imagen, es un texto cualquiera.\n".repeat(40));
  truncated = path.join(DIR, "foto-06-cortada.jpg");
  writeFileSync(truncated, good.buffers[0].subarray(0, Math.floor(good.buffers[0].length * 0.55)));
  fakeHeic = path.join(DIR, "IMG_0007.HEIC");
  const heic = Buffer.alloc(2048, 7);
  heic.set([0, 0, 0, 24], 0);
  heic.write("ftypheic", 4, "ascii");
  writeFileSync(fakeHeic, heic);
});
test.afterAll(() => {
  removePhotoSet(good);
  rmSync(DIR, { recursive: true, force: true });
});

const mixed = (): string[] => [good.paths[0], garbage, good.paths[1], textPng, truncated, good.paths[2]];

async function upload(page: Page, files: string[]): Promise<void> {
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(files);
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
}

async function download(page: Page): Promise<PDFDocument> {
  const button = page.getByRole("button", { name: "Descargar", exact: true });
  await expect(button).toBeVisible({ timeout: 120_000 });
  const { bytes } = await downloadFile(page, () => button.click());
  return PDFDocument.load(bytes);
}

test("las fotos malas se nombran ANTES de procesar, con su motivo, y «Quitar y continuar» las quita todas", async ({ page }) => {
  test.setTimeout(180_000);
  await upload(page, mixed());
  const alert = page.locator("[data-photo-problems]");
  await expect(alert).toBeVisible({ timeout: 60_000 });
  await expect(alert).toHaveAttribute("role", "alert");
  await expect(alert.locator("li")).toHaveCount(3, { timeout: 60_000 });
  await expect(alert).toContainText("3 fotos no se pueden usar");
  await expect(alert.locator("li", { hasText: "foto-04-basura.jpg" })).toContainText("no es una imagen válida");
  await expect(alert.locator("li", { hasText: "foto-05-notas.png" })).toContainText("no es una imagen válida");
  await expect(alert.locator("li", { hasText: "foto-06-cortada.jpg" })).toContainText("está incompleta");
  // Las buenas no aparecen en el aviso.
  await expect(alert).not.toContainText("foto-01.jpg");

  await alert.getByRole("button", { name: "Quitar y continuar" }).click();
  await expect(alert).toBeHidden();
  // Quedan las 3 buenas en la lista de archivos.
  const names = await page.locator("main li p[data-file-name]").allTextContents();
  expect(names.sort()).toEqual(["foto-01.jpg", "foto-02.jpg", "foto-03.jpg"]);

  await runButton(page).click();
  const document = await download(page);
  expect(document.getPageCount()).toBe(3);
  await expect(page.locator("[data-download-notices]")).toHaveCount(0);
});

for (const quality of ["Equilibrada", "Original"] as const) {
  test(`si no se quitan, se OMITEN al procesar con «${quality}» y el resultado las nombra: nunca un PDF con una imagen rota sin aviso`, async ({ page }) => {
    test.setTimeout(180_000);
    await upload(page, mixed());
    await expect(page.locator("[data-photo-problems] li")).toHaveCount(3, { timeout: 60_000 });
    await page.getByRole("tab", { name: quality, exact: true }).click();
    await runButton(page).click();
    const document = await download(page);
    // 3 buenas: ni basura, ni texto, ni el JPEG cortado (que con «Original» se incrustaba tal cual, roto).
    expect(document.getPageCount()).toBe(3);
    const notices = page.locator("[data-download-notices]");
    await expect(notices).toContainText("Se omitieron 3 fotos y no están en el PDF");
    await expect(notices).toContainText("foto-04-basura.jpg (no es una imagen)");
    await expect(notices).toContainText("foto-05-notas.png (no es una imagen)");
    await expect(notices).toContainText("foto-06-cortada.jpg (incompleta)");
    // El resumen cuenta solo las fotos que entraron.
    await expect(page.locator("[data-download-summary]")).toContainText("Tus fotos:");
  });
}

test("si TODAS las fotos son inservibles no se genera nada y los nombres siguen a la vista", async ({ page }) => {
  test.setTimeout(120_000);
  await upload(page, [garbage, textPng]);
  await expect(page.locator("[data-photo-problems] li")).toHaveCount(2, { timeout: 60_000 });
  await runButton(page).click();
  await expect(page.getByRole("alert").filter({ hasText: /No se pudo completar|formato/i }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-photo-problems]")).toContainText("foto-04-basura.jpg");
});

test("HEIC/HEIF se acepta en el selector; si el navegador no lo abre se dice como arreglarlo y el resto sigue", async ({ page }) => {
  test.setTimeout(180_000);
  await openTool(page, "jpg-to-pdf");
  const accept = (await page.locator('input[type="file"]').first().getAttribute("accept")) ?? "";
  for (const token of ["image/heic", "image/heif", ".heic", ".heif"]) expect(accept, `accept incluye ${token}`).toContain(token);

  // ¿Este navegador decodifica HEIC? (Safari si; Chromium y Firefox no.) La prueba comprueba lo que corresponde en cada caso.
  const canOpenHeic = await page.evaluate(async (bytes) => {
    try {
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/heic" });
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return true;
    } catch {
      return false;
    }
  }, Array.from(readFileSync(HEIC_FIXTURE)));

  test.info().annotations.push({ type: "heic", description: canOpenHeic ? "este navegador decodifica HEIC" : "este navegador NO decodifica HEIC" });
  await page.locator('input[type="file"]').first().setInputFiles([good.paths[0], HEIC_FIXTURE, fakeHeic]);
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
  const alert = page.locator("[data-photo-problems]");
  // El HEIC de mentira (bytes basura tras la firma) nunca se puede abrir, con o sin soporte.
  await expect(alert.locator("li", { hasText: "IMG_0007.HEIC" })).toContainText("es HEIC y este navegador no puede abrirlo", { timeout: 60_000 });
  await expect(alert.locator("li", { hasText: "IMG_0007.HEIC" })).toContainText("«Más compatible» en Ajustes › Cámara o exporta como JPEG");
  if (canOpenHeic) {
    await expect(alert.locator("li", { hasText: "small-o6.heic" })).toHaveCount(0);
    await alert.getByRole("button", { name: "Quitar y continuar" }).click();
    await runButton(page).click();
    const document = await download(page);
    expect(document.getPageCount()).toBe(2);
    // La foto HEIC con orientacion 6 sale derecha (vertical).
    const { width, height } = document.getPage(1).getSize();
    expect(height).toBeGreaterThan(width);
  } else {
    await expect(alert.locator("li", { hasText: "small-o6.heic" })).toContainText("es HEIC y este navegador no puede abrirlo");
    await alert.getByRole("button", { name: "Quitar y continuar" }).click();
    await runButton(page).click();
    expect((await download(page)).getPageCount()).toBe(1);
  }
});
