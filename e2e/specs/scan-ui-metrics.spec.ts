import { test, type Page } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount } from "../helpers/pdf-inspection";
import { cdpOf, isChromium } from "../helpers/touch-gestures";
import { docFiles, docFilesOnDisk, expect, fakeControls, FAKE_ONLY_REASON, importPhotos, installFakeCamera, installScanFakes, pageIds, USE_REAL_ENGINE, waitIdle, waitVideoReady, TEST_TIMEOUT, webkitLinuxCamera, WEBKIT_LINUX_CAMERA_REASON } from "../helpers/scan-ui";

/**
 * Escaner · metricas de ergonomia y rendimiento (se IMPRIMEN en el informe y se acotan con holguras):
 *   - toques de «abrir -> 10 paginas -> PDF» con captura automatica (objetivo <= 14) y tiempo (objetivo <= 60 s);
 *   - toques de «reordenar una pagina» (arrastrar, teclado, «Mover aqui»);
 *   - captura -> miniatura (< 300 ms percibidos) y pico de memoria de JS con 100 paginas (< 400 MB).
 */
test.use({ locale: "es-ES", viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page }) => {
  await installScanFakes(page, { controls: { autoAfterMs: 500 } });
  await installFakeCamera(page);
  await page.addInitScript(() => {
    (window as unknown as { __taps: number }).__taps = 0;
    window.addEventListener("pointerdown", () => ((window as unknown as { __taps: number }).__taps += 1), true);
  });
});

const taps = (page: Page) => page.evaluate(() => (window as unknown as { __taps: number }).__taps);
const slack = process.env.CI ? 2.5 : 1;

test("abrir -> 10 paginas con captura automatica -> PDF: toques y tiempo", async ({ page, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  const started = Date.now();
  await page.goto("/scan-to-pdf");
  const afterLoad = Date.now();
  await page.evaluate(() => ((window as unknown as { __taps: number }).__taps = 0));
  await page.getByRole("button", { name: "Activar cámara" }).tap();
  await waitVideoReady(page);
  // Diez paginas: el motor da luz verde, se captura sola; entre pagina y pagina el documento «cambia» (deja de estar estable).
  for (let n = 1; n <= 10; n += 1) {
    await fakeControls(page, (c) => (c.verdict = { hint: "ok", stable: true, stableMs: 1000, shouldAutoCapture: true }));
    await expect(page.locator("[data-camera-count]")).toHaveText(n === 1 ? "1 página" : `${n} páginas`, { timeout: 10_000 });
    await fakeControls(page, (c) => (c.verdict = { hint: "hold_steady", stable: false, stableMs: 0, shouldAutoCapture: false }));
    await page.waitForTimeout(1300);
  }
  await page.getByRole("button", { name: /Revisar \(10\)/ }).tap();
  await waitIdle(page, 60_000);
  await page.getByRole("button", { name: /Guardar PDF \(10\)/ }).tap();
  await page.locator('[data-save-action="create"]').tap();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download/i }).first().tap();
  });
  expect(await getPageCount(bytes)).toBe(10);
  const total = taps(page);
  const count = await total;
  const elapsed = Date.now() - afterLoad;
  test.info().annotations.push({ type: "metrica", description: `abrir->10 paginas->PDF con captura automatica: ${count} toques, ${(elapsed / 1000).toFixed(1)} s (de ellos ~13 s son la espera deliberada de 1,3 s entre paginas)` });
  console.log(`METRICA toques abrir->10 paginas->PDF (auto): ${count}; tiempo: ${(elapsed / 1000).toFixed(1)} s; carga: ${afterLoad - started} ms`);
  expect(count).toBeLessThanOrEqual(14);
  expect(elapsed).toBeLessThan(60_000 * slack);
});

test("mismo recorrido con disparador manual: toques", async ({ page, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  await page.goto("/scan-to-pdf");
  await page.evaluate(() => ((window as unknown as { __taps: number }).__taps = 0));
  await page.getByRole("button", { name: "Activar cámara" }).tap();
  await waitVideoReady(page);
  await page.locator('[data-camera-action="auto"]').tap();
  for (let n = 1; n <= 10; n += 1) await page.getByRole("button", { name: "Capturar página" }).tap();
  await page.getByRole("button", { name: /Revisar \(10\)/ }).tap();
  await waitIdle(page, 60_000);
  await page.getByRole("button", { name: /Guardar PDF \(10\)/ }).tap();
  await page.locator('[data-save-action="create"]').tap();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /descargar|download/i }).first().tap().catch(() => undefined);
  const count = await taps(page);
  test.info().annotations.push({ type: "metrica", description: `abrir->10 paginas->PDF con disparador manual: ${count} toques` });
  console.log(`METRICA toques abrir->10 paginas->PDF (manual): ${count}`);
});

