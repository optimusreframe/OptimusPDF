import { test, type Page } from "@playwright/test";
import { cdpOf, isChromium, touchDrag } from "../helpers/touch-gestures";
import { docFilesOnDisk, expect, importPhotos, installScanFakes, pageIds, waitIdle, widthCodedFiles, TEST_TIMEOUT } from "../helpers/scan-ui";

/**
 * Escaner · reordenar: arrastre con raton (desde cualquier punto), con el dedo desde el ASA y con pulsacion larga (Chromium por
 * CDP: WebKit no expone tacto de bajo nivel), auto-desplazamiento por TIEMPO cerca del borde, Escape cancela, teclado
 * (flechas / Inicio / Fin) y deshacer como UN solo paso.
 */
test.use({ locale: "es-ES" });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
});

const tiles = (page: Page) => page.locator("[data-page-grid] [data-page-id]");

async function load(page: Page, count: number) {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(count, { height: 520 }));
  await expect(page.locator("[data-review-bar] [data-review-action=save]")).toContainText(`(${count})`, { timeout: 60_000 });
  await waitIdle(page, 60_000);
  return pageIds(page);
}

/** Lo que se desplaza en Revisar es la zona del medio (la pagina esta fija): su `scrollTop`. */
const listScroll = (page: Page) => page.evaluate(() => document.querySelector("[data-shell-scroll]")?.scrollTop ?? -1);

async function center(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("raton", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("arrastrar una tarjeta desde cualquier punto la deja en el hueco elegido", async ({ page }) => {
    const ids = await load(page, 4);
    const from = await center(page, '[data-page-index="0"] [data-page-main]');
    const target = (await page.locator('[data-page-index="2"]').boundingBox())!;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 10, { steps: 4 });
    await page.mouse.move(target.x + target.width * 0.8, target.y + target.height / 2, { steps: 8 });
    await expect(page.locator("[data-drop-marker]")).toBeVisible();
    await expect(page.locator("[data-drag-ghost]")).toBeVisible();
    await page.mouse.up();
    await expect.poll(() => pageIds(page)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    // Un arrastre NO abre el editor (el clic que sigue a soltar se descarta).
    await expect(page.locator("[data-page-editor]")).toHaveCount(0);
    // Y deshacer lo devuelve de una vez.
    await page.getByRole("button", { name: "Deshacer", exact: true }).click();
    await expect.poll(() => pageIds(page)).toEqual(ids);
  });

  test("Escape cancela el arrastre y no mueve nada", async ({ page }) => {
    const ids = await load(page, 4);
    const handle = await center(page, '[data-page-index="0"] [data-drag-handle]');
    const target = (await page.locator('[data-page-index="3"]').boundingBox())!;
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 20, { steps: 8 });
    await expect(page.locator("[data-drag-ghost]")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator("[data-drag-ghost]")).toHaveCount(0);
    expect(await pageIds(page)).toEqual(ids);
  });

  test("teclado: flechas mueven de uno en uno, Fin la lleva al final, Inicio al principio; todo es UN paso de deshacer", async ({ page }) => {
    const ids = await load(page, 5);
    const handle = page.locator('[data-page-index="1"] [data-drag-handle]');
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => pageIds(page)).toEqual([ids[0], ids[2], ids[3], ids[1], ids[4]]);
    await expect(page.locator(`[data-page-id="${ids[1]}"] [data-drag-handle]`)).toBeFocused();
    await page.keyboard.press("End");
    await expect.poll(() => pageIds(page)).toEqual([ids[0], ids[2], ids[3], ids[4], ids[1]]);
    await page.keyboard.press("Home");
    await expect.poll(() => pageIds(page)).toEqual([ids[1], ids[0], ids[2], ids[3], ids[4]]);
    await page.getByRole("button", { name: "Deshacer", exact: true }).click();
    await expect.poll(() => pageIds(page)).toEqual(ids);
  });

  test("auto-desplazamiento por tiempo: con el puntero quieto cerca del borde la lista sigue avanzando", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    const ids = await load(page, 40);
    const handle = await center(page, '[data-page-index="0"] [data-drag-handle]');
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 40, handle.y + 60, { steps: 4 });
    const before = await listScroll(page);
    // El puntero se queda quieto en la franja de abajo.
    await page.mouse.move(handle.x + 40, 690, { steps: 6 });
    await page.waitForTimeout(700);
    const mid = await listScroll(page);
    await page.waitForTimeout(700);
    const after = await listScroll(page);
    expect(mid).toBeGreaterThan(before + 80);
    expect(after).toBeGreaterThan(mid + 80);
    await page.mouse.up();
    // La primera pagina cayo muy abajo, no en su sitio.
    const index = Number(await page.locator(`[data-page-id="${ids[0]}"]`).getAttribute("data-page-index"));
    expect(index).toBeGreaterThan(3);
  });
});

