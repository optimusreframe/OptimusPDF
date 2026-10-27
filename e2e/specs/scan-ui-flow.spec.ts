import { test } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageSize } from "../helpers/pdf-inspection";
import { expect, expectedWidth, fakeControls, importPhotos, installFakeCamera, installScanFakes, pageIds, waitIdle, waitVideoReady, widthCodedFiles, TEST_TIMEOUT, webkitLinuxCamera, WEBKIT_LINUX_CAMERA_REASON } from "../helpers/scan-ui";

/**
 * Escaner · flujo completo contra el motor y el almacen FALSOS (camara de canvas): camara -> rafaga -> revisar -> reordenar ->
 * girar -> borrar -> editar -> guardar -> descargar. Corre igual en Chromium y en `webkit-ipad`.
 */
test.use({ locale: "es-ES" });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
  await installFakeCamera(page);
});

async function openCamera(page: import("@playwright/test").Page) {
  await page.goto("/scan-to-pdf");
  await page.getByRole("button", { name: "Activar cámara" }).click();
  await waitVideoReady(page);
}

test("camara -> rafaga -> revisar -> reordenar -> girar -> borrar -> editar -> guardar -> descargar", async ({ page, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  await openCamera(page);
  // Sin captura automatica: el disparador manual de la rafaga.
  await page.locator('[data-camera-action="auto"]').click();
  await expect(page.locator('[data-camera-action="auto"]')).toHaveAccessibleName(/desactivada/i);
  const shutter = page.getByRole("button", { name: "Capturar página" });
  for (let n = 1; n <= 4; n += 1) {
    await shutter.click();
    await expect(page.locator("[data-camera-count]")).toHaveText(n === 1 ? "1 página" : `${n} páginas`);
    // Rafaga: sigue en la camara.
    await expect(page.locator("[data-camera-stage]")).toBeVisible();
  }
  await expect(page.locator("[data-camera-last]")).toBeVisible();
  await page.getByRole("button", { name: /Revisar \(4\)/ }).click();
  await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(4);
  await waitIdle(page);

  // Reordenar con teclado: la primera pagina baja un puesto.
  const before = await pageIds(page);
  const handle = page.locator("[data-page-grid] [data-drag-handle]").first();
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => pageIds(page)).toEqual([before[1], before[0], before[2], before[3]]);
  await expect(page.locator("[data-page-grid] [data-drag-handle]").nth(1)).toBeFocused();

  // Girar la segunda y borrar la cuarta.
  await page.getByRole("button", { name: "Girar la página 2" }).click();
  await page.getByRole("button", { name: "Borrar la página 4" }).click();
  await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(3);

  // Editor: filtro Blanco y negro en la primera.
  await page.locator("[data-page-grid] [data-page-main]").first().click();
  await expect(page.locator("[data-page-editor]")).toBeVisible();
  await page.locator('[data-filter="bw"]').click();
  await expect(page.locator('[data-filter="bw"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-editor-action="done"]').click();
  await expect(page.locator("[data-page-editor]")).toHaveCount(0);

  // Guardar.
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(3\)/ }).click();
  await expect(page.locator("[data-save-screen]")).toBeVisible();
  await page.getByRole("tab", { name: "Ajustar" }).click();
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download/i }).first().click();
  });
  expect(await getPageCount(bytes)).toBe(3);
  await expect(page.locator("[data-download-summary]")).toContainText(/Tus fotos: .* → PDF: /);
});

test("importar varias fotos de la fototeca: orden, avisos de calidad y PDF en el mismo orden", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(5));
  await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(5);
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(5\)/ }).click();
  await page.getByRole("tab", { name: "Ajustar" }).click();
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download/i }).first().click();
  });
  expect(await getPageCount(bytes)).toBe(5);
  for (let index = 0; index < 5; index += 1) {
    const size = await getPageSize(bytes, index + 1);
    expect(Math.abs(size.width - expectedWidth(index))).toBeLessThan(3);
  }
  // El motor procesa una foto a la vez.
  expect(await fakeControls(page, (c) => c.peakConcurrent)).toBeLessThanOrEqual(1);
});

test("cero red: ninguna peticion sale del origen durante todo el flujo (importar, revisar, guardar, descargar)", async ({ page, baseURL, browserName }) => {
  const foreign: string[] = [];
  const own = new URL(baseURL!).origin;
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
    if (new URL(url).origin !== own) foreign.push(`${request.method()} ${url}`);
  });
  // Y con la red cortada del todo, el flujo sigue funcionando (en Chromium: WebKit no sirve de cache los trozos de JS que aun no se pidieron).
  await page.goto("/scan-to-pdf");
  if (browserName === "chromium") await page.context().setOffline(true);
  await importPhotos(page, widthCodedFiles(3, { names: ["a.jpg", "b-blank.jpg", "c.jpg"] }));
  await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(3);
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(3\)/ }).click();
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download/i }).first().click();
  });
  expect(await getPageCount(bytes)).toBe(3);
  expect(foreign, foreign.join("\n")).toEqual([]);
});

test("resultado: compartir con la hoja nativa (gesto de usuario, con el archivo) y, sin ella, solo Descargar", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ files: Array<{ name: string; type: string; size: number }>; title?: string }> = [];
    (window as unknown as { __shared: typeof calls }).__shared = calls;
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: { files?: File[]; title?: string }) => {
        calls.push({ files: (data.files ?? []).map((file) => ({ name: file.name, type: file.type, size: file.size })), title: data.title });
      },
    });
  });
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  await page.locator("#scan-name").fill("Siniestro 4821");
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-result-action="share"]').click();
  const shared = await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0]).toMatchObject({ files: [{ name: "Siniestro 4821.pdf", type: "application/pdf" }], title: "Siniestro 4821" });
  expect((shared[0] as { files: Array<{ size: number }> }).files[0].size).toBeGreaterThan(500);
});

test("resultado sin hoja nativa de compartir: no hay boton «Compartir» y «Descargar» sigue siendo el camino", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(1));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(1\)/ }).click();
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-result-action="share"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /descargar|download/i }).first()).toBeVisible();
});

test("«Seguir en PDF Pro» abre el PDF resultante en PDF Pro (traspaso en memoria, sin subir nada)", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  await page.locator("#scan-name").fill("Para Pro");
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-result-action="pro"]').click();
  await expect(page).toHaveURL(/\/pdf-pro/);
  await expect(page.getByText("Para Pro.pdf").first()).toBeVisible({ timeout: 30_000 });
});

test("avisos de peso del PDF: > 20 MB aconseja «Compacta»; > 100 MB avisa de que WhatsApp y el correo no lo aceptan", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  await expect(page.locator("[data-size-warning]")).toHaveCount(0);
  const size = (bytes: number) =>
    page.evaluate((value) => {
      const engine = (globalThis as unknown as { __scanFake: { engine: { estimateSize: unknown } } }).__scanFake.engine;
      engine.estimateSize = () => ({ bytes: value, low: value, high: value });
    }, bytes);
  await size(30 * 1024 * 1024);
  await page.getByRole("tab", { name: "Alta", exact: true }).click();
  await expect(page.locator("[data-size-warning=big]")).toContainText("20 MB");
  await size(150 * 1024 * 1024);
  await page.getByRole("tab", { name: "Original", exact: true }).click();
  await expect(page.locator("[data-size-warning=huge]")).toContainText("100 MB");
});
