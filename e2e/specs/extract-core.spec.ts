import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { downloadBytes, downloadFile } from "../helpers/downloads";
import { assetList, pdfInput, setLanguage } from "../helpers/extract-ui-flow";
import { RUN_LABEL, corpusUpload, gridIou, openRealEngine, pixelGrid, runSearch, scalePdf, vaultGrid } from "../helpers/extract-core-flow";
import { embeddedImages } from "../helpers/pdf-images";
import { PRIVACY_SEEN_KEY, VAULT_TITLE, makeColoredPdf, openVault, readVault } from "../helpers/sign-vault-flow";
import { pdfUpload } from "../helpers/test-files";

/**
 * «Extraer elementos» con el motor REAL (U7.3) de extremo a extremo, en navegador real y headless: pdf.js con su worker, los
 * motores de imagenes y anotaciones, el clasificador y la interfaz. PDF SINTETICOS (pdf-lib y `signPdfMulti`; jamas los del usuario).
 *
 *  - Un PDF firmado por `signPdfMulti` (2 firmantes): la galeria muestra firmas e iniciales como «probable» con sus motivos.
 *  - «Guardar en Firmas guardadas» (firmante nuevo y existente): la entrada del baul tiene la imagen limpia (se compara la FORMA
 *    por pixeles con la imagen que `signPdfMulti` incrusto, no los bytes).
 *  - «Recortar region» sobre una pagina escaneada -> guardar -> usarla en Firmar PDF -> el PDF final incluye esa firma.
 *  - Cancelar a mitad, PDF roto o cifrado, 300+ paginas con tope y rango, ninguna peticion de red fuera de la aplicacion.
 *  - Rendimiento: 20 paginas con 30 imagenes (< 2 s en escritorio y < 4 s en iPad/WebKit; holgura x2,5 en CI), sin tareas largas
 *    de mas de 100 ms y con el heap de JS < 400 MB.
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad ... --project=webkit-ipad` (build con `CSP_SKIP_UPGRADE_INSECURE=1`).
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(240_000);

const SLACK = process.env.CI ? 2.5 : 1;

/** Peticiones que salen de la pagina: todas al propio origen y solo GET (nada de red externa). */
function trackRequests(page: Page): { external: string[]; nonGet: string[] } {
  const seen = { external: [] as string[], nonGet: [] as string[] };
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
    const origin = new URL(url).origin;
    const base = new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin;
    if (origin !== base && !url.startsWith("http://localhost")) seen.external.push(url);
    if (request.method() !== "GET" && request.method() !== "HEAD") seen.nonGet.push(`${request.method()} ${url}`);
  });
  return seen;
}

const SIGNATURE_NAME = /^Firma probable, página 3, \d+ × \d+ px$/;
const INITIALS_NAME = /^Iniciales probables, páginas 1, 2, 3, \d+ × \d+ px$/;

