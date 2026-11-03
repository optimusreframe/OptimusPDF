import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageText } from "../helpers/pdf-inspection";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS, withEmbeddedWording } from "../../src/app/sign-pdf/signEmbeddedStrings";
import { QUICK_SIGN_STRINGS } from "../../src/app/sign-pdf/fillMode/fillStrings";
import { FILL_EMBEDDED_STRINGS } from "../../src/app/sign-pdf/fillEmbeddedStrings";
import { getModeStrings } from "../../src/app/pdf-pro/modes/modeStrings";
import { clickUntil, stillBox } from "../helpers/engine";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
} from "../../src/app/sign-pdf/signFeatureFlags";

/**
 * PDF Pro · modos Firmar y Rellenar (Wave 7 · U7), navegador real y headless en 1280×800 y 375×812 tactil.
 *
 *  - Contrato de 3 paginas: Firmar -> firma tecleada, texto, «Aplicar» = UN snapshot «Documento firmado»;
 *    con pdf.js se comprueba la imagen de la firma y el texto, y Ctrl+Z global la deshace (y Ctrl+Shift+Z la rehace).
 *  - Dos firmantes: «Firmado por Ana y Luis».
 *  - Formulario AcroForm de 5 campos: Rellenar -> texto, casilla y desplegable escritos EN LOS CAMPOS (pdf-lib),
 *    y el mismo formulario aplanado.
 *  - PDF con firma digital: se avisa y el anfitrion pide confirmar.
 *  - Sin errores de consola (guardian de `tool-flow`), sin desbordes, foco nunca en <body>, axe en 0.
 */

const S = PRO_STRINGS.es;
const SG = SIGN_STRINGS.es;

/**
 * En un telefono (< 768 px) la paleta de Firmar llega PLEGADA en un boton (`data-palette-fab`, tambien dentro de PDF Pro:
 * auditoria VP-01, integracion M4); en tablet y escritorio es la barra. `paletteOrFab` vale para ambas; `pickPaletteTool`
 * la abre si hace falta antes de elegir la herramienta.
 */
const paletteOrFab = (page: Page) => page.getByRole("toolbar", { name: SG.paletteLabel }).or(page.locator("[data-palette-fab]"));
async function pickPaletteTool(page: Page, paletteLabel: string, tool: string): Promise<void> {
  const fab = page.locator("[data-palette-fab]");
  if (await fab.isVisible().catch(() => false)) await fab.click();
  await page.getByRole("toolbar", { name: paletteLabel }).getByRole("button", { name: tool, exact: true }).click();
}
const SE = SIGN_EMBEDDED_STRINGS.es;
/** Dentro de PDF Pro lo firmado se APLICA (no se descarga): textos de la pantalla final unica del ultimo turno (Ola 3). */
const SGE = withEmbeddedWording("es");
const QS = QUICK_SIGN_STRINGS.es;
const FE = FILL_EMBEDDED_STRINGS.es;
const HOST = getModeStrings("es").host;
const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = ["color-contrast", "aria-valid-attr-value", "label", "button-name", "link-name"] as const;

test.setTimeout(150_000);

async function buildContract(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 3; index += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`CONTRATO-${index}`, { x: 60, y: 760, size: 22, font });
    page.drawText("Las partes acuerdan lo siguiente.", { x: 60, y: 700, size: 12, font });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

/** Formulario AcroForm real de 5 campos: nombre, apellido, notas (multilinea), casilla y desplegable. */
async function buildForm(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  page.drawText("Formulario de alta", { x: 60, y: 780, size: 22, font });
  const form = document.getForm();
  form.createTextField("nombre").addToPage(page, { x: 60, y: 700, width: 260, height: 26 });
  form.createTextField("apellido").addToPage(page, { x: 60, y: 650, width: 260, height: 26 });
  const notes = form.createTextField("notas");
  notes.enableMultiline();
  notes.addToPage(page, { x: 60, y: 540, width: 360, height: 80 });
  form.createCheckBox("acepto").addToPage(page, { x: 60, y: 500, width: 18, height: 18 });
  const country = form.createDropdown("pais");
  country.addOptions(["España", "México", "Chile"]);
  country.addToPage(page, { x: 60, y: 450, width: 180, height: 26 });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

/** Un PDF con un campo de firma digital ya firmado (/FT /Sig con /V): lo que `inspectProtection` llama «activa». */
async function buildDigitallySigned(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  page.drawText("CONTRATO-FIRMADO", { x: 60, y: 760, size: 22, font });
  const context = document.context;
  const signature = PDFDict.withContext(context);
  signature.set(PDFName.of("Type"), PDFName.of("Sig"));
  const field = PDFDict.withContext(context);
  field.set(PDFName.of("FT"), PDFName.of("Sig"));
  field.set(PDFName.of("V"), context.register(signature));
  const fields = PDFArray.withContext(context);
  fields.push(context.register(field));
  const acroForm = PDFDict.withContext(context);
  acroForm.set(PDFName.of("Fields"), fields);
  document.catalog.set(PDFName.of("AcroForm"), context.register(acroForm));
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

/** Firma digital activa Y copia descifrada (restricciones de permisos): dos avisos del documento a la vez. */
async function buildSignedAndRestricted(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  page.drawText("CONTRATO-DOS-AVISOS", { x: 60, y: 760, size: 22, font });
  const context = document.context;
  const signature = PDFDict.withContext(context);
  signature.set(PDFName.of("Type"), PDFName.of("Sig"));
  const field = PDFDict.withContext(context);
  field.set(PDFName.of("FT"), PDFName.of("Sig"));
  field.set(PDFName.of("V"), context.register(signature));
  const fields = PDFArray.withContext(context);
  fields.push(context.register(field));
  const acroForm = PDFDict.withContext(context);
  acroForm.set(PDFName.of("Fields"), fields);
  document.catalog.set(PDFName.of("AcroForm"), context.register(acroForm));
  document.encrypt({ userPassword: "", ownerPassword: "propietario", permissions: { modifying: false, copying: false } });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function openProPdf(page: Page, bytes: Buffer, name = "contrato.pdf"): Promise<void> {
  await page.goto("/pdf-pro");
  await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
}

async function isMobileLayout(page: Page): Promise<boolean> {
  return (await page.locator("section[data-pro-suite]").getAttribute("data-layout")) === "mobile";
}

async function expectFocusNotBody(page: Page, where: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => !!document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement,
        ),
      { message: `el foco no debe quedar en <body> (${where})` },
    )
    .toBe(true);
}

/** Suelta la seleccion tocando una esquina vacia de la hoja: la barra flotante del campo seleccionado desaparece. */
async function releaseSelection(page: Page): Promise<void> {
  const bar = page.locator("[data-floating-bar]");
  if ((await bar.count()) === 0) return;
  await page.locator('img[alt]:not([alt=""])').first().click({ position: { x: 6, y: 6 } });
  await expect(bar).toHaveCount(0);
}

async function noHorizontalOverflow(page: Page, where: string): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scrollWidth, `sin desborde horizontal (${where})`).toBeLessThanOrEqual(clientWidth);
}

