import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import { renderPageToPixels } from "../helpers/pdf-render-inspection";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { MODE_STRINGS } from "../../src/app/pdf-pro/modes/modeStrings";
import { EDIT_STRINGS } from "../../src/app/edit-pdf/strings";

/**
 * Wave 8 · F2 (correccion del verificador): duplicar una pagina con el motor de paginas de PDF Pro la deja
 * COMPARTIENDO el flujo de contenido con la original. Editar el texto de la pagina 1 en el modo Editar no debe borrar
 * el de la copia: el exportador clona el flujo (copy-on-write) en vez de reescribirlo en su sitio. Navegador real,
 * headless, 1280x800: duplicar la pagina 1, editarla, descargar y comprobar con pdf.js y pixel a pixel que la copia
 * y la tercera pagina no cambiaron.
 */

const S = PRO_STRINGS.es;
const P = S.pages;
const M = MODE_STRINGS.es;

test.setTimeout(180_000);
test.use({ viewport: { width: 1280, height: 800 }, locale: "es-ES" });

async function makeDoc(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText("Total a pagar: 1.250,00", { x: 50, y: 600, size: 14, font: helv });
  p1.drawText("Pie comun de pagina", { x: 50, y: 60, size: 11, font: helv });
  const p2 = doc.addPage([595, 842]);
  p2.drawText("Pagina dos del informe", { x: 50, y: 770, size: 20, font: helv });
  return Buffer.from(await doc.save());
}

const topBar = (page: Page) => page.locator('[data-pro-region="top"]');
const host = (page: Page) => page.locator("[data-pro-mode-host]");
const applyButton = (page: Page) => page.locator("[data-pro-mode-apply]");
const grid = (page: Page) => page.getByRole("listbox", { name: /Páginas del documento/ });
const cardAt = (page: Page, n: number) => grid(page).getByRole("option", { name: new RegExp(`^Página ${n} de`) });
const block = (page: Page, text: string) => page.getByRole("button", { name: new RegExp(`^Texto: ${text}`) });

async function downloadCurrent(page: Page): Promise<Buffer> {
  const result = await downloadFile(page, async () => {
    await topBar(page).getByRole("button", { name: S.suite.download }).click();
  });
  return result.bytes;
}

async function diffPixels(a: Buffer, aPage: number, b: Buffer, bPage: number): Promise<number> {
  const ra = await renderPageToPixels(a, aPage, 0.5);
  const rb = await renderPageToPixels(b, bPage, 0.5);
  expect([ra.width, ra.height]).toEqual([rb.width, rb.height]);
  let different = 0;
  for (let y = 0; y < ra.height; y += 1) {
    for (let x = 0; x < ra.width; x += 1) {
      const pa = ra.pixelAt(x, y);
      const pb = rb.pixelAt(x, y);
      if (pa.r !== pb.r || pa.g !== pb.g || pa.b !== pb.b) different += 1;
    }
  }
  return different;
}

async function contentsRefs(bytes: Buffer): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.node.get(PDFName.of("Contents"))?.toString() ?? "");
}

async function openBlockEditor(page: Page, text: string): Promise<Locator> {
  const target = block(page, text);
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await target.dblclick();
  const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
  await expect(editor).toBeFocused();
  return editor;
}

test("duplicar la pagina 1, editar su texto en Editar y exportar: la copia y las demas conservan el suyo", async ({ page }) => {
  await page.goto("/pdf-pro");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "informe.pdf", mimeType: "application/pdf", buffer: await makeDoc() });
  await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible();

  // 1) Duplicar la pagina 1 desde «Páginas» y aplicar (un snapshot).
  await page.getByRole("tab", { name: S.suite.tabs.pages }).click();
  await expect(cardAt(page, 1)).toBeVisible();
  await cardAt(page, 1).click();
  await page.getByRole("button", { name: P.actions.duplicate, exact: true }).click();
  await page.getByRole("button", { name: P.status.apply, exact: true }).click();
  await expect(page.locator("[data-pages-chip]")).toHaveText(P.status.noChanges);
  const duplicated = await downloadCurrent(page);
  expect(await getPageCount(duplicated)).toBe(3);
  const refs = await contentsRefs(duplicated);
  expect(refs[0], "precondicion: la copia comparte el flujo con la original").toBe(refs[1]);
  expect(await getPageText(duplicated, 2)).toContain("Total a pagar: 1.250,00");

  // 2) Editar el texto de la pagina 1 en el modo Editar.
  await page.getByRole("tab", { name: "Editar" }).click();
  await expect(host(page)).toBeVisible();
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 30_000 });
  const goTo = page.getByRole("textbox", { name: EDIT_STRINGS.es.inline.goToPageLabel });
  await page.locator('[data-palette-item="select"]').focus();
  for (let i = 0; i < 3 && (await goTo.inputValue()) !== "1"; i += 1) {
    await page.keyboard.press("[");
    await page.waitForTimeout(300);
  }
  await expect(goTo).toHaveValue("1");
  const editor = await openBlockEditor(page, "Total a pagar");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Total pagado: 99,00");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await applyButton(page).click();
  await expect(host(page)).toHaveCount(0);
  await expect(page.locator("[data-pro-mode-result]")).toContainText("1 texto editado");

  // 3) Exportar y comprobar con pdf.js y pixel a pixel.
  const edited = await downloadCurrent(page);
  expect(await getPageCount(edited)).toBe(3);
  const p1 = await getPageText(edited, 1);
  expect(p1).toContain("Total pagado: 99,00");
  expect(p1).not.toContain("1.250,00");
  expect(p1).toContain("Pie comun de pagina");
  // La COPIA (pagina 2) conserva su texto original y la tercera no cambia.
  const p2 = await getPageText(edited, 2);
  expect(p2).toContain("Total a pagar: 1.250,00");
  expect(p2).toContain("Pie comun de pagina");
  expect(p2).not.toContain("99,00");
  expect(await getPageText(edited, 3)).toContain("Pagina dos del informe");
  expect(await diffPixels(duplicated, 2, edited, 2), "pagina 2 (la copia): 0 px de diferencia").toBe(0);
  expect(await diffPixels(duplicated, 3, edited, 3), "pagina 3: 0 px de diferencia").toBe(0);
  const after = await contentsRefs(edited);
  expect(after[0]).not.toBe(after[1]);
  expect(M.host.appliedTitle(M.edit.label(2))).toBeTruthy();
});