test.describe("extract-assets · motor real · PDF firmado por signPdfMulti", () => {
  test("la galeria muestra 2 firmas y 2 iniciales como «probable» con sus motivos, y no sale nada a la red", async ({ page }) => {
    const requests = trackRequests(page);
    await openRealEngine(page, await corpusUpload("optimus-2signers", "Contrato firmado.pdf"));
    await runSearch(page);
    await expect(page.locator("[data-extract-heading]")).toHaveText("Encontramos 4 elementos en 3 páginas.");
    const list = assetList(page);
    await expect(list.getByRole("listitem", { name: SIGNATURE_NAME })).toHaveCount(2);
    await expect(list.getByRole("listitem", { name: INITIALS_NAME })).toHaveCount(2);
    await expect(page.getByRole("button", { name: /^Firmas\s*2$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Iniciales\s*2$/ })).toBeVisible();
    // El detalle enseña por que: fondo transparente, proporcion de firma y la etiqueta cercana.
    await page.getByRole("button", { name: /^Ver detalles: Firma probable, página 3/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Detalles del elemento" });
    await expect(dialog).toContainText("cerca de «Firma del");
    await expect(dialog).toContainText("fondo transparente");
    await expect(dialog).toContainText("proporción");
    expect(requests.external, requests.external.join("\n")).toEqual([]);
    expect(requests.nonGet).toEqual([]);
  });

  test("EN: «We found 4 elements in 3 pages.» y los nombres accesibles en ingles", async ({ page }) => {
    await openRealEngine(page, await corpusUpload("optimus-2signers"), "en");
    await runSearch(page, "en");
    await expect(page.locator("[data-extract-heading]")).toHaveText("We found 4 elements in 3 pages.");
    await expect(page.getByRole("list", { name: /Elements found/ }).getByRole("listitem", { name: /^Probable signature, page 3, \d+ × \d+ px$/ })).toHaveCount(2);
  });

  test("firmas pegadas como escaneo, estilo DocuSign y logos repetidos en cabecera y pie", async ({ page }) => {
    await openRealEngine(page, await corpusUpload("logo-header-footer"));
    await runSearch(page);
    const list = assetList(page);
    await expect(list.getByRole("listitem", { name: /^Logo, 5 páginas/ })).toHaveCount(2);
    await expect(list.getByRole("listitem", { name: /^Firma probable, página 5/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Logos\s*2$/ })).toBeVisible();
  });

  test("una firma vectorial se marca «beta» y se descarga en PNG y SVG", async ({ page }) => {
    await openRealEngine(page, await corpusUpload("vector-signatures"));
    await runSearch(page);
    const first = assetList(page).getByRole("listitem").first();
    await expect(first).toBeVisible();
    await page.getByRole("button", { name: /^Ver detalles: /i }).first().click();
    await expect(page.getByRole("dialog", { name: "Detalles del elemento" })).toContainText("(beta)");
    await page.keyboard.press("Escape");
    const png = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar: / }).first().click());
    expect(png.filename).toMatch(/^p0\d-(firma|iniciales)-01\.png$/);
    expect(png.bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  test("un documento sin firmas (tablas y graficos) no inventa ninguna", async ({ page }) => {
    await openRealEngine(page, await corpusUpload("vector-decoys"));
    await runSearch(page);
    await expect(page.locator("[data-extract-heading]")).toContainText("No encontramos");
    await expect(page.locator("[data-extract-empty]")).toContainText("recortar una región");
  });
});

test.describe("extract-assets · motor real · guardar en Firmas guardadas", () => {
  test("firmante NUEVO con la firma y despues las iniciales al MISMO firmante: imagen limpia, forma identica a la incrustada", async ({ page }) => {
    const upload = await corpusUpload("optimus-2signers", "Contrato Pérez.pdf");
    await openRealEngine(page, upload);
    await runSearch(page);
    const embedded = await embeddedImages(upload.buffer);

    await page.getByRole("button", { name: /^Guardar en Firmas guardadas: Firma probable, página 3/ }).first().click();
    const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("radio", { name: "Firma", exact: true })).toBeChecked();
    await sheet.locator("[data-extract-save-name]").fill("Ana Pérez");
    await sheet.getByLabel("Cargo (opcional)").fill("Ajustadora");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
    await sheet.getByRole("button", { name: "Cerrar", exact: true }).first().click();
    await expect(sheet).toBeHidden();

    let rows = await readVault(page);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.origin).toBe("extracted");
    expect(row.sourceDocument).toBe("Contrato Pérez.pdf");
    expect(row.initialsHash).toBeNull();
    // Imagen LIMPIA: fondo transparente (esquinas con alfa 0), mucha transparencia y tinta azul o negra de verdad.
    expect(row.signature!.corners).toEqual([0, 0, 0, 0]);
    expect(row.signature!.transparent).toBeGreaterThan(0.5);
    expect(row.signature!.opaque).toBeGreaterThan(0.02);
    // La FORMA coincide con una de las dos firmas incrustadas por signPdfMulti (alfa a 48 x 16 casillas, IoU >= 0,7).
    const saved = await vaultGrid(page, "Ana Pérez", "signature");
    const best = Math.max(...embedded.filter((image) => image.width === 300 && image.height === 90).map((image) => gridIou(saved, pixelGrid(image))));
    expect(best, "forma de la firma guardada frente a la incrustada").toBeGreaterThan(0.7);

    // Iniciales al mismo firmante: una sola entrada con las dos imagenes.
    await page.getByRole("button", { name: /^Guardar en Firmas guardadas: Iniciales probables/ }).first().click();
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("radio", { name: "Iniciales", exact: true })).toBeChecked();
    await sheet.getByRole("radio", { name: /^Ana Pérez/ }).check();
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Iniciales añadidas a Ana Pérez");
    rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(row.id);
    expect(rows[0].initialsHash).not.toBeNull();
    expect(rows[0].initials!.corners).toEqual([0, 0, 0, 0]);
    expect(rows[0].role).toBe("Ajustadora");
  });

  test("la segunda firma a OTRO firmante nuevo crea una segunda entrada y deja la primera intacta", async ({ page }) => {
    await openRealEngine(page, await corpusUpload("optimus-2signers"));
    await runSearch(page);
    const cards = page.getByRole("button", { name: /^Guardar en Firmas guardadas: Firma probable, página 3/ });
    for (const [index, name] of ["Ana Pérez", "Luis Gómez"].entries()) {
      await cards.nth(index).click();
      const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
      await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
      if (index > 0) await sheet.getByRole("radio", { name: "Nuevo firmante" }).check();
      await sheet.locator("[data-extract-save-name]").fill(name);
      await sheet.locator("[data-extract-save-submit]").click();
      await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
      await sheet.getByRole("button", { name: "Cerrar", exact: true }).first().click();
      await expect(sheet).toBeHidden();
    }
    const rows = await readVault(page);
    expect(rows.map((row) => row.signerName)).toEqual(["Ana Pérez", "Luis Gómez"]);
    expect(rows[0].signatureHash).not.toBe(rows[1].signatureHash);
    // Las dos formas son distintas entre si (no se guardo dos veces la misma).
    const first = await vaultGrid(page, "Ana Pérez", "signature");
    const second = await vaultGrid(page, "Luis Gómez", "signature");
    expect(gridIou(first, second)).toBeLessThan(0.6);
  });
});

