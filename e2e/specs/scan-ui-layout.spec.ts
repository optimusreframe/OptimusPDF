import { test, type Page } from "@playwright/test";
import { docFilesOnDisk, expect, FAKE_ONLY_REASON, importPhotos, installScanFakes, scanFiles, USE_REAL_ENGINE, waitIdle, TEST_TIMEOUT } from "../helpers/scan-ui";

/**
 * Escaner · maquetacion de los pasos Revisar y Guardar en el movil (defectos medidos con el motor REAL):
 *   - «Guardar PDF» abre el paso DESDE ARRIBA: titulo, nombre y «Crear PDF» a la vista, foco en el titulo, la pagina sin desplazar;
 *   - la barra de acciones queda ANCLADA abajo (misma posicion con la lista arriba y al final), dentro de la ventana, sin tapar
 *     contenido, a 375x667, 393x852 y 320x568, tambien con la letra al 150 %;
 *   - con la letra al 150 % a 320 px: nada de esta herramienta se sale por los lados, el boton principal no se infla y los botones
 *     de cada hoja miden 44 px.
 * Corre igual con el motor falso y con el real (`SCAN_REAL=1`).
 */
test.use({ locale: "es-ES", hasTouch: true, isMobile: true });
test.setTimeout(TEST_TIMEOUT);

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 393, height: 852 },
  { width: 320, height: 568 },
] as const;

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
});

async function review(page: Page, count = 8) {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, scanFiles(Array.from({ length: count }, (_, index) => `p${index + 1}.jpg`)));
  await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(count, { timeout: 60_000 });
  await waitIdle(page, 90_000);
  await expect(page.locator('[data-review-action="save"]')).toBeEnabled();
}

const toEnd = (page: Page) => page.locator("[data-shell-scroll]").evaluate((node) => node.scrollTo(0, node.scrollHeight));

async function inWindow(page: Page, selector: string): Promise<{ top: number; bottom: number; height: number; inside: boolean } | null> {
  return page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height), inside: box.top >= -0.5 && box.bottom <= window.innerHeight + 0.5 };
  }, selector);
}

