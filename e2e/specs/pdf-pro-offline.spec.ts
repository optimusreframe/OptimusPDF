import { PDFDocument } from "@cantoo/pdf-lib";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageText, requiresPassword } from "../helpers/pdf-inspection";
import { isEncrypted } from "../helpers/pdf-structure";
import { makeImage, makePdf } from "../helpers/test-files";
import { closeSheetIfOpen, goToTab, isMobile, openProPdf, openSaveMenu, S, watchUploads } from "../helpers/pro-flow";
import { es } from "../../src/lib/locales/es";
import { PAGE_NUMBERS_STRINGS } from "../../src/app/add-page-numbers/strings";
import { WATERMARK_STRINGS } from "../../src/app/add-watermark/strings";
import { PDF_TO_TEXT_STRINGS } from "../../src/app/pdf-to-text/strings";
import { PROTECT_STRINGS } from "../../src/app/protect-pdf/strings";

/**
 * PDF Pro · SIN CONEXION (Wave 7 · cierre), navegador real y headless: se carga `/pdf-pro` EN LINEA, se corta la red
 * (`context.setOffline(true)`, `navigator.onLine === false`) y se comprueba que lo que no necesita red sigue
 * funcionando, y que lo que si la necesita lo dice con claridad.
 *
 * Como se mide (importante para leer los resultados):
 *  - «PDF abierto en linea»: el PDF se abre ANTES de cortar la red (pdf.js y su worker ya estan cargados); es lo que le
 *    pasa a quien pierde la conexion trabajando. «Desde el principio» corta la red nada mas cargar la pagina.
 *  - Peticiones fallidas: se vigilan TODAS las que fallan (`requestfailed`) y los `console.error` de la pagina. Se
 *    descartan solo las precargas RSC de `<Link>` (`?_rsc=`): barra lateral, pie y herramientas sueltas, ajenas a PDF Pro,
 *    que fallan con cualquier corte (p. ej. `GET /organize-pdf?_rsc=…`, `/split-pdf?_rsc=…`, `/settings?_rsc=…`).
 *  - Sin guardian de consola: cortar la red hace que Chromium escriba «Failed to load resource» por cada recurso; aqui
 *    la comprobacion es explicita (`watchNetwork`).
 *
 * HISTORIA (defectos que esta prueba encontro y que se arreglaron en la misma unidad): pdf.js y su worker no estaban
 * en cache (`/pdf.worker.min.mjs` salia con `max-age=0`: cada documento nuevo lo revalidaba y sin red fallaba), `getPdfJs()`
 * cacheaba el `import()` fallido, `createInputGuard` llamaba «dañado» a un PDF sano cuando faltaba un componente y los motores
 * de exportacion ni lo explicaban. Ahora: worker versionado con cache de un año, pdf.js + worker se precargan con la
 * pagina (`data-pro-warm`), texto/Markdown/JSON se precargan en reposo con un documento abierto (`data-pro-engines`),
 * y un componente sin descargar es el error `offline` («conéctate y vuelve a intentarlo»), nunca «dañado» ni «Algo ha fallado».
 * Los motores PESADOS (Word, Excel, PowerPoint, imagenes en ZIP) siguen siendo carga diferida: sin red y sin haberlos
 * usado antes, la tarjeta lo dice con `offline`.
 */

const T = S.docTools;
const E = S.export;
const ROTATE = S.operations.rotateAll90;

test.use({ locale: "es-ES" });
test.setTimeout(90_000);

const VIEWPORTS = [
  { name: "escritorio 1280×800", viewport: { width: 1280, height: 800 }, touch: false },
  { name: "movil 375×812 tactil", viewport: { width: 375, height: 812 }, touch: true },
] as const;

/* ------------------------------------------------------------------ *
 * Vigilancia de la red y corte de la conexion
 * ------------------------------------------------------------------ */

type NetWatch = {
  /** Peticiones que fallaron (sin las precargas RSC): `METODO /ruta (error)`. */
  failed: string[];
  /** `console.error` de la pagina (sin los de las precargas RSC): `texto @ /ruta`. */
  consoleErrors: string[];
  /** Excepciones no capturadas de la pagina. */
  pageErrors: string[];
};

/** Precarga de rutas de `<Link>`: ajena a PDF Pro y falla con cualquier corte de red. */
const isRoutePrefetch = (url: string): boolean => url.includes("_rsc=");
const shortUrl = (url: string): string => url.replace(/^https?:\/\/localhost:\d+/, "");

function watchNetwork(page: Page): NetWatch {
  const watch: NetWatch = { failed: [], consoleErrors: [], pageErrors: [] };
  page.on("requestfailed", (request) => {
    if (isRoutePrefetch(request.url())) return;
    watch.failed.push(`${request.method()} ${shortUrl(request.url())} (${request.failure()?.errorText ?? "?"})`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url ?? "";
    if (isRoutePrefetch(url)) return;
    watch.consoleErrors.push(`${message.text()} @ ${shortUrl(url)}`);
  });
  page.on("pageerror", (error) => watch.pageErrors.push(error.message));
  return watch;
}

/** Abre un PDF EN LINEA y espera a que el visor pinte su primera pagina (pdf.js y su worker ya cargados). */
async function openOnline(
  page: Page,
  options: { name?: string; pages?: number; label?: string; bytes?: Buffer } = {},
): Promise<{ bytes: Buffer; net: NetWatch }> {
  const net = watchNetwork(page);
  const bytes = await openProPdf(page, options);
  await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
  return { bytes, net };
}

async function goOffline(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(true);
  expect(await page.evaluate(() => navigator.onLine), "el navegador cree estar sin conexion").toBe(false);
}

async function goOnline(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect(await page.evaluate(() => navigator.onLine), "el navegador vuelve a estar en linea").toBe(true);
}

/* ------------------------------------------------------------------ *
 * Ayudas de la suite
 * ------------------------------------------------------------------ */

const topBar = (page: Page): Locator => page.locator('[data-pro-region="top"]');
const status = (page: Page): Locator => page.getByRole("status");
const historyList = (page: Page): Locator => page.getByRole("list", { name: S.suite.historyTitle });
const grid = (page: Page): Locator => page.getByRole("listbox", { name: /Páginas del documento/ });

async function noHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
}

