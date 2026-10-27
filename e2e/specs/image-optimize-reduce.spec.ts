import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, openTool, runButton, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { embeddedImages, qualityAgainstAreaReference } from "../helpers/photo-set";
import { drawSyntheticPhoto } from "../../src/lib/image/photoTestUtils";

/**
 * Imagenes a PDF · la reduccion de fotos grandes NO deja aliasing en ningun navegador.
 *
 * Defecto que cubre: el reductor nativo de `createImageBitmap` de WebKit (iPhone/iPad) no filtra al reducir mucho: un patron
 * de lineas de 2 px conservaba 0,8-0,9 del contraste (Chromium ~0,05) y una panoramica a 0,25x bajaba de 40 a 36 dB, con
 * dientes y halos al ampliar. Ahora la reduccion es por pasos de mitad exacta.
 *
 * Fotos sinteticas (ninguna real): una carta de barras de 8064 x 6048 (48 Mpx) y una panoramica de 12000 x 3200 con textura fina.
 */

test.use({ locale: "es-ES" });

const DIR = path.resolve(process.cwd(), ".evidence", "img-reduce-tmp");
const CHART_W = 8064;
const CHART_H = 6048;
/** Periodos (px del original) de las bandas de barras verticales; cada banda mide 700 x 140 px. */
const PERIODS = [2, 3, 4, 6, 8, 12, 16, 24];
const BAND = { x: 120, width: 700, height: 140, step: 190, top: 120 };

/**
 * Contra el promedio de area (referencia sin aliasing). Medido: Chromium 35,0 dB / SSIM 0,982; WebKit antes del arreglo 27,9 dB /
 * 0,854; WebKit despues 31,0 dB / 0,895 (la diferencia que queda frente a Chromium es del codificador JPEG de WebKit con lineas
 * finas muy contrastadas, no de la reduccion). Los topes separan el WebKit viejo del nuevo con margen para ambos lados.
 */
const PANO_MIN_PSNR = 29.5;
const PANO_MIN_SSIM = 0.87;

let chartPath = "";
let panoPath = "";
let chartPixels: Uint8ClampedArray;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const chart = createCanvas(CHART_W, CHART_H);
  const context = chart.getContext("2d");
  context.fillStyle = "#808080";
  context.fillRect(0, 0, CHART_W, CHART_H);
  PERIODS.forEach((period, index) => {
    const y = BAND.top + index * BAND.step;
    context.fillStyle = "#d7d7d7";
    context.fillRect(BAND.x, y, BAND.width, BAND.height);
    context.fillStyle = "#282828";
    for (let x = 0; x < BAND.width; x += period) context.fillRect(BAND.x + x, y, Math.max(1, period / 2), BAND.height);
  });
  chartPath = path.join(DIR, "carta-48mp.jpg");
  writeFileSync(chartPath, chart.toBuffer("image/jpeg", 95));
  chartPixels = context.getImageData(0, 0, CHART_W, CHART_H).data;
  panoPath = path.join(DIR, "panoramica-12000.jpg");
  // Panoramica con textura y, encima, juntas de mortero de 1-2 px (lo primero que el aliasing destroza al reducir 4x).
  const pano = drawSyntheticPhoto({ width: 12000, height: 3200, seed: 41, grain: 2, texture: 30 });
  const lines = pano.getContext("2d");
  lines.fillStyle = "rgba(235,235,235,0.55)";
  for (let x = 0; x < 12000; x += 23) lines.fillRect(x, 0, 1, 3200);
  for (let y = 0; y < 3200; y += 17) lines.fillRect(0, y, 12000, 2);
  writeFileSync(panoPath, pano.toBuffer("image/jpeg", 92));
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));

async function embedOne(page: import("@playwright/test").Page, file: string, quality: "Equilibrada" | "Compacta" | "Alta") {
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles([file]);
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: quality, exact: true }).click();
  await runButton(page).click();
  const download = page.getByRole("button", { name: "Descargar", exact: true });
  await expect(download).toBeVisible({ timeout: 120_000 });
  const { bytes } = await downloadFile(page, () => download.click());
  const images = await embeddedImages(bytes);
  expect(images).toHaveLength(1);
  return images[0];
}

/** Amplitud (p95 - p5) del perfil horizontal medio de una banda, dividida por la del original. */
function bandAmplitude(rgba: Uint8ClampedArray, width: number, scale: number, bandIndex: number): number {
  const x0 = Math.round((BAND.x + 20) * scale);
  const columns = Math.round((BAND.width - 40) * scale);
  const y0 = Math.round((BAND.top + bandIndex * BAND.step + 20) * scale);
  const rows = Math.max(1, Math.round((BAND.height - 40) * scale));
  const profile: number[] = [];
  for (let x = 0; x < columns; x += 1) {
    let sum = 0;
    for (let y = 0; y < rows; y += 1) {
      const at = ((y0 + y) * width + (x0 + x)) * 4;
      sum += 0.299 * rgba[at] + 0.587 * rgba[at + 1] + 0.114 * rgba[at + 2];
    }
    profile.push(sum / rows);
  }
  const sorted = [...profile].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)];
}

for (const quality of ["Equilibrada", "Compacta"] as const) {
  test(`48 Mpx con «${quality}»: el patron de 2 px no sobrevive como aliasing y las lineas anchas se conservan`, async ({ page }) => {
    test.setTimeout(240_000);
    const image = await embedOne(page, chartPath, quality);
    const decoded = await loadImage(Buffer.from(image.bytes));
    const canvas = createCanvas(decoded.width, decoded.height);
    const context = canvas.getContext("2d");
    context.drawImage(decoded, 0, 0);
    const pixels = context.getImageData(0, 0, decoded.width, decoded.height).data;
    const scale = decoded.width / CHART_W;
    const retention = PERIODS.map((_, index) => bandAmplitude(pixels, decoded.width, scale, index) / bandAmplitude(chartPixels, CHART_W, 1, index));
    test.info().annotations.push({ type: "retencion", description: retention.map((value, index) => `${PERIODS[index]}px:${value.toFixed(2)}`).join(" ") });
    // 2 px nativos (menos de 1 px tras reducir): no debe quedar contraste (aliasing). Chromium ~0,05; WebKit antes ~0,8.
    expect(retention[0], `contraste del patron de 2 px (${retention[0].toFixed(2)})`).toBeLessThan(0.15);
    // Detalle realmente resoluble (12-24 px nativos): se conserva casi entero, sin emborronar ni sobrepasar.
    for (const index of [5, 6, 7]) expect(retention[index], `banda de ${PERIODS[index]} px`).toBeGreaterThan(0.85);
    for (const index of [5, 6, 7]) expect(retention[index], `banda de ${PERIODS[index]} px`).toBeLessThan(1.35);
  });
}

test("panoramica de 12000 x 3200 con juntas finas y «Equilibrada»: PSNR y SSIM frente a la original reducida", async ({ page }) => {
  test.setTimeout(240_000);
  const image = await embedOne(page, panoPath, "Equilibrada");
  expect(Math.max(image.width, image.height)).toBe(3000);
  const { readFileSync } = await import("node:fs");
  const measured = await qualityAgainstAreaReference(image.bytes, readFileSync(panoPath));
  test.info().annotations.push({ type: "calidad", description: `${measured.width}x${measured.height} PSNR ${measured.psnr.toFixed(2)} dB SSIM ${measured.ssim.toFixed(4)}` });
  expect(measured.psnr).toBeGreaterThanOrEqual(PANO_MIN_PSNR);
  expect(measured.ssim).toBeGreaterThanOrEqual(PANO_MIN_SSIM);
});