test("reordenar una pagina: toques", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, docFiles(6, { width: 360, height: 480 }));
  await waitIdle(page);
  const ids = await pageIds(page);
  // Arrastre: UN gesto (un solo pointerdown).
  await page.evaluate(() => ((window as unknown as { __taps: number }).__taps = 0));
  const handle = (await page.locator('[data-page-index="0"] [data-drag-handle]').boundingBox())!;
  const target = (await page.locator('[data-page-index="1"]').boundingBox())!;
  if (isChromium(page)) {
    const cdp = await cdpOf(page);
    const { touchDrag } = await import("../helpers/touch-gestures");
    await touchDrag(cdp, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: target.x + target.width * 0.8, y: target.y + target.height / 2 }, { steps: 10 });
    await expect.poll(() => pageIds(page)).toEqual([ids[1], ids[0], ids[2], ids[3], ids[4], ids[5]]);
    test.info().annotations.push({ type: "metrica", description: `reordenar arrastrando el asa: ${await taps(page)} gesto` });
    console.log(`METRICA reordenar arrastrando: ${await taps(page)} gesto (pointerdown)`);
  }
  // «Mover aqui»: mas, mover, destino.
  await page.evaluate(() => ((window as unknown as { __taps: number }).__taps = 0));
  await page.getByRole("button", { name: "Más acciones de la página 1" }).tap();
  await page.locator('[data-more-action="move"]').tap();
  await page.locator("[data-move-end]").tap();
  const mover = await taps(page);
  console.log(`METRICA reordenar con «Mover aqui»: ${mover} toques`);
  test.info().annotations.push({ type: "metrica", description: `reordenar con «Mover aqui»: ${mover} toques` });
  expect(mover).toBeLessThanOrEqual(3);
});

test("captura -> miniatura y memoria con 100 paginas", async ({ page }) => {
  test.skip(!isChromium(page), "las metricas de memoria usan CDP (solo Chromium)");
  await page.goto("/scan-to-pdf");
  await page.getByRole("button", { name: "Activar cámara" }).tap();
  await waitVideoReady(page);
  await page.locator('[data-camera-action="auto"]').tap();
  // Captura -> miniatura: del toque a que la miniatura de la ultima pagina esta pintada.
  const timing = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('[data-camera-action="capture"]')!;
    const start = performance.now();
    button.click();
    for (;;) {
      const img = document.querySelector<HTMLImageElement>("[data-camera-last]");
      if (img && img.complete && img.naturalWidth > 0) return performance.now() - start;
      if (performance.now() - start > 5000) return -1;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  console.log(`METRICA captura -> miniatura: ${timing.toFixed(0)} ms`);
  test.info().annotations.push({ type: "metrica", description: `captura -> miniatura: ${timing.toFixed(0)} ms` });
  expect(timing).toBeGreaterThan(0);
  expect(timing).toBeLessThan(300 * slack);
  await page.locator('[data-camera-action="close"]').tap();

  const cdp = await cdpOf(page);
  await cdp.send("Performance.enable");
  const heap = async () => {
    const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
    return (metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0) / (1024 * 1024);
  };
  let peak = await heap();
  const disk = docFilesOnDisk("memoria", 100, { width: 1200, height: 1600 });
  await page.locator('input[data-scan-input="library"]').setInputFiles(disk.paths);
  for (let i = 0; i < 40; i += 1) {
    peak = Math.max(peak, await heap());
    const done = await page.evaluate(() => document.querySelectorAll("[data-tile-processing]").length === 0 && document.querySelectorAll("[data-pending]").length === 0);
    if (done) break;
    await page.waitForTimeout(500);
  }
  await waitIdle(page, 120_000);
  for (let step = 0; step < 14; step += 1) {
    await page.evaluate(() => document.querySelector("[data-shell-scroll]")?.scrollBy(0, 1500));
    await page.waitForTimeout(80);
    peak = Math.max(peak, await heap());
  }
  disk.cleanup();
  console.log(`METRICA pico de memoria JS con 100 paginas de 1200x1600: ${peak.toFixed(0)} MB`);
  test.info().annotations.push({ type: "metrica", description: `pico de memoria JS (100 paginas 1200x1600): ${peak.toFixed(0)} MB` });
  expect(peak).toBeLessThan(400);
});
