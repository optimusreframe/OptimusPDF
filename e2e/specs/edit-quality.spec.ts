import { expect, test, type Page } from "@playwright/test";
import { makeSmallTextPdf } from "../../src/lib/pdf/testing/signSyntheticPdfs";
import { isBenignEngineNoise } from "../helpers/engine";
import { compareImages, crop, decodePngGray } from "../helpers/image-metrics";
import { renderNativeReference } from "../helpers/native-reference";

/**
 * «Editar PDF»: nitidez del texto de la hoja (Wave 10 · C-A1). Headless siempre.
 *
 * Causa que se vigila: la superficie de Editar (`EditSurface`) dibujaba la pagina en un lienzo fuera de pantalla SIN
 * contexto 2D propio, asi que pdf.js creaba el suyo con `{ alpha: false, willReadFrequently: true }`. Un lienzo opaco
 * recibe antialiasing LCD (subpixel RGB) en Chromium para Linux (fontconfig de Ubuntu: `10-sub-pixel-rgb.conf`) y para
 * Windows (ClearType): el texto salia con franjas naranja y azul, distinto al de Firmar, que crea su contexto no opaco
 * antes de dibujar (`renderPageRaster`, ver docs/PLAN-REDISENO.md «Wave 9 · nitidez en Linux»). En macOS Chromium no
 * aplica LCD y esta prueba pasa igual con o sin la correccion: ahi la protege `EditSurface.test.tsx`; en Linux (el
 * runner de CI, o Docker con la imagen de Playwright) es esta prueba la que falla con el lienzo opaco.
 *
 * Dos medidas independientes del mismo lienzo (`[data-edit-canvas]`, lo que lee el muestreo de fondo y lo que se ve):
 *  1. Franjas de color: la tinta del PDF de prueba es casi neutra (R, G y B a < 16 de distancia), asi que un pixel con
 *     mas de 20 de diferencia entre canales es antialiasing LCD. MEDIDO en Linux con el lienzo opaco: 23.307 pixeles con
 *     color (maxima diferencia 151); con el no opaco, 0 y 15.
 *  2. El lienzo frente al pdf.js nativo del mismo navegador a su mismo tamano con un contexto no opaco (la misma
 *     referencia con la que se prueba Firmar): SSIM > 0,999, dif. media < 0,5, nitidez > 0,98 y desplazamiento (0, 0).
 */

test.setTimeout(120_000);
test.use({ locale: "es-ES", bypassCSP: true });

const FILE_INPUT = 'input[type="file"][accept*="pdf"]';
const CANVAS = "[data-edit-canvas]";
const SHEET = "[data-page-index]";

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isBenignEngineNoise(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (!isBenignEngineNoise(error.message)) errors.push(error.message);
  });
  return errors;
}

async function open(page: Page, bytes: Uint8Array) {
  await page.goto("/edit-pdf");
  await page
    .locator(FILE_INPUT)
    .first()
    .setInputFiles({ name: "texto-pequeno.pdf", mimeType: "application/pdf", buffer: Buffer.from(bytes) });
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
}

/** Espera a que el lienzo definitivo (el nitido, no el del zoom anterior) este puesto y no cambie de tamano. */
async function settleCanvas(page: Page, scope = ""): Promise<{ width: number; height: number }> {
  const canvas = page.locator(`${scope} ${CANVAS}`.trim());
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 100 && stable < 4; attempt += 1) {
    await page.waitForTimeout(150);
    const state = await page.locator(`${scope} ${SHEET}`.trim()).getAttribute("data-render-state");
    const size = await canvas.evaluate((el: HTMLCanvasElement) => `${el.width}x${el.height}`);
    stable = state === "ready" && size === previous ? stable + 1 : 0;
    previous = size;
  }
  const [width, height] = previous.split("x").map(Number);
  return { width, height };
}

/** Lo que dice el lienzo: PNG sin perdida y la cuenta de pixeles con color (franjas LCD). */
async function readCanvas(page: Page, scope = "") {
  return page.locator(`${scope} ${CANVAS}`.trim()).evaluate((el: HTMLCanvasElement) => {
    const context = el.getContext("2d")!;
    const { data } = context.getImageData(0, 0, el.width, el.height);
    let coloured = 0;
    let maxSpread = 0;
    for (let i = 0; i < data.length; i += 4) {
      const spread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      if (spread > maxSpread) maxSpread = spread;
      if (spread > 20) coloured += 1;
    }
    return { png: el.toDataURL("image/png").split(",")[1], coloured, maxSpread, width: el.width, height: el.height };
  });
}