/**
 * Espera a que terminen las animaciones y transiciones FINITAS de la pagina (las barras y avisos entran con un muelle): axe mide
 * el contraste con lo que se pinta en ese instante, y con un fundido a medias un texto sobre la hoja da un falso suspenso.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity),
      undefined,
      { timeout: 5000 },
    )
    .catch(() => undefined);
}

async function runAxe(page: Page): Promise<string[]> {
  await settleAnimations(page);
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
  }, AXE_RULES);
}

/** Abre una pestana (en movil, su boton de la barra inferior). Las de modo no abren hoja: ocupan la region central. */
async function gotoTab(page: Page, id: "home" | "sign"): Promise<void> {
  if (await isMobileLayout(page)) {
    const dialog = page.getByRole("dialog");
    if (await dialog.isVisible()) {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    await page.locator(`[data-dock="${id}"]`).click();
  } else {
    const tab = page.locator(`[data-tab="${id}"]`);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
}

/** Cierra la hoja del panel de Inicio en movil (para llegar a «Descargar»). */
async function closeSheet(page: Page): Promise<void> {
  if (!(await isMobileLayout(page))) return;
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
}

const hostApply = (page: Page): Locator => page.locator("[data-pro-mode-apply]");

async function download(page: Page): Promise<{ bytes: Buffer; filename: string }> {
  await closeSheet(page);
  return downloadFile(page, () => page.getByRole("button", { name: S.suite.download, exact: true }).click());
}

const history = (page: Page): Locator => page.getByRole("list", { name: S.suite.historyTitle });

async function historyLabels(page: Page): Promise<string[]> {
  await gotoTab(page, "home");
  const items = history(page).getByRole("listitem");
  const labels = await items.evaluateAll((nodes) => nodes.map((node) => node.querySelector("span")?.textContent?.trim() ?? ""));
  await closeSheet(page);
  return labels;
}

async function currentLabel(page: Page): Promise<string> {
  await gotoTab(page, "home");
  const button = history(page).locator("[aria-current='step']");
  const label = (await button.locator("span").first().textContent())?.trim() ?? "";
  await closeSheet(page);
  return label;
}

/** «Crear firma» -> compositor -> pestana Escribir -> nombre -> «Usar esta firma»: queda colocada en el lienzo. */
async function createTypedSignature(page: Page, name: string): Promise<void> {
  // Un clic justo despues de abrir la herramienta puede perderse en WebKit (la pagina aun termina de montarse): se repite
  // hasta que la hoja de firma esta abierta, como haria quien ve que no se abrio.
  await expect(async () => {
    if ((await page.getByRole("dialog").count()) === 0) await page.getByRole("button", { name: SG.createSignature }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: SG.modeType }).click();
  await dialog.getByLabel(SG.typeLabel, { exact: true }).fill(name);
  await dialog.getByRole("button", { name: SG.save }).click();
  await expect(page.getByRole("group", { name: `${SG.soloSignatureLabel}, ${SG.soloSignatureA11y}` })).toBeVisible();
}

/** Texto libre sobre la pagina visible con la herramienta Texto y su alternativa por boton. */
async function addTextHere(page: Page, value: string): Promise<void> {
  await pickPaletteTool(page, SG.paletteLabel, SG.fieldTypeText);
  const textboxes = await page.getByRole("textbox").count();
  await clickUntil(page.getByRole("button", { name: SG.addTextFieldHere }), async () => (await page.getByRole("textbox").count()) > textboxes);
  const input = page.getByRole("textbox").last();
  await input.fill(value);
  // Escape cierra el editor y devuelve el foco al campo (nunca a <body>), conservando lo escrito.
  await page.keyboard.press("Escape");
}

/** Texto de la pagina 1 segun poppler (incluye los widgets pintados); `null` si poppler no esta instalado. */
function popplerText(bytes: Buffer): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), "pro-fill-"));
  try {
    const file = path.join(dir, "in.pdf");
    writeFileSync(file, bytes);
    return execFileSync("pdftotext", ["-layout", "-f", "1", "-l", "1", file, "-"], { encoding: "utf8" });
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** El campo tiene apariencia (`/AP /N`) en su widget: el valor se ve en cualquier lector. */
function hasAppearance(document: PDFDocument, name: string): boolean {
  const field = document.getForm().getField(name) as unknown as { acroField: { getWidgets(): { dict: PDFDict }[] } };
  const ap = field.acroField.getWidgets()[0].dict.lookup(PDFName.of("AP"));
  return ap instanceof PDFDict && ap.has(PDFName.of("N"));
}

const AXE_VIEWPORTS = [
  { name: "escritorio 1280×800", width: 1280, height: 800, touch: false },
  { name: "movil 375×812", width: 375, height: 812, touch: true },
] as const;

for (const viewport of AXE_VIEWPORTS) {
  test.describe(`PDF Pro · modos Firmar y Rellenar · ${viewport.name}`, () => {
    test.use({
      locale: "es-ES",
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
    });

    test("Firmar: firma + texto, UN snapshot, imagen y texto en el PDF, Ctrl+Z global la deshace y Ctrl+Shift+Z la rehace", async ({ page }) => {
      await openProPdf(page, await buildContract());
      await gotoTab(page, "sign");
      await expect(page.getByRole("region", { name: SE.regionLabel })).toBeVisible();
      await expect(paletteOrFab(page)).toBeVisible();
      // Sin nada que aplicar todavia: el anfitrion deja «Aplicar» apagado.
      await expect(hostApply(page)).toHaveAttribute("aria-disabled", "true");
      await expectFocusNotBody(page, "al abrir Firmar");
      await noHorizontalOverflow(page, "Firmar");
      expect(await runAxe(page), "axe en el modo Firmar").toEqual([]);

      await createTypedSignature(page, "Ana Pérez");
      await addTextHere(page, "Madrid, 12 de octubre");
      await expect(hostApply(page)).not.toHaveAttribute("aria-disabled", "true");
      await expectFocusNotBody(page, "tras crear la firma y el texto");
      await noHorizontalOverflow(page, "Firmar con firma y texto");
      expect(await runAxe(page), "axe en el modo Firmar con firma").toEqual([]);

      await hostApply(page).click();
      await expect(page.locator("[data-pro-mode-result]")).toContainText(HOST.appliedTitle(SE.labelSigned));
      await expectFocusNotBody(page, "tras aplicar la firma");
      expect(await historyLabels(page)).toEqual(["Original", SE.labelSigned]);

      const signed = await download(page);
      expect(await getPageCount(signed.bytes)).toBe(3);
      const first = await getPageOperatorCounts(signed.bytes, 1);
      expect(first.imagePaintOps, "la firma es una imagen en la pagina 1").toBeGreaterThanOrEqual(1);
      expect((await getPageOperatorCounts(signed.bytes, 2)).imagePaintOps).toBe(0);
      expect(await getPageText(signed.bytes, 1)).toContain("Madrid, 12 de octubre");
      for (let n = 1; n <= 3; n += 1) expect(await getPageText(signed.bytes, n)).toContain(`CONTRATO-${n}`);

      // Ctrl+Z global (el foco esta en un boton): vuelve al original, sin firma ni texto.
      await page.getByRole("button", { name: S.suite.download, exact: true }).focus();
      await page.keyboard.press("Control+z");
      await expect.poll(() => currentLabel(page)).toBe("Original");
      const undone = await download(page);
      expect((await getPageOperatorCounts(undone.bytes, 1)).imagePaintOps).toBe(0);
      expect(await getPageText(undone.bytes, 1)).not.toContain("Madrid");
      await expectFocusNotBody(page, "tras deshacer");

      await page.getByRole("button", { name: S.suite.download, exact: true }).focus();
      await page.keyboard.press("Control+Shift+z");
      await expect.poll(() => currentLabel(page)).toBe(SE.labelSigned);
      const redone = await download(page);
      expect((await getPageOperatorCounts(redone.bytes, 1)).imagePaintOps).toBeGreaterThanOrEqual(1);
      await noHorizontalOverflow(page, "final");
    });

    /**
     * El recorrido entero con dos firmantes dentro de PDF Pro hasta el PDF descargado. `registroDeFirmas` siembra el
     * ajuste «Registro de firmas (página final)» (apagado por defecto desde U0.5); sin el, se usan los ajustes por defecto.
     */
    async function signWithTwoSigners(page: Page, options: { registroDeFirmas: boolean; finishWith: "ceremony" | "host" }) {
      if (options.registroDeFirmas) {
        await page.addInitScript(
          ([flagsKey, versionKey]) => {
            window.localStorage.setItem(flagsKey, JSON.stringify({ completionCertificate: true }));
            window.localStorage.setItem(versionKey, "2");
          },
          [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, SIGN_PDF_FEATURE_FLAGS_VERSION_KEY],
        );
      }
      await openProPdf(page, await buildContract());
      await gotoTab(page, "sign");
      await page.getByRole("tab", { name: SG.modeMulti }).click();
      await page.getByRole("button", { name: SG.addSigner }).click();
      await page.getByLabel(SG.signerNameLabel(1)).fill("Ana");
      await page.getByRole("button", { name: SG.addSigner }).click();
      await page.getByLabel(SG.signerNameLabel(2)).fill("Luis");
      await page.getByRole("button", { name: `2. ${SG.stepDocument}` }).click();
      for (const signer of ["Ana", "Luis"]) {
        await page.getByRole("radio", { name: signer, exact: true }).click();
        // En movil la paleta flota sobre el contenido: con la barra de zoom justo debajo se tapan; se vuelve arriba.
        await page.locator("[data-pro-mode-scroll]").evaluate((node) => {
          node.scrollTop = 0;
        });
        await pickPaletteTool(page, SG.paletteLabel, SG.fieldSignature);
        await page.getByRole("button", { name: SG.addFieldHere }).click();
      }
      await page.getByRole("button", { name: `3. ${SG.stepSign}` }).click();
      for (const signer of ["Ana", "Luis"]) {
        await page.getByRole("button", { name: SG.handoffReady }).first().click();
        await page.getByRole("button", { name: SG.captureSignature }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("tab", { name: SG.modeType }).click();
        await dialog.getByLabel(SG.typeLabel, { exact: true }).fill(signer);
        await dialog.getByRole("button", { name: SG.save }).click();
        await page.getByRole("button", { name: SG.captureContinue }).click();
        // Ola 3: con el ULTIMO firmante la revision y el boton final son UNA pantalla; ya no hay «He terminado».
        if (signer === "Ana") await page.getByRole("button", { name: SG.reviewNext }).click();
      }
      await expect(page.getByRole("heading", { name: QS.finalTitleApply })).toBeVisible();
      await expect(page.getByRole("button", { name: SG.reviewFinish })).toHaveCount(0);
      await expectFocusNotBody(page, "tras la ceremonia");
      expect(await runAxe(page), "axe en la ceremonia dentro de PDF Pro").toEqual([]);
      // Se aplica por los dos caminos: el boton de la propia pantalla final («Finalizar y aplicar») o el «Aplicar» del anfitrion.
      if (options.finishWith === "ceremony") await page.getByRole("button", { name: SGE.applyAndDownload, exact: true }).click();
      else await hostApply(page).click();
      await expect(page.locator("[data-pro-mode-result]")).toContainText(HOST.appliedTitle("Firmado por Ana y Luis"));
      return download(page);
    }

    test("Firmar con dos firmantes (ajustes por defecto): «Firmado por Ana y Luis», dos imagenes y EXACTAMENTE las 3 paginas del original", async ({ page }) => {
      const signed = await signWithTwoSigners(page, { registroDeFirmas: false, finishWith: "ceremony" });
      // Sin hoja «Registro de firmas»: las 3 paginas del contrato y solo metadatos.
      expect(await getPageCount(signed.bytes)).toBe(3);
      expect((await getPageOperatorCounts(signed.bytes, 1)).imagePaintOps).toBeGreaterThanOrEqual(2);
      const info = await PDFDocument.load(new Uint8Array(signed.bytes), { updateMetadata: false });
      expect(info.getProducer()).toBe("OptimusPDF");
      await noHorizontalOverflow(page, "dos firmantes");
    });

    test("Firmar con dos firmantes y «Registro de firmas» ACTIVADO: dos imagenes y una pagina final «Registro de firmas»", async ({ page }) => {
      const signed = await signWithTwoSigners(page, { registroDeFirmas: true, finishWith: "host" });
      // 3 paginas + la del registro de firmas (ajuste activado en Ajustes de Firmar).
      expect(await getPageCount(signed.bytes)).toBe(4);
      expect((await getPageOperatorCounts(signed.bytes, 1)).imagePaintOps).toBeGreaterThanOrEqual(2);
      expect(await getPageText(signed.bytes, 4)).toContain(SG.certificateTitle);
      expect(await getPageText(signed.bytes, 4)).toContain("Registro de firmas");
      await noHorizontalOverflow(page, "dos firmantes con registro");
    });

    test("Rellenar: formulario AcroForm de 5 campos -> texto, casilla y desplegable en los CAMPOS; deshacer vuelve al formulario vacio", async ({ page }) => {
      await openProPdf(page, await buildForm(), "formulario.pdf");
      await gotoTab(page, "sign");
      await page.getByRole("tab", { name: SE.switchFill }).click();
      await expect(page.getByText(FE.formFound(5), { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: FE.regionLabel })).toBeVisible();
      await noHorizontalOverflow(page, "Rellenar");
      expect(await runAxe(page), "axe en el modo Rellenar").toEqual([]);

      const tap = async (label: RegExp) => {
        // Escape cierra el editor pero deja el campo SELECCIONADO, y su barra de acciones (con «Etiquetar») ocupa dos filas a
        // 375 px y tapa los campos de debajo: antes de tocar el siguiente, una persona suelta la seleccion tocando la hoja vacia.
        await releaseSelection(page);
        const group = page.getByRole("group", { name: label });
        await group.scrollIntoViewIfNeeded();
        await group.click();
      };
      await tap(/^nombre, /);
      await page.getByRole("textbox", { name: "nombre" }).fill("Ñandú José");
      await page.keyboard.press("Escape");
      await tap(/^apellido, /);
      await page.getByRole("textbox", { name: "apellido" }).fill("Pérez");
      await page.keyboard.press("Escape");
      await tap(/^acepto, /);
      await page.getByLabel(/^pais/).selectOption("México");
      await expect(hostApply(page)).not.toHaveAttribute("aria-disabled", "true");
      await expectFocusNotBody(page, "tras rellenar");
      expect(await runAxe(page), "axe en Rellenar con valores").toEqual([]);

      await hostApply(page).click();
      await expect(page.locator("[data-pro-mode-result]")).toContainText(HOST.appliedTitle("Formulario rellenado (4 campos)"));
      await expectFocusNotBody(page, "tras aplicar el formulario");
      expect(await historyLabels(page)).toEqual(["Original", "Formulario rellenado (4 campos)"]);

      const filled = await download(page);
      const reloaded = await PDFDocument.load(filled.bytes, { updateMetadata: false });
      const form = reloaded.getForm();
      expect(form.getTextField("nombre").getText()).toBe("Ñandú José");
      expect(form.getTextField("apellido").getText()).toBe("Pérez");
      expect(form.getCheckBox("acepto").isChecked()).toBe(true);
      expect(form.getDropdown("pais").getSelected()).toEqual(["México"]);
      // Siguen siendo campos y llevan apariencia generada: el valor se ve en cualquier lector.
      expect(form.getFields()).toHaveLength(5);
      expect(hasAppearance(reloaded, "nombre")).toBe(true);
      expect(hasAppearance(reloaded, "apellido")).toBe(true);
      const poppler = popplerText(filled.bytes);
      if (poppler !== null) {
        expect(poppler).toContain("Ñandú José");
        expect(poppler).toContain("Pérez");
        expect(poppler).toContain("México");
      }

      await page.getByRole("button", { name: S.suite.download, exact: true }).focus();
      await page.keyboard.press("Control+z");
      await expect.poll(() => currentLabel(page)).toBe("Original");
      const empty = await download(page);
      const emptyForm = (await PDFDocument.load(empty.bytes, { updateMetadata: false })).getForm();
      expect(emptyForm.getTextField("nombre").getText() ?? "").toBe("");
      expect(emptyForm.getCheckBox("acepto").isChecked()).toBe(false);
      await expectFocusNotBody(page, "tras deshacer el formulario");
    });

    test("Rellenar y aplanar: los campos pasan a ser contenido de la pagina", async ({ page }) => {
      await openProPdf(page, await buildForm(), "formulario.pdf");
      await gotoTab(page, "sign");
      await page.getByRole("tab", { name: SE.switchFill }).click();
      await expect(page.getByText(FE.formFound(5), { exact: true })).toBeVisible();
      const group = page.getByRole("group", { name: /^nombre, / });
      await group.scrollIntoViewIfNeeded();
      await group.click();
      await page.getByRole("textbox", { name: "nombre" }).fill("Aplanado E2E");
      await page.keyboard.press("Escape");
      await page.getByRole("checkbox", { name: new RegExp(FE.flattenLabel) }).check();
      await hostApply(page).click();
      await expect(page.locator("[data-pro-mode-result]")).toContainText(HOST.appliedTitle("Formulario rellenado (1 campo)"));
      const flat = await download(page);
      const reloaded = await PDFDocument.load(flat.bytes, { updateMetadata: false });
      expect(reloaded.getForm().getFields()).toHaveLength(0);
      expect(await getPageText(flat.bytes, 1)).toContain("Aplanado E2E");
    });

    test("objetivos de toque >= 44 px en el conmutador y los controles propios de Rellenar", async ({ page }) => {
      await openProPdf(page, await buildForm(), "formulario.pdf");
      await gotoTab(page, "sign");
      await page.getByRole("tab", { name: SE.switchFill }).click();
      await expect(page.getByText(FE.formFound(5), { exact: true })).toBeVisible();
      const heights = await page
        .locator("[data-pro-mode-switch] [role='tab'], [data-fill-choices] select, label:has([data-fill-flatten]), [data-fill-choices] label:has(input[type='radio'])")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => (node as HTMLElement).offsetParent !== null)
            .map((node) => ({
              name: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 28) ?? node.tagName,
              height: Math.round(node.getBoundingClientRect().height),
            })),
        );
      expect(heights.length).toBeGreaterThanOrEqual(4);
      const small = heights.filter((item) => item.height < 43);
      expect(small, `controles de menos de 44 px: ${JSON.stringify(small)}`).toEqual([]);
    });

    test("PDF con firma digital: el modo avisa y el anfitrion pide confirmar antes de aplicar", async ({ page }) => {
      await openProPdf(page, await buildDigitallySigned(), "firmado.pdf");
      await gotoTab(page, "sign");
      await expect(page.locator("[data-pro-mode-warnings]")).toContainText("firmas digitales");
      await addTextHere(page, "Anotacion");
      await hostApply(page).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByRole("heading", { name: HOST.signaturesTitle })).toBeVisible();
      await expectFocusNotBody(page, "con la confirmacion de firmas");
      await sheet.getByRole("button", { name: HOST.signaturesCancel }).click();
      await expect(sheet).toBeHidden();
      // No se aplico nada: la sesion sigue y el historial no cambio.
      await expect(page.getByRole("region", { name: SE.regionLabel })).toBeVisible();
      await hostApply(page).click();
      await sheet.getByRole("button", { name: HOST.signaturesConfirm }).click();
      await expect(page.locator("[data-pro-mode-result]")).toContainText(HOST.appliedTitle(SE.labelSigned));
      expect(await historyLabels(page)).toEqual(["Original", SE.labelSigned]);
    });
  });
}

