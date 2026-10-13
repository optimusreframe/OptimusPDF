import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import type { Locator, Page } from "@playwright/test";
import { expect, openTool, test, uploadFiles } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageText, requiresPassword } from "../helpers/pdf-inspection";
import { isEncrypted } from "../helpers/pdf-structure";
import { makePdf, pdfUpload } from "../helpers/test-files";
import {
  focusedDescription,
  goToTab,
  isMobile as onMobile,
  noHorizontalOverflow,
  openProPdf,
  openSaveMenu,
  S,
  watchUploads,
} from "../helpers/pro-flow";
import { es } from "../../src/lib/locales/es";
import { MODE_STRINGS } from "../../src/app/pdf-pro/modes/modeStrings";
import { EDIT_STRINGS } from "../../src/app/edit-pdf/strings";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS } from "../../src/app/sign-pdf/signEmbeddedStrings";
import { FILL_EMBEDDED_STRINGS } from "../../src/app/sign-pdf/fillEmbeddedStrings";
import { WATERMARK_STRINGS } from "../../src/app/add-watermark/strings";
import { PAGE_NUMBERS_STRINGS } from "../../src/app/add-page-numbers/strings";
import { PROTECT_STRINGS } from "../../src/app/protect-pdf/strings";
import { PDF_TO_CSV_STRINGS } from "../../src/app/pdf-to-csv/strings";
import { PDF_TO_JSON_STRINGS } from "../../src/app/pdf-to-json/strings";
import { PDF_TO_TEXT_STRINGS } from "../../src/app/pdf-to-text/strings";
import { STRINGS as PDF_TO_WORD_STRINGS } from "../../src/app/pdf-to-word/strings";
import { STRINGS as PDF_TO_JPG_STRINGS } from "../../src/app/pdf-to-jpg/strings";
import { PDF_TO_EXCEL_STRINGS } from "../../src/app/pdf-to-excel/strings";
import { PDF_TO_MARKDOWN_STRINGS } from "../../src/app/pdf-to-markdown/strings";
import { STRINGS as PDF_TO_POWERPOINT_STRINGS } from "../../src/app/pdf-to-powerpoint/strings";

/**
 * PDF Pro · RECORRIDOS COMPLETOS de usuario (Wave 7 · cierre), navegador real y headless, cada uno en escritorio
 * 1280×800 y en movil 375×812 tactil (donde los paneles son hojas `dialog` y las herramientas se eligen en la barra
 * inferior):
 *
 *  (a) Contrato      — abrir 5 paginas, reordenar + eliminar (Aplicar), marca de agua, numerar, editar un texto
 *                      existente, firmar y «Guardar con contraseña»; se verifica el archivo FINAL cifrado paso a paso
 *                      (abriendolo con la contraseña), que el historial no gano ningun paso por guardar y que Ctrl+Z
 *                      global deshace desde el ultimo con su anuncio en la region viva unica.
 *  (b) Formulario    — AcroForm -> Rellenar -> Aplicar -> «Descargar PDF»; los valores se leen con pdf-lib.
 *  (c) Unir y dividir— unir 2 PDF + insertar paginas de otro, Aplicar y dividir por rangos en un ZIP (jszip).
 *  (d) Exportar      — los 8 formatos (texto, Word, imagenes con rango y PNG, CSV y CSV como JSON, JSON, Markdown, Excel,
 *                      PowerPoint); insertar un HTML y deshacerlo.
 *  (e) Recuperacion  — editar, recargar, retomar el borrador (dos caminos) y «Borrar datos locales».
 *  (f) Handoff       — «Abrir en PDF Pro» desde /merge-pdf (2 PDF) y /compress-pdf (1 PDF).
 *
 * En todas: sin errores de consola (guardian de `tool-flow`), sin desborde horizontal, ninguna peticion que suba
 * contenido, foco nunca en <body> tras las acciones importantes y axe-core sin violaciones en dos puntos.
 */

const P = S.pages;
const T = S.docTools;
const E = S.export;
const M = MODE_STRINGS.es;
const HOST = M.host;
const ED = EDIT_STRINGS.es;
const SG = SIGN_STRINGS.es;
const SE = SIGN_EMBEDDED_STRINGS.es;
const FE = FILL_EMBEDDED_STRINGS.es;
const WM = WATERMARK_STRINGS.es;
const PN = PAGE_NUMBERS_STRINGS.es;
const PR = PROTECT_STRINGS.es;
const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = ["color-contrast", "aria-valid-attr-value", "label", "button-name", "link-name"] as const;

test.setTimeout(180_000);

const VIEWPORTS = [
  { name: "escritorio 1280×800", width: 1280, height: 800, touch: false },
  { name: "movil 375×812 tactil", width: 375, height: 812, touch: true },
] as const;

type Tab = "home" | "pages" | "edit" | "annotate" | "sign" | "protect" | "convert";
/** Pestañas que abren un modo en la region central (no una hoja en movil). */
const MODE_TABS: readonly Tab[] = ["edit", "annotate", "sign"];

/* ------------------------------------------------------------------ *
 * Documentos de prueba
 * ------------------------------------------------------------------ */