test.describe("extract-assets · motor real · recortar region de una pagina escaneada y usarla al firmar", () => {
  test("recorte -> guardar -> Firmar PDF -> el PDF final incluye esa firma (forma comparada por pixeles)", async ({ page }) => {
    await page.addInitScript((key) => {
      try {
        window.localStorage.setItem(key, "1");
      } catch {
        /* almacenamiento bloqueado */
      }
    }, PRIVACY_SEEN_KEY);
    await openRealEngine(page, await corpusUpload("scanned-page", "escaneo.pdf"));
    await runSearch(page);
    // Una pagina escaneada: no se separa sola; se avisa y se ofrece recortar.
    await expect(page.locator('[data-notice="scanned-page"]')).toContainText("La página 1 es un escaneo");
    await page.locator('[data-notice="scanned-page"]').getByRole("button").click();
    const rect = page.locator("[data-region-rect]");
    await expect(rect).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => !!document.querySelector("[data-region-page-canvas] canvas")), { timeout: 30_000 }).toBe(true);
    // La firma esta abajo a la derecha (54-87 % de ancho, 82-90 % de alto): se lleva el rectangulo con el teclado.
    await rect.focus();
    for (let i = 0; i < 42; i += 1) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 14; i += 1) await page.keyboard.press("ArrowDown");
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 90_000 });
    await page.locator("[data-region-save]").click();
    const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await sheet.locator("[data-extract-save-name]").fill("Marta Díaz");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
    const rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("extracted");
    expect(rows[0].signature!.corners).toEqual([0, 0, 0, 0]);
    expect(rows[0].signature!.opaque).toBeGreaterThan(0.01);
    const [r, , b] = [rows[0].signature!.ink!.r, 0, rows[0].signature!.ink!.b];
    expect(b).toBeGreaterThan(r + 30); // tinta azul
    const saved = await vaultGrid(page, "Marta Díaz", "signature");

    // Usarla al firmar un documento y descargar: el PDF final lleva esa firma incrustada.
    const base = await makeColoredPdf("Anexo");
    await page.goto("/sign-pdf");
    await pdfInput(page).setInputFiles({ name: "anexo.pdf", mimeType: "application/pdf", buffer: base });
    await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
    await openVault(page);
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Usar la firma de Marta Díaz" }).click();
    await expect(page.getByRole("group", { name: /firma colocada/i }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Procesar" }).click();
    await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
    const signed = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar" }).click();
    });
    const images = await embeddedImages(signed);
    expect(images.length).toBeGreaterThanOrEqual(1);
    const best = Math.max(...images.map((image) => gridIou(saved, pixelGrid(image))));
    expect(best, "forma de la firma recortada frente a la que lleva el PDF final").toBeGreaterThan(0.7);
  });
});