/** `true` si en algun instante tras `action` el foco estuvo en <body> (observa cada cambio del DOM y 6 fotogramas). */
async function focusEverInBody(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) =>
      new Promise<boolean>((resolve) => {
        let seen = false;
        const check = () => {
          if (!document.activeElement || document.activeElement === document.body) seen = true;
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        const button = document.querySelector<HTMLElement>(sel)!;
        button.focus();
        button.click();
        let frames = 0;
        const tick = () => {
          check();
          frames += 1;
          if (frames < 8) requestAnimationFrame(tick);
          else {
            observer.disconnect();
            resolve(seen);
          }
        };
        requestAnimationFrame(tick);
      }),
    selector,
  );
}

const unloadPrevented = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

for (const viewport of AXE_VIEWPORTS) {
  test.describe(`PDF Pro · modos Firmar y Rellenar · correcciones del verificador · ${viewport.name}`, () => {
    test.use({
      locale: "es-ES",
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
    });

    for (const [key, label, name] of [
      ["s", SE.switchSign, "Firmando"],
      ["f", SE.switchFill, "Rellenando"],
    ] as const) {
      test(`pulsar ${key.toUpperCase()} con el foco en el visor entra en el modo y NO deja el foco en <body>`, async ({ page, browserName }) => {
        // El visor solo recibe foco de teclado con un puntero fino: los atajos son de escritorio.
        test.skip(viewport.touch, "atajos de teclado: solo escritorio");
        await openProPdf(page, await buildForm(), "formulario.pdf");
        const scroller = page.locator("[data-pro-viewer-scroller]");
        await expect(scroller).toBeVisible();
        // Chromium deja enfocar el contenedor desplazable; Safari y Firefox no: ahi el foco del visor vive en sus paginas.
        const inViewer = browserName === "chromium" ? scroller : page.locator('[data-pro-feed] [data-page-index="0"]');
        await inViewer.focus();
        await expect(inViewer).toBeFocused();
        await page.keyboard.press(key);
        await expect(page.locator("[data-pro-mode-host]")).toHaveAttribute("data-mode", "sign");
        await expect(page.locator("[data-pro-mode-name]")).toHaveText(name);
        const active = page.locator("[data-pro-mode-switch] [role='tab'][aria-selected='true']");
        await expect(active).toHaveText(label);
        await expect(active).toBeFocused();
        await expectFocusNotBody(page, `tras pulsar ${key}`);
      });
    }

    test("recargar o cerrar con trabajo sin aplicar avisa; aplicar o descartar retira el aviso", async ({ page }) => {
      await openProPdf(page, await buildContract());
      await gotoTab(page, "sign");
      await expect(paletteOrFab(page)).toBeVisible();
      expect(await unloadPrevented(page), "sin trabajo no avisa").toBe(false);
      await createTypedSignature(page, "Ana Pérez");
      expect(await unloadPrevented(page), "con una firma sin aplicar avisa").toBe(true);
      await hostApply(page).click();
      await expect(page.locator("[data-pro-mode-result]")).toBeVisible();
      // Tras aplicar, el documento queda con cambios: el aviso dura lo que tarda en escribirse su borrador (~0,6 s) y se retira.
      await expect.poll(() => unloadPrevented(page), { message: "tras aplicar (y guardarse el borrador) ya no avisa", timeout: 10_000 }).toBe(false);
      await gotoTab(page, "sign");
      await addTextHere(page, "Otra");
      expect(await unloadPrevented(page)).toBe(true);
      await page.locator("[data-pro-mode-discard]").click();
      await page.getByRole("button", { name: HOST.discardConfirm }).click();
      await expect(page.locator("[data-pro-mode-host]")).toHaveCount(0);
      await expect.poll(() => unloadPrevented(page), { message: "tras descartar ya no avisa", timeout: 10_000 }).toBe(false);
    });

    test("la barra del modo nombra la herramienta, hay UNA sola barra y «Aplicar» sin cambios se ve apagado y lo anuncia", async ({ page }) => {
      await openProPdf(page, await buildForm(), "formulario.pdf");
      await gotoTab(page, "sign");
      await expect(page.locator("[data-pro-mode-name]")).toHaveText("Firmando");
      await page.getByRole("tab", { name: SE.switchFill }).click();
      await expect(page.locator("[data-pro-mode-name]")).toHaveText("Rellenando");
      expect(await page.locator("[data-pro-mode-bar]").count(), "una sola barra del modo").toBe(1);
      const apply = hostApply(page);
      await expect(apply).toHaveAttribute("aria-disabled", "true");
      const opacity = await apply.evaluate((node) => Number(getComputedStyle(node).opacity));
      expect(opacity, "«Aplicar» apagado se ve atenuado").toBeLessThan(1);
      await apply.click({ force: true });
      await expect(page.getByRole("status").filter({ hasText: HOST.noChanges })).toHaveCount(1);
    });

    test("descartar un modo limpio no deja el foco ni un fotograma en <body>", async ({ page }) => {
      await openProPdf(page, await buildContract());
      await gotoTab(page, "sign");
      await expect(paletteOrFab(page)).toBeVisible();
      expect(await focusEverInBody(page, "[data-pro-mode-discard]")).toBe(false);
      await expect(page.locator("[data-pro-mode-host]")).toHaveCount(0);
      await expectFocusNotBody(page, "tras descartar un modo limpio");
    });

    test("la zona del modo se desplaza por si sola y la hoja se recorre con la rueda", async ({ page, browserName }) => {
      test.skip(viewport.touch && browserName === "webkit", "Playwright no soporta mouse.wheel en WebKit movil (isMobile)");
      await openProPdf(page, await buildContract());
      await gotoTab(page, "sign");
      await expect(paletteOrFab(page)).toBeVisible();
      const metrics = await page.locator("[data-pro-mode-scroll]").evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        bottom: node.getBoundingClientRect().bottom,
        innerHeight: window.innerHeight,
      }));
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      expect(metrics.bottom, "la zona cabe en la ventana").toBeLessThanOrEqual(metrics.innerHeight + 1);
      // Quieta: con la zona aun acomodandose, la rueda cae sobre otro elemento y no desplaza nada (visto en WebKit).
      const box = await stillBox(page.locator("[data-pro-mode-scroll]"));
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, 300);
      await expect.poll(() => page.locator("[data-pro-mode-scroll]").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    });
  });
}