async function focusNotBody(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null), { message: "el foco nunca queda en <body>" })
    .toBe(true);
}

/** Descarga el documento actual con «Descargar» (cierra antes cualquier hoja abierta en movil). */
async function downloadDoc(page: Page): Promise<{ bytes: Buffer; filename: string }> {
  await closeSheetIfOpen(page);
  return downloadFile(page, () => topBar(page).getByRole("button", { name: S.suite.download, exact: true }).click());
}

/** Pulsa y espera una descarga con un tope corto (las comprobaciones de «no descarga» no deben esperar el tiempo de la prueba entera). */
async function downloadWithin(page: Page, timeout: number, action: () => Promise<void>): Promise<{ filename: string }> {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout }), action()]);
  return { filename: download.suggestedFilename() };
}

async function rotationsOf(bytes: Buffer): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => ((p.getRotation().angle % 360) + 360) % 360);
}

/** Pasos del historial (escritorio: panel Inicio; movil: dentro de la hoja, que se cierra despues). */
async function historySteps(page: Page): Promise<number> {
  await closeSheetIfOpen(page);
  await goToTab(page, "home");
  const count = await historyList(page).getByRole("listitem").count();
  await closeSheetIfOpen(page);
  return count;
}

/** Abre una herramienta de documento de «Inicio» (en movil, abre la hoja del panel si no lo esta). */
async function openDocTool(page: Page, title: string): Promise<void> {
  if (isMobile(page)) {
    if (!(await page.getByRole("dialog").isVisible())) await goToTab(page, "home");
  } else {
    await goToTab(page, "home");
  }
  await page.getByRole("button", { name: T.launcher.open(title), exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
}

async function applyDocTool(page: Page, announced: string): Promise<void> {
  await page.getByRole("button", { name: T.runner.apply, exact: true }).click();
  await expect(status(page)).toHaveText(S.announce.applied(announced));
  await page.getByRole("button", { name: T.launcher.back, exact: true }).click();
}

/** Espera a que un elemento deje de moverse (la hoja movil entra con un muelle de ~1 s). */
async function waitUntilStill(locator: Locator): Promise<void> {
  let previous = "";
  let still = 0;
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        const now = box ? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}` : "";
        still = now !== "" && now === previous ? still + 1 : 0;
        previous = now;
        return still;
      },
      { intervals: [80], timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

async function openPagesPanel(page: Page): Promise<void> {
  await goToTab(page, "pages");
  await expect(grid(page)).toBeVisible();
  await expect(grid(page).getByRole("option").first()).toBeVisible();
  if (isMobile(page)) await waitUntilStill(page.getByRole("dialog").last());
}

/** Cierra la hoja del organizador (movil): con paginas seleccionadas, Esc primero suelta la seleccion, asi que se usa «Cerrar». */
async function closePagesPanel(page: Page): Promise<void> {
  if (!isMobile(page)) return;
  await page.getByRole("dialog").last().getByRole("button", { name: es.common.close, exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Abre «Más acciones» y elige una opcion del menu. */
async function chooseFromMoreMenu(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: S.shell.more }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

/** Abre la pestaña Convertir UNA vez (en movil, su hoja) y devuelve el localizador de una tarjeta. */
async function openConvert(page: Page): Promise<void> {
  await closeSheetIfOpen(page);
  await goToTab(page, "convert");
  await expect(page.locator('[data-export="text"]')).toBeVisible();
}

async function exportCard(page: Page, id: string): Promise<Locator> {
  const card = page.locator(`[data-export="${id}"]`);
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  return card;
}

/** PDF «escaneado»: cada pagina es una imagen y no tiene texto (el OCR es lo unico que puede leerla). */
async function scanLikePdf(pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([300, 400]);
    const png = await doc.embedPng(makeImage("png", 160, 120, 5 + index));
    page.drawImage(png, { x: 10, y: 100, width: 280, height: 210 });
  }
  return Buffer.from(await doc.save());
}

/* ------------------------------------------------------------------ *
 * Lo que SIGUE funcionando sin conexion (PDF ya abierto en linea)
 * ------------------------------------------------------------------ */

for (const project of VIEWPORTS) {
  test.describe(`PDF Pro · sin conexion · ${project.name}`, () => {
    test.use({ viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

    test("rotar, deshacer, rehacer y descargar funcionan, sin subir nada y sin excepciones de la pagina", async ({ page, context }) => {
      const uploads = watchUploads(page);
      const { net } = await openOnline(page, { name: "informe.pdf", pages: 3, label: "OFF" });
      await goOffline(page, context);

      // Rotar todas: un snapshot nuevo, anunciado y marcado como sin guardar.
      await goToTab(page, "home");
      await page.getByRole("button", { name: ROTATE, exact: true }).click();
      await closeSheetIfOpen(page);
      await expect(status(page)).toHaveText(S.announce.applied(ROTATE));
      await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
      expect(await historySteps(page)).toBe(2);

      // Descargar: el PDF sale girado y con el nombre de siempre.
      const rotated = await downloadDoc(page);
      expect(rotated.filename).toBe("informe-pro.pdf");
      expect(await rotationsOf(rotated.bytes)).toEqual([90, 90, 90]);
      await expect(status(page)).toHaveText(S.save.downloaded("informe-pro.pdf"));
      await expect(page.getByText(S.suite.saved).first()).toBeVisible();

      // Deshacer y rehacer con los botones de la barra.
      await topBar(page).getByRole("button", { name: S.suite.undo }).click();
      await expect(status(page)).toHaveText(S.announce.undone(ROTATE));
      expect(await rotationsOf((await downloadDoc(page)).bytes)).toEqual([0, 0, 0]);
      await topBar(page).getByRole("button", { name: S.suite.redo }).click();
      await expect(status(page)).toHaveText(S.announce.redone(ROTATE));
      expect(await rotationsOf((await downloadDoc(page)).bytes)).toEqual([90, 90, 90]);

      await focusNotBody(page);
      await noHorizontalOverflow(page);
      expect(uploads.requests, "sin conexion no se sube nada (y con conexion tampoco)").toEqual([]);
      expect(net.pageErrors, "ninguna excepcion no capturada de la pagina").toEqual([]);
    });

    test("organizar paginas: eliminar una y aplicar crea un snapshot y se descarga con una pagina menos", async ({ page, context }) => {
      const { net } = await openOnline(page, { name: "libro.pdf", pages: 3, label: "ORG" });
      await goOffline(page, context);
      await openPagesPanel(page);
      await grid(page).getByRole("option", { name: /^Página 2 de/ }).click();
      await page.getByRole("button", { name: S.pages.actions.remove, exact: true }).click();
      await expect(grid(page).getByRole("option")).toHaveCount(2);
      await page.getByRole("button", { name: S.pages.status.apply, exact: true }).click();
      await expect(page.locator("[data-pages-chip]")).toHaveText(S.pages.status.noChanges, { timeout: 30_000 });
      await closePagesPanel(page);
      const out = await downloadDoc(page);
      expect(await getPageCount(out.bytes)).toBe(2);
      expect(await getPageText(out.bytes, 1)).toContain("ORG-1");
      expect(await getPageText(out.bytes, 2)).toContain("ORG-3");
      expect(net.pageErrors).toEqual([]);
    });

    test("Guardar con contraseña funciona sin conexion: descarga cifrado, no toca el historial y no pide nada a la red", async ({ page, context }) => {
      const { net } = await openOnline(page, { name: "informe.pdf", pages: 3 });
      await goOffline(page, context);
      const before = await historySteps(page);
      const menu = await openSaveMenu(page);
      await menu.getByRole("menuitem", { name: S.save.saveWithPassword }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(PROTECT_STRINGS.es.passwordLabel, { exact: true }).fill("secreto1");
      await dialog.getByLabel(PROTECT_STRINGS.es.confirmLabel, { exact: true }).fill("secreto1");
      const file = await downloadFile(page, async () => {
        await dialog.getByRole("button", { name: T.protect.saveButton, exact: true }).click();
      });
      expect(file.filename).toBe("informe-protegido.pdf");
      expect(await isEncrypted(file.bytes)).toBe(true);
      expect(await requiresPassword(file.bytes)).toBe(true);
      expect(await getPageCount(file.bytes, "secreto1")).toBe(3);
      await dialog.waitFor({ state: "hidden" }).catch(() => undefined);
      if (await dialog.isVisible()) await page.keyboard.press("Escape");
      expect(await historySteps(page)).toBe(before);
      // Cifrar es 100 % local (pdf-lib): ninguna peticion fallida de la web, ni siquiera el worker de pdf.js.
      expect(net.failed, "guardar con contraseña no necesita red").toEqual([]);
      expect(net.consoleErrors).toEqual([]);
      expect(net.pageErrors).toEqual([]);
    });

    test("nuevo documento en blanco y nuevo PDF desde imagenes se crean sin conexion y se descargan validos", async ({ page, context }) => {
      const { net } = await openOnline(page, { name: "base.pdf", pages: 2 });
      await goOffline(page, context);

      await chooseFromMoreMenu(page, S.create.menu.newBlank);
      const blank = page.getByRole("dialog");
      await expect(blank).toBeVisible();
      await blank.getByRole("button", { name: S.create.blank.create }).click();
      await expect(page.getByRole("heading", { level: 1, name: /documento-en-blanco\.pdf/ })).toBeVisible();
      await expect(page.getByText(S.suite.pageCount(1)).first()).toBeVisible();
      expect(await getPageCount((await downloadDoc(page)).bytes)).toBe(1);

      await page.locator("[data-pro-create-input]").setInputFiles([
        { name: "uno.png", mimeType: "image/png", buffer: makeImage("png", 120, 80, 2) },
        { name: "dos.jpg", mimeType: "image/jpeg", buffer: makeImage("jpeg", 120, 80, 3) },
      ]);
      const images = page.getByRole("dialog");
      await expect(images).toBeVisible();
      await images.getByRole("button", { name: S.create.images.create }).click();
      await expect(page.getByRole("heading", { level: 1, name: /imagenes\.pdf/ })).toBeVisible();
      await expect(page.getByText(S.suite.pageCount(2)).first()).toBeVisible();
      expect(await getPageCount((await downloadDoc(page)).bytes)).toBe(2);
      expect(net.pageErrors).toEqual([]);
    });

    test("los modos Editar, Anotar y Firmar se pueden abrir y cerrar con «Descartar», sin cambiar el documento", async ({ page, context }) => {
      const { net } = await openOnline(page, { name: "informe.pdf", pages: 3 });
      await goOffline(page, context);
      for (const tab of ["edit", "annotate", "sign"] as const) {
        await goToTab(page, tab);
        await expect(page.locator("[data-pro-mode-host]")).toBeVisible({ timeout: 15_000 });
        await page.locator("[data-pro-mode-discard]").click();
        await expect(page.locator("[data-pro-mode-host]")).toBeHidden();
        await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible();
        await focusNotBody(page);
      }
      expect(await historySteps(page), "entrar y salir de un modo sin aplicar no cambia el historial").toBe(1);
      await expect(page.getByText(S.suite.saved).first()).toBeVisible();
      expect(net.pageErrors).toEqual([]);
    });

    test("OCR: sin conexion el aviso dice que las paginas escaneadas no se reconoceran; al reconectar cambia, y sin OCR desaparece", async ({
      page,
      context,
    }) => {
      await openOnline(page, { name: "informe.pdf", pages: 3 });
      await goOffline(page, context);
      await openConvert(page);
      const withOcr = ["text", "markdown", "json", "word"] as const;
      const withoutOcr = ["images", "excel", "csv", "powerpoint"] as const;
      for (const id of withOcr) {
        const card = await exportCard(page, id);
        await expect(card.locator("[data-export-network]"), `${id}: aviso sin conexion`).toHaveText(E.card.ocrOffline);
      }
      for (const id of withoutOcr) {
        const card = await exportCard(page, id);
        await expect(card.locator("[data-export-network]"), `${id}: no usa OCR, sin aviso de red`).toHaveCount(0);
      }

      await goOnline(page, context);
      for (const id of withOcr) {
        const card = await exportCard(page, id);
        await expect(card.locator("[data-export-network]"), `${id}: aviso al reconectar`).toHaveText(E.card.ocrNetwork);
      }
      // Cortar otra vez devuelve el aviso de «sin conexion».
      await goOffline(page, context);
      const text = await exportCard(page, "text");
      await expect(text.locator("[data-export-network]")).toHaveText(E.card.ocrOffline);
      await expect(text.getByText(E.card.mayNeedNetwork, { exact: true })).toBeVisible();

      // Apagar el OCR de «Texto» quita el aviso: ya no depende de la red.
      await text.getByRole("button", { name: E.card.showOptions }).click();
      await expect(text.getByRole("checkbox", { name: PDF_TO_TEXT_STRINGS.es.ocrLabel })).toBeChecked();
      // El <input> queda bajo la superposicion de su etiqueta: se pulsa la etiqueta, como haria una persona.
      await text.locator("label", { hasText: PDF_TO_TEXT_STRINGS.es.ocrLabel }).click();
      await expect(text.getByRole("checkbox", { name: PDF_TO_TEXT_STRINGS.es.ocrLabel })).not.toBeChecked();
      await expect(text.locator("[data-export-network]")).toHaveCount(0);
      await expect(text.getByText(E.card.localOnly, { exact: true })).toBeVisible();
      await noHorizontalOverflow(page);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Herramientas de documento (marca de agua y numerar) — escritorio
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · sin conexion · herramientas de documento (escritorio)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("el borrador automatico (IndexedDB) se guarda sin conexion: tras girar queda un borrador y no sale el aviso de borrador fallido", async ({ page, context }) => {
    const { net } = await openOnline(page, { name: "borrador.pdf", pages: 2 });
    await goOffline(page, context);
    await page.getByRole("button", { name: ROTATE, exact: true }).click();
    await expect(status(page)).toHaveText(S.announce.applied(ROTATE));
    // El autoguardado (calma de 600 ms) escribe en la base real del navegador; no necesita red.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<number>((resolve) => {
                const open = indexedDB.open("optimuspdf-pro-drafts");
                open.onerror = () => resolve(-1);
                open.onsuccess = () => {
                  const db = open.result;
                  if (!db.objectStoreNames.contains("draftMeta")) {
                    db.close();
                    resolve(0);
                    return;
                  }
                  const count = db.transaction("draftMeta").objectStore("draftMeta").count();
                  count.onsuccess = () => {
                    db.close();
                    resolve(count.result);
                  };
                };
              }),
          ),
        { timeout: 15_000, message: "hay un borrador guardado en IndexedDB" },
      )
      .toBe(1);
    await expect(page.locator("[data-autosave-issue]"), "ningun aviso de borrador fallido").toHaveCount(0);
    expect(net.pageErrors).toEqual([]);
  });

  test("marca de agua y numerar paginas se aplican, la descarga lleva ambas, y deshacerlas vuelve al original", async ({ page, context }) => {
    const { net } = await openOnline(page, { name: "informe.pdf", pages: 3, label: "SEQ" });
    await goOffline(page, context);

    await openDocTool(page, T.tools.watermark.title);
    await page.getByLabel(WATERMARK_STRINGS.es.textLabel).fill("SIN RED");
    // La vista previa necesita pdf.js (red): sin ella se dice, y aun asi se puede aplicar (nunca se queda en «Preparando…»).
    await expect(page.locator("[data-preview]")).toHaveAttribute("data-preview", /^(ready|unavailable)$/, { timeout: 20_000 });
    await applyDocTool(page, T.labels.watermarkText("SIN RED"));

    await openDocTool(page, T.tools["page-numbers"].title);
    await page.getByRole("radio", { name: PAGE_NUMBERS_STRINGS.es.formatPageNofP, exact: true }).click();
    await applyDocTool(page, T.labels.pageNumbers);
    expect(await historySteps(page)).toBe(3);

    const out = await downloadDoc(page);
    expect(await getPageCount(out.bytes)).toBe(3);
    for (let n = 1; n <= 3; n += 1) {
      const text = await getPageText(out.bytes, n);
      expect(text, `pagina ${n}: marca de agua`).toContain("SIN RED");
      expect(text, `pagina ${n}: numeracion`).toContain(`Página ${n} de 3`);
      expect(text, `pagina ${n}: texto original`).toContain(`SEQ-${n}`);
    }

    await topBar(page).getByRole("button", { name: S.suite.undo }).click();
    await topBar(page).getByRole("button", { name: S.suite.undo }).click();
    const original = await downloadDoc(page);
    expect(await getPageText(original.bytes, 1)).not.toContain("SIN RED");
    expect(await getPageText(original.bytes, 1)).not.toContain("Página 1 de 3");
    expect(net.pageErrors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Lo que SI necesita red: se dice con claridad y no se cuelga
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · sin conexion · lo que necesita red", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("exportar texto con OCR de un PDF sin texto, sin conexion, termina en menos de 40 s con un error visible, sin descarga y sin bloquear", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const { net } = await openOnline(page, { name: "escaneado.pdf", bytes: await scanLikePdf(2) });
    await goOffline(page, context);
    await openConvert(page);
    const card = await exportCard(page, "text");
    await expect(card.locator("[data-export-network]")).toHaveText(E.card.ocrOffline);

    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    const started = Date.now();
    await card.getByRole("button", { name: E.formats.text.title }).click();
    await expect(card.locator("[data-error-banner]")).toBeVisible({ timeout: 40_000 });
    const elapsed = Date.now() - started;
    const message = ((await card.locator("[data-error-banner]").innerText()) ?? "").replace(/\s+/g, " ");
    test.info().annotations.push({ type: "ocr-sin-conexion", description: `${elapsed} ms → ${message}` });
    expect(elapsed, "el error llega antes de 40 s (guarda de inactividad del OCR: 20 s)").toBeLessThan(40_000);
    expect(downloaded, "no se descarga nada").toBe(false);

    // La tarjeta queda usable (sin barra de progreso ni «Cancelar») y el documento no cambia.
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    await expect(card.getByRole("button", { name: E.formats.text.title })).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(S.suite.saved).first()).toBeVisible();
    await card.getByRole("button", { name: es.common.close }).click();
    await expect(card.locator("[data-error-banner]")).toHaveCount(0);
    expect(net.pageErrors).toEqual([]);
  });

  test("OCR con el CDN bloqueado (la web si responde): error claro de OCR en menos de 40 s y sin descarga", async ({ page, context }) => {
    await context.route(/cdn\.jsdelivr\.net/, (route) => route.abort("connectionrefused"));
    const { net } = await openOnline(page, { name: "escaneado.pdf", bytes: await scanLikePdf(2) });
    await openConvert(page);
    const card = await exportCard(page, "text");
    await expect(card.locator("[data-export-network]"), "en linea: aviso de que el modelo se descarga").toHaveText(E.card.ocrNetwork);
    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    const started = Date.now();
    await card.getByRole("button", { name: E.formats.text.title }).click();
    const banner = card.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 40_000 });
    expect(Date.now() - started).toBeLessThan(40_000);
    await expect(banner).toContainText(es.tool.errors.ocrNetworkFailure);
    expect(downloaded).toBe(false);
    await expect(card.getByRole("button", { name: E.formats.text.title })).not.toHaveAttribute("aria-disabled", "true");
    // El worker de tesseract.js (codigo de la libreria) escribe su propio «importScripts … failed to load» al no poder
    // bajar su script del CDN; es lo UNICO que se tolera aqui, y solo con el CDN bloqueado a proposito.
    expect(net.pageErrors.filter((message) => !/importScripts.*cdn\.jsdelivr\.net.*failed to load/.test(message))).toEqual([]);
  });

  test("OCR con el CDN colgado (sin respuesta): la guarda de inactividad (~20 s) rinde y avisa antes de 40 s", async ({ page, context }) => {
    test.setTimeout(120_000);
    // Las peticiones al CDN no se contestan nunca: el motor de OCR no da señales de vida.
    await context.route(/cdn\.jsdelivr\.net/, () => new Promise<void>(() => undefined));
    const { net } = await openOnline(page, { name: "escaneado.pdf", bytes: await scanLikePdf(2) });
    await openConvert(page);
    const card = await exportCard(page, "text");
    const started = Date.now();
    await card.getByRole("button", { name: E.formats.text.title }).click();
    // Mientras espera, se ve el progreso y se puede cancelar.
    await expect(card.getByRole("progressbar")).toBeVisible();
    await expect(card.getByRole("button", { name: E.card.cancel })).toBeVisible();
    const banner = card.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 40_000 });
    const elapsed = Date.now() - started;
    test.info().annotations.push({ type: "ocr-cdn-colgado", description: `${elapsed} ms` });
    expect(elapsed, "no responde en 20 s: la guarda rinde (no antes)").toBeGreaterThanOrEqual(15_000);
    expect(elapsed).toBeLessThan(40_000);
    await expect(banner).toContainText(es.tool.errors.ocrNetworkFailure);
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    expect(net.pageErrors).toEqual([]);
  });

  test("OCR con el CDN colgado: «Cancelar» corta la espera al momento y la tarjeta vuelve a estar lista", async ({ page, context }) => {
    await context.route(/cdn\.jsdelivr\.net/, () => new Promise<void>(() => undefined));
    await openOnline(page, { name: "escaneado.pdf", bytes: await scanLikePdf(2) });
    await openConvert(page);
    const card = await exportCard(page, "text");
    await card.getByRole("button", { name: E.formats.text.title }).click();
    const cancel = card.getByRole("button", { name: E.card.cancel });
    await expect(cancel).toBeVisible();
    const started = Date.now();
    await cancel.click();
    await expect(card.getByText(E.card.cancelled)).toBeVisible({ timeout: 8_000 });
    expect(Date.now() - started).toBeLessThan(8_000);
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    await expect(card.getByRole("button", { name: E.formats.text.title })).not.toHaveAttribute("aria-disabled", "true");
    await expect(card.locator("[data-error-banner]")).toHaveCount(0);
  });

  test("la herramienta «Reconocer texto (OCR)» avisa de que necesita conexion (insignia y nota) y, sin red, «Aplicar» termina con un error visible sin añadir pasos", async ({
    page,
    context,
  }) => {
    const { net } = await openOnline(page, { name: "escaneado.pdf", bytes: await scanLikePdf(2) });
    await goOffline(page, context);
    await goToTab(page, "home");
    const launcher = page.getByRole("button", { name: T.launcher.open(T.tools.ocr.title), exact: true });
    await expect(launcher, "el listado ya dice que requiere conexion").toContainText(T.runner.networkBadge);
    await launcher.click();
    const note = page.locator("[data-needs-network]");
    await expect(note).toContainText(T.runner.networkBadge);
    await expect(note).toContainText(T.runner.networkBody);
    await page.getByRole("button", { name: T.runner.apply, exact: true }).click();
    const panel = page.locator("[data-doc-tool='ocr']");
    await expect(panel.locator("[data-error-banner]")).toBeVisible({ timeout: 40_000 });
    await expect(panel.getByRole("button", { name: T.runner.apply, exact: true })).not.toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: T.launcher.back, exact: true }).click();
    expect(await historySteps(page), "un OCR fallido no añade ningun paso").toBe(1);
    await expect(page.getByText(S.suite.saved).first()).toBeVisible();
    expect(net.pageErrors).toEqual([]);
  });

  test("al reconectar (sin haber intentado nada sin red), texto, Markdown, JSON, imagenes (ZIP) y Word se exportan con su contenido", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const { net } = await openOnline(page, { name: "acta.pdf", pages: 3, label: "ACTA" });
    await goOffline(page, context);
    await openConvert(page);
    await expect((await exportCard(page, "text")).locator("[data-export-network]")).toHaveText(E.card.ocrOffline);
    await goOnline(page, context);
    await expect((await exportCard(page, "text")).locator("[data-export-network]")).toHaveText(E.card.ocrNetwork);

    const text = await exportCard(page, "text");
    const txt = await downloadFile(page, () => text.getByRole("button", { name: E.formats.text.title }).click());
    expect(txt.filename).toBe("acta-texto.txt");
    expect(txt.bytes.toString("utf8")).toContain("ACTA-2");

    const markdown = await exportCard(page, "markdown");
    const md = await downloadFile(page, () => markdown.getByRole("button", { name: E.formats.markdown.title }).click());
    expect(md.filename).toBe("acta-markdown.md");
    expect(md.bytes.toString("utf8")).toContain("ACTA-1");

    const json = await exportCard(page, "json");
    const js = await downloadFile(page, () => json.getByRole("button", { name: E.formats.json.title }).click());
    expect(js.filename).toBe("acta-json.json");
    expect(JSON.parse(js.bytes.toString("utf8"))).toBeTruthy();

    const images = await exportCard(page, "images");
    const zip = await downloadFile(page, () => images.getByRole("button", { name: E.formats.images.title }).click());
    expect(zip.filename).toBe("acta-imagenes.zip");
    expect(zip.bytes.subarray(0, 2).toString("latin1"), "un ZIP empieza por PK").toBe("PK");

    const word = await exportCard(page, "word");
    const docx = await downloadFile(page, () => word.getByRole("button", { name: E.formats.word.title }).click());
    expect(docx.filename).toBe("acta-word.docx");
    expect(docx.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(net.pageErrors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Sin conexion desde el principio (la pagina se cargo en linea y la red se corta antes de abrir nada)
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · sin conexion desde el principio", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("la pagina precarga pdf.js y su worker: el primer PDF abre aunque la red se corte antes de elegirlo", async ({ page, context }) => {
    const net = watchNetwork(page);
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-pro-warm", "ready", { timeout: 30_000 });
    await goOffline(page, context);
    const bytes = await makePdf({ pages: 2, label: "FRIO" });
    await page.locator('input[type="file"]').first().setInputFiles({ name: "frio.pdf", mimeType: "application/pdf", buffer: bytes });
    await expect(page.getByRole("heading", { level: 1, name: /frio\.pdf/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 15_000 });
    expect(net.pageErrors).toEqual([]);
  });

  test("si pdf.js NO se pudo descargar, el aviso lo explica (no culpa al archivo) y al reconectar el mismo PDF abre (si el empaquetador cacheo el fallo, tras recargar)", async ({
    page,
    context,
  }) => {
    const net = watchNetwork(page);
    // Simula una carga en frio: sin `Worker` la precarga no corre; se «devuelve» justo al elegir el archivo.
    await page.addInitScript(() => {
      const RealWorker = window.Worker;
      Object.defineProperty(window, "Worker", {
        configurable: true,
        get: () => ((window as unknown as { __allowWorker?: boolean }).__allowWorker ? RealWorker : undefined),
      });
    });
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await goOffline(page, context);
    await page.evaluate(() => {
      (window as unknown as { __allowWorker?: boolean }).__allowWorker = true;
    });
    const file = { name: "frio.pdf", mimeType: "application/pdf", buffer: await makePdf({ pages: 2, label: "FRIO" }) };
    await page.locator('input[type="file"]').first().setInputFiles(file);
    const banner = page.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(banner).toContainText(es.tool.errors.offline);
    await expect(banner).not.toContainText(es.tool.errors.corrupt);
    await expect(page.locator('[aria-busy="true"]'), "ya no esta «Comprobando el archivo…»").toHaveCount(0);
    await expect(page.locator("main").getByRole("tablist")).toHaveCount(0);
    await expect.poll(() => banner.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // El resto del estado vacio sigue vivo y, al volver la conexion el boton «Recargar la pagina» deja abrir el MISMO PDF.
    await expect(page.locator("[data-pro-new='blank']")).toBeVisible();
    await goOnline(page, context);
    // El aviso no promete un reintento que no ocurre: ofrece «Recargar la página» y eso es lo que hace.
    const reload = banner.getByRole("button", { name: es.tool.errors.reloadAction });
    await expect(reload).toBeVisible();
    await reload.click();
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await expect(page.locator("[data-error-banner]")).toHaveCount(0);
    await page.locator('input[type="file"]').first().setInputFiles(file);
    const opened = page.getByRole("heading", { level: 1, name: /frio\.pdf/ });
    await expect(opened).toBeVisible({ timeout: 30_000 });
    expect(net.pageErrors).toEqual([]);
  });

  test("sin red desde el principio, «Nuevo en blanco» abre un documento nuevo con la suite completa", async ({ page, context }) => {
    const net = watchNetwork(page);
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await goOffline(page, context);
    await page.locator("[data-pro-new='blank']").click();
    await page.getByRole("dialog").getByRole("button", { name: S.create.blank.create }).click();
    await expect(page.getByRole("heading", { level: 1, name: /documento-en-blanco\.pdf/ })).toBeVisible();
    await expect(page.locator("main").getByRole("tab")).toHaveCount(7);
    expect(await getPageCount((await downloadDoc(page)).bytes)).toBe(1);
    expect(net.pageErrors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Con un PDF abierto y la red cortada despues (lo que le pasa a quien pierde la conexion trabajando)
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · sin conexion con un documento abierto", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("«Abrir otro PDF…» sin conexion abre el PDF", async ({ page, context }) => {
    await openOnline(page, { name: "primero.pdf", pages: 2 });
    await goOffline(page, context);
    const chooser = page.waitForEvent("filechooser");
    await chooseFromMoreMenu(page, S.create.menu.openAnother);
    await (await chooser).setFiles({ name: "segundo.pdf", mimeType: "application/pdf", buffer: await makePdf({ pages: 2, label: "SEG" }) });
    await expect(page.getByRole("heading", { level: 1, name: /segundo\.pdf/ })).toBeVisible({ timeout: 15_000 });
  });

  test("tras aplicar una operacion sin conexion el visor muestra el documento nuevo", async ({ page, context }) => {
    await openOnline(page, { name: "informe.pdf", pages: 3 });
    await goOffline(page, context);
    const first = page.locator('article[data-page-index="0"]');
    const before = (await first.boundingBox())!;
    expect(before.height, "paginas verticales antes de girar").toBeGreaterThan(before.width);
    await goToTab(page, "home");
    await page.getByRole("button", { name: ROTATE, exact: true }).click();
    await closeSheetIfOpen(page);
    await expect(status(page)).toHaveText(S.announce.applied(ROTATE));
    await expect
      .poll(async () => {
        const box = await first.boundingBox();
        return !!box && box.width > box.height;
      }, { timeout: 15_000, message: "la primera pagina se ve girada (apaisada)" })
      .toBe(true);
  });

  test("las operaciones sin conexion no provocan peticiones fallidas ni console.error de la web", async ({ page, context }) => {
    const { net } = await openOnline(page, { name: "informe.pdf", pages: 3 });
    await goOffline(page, context);
    await goToTab(page, "home");
    await page.getByRole("button", { name: ROTATE, exact: true }).click();
    await expect(status(page)).toHaveText(S.announce.applied(ROTATE));
    await page.waitForTimeout(1500);
    expect(net.failed, "ninguna peticion de la web falla").toEqual([]);
    expect(net.consoleErrors, "ningun console.error de la web").toEqual([]);
  });

  for (const tab of ["edit", "annotate", "sign"] as const) {
    test(`el modo ${tab} sin conexion muestra las paginas`, async ({ page, context }) => {
      await openOnline(page, { name: "informe.pdf", pages: 3 });
      await goOffline(page, context);
      await goToTab(page, tab);
      await expect(page.locator("[data-pro-mode-host]")).toBeVisible({ timeout: 15_000 });
      // Editar y Anotar marcan cada pagina dibujada (`data-render-state`); Firmar la pinta como imagen (blob:) de la pagina.
      const painted = tab === "sign" ? page.locator('[data-pro-mode-host] img[src^="blob:"]') : page.locator('[data-render-state="ready"]');
      await expect(painted.first()).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("[data-pro-mode-host]")).not.toContainText("parece dañado");
    });
  }

  for (const id of ["text", "markdown", "json"] as const) {
    test(`exportar ${id} sin conexion descarga (los motores ligeros se precargan con el documento)`, async ({ page, context }) => {
      await openOnline(page, { name: "acta.pdf", pages: 3, label: "ACTA" });
      await expect(page.locator("html")).toHaveAttribute("data-pro-engines", "ready", { timeout: 30_000 });
      await goOffline(page, context);
      await openConvert(page);
      const card = await exportCard(page, id);
      await downloadWithin(page, 15_000, () => card.getByRole("button", { name: E.formats[id].title }).click());
    });
  }

  for (const id of ["images", "word"] as const) {
    test(`exportar ${id} sin conexion: descarga o, si su motor pesado no se habia descargado, lo dice (offline), nunca «Algo ha fallado»`, async ({
      page,
      context,
    }) => {
      await openOnline(page, { name: "acta.pdf", pages: 3, label: "ACTA" });
      await goOffline(page, context);
      await openConvert(page);
      const card = await exportCard(page, id);
      const banner = card.locator("[data-error-banner]");
      const outcome = await Promise.race([
        downloadWithin(page, 20_000, () => card.getByRole("button", { name: E.formats[id].title }).click()).then(() => "archivo"),
        banner.waitFor({ state: "visible", timeout: 20_000 }).then(() => "aviso"),
      ]);
      if (outcome === "aviso") {
        await expect(banner).toContainText(es.tool.errors.offline);
        await expect(banner).not.toContainText(es.tool.errors.unknown);
      }
    });
  }

  test("«Reconocer texto (OCR)» sin conexion dice que falta la conexion (componente u OCR), no «Algo ha fallado»", async ({ page, context }) => {
    await openOnline(page, { name: "escaneado.pdf", bytes: await scanLikePdf(2) });
    await goOffline(page, context);
    await goToTab(page, "home");
    await page.getByRole("button", { name: T.launcher.open(T.tools.ocr.title), exact: true }).click();
    await page.getByRole("button", { name: T.runner.apply, exact: true }).click();
    const banner = page.locator("[data-doc-tool='ocr'] [data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 40_000 });
    await expect(banner).toContainText(new RegExp(`${escapeRegExp(es.tool.errors.offline)}|${escapeRegExp(es.tool.errors.ocrNetworkFailure)}`));
  });

  test("exportar texto con OCR de un PDF sin texto, sin conexion: explica que falta la conexion", async ({ page, context }) => {
    await openOnline(page, { name: "escaneado.pdf", bytes: await scanLikePdf(2) });
    await expect(page.locator("html")).toHaveAttribute("data-pro-engines", "ready", { timeout: 30_000 });
    await goOffline(page, context);
    await openConvert(page);
    const card = await exportCard(page, "text");
    await card.getByRole("button", { name: E.formats.text.title }).click();
    const banner = card.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 40_000 });
    await expect(banner).toContainText(new RegExp(`${escapeRegExp(es.tool.errors.offline)}|${escapeRegExp(es.tool.errors.ocrNetworkFailure)}`));
    await expect(banner).not.toContainText(es.tool.errors.unknown);
  });

  test("tras un fallo de exportacion sin red, el aviso ofrece «Recargar la página» y, recargado y reconectado, la exportacion funciona", async ({
    page,
    context,
  }) => {
    await openOnline(page, { name: "acta.pdf", pages: 3, label: "ACTA" });
    await goOffline(page, context);
    await openConvert(page);
    let card = await exportCard(page, "word");
    await card.getByRole("button", { name: E.formats.word.title }).click();
    const banner = card.locator("[data-error-banner]");
    const failed = await banner.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false);
    if (!failed) return; // el motor pesado ya estaba en cache: nada que reintentar
    await expect(banner).toContainText(es.tool.errors.offline);
    // El aviso no promete un reintento que no ocurre (el empaquetador cachea el `import()` fallido): dice que hay que recargar.
    await expect(banner).toContainText(/recarga/i);
    const reload = banner.getByRole("button", { name: es.tool.errors.reloadAction });
    await expect(reload).toBeVisible();
    await goOnline(page, context);
    await reload.click();
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await openOnline(page, { name: "acta.pdf", pages: 3, label: "ACTA" });
    await openConvert(page);
    card = await exportCard(page, "word");
    const file = await downloadWithin(page, 30_000, () => card.getByRole("button", { name: E.formats.word.title }).click());
    expect(file.filename).toBe("acta-word.docx");
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
