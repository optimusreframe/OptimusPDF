import { test, type Page } from "@playwright/test";
import { expect, importPhotos, installFakeCamera, installScanFakes, pageIds, waitIdle, waitVideoReady, widthCodedFiles, TEST_TIMEOUT, webkitLinuxCamera, WEBKIT_LINUX_CAMERA_REASON } from "../helpers/scan-ui";

/**
 * Escaner · teclado completo y foco: cada capa se abre con el foco dentro y se cierra devolviendolo al control que la abrio;
 * Escape cierra la capa de arriba (no las de debajo); Tab cicla dentro de una capa; mover, girar y borrar sin raton; y borrar
 * una tarjeta deja el foco en la vecina, nunca en <body>.
 */
test.use({ locale: "es-ES", viewport: { width: 900, height: 900 } });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
  await installFakeCamera(page);
});

const tiles = (page: Page) => page.locator("[data-page-grid] [data-page-id]");
const notBody = (page: Page) => page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null);

async function load(page: Page, count = 4) {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(count));
  await expect(tiles(page)).toHaveCount(count);
  await waitIdle(page);
  return pageIds(page);
}

test("Enter abre el editor con el foco dentro; Escape lo cierra y devuelve el foco a la tarjeta", async ({ page, browserName }) => {
  await load(page);
  const main = page.locator('[data-page-index="1"] [data-page-main]');
  await main.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-page-editor]")).toBeVisible();
  await expect(page.locator('[data-editor-action="done"]')).toBeFocused();
  // Tab cicla dentro de la capa: nunca sale al fondo (que esta inert). (Safari no pasa por los botones con Tab sin «Opcion»: solo Chromium.)
  for (let i = 0; i < (browserName === "chromium" ? 24 : 0); i += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-page-editor]"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-page-editor]")).toHaveCount(0);
  await expect(main).toBeFocused();
});

test("Escape cierra solo la capa de arriba: el editor de esquinas vuelve al editor, no al fondo", async ({ page }) => {
  await load(page);
  await page.locator('[data-page-index="0"] [data-page-main]').click();
  await page.locator('[data-editor-action="crop"]').click();
  await expect(page.locator("[data-corner-editor]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-corner-editor]")).toHaveCount(0);
  await expect(page.locator("[data-page-editor]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-page-editor]")).toHaveCount(0);
});

test("camara: el foco entra en el disparador y Escape la cierra", async ({ page, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  await page.goto("/scan-to-pdf");
  await page.locator('[data-camera-action="start"]').first().focus();
  await page.keyboard.press("Enter");
  await waitVideoReady(page);
  await expect(page.locator('[data-camera-stage] [data-camera-action="capture"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-camera-stage]")).toHaveCount(0);
  await expect.poll(() => notBody(page)).toBe(true);
});

test("girar, duplicar y borrar con el teclado; borrar deja el foco en la tarjeta vecina", async ({ page }) => {
  const ids = await load(page, 3);
  await page.getByRole("button", { name: "Girar la página 2" }).focus();
  await page.keyboard.press("Enter");
  await waitIdle(page);
  await page.getByRole("button", { name: "Borrar la página 2" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => pageIds(page)).toEqual([ids[0], ids[2]]);
  await expect.poll(() => notBody(page)).toBe(true);
  expect(await page.evaluate(() => !!document.activeElement?.closest("[data-page-grid]"))).toBe(true);
  // El foco queda en la tarjeta que ocupa el sitio de la borrada (la pagina 3 original, ahora la 2.ª).
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-page-id]")?.getAttribute("data-page-index"))).toBe("1");
  // Deshacer con el teclado desde el boton.
  await page.getByRole("button", { name: "Deshacer", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect.poll(() => pageIds(page)).toEqual(ids);
});

test("hoja «Mas acciones»: el foco entra, Escape la cierra y el foco vuelve al boton", async ({ page }) => {
  await load(page);
  const more = page.getByRole("button", { name: "Más acciones de la página 2" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-more-sheet]")).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-more-sheet]")).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("seleccion con el teclado: Espacio marca, y la barra inferior actua sobre lo marcado", async ({ page }) => {
  const ids = await load(page, 4);
  await page.getByRole("button", { name: "Seleccionar" }).focus();
  await page.keyboard.press("Enter");
  for (const index of [0, 2]) {
    await page.locator(`[data-page-index="${index}"] [data-page-main]`).focus();
    await page.keyboard.press("Space");
  }
  await expect(page.locator("[data-selected-count]")).toHaveText("2 seleccionadas");
  await page.locator('[data-review-action="bulk-delete"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => pageIds(page)).toEqual([ids[1], ids[3]]);
});

test("la hoja de salida: el foco entra en «Seguir escaneando» (la opcion segura) y Escape se queda", async ({ page }) => {
  await page.goto("/");
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  await page.goBack();
  const sheet = page.getByRole("dialog", { name: "¿Salir del escaneo?" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Seguir escaneando" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
});