test.describe("PDF Pro · modos Firmar y Rellenar · lienzo compacto (1280×800)", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  /** Espera a que termine «Buscando campos…» (una linea transitoria que mueve la hoja) antes de medir. */
  async function settleCanvas(page: Page): Promise<void> {
    // (El texto tambien queda en la region viva unica de PDF Pro: se mira la propia linea, no el texto.)
    await expect(page.locator("[data-detecting]")).toHaveCount(0);
    await expect(page.locator('img[alt]:not([alt=""])').first()).toBeVisible();
    let previous = -1;
    await expect
      .poll(async () => {
        const top = await page.evaluate(() => document.querySelector('[data-canvas="host"]')!.getBoundingClientRect().top);
        const settled = Math.abs(top - previous) < 0.5;
        previous = top;
        return settled;
      })
      .toBe(true);
  }

  async function canvasLayout(page: Page) {
    await settleCanvas(page);
    return page.evaluate(() => {
      const scroll = document.querySelector("[data-pro-mode-scroll]")!;
      const canvas = document.querySelector("[data-canvas-announcer]")!.parentElement!;
      const area = scroll.getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      // La HOJA (el lienzo donde se coloca la firma), no solo el contenedor con sus barras: es lo que se ve de la pagina.
      const stage = document.querySelector('[data-canvas="host"]')!.getBoundingClientRect();
      return {
        scrollTop: scroll.scrollTop,
        areaHeight: area.height,
        canvasTop: box.top - area.top,
        canvasVisible: Math.min(area.bottom, box.bottom) - Math.max(area.top, box.top),
        stageVisible: Math.min(area.bottom, stage.bottom) - Math.max(area.top, stage.top),
        intro: document.querySelector("[data-canvas-intro]")?.className ?? "",
        warnings: document.querySelectorAll("[data-pro-mode-warnings] li").length,
      };
    });
  }

  test("con un aviso del documento el lienzo empieza a la vista y se ve con >= 450 px de alto", async ({ page }) => {
    await openProPdf(page, await buildDigitallySigned(), "firmado.pdf");
    await gotoTab(page, "sign");
    await expect(paletteOrFab(page)).toBeVisible();
    await expect(page.locator("[data-pro-mode-warnings] li")).toHaveCount(1);
    const layout = await canvasLayout(page);
    expect(layout.scrollTop).toBe(0);
    expect(layout.canvasTop, "el lienzo empieza a la vista").toBeLessThan(layout.areaHeight / 3);
    expect(layout.canvasVisible, "alto visible del lienzo").toBeGreaterThanOrEqual(450);
    // B1: y la HOJA misma (antes ~275 px con dos avisos): se ve con >= 450 px.
    expect(layout.stageVisible, "alto visible de la hoja").toBeGreaterThanOrEqual(450);
    expect(layout.intro).toContain("sr-only");
    expect(await page.locator("[data-pro-mode-notes]").evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    await noHorizontalOverflow(page, "un aviso");
  });

  test("con DOS avisos apilados (y el aviso general de la suite encima) la zona del lienzo sigue siendo >= 450 px", async ({ page }) => {
    await openProPdf(page, await buildSignedAndRestricted(), "avisos.pdf");
    await gotoTab(page, "sign");
    await expect(paletteOrFab(page)).toBeVisible();
    await expect(page.locator("[data-pro-mode-warnings] li")).toHaveCount(2);
    const layout = await canvasLayout(page);
    expect(layout.scrollTop).toBe(0);
    expect(layout.areaHeight, "zona del modo").toBeGreaterThanOrEqual(450);
    expect(layout.canvasTop, "el lienzo empieza a la vista").toBeLessThan(layout.areaHeight / 3);
    // B1: con el aviso general de la suite y los dos avisos propios el lienzo y la hoja se ven con >= 450 px
    // (antes 390 y ~275: los dos avisos van plegados en UNA linea «2 avisos», en la fila de controles).
    expect(layout.canvasVisible, "alto visible del lienzo").toBeGreaterThanOrEqual(450);
    expect(layout.stageVisible, "alto visible de la hoja").toBeGreaterThanOrEqual(450);
    await expect(page.getByRole("button", { name: SE.warningsCount(2), exact: true })).toBeVisible();
    await noHorizontalOverflow(page, "avisos");
    expect(await runAxe(page), "axe con dos avisos").toEqual([]);
  });

  test("con DOS avisos y el aviso general de la suite plegado (documento con cambios): la hoja sigue viendose con >= 450 px", async ({ page }) => {
    await openProPdf(page, await buildSignedAndRestricted(), "avisos.pdf");
    // Dos giros de 90° dejan la pagina como estaba (vertical) pero el documento con cambios: la firma digital se invalida
    // y, con la copia sin contrasena, «Antes de guardar» tiene DOS avisos -> UNA linea.
    const rotate = page.getByRole("button", { name: S.operations.rotateAll90, exact: true });
    await rotate.click();
    await expect(history(page).getByRole("listitem")).toHaveCount(2);
    await rotate.click();
    await expect(history(page).getByRole("listitem")).toHaveCount(3);
    const banner = page.locator("[data-pro-warnings-fold]");
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: new RegExp(`${S.suite.warningsTitle}.*${S.suite.warningsCount(2)}`) })).toBeVisible();
    await gotoTab(page, "sign");
    await expect(paletteOrFab(page)).toBeVisible();
    await expect(page.getByRole("button", { name: SE.warningsCount(2), exact: true })).toBeVisible();
    const layout = await canvasLayout(page);
    expect(layout.scrollTop).toBe(0);
    expect(layout.canvasVisible, "alto visible del lienzo").toBeGreaterThanOrEqual(450);
    expect(layout.stageVisible, "alto visible de la hoja").toBeGreaterThanOrEqual(450);
    await noHorizontalOverflow(page, "dos avisos y banner plegado");
    expect(await runAxe(page), "axe con el banner plegado").toEqual([]);
  });

  test("los avisos plegados: texto completo al expandir, teclado (Intro y Escape con el foco en el boton) y NINGUNA region viva nueva", async ({ page }) => {
    await openProPdf(page, await buildSignedAndRestricted(), "avisos.pdf");
    await gotoTab(page, "sign");
    await expect(paletteOrFab(page)).toBeVisible();
    const fold = page.getByRole("button", { name: SE.warningsCount(2), exact: true });
    const panel = page.locator("[data-pro-mode-warnings-fold] [data-notice-fold-panel]");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    // Plegado: no se ve, pero el texto completo sigue para lectores de pantalla.
    await expect(panel.locator("li")).toHaveCount(2);
    expect(await panel.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await expect(panel).toContainText("firmas digitales");
    await expect(panel).toContainText("contraseña");
    await settleCanvas(page);
    const liveBefore = await page.locator('[role="status"], [role="alert"], [aria-live]').allInnerTexts();
    // Teclado: foco en el boton e Intro lo expande; el foco NO se mueve; Escape lo cierra y el foco sigue en el boton.
    await fold.focus();
    await page.keyboard.press("Enter");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(fold).toBeFocused();
    expect(await panel.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(100);
    await expect(panel.locator("li").nth(0)).toBeVisible();
    await expect(panel.locator("li").nth(1)).toBeVisible();
    expect(await runAxe(page), "axe con los avisos expandidos").toEqual([]);
    await noHorizontalOverflow(page, "avisos expandidos");
    await page.keyboard.press("Escape");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(fold).toBeFocused();
    // Escape NO sale del modo (el pliegue se queda el evento): seguimos en Firmar.
    await expect(paletteOrFab(page)).toBeVisible();
    // Ni abrir ni cerrar tocaron una region viva.
    expect(await page.locator('[role="status"], [role="alert"], [aria-live]').allInnerTexts()).toEqual(liveBefore);
    // Espacio tambien lo abre; un clic lo cierra.
    await page.keyboard.press("Space");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
  });

  test("con UN aviso no hay pliegue: una linea con su texto, como siempre", async ({ page }) => {
    await openProPdf(page, await buildDigitallySigned(), "firmado.pdf");
    await gotoTab(page, "sign");
    await expect(paletteOrFab(page)).toBeVisible();
    await expect(page.locator("[data-pro-mode-warnings-fold]")).toHaveCount(0);
    await expect(page.locator("[data-pro-mode-warnings] li")).toHaveCount(1);
  });

  test("Rellenar con dos avisos del documento: tambien «2 avisos» plegado en la fila de controles", async ({ page }) => {
    await openProPdf(page, await buildSignedAndRestricted(), "avisos.pdf");
    await gotoTab(page, "sign");
    await page.getByRole("tab", { name: SE.switchFill }).click();
    const fold = page.getByRole("button", { name: SE.warningsCount(2), exact: true });
    await expect(fold).toBeVisible();
    await expect(page.locator("[data-pro-mode-warnings] li")).toHaveCount(2);
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-pro-mode-warnings] li").nth(0)).toBeVisible();
    await noHorizontalOverflow(page, "Rellenar con dos avisos");
    expect(await runAxe(page), "axe en Rellenar con los avisos expandidos").toEqual([]);
  });

  test("Rellenar tambien arranca compacto: estado en una linea y una sola cifra de campos", async ({ page }) => {
    await openProPdf(page, await buildForm(), "formulario.pdf");
    await gotoTab(page, "sign");
    await page.getByRole("tab", { name: SE.switchFill }).click();
    await expect(page.getByText(FE.formFound(5), { exact: true })).toBeVisible();
    const text = (await page.locator("[data-pro-mode-host]").innerText()).replace(/\s+/g, " ");
    const counts = [...text.matchAll(/(?:Se encontraron|Se detectaron|Se detectó|Se encontró) (\d+|un) campos?/g)].map((match) => match[0]);
    expect(counts, "una sola cifra de campos").toEqual(["Se encontraron 5 campos"]);
  });
});

