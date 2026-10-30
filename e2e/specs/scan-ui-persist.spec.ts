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
  await expect(sheet).toContainText("quedan guardadas en este dispositivo");
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
  await expect(page.getByRole("dialog", { name: "¿Salir del escaneo?" })).toContainText("No se pudo guardar");
});

test("cuota llena: avisa con un mensaje claro y se puede seguir creando el PDF", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installScanFakes(page, { store: { quotaBytes: 1 } });
  await page.goto("/scan-to-pdf");
  await importPhotos(page, widthCodedFiles(2));
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  await expect(status(page)).toHaveText("No guardado: no hay espacio");
  await expect(page.locator('[data-banner="storage"]')).toContainText("No queda espacio");
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

test("girar y recargar de INMEDIATO conserva el giro (el almacen apunta cada cambio y lo escribe al irse la pagina)", async ({ page }) => {
  // Con el almacen REAL: `stage` en cada cambio y volcado en `pagehide` (el almacen falso no escribe al ocultarse).
  test.skip(!USE_REAL_ENGINE, "solo con el almacen real: el volcado al irse la pagina es de `scanSessionStore`");
  await startScan(page, 2);
  const ids = await pageIds(page);
  const rotationOf = async (index: number) => Number(await tiles(page).nth(index).getAttribute("data-rotation"));
  // La orientacion automatica del motor corre en segundo plano justo despues de crear las paginas y puede girar alguna: se espera a
  // que los giros dejen de cambiar (si no, el giro automatico podria caer entre la lectura y el clic) y se parte de lo que haya.
  let stable = 0;
  let last = "";
  while (stable < 4) {
    const now = `${await rotationOf(0)},${await rotationOf(1)}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
    await page.waitForTimeout(350);
  }
  const first = await rotationOf(0);
  const second = await rotationOf(1);
  const turned = String((first + 90) % 360);
  await page.getByRole("button", { name: "Girar la página 1" }).click();
  await expect(tiles(page).first()).toHaveAttribute("data-rotation", turned);
  // Sin esperar el autoguardado de 500 ms.
  await page.reload();
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  expect(await pageIds(page)).toEqual(ids);
  await expect(tiles(page).first()).toHaveAttribute("data-rotation", turned);
  await expect(tiles(page).nth(1)).toHaveAttribute("data-rotation", String(second));
  // Y un borrado seguido de recarga inmediata tambien. El almacen abre su conexion de volcado en segundo plano tras la primera carga:
  // se le da un instante (nadie borra una hoja en los primeros 100 ms de abrir la pagina; sin conexion abierta el volcado cae al
  // guardado normal, que una recarga inmediata corta).
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "Borrar la página 2" }).click();
  await expect(tiles(page)).toHaveCount(1);
  await page.reload();
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first()).toHaveAttribute("data-rotation", turned);
});

test("borrar una pagina y que la pagina MUERA justo despues (sin guardado normal posible) no pierde el borrado, tras una recarga sin guardado con Blob", async ({ page }) => {
  // Determinista: no depende de la carga de la maquina ni de carreras con el guardado anticipado (~30 ms). Tras la recarga NO hay ningun guardado con
  // Blob terminado en esta carga (`blobVerified` en `false`); la pagina «muere» al irse porque `indexedDB.open` deja de contestar (el guardado normal,
  // que abre la base despues de un `await`, no puede avanzar): solo el volcado de `pagehide` sobre la conexion ya abierta puede escribir el borrado.
  test.skip(!USE_REAL_ENGINE, "solo con el almacen real: el volcado al irse la pagina es de `scanSessionStore`");
  await startScan(page, 2);
  await page.reload();
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  // El almacen abre su conexion de volcado en segundo plano tras la primera carga (nadie borra una hoja en los primeros 100 ms de abrir la pagina).
  await page.waitForTimeout(1_000);
  const ids = await pageIds(page);
  await page.getByRole("button", { name: "Borrar la página 2" }).evaluate(async (button) => {
    (indexedDB as unknown as { open: unknown }).open = () => ({});
    (button as HTMLButtonElement).click();
    while (document.querySelectorAll("[data-page-grid] [data-page-id]").length > 1) await new Promise((resolve) => setTimeout(resolve, 1));
    // Un turno para que la interfaz apunte el cambio con `stage`, y la pagina se va.
    await new Promise((resolve) => setTimeout(resolve, 2));
    window.dispatchEvent(new Event("pagehide"));
  });
  // La pagina «murio»: se recarga (la base real, sin el `open` anulado) y lo que quedo escrito es lo que vuelve.
  await page.reload();
  await expect(tiles(page)).toHaveCount(1);
  await waitIdle(page);
  expect(await pageIds(page)).toEqual(ids.slice(0, 1));
});

test("con el almacen falso cada cambio se apunta con `stage` al instante y se vuelca con `flush`", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await startScan(page, 2);
  const before = await page.evaluate(() => (globalThis as unknown as { __scanFake: { store: { controls: { stageLog: unknown[] } } } }).__scanFake.store.controls.stageLog.length);
  await page.getByRole("button", { name: "Girar la página 1" }).click();
  const after = await page.evaluate(() => (globalThis as unknown as { __scanFake: { store: { controls: { stageLog: unknown[] } } } }).__scanFake.store.controls.stageLog.length);
  expect(after).toBeGreaterThan(before);
});

test("el escaner no se pudo CARGAR (sin red): un mensaje claro con «Reintentar», nunca «dañada», y al volver la red las fotos entran", async ({ page, context }) => {
  let blocked = false;
  if (USE_REAL_ENGINE) {
    // Motor REAL: despues de cargar la pagina se cortan los trozos de JS que aun no llegaron (el motor se carga bajo demanda): el
    // `import()` falla como con un movil sin cobertura. Se corta con `route` (no `setOffline`: rompe las URL `blob:` en WebKit/Linux).
    await context.route(/\/_next\/static\/.*\.js/, (route) => (blocked ? route.abort("internetdisconnected") : route.continue()));
    await page.goto("/scan-to-pdf");
    await page.waitForLoadState("load");
    blocked = true;
  } else {
    await installScanFakes(page, { controls: { engineUnavailable: true } });
    await page.goto("/scan-to-pdf");
  }
  await importPhotos(page, widthCodedFiles(2));
  const banner = page.locator('[data-banner="import-problems"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("No se pudo cargar el escáner. Revisa tu conexión y vuelve a intentarlo");
  await expect(banner).not.toContainText(/dañada|incompleta/i);
  await expect(banner.locator("[data-import-problem]")).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(0);
  // Vuelve la red.
  if (USE_REAL_ENGINE) blocked = false;
  else await fakeControls(page, (c) => (c.engineUnavailable = false));
  await banner.getByRole("button", { name: "Reintentar" }).click();
  // El empaquetador puede guardar el fallo de carga de un trozo hasta recargar la pagina: si el reintento tambien falla, el aviso lo
  // dice y ofrece «Recargar la página»; tras recargar, las fotos entran.
  const reload = page.locator('[data-import-action="reload"]');
  await expect(tiles(page).first().or(reload)).toBeVisible({ timeout: 60_000 });
  if (await reload.isVisible()) {
    await expect(page.locator("[data-import-reload-hint]")).toBeVisible();
    await expect(banner).not.toContainText(/dañada|incompleta/i);
    await reload.click();
    await page.waitForLoadState("load");
    await importPhotos(page, widthCodedFiles(2));
  }
  await expect(tiles(page)).toHaveCount(2, { timeout: 60_000 });
  await expect(banner).toHaveCount(0);
});

test("el almacen no responde: «Guardando…» pasa en ~10 s a un aviso honesto con «descarga el PDF» (nunca eterno)", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await page.goto("/scan-to-pdf");
  await page.evaluate(() => {
    (globalThis as unknown as { __scanFake: { store: { controls: { hangSave: boolean } } } }).__scanFake.store.controls.hangSave = true;
  });
  await importPhotos(page, widthCodedFiles(2));
  await expect(tiles(page)).toHaveCount(2);
  await waitIdle(page);
  await expect(status(page)).toHaveText("Guardando…");
  await expect(status(page)).toHaveText("No guardado: sin respuesta", { timeout: 25_000 });
  await expect(page.locator('[data-banner="storage"]')).toHaveText("No se pudo guardar en este dispositivo; descarga el PDF para no perder el trabajo.");
  // Se puede seguir: crear el PDF funciona (no depende del almacen).
  await page.getByRole("button", { name: /Guardar PDF \(2\)/ }).click();
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
});
