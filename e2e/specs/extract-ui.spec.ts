import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { downloadFile } from "../helpers/downloads";
import { readVault } from "../helpers/sign-vault-flow";
import {
  assetList,
  configureFake,
  fakeCalls,
  installFake,
  openAndRun,
  openExtract,
  pdfInput,
  setLanguage,
  syntheticPdf,
} from "../helpers/extract-ui-flow";

/**
 * «Extraer elementos» (F7 · U7.4): la interfaz completa contra el MOTOR FALSO (`createFakeEngine`) inyectado en la build
 * de produccion con el gancho `__optimusExtractEngine`. Cubre carga, progreso, galeria (nombres accesibles, filtros,
 * seleccion), descargas (PNG, JPG original, ZIP con `p03-firma-01.png`), detalle, guardar en «Firmas guardadas», avisos,
 * errores, estado vacio, cancelacion, rango de paginas y que NO hay peticiones de red externas. Headless siempre.
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad`.
 */

test.setTimeout(120_000);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

test.describe("extract-assets · flujo principal (ES)", () => {
  test("busca, muestra el recuento, la lista con nombres accesibles y los filtros con su numero", async ({ page }) => {
    await openAndRun(page);
    await expect(page.locator("[data-extract-heading]")).toHaveText("Encontramos 10 elementos en 6 páginas.");
    await expect(page.locator("[data-extract-heading]")).toBeFocused();
    const list = assetList(page);
    await expect(list.getByRole("listitem")).toHaveCount(10);
    for (const name of [
      "Firma, página 3, 420 × 140 px",
      "Firma probable, página 4, 520 × 180 px",
      "Firma, página 2, 380 × 120 px",
      "Iniciales probables, páginas 1, 2, 160 × 90 px",
      "Logo, 6 páginas, 300 × 100 px",
      "Sello, página 4, 220 × 220 px",
      "Marca de agua probable, 6 páginas, solo texto",
      "Imagen, página 5, 800 × 600 px",
      "Foto, página 6, 640 × 480 px",
      "Dibujo probable, página 3, 300 × 120 px",
    ]) {
      await expect(list.getByRole("listitem", { name })).toHaveCount(1);
      await expect(list.getByRole("checkbox", { name })).toHaveCount(1);
    }
    await expect(page.getByRole("button", { name: /^Firmas\s*3$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Iniciales\s*1$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Imágenes\s*2$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Otros\s*1$/ })).toBeVisible();
    // La nota estatica de una linea: sin casilla ni marca.
    await expect(page.locator("[data-extract-note]")).toHaveText("Úsalo solo con firmas propias o con autorización de su titular.");
    await expect(page.locator("[data-extract-note] input")).toHaveCount(0);
    // Aviso de la pagina escaneada y salida al recorte.
    await expect(page.locator('[data-notice="scanned-page"]')).toContainText("La página 5 es un escaneo");
  });

  test("filtrar por tipo cambia la lista y la region viva UNICA lo anuncia; Seleccionar todo actua sobre lo visible", async ({ page }) => {
    await openAndRun(page);
    expect(await page.locator('[role="status"]').count()).toBe(1);
    await page.getByRole("button", { name: /^Firmas/ }).click();
    await expect(assetList(page).getByRole("listitem")).toHaveCount(3);
    await expect(page.locator("[data-extract-status]")).toHaveText("Mostrando 3 de 10");
    await expect(page.getByRole("button", { name: /^Firmas/ })).toHaveAttribute("aria-pressed", "true");
    await page.locator("[data-select-all]").check();
    await expect(page.getByText("3 seleccionados").first()).toBeVisible();
    // Cambiar de filtro no pierde la seleccion, y «Todos» marca el parcial como indeterminado.
    await page.getByRole("button", { name: /^Todos/ }).click();
    await expect(assetList(page).getByRole("checkbox", { checked: true })).toHaveCount(3);
    expect(await page.locator("[data-select-all]").evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
    await page.locator("[data-select-all]").check();
    await expect(page.getByText("10 seleccionados").first()).toBeVisible();
    await page.locator("[data-select-all]").uncheck();
    await expect(page.getByText("Ninguno seleccionado").first()).toBeVisible();
  });

  test("la casilla de cada tarjeta se marca con la barra espaciadora", async ({ page }) => {
    await openAndRun(page);
    const box = assetList(page).getByRole("checkbox", { name: "Firma, página 3, 420 × 140 px" });
    await box.focus();
    await page.keyboard.press("Space");
    await expect(box).toBeChecked();
    await page.keyboard.press("Space");
    await expect(box).not.toBeChecked();
  });

  test("descarga individual en PNG con nombre p03-firma-01.png y, con «Original», el JPG original", async ({ page }) => {
    await openAndRun(page);
    const sig = page.getByRole("button", { name: /^Descargar: Firma, página 3/ });
    const png = await downloadFile(page, () => sig.click());
    expect(png.filename).toBe("p03-firma-01.png");
    expect(png.bytes.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    // La segunda firma de la pagina 4 trae JPG original.
    await page.getByRole("button", { name: "Original", exact: true }).click();
    const jpg = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar: Firma probable, página 4/ }).click());
    expect(jpg.filename).toBe("p04-firma-01.jpg");
    expect(jpg.bytes.subarray(0, 3).equals(JPG_MAGIC)).toBe(true);
    // La marca de agua de texto sale como .txt con su texto; el trazo de lapiz como SVG.
    const txt = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar: Marca de agua probable/ }).click());
    expect(txt.filename).toBe("p01-marca-de-agua-01.txt");
    expect(txt.bytes.toString("utf8")).toBe("CONFIDENCIAL");
    const svg = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar: Firma, página 2/ }).click());
    expect(svg.filename).toBe("p02-firma-01.svg");
    expect(svg.bytes.toString("utf8")).toContain("<svg");
  });

  test("ZIP de seleccionados: nombres p03-firma-01.png, sin colisiones y con los bytes de cada elemento", async ({ page }) => {
    await openAndRun(page);
    await page.getByRole("button", { name: /^Firmas/ }).click();
    await page.locator("[data-select-all]").check();
    const zipButton = page.getByRole("button", { name: "Descargar seleccionados (.zip)" });
    await expect(zipButton).toBeVisible();
    const zip = await downloadFile(page, () => zipButton.click());
    expect(zip.filename).toBe("contrato-elementos.zip");
    const loaded = await JSZip.loadAsync(zip.bytes);
    expect(Object.keys(loaded.files).sort()).toEqual(["p02-firma-01.png", "p03-firma-01.png", "p04-firma-01.png"]);
    for (const name of Object.keys(loaded.files)) {
      const bytes = await loaded.files[name].async("nodebuffer");
      expect(bytes.subarray(0, 4).equals(PNG_MAGIC), name).toBe(true);
    }
    await expect(page.locator("[data-extract-status]")).toContainText("ZIP descargado con 3 archivos.");
  });

  test("el detalle muestra los motivos del clasificador, vuelve el foco al cerrar y permite descargar por formato", async ({ page }) => {
    await openAndRun(page);
    const open = page.getByRole("button", { name: /^Ver detalles: Firma probable, página 4/ });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Detalles del elemento" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("cerca de “Firma”")).toBeVisible();
    await expect(dialog.getByText("Confianza: 64 %")).toBeVisible();
    await expect(dialog.getByText("Página 4")).toBeVisible();
    const jpg = await downloadFile(page, () => dialog.getByRole("button", { name: "Original (imagen tal cual)" }).click());
    expect(jpg.filename).toBe("p04-firma-01.jpg");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
  });

  test("guardar en Firmas guardadas: hoja con nombre y cargo, limpieza, origin «extracted» y documento de origen", async ({ page }) => {
    await openAndRun(page, { fileName: "Contrato Pérez.pdf" });
    await page.getByRole("button", { name: /^Guardar en Firmas guardadas: Firma probable, página 4/ }).click();
    const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.locator("[data-extract-save-name]")).toBeFocused();
    // Sin nombre no se guarda.
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.getByText("Escribe el nombre de quien firma.")).toBeVisible();
    await sheet.locator("[data-extract-save-name]").fill("Ana Pérez");
    await sheet.getByLabel("Cargo (opcional)").fill("Ajustadora");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Guardada en Firmas guardadas: Ana Pérez.");
    await expect(sheet.getByRole("link", { name: "Ver en Firmas guardadas" })).toHaveAttribute("href", "/sign-pdf");
    await expect(sheet.getByRole("button", { name: "Recortar otra" })).toBeVisible();
    await sheet.getByRole("button", { name: "Cerrar", exact: true }).first().click();
    await expect(sheet).toBeHidden();
    const rows = await readVault(page);
    expect(rows).toHaveLength(1);
    const row = rows[0] as unknown as Record<string, unknown> & { signature: { transparent: number; corners: number[] } | null };
    expect(row.signerName).toBe("Ana Pérez");
    expect(row.role).toBe("Ajustadora");
    expect(row.origin).toBe("extracted");
    expect(row.sourceDocument).toBe("Contrato Pérez.pdf");
    // El papel gris del escaneo se quito: esquinas transparentes y buena parte del lienzo sin tinta.
    expect(row.signature).not.toBeNull();
    expect(row.signature!.corners.every((alpha) => alpha === 0)).toBe(true);
    expect(row.signature!.transparent).toBeGreaterThan(0.5);
  });

  test("tras guardar, «Ver en Firmas guardadas» lleva a Firmar PDF, donde la firma ya esta guardada", async ({ page }) => {
    await openAndRun(page);
    await page.getByRole("button", { name: /^Guardar en Firmas guardadas: Firma, página 3/ }).click();
    const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await sheet.locator("[data-extract-save-name]").fill("Luis Gómez");
    await sheet.locator("[data-extract-save-submit]").click();
    await sheet.getByRole("link", { name: "Ver en Firmas guardadas" }).click();
    await expect(page).toHaveURL(/\/sign-pdf$/);
    expect((await readVault(page)).map((row) => row.signerName)).toEqual(["Luis Gómez"]);
  });

  test("las iniciales se guardan como iniciales", async ({ page }) => {
    await openAndRun(page);
    await page.getByRole("button", { name: /^Guardar en Firmas guardadas: Iniciales probables/ }).click();
    const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
    await expect(sheet.getByRole("radio", { name: "Iniciales", exact: true })).toBeChecked();
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await sheet.locator("[data-extract-save-name]").fill("Eva Ríos");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
    const rows = await readVault(page);
    expect(rows[0].initials).not.toBeNull();
    expect(rows[0].signature).toBeNull();
  });
});