test.describe("PDF Pro · modos Firmar y Rellenar · salida y cambio de herramienta", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  test("salir con cambios sin aplicar pregunta; descartar no crea snapshot; el conmutador pide confirmar", async ({ page }) => {
    await openProPdf(page, await buildForm(), "formulario.pdf");
    await gotoTab(page, "sign");
    await addTextHere(page, "Pendiente");
    // Cambiar a Rellenar con trabajo sin aplicar pregunta.
    await page.getByRole("tab", { name: SE.switchFill }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: SE.switchConfirmTitle })).toBeVisible();
    await page.getByRole("button", { name: SE.switchStay }).click();
    await expect(page.locator("[data-pro-mode-switch]").getByRole("tab", { name: SE.switchSign })).toHaveAttribute("aria-selected", "true");
    // Salir a Inicio con cambios pregunta: descartar y salir.
    await page.locator('[data-tab="home"]').click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: HOST.leaveTitle })).toBeVisible();
    await page.getByRole("button", { name: HOST.leaveDiscard }).click();
    await expect(page.locator('[data-tab="home"]')).toHaveAttribute("aria-selected", "true");
    expect(await historyLabels(page)).toEqual(["Original"]);
    await expectFocusNotBody(page, "tras descartar");
  });
});

test.describe("PDF Pro · modos Firmar y Rellenar · ingles", () => {
  test.use({ locale: "en-US", viewport: { width: 1280, height: 800 } });

  test("los modos salen en ingles y el snapshot tambien", async ({ page }) => {
    const en = SIGN_STRINGS.en;
    const ee = SIGN_EMBEDDED_STRINGS.en;
    await page.addInitScript(() => window.localStorage.setItem("optimuspdf.language", "en"));
    await openProPdf(page, await buildContract(), "contract.pdf");
    await page.locator('[data-tab="sign"]').click();
    await expect(page.getByRole("region", { name: ee.regionLabel })).toBeVisible();
    await pickPaletteTool(page, en.paletteLabel, en.fieldTypeText);
    const textboxes = await page.getByRole("textbox").count();
    await clickUntil(page.getByRole("button", { name: en.addTextFieldHere }), async () => (await page.getByRole("textbox").count()) > textboxes);
    await page.getByRole("textbox").last().fill("Hello");
    await page.keyboard.press("Escape");
    await page.locator("[data-pro-mode-apply]").click();
    await expect(page.locator("[data-pro-mode-result]")).toContainText(getModeStrings("en").host.appliedTitle(ee.labelSigned));
  });
});

