import { unfoldPalette } from "../helpers/mobile-sign";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { makeReceiptPdf } from "../../src/lib/pdf/testing/signSyntheticPdfs";
import { downloadFile } from "../helpers/downloads";
import { isBenignEngineNoise } from "../helpers/engine";
import { getPageText } from "../helpers/pdf-inspection";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS, withEmbeddedWording } from "../../src/app/sign-pdf/signEmbeddedStrings";
import { EDIT_FLOW_STRINGS } from "../../src/app/edit-pdf/flowStrings";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { getModeStrings } from "../../src/app/pdf-pro/modes/modeStrings";

/**
 * B1 · Firmar muestra lo que paso con el texto ORIGINAL editado (F2), en navegador real y headless.
 *
 *  - Herramienta suelta (/sign-pdf): editar un texto, procesar y descargar: la pantalla de resultado dice «N textos
 *    editados: el original se elimino del archivo» y, si F2 no pudo quitarlo (Form XObject compartido), el motivo en
 *    llano y la salida recomendada. Se comprueba contra el PDF descargado (con pdf.js): el resumen no miente.
 *  - Accesibilidad: el resumen y los avisos no son una region viva (la descripcion del boton «Descargar» los lee
 *    enteros), sin desbordes, axe en 0, es y en, escritorio y movil (toque real).
 *  - PDF Pro · Firmar: «Aplicar» deja el resumen en la tarjeta de «Aplicado».
 */

test.setTimeout(150_000);

const SG = SIGN_STRINGS.es;
const SGE = SIGN_STRINGS.en;
const FLOW = EDIT_FLOW_STRINGS.es;
const FLOW_EN = EDIT_FLOW_STRINGS.en;
const SE = SIGN_EMBEDDED_STRINGS.es;
const WORDING = withEmbeddedWording("es");
const S = PRO_STRINGS.es;
const HOST = getModeStrings("es").host;
const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = ["color-contrast", "aria-valid-attr-value", "label", "button-name", "link-name"] as const;

const EDITED_TITLE = "Recibo editado por Optimus";
const ORIGINAL_TITLE = "Receipt from Acme Studio";

const SUMMARY_REMOVED = "1 texto editado: el original se eliminó del archivo.";
const SUMMARY_REMAINS = "1 texto editado: no se pudo quitar el original (más abajo, por qué).";

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isBenignEngineNoise(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (!isBenignEngineNoise(error.message)) errors.push(error.message);
  });
  return errors;
}

/** El titulo del recibo, dentro de un Form XObject que comparten DOS paginas: F2 no lo puede quitar (shared-xobject). */
async function makeSharedTitlePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const xobject = doc.context.register(
    doc.context.stream(`BT /F1 22 Tf 0 0 Td (${ORIGINAL_TITLE}) Tj ET`, {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, -10, 400, 30],
      Matrix: [1, 0, 0, 1, 56, 730],
      Resources: { Font: { F1: font.ref } },
    }),
  );
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([612, 792]);
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
  }
  return Buffer.from(await doc.save());
}

/** Un recibo simple (el titulo es texto normal: F2 SI lo puede quitar). */
async function makeTitlePdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(`Receipt from ${label}`, { x: 56, y: 730, size: 22, font });
  return Buffer.from(await doc.save());
}

/** Como `makeSharedTitlePdf`, con el titulo `Receipt from <label>`. */
async function makeSharedLabelPdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const xobject = doc.context.register(
    doc.context.stream(`BT /F1 22 Tf 0 0 Td (Receipt from ${label}) Tj ET`, {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, -10, 400, 30],
      Matrix: [1, 0, 0, 1, 56, 730],
      Resources: { Font: { F1: font.ref } },
    }),
  );
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([612, 792]);
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
  }
  return Buffer.from(await doc.save());
}