test.describe("extract-assets · motor real · errores, cancelar y topes", () => {
  test("PDF roto y PDF cifrado con contrasena: se rechazan antes de buscar y el boton explica por que", async ({ page }) => {
    await setLanguage(page, "es");
    await page.goto("/extract-assets");
    await pdfInput(page).setInputFiles({ name: "roto.pdf", mimeType: "application/pdf", buffer: Buffer.from("no es un pdf, es texto") });
    await expect(page.locator("[data-error-banner]")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: RUN_LABEL.es })).toBeDisabled();
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText("secreto", { x: 10, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    await doc.encrypt({ userPassword: "abc", ownerPassword: "own" });
    await pdfInput(page).setInputFiles(pdfUpload("cifrado.pdf", Buffer.from(await doc.save())));
    await expect(page.locator("[data-error-banner], [role=dialog]").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText("Algo ha fallado");
  });

  test("PDF cifrado solo con restricciones (sin contrasena de apertura): la pantalla lo explica y manda a Desbloquear PDF", async ({ page }) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 300]).drawText("Hola", { x: 20, y: 200, size: 12, font });
    await doc.encrypt({ userPassword: "", ownerPassword: "propietario", permissions: { printing: false } });
    await openRealEngine(page, pdfUpload("restringido.pdf", Buffer.from(await doc.save())));
    const banner = page.locator("[data-error-banner]");
    await expect(banner).toContainText("protegido con contraseña", { timeout: 30_000 });
    await expect(banner.getByRole("link", { name: "Desbloquear PDF" })).toHaveAttribute("href", "/unlock-pdf");
    await expect(page.getByRole("button", { name: RUN_LABEL.es })).toBeDisabled();
  });

  test("cancelar a mitad: aviso en la region viva, vuelve a la carga y no queda ningun resultado", async ({ page }) => {
    await openRealEngine(page, await scalePdf(60, 120, 500, 400));
    await page.getByRole("button", { name: RUN_LABEL.es }).click();
    const overlay = page.getByRole("dialog");
    await expect(overlay).toContainText(/Página \d+ de 60/, { timeout: 30_000 });
    await overlay.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.locator("[data-extract-status]")).toHaveText("Búsqueda cancelada.");
    await expect(page.getByRole("button", { name: RUN_LABEL.es })).toBeFocused();
    await expect(page.locator("[data-extract-heading]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Algo ha fallado");
  });

  test("más de 300 paginas: analiza las primeras 300, avisa y deja elegir un rango que se vuelve a pedir", async ({ page }) => {
    test.setTimeout(420_000);
    const { encodePngBytes } = await import("../../src/lib/image/inkPng");
    const { logoRaster } = await import("../../src/lib/pdf/extractAssets/__fixtures__/classify/rasters");
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const logo = await doc.embedPng(await encodePngBytes(logoRaster({ seed: 7 })));
    for (let i = 0; i < 320; i += 1) {
      const sheet = doc.addPage([200, 200]);
      sheet.drawText(`P${i + 1}`, { x: 20, y: 100, size: 12, font });
      // Un elemento en la pagina 5 (dentro de las 300 primeras) y otro en la 310 (solo con el rango).
      if (i === 4) sheet.drawImage(logo, { x: 20, y: 140, width: 60, height: 19 });
      if (i === 309) sheet.drawImage(logo, { x: 90, y: 20, width: 60, height: 19 });
    }
    await openRealEngine(page, pdfUpload("largo.pdf", Buffer.from(await doc.save({ useObjectStreams: true }))));
    await runSearch(page, "es", 300_000);
    await expect(page.locator('[data-notice="too-many-pages"]')).toContainText("320 páginas");
    await expect(page.locator("[data-extract-heading]")).toHaveText("Encontramos 1 elemento en 300 páginas.");
    await expect(assetList(page).getByRole("listitem")).toHaveCount(1);
    const form = page.locator("[data-extract-range]");
    await form.getByLabel("Desde la página").fill("301");
    await form.getByLabel("Hasta la página").fill("320");
    await form.getByRole("button", { name: "Buscar en este rango" }).click();
    await expect(page.locator("[data-extract-heading]")).toHaveText("Encontramos 1 elemento en 20 páginas.", { timeout: 120_000 });
    await expect(page.locator('[data-notice="too-many-pages"]')).toHaveCount(0);
    // El elemento del rango es el de la pagina 310, no el de la 5.
    await expect(assetList(page).getByRole("listitem", { name: /página 310/ })).toHaveCount(1);
  });
});

