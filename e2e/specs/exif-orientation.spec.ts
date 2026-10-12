import { PDFDocument } from "@cantoo/pdf-lib";
import type { Page } from "@playwright/test";
import { expect, openTool, runAndDownload, test, uploadFiles } from "../helpers/tool-flow";
import { colorDistance, renderPageToPixels, type Rgba } from "../helpers/pdf-render-inspection";
import { makeExifJpeg } from "../helpers/exif-jpeg";
import { downloadFile } from "../helpers/downloads";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { STRINGS as JPG_TO_PDF_STRINGS } from "../../src/app/jpg-to-pdf/strings";

/**
 * Orientacion EXIF (ronda de correcciones de U8), navegador real y headless: una foto de movil se guarda «de lado» y lleva
 * la etiqueta EXIF que dice como girarla. «Imagen a PDF» y «Nuevo PDF desde imagenes» de PDF Pro deben dibujarla COMO SE VE
 * (antes salia la imagen cruda: pagina apaisada con la foto tumbada).
 *
 * La mitad izquierda de la imagen guardada es ROJA y la derecha AZUL (`makeExifJpeg`): el color de cada borde de la pagina
 * dice cuanto se giro. Con la orientacion 6 (girar 90° a la derecha) el rojo queda arriba; con la 8, abajo; con la 3, a la
 * derecha; con la 1, a la izquierda.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };
const C = PRO_STRINGS.es.create;

type Case = { orientation: 1 | 3 | 6 | 8; portrait: boolean; first: Rgba; second: Rgba; where: string };
/** Imagen guardada de 300x100 (apaisada): `first` es el color del borde izquierdo o superior de la foto vista. */
const CASES: readonly Case[] = [
  { orientation: 1, portrait: false, first: RED, second: BLUE, where: "izquierda/derecha" },
  { orientation: 3, portrait: false, first: BLUE, second: RED, where: "izquierda/derecha" },
  { orientation: 6, portrait: true, first: RED, second: BLUE, where: "arriba/abajo" },
  { orientation: 8, portrait: true, first: BLUE, second: RED, where: "arriba/abajo" },
];

async function expectOriented(bytes: Buffer, expected: Case): Promise<void> {
  const document = await PDFDocument.load(bytes);
  expect(document.getPageCount()).toBe(1);
  const size = document.getPage(0).getSize();
  expect(size.height > size.width, `orientacion ${expected.orientation}: pagina ${expected.portrait ? "vertical" : "horizontal"}`).toBe(expected.portrait);
  const rendered = await renderPageToPixels(bytes, 1, 1);
  const { width, height } = rendered;
  // Se muestrean dos puntos en el eje de la foto (centro de cada mitad).
  const points = expected.portrait
    ? [{ x: width / 2, y: height * 0.15 }, { x: width / 2, y: height * 0.85 }]
    : [{ x: width * 0.15, y: height / 2 }, { x: width * 0.85, y: height / 2 }];
  const [first, second] = points.map((point) => rendered.averageColor(Math.round(point.x) - 2, Math.round(point.y) - 2, 4, 4));
  expect(colorDistance(first, expected.first), `orientacion ${expected.orientation}: borde ${expected.where} (1.º) ${JSON.stringify(first)}`).toBeLessThan(90);
  expect(colorDistance(second, expected.second), `orientacion ${expected.orientation}: borde ${expected.where} (2.º) ${JSON.stringify(second)}`).toBeLessThan(90);
}

test.describe("Imagen a PDF respeta la orientacion EXIF", () => {
  for (const expected of CASES) {
    test(`orientacion ${expected.orientation}: ${expected.portrait ? "pagina vertical" : "pagina horizontal"} y la foto como se ve`, async ({ page }) => {
      await openTool(page, "jpg-to-pdf");
      await uploadFiles(page, {
        name: `foto-${expected.orientation}.jpg`,
        mimeType: "image/jpeg",
        buffer: makeExifJpeg({ width: 300, height: 100, orientation: expected.orientation }),
      });
      const { bytes } = await runAndDownload(page);
      await expectOriented(bytes, expected);
    });
  }
});

async function downloadCurrent(page: Page): Promise<{ bytes: Buffer; filename: string }> {
  return downloadFile(page, () => page.getByRole("button", { name: PRO_STRINGS.es.suite.download, exact: true }).click());
}

test.describe("«Nuevo PDF desde imagenes» de PDF Pro respeta la orientacion EXIF", () => {
  for (const expected of CASES.filter((entry) => entry.orientation === 6 || entry.orientation === 8)) {
    test(`orientacion ${expected.orientation}: pagina vertical y la foto como se ve (todo en el navegador)`, async ({ page }) => {
      await page.goto("/pdf-pro");
      await page.locator("[data-pro-create-input]").setInputFiles({
        name: `foto-${expected.orientation}.jpg`,
        mimeType: "image/jpeg",
        buffer: makeExifJpeg({ width: 300, height: 100, orientation: expected.orientation }),
      });
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("list", { name: C.images.listLabel })).toBeVisible();
      await dialog.getByRole("button", { name: C.images.create }).click();
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(C.images.fileName.replace(".", "\\.")) })).toBeVisible({ timeout: 30_000 });
      const file = await downloadCurrent(page);
      await expectOriented(file.bytes, expected);
    });
  }

  test("con «Ajustar» la pagina mide la foto YA girada (100x300 + margen), no la imagen cruda", async ({ page }) => {
    await page.goto("/pdf-pro");
    await page.locator("[data-pro-create-input]").setInputFiles({
      name: "foto-6.jpg",
      mimeType: "image/jpeg",
      buffer: makeExifJpeg({ width: 300, height: 100, orientation: 6 }),
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("list", { name: C.images.listLabel })).toBeVisible();
    await dialog.getByRole("radio", { name: JPG_TO_PDF_STRINGS.es.pageSizeFit }).click();
    await dialog.getByRole("button", { name: C.images.create }).click();
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(C.images.fileName.replace(".", "\\.")) })).toBeVisible({ timeout: 30_000 });
    const file = await downloadCurrent(page);
    const size = (await PDFDocument.load(file.bytes)).getPage(0).getSize();
    expect(size.height).toBeGreaterThan(size.width * 2);
  });
});