/** «Crear firma» -> trazo -> «Usar esta firma»: la firma recien creada se coloca sola en el documento activo. */
async function drawSignature(page: Page): Promise<void> {
  await page.getByRole("button", { name: SG.createSignature }).first().click();
  const dialog = page.getByRole("dialog");
  const canvas = dialog.locator("canvas");
  let box = await canvas.boundingBox();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(100);
    const next = await canvas.boundingBox();
    if (box && next && next.x === box.x && next.y === box.y) break;
    box = next;
  }
  if (!box) throw new Error("no se encontro el lienzo de firma");
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 8 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 8 });
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Usar esta firma" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function upload(page: Page, name: string, bytes: Uint8Array | Buffer): Promise<void> {
  await page.goto("/sign-pdf");
  await page
    .locator('input[type="file"][accept*="pdf"]')
    .first()
    .setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.from(bytes) });
  await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
}

/** «Editar texto» -> el titulo del recibo (primer bloque `Receipt from…`) -> `text`. Con el dedo, un toque selecciona y el siguiente edita. */
async function editTitle(
  page: Page,
  text: string,
  options: { touch?: boolean; strings?: typeof SG; ariaLabel?: string } = {},
): Promise<void> {
  const strings = options.strings ?? SG;
  await unfoldPalette(page); // movil: la paleta llega plegada en un boton
  await page.getByRole("button", { name: strings.toolEditText }).click();
  const title: Locator = page.locator(`[data-block-layer] [aria-label*="${options.ariaLabel ?? "Receipt from"}"]`).first();
  await title.waitFor({ timeout: 20_000 });
  if (options.touch) {
    await title.tap();
    await title.tap();
  } else {
    await title.dblclick();
  }
  const editor = page.locator("[data-inline-editor]");
  await expect(editor).toBeVisible();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  await expect(editor).toContainText(text);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await unfoldPalette(page); // movil: elegir una herramienta pliega la paleta
  await page.getByRole("button", { name: strings.toolSelect }).click();
  await expect(page.locator("[data-edit-text-panel]")).toContainText(strings.editTextCount(1));
}

async function process(page: Page, language: "es" | "en" = "es"): Promise<void> {
  await page.getByRole("button", { name: language === "es" ? "Procesar" : "Process" }).click();
  await expect(page.getByRole("button", { name: language === "es" ? "Descargar" : "Download", exact: true })).toBeVisible({ timeout: 60_000 });
  // La pantalla entra con un fundido: axe mide el contraste con la opacidad real, asi que se espera a que termine.
  await expect
    .poll(() =>
      page.evaluate(() => {
        for (let el: Element | null = document.querySelector('section[aria-labelledby="download-title"]'); el; el = el.parentElement) {
          if (getComputedStyle(el).opacity !== "1") return false;
        }
        return true;
      }),
    )
    .toBe(true);
}

async function noHorizontalOverflow(page: Page, where: string): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scrollWidth, `sin desborde horizontal (${where})`).toBeLessThanOrEqual(clientWidth);
}

async function runAxe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
  }, AXE_RULES);
}

/** Ni el resumen ni los avisos viven dentro de una region viva: se leen por la descripcion del boton «Descargar». */
async function expectNotLive(locator: Locator): Promise<void> {
  const insideLive = await locator.evaluate((node) => node.closest('[role="status"], [role="alert"], [aria-live]') !== null);
  expect(insideLive, "el resumen no es una region viva").toBe(false);
}

