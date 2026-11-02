import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, openTool, runButton, test } from "../helpers/tool-flow";
import { makePhotoSet, removePhotoSet, type PhotoSet } from "../helpers/photo-set";

/**
 * Imagenes a PDF · el hilo principal no se bloquea al elegir muchas fotos.
 *
 * Defecto que cubre: en WebKit (iPhone/iPad) las miniaturas se decodificaban en el hilo principal y, con 117 fotos, la pantalla
 * se congelaba 61 veces mas de 90 ms (maximo 386 ms; Chromium: 0); ademas, montar de golpe la lista, la rejilla y el panel de
 * opciones sumaba una tarea de 130-240 ms. Ahora las miniaturas y la comprobacion de cada foto van a un worker y el primer
 * pintado se reparte en tareas cortas.
 *
 * El hueco se mide con un temporizador de 25 ms (WebKit no tiene la API de tareas largas). Las fotos se ENTREGAN a la pagina
 * desde dentro (fetch + DataTransfer), no con `setInputFiles`: la inyeccion de archivos de Playwright bloquea la pagina por si
 * misma ~50 ms en WebKit y ensuciaria la medida. Fotos sinteticas: un tercio de 24 Mpx y el resto de 12 Mpx (la decodificacion de una foto de 24-48 Mpx es lo que bloqueaba).
 */

test.use({ locale: "es-ES" });

const CI = !!process.env.CI;
const SLACK = CI ? 2.5 : 1;
const PHOTOS = 117;

let set: PhotoSet;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  set = await makePhotoSet({ name: "thread117", count: PHOTOS, size: (index) => (index % 3 === 0 ? { width: 4284, height: 5712 } : { width: 4000, height: 3000 }), distinct: 6, quality: 88 });
});
test.afterAll(() => removePhotoSet(set));

async function installGapMonitor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { gaps: [] as Array<[number, number]>, armed: false, t0: 0 };
    (window as unknown as { __gaps: typeof state }).__gaps = state;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (state.armed && now - last - 25 > 40) state.gaps.push([Math.round(now - last - 25), Math.round(now - state.t0)]);
      last = now;
    }, 25);
  });
}

/** Entrega los archivos al `<input type=file>` desde la propia pagina (sin la inyeccion de Playwright) y arma el medidor justo antes. */
async function deliver(page: Page, paths: string[]): Promise<void> {
  await page.route("**/__photos/*", async (route) => {
    const index = Number(new URL(route.request().url()).pathname.split("/").pop());
    await route.fulfill({ path: paths[index], contentType: "image/jpeg" });
  });
  const origin = new URL(page.url()).origin;
  const blobs = await page.evaluate(
    async ([count, base]) => {
      const out: Blob[] = [];
      for (let index = 0; index < Number(count); index += 1) out.push(await (await fetch(`${String(base)}/__photos/${index}`)).blob());
      (window as unknown as { __blobs: Blob[] }).__blobs = out;
      return out.length;
    },
    [paths.length, origin] as const,
  );
  expect(blobs).toBe(paths.length);
  await page.evaluate((names) => {
    const w = window as unknown as { __blobs: Blob[]; __gaps: { armed: boolean; t0: number; gaps: unknown[] } };
    const transfer = new DataTransfer();
    w.__blobs.forEach((blob, index) => transfer.items.add(new File([blob], names[index], { type: "image/jpeg" })));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    w.__gaps.gaps.length = 0;
    w.__gaps.t0 = performance.now();
    w.__gaps.armed = true;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, paths.map((file) => path.basename(file)));
}

const gaps = (page: Page): Promise<Array<[number, number]>> =>
  page.evaluate(() => (window as unknown as { __gaps: { gaps: Array<[number, number]> } }).__gaps.gaps);

test(`${PHOTOS} fotos: ni el primer pintado ni las miniaturas bloquean el hilo principal mas de 100 ms`, { tag: "@perf" }, async ({ page }) => {
  test.setTimeout(420_000);
  await installGapMonitor(page);
  await openTool(page, "jpg-to-pdf");
  await deliver(page, set.paths);
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
  // Todas las miniaturas hechas (cada una es un <img> con alt «Imagen N»).
  await expect(page.getByAltText(/^Imagen \d+$/)).toHaveCount(PHOTOS, { timeout: 360_000 });
  const measured = await gaps(page);
  const worst = measured.reduce((max, [gap]) => Math.max(max, gap), 0);
  test.info().annotations.push({ type: "huecos-hilo-principal", description: `${measured.length} huecos > 40 ms, maximo ${worst} ms: ${JSON.stringify(measured.slice(0, 8))}` });
  expect(worst, `hueco mas largo del hilo principal (${JSON.stringify(measured.slice(0, 6))})`).toBeLessThan(100 * SLACK);
});

test("las miniaturas se hacen fuera del hilo principal: hay un worker de miniaturas y la lista entera aparece por trozos", async ({ page }) => {
  test.setTimeout(240_000);
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(set.paths.slice(0, 40));
  await expect(page.getByAltText(/^Imagen \d+$/)).toHaveCount(40, { timeout: 180_000 });
  expect(workers.length, "workers creados (miniaturas y/o preparacion)").toBeGreaterThan(0);
  // La lista de archivos completa (40 filas) acaba pintada aunque se vaya montando por trozos.
  await expect(page.locator("main li p[data-file-name]")).toHaveCount(40);
});

test("al procesar 40 fotos tampoco hay huecos de mas de 100 ms optimizando (y las miniaturas pendientes esperan)", async ({ page }) => {
  test.setTimeout(420_000);
  await installGapMonitor(page);
  await openTool(page, "jpg-to-pdf");
  await deliver(page, set.paths.slice(0, 40));
  await expect(page.getByAltText(/^Imagen \d+$/)).toHaveCount(40, { timeout: 240_000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const state = (window as unknown as { __gaps: { armed: boolean; t0: number; gaps: unknown[] } }).__gaps;
    state.gaps.length = 0;
    state.t0 = performance.now();
    state.armed = true;
  });
  await runButton(page).click();
  // Hasta empezar la ultima foto (guardar el PDF final es una sola operacion sincrona de pdf-lib, aparte).
  await expect(page.locator("[data-processing-overlay]")).toContainText(/foto 40 de 40/, { timeout: 300_000 });
  const optimizing = await gaps(page);
  const worst = optimizing.reduce((max, [gap]) => Math.max(max, gap), 0);
  test.info().annotations.push({ type: "huecos-optimizando", description: `${optimizing.length} huecos > 40 ms, maximo ${worst} ms` });
  expect(worst, `hueco mas largo optimizando (${JSON.stringify(optimizing.slice(0, 6))})`).toBeLessThan(100 * SLACK);
});
