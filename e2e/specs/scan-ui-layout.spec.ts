import { test, type Page } from "@playwright/test";
import { expect, importPhotos, installScanFakes, scanFiles, waitIdle, TEST_TIMEOUT } from "../helpers/scan-ui";

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