test.describe("Firmar · resumen del texto editado · escritorio 1280×800", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 }, acceptDownloads: true });

  test("se quito el original: «1 texto editado: el original se elimino del archivo», sin avisos, y el PDF descargado ya no lo trae", async ({ page }) => {
    const errors = trackErrors(page);
    await upload(page, "recibo.pdf", await makeReceiptPdf());
    await editTitle(page, EDITED_TITLE);
    await process(page);

    const summary = page.locator("[data-download-summary]");
    await expect(summary).toHaveText(SUMMARY_REMOVED);
    // Todo quitado: no hay lista de avisos (la pantalla no alarma sin motivo).
    await expect(page.locator("[data-download-notices]")).toHaveCount(0);
    await expectNotLive(summary);
    // Texto completo para lectores de pantalla: la descripcion del boton «Descargar».
    await expect(page.getByRole("button", { name: "Descargar" })).toHaveAccessibleDescription(SUMMARY_REMOVED);
    await expect(page.getByText("recibo-editado.pdf")).toBeVisible();
    await noHorizontalOverflow(page, "resultado");
    expect(await runAxe(page), "axe en el resultado").toEqual([]);

    const { bytes } = await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click());
    const text = await getPageText(bytes, 1);
    expect(text).toContain(EDITED_TITLE);
    // Lo que dice el resumen es verdad: el original ya no esta en el archivo.
    expect(text).not.toContain(ORIGINAL_TITLE);
    expect(errors).toEqual([]);
  });

  test("NO se pudo quitar (contenido compartido): el resumen lo dice, el bloque lleva su motivo en llano, la salida recomendada, y el archivo conserva el original", async ({ page }) => {
    const errors = trackErrors(page);
    await upload(page, "compartido.pdf", await makeSharedTitlePdf());
    await editTitle(page, EDITED_TITLE);
    await process(page);

    const summary = page.locator("[data-download-summary]");
    await expect(summary).toHaveText(SUMMARY_REMAINS);
    const notices = page.locator("[data-download-notices]");
    await expect(notices).toBeVisible();
    await expect(notices.getByRole("heading", { name: SG.editReportTitle })).toBeVisible();
    const items = notices.getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText(
      `Página 1, «${EDITED_TITLE}»: el original sigue bajo la edición. ${FLOW.remainsReason("shared-xobject")}`,
    );
    await expect(items.nth(1)).toHaveText(SG.editRemainsAdvice(FLOW.flattenAction));
    await expect(items.nth(1)).toContainText("«Aplanar página»");
    await expectNotLive(summary);
    await expectNotLive(notices);
    // La descripcion del boton lee el resumen Y los avisos enteros.
    const description = page.getByRole("button", { name: "Descargar" });
    await expect(description).toHaveAccessibleDescription(
      new RegExp(`${SUMMARY_REMAINS.replace(/[()]/g, "\\$&")}[\\s\\S]*${SG.editReportTitle}[\\s\\S]*comparten otras páginas[\\s\\S]*Aplanar página`),
    );
    // Ni claves crudas ni marcadores.
    const shown = (await page.locator("[data-download-summary], [data-download-notices]").allInnerTexts()).join(" ");
    expect(shown).not.toMatch(/undefined|\{\w+\}|\[object|remains|shared-xobject|editRemains/);
    await noHorizontalOverflow(page, "resultado con avisos");
    expect(await runAxe(page), "axe en el resultado con avisos").toEqual([]);

    const { bytes } = await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click());
    const text = await getPageText(bytes, 1);
    expect(text).toContain(EDITED_TITLE);
    // La honestidad del aviso: el original SIGUE en el archivo (y se puede extraer).
    expect(text).toContain(ORIGINAL_TITLE);
    expect(errors).toEqual([]);
  });

  test("la nota del panel describe lo que de verdad ocurre y apunta al resumen", async ({ page }) => {
    await upload(page, "recibo.pdf", await makeReceiptPdf());
    await editTitle(page, EDITED_TITLE);
    const panel = page.locator("[data-edit-text-panel]");
    await expect(panel).toContainText(SG.editTextNote);
    await expect(panel).toContainText("verás un resumen");
    await expect(panel).not.toContainText(/puede seguir existiendo/);
  });
});