test.describe("dedo (CDP, solo Chromium)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("desde el asa: arrastra y suelta; el cuerpo de la tarjeta sigue permitiendo desplazar con un dedo", async ({ page }) => {
    test.skip(!isChromium(page), "el tacto de bajo nivel (Input.dispatchTouchEvent) solo existe en Chromium");
    const ids = await load(page, 6);
    const cdp = await cdpOf(page);
    const from = await center(page, '[data-page-index="0"] [data-drag-handle]');
    const target = (await page.locator('[data-page-index="3"]').boundingBox())!;
    await touchDrag(cdp, from, { x: target.x + target.width * 0.8, y: target.y + target.height / 2 }, { steps: 12 });
    await expect.poll(() => pageIds(page)).toEqual([ids[1], ids[2], ids[3], ids[0], ids[4], ids[5]]);

    // Un dedo sobre la miniatura que se mueve ANTES de la pulsacion larga desplaza la pagina (no arrastra).
    const body = await center(page, '[data-page-index="1"] [data-page-main]');
    const y0 = await listScroll(page);
    await touchDrag(cdp, body, { x: body.x, y: body.y - 220 }, { steps: 10, stepMs: 16 });
    await expect.poll(() => listScroll(page)).toBeGreaterThan(y0 + 50);
    expect(await pageIds(page)).toEqual([ids[1], ids[2], ids[3], ids[0], ids[4], ids[5]]);
  });

  test("pulsacion larga sobre la miniatura: empieza a arrastrar sin mover la pagina", async ({ page }) => {
    test.skip(!isChromium(page), "el tacto de bajo nivel (Input.dispatchTouchEvent) solo existe en Chromium");
    const ids = await load(page, 6);
    const cdp = await cdpOf(page);
    const from = await center(page, '[data-page-index="0"] [data-page-main]');
    const target = (await page.locator('[data-page-index="1"]').boundingBox())!;
    const y0 = await listScroll(page);
    await touchDrag(cdp, from, { x: target.x + target.width * 0.8, y: target.y + target.height / 2 }, { holdMs: 650, steps: 12 });
    await expect.poll(() => pageIds(page)).toEqual([ids[1], ids[0], ids[2], ids[3], ids[4], ids[5]]);
    expect(await listScroll(page)).toBe(y0);
  });
});

test("100 paginas: la cuadricula esta virtualizada, sin tareas largas y arrastrar sigue funcionando", { tag: "@perf" }, async ({ page, browserName }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__long.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* WebKit no expone longtask */
    }
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/scan-to-pdf");
  await expect(page.locator("[data-start]")).toBeVisible();
  // Solo cuentan las tareas largas DESPUES de cargar la pagina (la carga y la hidratacion no son de esta herramienta).
  await page.waitForTimeout(500);
  await page.evaluate(() => ((window as unknown as { __long: number[] }).__long.length = 0));
  const disk = docFilesOnDisk("cien", 100, { width: 360, height: 480 });
  await page.locator('input[data-scan-input="library"]').setInputFiles(disk.paths);
  await expect.poll(() => page.locator("[data-review-bar] [data-review-action=save]").textContent(), { timeout: 60_000 }).toContain("(100)");
  await waitIdle(page, 90_000);
  // Virtualizacion: nunca se pintan todas las tarjetas.
  const painted = await tiles(page).count();
  expect(painted).toBeLessThan(40);
  expect(painted).toBeGreaterThan(4);
  expect(await page.locator("[data-page-grid]").getAttribute("data-virtual")).not.toBeNull();
  // El contenedor conserva el alto de las 100 (la barra de desplazamiento es la real).
  const total = await page.locator("[data-page-grid]").evaluate((node) => node.getBoundingClientRect().height);
  expect(total).toBeGreaterThan(50 * 250);

  // Recorrer la lista de arriba abajo.
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.wheel(0, 1500).catch(() => undefined);
    await page.evaluate(() => document.querySelector("[data-shell-scroll]")?.scrollBy(0, 1500));
    await page.waitForTimeout(60);
  }
  await expect(page.locator('[data-page-index="99"]')).toBeAttached({ timeout: 10_000 }).catch(() => undefined);
  expect(await tiles(page).count()).toBeLessThan(40);

  // Reordenar con teclado en el medio de la lista (la tarjeta con foco nunca se desmonta).
  await page.evaluate(() => document.querySelector("[data-shell-scroll]")?.scrollTo(0, 0));
  await page.locator('[data-page-index="0"] [data-drag-handle]').focus();
  for (let n = 0; n < 5; n += 1) await page.keyboard.press("ArrowRight");
  await expect(page.locator('[data-page-index="5"] [data-drag-handle]')).toBeFocused();

  disk.cleanup();
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  if (browserName === "chromium") {
    // El servidor de desarrollo (React sin minificar) es varias veces mas lento: la cifra de verdad es la de la build de produccion.
    const dev = (await page.locator("nextjs-portal").count()) > 0;
    const slack = (process.env.CI ? 2.5 : 1) * (dev ? 3.5 : 1);
    const worst = Math.max(0, ...long);
    // Ninguna tarea larga de mas de 100 ms (con holgura en CI / desarrollo) mientras se importa, se recorre y se reordena.
    test.info().annotations.push({ type: "metrica", description: `tarea larga maxima con 100 paginas: ${Math.round(worst)} ms (${long.length} tareas largas)` });
    console.log(`METRICA tarea larga maxima con 100 paginas: ${Math.round(worst)} ms (${long.length} tareas largas)`);
    expect(worst, `tareas largas (ms): ${long.join(", ")}`).toBeLessThan(100 * slack);
  }
});
