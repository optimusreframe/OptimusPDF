import { test, type Page } from "@playwright/test";
import { expect, fakeControls, FAKE_ONLY_REASON, importPhotos, installFakeCamera, installScanFakes, pageIds, storeSummary, USE_REAL_ENGINE, waitIdle, widthCodedFiles, TEST_TIMEOUT } from "../helpers/scan-ui";

/**
 * Escaner · NUNCA perder trabajo: guardado automatico tras cada cambio, «Retomar escaneo» al volver (banner, `?scan=`,
 * `?resume=scan:`), «Empezar de nuevo» con confirmacion, aviso al salir (BACK, cierre) solo con algo que perder, cuota llena.
 * El almacen falso usa IndexedDB real del navegador (propio, NO el de produccion): sobrevive a la recarga.
 */
test.use({ locale: "es-ES" });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
  await installFakeCamera(page);
});

const tiles = (page: Page) => page.locator("[data-page-grid] [data-page-id]");
const status = (page: Page) => page.locator("[data-save-status]");

async function startScan(page: Page, count = 3) {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(count));
  await expect(tiles(page)).toHaveCount(count);
  await waitIdle(page);
  await expect(status(page)).toHaveText("Guardado ✓");
}

test("se guarda solo tras cada cambio y el estado «Guardado ✓» es visible", async ({ page }) => {
  await startScan(page, 3);
  const first = await storeSummary(page);
  expect(first).toHaveLength(1);
  expect(first[0].pageCount).toBe(3);
  // Un cambio de organizacion vuelve a guardar.
  await page.getByRole("button", { name: "Borrar la página 3" }).click();
  await expect.poll(async () => (await storeSummary(page))[0]?.pageCount).toBe(2);
  await expect(status(page)).toHaveText("Guardado ✓");
});

test("recarga con la sesion en la direccion: se restaura sola, con las paginas y en el mismo orden", async ({ page }) => {
  await startScan(page, 4);
  const ids = await pageIds(page);
  expect(page.url()).toContain("?scan=");
  await page.reload();
  await expect(tiles(page)).toHaveCount(4);
  await waitIdle(page);
  expect(await pageIds(page)).toEqual(ids);
});

test("al volver sin parametro: banner «Retomar escaneo» con miniatura y numero de paginas; Retomar restaura", async ({ page }) => {
  await startScan(page, 3);
  await page.goto("/scan-to-pdf");
  const banner = page.locator("[data-resume-banner]");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Tienes un escaneo sin terminar");
  await expect(banner).toContainText("3 páginas");
  await expect(banner.locator("img")).toBeVisible();
  await banner.getByRole("button", { name: "Retomar escaneo" }).click();
  await expect(tiles(page)).toHaveCount(3);
  // El foco queda en el encabezado del paso, nunca en <body>.
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
});

test("«Empezar de nuevo» pide confirmacion y borra la sesion guardada", async ({ page }) => {
  await startScan(page, 2);
  await page.goto("/scan-to-pdf");
  await page.locator('[data-resume-action="discard"]').click();
  await page.getByRole("button", { name: "Conservarlo" }).click();
  await expect(page.locator("[data-resume-banner]")).toBeVisible();
  expect(await storeSummary(page)).toHaveLength(1);
  await page.locator('[data-resume-action="discard"]').click();
  await page.getByRole("button", { name: "Borrar y empezar" }).click();
  await expect(page.locator("[data-resume-banner]")).toHaveCount(0);
  await expect.poll(async () => (await storeSummary(page)).length).toBe(0);
});

test("`?resume=scan:<id>` (enlace de Recientes) restaura; un id que no existe lo dice y limpia la direccion", async ({ page }) => {
  await startScan(page, 2);
  const id = (await storeSummary(page))[0].id;
  await page.goto(`/scan-to-pdf?resume=scan:${id}`);
  await expect(tiles(page)).toHaveCount(2);
  await page.goto("/scan-to-pdf?scan=no-existe-1234");
  await expect(page.locator("[data-resume-notice]")).toContainText("ya no está disponible");
  await expect.poll(() => page.url()).not.toContain("scan=");
  // Un valor con forma de ataque no restaura nada.
  await page.goto("/scan-to-pdf?scan=" + encodeURIComponent("../../etc/passwd"));
  await expect(page.locator("[data-start]")).toBeVisible();
  await expect.poll(() => page.url()).not.toContain("passwd");
});