test.describe("PDF Pro · Firmar · avisos plegados · movil 375×812", () => {
  test.use({ locale: "es-ES", viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("dos avisos: una linea «2 avisos» expandible, sin desbordes; la tarjeta de la firma sigue en su sitio y el lienzo va primero", async ({ page }) => {
    await openProPdf(page, await buildSignedAndRestricted(), "avisos.pdf");
    await gotoTab(page, "sign");
    await expect(paletteOrFab(page)).toBeVisible();
    const fold = page.getByRole("button", { name: SE.warningsCount(2), exact: true });
    await expect(fold).toBeVisible();
    const target = await fold.boundingBox();
    expect(target!.height, "objetivo tactil").toBeGreaterThanOrEqual(44);
    await noHorizontalOverflow(page, "movil, plegado");
    // En movil NO se junta la barra: el dueno de la firma sigue en su tarjeta. Los contadores van DEBAJO de la hoja (la hoja
    // primero: integracion M4 / VP-01; antes estaban encima y la hoja no se veia en un telefono).
    await expect(page.locator("[data-canvas-controls]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: SG.createSignature }).first()).toBeVisible();
    const order = await page.evaluate(() => {
      const host = document.querySelector('[data-canvas="host"]')!;
      const row = document.querySelector("[data-canvas-status-row]")!;
      return host.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING ? "antes" : "despues";
    });
    expect(order).toBe("despues");
    // Expandir: el texto completo de los dos, dentro del ancho del telefono.
    await fold.tap();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    const items = page.locator("[data-pro-mode-warnings] li");
    await expect(items.nth(0)).toBeVisible();
    await expect(items.nth(1)).toBeVisible();
    await expect(items.nth(0)).toContainText("firmas digitales");
    await expect(items.nth(1)).toContainText("contraseña");
    const box = await page.locator("[data-notice-fold-panel]").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await noHorizontalOverflow(page, "movil, expandido");
    expect(await runAxe(page), "axe en movil con los avisos expandidos").toEqual([]);
    await fold.tap();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(paletteOrFab(page)).toBeVisible();
  });
});