test.describe("extract-assets · avisos, errores y estados", () => {
  test("estado vacio: texto, salida al recorte y la pagina escaneada marcada", async ({ page }) => {
    await openAndRun(page, { fake: { scenario: "empty" } });
    await expect(page.locator("[data-extract-empty]")).toContainText("No encontramos elementos; prueba a recortar una región.");
    await page.getByRole("button", { name: "Recortar una región" }).click();
    await expect(page.locator("[data-region-scanned]")).toContainText("Esta página es un escaneo: recorta la región donde está la firma.");
  });

  test("sin motor de deteccion se ofrece el recorte manual, que si funciona (el motor por defecto ya es el real: se simula con el gancho)", async ({ page }) => {
    await openAndRun(page, { unavailable: true });
    await expect(page.locator("[data-extract-heading]")).toContainText("La búsqueda automática aún no está disponible");
    await expect(page.getByRole("tab", { name: "Recortar región" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-region-rect]")).toBeVisible();
  });

  test("todos los avisos del motor se dicen en frases claras", async ({ page }) => {
    await openAndRun(page, { fake: { scenario: "warnings" } });
    const notices = page.locator("[data-extract-notices]");
    await expect(notices).toContainText("La página 5 es un escaneo");
    await expect(notices).toContainText("La página 2 tiene una firma digital");
    await expect(notices).toContainText("No se pudo leer una imagen de la página 3");
    await expect(notices).toContainText("Una imagen de la página 4 es demasiado grande");
    await expect(notices).toContainText("El documento está cifrado");
  });

  test("500 elementos: se corta en 500 con aviso y la galeria sigue siendo una lista navegable", async ({ page }) => {
    await openAndRun(page, { fake: { scenario: "many", assetCount: 520 } });
    await expect(page.locator("[data-extract-heading]")).toContainText("Encontramos 500 elementos");
    await expect(assetList(page).getByRole("listitem")).toHaveCount(500);
    await expect(page.locator('[data-notice="too-many-assets"]')).toBeVisible();
  });

  test("500 elementos: el pintado de la galeria no deja tareas largas (> 100 ms) en el hilo principal", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "PerformanceObserver de `longtask` solo existe en Chromium");
    await openExtract(page, { fake: { scenario: "many", assetCount: 520 } });
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__long.push(Math.round(entry.duration));
      }).observe({ type: "longtask" });
    });
    await page.getByRole("button", { name: "Buscar elementos" }).click();
    await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout: 60_000 });
    // Desde aqui solo se mide LO QUE PINTA LA INTERFAZ (el motor falso ya termino).
    await page.evaluate(() => ((window as unknown as { __long: number[] }).__long.length = 0));
    await expect(assetList(page).getByRole("listitem")).toHaveCount(500, { timeout: 60_000 });
    await page.waitForTimeout(500);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    // El CI es ~2,5 veces mas lento: el limite lleva holgura solo alli.
    expect(Math.max(0, ...long), `tareas largas: ${long.join(", ")} ms`).toBeLessThanOrEqual(100 * (process.env.CI ? 2.5 : 1));
  });

  test("documento de mas de 300 paginas: avisa y deja elegir un rango que se pide al motor", async ({ page }) => {
    await openAndRun(page, { fake: { scenario: "tooManyPages", pageCount: 450 } });
    await expect(page.locator('[data-notice="too-many-pages"]')).toContainText("450 páginas");
    const form = page.locator("[data-extract-range]");
    await form.getByLabel("Desde la página").fill("301");
    await form.getByLabel("Hasta la página").fill("450");
    await form.getByRole("button", { name: "Buscar en este rango" }).click();
    await expect(page.locator("[data-extract-heading]")).toBeVisible();
    await expect(page.locator('[data-notice="too-many-pages"]')).toHaveCount(0);
    await expect(page.locator("[data-extract-heading]")).toContainText("150 páginas");
    const calls = await fakeCalls(page);
    expect(calls.filter((call) => call.method === "extractAssets")).toHaveLength(2);
  });

  test("un fallo del motor muestra el banner de error compartido y permite reintentar", async ({ page }) => {
    await openExtract(page, { fake: { failWith: "corrupt" } });
    await page.getByRole("button", { name: "Buscar elementos" }).click();
    await expect(page.locator("[data-error-banner]")).toContainText("dañado");
    await configureFake(page, { failWith: undefined });
    await page.getByRole("button", { name: "Buscar elementos" }).click();
    await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout: 30_000 });
  });

  test("cancelar mientras busca: aviso en la region viva, vuelve a la pantalla de carga y el foco al boton", async ({ page }) => {
    await openExtract(page, { fake: { delayMs: 400 }, pages: 6 });
    await page.getByRole("button", { name: "Buscar elementos" }).click();
    const overlay = page.getByRole("dialog");
    await expect(overlay).toContainText(/Página \d+ de 6/);
    await overlay.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.locator("[data-extract-status]")).toHaveText("Búsqueda cancelada.");
    await expect(page.getByRole("button", { name: "Buscar elementos" })).toBeFocused();
    await expect(page.locator("[data-extract-heading]")).toHaveCount(0);
  });

  test("un PDF cifrado o roto se rechaza antes de buscar y el boton explica por que", async ({ page }) => {
    await setLanguage(page, "es");
    await installFake(page, {});
    await page.goto("/extract-assets");
    await pdfInput(page).setInputFiles({ name: "roto.pdf", mimeType: "application/pdf", buffer: Buffer.from("no es un pdf") });
    await expect(page.locator("[data-error-banner]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Buscar elementos" })).toBeDisabled();
  });

  test("«Abrir en PDF Pro» lleva el archivo a PDF Pro", async ({ page }) => {
    await openAndRun(page);
    await page.getByRole("link", { name: "Abrir en PDF Pro" }).click();
    await expect(page).toHaveURL(/\/pdf-pro/);
  });

  test("todo es local: ninguna peticion a otro origen durante todo el flujo", async ({ page, baseURL }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
      if (!url.startsWith(baseURL ?? "http://localhost")) external.push(url);
    });
    await openAndRun(page);
    await page.getByRole("button", { name: /^Descargar: Firma, página 3/ }).click();
    await page.getByRole("tab", { name: "Recortar región" }).click();
    await expect(page.locator("[data-region-rect]")).toBeVisible();
    expect(external).toEqual([]);
  });
});

test.describe("extract-assets · English", () => {
  test("textos y nombres de archivo en ingles", async ({ page }) => {
    await openAndRun(page, { lang: "en" });
    await expect(page.locator("[data-extract-heading]")).toHaveText("We found 10 elements in 6 pages.");
    await expect(page.locator("[data-extract-note]")).toHaveText("Use this only with your own signatures or with the signer's permission.");
    const list = assetList(page);
    await expect(list.getByRole("listitem", { name: "Signature, page 3, 420 × 140 px" })).toHaveCount(1);
    await expect(list.getByRole("listitem", { name: "Probable signature, page 4, 520 × 180 px" })).toHaveCount(1);
    const file = await downloadFile(page, () => page.getByRole("button", { name: /^Download: Signature, page 3/ }).click());
    expect(file.filename).toBe("p03-signature-01.png");
  });
});

test("el motor falso no rompe la deteccion de un escenario con solo firmas", async ({ page }) => {
  await openAndRun(page, { fake: { scenario: "signatures" } });
  await expect(assetList(page).getByRole("listitem")).toHaveCount(4);
  void syntheticPdf;
});