test("BACK con paginas: pregunta antes de salir; «Seguir escaneando» se queda y «Salir» sale", async ({ page }) => {
  await page.goto("/");
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  await expect(status(page)).toHaveText("Guardado ✓");
  await page.goBack();
  const sheet = page.getByRole("dialog", { name: "¿Salir del escaneo?" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("está guardado en este dispositivo");
  await sheet.getByRole("button", { name: "Seguir escaneando" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
  // La entrada de historial vuelve a estar: el siguiente BACK vuelve a preguntar.
  await page.goBack();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Salir", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/");
});

test("cierre de pestaña: solo avisa si hay algo SIN guardar", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await startScan(page, 2);
  const blocked = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(await blocked()).toBe(false);
  // El almacen deja de poder guardar: lo hecho se pierde si se cierra -> avisa y el estado lo dice.
  await page.evaluate(() => {
    (globalThis as unknown as { __scanFake: { store: { controls: { unavailable: boolean } } } }).__scanFake.store.controls.unavailable = true;
  });
  await page.getByRole("button", { name: "Borrar la página 2" }).click();
  await expect(status(page)).toHaveText("No guardado: sin almacenamiento");
  await expect(page.locator('[data-banner="storage"]')).toBeVisible();
  expect(await blocked()).toBe(true);
  // Y la hoja de salida dice la verdad: no esta guardado.
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "¿Salir del escaneo?" })).toContainText("no está guardado");
});

test("cuota llena: avisa con un mensaje claro y se puede seguir creando el PDF", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installScanFakes(page, { store: { quotaBytes: 1 } });
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  await expect(status(page)).toHaveText("No guardado: no hay espacio");
  await expect(page.locator('[data-banner="storage"]')).toContainText("no hay espacio");
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
});

test("fotos que no se pueden anadir: el aviso las NOMBRA con su motivo (no es imagen / HEIC / danada), el plural es correcto y la buena se queda", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(200, 7)]);
  await importPhotos(page, [
    { name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("hola") },
    { name: "foto-fail.heic", mimeType: "image/heic", buffer: heic },
    { name: "roto-fail.jpg", mimeType: "image/jpeg", buffer: Buffer.from("no soy un jpeg") },
    ...widthCodedFiles(1, { names: ["ok.jpg"] }),
  ]);
  await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });
  await waitIdle(page);
  const banner = page.locator('[data-banner="import-problems"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("No se pudieron añadir 3 fotos");
  await expect(banner.locator('[data-import-problem="notImage"]')).toContainText("nota.txt");
  await expect(banner.locator('[data-import-problem="notImage"]')).toContainText("no es una imagen");
  await expect(banner.locator('[data-import-problem="heic"]')).toContainText("foto-fail.heic");
  await expect(banner.locator('[data-import-problem="heic"]')).toContainText("HEIC");
  await expect(banner.locator('[data-import-problem="damaged"]')).toContainText("roto-fail.jpg");
  await expect(banner.locator('[data-import-problem="damaged"]')).toContainText("dañada");
  await expect(banner).toContainText("Las demás siguen en la lista");
  // Con UNA sola foto fallida, el singular.
  await banner.getByRole("button", { name: /Cerrar el aviso/ }).click();
  await expect(banner).toHaveCount(0);
  await importPhotos(page, [{ name: "otra-fail.jpg", mimeType: "image/jpeg", buffer: Buffer.from("tampoco") }]);
  await expect(banner).toContainText("No se pudo añadir 1 foto");
  await expect(tiles(page)).toHaveCount(1);
});

test("una foto que no se puede procesar se descarta con aviso y el resto sigue (el motor falso cuenta sus llamadas)", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(3, { names: ["a.jpg", "b-fail.jpg", "c.jpg"] }));
  await expect(tiles(page)).toHaveCount(2, { timeout: 15_000 });
  await waitIdle(page);
  expect(await fakeControls(page, (c) => c.calls.createPage)).toBe(3);
});