test.describe("Firmar · resumen del texto editado · varios documentos (ZIP) · 1280×900", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });

  test("dos documentos con texto editado: el ZIP, el resumen de todos y el motivo con el nombre del documento", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/sign-pdf");
    await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles([
      { name: "A.pdf", mimeType: "application/pdf", buffer: await makeTitlePdf("Alfa") },
      { name: "B.pdf", mimeType: "application/pdf", buffer: await makeSharedLabelPdf("Beta") },
    ]);
    await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
    await drawSignature(page);
    await expect(page.getByRole("button", { name: /^1\. A\.pdf.*Colocada/ })).toBeVisible();

    await editTitle(page, "Alfa editado", { ariaLabel: "Receipt from Alfa" });
    await page.getByRole("button", { name: /^2\. B\.pdf/ }).click();
    await expect(page.getByRole("button", { name: /^2\. B\.pdf/ })).toHaveAttribute("aria-current", "true");
    await editTitle(page, "Beta editado", { ariaLabel: "Receipt from Beta" });
    await process(page);

    await expect(page.getByText("Firmados - 2 documentos.zip")).toBeVisible();
    const summary = page.locator("[data-download-summary]");
    await expect(summary).toHaveText(
      "2 textos editados en 2 documentos: el original se eliminó de 1 y no se pudo quitar de 1 (más abajo, por qué).",
    );
    const notices = page.locator("[data-download-notices]");
    const items = notices.getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText(
      `B.pdf, página 1, «Beta editado»: el original sigue bajo la edición. ${FLOW.remainsReason("shared-xobject")}`,
    );
    await expect(items.nth(1)).toHaveText(SG.editRemainsAdvice(FLOW.flattenAction));
    await expectNotLive(summary);
    await expectNotLive(notices);
    await expect(page.getByRole("button", { name: "Descargar" })).toHaveAccessibleDescription(/2 textos editados en 2 documentos[\s\S]*Sobre el texto editado[\s\S]*B\.pdf, página 1/);
    await noHorizontalOverflow(page, "ZIP");
    expect(await runAxe(page), "axe en el resultado del ZIP").toEqual([]);

    // El resumen es verdad para cada PDF del ZIP.
    const { bytes } = await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click());
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).sort();
    expect(names).toHaveLength(2);
    const [textA, textB] = await Promise.all(
      names.map(async (name) => getPageText(Buffer.from(await zip.file(name)!.async("uint8array")), 1)),
    );
    expect(textA).toContain("Alfa editado");
    expect(textA).not.toContain("Receipt from Alfa");
    expect(textB).toContain("Beta editado");
    expect(textB).toContain("Receipt from Beta");
    expect(errors).toEqual([]);
  });
});

test.describe("Firmar · resumen del texto editado · ingles", () => {
  test.use({ locale: "en-US", viewport: { width: 1280, height: 800 }, acceptDownloads: true });

  test("el resumen y los avisos salen en ingles, completos", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("optimuspdf.language", "en"));
    await upload(page, "shared.pdf", await makeSharedTitlePdf());
    await editTitle(page, "Edited by Optimus", { strings: SGE });
    await process(page, "en");
    await expect(page.locator("[data-download-summary]")).toHaveText("1 text edited: the original could not be removed (see why below).");
    const notices = page.locator("[data-download-notices]");
    await expect(notices.getByRole("heading", { name: SGE.editReportTitle })).toBeVisible();
    await expect(notices.getByRole("listitem").nth(0)).toHaveText(
      `Page 1, “Edited by Optimus”: the original is still under the edit. ${FLOW_EN.remainsReason("shared-xobject")}`,
    );
    await expect(notices.getByRole("listitem").nth(1)).toHaveText(SGE.editRemainsAdvice(FLOW_EN.flattenAction));
    await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveAccessibleDescription(/could not be removed[\s\S]*About the edited text[\s\S]*shared with other pages[\s\S]*Flatten page/);
    expect(await runAxe(page)).toEqual([]);
  });
});

