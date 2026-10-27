import { test, type Page } from "@playwright/test";
import { expect, fakeControls, installFakeCamera, installScanFakes, pageIds, waitIdle, waitVideoReady, widthCodedFiles, TEST_TIMEOUT, webkitLinuxCamera, WEBKIT_LINUX_CAMERA_REASON } from "../helpers/scan-ui";

/**
 * Escaner · camara: guia unica en vivo, captura automatica con anillo y enfriamiento (desactivable), rafaga con contador y
 * «Deshacer», modos (Identificacion = dos capturas en UNA hoja; Libro = una foto, dos paginas), linterna / zoom / enfoque por
 * toque / cambio de camara donde la pista lo permita (degrada si no), importar y mezclar con la camara, y sin camara.
 */
test.use({ locale: "es-ES" });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  await installScanFakes(page);
});

const tiles = (page: Page) => page.locator("[data-page-grid] [data-page-id]");
const count = (page: Page) => page.locator("[data-camera-count]");

async function openCamera(page: Page) {
  await page.goto("/scan-to-pdf");
  await page.getByRole("button", { name: "Activar cámara" }).click();
  await waitVideoReady(page);
}

test("la guia unica sigue el veredicto del motor y la captura automatica dispara sola con enfriamiento", async ({ page }) => {
  await installFakeCamera(page);
  await openCamera(page);
  // Guia: el motor dice «Acércate» -> eso, y solo eso, se ve.
  await fakeControls(page, (c) => (c.verdict = { hint: "move_closer", stable: false, stableMs: 0, shouldAutoCapture: false }));
  await expect(page.locator("[data-camera-hint]")).toHaveText("Acércate");
  await fakeControls(page, (c) => (c.verdict = { hint: "glare", stable: false, stableMs: 0, shouldAutoCapture: false }));
  await expect(page.locator("[data-camera-hint]")).toHaveText("Hay brillo");
  await fakeControls(page, (c) => (c.verdict = { hint: "no_document", quad: null, stable: false, stableMs: 0, shouldAutoCapture: false }));
  await expect(page.locator("[data-camera-hint]")).toHaveText("No veo el documento");

  // Estable pero sin disparar todavia: el anillo avanza.
  await fakeControls(page, (c) => (c.verdict = { hint: "ok", stable: true, stableMs: 450, shouldAutoCapture: false }));
  await expect(page.locator('[data-camera-ring="0.50"]')).toBeAttached();
  await expect(count(page)).toHaveText("0 páginas");

  // El motor da luz verde: captura sola UNA vez (enfriamiento + hay que mover el documento antes de la siguiente).
  await fakeControls(page, (c) => (c.verdict = { hint: "ok", stable: true, stableMs: 1000, shouldAutoCapture: true }));
  await expect(count(page)).toHaveText("1 página");
  await page.waitForTimeout(2200);
  await expect(count(page)).toHaveText("1 página");
  // Se mueve el documento (deja de estar estable) y se presenta el siguiente: dispara otra vez.
  await fakeControls(page, (c) => (c.verdict = { hint: "hold_steady", stable: false, stableMs: 0, shouldAutoCapture: false }));
  await page.waitForTimeout(400);
  await fakeControls(page, (c) => (c.verdict = { hint: "ok", stable: true, stableMs: 1000, shouldAutoCapture: true }));
  await expect(count(page)).toHaveText("2 páginas");
});

test("con la captura automatica desactivada nunca dispara; y esa eleccion se recuerda", async ({ page }) => {
  await installFakeCamera(page);
  await openCamera(page);
  await page.locator('[data-camera-action="auto"]').click();
  await fakeControls(page, (c) => (c.verdict = { hint: "ok", stable: true, stableMs: 2000, shouldAutoCapture: true }));
  await page.waitForTimeout(1500);
  await expect(count(page)).toHaveText("0 páginas");
  await page.getByRole("button", { name: "Capturar página" }).click();
  await expect(count(page)).toHaveText("1 página");
  await page.goto("/scan-to-pdf");
  await page.getByRole("button", { name: "Activar cámara" }).click();
  await expect(page.locator('[data-camera-action="auto"]')).toHaveAccessibleName(/desactivada/i);
});

test("rafaga: contador, miniatura de la ultima y «Deshacer»; sin rafaga, tras cada pagina se va a revisar", async ({ page }) => {
  await installFakeCamera(page);
  await openCamera(page);
  await page.locator('[data-camera-action="auto"]').click();
  const shutter = page.getByRole("button", { name: "Capturar página" });
  await shutter.click();
  await shutter.click();
  await expect(count(page)).toHaveText("2 páginas");
  await expect(page.locator("[data-camera-last]")).toHaveAttribute("alt", "Última captura: página 2");
  await page.locator('[data-camera-action="undo-last"]').click();
  await expect(count(page)).toHaveText("1 página");
  await expect(page.locator("[data-camera-last]")).toHaveCount(0);
  // Sin rafaga.
  await page.locator('[data-camera-action="burst"]').click();
  await shutter.click();
  await expect(page.locator("[data-camera-stage]")).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
});

