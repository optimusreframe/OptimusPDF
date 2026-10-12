import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import { isEncrypted } from "../helpers/pdf-structure";
import { makeImage } from "../helpers/test-files";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { PAGE_NUMBERS_STRINGS } from "../../src/app/add-page-numbers/strings";
import { WATERMARK_STRINGS } from "../../src/app/add-watermark/strings";
import { PROTECT_STRINGS } from "../../src/app/protect-pdf/strings";

/**
 * PDF Pro · herramientas de documento (Wave 7 · U5), navegador real y headless en 1280×800 y 375×812:
 * marca de agua + numerar + comprimir + metadatos + recortar sobre el MISMO documento, en secuencia;
 * se verifica con pdf.js/pdf-lib que todo esta en el PDF final, se deshace paso a paso con Ctrl+Z y se
 * exporta protegido con contraseña (sin tocar el historial). Sin errores de consola (guardian de
 * `tool-flow`), sin desbordes, con el foco nunca en <body> y con axe en 0 violaciones.
 *
 * Nota de presupuesto: desde la Wave 7 · U8 el historial se acota por BYTES (~400 MB) con un tope de 50 pasos, asi que
 * con un PDF pequeño las 5 operaciones quedan todas y se deshacen 5 pasos hasta el original (antes, un tope de 5
 * snapshots descartaba la marca de agua y Ctrl+Z saltaba dos pasos de golpe).
 */

const S = PRO_STRINGS.es;
const T = S.docTools;
const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = ["color-contrast", "aria-valid-attr-value", "label", "button-name", "link-name"] as const;

test.setTimeout(150_000);

/** 3 paginas con texto + una foto JPEG de ruido de calidad alta (comprimible de verdad). */
async function buildPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 3; index += 1) {
    const page = document.addPage([300, 400]);
    const jpeg = await document.embedJpg(makeImage("jpeg", 800, 560, 60 + index, 97));
    page.drawImage(jpeg, { x: 10, y: 120, width: 280, height: 200 });
    page.drawText(`SEQ-${index}`, { x: 60, y: 340, size: 16, font });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function openProPdf(page: Page, bytes: Buffer, name = "informe.pdf"): Promise<void> {
  await page.goto("/pdf-pro");
  await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
}

const history = (page: Page): Locator => page.getByRole("list", { name: S.suite.historyTitle });

async function historyLabels(page: Page): Promise<string[]> {
  const items = history(page).getByRole("listitem");
  return items.evaluateAll((nodes) => nodes.map((node) => node.querySelector("span")?.textContent?.trim() ?? ""));
}

async function currentLabel(page: Page): Promise<string> {
  const button = history(page).locator("[aria-current='step']");
  return (await button.locator("span").first().textContent())?.trim() ?? "";
}

async function expectFocusNotBody(page: Page, where: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement), {
      message: `el foco no debe quedar en <body> (${where})`,
    })
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

/** Escritorio: pestañas arriba y panel lateral. Movil: barra inferior y el panel en una hoja (`dialog`). */
async function isMobileLayout(page: Page): Promise<boolean> {
  return (await page.locator("section[data-pro-suite]").getAttribute("data-layout")) === "mobile";
}

async function closeSheet(page: Page): Promise<void> {
  if (!(await isMobileLayout(page))) return;
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
}

const TAB_ID: Record<string, string> = { Inicio: "home", Proteger: "protect" };

/** Abre el panel de una pestaña (en movil, su hoja) y espera a que este visible. */
async function gotoTab(page: Page, name: "Inicio" | "Proteger"): Promise<void> {
  if (await isMobileLayout(page)) {
    await closeSheet(page);
    await page.locator(`[data-dock="${TAB_ID[name]}"]`).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  } else {
    const tab = page.locator(`[data-tab="${TAB_ID[name]}"]`);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
}

async function openTool(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: T.launcher.open(title), exact: true }).click();
  const heading = page.getByRole("heading", { level: 2, name: title, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
}

async function backToTools(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: T.launcher.back, exact: true }).click();
  await expect(page.getByRole("button", { name: T.launcher.open(title), exact: true })).toBeFocused();
}