test.describe("extract-assets · motor real · rendimiento", () => {
  test("20 paginas con 30 imagenes de 800 x 600: dentro del presupuesto, sin tareas largas y con memoria acotada", async ({ page, browserName }, testInfo) => {
    const ipad = testInfo.project.name === "webkit-ipad";
    await openRealEngine(page, await scalePdf(20, 30, 800, 600));
    // Calentamiento: la primera busqueda carga pdf.js y su worker; el presupuesto se mide en la segunda (worker caliente).
    await runSearch(page);
    await page.getByRole("button", { name: "Empezar con otro PDF" }).click();
    await pdfInput(page).setInputFiles(await scalePdf(20, 30, 800, 600));
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[]; __gap: number; __peak: number };
      w.__long = [];
      w.__gap = 0;
      w.__peak = 0;
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        w.__gap = Math.max(w.__gap, now - last);
        last = now;
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        if (memory) w.__peak = Math.max(w.__peak, memory.usedJSHeapSize);
      }, 10);
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__long.push(Math.round(entry.duration));
        }).observe({ type: "longtask" });
      } catch {
        /* solo Chromium */
      }
    });
    const started = Date.now();
    await page.getByRole("button", { name: RUN_LABEL.es }).click();
    await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout: 120_000 });
    const ms = Date.now() - started;
    const stats = await page.evaluate(() => {
      const w = window as unknown as { __long: number[]; __gap: number; __peak: number };
      return { long: w.__long, gap: w.__gap, peakMb: w.__peak / 1048576 };
    });
    console.log(`[extract-core] ${testInfo.project.name}/${browserName}: 20 paginas x 30 imagenes en ${ms} ms; tarea larga max ${Math.max(0, ...stats.long)} ms; hueco max ${stats.gap.toFixed(0)} ms; pico de heap JS ${stats.peakMb.toFixed(0)} MB`);
    await expect(page.locator("[data-extract-heading]")).toHaveText("Encontramos 30 elementos en 20 páginas.");
    expect(ms).toBeLessThan((ipad ? 4000 : 2000) * SLACK);
    for (const duration of stats.long) expect(duration).toBeLessThan(100 * SLACK);
    expect(stats.gap).toBeLessThan(250 * SLACK);
    if (stats.peakMb > 0) expect(stats.peakMb).toBeLessThan(400);
  });
});