test("linterna, zoom y enfoque por toque usan applyConstraints de la pista; el cambio de camara solo aparece con varias", async ({ page }) => {
  await installFakeCamera(page, { devices: 2 });
  await openCamera(page);
  await page.locator('[data-camera-action="torch"]').click();
  await page.locator('[data-camera-action="zoom"]').click();
  await expect(page.locator('[data-camera-action="zoom"]')).toHaveAccessibleName("Zoom 2×");
  // Toque en el video: enfoque de un disparo con el punto de interes.
  const stage = page.locator("[data-camera-stage] video");
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await expect(page.locator("[data-focus-ring]")).toBeVisible();
  const constraints = await page.evaluate(() => JSON.stringify((window as unknown as { __cam: { constraints: unknown[] } }).__cam.constraints));
  expect(constraints).toContain('"torch":true');
  expect(constraints).toContain('"zoom":2');
  expect(constraints).toContain('"focusMode":"single-shot"');
  expect(constraints).toContain("pointsOfInterest");
  const before = await page.evaluate(() => (window as unknown as { __cam: { gum: number } }).__cam.gum);
  await page.locator('[data-camera-action="switch"]').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cam: { gum: number } }).__cam.gum)).toBe(before + 1);
});

test("sin capacidades (Safari / webcam): la linterna y el zoom no aparecen y nada falla", async ({ page }) => {
  await installFakeCamera(page, { torch: false, zoom: false, focus: false });
  await openCamera(page);
  await expect(page.locator('[data-camera-action="torch"]')).toHaveCount(0);
  await expect(page.locator('[data-camera-action="zoom"]')).toHaveCount(0);
  await expect(page.locator('[data-camera-action="switch"]')).toHaveCount(0);
  await expect(page.locator('[data-camera-action="import"]')).toBeVisible();
});

test("importar fotos desde la camara y mezclarlas con las capturadas", async ({ page }) => {
  await installFakeCamera(page);
  await openCamera(page);
  await page.locator('[data-camera-action="auto"]').click();
  await page.getByRole("button", { name: "Capturar página" }).click();
  await expect(count(page)).toHaveText("1 página");
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-camera-action="import"]').click();
  await (await chooser).setFiles(widthCodedFiles(2));
  await expect(count(page)).toHaveText("3 páginas");
  await page.getByRole("button", { name: /Revisar \(3\)/ }).click();
  await expect(tiles(page)).toHaveCount(3);
  await waitIdle(page);
});

test("modo Identificacion: anverso y reverso = UNA hoja", async ({ page }) => {
  await installFakeCamera(page);
  await openCamera(page);
  await page.locator('[data-camera-action="auto"]').click();
  await page.locator('[data-camera-stage] [data-mode="id-card"]').click();
  await expect(page.locator("[data-camera-stage]")).toContainText("Identificación · Anverso (1 de 2)");
  const shutter = page.getByRole("button", { name: "Capturar página" });
  await shutter.click();
  await expect(page.locator("[data-camera-stage]")).toContainText("Identificación · Reverso (2 de 2)");
  await expect(count(page)).toHaveText("0 páginas");
  await shutter.click();
  await expect(count(page)).toHaveText("1 página");
  await expect(page.locator("[data-camera-stage]")).toContainText("Identificación · Anverso (1 de 2)");
  await page.getByRole("button", { name: /Revisar \(1\)/ }).click();
  await expect(tiles(page)).toHaveCount(1);
  await waitIdle(page);
  // La hoja compuesta es una A4 (1240x1754 a 150 ppp), no una de las dos fotos de camara (640x480).
  const dims = await page.evaluate(async () => {
    const f = (globalThis as unknown as { __scanFake: { store: { list: () => Promise<{ id: string }[]>; load: (id: string) => Promise<{ pages: { originalWidth: number; originalHeight: number }[] }> } } }).__scanFake;
    await new Promise((resolve) => setTimeout(resolve, 900));
    const id = (await f.store.list())[0].id;
    const session = await f.store.load(id);
    return { w: session.pages[0].originalWidth, h: session.pages[0].originalHeight, n: session.pages.length };
  });
  expect(dims.n).toBe(1);
  expect(dims.h).toBeGreaterThan(dims.w);
  expect(dims.w).toBe(1240);
});

test("modo Libro: una foto = dos paginas (mitad izquierda y derecha)", async ({ page }) => {
  await installFakeCamera(page, { width: 800, height: 480 });
  await openCamera(page);
  await page.locator('[data-camera-action="auto"]').click();
  await page.locator('[data-camera-stage] [data-mode="book"]').click();
  await page.getByRole("button", { name: "Capturar página" }).click();
  await expect(count(page)).toHaveText("2 páginas");
  await page.getByRole("button", { name: /Revisar \(2\)/ }).click();
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  expect(await fakeControls(page, (c) => c.calls.splitSpread ?? 0)).toBe(1);
});

test("sin camara (permiso denegado): pantalla clara y «Elegir fotos» como camino principal", async ({ page }) => {
  await installFakeCamera(page, { denyWith: "NotAllowedError" });
  await page.goto("/scan-to-pdf");
  await page.getByRole("button", { name: "Activar cámara" }).click();
  const error = page.locator("[data-camera-error]");
  await expect(error).toBeFocused();
  await expect(error).toContainText("La cámara no está disponible");
  await expect(error).toContainText("Has bloqueado el acceso");
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-camera-stage]").getByRole("button", { name: "Elegir fotos" }).click();
  await (await chooser).setFiles(widthCodedFiles(2));
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  expect(await pageIds(page)).toHaveLength(2);
});