/** Contrato A4: cada pagina lleva `CONTRATO-n` (titulo) y una clausula editable arriba (lejos de la marca de agua). */
async function buildContract(pages: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  const helvetica = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  for (let n = 1; n <= pages; n += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`CONTRATO-${n}`, { x: 60, y: 780, size: 22, font: bold });
    page.drawText(`Clausula ${n}: importe pactado 1.250,00`, { x: 60, y: 700, size: 14, font: helvetica, color: rgb(0.1, 0.1, 0.1) });
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

const TABLE_ROWS = [
  ["Producto", "Unidades", "Precio"],
  ["Tornillos", "120", "0.15"],
  ["Tuercas", "80", "0.10"],
  ["Arandelas", "200", "0.05"],
] as const;

/**
 * Acta de 5 paginas con texto de sobra (mas de 24 caracteres: nunca se activa el OCR). La pagina 1 lleva ademas una
 * tabla REAL de 3 columnas × 4 filas: celdas de texto alineadas por columnas (rejilla regular, mismo cuerpo).
 */
async function buildActa(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 5; n += 1) {
    const page = document.addPage([595, 842]);
    // A media altura: una linea repetida en la franja superior/inferior de cada pagina se tomaria por un encabezado y se quitaria.
    page.drawText(`ACTA-${n}: contenido de la pagina ${n} del acta`, { x: 60, y: 700, size: 12, font });
    if (n === 1) {
      TABLE_ROWS.forEach((row, rowIndex) => {
        row.forEach((cell, column) => {
          page.drawText(cell, { x: 60 + column * 160, y: 600 - rowIndex * 24, size: 12, font });
        });
      });
    }
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

const HTML_NOTE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Nota</title></head><body style="font-family:sans-serif"><h1>Nota HTML de prueba</h1><p>Este parrafo se convierte en una pagina nueva del documento.</p></body></html>`;

/* ------------------------------------------------------------------ *
 * Localizadores y ayudas comunes (escritorio y movil)
 * ------------------------------------------------------------------ */

const topBar = (page: Page) => page.locator('[data-pro-region="top"]');
const status = (page: Page) => page.getByRole("status");
const historyList = (page: Page) => page.getByRole("list", { name: S.suite.historyTitle });
const grid = (page: Page) => page.getByRole("listbox", { name: /Páginas del documento/ });
const cardAt = (page: Page, n: number) => grid(page).getByRole("option", { name: new RegExp(`^Página ${n} de`) });
const chip = (page: Page) => page.locator("[data-pages-chip]");
/** Paginas del plan del organizador (la cuadricula esta virtualizada: se lee de su etiqueta, no se cuentan las tarjetas pintadas). */
const expectPlanSize = (page: Page, total: number) => expect(grid(page)).toHaveAttribute("aria-label", P.gridLabel(total));
const pagesButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const hostApply = (page: Page) => page.locator("[data-pro-mode-apply]");
const modeResult = (page: Page) => page.locator("[data-pro-mode-result]");
const undoButton = (page: Page) => topBar(page).getByRole("button", { name: S.suite.undo, exact: true });

/** El foco nunca queda en <body> tras una accion importante (se reintenta: una hoja que se cierra tarda unos cuadros). */
async function focusNotBody(page: Page, where: string): Promise<void> {
  await expect
    .poll(() => focusedDescription(page), { message: `el foco no debe quedar en <body> (${where})`, timeout: 10_000 })
    .not.toBe("<body>");
}

async function runAxe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
  }, AXE_RULES);
}

/**
 * axe sin violaciones. Se espera a que las animaciones CSS terminen y se reintenta unos segundos: un texto a medio
 * fundir (entrada de pagina, hoja que se cierra) mediria un contraste que el usuario no llega a ver. Un defecto de
 * verdad persiste y hace fallar la prueba con la lista de violaciones.
 */
async function expectNoAxeViolations(page: Page, where: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(async () => {
          const finite = document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime as number));
          await Promise.allSettled(finite.map((animation) => animation.finished));
        });
        return runAxe(page);
      },
      { message: `axe en ${where}`, timeout: 8_000, intervals: [250, 500, 1000] },
    )
    .toEqual([]);
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

/**
 * Cierra todas las hojas abiertas con su boton «Cerrar» (Escape primero suelta la seleccion de paginas). Una hoja que ya
 * esta saliendo puede desaparecer mientras se la intenta cerrar: cada intento es corto y se vuelve a mirar.
 */
async function closeSheets(page: Page): Promise<void> {
  const dialogs = page.getByRole("dialog");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const count = await dialogs.count();
    if (count === 0) return;
    await dialogs
      .last()
      .getByRole("button", { name: es.common.close, exact: true })
      .first()
      .click({ timeout: 1500 })
      .catch(() => undefined);
    await expect
      .poll(() => dialogs.count(), { timeout: 1500 })
      .toBeLessThan(count)
      .catch(() => undefined);
  }
  await expect(dialogs).toHaveCount(0);
}

/** Abre una pestaña: escritorio, la de arriba; movil, el boton de la barra inferior (con la hoja de antes ya cerrada). */
async function openTab(page: Page, tab: Tab): Promise<void> {
  if (onMobile(page)) {
    await closeSheets(page);
    await goToTab(page, tab);
    if (!MODE_TABS.includes(tab)) {
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await waitUntilStill(page.getByRole("dialog").last());
    }
  } else {
    await goToTab(page, tab);
    await expect(page.locator(`[role="tab"][data-tab="${tab}"]`)).toHaveAttribute("aria-selected", "true");
  }
}

/** Pasos del historial y el actual (esta en «Inicio»; en movil se abre su hoja y se vuelve a cerrar). */
async function readHistory(page: Page): Promise<{ labels: string[]; current: string }> {
  await openTab(page, "home");
  await expect(historyList(page)).toBeVisible();
  const labels = await historyList(page)
    .getByRole("listitem")
    .evaluateAll((nodes) => nodes.map((node) => node.querySelector("span")?.textContent?.trim() ?? ""));
  const current = ((await historyList(page).locator("[aria-current='step']").locator("span").first().textContent()) ?? "").trim();
  if (onMobile(page)) await closeSheets(page);
  return { labels, current };
}

async function expectPageCount(page: Page, count: number): Promise<void> {
  await expect(topBar(page)).toContainText(S.suite.pageCount(count));
}

/** «Descargar» de la barra del documento (cierra antes cualquier hoja). */
async function downloadCurrent(page: Page): Promise<{ bytes: Buffer; filename: string }> {
  await closeSheets(page);
  return downloadFile(page, () => topBar(page).getByRole("button", { name: S.suite.download, exact: true }).click());
}

/** Abre el menu «Más acciones» de la barra superior (escritorio y movil) y devuelve su lista. */
async function openMoreMenu(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: S.shell.more, exact: true }).click();
  const menu = page.getByRole("menu", { name: S.shell.more });
  await expect(menu).toBeVisible();
  return menu;
}

/** Herramienta de documento de «Inicio» (marca de agua, numerar...): abrirla, aplicarla y volver a la lista. */
async function openDocTool(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: T.launcher.open(title), exact: true }).click();
  const heading = page.getByRole("heading", { level: 2, name: title, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
}

async function backToDocTools(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: T.launcher.back, exact: true }).click();
  await expect(page.getByRole("button", { name: T.launcher.open(title), exact: true })).toBeFocused();
}

const applyDocTool = (page: Page): Locator => page.getByRole("button", { name: T.runner.apply, exact: true });

/** Cuenta los borradores guardados en la base real de IndexedDB de PDF Pro. */
async function draftCount(page: Page): Promise<number> {
  return page.evaluate(
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
  );
}

/** `true` si algun borrador se guardo (o reescribio) a partir de `since` (ISO 8601): el autoguardado ya recogio la ultima edicion. */
async function draftSavedSince(page: Page, since: string): Promise<boolean> {
  return page.evaluate(
    (threshold) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open("optimuspdf-pro-drafts");
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("draftMeta")) {
            db.close();
            resolve(false);
            return;
          }
          const all = db.transaction("draftMeta").objectStore("draftMeta").getAll();
          all.onsuccess = () => {
            db.close();
            resolve((all.result as Array<{ savedAt: string }>).some((meta) => meta.savedAt >= threshold));
          };
        };
      }),
    since,
  );
}

/** Operaciones de pintado de imagen de una pagina (pdf.js; con contraseña si el PDF esta cifrado): la firma es una imagen. */
async function imagePaintOps(bytes: Buffer, pageNumber: number, password?: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    ...(password === undefined ? {} : { password }),
    standardFontDataUrl: `${path.resolve(process.cwd(), "node_modules/pdfjs-dist/standard_fonts")}${path.sep}`,
  });
  const pdf = await loading.promise;
  try {
    const target = await pdf.getPage(pageNumber);
    const ops = await target.getOperatorList();
    const imageOps = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
    return (ops.fnArray as number[]).filter((fn) => imageOps.has(fn)).length;
  } finally {
    await loading.destroy();
  }
}

/** Lo que el recorrido «Contrato» espera ver en el PDF despues de cada paso (o de deshacerlo). */
type ContractState = {
  /** Paginas originales (1..5) en el orden en que estan ahora. */
  order: readonly number[];
  watermark: boolean;
  numbers: boolean;
  edited: boolean;
  signature: boolean;
};

const CONTRACT_WATERMARK = "BORRADOR";
const CONTRACT_EDITED = "Importe final: 99,00";
const CONTRACT_PASSWORD = "Contrato-2026";

/** Comprueba, leyendolo con pdf.js, que `bytes` (con su contraseña, si la lleva) esta en el estado `state`. */
async function expectContractState(bytes: Buffer, state: ContractState, where: string, password?: string): Promise<void> {
  expect(await getPageCount(bytes, password), `${where}: paginas`).toBe(state.order.length);
  let imagePages = 0;
  for (let index = 0; index < state.order.length; index += 1) {
    const number = index + 1;
    const original = state.order[index];
    const text = await getPageText(bytes, number, password);
    expect(text, `${where}, pagina ${number}: orden (CONTRATO-${original})`).toContain(`CONTRATO-${original}`);
    // En la pagina 1 editada, F2 QUITA del PDF la clausula original (ya no queda extraible): se sustituye por el texto nuevo.
    if (number === 1 && state.edited) {
      expect(text, `${where}, pagina ${number}: la clausula original se elimino de verdad`).not.toContain(`Clausula ${original}: importe pactado 1.250,00`);
    } else {
      expect(text, `${where}, pagina ${number}: clausula original`).toContain(`Clausula ${original}: importe pactado 1.250,00`);
    }
    if (state.watermark) expect(text, `${where}, pagina ${number}: marca de agua`).toContain(CONTRACT_WATERMARK);
    else expect(text, `${where}, pagina ${number}: sin marca de agua`).not.toContain(CONTRACT_WATERMARK);
    if (state.numbers) expect(text, `${where}, pagina ${number}: numeracion`).toContain(`Página ${number} de ${state.order.length}`);
    else expect(text, `${where}, pagina ${number}: sin numeracion`).not.toContain("Página");
    if (number === 1) {
      if (state.edited) expect(text, `${where}: texto editado`).toContain(CONTRACT_EDITED);
      else expect(text, `${where}: sin texto editado`).not.toContain(CONTRACT_EDITED);
    }
    if ((await imagePaintOps(bytes, number, password)) > 0) imagePages += 1;
  }
  expect(imagePages, `${where}: la firma es una imagen en ${state.signature ? "exactamente una pagina" : "ninguna pagina"}`).toBe(state.signature ? 1 : 0);
}

/* ------------------------------------------------------------------ *
 * Piezas de «Páginas»
 * ------------------------------------------------------------------ */

/** Una accion de «Páginas»: directa si la barra es ancha, y si no, dentro de «Más» (hoja de acciones). */
async function pagesAction(page: Page, name: string): Promise<void> {
  // La hoja de antes (unir, insertar, dividir...) sale con una animacion: «Más» se abre cuando ya no queda ninguna
  // (en movil queda la hoja del propio panel de Páginas).
  const base = onMobile(page) ? 1 : 0;
  await expect(page.getByRole("dialog")).toHaveCount(base);
  const direct = pagesButton(page, name);
  if ((await direct.count()) > 0 && (await direct.first().isVisible())) {
    await direct.first().click();
    return;
  }
  await pagesButton(page, P.actions.more).click();
  await expect(page.getByRole("dialog")).toHaveCount(base + 1);
  const sheet = page.getByRole("dialog").last();
  await waitUntilStill(sheet);
  await sheet.getByRole("button", { name, exact: true }).click();
}

/** Una accion de «Páginas» que abre el selector de archivos del sistema: se atiende el `filechooser` como un usuario. */
async function pagesActionWithFiles(page: Page, name: string, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pagesAction(page, name)]);
  await chooser.setFiles(files);
}

/* ------------------------------------------------------------------ *
 * Piezas de los modos Editar y Firmar
 * ------------------------------------------------------------------ */

async function enterEditMode(page: Page): Promise<void> {
  await openTab(page, "edit");
  await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-palette-item="select"]')).toBeVisible();
}

/** Selecciona un bloque de texto y lo abre para editar: doble clic (raton) o dos toques (dedo). */
async function openBlockEditor(page: Page, text: string): Promise<Locator> {
  const target = page.getByRole("button", { name: new RegExp(`^Texto: ${text}`) });
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  if (onMobile(page)) {
    const rect = (await target.boundingBox())!;
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
  } else {
    await target.dblclick();
  }
  const editor = page.getByRole("textbox", { name: ED.inline.editorLabel });
  await expect(editor).toBeFocused();
  return editor;
}

/** «Crear firma» -> compositor -> pestaña Escribir -> nombre -> «Usar esta firma»: queda colocada en el lienzo. */
async function createTypedSignature(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: SG.createSignature }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: SG.modeType }).click();
  await dialog.getByLabel(SG.typeLabel, { exact: true }).fill(name);
  await dialog.getByRole("button", { name: SG.save }).click();
  await expect(page.getByRole("group", { name: `${SG.soloSignatureLabel}, ${SG.soloSignatureA11y}` })).toBeVisible();
  // El compositor sale con una animacion: hasta que no desaparece del todo, axe mediria colores a medio fundir.
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/* ------------------------------------------------------------------ *
 * Recorridos
 * ------------------------------------------------------------------ */

for (const viewport of VIEWPORTS) {
  test.describe(`PDF Pro · recorridos completos · ${viewport.name}`, () => {
    test.use({
      locale: "es-ES",
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
    });

    /* ---------------------------------------------------------------- *
     * (a) Contrato
     * ---------------------------------------------------------------- */
    test("Contrato: páginas, marca de agua, numerar, editar, firmar y guardar con contraseña; todo verificado en el archivo cifrado y deshecho paso a paso", async ({
      page,
    }) => {
      const uploads = watchUploads(page);
      const PASSWORD = CONTRACT_PASSWORD;
      const WATERMARK = CONTRACT_WATERMARK;
      const EDITED = CONTRACT_EDITED;
      /** Orden final de las paginas originales tras «Mover después» ×2 sobre la 1 y eliminar la 4. */
      const ORDER = [2, 3, 1, 5];

      await openProPdf(page, { name: "contrato.pdf", bytes: await buildContract(5) });
      await expectPageCount(page, 5);
      await expect(status(page)).toHaveCount(1);
      await expect(status(page)).toHaveText(S.announce.opened("contrato.pdf"));
      await focusNotBody(page, "al abrir el contrato");
      await noHorizontalOverflow(page);

      /* 1 · Páginas: reordenar (la 1 dos puestos a la derecha) y eliminar (la 4 original) -> UN snapshot. */
      await openTab(page, "pages");
      await expectPlanSize(page, 5);
      await cardAt(page, 1).click();
      await pagesButton(page, P.actions.moveAfter).click();
      await pagesButton(page, P.actions.moveAfter).click();
      await cardAt(page, 4).click();
      await pagesButton(page, P.actions.remove).click();
      await expectPlanSize(page, 4);
      await expect(chip(page)).not.toHaveText(P.status.noChanges);
      await pagesButton(page, P.status.apply).click();
      await expect(chip(page)).toHaveText(P.status.noChanges);
      await expect(status(page)).toHaveText(/^Aplicado: /);
      await focusNotBody(page, "tras aplicar los cambios de páginas");
      await expectPageCount(page, 4);
      const afterPages = await readHistory(page);
      expect(afterPages.labels).toHaveLength(2);
      expect(afterPages.labels[0]).toBe("Original");
      const pagesLabel = afterPages.labels[1];
      expect(pagesLabel.toLowerCase(), "etiqueta del paso de páginas").toContain(P.label.remove(1));

      /* 2 · Marca de agua. */
      await openTab(page, "home");
      await openDocTool(page, T.tools.watermark.title);
      await page.getByLabel(WM.textLabel).fill(WATERMARK);
      await expect(page.getByAltText(T.runner.previewAlt(1))).toBeVisible({ timeout: 30_000 });
      await noHorizontalOverflow(page);
      await expectNoAxeViolations(page, "el panel de marca de agua");
      await applyDocTool(page).click();
      await expect(status(page)).toHaveText(S.announce.applied(T.labels.watermarkText(WATERMARK)));
      await focusNotBody(page, "tras aplicar la marca de agua");
      await backToDocTools(page, T.tools.watermark.title);

      /* 3 · Numerar páginas («Página n de p»). */
      await openDocTool(page, T.tools["page-numbers"].title);
      await page.getByRole("radio", { name: PN.formatPageNofP, exact: true }).click();
      await applyDocTool(page).click();
      await expect(status(page)).toHaveText(S.announce.applied(T.labels.pageNumbers));
      await focusNotBody(page, "tras numerar las páginas");
      await backToDocTools(page, T.tools["page-numbers"].title);

      /* 4 · Editar un texto existente (modo Editar): la clausula de la primera pagina. */
      await enterEditMode(page);
      await noHorizontalOverflow(page);
      const goTo = page.getByRole("textbox", { name: ED.inline.goToPageLabel });
      if ((await goTo.inputValue()) !== "1") {
        await goTo.fill("1");
        await goTo.press("Enter");
      }
      await expect(goTo).toHaveValue("1");
      const editor = await openBlockEditor(page, `Clausula ${ORDER[0]}:`);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(EDITED);
      await expect(editor).toHaveText(EDITED);
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await expect(page.locator("[data-pro-mode-bar]")).toContainText(HOST.dirty);
      await hostApply(page).click();
      await expect(modeResult(page)).toContainText(HOST.appliedTitle(M.edit.label(1)));
      await focusNotBody(page, "tras aplicar la edición");

      /* 5 · Firmar (firma tecleada) sobre el documento ya editado. */
      await openTab(page, "sign");
      await expect(page.getByRole("region", { name: SE.regionLabel })).toBeVisible();
      await createTypedSignature(page, "Ana Pérez");
      await expect(hostApply(page)).not.toHaveAttribute("aria-disabled", "true");
      await focusNotBody(page, "tras crear la firma");
      await noHorizontalOverflow(page);
      await expectNoAxeViolations(page, "el modo Firmar con la firma colocada");
      await hostApply(page).click();
      await expect(modeResult(page)).toContainText(HOST.appliedTitle(SE.labelSigned));
      await focusNotBody(page, "tras aplicar la firma");

      /* El historial conserva los 4 ultimos pasos, en orden (el presupuesto de memoria puede descartar los primeros). */
      const beforeSave = await readHistory(page);
      expect(beforeSave.labels[0]).toBe("Original");
      expect(beforeSave.labels.slice(-4)).toEqual([
        T.labels.watermarkText(WATERMARK),
        T.labels.pageNumbers,
        M.edit.label(1),
        SE.labelSigned,
      ]);
      expect(beforeSave.current).toBe(SE.labelSigned);

      /* 6 · Guardar con contraseña (no es un paso del historial). */
      const menu = await openSaveMenu(page);
      await menu.getByRole("menuitem", { name: S.save.saveWithPassword }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(PR.passwordLabel, { exact: true }).fill(PASSWORD);
      await dialog.getByLabel(PR.confirmLabel, { exact: true }).fill(PASSWORD);
      const finalFile = await downloadFile(page, () => dialog.getByRole("button", { name: T.protect.saveButton, exact: true }).click());
      expect(finalFile.filename).toBe("contrato-protegido.pdf");
      await expect(dialog).toBeHidden();
      await focusNotBody(page, "tras guardar con contraseña");
      await noHorizontalOverflow(page);

      /* El archivo FINAL esta cifrado y, abierto con la contraseña, trae TODOS los pasos. */
      const final = finalFile.bytes;
      expect(await isEncrypted(final)).toBe(true);
      expect(await requiresPassword(final)).toBe(true);
      expect(await requiresPassword(final, "contraseña-equivocada")).toBe(true);
      expect(await requiresPassword(final, PASSWORD)).toBe(false);
      const FULL: ContractState = { order: ORDER, watermark: true, numbers: true, edited: true, signature: true };
      await expectContractState(final, FULL, "archivo final cifrado", PASSWORD);

      /* Guardar con contraseña no creo ningun paso y el documento quedo guardado. */
      const afterSave = await readHistory(page);
      expect(afterSave.labels).toEqual(beforeSave.labels);
      expect(afterSave.current).toBe(SE.labelSigned);
      await expect(topBar(page)).toContainText(S.suite.saved);

      /* 7 · Ctrl+Z global (foco fuera de campos): deshace desde el ultimo, con su anuncio en la region viva unica, y el
         PDF que se descarga en cada paso es el del paso anterior. */
      await topBar(page).locator("h1").focus();
      const undo = async (label: string, exact = true) => {
        await page.keyboard.press("Control+z");
        if (exact) await expect(status(page)).toHaveText(S.announce.undone(label));
        // Con el presupuesto de memoria al limite el anuncio añade los pasos que se saltan: se busca el nombre.
        else await expect(status(page)).toContainText(S.announce.undone(label));
        await expect(status(page)).toHaveCount(1);
        await focusNotBody(page, `tras deshacer «${label}»`);
      };
      await undo(SE.labelSigned);
      await expectContractState((await downloadCurrent(page)).bytes, { ...FULL, signature: false }, "sin la firma");
      await undo(M.edit.label(1));
      await expectContractState((await downloadCurrent(page)).bytes, { ...FULL, signature: false, edited: false }, "sin la edicion");
      await undo(T.labels.pageNumbers);
      await expectContractState((await downloadCurrent(page)).bytes, { ...FULL, signature: false, edited: false, numbers: false }, "sin los numeros");
      await undo(T.labels.watermarkText(WATERMARK), false);
      // El paso de «Páginas» solo sigue en el historial si el presupuesto de memoria no lo descarto antes.
      if ((await undoButton(page).getAttribute("aria-disabled")) !== "true") {
        await expectContractState(
          (await downloadCurrent(page)).bytes,
          { order: ORDER, watermark: false, numbers: false, edited: false, signature: false },
          "solo con los cambios de páginas",
        );
        await page.keyboard.press("Control+z");
      }
      await expect(status(page)).toContainText(pagesLabel);
      await expect(undoButton(page)).toHaveAttribute("aria-disabled", "true");
      await expectPageCount(page, 5);
      const restored = await downloadCurrent(page);
      expect(restored.filename).toBe("contrato-pro.pdf");
      await expectContractState(restored.bytes, { order: [1, 2, 3, 4, 5], watermark: false, numbers: false, edited: false, signature: false }, "documento original");
      await focusNotBody(page, "tras deshacer todo");

      expect(uploads.requests).toEqual([]);
    });

    /* ---------------------------------------------------------------- *
     * (b) Formulario
     * ---------------------------------------------------------------- */
    test("Formulario: AcroForm, modo Rellenar, Aplicar y «Descargar PDF» con los valores en los campos", async ({ page }) => {
      const uploads = watchUploads(page);
      await openProPdf(page, { name: "formulario.pdf", bytes: await buildForm() });
      await openTab(page, "sign");
      await page.getByRole("tab", { name: SE.switchFill }).click();
      await expect(page.getByText(FE.formFound(5), { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: FE.regionLabel })).toBeVisible();
      await noHorizontalOverflow(page);
      await expectNoAxeViolations(page, "el modo Rellenar");

      const tap = async (label: RegExp) => {
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
      await focusNotBody(page, "tras rellenar los campos");
      await expectNoAxeViolations(page, "el modo Rellenar con valores");

      await hostApply(page).click();
      await expect(modeResult(page)).toContainText(HOST.appliedTitle(FE.labelFilled(4)));
      await focusNotBody(page, "tras aplicar el formulario");
      expect((await readHistory(page)).labels).toEqual(["Original", FE.labelFilled(4)]);

      // «Descargar PDF» desde el menu de guardado (escritorio: «Guardar y exportar»; movil: «Más acciones»).
      const menu = await openSaveMenu(page);
      const filled = await downloadFile(page, () => menu.getByRole("menuitem", { name: S.save.downloadPdf }).click());
      expect(filled.filename).toBe("formulario-pro.pdf");
      await expect(status(page)).toHaveText(S.save.downloaded("formulario-pro.pdf"));
      await expect(topBar(page)).toContainText(S.suite.saved);
      await focusNotBody(page, "tras descargar el formulario");

      const form = (await PDFDocument.load(filled.bytes, { updateMetadata: false })).getForm();
      expect(form.getFields()).toHaveLength(5);
      expect(form.getTextField("nombre").getText()).toBe("Ñandú José");
      expect(form.getTextField("apellido").getText()).toBe("Pérez");
      expect(form.getCheckBox("acepto").isChecked()).toBe(true);
      expect(form.getDropdown("pais").getSelected()).toEqual(["México"]);
      expect(form.getTextField("notas").getText() ?? "").toBe("");
      expect(await getPageText(filled.bytes, 1)).toContain("Formulario de alta");
      await noHorizontalOverflow(page);
      expect(uploads.requests).toEqual([]);
    });

    /* ---------------------------------------------------------------- *
     * (c) Unir y dividir
     * ---------------------------------------------------------------- */
    test("Unir y dividir: unir 2 PDF e insertar páginas de otro, Aplicar y dividir por rangos en un ZIP de nombres únicos", async ({ page }) => {
      const uploads = watchUploads(page);
      const base = await makePdf({ pages: 3, label: "BASE" });
      const segundo = await makePdf({ pages: 2, label: "SEGUNDO" });
      const tercero = await makePdf({ pages: 4, label: "TERCERO" });
      const cuarto = await makePdf({ pages: 3, label: "CUARTO" });
      await openProPdf(page, { name: "informe ñandú.pdf", bytes: base });
      await expectPageCount(page, 3);

      await openTab(page, "pages");
      await expectPlanSize(page, 3);

      // Unir 2 PDF más (Más → «Unir PDFs…»), al final.
      await pagesActionWithFiles(page, P.actions.mergePdfs, [pdfUpload("segundo.pdf", segundo), pdfUpload("tercero.pdf", tercero)]);
      const merge = page.getByRole("dialog").last();
      await expect(merge.getByRole("button", { name: P.sheets.mergeSubmit(2, 6) })).toBeEnabled({ timeout: 30_000 });
      await merge.getByRole("button", { name: P.sheets.mergeSubmit(2, 6) }).click();
      await expectPlanSize(page, 9);

      // Insertar desde PDF: las páginas 2 y 3 de otro documento, al principio.
      await pagesActionWithFiles(page, P.actions.insertFromPdf, [pdfUpload("cuarto.pdf", cuarto)]);
      const insert = page.getByRole("dialog").last();
      await expect(insert.getByRole("option")).toHaveCount(3, { timeout: 30_000 });
      await insert.getByRole("button", { name: P.sheets.pdfSelectNone }).click();
      await insert.getByRole("option").nth(1).click();
      if (onMobile(page)) await insert.getByRole("option").nth(2).tap();
      else await insert.getByRole("option").nth(2).click({ modifiers: ["ControlOrMeta"] });
      await insert.getByRole("radio", { name: P.sheets.positionStart }).click();
      await insert.getByRole("button", { name: P.sheets.pdfSubmit(2) }).click();
      await expectPlanSize(page, 11);
      await noHorizontalOverflow(page);

      // Aplicar: UN solo snapshot.
      await pagesButton(page, P.status.apply).click();
      await expect(chip(page)).toHaveText(P.status.noChanges, { timeout: 60_000 });
      await focusNotBody(page, "tras aplicar la unión");
      await expectNoAxeViolations(page, "«Páginas» tras unir");
      await expectPageCount(page, 11);
      const history = await readHistory(page);
      expect(history.labels).toHaveLength(2);
      expect(history.labels[0]).toBe("Original");

      // El documento unido, tal cual: el orden de las fuentes.
      const merged = await downloadCurrent(page);
      expect(merged.filename).toBe("informe ñandú-pro.pdf");
      expect(await getPageCount(merged.bytes)).toBe(11);
      const expectedTexts = ["CUARTO-2", "CUARTO-3", "BASE-1", "BASE-2", "BASE-3", "SEGUNDO-1", "SEGUNDO-2", "TERCERO-1", "TERCERO-2", "TERCERO-3", "TERCERO-4"];
      for (let index = 0; index < expectedTexts.length; index += 1) {
        expect(await getPageText(merged.bytes, index + 1), `pagina ${index + 1} del documento unido`).toContain(expectedTexts[index]);
      }

      // Dividir por rangos: una parte por documento de origen.
      await openTab(page, "pages");
      await expectPlanSize(page, 11);
      await pagesAction(page, P.actions.split);
      const split = page.getByRole("dialog").last();
      await split.getByLabel(P.sheets.splitRangesLabel).fill("1-2, 3-5, 6-7, 8-11");
      await expect(split.getByText(/Se crearán 4 archivos/)).toBeVisible();
      await expectNoAxeViolations(page, "la hoja Dividir");
      const zipped = await downloadFile(page, () => split.getByRole("button", { name: P.sheets.splitSubmit }).click());
      expect(zipped.filename).toBe("informe ñandú-dividido.zip");
      const zip = await JSZip.loadAsync(zipped.bytes);
      const names = Object.keys(zip.files);
      expect(names, "una parte por rango").toHaveLength(4);
      expect(new Set(names.map((name) => name.normalize("NFC").toLowerCase())).size, "nombres únicos").toBe(4);
      for (const name of names) expect(name.normalize("NFC"), "cada parte es un PDF con el nombre del documento").toMatch(/^informe ñandú.*\.pdf$/);
      // Cada parte es exactamente un documento de origen: (páginas, rótulo) de las cuatro, sea cual sea su nombre.
      const found: string[] = [];
      for (const name of names) {
        const part = Buffer.from(await zip.files[name].async("uint8array"));
        const pageCount = await getPageCount(part);
        const label = /^[A-Z]+/.exec(await getPageText(part, 1))?.[0] ?? "?";
        expect(await getPageText(part, pageCount), `${name}: la ultima pagina es del mismo documento de origen`).toContain(label);
        found.push(`${label}:${pageCount}`);
      }
      expect(found.sort()).toEqual(["BASE:3", "CUARTO:2", "SEGUNDO:2", "TERCERO:4"]);
      await expect(status(page)).toHaveText(P.sheets.splitDone(4));
      await focusNotBody(page, "tras dividir");

      // Rangos repetidos: los nombres del ZIP siguen siendo únicos y ninguna parte se pierde.
      await pagesAction(page, P.actions.split);
      const again = page.getByRole("dialog").last();
      await again.getByLabel(P.sheets.splitRangesLabel).fill("1-2, 1-2, 3-5");
      await expect(again.getByText(/Se crearán 3 archivos/)).toBeVisible();
      const duplicated = await downloadFile(page, () => again.getByRole("button", { name: P.sheets.splitSubmit }).click());
      const duplicatedZip = await JSZip.loadAsync(duplicated.bytes);
      const duplicatedNames = Object.keys(duplicatedZip.files);
      expect(duplicatedNames).toHaveLength(3);
      expect(new Set(duplicatedNames.map((name) => name.normalize("NFC").toLowerCase())).size, "nombres únicos con rangos repetidos").toBe(3);
      const duplicatedCounts: number[] = [];
      for (const name of duplicatedNames) {
        duplicatedCounts.push(await getPageCount(Buffer.from(await duplicatedZip.files[name].async("uint8array"))));
      }
      expect(duplicatedCounts.sort(), "2 + 2 + 3 paginas").toEqual([2, 2, 3]);

      // Dividir no toca el documento ni el historial.
      expect((await readHistory(page)).labels).toEqual(history.labels);
      await noHorizontalOverflow(page);
      expect(uploads.requests).toEqual([]);
    });

    /* ---------------------------------------------------------------- *
     * (d) Exportar
     * ---------------------------------------------------------------- */
    test("Exportar: los 8 formatos (texto, Word, imágenes con rango y PNG, CSV y CSV como JSON, JSON, Markdown, Excel y PowerPoint); insertar un HTML y deshacerlo", async ({ page }) => {
      const uploads = watchUploads(page);
      await openProPdf(page, { name: "acta.pdf", bytes: await buildActa() });
      await expectPageCount(page, 5);

      const exportCard = async (id: string): Promise<Locator> => {
        await openTab(page, "convert");
        const card = page.locator(`[data-export="${id}"]`);
        await card.scrollIntoViewIfNeeded();
        await expect(card).toBeVisible();
        return card;
      };

      // Texto (.txt): el contenido de todas las paginas, en orden.
      const textCard = await exportCard("text");
      await expectNoAxeViolations(page, "la pestaña Convertir");
      const text = await downloadFile(page, () => textCard.getByRole("button", { name: E.formats.text.title }).click());
      expect(text.filename).toBe(`acta-${PDF_TO_TEXT_STRINGS.es.filenameSuffix}.txt`);
      const plain = text.bytes.toString("utf8");
      let cursor = -1;
      for (let n = 1; n <= 5; n += 1) {
        const at = plain.indexOf(`ACTA-${n}: contenido de la pagina ${n} del acta`);
        expect(at, `texto de la pagina ${n}`).toBeGreaterThan(cursor);
        cursor = at;
      }
      await expect(status(page)).toHaveText(E.card.done(text.filename));
      await focusNotBody(page, "tras exportar a texto");

      // Word (.docx): un ZIP OOXML valido con el texto en `word/document.xml`.
      const wordCard = await exportCard("word");
      const word = await downloadFile(page, () => wordCard.getByRole("button", { name: E.formats.word.title }).click());
      expect(word.filename).toBe(`acta-${PDF_TO_WORD_STRINGS.es.filenameSuffix}.docx`);
      const docx = await JSZip.loadAsync(word.bytes);
      expect(Object.keys(docx.files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]));
      const documentXml = await docx.file("word/document.xml")!.async("string");
      expect(documentXml).toContain("<w:document");
      for (let n = 1; n <= 5; n += 1) expect(documentXml, `docx: pagina ${n}`).toContain(`ACTA-${n}`);
      expect(documentXml).toContain("Tornillos");

      // Imágenes: rango «2-3» en PNG -> ZIP con dos PNG de nombres únicos.
      const imagesCard = await exportCard("images");
      await imagesCard.getByRole("button", { name: E.card.showOptions }).click();
      await imagesCard.getByRole("tab", { name: E.images.png }).click();
      await imagesCard.getByRole("tab", { name: E.images.scopeRange }).click();
      await imagesCard.getByLabel(E.images.rangeLabel).fill("2-3");
      await expect(imagesCard.getByText(E.images.summary(2, true))).toBeVisible();
      await expectNoAxeViolations(page, "las opciones de exportar a imágenes");
      const images = await downloadFile(page, () => imagesCard.getByRole("button", { name: E.formats.images.title }).click());
      expect(images.filename).toBe(`acta-${PDF_TO_JPG_STRINGS.es.filenameSuffix}.zip`);
      const imageZip = await JSZip.loadAsync(images.bytes);
      const prefix = PDF_TO_JPG_STRINGS.es.filePrefix;
      expect(Object.keys(imageZip.files).sort()).toEqual([`${prefix}-2.png`, `${prefix}-3.png`]);
      for (const name of Object.keys(imageZip.files)) {
        const head = await imageZip.file(name)!.async("uint8array");
        expect([...head.slice(0, 8)], `${name}: cabecera PNG`).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      }

      // CSV: la tabla REAL de la pagina 1 (3 columnas × 4 filas); si el motor no la detecta, error claro y sin colgarse.
      const csvCard = await exportCard("csv");
      const csvButton = csvCard.getByRole("button", { name: E.formats.csv.title });
      const csvOutcome = await Promise.race([
        downloadFile(page, () => csvButton.click()).then((file) => ({ kind: "file" as const, file })),
        csvCard
          .getByRole("alert")
          .waitFor({ state: "visible", timeout: 60_000 })
          .then(() => ({ kind: "error" as const })),
      ]);
      if (csvOutcome.kind === "file") {
        expect(csvOutcome.file.filename).toBe(`acta-${PDF_TO_CSV_STRINGS.es.filenameSuffix}.csv`);
        const rows = csvOutcome.file.bytes
          .toString("utf8")
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split(","));
        expect(rows, "CSV: 4 filas × 3 columnas").toEqual(TABLE_ROWS.map((row) => [...row]));

        // El mismo motor en JSON: [{ table: 1, rows: [[...]] }].
        await csvCard.getByRole("button", { name: E.card.showOptions }).click();
        await csvCard.getByRole("tab", { name: PDF_TO_CSV_STRINGS.es.formatJson }).click();
        const csvJson = await downloadFile(page, () => csvButton.click());
        expect(csvJson.filename).toBe(`acta-${PDF_TO_CSV_STRINGS.es.filenameSuffix}.json`);
        expect(JSON.parse(csvJson.bytes.toString("utf8"))).toEqual([{ table: 1, rows: TABLE_ROWS.map((row) => [...row]) }]);
      } else {
        await expect(csvCard.getByRole("alert")).toContainText(es.tool.errors.noTablesFound);
        test.info().annotations.push({ type: "csv", description: "el motor no detecto la tabla de prueba: se comprobo el error claro noTablesFound" });
      }

      // JSON (.json): la estructura del documento, con sus parrafos.
      const jsonCard = await exportCard("json");
      const json = await downloadFile(page, () => jsonCard.getByRole("button", { name: E.formats.json.title }).click());
      expect(json.filename).toBe(`acta-${PDF_TO_JSON_STRINGS.es.filenameSuffix}.json`);
      const parsed = JSON.parse(json.bytes.toString("utf8"));
      expect(parsed).toBeTruthy();
      expect(JSON.stringify(parsed)).toContain("ACTA-3: contenido de la pagina 3 del acta");

      // Markdown (.md): el texto y la tabla como tabla GFM.
      const markdownCard = await exportCard("markdown");
      const markdown = await downloadFile(page, () => markdownCard.getByRole("button", { name: E.formats.markdown.title }).click());
      expect(markdown.filename).toBe(`acta-${PDF_TO_MARKDOWN_STRINGS.es.filenameSuffix}.md`);
      const md = markdown.bytes.toString("utf8");
      for (let n = 1; n <= 5; n += 1) expect(md, `markdown: pagina ${n}`).toContain(`ACTA-${n}`);
      expect(md).toMatch(/\|\s*Producto\s*\|\s*Unidades\s*\|\s*Precio\s*\|/);
      expect(md).toMatch(/\|\s*Tornillos\s*\|\s*120\s*\|\s*0\.15\s*\|/);

      // Excel (.xlsx): la tabla en una hoja (un ZIP OOXML con la tabla en sus cadenas compartidas).
      const excelCard = await exportCard("excel");
      const excel = await downloadFile(page, () => excelCard.getByRole("button", { name: E.formats.excel.title }).click());
      expect(excel.filename).toBe(`acta-${PDF_TO_EXCEL_STRINGS.es.filenameSuffix}.xlsx`);
      const xlsx = await JSZip.loadAsync(excel.bytes);
      expect(Object.keys(xlsx.files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]));
      const sharedStrings = await xlsx.file("xl/sharedStrings.xml")!.async("string");
      for (const cell of TABLE_ROWS.flat()) expect(sharedStrings, `xlsx: celda ${cell}`).toContain(cell);

      // PowerPoint (.pptx): una diapositiva por pagina.
      const powerpointCard = await exportCard("powerpoint");
      const powerpoint = await downloadFile(page, () => powerpointCard.getByRole("button", { name: E.formats.powerpoint.title }).click());
      expect(powerpoint.filename).toBe(`acta-${PDF_TO_POWERPOINT_STRINGS.es.filenameSuffix}.pptx`);
      const pptx = await JSZip.loadAsync(powerpoint.bytes);
      const slides = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      expect(slides, "una diapositiva por pagina").toHaveLength(5);
      await focusNotBody(page, "tras exportar a PowerPoint");

      // Exportar no toca el historial ni el estado «guardado».
      const afterExports = await readHistory(page);
      expect(afterExports.labels).toEqual(["Original"]);
      await expect(topBar(page)).toContainText(S.suite.saved);

      // Insertar desde HTML (Más acciones → «Insertar desde Word, Excel o HTML…»): páginas nuevas y Ctrl+Z lo deshace.
      await closeSheets(page);
      const more = await openMoreMenu(page);
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        more.getByRole("menuitem", { name: S.create.menu.insertConvert }).click(),
      ]);
      // El selector que se abre es el de «Insertar desde Word, Excel o HTML» (`data-pro-import-input`).
      expect(await chooser.element().getAttribute("data-pro-import-input")).not.toBeNull();
      await chooser.setFiles({ name: "nota.html", mimeType: "text/html", buffer: Buffer.from(HTML_NOTE, "utf8") });
      const sheet = page.getByRole("dialog").last();
      await expect(sheet.getByText(S.create.insert.kind.html)).toBeVisible();
      await expect(sheet.getByText(S.create.insert.fidelityHtml)).toBeVisible();
      await sheet.getByRole("button", { name: S.create.insert.insert, exact: true }).click();
      await expect(sheet).toBeHidden({ timeout: 60_000 });
      await expect(topBar(page)).toContainText(S.suite.unsaved);
      const label = S.create.insert.label("nota.html");
      await expect(status(page)).toHaveText(new RegExp(`^${label.replace(/[.]/g, "\\.")}\\. (Se insertó 1 página|Se insertaron \\d+ páginas)\\.$`));
      await focusNotBody(page, "tras insertar el HTML");
      const withHtml = await readHistory(page);
      expect(withHtml.labels).toEqual(["Original", label]);
      const htmlPages = await downloadCurrent(page);
      const added = (await getPageCount(htmlPages.bytes)) - 5;
      expect(added, "páginas añadidas por el HTML").toBeGreaterThanOrEqual(1);
      await expectPageCount(page, 5 + added);
      for (let n = 1; n <= 5; n += 1) expect(await getPageText(htmlPages.bytes, n)).toContain(`ACTA-${n}`);

      await topBar(page).locator("h1").focus();
      await page.keyboard.press("Control+z");
      await expect(status(page)).toHaveText(S.announce.undone(label));
      await expectPageCount(page, 5);
      await expect(undoButton(page)).toHaveAttribute("aria-disabled", "true");
      await noHorizontalOverflow(page);
      expect(uploads.requests).toEqual([]);
    });

    /* ---------------------------------------------------------------- *
     * (e) Recuperación
     * ---------------------------------------------------------------- */
    test("Recuperación: editar, recargar, retomar el borrador por los dos caminos y «Borrar datos locales»", async ({ page }) => {
      const uploads = watchUploads(page);
      const bytes = await makePdf({ pages: 3, label: "REC" });
      await openProPdf(page, { name: "borrador.pdf", bytes });

      // Editar («Rotar todas las páginas 90°») y esperar al autoguardado en la base real.
      const rotateAll = async () => {
        await openTab(page, "home");
        await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
        await expect(topBar(page)).toContainText(S.suite.unsaved);
        await closeSheets(page);
      };
      await rotateAll();
      await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(1);

      // Camino 1 · recargar y «Reabrir el último documento» del estado vacío.
      await page.reload();
      await expect(page.getByRole("heading", { name: es.tool.dropTitle })).toBeVisible();
      const recent = page.getByRole("button", { name: S.empty.recentOpen("borrador.pdf") });
      await expect(recent).toBeVisible();
      await expect(recent).toContainText("1 cambio");
      await noHorizontalOverflow(page);
      await expectNoAxeViolations(page, "el estado vacío con documentos recientes");
      const reopen = page.getByRole("button", { name: S.session.openLast });
      await expect(reopen).toBeVisible();
      await reopen.click();
      await expect(page.getByRole("heading", { level: 1, name: /borrador\.pdf/ })).toBeVisible();
      await expectPageCount(page, 3);
      await expect(topBar(page)).toContainText(S.suite.unsaved);
      await focusNotBody(page, "tras reabrir el último documento");
      await openTab(page, "home");
      await expect(page.getByText(S.suite.historyRestoredBody)).toBeVisible();
      await closeSheets(page);
      // El contenido (sin descargar: descargar limpiaria el borrador): se exporta el texto.
      await openTab(page, "convert");
      const card = page.locator('[data-export="text"]');
      await card.scrollIntoViewIfNeeded();
      const recoveredText = await downloadFile(page, () => card.getByRole("button", { name: E.formats.text.title }).click());
      for (let n = 1; n <= 3; n += 1) expect(recoveredText.bytes.toString("utf8")).toContain(`REC-${n}`);
      await closeSheets(page);
      await expect(topBar(page)).toContainText(S.suite.unsaved);

      // Camino 2 · recargar, abrir el MISMO PDF y «Retomar borrador» de la oferta.
      await page.reload();
      await expect(page.getByRole("heading", { name: es.tool.dropTitle })).toBeVisible();
      await page.locator('input[type="file"]').first().setInputFiles({ name: "borrador.pdf", mimeType: "application/pdf", buffer: bytes });
      await expect(page.getByRole("heading", { level: 1, name: /borrador\.pdf/ })).toBeVisible();
      const offer = page.getByRole("group", { name: S.drafts.foundTitle });
      await expect(offer).toBeVisible();
      await expect(topBar(page)).toContainText(S.suite.saved);
      await offer.getByRole("button", { name: S.drafts.restore }).click();
      await expect(offer).toHaveCount(0);
      await expect(topBar(page)).toContainText(S.suite.unsaved);
      // (El foco tras «Retomar borrador» lo comprueba la prueba «Retomar borrador» y «Descartar borrador» de mas abajo.)
      const restored = await downloadCurrent(page);
      expect(restored.filename).toBe("borrador-pro.pdf");
      const restoredDoc = await PDFDocument.load(restored.bytes);
      expect(restoredDoc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 90]);
      for (let n = 1; n <= 3; n += 1) expect(await getPageText(restored.bytes, n)).toContain(`REC-${n}`);
      await expect(topBar(page)).toContainText(S.suite.saved);

      // Otra edicion deja un borrador reciente (se espera a que el autoguardado lo escriba) y «Borrar datos locales» de
      // Ajustes lo vacia.
      const editedAt = await page.evaluate(() => new Date().toISOString());
      await rotateAll();
      await expect.poll(() => draftSavedSince(page, editedAt), { timeout: 15_000 }).toBe(true);
      expect(await draftCount(page)).toBe(1);
      await page.goto("/settings");
      await expect(page.getByRole("button", { name: es.settings.clearData })).toBeVisible();
      await noHorizontalOverflow(page);
      await expectNoAxeViolations(page, "Ajustes");
      await page.getByRole("button", { name: es.settings.clearData }).click();
      await expect(page.getByText(es.settings.cleared)).toBeVisible();
      await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(0);
      await page.goto("/pdf-pro");
      await expect(page.getByText(S.empty.recentEmpty)).toBeVisible();
      await expect(page.locator("[data-recent-list]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: S.empty.recentOpen("borrador.pdf") })).toHaveCount(0);
      await expect(page.getByRole("button", { name: S.session.openLast })).toHaveCount(0);
      await noHorizontalOverflow(page);
      expect(uploads.requests).toEqual([]);
    });

    /**
     * Regresion de un defecto hallado al construir (e): al pulsar «Retomar borrador» o «Descartar borrador» el boton con
     * el foco se retiraba del DOM y `document.activeElement` pasaba a `<body>` (WCAG 2.4.3). `ProSuite` lo devuelve al
     * titulo del documento en la fase de layout del mismo commit.
     */
    test("Recuperación: «Retomar borrador» y «Descartar borrador» no dejan el foco en <body>", async ({ page }) => {
      const bytes = await makePdf({ pages: 2, label: "FOCO" });
      await openProPdf(page, { name: "foco.pdf", bytes });
      await openTab(page, "home");
      await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
      await expect(topBar(page)).toContainText(S.suite.unsaved);
      await closeSheets(page);
      await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(1);
      for (const action of [S.drafts.restore, S.drafts.discard]) {
        await page.reload();
        await page.locator('input[type="file"]').first().setInputFiles({ name: "foco.pdf", mimeType: "application/pdf", buffer: bytes });
        const offer = page.getByRole("group", { name: S.drafts.foundTitle });
        await expect(offer).toBeVisible();
        await offer.getByRole("button", { name: action }).click();
        await expect(offer).toHaveCount(0);
        await focusNotBody(page, `tras «${action}»`);
      }
    });

    /* ---------------------------------------------------------------- *
     * (f) Handoff
     * ---------------------------------------------------------------- */
    test("Handoff: «Abrir en PDF Pro» desde /merge-pdf (2 PDF, avisa) y desde /compress-pdf (1 PDF)", async ({ page }) => {
      const uploads = watchUploads(page);

      // /merge-pdf con 2 PDF: se abre el PRIMERO y se avisa de que habia mas.
      await openTool(page, "merge-pdf");
      await uploadFiles(
        page,
        pdfUpload("primero.pdf", await makePdf({ pages: 2, label: "UNO" })),
        pdfUpload("segundo.pdf", await makePdf({ pages: 3, label: "DOS" })),
      );
      const open = page.getByRole("link", { name: es.tool.openInPro });
      await expect(open).toBeVisible();
      await noHorizontalOverflow(page);
      await expectNoAxeViolations(page, "/merge-pdf con dos archivos");
      await open.click();
      await expect(page).toHaveURL(/\/pdf-pro$/);
      await expect(page.getByRole("heading", { level: 1, name: /primero\.pdf/ })).toBeVisible();
      await expectPageCount(page, 2);
      const many = S.suite.openedFromMany(es.tools["merge-pdf"].name, 2);
      await expect(page.getByText(many, { exact: true })).toBeVisible();
      await focusNotBody(page, "tras abrir desde /merge-pdf");
      await noHorizontalOverflow(page);
      await expectNoAxeViolations(page, "PDF Pro abierto desde /merge-pdf");

      // Recargar: el traspaso ya no existe (estado vacio, no se reabre un archivo viejo).
      await page.reload();
      await expect(page.getByRole("heading", { name: es.tool.dropTitle })).toBeVisible();

      // /compress-pdf con 1 PDF.
      await openTool(page, "compress-pdf");
      await uploadFiles(page, pdfUpload("desde-comprimir.pdf", await makePdf({ pages: 4, label: "COMP" })));
      const openSingle = page.getByRole("link", { name: es.tool.openInPro });
      await expect(openSingle).toBeVisible();
      await openSingle.click();
      await expect(page).toHaveURL(/\/pdf-pro$/);
      await expect(page.getByRole("heading", { level: 1, name: /desde-comprimir\.pdf/ })).toBeVisible();
      await expectPageCount(page, 4);
      await expect(page.getByText(S.suite.openedFrom(es.tools["compress-pdf"].name), { exact: true })).toBeVisible();
      await expect(page.getByText(S.suite.openedFromMany(es.tools["compress-pdf"].name, 2), { exact: false })).toHaveCount(0);
      await focusNotBody(page, "tras abrir desde /compress-pdf");
      await noHorizontalOverflow(page);

      // El documento abierto es de verdad el archivo: se descarga tal cual y conserva sus paginas.
      const downloaded = await downloadCurrent(page);
      expect(downloaded.filename).toBe("desde-comprimir.pdf");
      expect(await getPageCount(downloaded.bytes)).toBe(4);
      expect(await getPageText(downloaded.bytes, 4)).toContain("COMP-4");
      expect(uploads.requests).toEqual([]);
    });
  });
}