const applyButton = (page: Page): Locator => page.getByRole("button", { name: T.runner.apply, exact: true });

async function download(page: Page): Promise<{ bytes: Buffer; filename: string }> {
  return downloadFile(page, () => page.getByRole("button", { name: S.suite.download, exact: true }).click());
}

for (const viewport of [
  { name: "escritorio 1280×800", width: 1280, height: 800 },
  { name: "movil 375×812", width: 375, height: 812 },
]) {
  test.describe(`PDF Pro · herramientas de documento · ${viewport.name}`, () => {
    test.use({ locale: "es-ES", viewport: { width: viewport.width, height: viewport.height } });

    test("secuencia: marca de agua, numerar, comprimir, metadatos y recortar sobre el MISMO documento; deshacer paso a paso; exportar protegido", async ({
      page,
    }) => {
      const original = await buildPdf();
      await openProPdf(page, original);
      await gotoTab(page, "Inicio");
      await expect(page.getByRole("heading", { name: T.summary.title })).toBeVisible();
      await noHorizontalOverflow(page, "Inicio");

      // 1 · Marca de agua, con vista previa real y axe sobre el panel abierto.
      await openTool(page, T.tools.watermark.title);
      await page.getByLabel(WATERMARK_STRINGS.es.textLabel).fill("SECRETO");
      await expect(page.getByAltText(T.runner.previewAlt(1))).toBeVisible({ timeout: 30_000 });
      await noHorizontalOverflow(page, "marca de agua");
      expect(await runAxe(page), "axe en el panel de marca de agua").toEqual([]);
      await applyButton(page).click();
      await expect(page.getByRole("status")).toHaveText(S.announce.applied("Marca de agua “SECRETO”"));
      await expectFocusNotBody(page, "tras aplicar la marca de agua");
      await backToTools(page, T.tools.watermark.title);
      expect(await historyLabels(page)).toEqual(["Original", "Marca de agua “SECRETO”"]);

      // 2 · Numerar paginas (Página n de p).
      await openTool(page, T.tools["page-numbers"].title);
      await page.getByRole("radio", { name: PAGE_NUMBERS_STRINGS.es.formatPageNofP, exact: true }).click();
      await applyButton(page).click();
      await expect(page.getByRole("status")).toHaveText(S.announce.applied(T.labels.pageNumbers));
      await backToTools(page, T.tools["page-numbers"].title);
      expect(await historyLabels(page)).toEqual(["Original", "Marca de agua “SECRETO”", T.labels.pageNumbers]);

      // 3 · Comprimir: ahorro REAL medido.
      await openTool(page, T.tools.compress.title);
      await applyButton(page).click();
      await expect(page.getByRole("status")).toHaveText(S.announce.applied(T.labels.compress(T.labels.levels.recommended)));
      await expect(page.getByRole("heading", { name: "Última compresión" })).toBeVisible();
      await expect(page.getByText(/^−\d+%$/)).toBeVisible();
      await backToTools(page, T.tools.compress.title);
      expect((await historyLabels(page)).at(-1)).toBe(T.labels.compress(T.labels.levels.recommended));

      // 4 · Metadatos.
      await openTool(page, T.tools.metadata.title);
      await expect(page.getByText(T.metadata.nothingChanged).first()).toBeVisible();
      await page.getByLabel(T.metadata.fieldTitle, { exact: true }).fill("Informe E2E");
      await page.getByLabel(T.metadata.fieldAuthor, { exact: true }).fill("Equipo de pruebas");
      await applyButton(page).click();
      await expect(page.getByRole("status")).toHaveText(S.announce.applied(T.labels.metadataSet));
      await backToTools(page, T.tools.metadata.title);

      // 5 · Recortar con margenes numericos (12 mm en los cuatro lados).
      await openTool(page, T.tools.crop.title);
      await page.getByRole("spinbutton", { name: `${T.crop.linked} (mm)` }).fill("12");
      await expect(page.getByText(T.crop.pageSize("105.8", "141.1"))).toBeVisible();
      await applyButton(page).click();
      await expect(page.getByRole("status")).toContainText(S.announce.applied(T.labels.crop));
      await backToTools(page, T.tools.crop.title);

      // El presupuesto es por BYTES (no por numero de pasos): con un PDF pequeño el historial conserva TODOS los pasos.
      expect(await historyLabels(page)).toEqual([
        "Original",
        "Marca de agua “SECRETO”",
        T.labels.pageNumbers,
        T.labels.compress(T.labels.levels.recommended),
        T.labels.metadataSet,
        T.labels.crop,
      ]);
      await expect(page.getByText(S.suite.historyTrimmed)).toHaveCount(0);
      await noHorizontalOverflow(page, "historial completo");

      // Todo esta en el PDF final.
      await closeSheet(page);
      const final = await download(page);
      expect(final.filename).toBe("informe-pro.pdf");
      expect(await getPageCount(final.bytes)).toBe(3);
      for (let n = 1; n <= 3; n += 1) {
        const text = await getPageText(final.bytes, n);
        expect(text, `pagina ${n}: marca de agua`).toContain("SECRETO");
        expect(text, `pagina ${n}: numeracion`).toContain(`Página ${n} de 3`);
        expect(text, `pagina ${n}: texto original`).toContain(`SEQ-${n}`);
      }
      const finalDoc = await PDFDocument.load(final.bytes, { updateMetadata: false });
      expect(finalDoc.getTitle()).toBe("Informe E2E");
      expect(finalDoc.getAuthor()).toBe("Equipo de pruebas");
      const cropBox = finalDoc.getPage(0).getCropBox();
      const twelveMm = (12 * 72) / 25.4;
      expect(cropBox.x).toBeCloseTo(twelveMm, 1);
      expect(cropBox.width).toBeCloseTo(300 - 2 * twelveMm, 1);
      expect(final.bytes.length, "comprimido: pesa menos que el original").toBeLessThan(original.length);

      // Deshacer paso a paso con Ctrl+Z (el foco esta en un boton, no en un campo de texto).
      await page.getByRole("button", { name: S.suite.download, exact: true }).focus();
      await page.keyboard.press("Control+z");
      await gotoTab(page, "Inicio");
      await expect.poll(() => currentLabel(page)).toBe(T.labels.metadataSet);
      await page.keyboard.press("Control+z");
      await expect.poll(() => currentLabel(page)).toBe(T.labels.compress(T.labels.levels.recommended));
      await page.keyboard.press("Control+z");
      await expect.poll(() => currentLabel(page)).toBe(T.labels.pageNumbers);
      await closeSheet(page);
      const step3 = await download(page);
      const doc3 = await PDFDocument.load(step3.bytes, { updateMetadata: false });
      expect(doc3.getTitle() ?? "").toBe("");
      expect(doc3.getPage(0).getCropBox().width).toBeCloseTo(300, 1);
      expect(await getPageText(step3.bytes, 1)).toContain("SECRETO");
      expect(await getPageText(step3.bytes, 1)).toContain("Página 1 de 3");
      await page.keyboard.press("Control+z");
      await gotoTab(page, "Inicio");
      await expect.poll(() => currentLabel(page)).toBe("Marca de agua “SECRETO”");
      await page.keyboard.press("Control+z");
      await expect.poll(() => currentLabel(page)).toBe("Original");
      await closeSheet(page);
      const step4 = await download(page);
      expect(await getPageText(step4.bytes, 1)).not.toContain("SECRETO");
      expect(step4.bytes.length).toBe(original.length);
      await expectFocusNotBody(page, "tras deshacer");

      // Rehacer vuelve al ultimo paso.
      await page.getByRole("button", { name: S.suite.download, exact: true }).focus();
      for (let i = 0; i < 5; i += 1) await page.keyboard.press("Control+Shift+z");
      await gotoTab(page, "Inicio");
      await expect.poll(() => currentLabel(page)).toBe(T.labels.crop);

      // Exportar protegido: opcion de guardado, no un paso del historial.
      const stepsBefore = (await historyLabels(page)).length;
      await gotoTab(page, "Proteger");
      await expect(page.getByRole("heading", { name: T.protect.saveTitle })).toBeVisible();
      await noHorizontalOverflow(page, "Proteger");
      expect(await runAxe(page), "axe en la pestaña Proteger").toEqual([]);
      await page.getByLabel(PROTECT_STRINGS.es.passwordLabel, { exact: true }).fill("secreto1");
      await page.getByLabel(PROTECT_STRINGS.es.confirmLabel, { exact: true }).fill("secreto1");
      const protectedFile = await downloadFile(page, () => page.getByRole("button", { name: T.protect.saveButton, exact: true }).click());
      expect(protectedFile.filename).toBe("informe-protegido.pdf");
      expect(await isEncrypted(protectedFile.bytes)).toBe(true);
      expect(await getPageCount(protectedFile.bytes, "secreto1")).toBe(3);
      await expect(page.getByRole("status")).toHaveText(T.protect.saved("informe-protegido.pdf"));
      await gotoTab(page, "Inicio");
      expect((await historyLabels(page)).length).toBe(stepsBefore);
      expect(await currentLabel(page)).toBe(T.labels.crop);
      await expectFocusNotBody(page, "tras guardar protegido");
      await noHorizontalOverflow(page, "final");
    });

    test("contraseña fuera de Latin-1: motivo claro y el boton no guarda", async ({ page }) => {
      await openProPdf(page, await buildPdf());
      await gotoTab(page, "Proteger");
      await page.getByLabel(PROTECT_STRINGS.es.passwordLabel, { exact: true }).fill("clave€uro");
      await expect(page.getByText(PROTECT_STRINGS.es.errors.unsupportedChars.replace("{chars}", "€"))).toBeVisible();
      await expect(page.getByRole("button", { name: T.protect.saveButton, exact: true })).toHaveAttribute("aria-disabled", "true");
    });

    test("OCR avisa de que requiere conexion y recortar rechaza margenes vacios", async ({ page }) => {
      await openProPdf(page, await buildPdf());
      await gotoTab(page, "Inicio");
      await openTool(page, T.tools.ocr.title);
      await expect(page.locator("[data-needs-network]")).toContainText(T.runner.networkBadge);
      await backToTools(page, T.tools.ocr.title);
      await openTool(page, T.tools.crop.title);
      await page.getByRole("spinbutton", { name: `${T.crop.linked} (mm)` }).fill("0");
      await expect(page.getByText(T.crop.nothingToCrop)).toBeVisible();
      await expect(applyButton(page)).toHaveAttribute("aria-disabled", "true");
    });

    test("objetivos de toque >= 44 px en los controles de los paneles", async ({ page }) => {
      await openProPdf(page, await buildPdf());
      await gotoTab(page, "Inicio");
      await openTool(page, T.tools.crop.title);
      const targets = page.locator("[data-doc-tool='crop'] button, [data-doc-tool='crop'] input, [data-doc-tool='crop'] [role='tab'], [data-doc-tool='crop'] [role='switch']");
      const boxes = await targets.evaluateAll((nodes) =>
        nodes
          .filter((node) => (node as HTMLElement).offsetParent !== null)
          .map((node) => {
            const rect = node.getBoundingClientRect();
            return { name: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 24) ?? node.tagName, height: Math.round(rect.height) };
          }),
      );
      const small = boxes.filter((box) => box.height < 43);
      expect(small, `controles de menos de 44 px: ${JSON.stringify(small)}`).toEqual([]);
    });
  });
}

test.describe("PDF Pro · herramientas de documento · ingles", () => {
  test.use({ locale: "en-US", viewport: { width: 1280, height: 800 } });

  test("los paneles salen en ingles y la etiqueta del paso tambien", async ({ page }) => {
    const TE = PRO_STRINGS.en.docTools;
    await page.addInitScript(() => window.localStorage.setItem("optimuspdf.language", "en"));
    await openProPdf(page, await buildPdf(), "report.pdf");
    await gotoTab(page, "Inicio");
    await page.getByRole("button", { name: TE.launcher.open(TE.tools.watermark.title), exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: TE.tools.watermark.title })).toBeVisible();
    await page.getByRole("button", { name: TE.runner.apply, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(PRO_STRINGS.en.announce.applied("Watermark “CONFIDENTIAL”"));
  });
});