test.describe("Firmar · resumen del texto editado · movil 375×812", () => {
  test.use({ locale: "es-ES", viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, acceptDownloads: true });

  test("con el dedo: el resumen y los avisos caben, sin desbordes, y el boton Descargar sigue a mano", async ({ page }) => {
    const errors = trackErrors(page);
    await upload(page, "compartido.pdf", await makeSharedTitlePdf());
    await editTitle(page, EDITED_TITLE, { touch: true });
    await process(page);
    await expect(page.locator("[data-download-summary]")).toHaveText(SUMMARY_REMAINS);
    const notices = page.locator("[data-download-notices]");
    await expect(notices).toBeVisible();
    await expect(notices.getByRole("listitem")).toHaveCount(2);
    await noHorizontalOverflow(page, "movil");
    const box = await notices.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, "los avisos caben en el ancho del telefono").toBeLessThanOrEqual(375);
    const download = page.getByRole("button", { name: "Descargar" });
    await expect(download).toBeVisible();
    const target = await download.boundingBox();
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(await runAxe(page), "axe en movil").toEqual([]);
    expect(errors).toEqual([]);
  });

  test("el original quitado tambien se resume en el movil", async ({ page }) => {
    await upload(page, "recibo.pdf", await makeReceiptPdf());
    await editTitle(page, EDITED_TITLE, { touch: true });
    await process(page);
    await expect(page.locator("[data-download-summary]")).toHaveText(SUMMARY_REMOVED);
    await noHorizontalOverflow(page, "movil");
  });
});

/* ------------------------------------------------------------------ *
 * PDF Pro · Firmar · «Aplicar»
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · Firmar con texto editado · 1280×800", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 }, acceptDownloads: true });

  async function openPro(page: Page, bytes: Buffer, name: string): Promise<void> {
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
    await page.locator('[data-tab="sign"]').click();
    await expect(page.getByRole("toolbar", { name: SG.paletteLabel })).toBeVisible();
  }

  test("«Aplicar»: la tarjeta de «Aplicado» lleva el resumen del texto editado y el original se fue del documento", async ({ page }) => {
    await openPro(page, Buffer.from(await makeReceiptPdf()), "recibo.pdf");
    await editTitle(page, EDITED_TITLE);
    // La nota del texto original vive en la cabecera del modo (plegada con los demas avisos), no repetida en el panel.
    await expect(page.locator('[data-pro-mode-warnings] [data-warning="editedText"]')).toHaveCount(1);
    await expect(page.locator("[data-edit-text-panel]")).not.toContainText(WORDING.editTextNote);
    await page.locator("[data-pro-mode-apply]").click();
    const result = page.locator("[data-pro-mode-result]");
    await expect(result).toContainText(HOST.appliedTitle(SE.labelEdited));
    await expect(result.getByRole("listitem")).toHaveText([SUMMARY_REMOVED]);
    // Se guarda y se comprueba contra el PDF real (pdf.js): el original ya no esta.
    const { bytes } = await downloadFile(page, () => page.getByRole("button", { name: S.suite.download, exact: true }).click());
    const text = await getPageText(bytes, 1);
    expect(text).toContain(EDITED_TITLE);
    expect(text).not.toContain(ORIGINAL_TITLE);
  });

  test("«Aplicar» con el original compartido: el motivo y la salida de PDF Pro (pestaña Editar) en la tarjeta", async ({ page }) => {
    await openPro(page, await makeSharedTitlePdf(), "compartido.pdf");
    await editTitle(page, EDITED_TITLE);
    await page.locator("[data-pro-mode-apply]").click();
    const result = page.locator("[data-pro-mode-result]");
    await expect(result).toContainText(HOST.appliedTitle(SE.labelEdited));
    const items = result.getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveText(SUMMARY_REMAINS);
    await expect(items.nth(1)).toHaveText(
      `Página 1, «${EDITED_TITLE}»: el original sigue bajo la edición. ${FLOW.remainsReason("shared-xobject")}`,
    );
    await expect(items.nth(2)).toHaveText(WORDING.editRemainsAdvice(FLOW.flattenAction));
    await expect(items.nth(2)).toContainText("pestaña Editar de PDF Pro");
    expect(await runAxe(page)).toEqual([]);
  });
});