for (const vp of VIEWPORTS) {
  test(`«Guardar PDF» abre el paso desde arriba, con titulo, nombre y «Crear PDF» a la vista · ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await review(page);
    await toEnd(page);
    await page.locator('[data-review-action="save"]').click();
    await expect(page.locator("[data-save-screen]")).toBeVisible();
    await expect(page.locator("[data-view-heading]")).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const heading = await inWindow(page, "[data-view-heading]");
    expect(heading?.inside, `titulo ${JSON.stringify(heading)}`).toBe(true);
    const name = await inWindow(page, "#scan-name");
    expect(name?.inside, `nombre ${JSON.stringify(name)}`).toBe(true);
    const create = await inWindow(page, '[data-save-action="create"]');
    expect(create?.inside, `crear ${JSON.stringify(create)}`).toBe(true);
    // Y volver a Revisar tambien abre desde arriba.
    await page.locator('[data-save-action="back"]').click();
    await expect(page.locator("[data-review]")).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect((await inWindow(page, "[data-view-heading]"))?.inside).toBe(true);
  });

  for (const fontScale of [100, 150] as const) {
    test(`la barra «Guardar PDF» queda anclada abajo, dentro de la ventana y sin tapar la lista · ${vp.width}x${vp.height} · letra ${fontScale} %`, async ({ page }) => {
      await page.setViewportSize(vp);
      if (fontScale !== 100) await page.addInitScript((scale) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(`html { font-size: ${scale}% !important; }`);
        document.adoptedStyleSheets = [sheet];
      }, fontScale);
      await review(page);
      const bar = '[data-review-bar]';
      const save = '[data-review-action="save"]';
      const top = { bar: await inWindow(page, bar), save: await inWindow(page, save) };
      await toEnd(page);
      await page.waitForTimeout(200);
      const end = { bar: await inWindow(page, bar), save: await inWindow(page, save) };
      // Anclada: ni se despega al llegar al final ni sale de la ventana (un pulgar siempre la alcanza).
      expect(end.bar?.bottom, "la barra no se mueve al desplazar la lista").toBe(top.bar?.bottom);
      expect(end.bar?.top).toBe(top.bar?.top);
      expect(end.save?.inside, `boton ${JSON.stringify(end.save)}`).toBe(true);
      expect(end.bar?.inside, `barra ${JSON.stringify(end.bar)}`).toBe(true);
      // No tapa la lista: la zona con desplazamiento acaba donde empieza la barra.
      const areaBottom = await page.locator("[data-shell-scroll]").evaluate((node) => Math.round(node.getBoundingClientRect().bottom));
      expect(areaBottom).toBeLessThanOrEqual(end.bar!.top + 1);
      // Cerca del pie de la ventana: por encima de la barra de pestañas del movil, sin dejar un hueco enorme.
      expect(end.bar!.bottom).toBeGreaterThan(vp.height - (fontScale === 150 ? 260 : 150));
      // La ultima hoja se puede ver entera encima de la barra.
      const lastBottom = await page.locator('[data-page-grid] [data-page-id]').last().evaluate((node) => Math.round(node.getBoundingClientRect().bottom));
      expect(lastBottom).toBeLessThanOrEqual(end.bar!.top + 1);
    });
  }
}

test("letra al 150 % a 320 px: nada se sale por los lados, el boton principal no se infla y los botones de cada hoja miden 44 px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("html { font-size: 150% !important; }");
    document.adoptedStyleSheets = [sheet];
  });
  await review(page, 4);
  const offenders = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const element of document.querySelectorAll("[data-screen-shell] *")) {
      const box = element.getBoundingClientRect();
      if (box.width < 1.5 || box.height < 1.5) continue;
      if (box.right > width + 1 || box.left < -1) out.push(`${element.tagName.toLowerCase()} ${String(element.getAttribute("class") ?? "").slice(0, 50)} ${Math.round(box.left)}..${Math.round(box.right)}`);
    }
    return out.slice(0, 6);
  });
  expect(offenders, offenders.join("\n")).toEqual([]);
  const save = await inWindow(page, '[data-review-action="save"]');
  // Antes: 84 px de ancho y de alto (altura fija en rem y el boton estrujado entre los iconos). Ahora tiene su propia linea: ancho
  // casi completo y el alto lo marca el texto (una o dos lineas segun la fuente).
  const saveWidth = await page.locator('[data-review-action="save"]').evaluate((node) => Math.round(node.getBoundingClientRect().width));
  expect(saveWidth, `ancho del boton principal`).toBeGreaterThanOrEqual(200);
  expect(save!.height, `boton principal ${JSON.stringify(save)}`).toBeLessThanOrEqual(110);
  const small = await page.locator("[data-page-grid] button").evaluateAll((nodes) =>
    nodes
      .filter((node) => !node.closest("[inert]"))
      .map((node) => ({ label: node.getAttribute("aria-label") ?? "", box: node.getBoundingClientRect() }))
      .filter((item) => item.box.width > 0 && (item.box.width < 43.9 || item.box.height < 43.9))
      .map((item) => `${item.label} ${item.box.width.toFixed(1)}x${item.box.height.toFixed(1)}`),
  );
  expect(small, small.join("\n")).toEqual([]);
});

test("crear el PDF con 40 hojas: el overlay responde, «Cancelar» tiene el foco, mide >= 44 px y cancela al instante (sin tareas largas de la interfaz)", async ({ page }) => {
  // Con el motor falso (retardo por hoja) se aisla lo que hace LA INTERFAZ durante la creacion; la cesion al hilo del motor real es del motor.
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  test.setTimeout(180_000);
  await installScanFakes(page, { controls: { buildDelayMs: 150 } });
  await page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__long.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* sin longtask */
    }
  });
  await page.goto("/scan-to-pdf");
  const disk = docFilesOnDisk("guardar40", 40, { width: 360, height: 480 });
  await page.locator('input[data-scan-input="library"]').setInputFiles(disk.paths);
  await expect(page.locator('[data-review-action="save"]')).toContainText("(40)", { timeout: 90_000 });
  await waitIdle(page, 90_000);
  disk.cleanup();
  await page.locator('[data-review-action="save"]').click();
  await expect(page.locator("[data-save-screen]")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __long: number[] }).__long.length = 0));
  await page.locator('[data-save-action="create"]').click();
  const overlay = page.locator("[data-processing-overlay]");
  await expect(overlay).toBeVisible();
  const cancel = overlay.getByRole("button", { name: /cancelar|cancel/i });
  await expect(cancel).toBeFocused();
  // La tarjeta «materializa» (escala 0,96 → 1): se mide cuando termina la animacion.
  await expect.poll(async () => (await cancel.boundingBox())!.height, { timeout: 5_000 }).toBeGreaterThanOrEqual(43.5);
  // El progreso avanza de verdad (no se queda en 0) mientras se crean las hojas.
  await expect.poll(() => overlay.getByRole("progressbar").first().getAttribute("aria-valuenow").then((value) => Number(value ?? 0)), { timeout: 20_000 }).toBeGreaterThan(5);
  const started = Date.now();
  await cancel.click();
  await expect(overlay).toHaveCount(0, { timeout: 3_000 });
  expect(Date.now() - started).toBeLessThan(3_000);
  await expect(page.locator("[data-save-error]")).toBeVisible();
  // La interfaz no bloqueo el hilo: ninguna tarea larga seria durante la creacion.
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  const slack = process.env.CI ? 2.5 : 1;
  expect(Math.max(0, ...long), `tareas largas (ms): ${long.join(", ")}`).toBeLessThan(250 * slack);
});
