import { PDFDocument } from "@cantoo/pdf-lib";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { imageUpload } from "../helpers/test-files";
import { closeSheetIfOpen, focusedDescription, noHorizontalOverflow, openProPdf, openSaveMenu, S, watchUploads } from "../helpers/pro-flow";
import { STRINGS as JPG_TO_PDF_STRINGS } from "../../src/app/jpg-to-pdf/strings";

/**
 * PDF Pro · crear e importar (Wave 7 · U8), navegador real y headless en 1280×800 y 375×812 tactil: nuevo en blanco
 * (tamaño, orientacion, paginas), nuevo desde imagenes (orden, «Ajustar» al tamaño de la imagen), insertar desde HTML
 * (motor real, deshacible), «Abrir otro PDF» con confirmacion y «Reabrir el ultimo documento» tras recargar.
 */

test.setTimeout(120_000);

const C = S.create;
const SE = S.session;

const projects = [
  { name: "escritorio 1280×800", viewport: { width: 1280, height: 800 }, touch: false },
  { name: "movil 375×812 tactil", viewport: { width: 375, height: 812 }, touch: true },
] as const;

async function downloadCurrent(page: Page) {
  await closeSheetIfOpen(page);
  return downloadFile(page, () => page.getByRole("button", { name: S.suite.download, exact: true }).click());
}

async function openMoreItem(page: Page, name: string) {
  await closeSheetIfOpen(page);
  await page.getByRole("button", { name: S.shell.more }).click();
  await page.getByRole("menuitem", { name }).click();
}

for (const project of projects) {
  test.describe(project.name, () => {
    test.use({ locale: "es-ES", viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

    test("Nuevo en blanco: Carta horizontal de 3 paginas, se abre y se descarga con ese tamaño", async ({ page }) => {
      const uploads = watchUploads(page);
      await page.goto("/pdf-pro");
      await page.getByRole("button", { name: SE.newBlank }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: C.blank.letter }).click();
      await dialog.getByRole("radio", { name: C.blank.landscape }).click();
      await dialog.getByLabel(C.blank.pagesLabel).fill("3");
      await dialog.getByRole("button", { name: C.blank.create }).click();
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(C.blank.fileName.replace(".", "\\.")) })).toBeVisible();
      await expect(page.getByText("3 páginas").first()).toBeVisible();
      await expect(page.getByText(S.suite.saved).first()).toBeVisible();
      await expect.poll(() => focusedDescription(page)).not.toBe("<body>");
      const file = await downloadCurrent(page);
      expect(file.filename).toBe(C.blank.fileName);
      const doc = await PDFDocument.load(file.bytes);
      expect(doc.getPageCount()).toBe(3);
      expect(doc.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
      await noHorizontalOverflow(page);
      expect(uploads.requests).toEqual([]);
    });

    test("Nuevo desde imagenes: el orden elegido y «Ajustar» dan paginas del tamaño de cada imagen", async ({ page }) => {
      await page.goto("/pdf-pro");
      const wide = imageUpload("ancha.png", "png", 300, 100, 1);
      const tall = imageUpload("alta.png", "png", 100, 300, 2);
      await page.locator("[data-pro-create-input]").setInputFiles([wide, tall]);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("list", { name: C.images.listLabel })).toBeVisible();
      // La lista sale en el orden elegido; se baja la primera.
      await dialog.getByRole("button", { name: C.images.moveDown("ancha.png") }).click();
      await expect(dialog.getByRole("listitem").first()).toContainText("alta.png");
      await dialog.getByRole("radio", { name: JPG_TO_PDF_STRINGS.es.pageSizeFit }).click();
      await dialog.getByRole("button", { name: C.images.create }).click();
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(C.images.fileName.replace(".", "\\.")) })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("2 páginas").first()).toBeVisible();
      const file = await downloadCurrent(page);
      const doc = await PDFDocument.load(file.bytes);
      const sizes = doc.getPages().map((p) => p.getSize());
      expect(sizes[0].height).toBeGreaterThan(sizes[0].width); // «alta» primero
      expect(sizes[1].width).toBeGreaterThan(sizes[1].height);
    });

    test("Insertar desde HTML: añade paginas (motor real), se deshace con Ctrl+Z y no sube nada", async ({ page }) => {
      const uploads = watchUploads(page);
      await openProPdf(page, { pages: 2 });
      await openMoreItem(page, C.menu.insertConvert);
      await page.locator("[data-pro-import-input]").setInputFiles({
        name: "nota.html",
        mimeType: "text/html",
        buffer: Buffer.from("<html><body><h1>Nota importada</h1><p>Texto de prueba para la conversion.</p></body></html>"),
      });
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(C.insert.fidelityHtml)).toBeVisible();
      await dialog.getByRole("radio", { name: C.insert.start }).click();
      await dialog.getByRole("button", { name: C.insert.insert }).click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
      await expect(page.getByText("3 páginas").first()).toBeVisible();
      await expect(page.getByRole("status")).toContainText(C.insert.label("nota.html"));
      const withHtml = await downloadCurrent(page);
      expect((await PDFDocument.load(withHtml.bytes)).getPageCount()).toBe(3);
      // Ctrl+Z global lo deshace.
      await page.locator("body").click({ position: { x: 3, y: 3 } });
      await page.keyboard.press("Control+z");
      await expect(page.getByText("2 páginas").first()).toBeVisible();
      expect(uploads.requests).toEqual([]);
    });

    test("Abrir otro PDF con cambios sin descargar pide confirmar; «Cancelar» conserva el documento", async ({ page }) => {
      await openProPdf(page, { name: "uno.pdf", pages: 2 });
      await closeSheetIfOpen(page);
      // En movil el boton vive en la hoja de Inicio.
      if (project.touch) await page.locator('[data-dock="home"]').click();
      await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
      await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
      await closeSheetIfOpen(page);
      await page.locator("[data-pro-open-input]").setInputFiles({ name: "dos.pdf", mimeType: "application/pdf", buffer: Buffer.from(await (await PDFDocument.create()).save()) });
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(SE.replaceBody)).toBeVisible();
      await dialog.getByRole("button", { name: "Cancelar" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("uno.pdf");
    });

    test("«Reabrir el ultimo documento» tras recargar recupera los cambios", async ({ page }) => {
      await openProPdf(page, { name: "borrador.pdf", pages: 3 });
      await closeSheetIfOpen(page);
      if (project.touch) await page.locator('[data-dock="home"]').click();
      await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
      await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
      // Espera el autoguardado (debounce de 600 ms + escritura) antes de recargar.
      await page.waitForTimeout(2500);
      await page.reload();
      const reopen = page.getByRole("button", { name: SE.openLast });
      await expect(reopen).toBeVisible();
      await expect(page.locator("[data-recent-list]")).toContainText("borrador.pdf");
      await reopen.click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("borrador.pdf");
      await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
      const file = await downloadCurrent(page);
      const rotations = (await PDFDocument.load(file.bytes)).getPages().map((p) => p.getRotation().angle);
      expect(rotations).toEqual([90, 90, 90]);
    });

    test("el menu de guardar sigue enfocable tras abrir y cerrar una hoja (foco nunca en <body>)", async ({ page }) => {
      await openProPdf(page);
      const menu = await openSaveMenu(page);
      await menu.getByRole("menuitem", { name: S.save.saveAs }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect.poll(() => focusedDescription(page)).not.toBe("<body>");
    });
  });
}
