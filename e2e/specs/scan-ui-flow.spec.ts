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
    await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
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
    await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
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
    // El motor real se precarga solo al abrir la herramienta (`preloadScanEngine`): se espera a que acabe y se corta la red SIN calentar
    // con ninguna importacion previa (como un movil que abre la herramienta y se queda sin cobertura). Se corta con `route` y no con
    // `setOffline`: en WebKit de Linux `setOffline` tambien rompe las URL `blob:` locales, que no son red.
    await page.waitForTimeout(4000);
    await page.context().route(/^https?:\/\//, (route) => route.abort("internetdisconnected"));
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  } else if (browserName === "chromium") await page.context().setOffline(true);
  await importPhotos(page, scanFiles(["a.jpg", "b-blank.jpg", "c.jpg"]));
  await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(3);
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(3\)/ }).click();
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /descargar|download(?!er)/i }).first().click();
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
  await expect(page.getByRole("button", { name: /descargar|download(?!er)/i }).first()).toBeVisible();
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

test("texto buscable: sin el modelo ofrece DESCARGARLO (accion explicita), no descarga nada solo y el PDF sale normal con un AVISO", async ({ page, baseURL }) => {
  const foreign: string[] = [];
  const own = new URL(baseURL!).origin;
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
    if (new URL(url).origin !== own) foreign.push(`${request.method()} ${url}`);
  });
  await page.goto("/scan-to-pdf");
  await importPhotos(page, scanFiles(["a.jpg", "b.jpg"]));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  const save = page.locator("[data-save-screen]");
  // Antes de marcar nada, el texto de la casilla no afirma que funcione sin conexion (falso la primera vez).
  await expect(save).not.toContainText(/sin internet/i);
  await page.getByRole("checkbox", { name: "PDF con texto buscable" }).check({ force: true });
  const download = page.locator("[data-ocr-download]");
  await expect(download).toBeVisible();
  await expect(download).toContainText("≈ 25 MB");
  const button = page.locator('[data-save-action="download-model"]');
  await expect(button).toHaveText("Descargar el modelo de texto (≈ 25 MB)");
  await expect(page.locator("[data-create-meta]")).toContainText("Sin el modelo de texto");
  // Crear NO depende de la descarga: PDF normal y un aviso (no un error) con el texto del motor. Sin ninguna peticion externa.
  const create = page.locator('[data-save-action="create"]');
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-download-notices]")).toContainText("sin texto buscable");
  await expect(page.locator("[data-download-notices]")).toContainText("falta el modelo de texto");
  await expect(page.locator("[data-save-error]")).toHaveCount(0);
  expect(foreign, foreign.join("\n")).toEqual([]);
});

test("texto buscable: «Descargar el modelo de texto» baja el modelo UNA vez y despues el PDF lleva texto; si falla, lo dice y se puede reintentar", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installScanFakes(page, { controls: { ocrPrepare: "offline" } });
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await waitIdle(page);
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  await page.getByRole("checkbox", { name: "PDF con texto buscable" }).check({ force: true });
  const button = page.locator('[data-save-action="download-model"]');
  await button.click();
  await expect(page.locator("[data-ocr-download-error]")).toContainText("Sin conexión");
  await expect(button).toBeEnabled();
  // Vuelve la conexion: el siguiente intento baja el modelo y la nota desaparece.
  await fakeControls(page, (c) => (c.ocrPrepare = "ok"));
  await button.click();
  await expect(page.locator("[data-ocr-download]")).toHaveCount(0);
  expect(await fakeControls(page, (c) => c.calls.prepareOcrModel)).toBe(2);
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-download-notices]")).toHaveCount(0);
  expect(await fakeControls(page, (c) => c.calls.ocrUsed)).toBe(1);
});
