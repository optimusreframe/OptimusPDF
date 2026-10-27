import { test } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageSize } from "../helpers/pdf-inspection";
import { expect, expectedWidth, fakeControls, FAKE_ONLY_REASON, heightCodedFiles, importPhotos, installFakeCamera, installScanFakes, pageIds, scanFiles, USE_REAL_ENGINE, waitIdle, waitVideoReady, widthCodedFiles, TEST_TIMEOUT, webkitLinuxCamera, WEBKIT_LINUX_CAMERA_REASON } from "../helpers/scan-ui";

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
  // Motor real: su recorte varia, asi que el orden se identifica por el ALTO de cada hoja (crece con el numero).
  await importPhotos(page, USE_REAL_ENGINE ? heightCodedFiles(5) : widthCodedFiles(5));
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
  const heights: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const size = await getPageSize(bytes, index + 1);
    heights.push(size.height);
    // Motor falso: recorte conocido del 4 % por lado. Real: el recorte lo decide la deteccion, asi que se comprueba el ORDEN.
    if (!USE_REAL_ENGINE) expect(Math.abs(size.width - expectedWidth(index))).toBeLessThan(3);
  }
  if (USE_REAL_ENGINE) expect(heights, `altos por pagina: ${heights.join(", ")}`).toEqual([...heights].sort((a, b) => a - b));
  // El motor procesa una foto a la vez.
  if (!USE_REAL_ENGINE) expect(await fakeControls(page, (c) => c.peakConcurrent)).toBeLessThanOrEqual(1);
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
  if (USE_REAL_ENGINE) {
    // El motor real carga su trabajador de dibujo la primera vez: se calienta CON red (importar una foto) y despues se corta. El
    // arranque del motor sin red es del motor y lo cubre su propio spec; aqui se prueba que el FLUJO no necesita la red.
    await importPhotos(page, scanFiles(["calentar.jpg"]));
    await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(1);
    await waitIdle(page);
    await page.getByRole("button", { name: "Borrar la página 1" }).click();
  }
  if (browserName === "chromium") await page.context().setOffline(true);
  await importPhotos(page, scanFiles(["a.jpg", "b-blank.jpg", "c.jpg"]));
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
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
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

test("texto buscable: no promete «sin internet», pide aceptar la descarga del modelo y hasta entonces no crea el PDF", async ({ page }) => {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, scanFiles(["a.jpg", "b.jpg"]));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  const save = page.locator("[data-save-screen]");
  // Antes de marcar nada, el texto de la casilla no afirma que funcione sin conexion (falso la primera vez).
  await expect(save).not.toContainText(/sin internet/i);
  const searchable = page.getByRole("checkbox", { name: "PDF con texto buscable" });
  await searchable.check({ force: true });
  const download = page.locator("[data-ocr-download]");
  await expect(download).toBeVisible();
  await expect(download).toContainText("se descarga el modelo");
  const create = page.locator('[data-save-action="create"]');
  await expect(create).toBeDisabled();
  await expect(page.locator("[data-create-meta]")).toContainText("Permitir descargar el modelo");
  await page.getByRole("checkbox", { name: /Permitir descargar el modelo/ }).check({ force: true });
  await expect(create).toBeEnabled();
  // Desmarcar el texto buscable quita la condicion.
  await searchable.uncheck({ force: true });
  await expect(download).toHaveCount(0);
  await expect(create).toBeEnabled();
});

test("texto buscable: si el PDF sale sin texto en alguna pagina, un AVISO (no un error) lo dice", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installScanFakes(page, { controls: { ocrAvailable: true, searchableReport: { total: 3, withText: 1 } } });
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(3));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(3\)/ }).click();
  await page.getByRole("checkbox", { name: "PDF con texto buscable" }).check({ force: true });
  // El modelo ya esta en el dispositivo: no hay nada que aceptar.
  await expect(page.locator("[data-ocr-download]")).toHaveCount(0);
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-download-notices]")).toContainText("2 de 3 páginas no tienen texto buscable");
  await expect(page.locator("[data-save-error]")).toHaveCount(0);
});