async function expectSharpAndGrey(page: Page, bytes: Uint8Array, scope = "") {
  const read = await readCanvas(page, scope);
  // 1) Sin franjas de color: el texto de Editar sale en grises, como el de Firmar.
  // `soft`: si falla, tambien se miden las cifras de la comparacion con la referencia (mas abajo) y salen en el informe.
  expect.soft(read.coloured, `pixeles con color (LCD): ${read.coloured}, diferencia maxima entre canales ${read.maxSpread}`).toBe(0);
  expect.soft(read.maxSpread).toBeLessThanOrEqual(20);
  // 2) Identico al render nativo no opaco a su mismo tamano.
  const natural = await decodePngGray(Buffer.from(read.png, "base64"));
  // La referencia se pide al ancho EXACTO que pinta la aplicacion (ancho CSS de la hoja x DPR), no al del lienzo: con un
  // ancho de 1290 px el flotante de pdf.js da 1289,9999 y el lienzo sale 1 px mas estrecho (se estira por CSS), lo que
  // desplazaria la escala de la referencia una fraccion y bajaria el SSIM sin que cambie la nitidez.
  const paintedWidth = await page.locator(`${scope} ${SHEET}`.trim()).evaluate((el) =>
    Math.round(parseFloat((el as HTMLElement).style.width) * Math.min(3, window.devicePixelRatio)),
  );
  expect(Math.abs(paintedWidth - natural.width)).toBeLessThanOrEqual(1);
  const reference = await renderNativeReference(page, bytes, 1, paintedWidth);
  const h = Math.min(natural.height, reference.height);
  const y0 = Math.round(h * 0.04);
  const hh = Math.round(h * 0.5);
  const result = compareImages(crop(natural, 0, y0, natural.width, hh), crop(reference, 0, y0, reference.width, hh), {
    margin: 10,
    maxShift: 2,
  });
  const detail = `lienzo ${read.width}x${read.height}: ${JSON.stringify(result)}`;
  expect(result.shift, detail).toEqual({ x: 0, y: 0 });
  expect(result.ssim, detail).toBeGreaterThan(0.999);
  expect(result.meanAbsDiff, detail).toBeLessThan(0.5);
  expect(result.sharpnessRatio, detail).toBeGreaterThan(0.98);
}

for (const dpr of [1, 2]) {
  test.describe(`escritorio 1280x800, DPR ${dpr}`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });

    test("la hoja de Editar es tan nitida como el render nativo y su texto va en grises (sin franjas LCD)", async ({ page }) => {
      const errors = trackErrors(page);
      const bytes = await makeSmallTextPdf();
      await open(page, bytes);
      const { width } = await settleCanvas(page);
      // El bitmap tiene los pixeles que se ven (ancho CSS de la hoja x DPR).
      const css = await page.locator("[data-page-index]").evaluate((el) => el.getBoundingClientRect().width);
      expect(width).toBeGreaterThanOrEqual(Math.floor(css * dpr * 0.98));
      await expectSharpAndGrey(page, bytes);
      expect(errors).toEqual([]);
    });
  });
}

test.describe("escritorio 1280x800, al acercar", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test("al acercar (x1,5) Editar vuelve a dibujar a mas resolucion y el texto sigue en grises y nitido", async ({ page }) => {
    const bytes = await makeSmallTextPdf();
    await open(page, bytes);
    const before = await settleCanvas(page);
    const zoomIn = page.getByRole("button", { name: "Acercar" });
    await zoomIn.click();
    await zoomIn.click();
    await expect(page.getByRole("group", { name: /zoom/i }).first()).not.toContainText("100 %");
    // Un lienzo nuevo (el render del zoom) con mas pixeles que el de zoom 1.
    await expect
      .poll(async () => (await settleCanvas(page)).width, { timeout: 30_000 })
      .toBeGreaterThan(before.width * 1.1);
    await expectSharpAndGrey(page, bytes);
  });
});

test.describe("PDF Pro · modo Editar, escritorio 1280x800", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test("el modo Editar de PDF Pro monta el mismo editor: su hoja tambien va en grises y es nitida", async ({ page }) => {
    const errors = trackErrors(page);
    const bytes = await makeSmallTextPdf();
    await page.goto("/pdf-pro");
    await page
      .locator(FILE_INPUT)
      .first()
      .setInputFiles({ name: "texto-pequeno.pdf", mimeType: "application/pdf", buffer: Buffer.from(bytes) });
    await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible({ timeout: 40_000 });
    await page.locator('[role="tab"][data-tab="edit"]').click();
    const scope = "[data-pro-editor]";
    await expect(page.locator(`${scope} [data-render-state="ready"]`)).toBeVisible({ timeout: 40_000 });
    await settleCanvas(page, scope);
    await expectSharpAndGrey(page, bytes, scope);
    expect(errors).toEqual([]);
  });
});

test.describe("movil tactil 375x812, DPR 3", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("en el movil la hoja de Editar es nitida (a DPR 3) y sin franjas de color", async ({ page }) => {
    const errors = trackErrors(page);
    const bytes = await makeSmallTextPdf();
    await open(page, bytes);
    const { width } = await settleCanvas(page);
    const css = await page.locator("[data-page-index]").evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThanOrEqual(Math.floor(css * 3 * 0.98));
    await expectSharpAndGrey(page, bytes);
    expect(errors).toEqual([]);
  });
});
