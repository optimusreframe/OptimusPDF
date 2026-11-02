import { PDFDocument } from "@cantoo/pdf-lib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageText, requiresPassword } from "../helpers/pdf-inspection";
import { makeImage, makePdf } from "../helpers/test-files";
import { makeViewerPdf } from "../helpers/viewer-pdfs";
import { closeSheetIfOpen, dropPdf, goToTab, isMobile, noHorizontalOverflow, openProPdf, S } from "../helpers/pro-flow";
import { es } from "../../src/lib/locales/es";

/**
 * PDF Pro · mensajes claros de error al abrir y al insertar archivos (Wave 7 · cierre), navegador real y headless en
 * 1280×800 y 375×812 tactil. Los textos son los de W6 (`errorCopy` con `fileProblem`): el MISMO archivo malo se
 * explica con las mismas palabras que en el resto de herramientas.
 *
 *  A. Estado vacio (selector y arrastre): corrupto, truncado, 0 bytes, texto con extension .pdf, imagen renombrada y
 *     formato que no es PDF → aviso con rol alert, enlazado al foco, la suite NO se abre y un PDF bueno despues si.
 *     Cifrado: hoja de contraseña (mala, buena, cancelar, Esc) y solo-permisos. Mas de 100 MB: se abre con el aviso de
 *     «documento grande» y no se bloquea.
 *  B. «Abrir otro PDF…» con un documento abierto: el error sale DENTRO de la suite y el original sigue abierto, sin
 *     cambios; con cambios sin descargar primero pide confirmacion.
 *  C. Traspaso desde otra herramienta: un archivo invalido no ofrece «Abrir en PDF Pro»; uno cifrado lo ofrece al
 *     descifrarlo; uno de mas de 100 MB lo ofrece y llega con el aviso.
 *  D. Páginas → «Insertar desde PDF» (corrupto, vacio, no PDF, cifrado), «Insertar desde Word, Excel o HTML» (.docx falso,
 *     .doc antiguo, .html vacio...) y «Unir PDFs» con mas de 10 (aviso `[data-pages-omitted]` con los nombres omitidos).
 *  E. «Nuevo PDF desde imagenes» con un archivo que no es imagen.
 *
 * HALLAZGOS que esta prueba encontro y se corrigieron en U8 (siguen aqui como regresion):
 *  - .docx/.xlsx con cabecera zip y contenido roto daban `unknown`; ahora `corrupt` («Corrupted zip» en `CORRUPT_HINTS`).
 *  - .html de 0 bytes decia «Necesitas añadir al menos un archivo»; ahora `emptyFile` (`convertToPdf`).
 *  - un .doc/.xls (formato antiguo) no explicaba que era el formato antiguo; ahora muestra `legacyOfficeFormat`.
 *  - foco en <body> tras cerrar el aviso con la X, tras «Entendido» (PDF omitidos), tras cancelar la contraseña de un PDF
 *    soltado con el raton y tras «Continuar» con un archivo roto.
 */

/**
 * Las pruebas que antes eran «DEFECTO ·» (hallazgos de esta misma unidad) ya pasan: el producto se corrigio en U8 y la
 * razon original queda solo como documentacion de la prueba.
 */
function knownDefect(reason: string): void {
  void reason;
}

const T = es.tool;
const P = S.pages;

test.use({ locale: "es-ES" });
test.setTimeout(90_000);

const VIEWPORTS = [
  { name: "escritorio 1280×800", viewport: { width: 1280, height: 800 }, touch: false },
  { name: "movil 375×812 tactil", viewport: { width: 375, height: 812 }, touch: true },
] as const;

/* ------------------------------------------------------------------ *
 * Archivos de prueba (todo se genera al vuelo; nada binario en el repositorio)
 * ------------------------------------------------------------------ */

type Upload = { name: string; mimeType: string; buffer: Buffer };

function filler(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 131 + 17) & 0xff;
  return bytes;
}

type BadKind = "garbage" | "truncated" | "empty" | "notPdf" | "renamedPng";
const BAD_KINDS: readonly BadKind[] = ["garbage", "truncated", "empty", "notPdf", "renamedPng"];

async function badFile(kind: BadKind): Promise<Upload> {
  const pdf = (name: string, buffer: Buffer): Upload => ({ name, mimeType: "application/pdf", buffer });
  switch (kind) {
    case "garbage":
      return pdf("basura.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), filler(4000)]));
    case "truncated": {
      const good = await makePdf({ pages: 4, label: "TRU" });
      return pdf("truncado.pdf", good.subarray(0, Math.floor(good.length / 2)));
    }
    case "empty":
      return pdf("vacio.pdf", Buffer.alloc(0));
    case "notPdf":
      return pdf("texto.pdf", Buffer.from("Esto es un texto plano con extension pdf.\n".repeat(20)));
    case "renamedPng":
      return pdf("imagen.pdf", makeImage("png", 8, 8, 1));
  }
}

/** Lo que dice el aviso de cada archivo malo (mensaje y, si lo hay, la pista). */
const PROBLEM: Record<BadKind, { message: string; hint?: string }> = {
  garbage: { message: T.errors.corrupt, hint: T.errorHints.corrupt },
  truncated: { message: T.errors.corrupt, hint: T.errorHints.corrupt },
  empty: { message: T.errors.emptyFile },
  notPdf: { message: T.errors.notPdf },
  renamedPng: { message: T.errors.notPdf },
};

const goodPdf = async (name = "bueno.pdf", pages = 2, label = "BUE"): Promise<Upload> => ({
  name,
  mimeType: "application/pdf",
  buffer: await makePdf({ pages, label }),
});

const encryptedPdf = async (name = "cifrado.pdf"): Promise<Upload> => ({
  name,
  mimeType: "application/pdf",
  buffer: await makePdf({ pages: 2, label: "CIF", userPassword: "secreta" }),
});

/** PDF que solo restringe permisos (contraseña de apertura vacia): se abre sin pedir nada. */
async function permissionsOnlyPdf(): Promise<Upload> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  document.addPage([200, 200]);
  document.encrypt({ userPassword: "", ownerPassword: "owner-secret", permissions: {} });
  return { name: "permisos.pdf", mimeType: "application/pdf", buffer: Buffer.from(await document.save()) };
}

/* ------------------------------------------------------------------ *
 * Ayudas de pantalla
 * ------------------------------------------------------------------ */

const emptyInput = (page: Page): Locator => page.locator('input[type="file"]').first();
// Un aviso que se esta yendo (animacion de salida) queda `inert` un instante: no cuenta como aviso vigente.
const banner = (page: Page): Locator => page.locator("[data-error-banner]:not([inert])");
const suiteBanner = (page: Page): Locator => page.locator("section[data-pro-suite] [data-error-banner]:not([inert])");
const topBar = (page: Page): Locator => page.locator('[data-pro-region="top"]');
const status = (page: Page): Locator => page.getByRole("status");
const historyList = (page: Page): Locator => page.getByRole("list", { name: S.suite.historyTitle });
const grid = (page: Page): Locator => page.getByRole("listbox", { name: /Páginas del documento/ });
/** Las 7 herramientas de la suite: pestañas en escritorio, botones de la barra inferior en movil. */
const toolTabs = (page: Page): Locator => (isMobile(page) ? page.locator("[data-dock]") : page.getByRole("tab"));

async function bannerHasFocus(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((element) => element.contains(document.activeElement)), { message: "el foco esta en el aviso" }).toBe(true);
}

async function focusNotBody(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null), { message: "el foco nunca queda en <body>" })
    .toBe(true);
}

/** Aviso de «archivo inservible»: rol alert, titulo de W6, nombre del archivo, mensaje y pista del codigo. */
async function expectFileProblem(
  alert: Locator,
  expected: { name?: string; message: string; hint?: string },
): Promise<void> {
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute("role", "alert");
  await expect(alert).toContainText(T.fileProblemTitle);
  if (expected.name) await expect(alert).toContainText(expected.name);
  await expect(alert).toContainText(expected.message);
  if (expected.hint) await expect(alert).toContainText(expected.hint);
  // Nunca la pantalla generica de fallo.
  await expect(alert).not.toContainText(T.errors.unknown);
}

/** Regex de un aviso con `{size}` (p. ej. «Este documento pesa 104 MB…»). */
function warningRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{size\\}", "\\d+(?:[.,]\\d+)? (?:MB|GB)");
  return new RegExp(escaped);
}

async function downloadDoc(page: Page): Promise<{ bytes: Buffer; filename: string }> {
  await closeSheetIfOpen(page);
  return downloadFile(page, () => topBar(page).getByRole("button", { name: S.suite.download, exact: true }).click());
}

/** Pasos del historial (en movil, dentro de la hoja del panel, que se cierra despues). */
async function historySteps(page: Page): Promise<number> {
  await closeSheetIfOpen(page);
  await goToTab(page, "home");
  const count = await historyList(page).getByRole("listitem").count();
  await closeSheetIfOpen(page);
  return count;
}

/** Estado visible del documento abierto: titulo, paginas, guardado y pasos del historial. */
async function docSnapshot(page: Page): Promise<{ title: string; pages: string; unsaved: boolean; steps: number }> {
  const title = ((await page.getByRole("heading", { level: 1 }).first().textContent()) ?? "").trim();
  // El recuento de paginas es el primer <span> del parrafo de la barra (junto a la insignia de «sin guardar»).
  const pages = ((await topBar(page).locator("p > span").first().textContent()) ?? "").trim();
  const unsaved = (await page.getByText(S.suite.unsaved).count()) > 0;
  const steps = await historySteps(page);
  return { title, pages, unsaved, steps };
}

async function rotateAll(page: Page): Promise<void> {
  await goToTab(page, "home");
  await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
  await closeSheetIfOpen(page);
  await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
}

/** «Más acciones» → «Abrir otro PDF…» → elige el archivo en el selector del sistema. */
async function openAnother(page: Page, file: Upload | string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: S.shell.more }).click();
  await page.getByRole("menuitem", { name: S.create.menu.openAnother }).click();
  await (await chooser).setFiles(file);
}

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

/** Cierra la hoja del organizador (movil): con paginas seleccionadas, Esc primero suelta la seleccion. */
async function closePagesPanel(page: Page): Promise<void> {
  if (!isMobile(page)) return;
  await page.getByRole("dialog").last().getByRole("button", { name: es.common.close, exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Cierra la hoja de arriba (la ultima abierta) con su boton «Cerrar» y espera a que se vaya. */
async function closeTopSheet(page: Page): Promise<void> {
  const before = await page.getByRole("dialog").count();
  await page.getByRole("dialog").last().getByRole("button", { name: es.common.close, exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(before - 1);
}

/* ------------------------------------------------------------------ *
 * A · Estado vacio
 * ------------------------------------------------------------------ */

for (const project of VIEWPORTS) {
  test.describe(`PDF Pro · errores al abrir · estado vacio · ${project.name}`, () => {
    test.use({ viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

    for (const kind of BAD_KINDS) {
      test(`${kind}: aviso claro con foco, la suite NO se abre, y un PDF bueno despues si`, async ({ page }) => {
        await page.goto("/pdf-pro");
        await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
        const file = await badFile(kind);
        await emptyInput(page).setInputFiles(file);

        await expectFileProblem(banner(page), { name: file.name, ...PROBLEM[kind] });
        await bannerHasFocus(banner(page));
        await expect(page.getByRole("tablist"), "la suite no se abre").toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.locator('[aria-busy="true"]'), "ya no esta «Comprobando el archivo…»").toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
        await noHorizontalOverflow(page);
        if (project.touch) {
          const close = await banner(page).getByRole("button", { name: es.common.close }).boundingBox();
          expect(close?.height ?? 0, "cerrar el aviso mide al menos 44 px").toBeGreaterThanOrEqual(43.5);
        }

        // Recuperacion: un PDF bueno abre la suite y no queda rastro del aviso.
        await emptyInput(page).setInputFiles(await goodPdf("bueno.pdf", 2));
        await expect(page.getByRole("heading", { level: 1, name: /bueno\.pdf/ })).toBeVisible();
        await expect(banner(page)).toHaveCount(0);
        await expect(toolTabs(page)).toHaveCount(7);
      });
    }

    test("una imagen real (.png) en la zona de carga: «Ese formato no sirve», sin nombre de archivo y sin abrir nada", async ({ page }) => {
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      await emptyInput(page).setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: makeImage("png", 8, 8, 2) });
      await expectFileProblem(banner(page), { message: T.errors.invalidType });
      await expect(banner(page)).not.toContainText("foto.png");
      await bannerHasFocus(banner(page));
      await expect(page.getByRole("tablist")).toHaveCount(0);
    });

    test("soltar un archivo roto sobre la zona de carga se explica igual que al elegirlo", async ({ page }) => {
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      const file = await badFile("garbage");
      await dropPdf(page, file.buffer, file.name);
      await expectFileProblem(banner(page), { name: file.name, ...PROBLEM.garbage });
      await bannerHasFocus(banner(page));
      await expect(page.getByRole("tablist")).toHaveCount(0);
    });

    test("dos intentos seguidos: el aviso del segundo reemplaza al primero (nunca dos avisos) y se puede cerrar con la X", async ({ page }) => {
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      await emptyInput(page).setInputFiles(await badFile("garbage"));
      await expectFileProblem(banner(page), { name: "basura.pdf", ...PROBLEM.garbage });
      await emptyInput(page).setInputFiles(await badFile("empty"));
      await expectFileProblem(banner(page), { name: "vacio.pdf", message: T.errors.emptyFile });
      await expect(banner(page)).toHaveCount(1);
      await expect(banner(page)).not.toContainText("basura.pdf");
      await banner(page).getByRole("button", { name: es.common.close }).click();
      await expect(banner(page)).toHaveCount(0);
      await expect(page.getByRole("tablist")).toHaveCount(0);
    });

    test("PDF cifrado: hoja de contraseña con el nombre y el foco; mala → mensaje y el campo vuelve a tener el foco; buena → abre con el aviso de copia sin contraseña", async ({
      page,
    }) => {
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      await emptyInput(page).setInputFiles(await encryptedPdf());
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(T.password.title);
      await expect(dialog).toContainText("cifrado.pdf");
      const field = dialog.getByLabel(T.password.label, { exact: true });
      await expect(field).toBeFocused();
      await expect(page.getByRole("tablist"), "mientras se pide la contraseña no hay suite").toHaveCount(0);

      await field.fill("equivocada");
      await dialog.getByRole("button", { name: T.password.submit }).click();
      await expect(dialog.getByText(T.password.wrong)).toBeVisible();
      await expect(field).toBeFocused();
      await expect(page.getByRole("tablist")).toHaveCount(0);

      await field.fill("secreta");
      await dialog.getByRole("button", { name: T.password.submit }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("heading", { level: 1, name: /cifrado\.pdf/ })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(status(page)).toHaveText(S.announce.opened("cifrado.pdf"));
      await expect(page.getByText(S.warnings.decryptedCopy)).toBeVisible();
      await expect(page.getByText(S.suite.pageCount(2)).first()).toBeVisible();
      await expect(banner(page)).toHaveCount(0);

      // Descargar una copia descifrada avisa antes y sale SIN cifrar.
      await topBar(page).getByRole("button", { name: S.suite.download, exact: true }).click();
      const confirm = page.getByRole("dialog");
      await expect(confirm).toContainText(S.save.confirmDecrypted);
      const out = await downloadFile(page, () => confirm.getByRole("button", { name: S.save.confirmDownloadPlain }).click());
      expect(await requiresPassword(out.bytes), "la copia descargada no pide contraseña").toBe(false);
      expect(await getPageCount(out.bytes)).toBe(2);
    });

    test("PDF cifrado: «Cancelar» y Esc cierran la hoja sin abrir nada y sin aviso de error, el foco vuelve a «Seleccionar archivo» y se puede elegir otro archivo", async ({
      page,
    }) => {
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      const pick = page.locator("button", { hasText: T.dropButton });
      const dialog = page.getByRole("dialog");

      // El foco estaba en «Seleccionar archivo» (la persona lo pulso para elegir el PDF).
      await pick.focus();
      await emptyInput(page).setInputFiles(await encryptedPdf());
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: T.password.cancel }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("tablist")).toHaveCount(0);
      await expect(banner(page)).toHaveCount(0);
      await expect(pick).toBeFocused();

      await pick.focus();
      await emptyInput(page).setInputFiles(await encryptedPdf("cifrado-2.pdf"));
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("tablist")).toHaveCount(0);
      await expect(banner(page)).toHaveCount(0);
      await expect(pick).toBeFocused();

      await emptyInput(page).setInputFiles(await goodPdf("despues.pdf"));
      await expect(page.getByRole("heading", { level: 1, name: /despues\.pdf/ })).toBeVisible();
    });

    test("PDF que solo restringe permisos: se abre sin pedir contraseña y avisa de que se trabaja con una copia", async ({ page }) => {
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      await emptyInput(page).setInputFiles(await permissionsOnlyPdf());
      await expect(page.getByRole("heading", { level: 1, name: /permisos\.pdf/ })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(banner(page)).toHaveCount(0);
      await expect(page.getByText(S.warnings.decryptedCopy)).toBeVisible();
    });
  });
}

/* ------------------------------------------------------------------ *
 * A · Mas de 100 MB: se abre con el aviso de «documento grande» y no se bloquea
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · errores al abrir · mas de 100 MB", () => {
  let hugeDir = "";
  let hugePath = "";

  test.beforeAll(async () => {
    hugeDir = fs.mkdtempSync(path.join(os.tmpdir(), "optimuspdf-pro-grande-"));
    hugePath = path.join(hugeDir, "grande.pdf");
    // 30 paginas con ~3,5 MB de ruido incompresible cada una: ~105 MiB (el umbral de aviso es 100 MiB).
    const bytes = await makeViewerPdf(30, { noiseKb: 3600 });
    expect(bytes.length, "el PDF de prueba supera los 100 MiB").toBeGreaterThan(100 * 1024 * 1024);
    fs.writeFileSync(hugePath, bytes);
  });
  test.afterAll(() => {
    if (hugeDir) fs.rmSync(hugeDir, { recursive: true, force: true });
  });

  for (const project of VIEWPORTS) {
    test.describe(project.name, () => {
      test.use({ viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

      test("desde el estado vacio se abre con el aviso visible y la suite sigue usable", async ({ page }) => {
        test.setTimeout(150_000);
        await page.goto("/pdf-pro");
        await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
        await emptyInput(page).setInputFiles(hugePath);
        await expect(page.getByRole("heading", { level: 1, name: /grande\.pdf/ })).toBeVisible({ timeout: 60_000 });
        // Aviso visible (no solo para lectores de pantalla) y SIN aviso de error: no bloquea.
        const limits = page.locator("[data-pro-limits]");
        await expect(limits).toBeVisible();
        await expect(limits).toContainText(S.session.limitsTitle);
        await expect(limits).toContainText(warningRegex(S.warnings.largeDocument));
        await expect(banner(page)).toHaveCount(0);
        await expect(toolTabs(page)).toHaveCount(7);
        // El visor pinta paginas de verdad y el documento es manejable.
        await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 90_000 });
        await expect(topBar(page).getByText(S.suite.pageCount(30))).toBeVisible();
        await expect(topBar(page).getByRole("button", { name: S.suite.download, exact: true })).not.toHaveAttribute("aria-disabled", "true");
        await noHorizontalOverflow(page);
      });
    });
  }

  test("«Abrir otro PDF…» con uno de mas de 100 MB reemplaza el documento y muestra el aviso", async ({ page }) => {
    test.setTimeout(150_000);
    await openProPdf(page, { name: "pequeno.pdf", pages: 2 });
    await expect(page.locator("[data-pro-limits]")).toHaveCount(0);
    await openAnother(page, hugePath);
    await expect(page.getByRole("heading", { level: 1, name: /grande\.pdf/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-pro-limits]")).toContainText(warningRegex(S.warnings.largeDocument));
    await expect(suiteBanner(page)).toHaveCount(0);
  });

  test("«Insertar desde PDF» con uno de mas de 100 MB: la hoja lo rechaza con el mensaje del limite (no lo lee) y el documento no cambia", async ({ page }) => {
    test.setTimeout(120_000);
    await openProPdf(page, { name: "base.pdf", pages: 3, label: "BAS" });
    await goToTab(page, "pages");
    await expect(grid(page)).toBeVisible();
    await page.locator('[data-pages-input="pdf"]').setInputFiles(hugePath);
    const sheet = page.getByRole("dialog").last();
    await expect(sheet).toContainText(P.sheets.pdfTitle);
    await expect(sheet).toContainText("grande.pdf");
    await expect(sheet).toContainText(T.errors.tooLarge);
    await expect(sheet.getByRole("option"), "no se ofrece ninguna pagina").toHaveCount(0);
    await closeTopSheet(page);
    await expect(page.locator("[data-pages-chip]")).toHaveText(P.status.noChanges);
    await expect(grid(page).getByRole("option")).toHaveCount(3);
    expect(await historySteps(page)).toBe(1);
  });

  test("traspaso desde Comprimir PDF: el archivo grande SI se ofrece (solo avisa) y llega a PDF Pro con el aviso", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/compress-pdf");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(hugePath);
    const warning = banner(page);
    await expect(warning).toBeVisible({ timeout: 60_000 });
    await expect(warning).toContainText(T.largeFileTitle);
    await expect(warning).toHaveAttribute("role", "status");
    const link = page.getByRole("link", { name: T.openInPro });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/pdf-pro$/);
    await expect(page.getByRole("heading", { level: 1, name: /grande\.pdf/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-pro-limits]")).toContainText(warningRegex(S.warnings.largeDocument));
    await expect(page.getByText(S.suite.openedFrom(es.tools["compress-pdf"].name))).toBeVisible();
    await expect(suiteBanner(page)).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ *
 * B · «Abrir otro PDF…» con un documento abierto
 * ------------------------------------------------------------------ */

for (const project of VIEWPORTS) {
  test.describe(`PDF Pro · errores al abrir · «Abrir otro PDF…» · ${project.name}`, () => {
    test.use({ viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

    for (const kind of BAD_KINDS) {
      test(`${kind}: el error sale dentro de la suite y el documento original sigue abierto y sin cambios`, async ({ page }) => {
        await openProPdf(page, { name: "informe.pdf", pages: 3, label: "ERR" });
        await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
        const before = await docSnapshot(page);
        expect(before).toEqual({ title: `${S.suite.regionLabel}: informe.pdf`, pages: S.suite.pageCount(3), unsaved: false, steps: 1 });

        const file = await badFile(kind);
        await openAnother(page, file);
        await expectFileProblem(suiteBanner(page), { name: file.name, ...PROBLEM[kind] });
        await bannerHasFocus(suiteBanner(page));
        await expect(page.getByRole("dialog"), "no hay hoja de confirmacion: no habia cambios").toHaveCount(0);

        // El original, intacto: mismo titulo, paginas, sin cambios, mismo historial y visor vivo.
        expect(await docSnapshot(page)).toEqual(before);
        await expect(toolTabs(page)).toHaveCount(7);
        await expect(page.locator('article[data-state="ready"]').first()).toBeVisible();
        const out = await downloadDoc(page);
        expect(await getPageCount(out.bytes)).toBe(3);
        expect(await getPageText(out.bytes, 2)).toContain("ERR-2");
        await noHorizontalOverflow(page);

        // Recuperacion: el siguiente PDF bueno reemplaza al original y el aviso desaparece.
        await openAnother(page, await goodPdf("segundo.pdf", 2, "SEG"));
        await expect(page.getByRole("heading", { level: 1, name: /segundo\.pdf/ })).toBeVisible();
        await expect(suiteBanner(page)).toHaveCount(0);
        await expect(page.getByText(S.suite.pageCount(2)).first()).toBeVisible();
      });
    }

    test("con cambios sin descargar primero pide confirmacion; «Cancelar» no cambia nada y «Continuar» muestra el error con el original aun abierto y sin descargar", async ({
      page,
    }) => {
      await openProPdf(page, { name: "informe.pdf", pages: 3, label: "ERR" });
      await rotateAll(page);
      const before = await docSnapshot(page);
      expect(before).toEqual({ title: `${S.suite.regionLabel}: informe.pdf`, pages: S.suite.pageCount(3), unsaved: true, steps: 2 });

      // Cancelar: ni se comprueba el archivo (no hay aviso) ni cambia nada.
      await openAnother(page, await badFile("garbage"));
      const confirm = page.getByRole("dialog");
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(S.session.replaceTitle);
      await expect(confirm).toContainText(S.session.replaceBody);
      await confirm.getByRole("button", { name: es.common.cancel }).click();
      await expect(confirm).toBeHidden();
      await expect(suiteBanner(page)).toHaveCount(0);
      expect(await docSnapshot(page)).toEqual(before);

      // Continuar: se comprueba el archivo, sale el error DENTRO de la suite y el original sigue ahi con sus cambios.
      await openAnother(page, await badFile("empty"));
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: S.session.replaceConfirm }).click();
      await expect(confirm).toBeHidden();
      await expectFileProblem(suiteBanner(page), { name: "vacio.pdf", message: T.errors.emptyFile });
      await focusNotBody(page);
      expect(await docSnapshot(page)).toEqual(before);
      const out = await downloadDoc(page);
      expect(await getPageCount(out.bytes)).toBe(3);

      // Y un PDF bueno, tras confirmar, SI reemplaza el documento.
      await rotateAll(page);
      await openAnother(page, await goodPdf("nuevo.pdf", 4, "NUE"));
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: S.session.replaceConfirm }).click();
      await expect(page.getByRole("heading", { level: 1, name: /nuevo\.pdf/ })).toBeVisible();
      await expect(suiteBanner(page)).toHaveCount(0);
      await expect(page.getByText(S.suite.pageCount(4)).first()).toBeVisible();
    });

    test("el selector oculto [data-pro-open-input] da el mismo aviso que el menu", async ({ page }) => {
      await openProPdf(page, { name: "informe.pdf", pages: 3 });
      await page.locator("[data-pro-open-input]").setInputFiles(await badFile("notPdf"));
      await expectFileProblem(suiteBanner(page), { name: "texto.pdf", message: T.errors.notPdf });
      await expect(page.getByRole("heading", { level: 1, name: /informe\.pdf/ })).toBeVisible();
    });

    test("PDF cifrado: hoja de contraseña sobre la suite; mala → mensaje; «Cancelar» deja el original; buena → abre la copia sin contraseña", async ({ page }) => {
      await openProPdf(page, { name: "informe.pdf", pages: 3, label: "ORI" });
      await openAnother(page, await encryptedPdf());
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(T.password.title);
      await expect(dialog).toContainText("cifrado.pdf");
      const field = dialog.getByLabel(T.password.label, { exact: true });
      await field.fill("equivocada");
      await dialog.getByRole("button", { name: T.password.submit }).click();
      await expect(dialog.getByText(T.password.wrong)).toBeVisible();
      await expect(field).toBeFocused();
      await expect(page.getByRole("heading", { level: 1, name: /informe\.pdf/ }), "mientras tanto el original sigue abierto").toBeVisible();

      await dialog.getByRole("button", { name: T.password.cancel }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("heading", { level: 1, name: /informe\.pdf/ })).toBeVisible();
      await expect(suiteBanner(page)).toHaveCount(0);
      await focusNotBody(page);

      await openAnother(page, await encryptedPdf());
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(T.password.label, { exact: true }).fill("secreta");
      await dialog.getByRole("button", { name: T.password.submit }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("heading", { level: 1, name: /cifrado\.pdf/ })).toBeVisible();
      await expect(page.getByText(S.warnings.decryptedCopy)).toBeVisible();
      await expect(suiteBanner(page)).toHaveCount(0);
    });
  });
}

/* ------------------------------------------------------------------ *
 * C · Traspaso desde otra herramienta
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · errores al abrir · traspaso desde otra herramienta (escritorio)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const toolInput = (page: Page): Locator => page.locator('input[type="file"][accept*="pdf"]').first();
  const openInProLink = (page: Page): Locator => page.getByRole("link", { name: T.openInPro });

  async function openTool(page: Page, slug: string): Promise<void> {
    await page.goto(`/${slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }

  for (const kind of ["garbage", "empty", "notPdf"] as const) {
    test(`Comprimir PDF con un archivo ${kind}: no se ofrece «Abrir en PDF Pro», se explica allí y PDF Pro no se queda con nada`, async ({ page }) => {
      await openTool(page, "compress-pdf");
      const file = await badFile(kind);
      await toolInput(page).setInputFiles(file);
      await expectFileProblem(banner(page), { name: file.name, ...PROBLEM[kind] });
      await expect(openInProLink(page)).toHaveCount(0);
      // Entrar a PDF Pro a mano (navegacion de cliente desde la barra lateral) deja el estado vacio, sin suite rota.
      await page.getByRole("navigation", { name: es.nav.primaryNav }).getByRole("link", { name: "PDF Pro", exact: true }).click();
      await expect(page).toHaveURL(/\/pdf-pro$/);
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      await expect(page.getByRole("tablist")).toHaveCount(0);
      await expect(banner(page)).toHaveCount(0);
    });
  }

  test("Unir PDF con uno bueno y otro roto: el enlace «Abrir en PDF Pro» no se ofrece mientras haya un archivo inservible", async ({ page }) => {
    await openTool(page, "merge-pdf");
    const good = await goodPdf("bueno.pdf", 2);
    const bad = await badFile("garbage");
    await toolInput(page).setInputFiles([good, bad]);
    await expectFileProblem(banner(page), { name: bad.name, ...PROBLEM.garbage });
    await expect(openInProLink(page)).toHaveCount(0);
    // Quitando el roto vuelve a ofrecerse.
    await banner(page).getByRole("button", { name: T.removeFile }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(openInProLink(page)).toBeVisible();
  });

  test("Comprimir PDF con un PDF cifrado: sin enlace hasta descifrarlo; con la contraseña se abre en PDF Pro con el aviso de copia sin contraseña", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openTool(page, "compress-pdf");
    await toolInput(page).setInputFiles(await encryptedPdf());
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(openInProLink(page), "cifrado y sin contraseña: no se ofrece").toHaveCount(0);
    await dialog.getByLabel(T.password.label, { exact: true }).fill("equivocada");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog.getByText(T.password.wrong)).toBeVisible();
    await expect(openInProLink(page)).toHaveCount(0);
    await dialog.getByLabel(T.password.label, { exact: true }).fill("secreta");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(openInProLink(page)).toBeVisible();
    await openInProLink(page).click();

    await expect(page).toHaveURL(/\/pdf-pro$/);
    await expect(page.getByRole("heading", { level: 1, name: /cifrado\.pdf/ })).toBeVisible();
    await expect(page.getByText(S.suite.openedFrom(es.tools["compress-pdf"].name))).toBeVisible();
    await expect(page.getByText(S.warnings.decryptedCopy)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(suiteBanner(page)).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(7);
    expect(await historySteps(page)).toBe(1);
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * D · Páginas: insertar desde PDF, desde Word/Excel/HTML y unir (>10)
 * ------------------------------------------------------------------ */

for (const project of VIEWPORTS) {
  test.describe(`PDF Pro · errores al insertar · ${project.name}`, () => {
    test.use({ viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

    async function openPagesWith(page: Page, pages = 3): Promise<void> {
      await openProPdf(page, { name: "base.pdf", pages, label: "BAS" });
      await openPagesPanel(page);
    }

    /** El documento no cambio: sin cambios pendientes en el organizador, sin snapshot nuevo, mismas paginas. */
    async function expectUntouched(page: Page, pages = 3): Promise<void> {
      await expect(page.locator("[data-pages-chip]")).toHaveText(P.status.noChanges);
      await expect(grid(page).getByRole("option")).toHaveCount(pages);
      await closePagesPanel(page);
      await expect(page.getByText(S.suite.saved).first()).toBeVisible();
      expect(await historySteps(page), "el historial no cambia").toBe(1);
      await expect(topBar(page).getByText(S.suite.pageCount(pages))).toBeVisible();
    }

    for (const kind of ["garbage", "empty", "notPdf", "truncated"] as const) {
      test(`Insertar desde PDF ${kind}: la hoja lo explica con el nombre del archivo y el documento no cambia`, async ({ page }) => {
        await openPagesWith(page);
        const file = await badFile(kind);
        await page.locator('[data-pages-input="pdf"]').setInputFiles(file);
        const sheet = page.getByRole("dialog").last();
        await expect(sheet).toContainText(P.sheets.pdfTitle);
        await expect(sheet).toContainText(file.name);
        await expect(sheet).toContainText(PROBLEM[kind].message);
        await expect(sheet).not.toContainText(T.errors.unknown);
        await expect(sheet.getByRole("option"), "sin paginas que elegir").toHaveCount(0);
        await expect(sheet.getByRole("button", { name: /^Insertar \d+ páginas?$/ })).toHaveCount(0);
        await closeTopSheet(page);
        await expectUntouched(page);
      });
    }

    test("Insertar desde PDF cifrado: contraseña mala → mensaje; «Cancelar» quita el archivo y el documento no cambia; buena → ofrece sus paginas", async ({
      page,
    }) => {
      await openPagesWith(page);
      const input = page.locator('[data-pages-input="pdf"]');
      await input.setInputFiles(await encryptedPdf());
      const password = page.getByRole("dialog").filter({ hasText: T.password.title });
      await expect(password).toBeVisible();
      await expect(password).toContainText("cifrado.pdf");
      await password.getByLabel(T.password.label, { exact: true }).fill("equivocada");
      await password.getByRole("button", { name: T.password.submit }).click();
      await expect(password.getByText(T.password.wrong)).toBeVisible();
      await expect(password.getByLabel(T.password.label, { exact: true })).toBeFocused();

      await password.getByRole("button", { name: T.password.cancel }).click();
      await expect(password).toBeHidden();
      // Vuelve la hoja de «Insertar desde PDF» sin archivo, sin pagina que insertar y sin cambios en el documento.
      const sheet = page.getByRole("dialog").last();
      await expect(sheet).toContainText(P.sheets.pdfTitle);
      await expect(sheet.getByRole("option")).toHaveCount(0);
      await closeTopSheet(page);
      await expectUntouched(page);

      await openPagesPanel(page);
      await input.setInputFiles(await encryptedPdf());
      await expect(password).toBeVisible();
      await password.getByLabel(T.password.label, { exact: true }).fill("secreta");
      await password.getByRole("button", { name: T.password.submit }).click();
      await expect(password).toBeHidden();
      await expect(page.getByRole("dialog").last().getByRole("option")).toHaveCount(2);
      await closeTopSheet(page);
      await expectUntouched(page);
    });

    test("Insertar desde Word, Excel o HTML: .docx que no es un zip → «parece dañado»; .docx con cabecera antigua → formato antiguo; el documento no cambia", async ({
      page,
    }) => {
      await openProPdf(page, { name: "base.pdf", pages: 3, label: "BAS" });
      const importInput = page.locator("[data-pro-import-input]");
      const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), filler(2000)]);
      const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const cases: Array<{ file: Upload; message: string }> = [
        { file: { name: "texto.docx", mimeType: DOCX, buffer: Buffer.from("esto no es un zip, es texto plano") }, message: T.errors.corrupt },
        { file: { name: "antiguo-renombrado.docx", mimeType: DOCX, buffer: ole }, message: T.errors.legacyOfficeFormat },
      ];
      for (const { file, message } of cases) {
        await importInput.setInputFiles(file);
        const sheet = page.getByRole("dialog").last();
        await expect(sheet).toContainText(S.create.insert.title);
        await sheet.getByRole("button", { name: S.create.insert.insert }).click();
        const alert = sheet.getByRole("alert");
        await expect(alert).toBeVisible({ timeout: 30_000 });
        await expect(alert).toContainText(message);
        await expect(alert).not.toContainText(T.errors.unknown);
        await expect(sheet.getByRole("button", { name: S.create.insert.insert })).not.toHaveAttribute("aria-disabled", "true");
        await closeTopSheet(page);
        expect(await historySteps(page), `${file.name}: el historial no cambia`).toBe(1);
        await expect(page.getByText(S.suite.saved).first()).toBeVisible();
      }
    });

    test("Insertar desde Word, Excel o HTML: un .docx/.xlsx dañado (zip roto) o un .html vacio muestran un error en la hoja (alert), no cambian el documento y la hoja sigue usable", async ({
      page,
    }) => {
      await openProPdf(page, { name: "base.pdf", pages: 3, label: "BAS" });
      const zipBroken = Buffer.concat([Buffer.from("PK\x03\x04"), filler(600)]);
      const cases: Upload[] = [
        { name: "falso.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: zipBroken },
        { name: "falso.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: zipBroken },
        { name: "vacio.html", mimeType: "text/html", buffer: Buffer.alloc(0) },
      ];
      for (const file of cases) {
        await page.locator("[data-pro-import-input]").setInputFiles(file);
        const sheet = page.getByRole("dialog").last();
        await expect(sheet).toContainText(S.create.insert.title);
        await sheet.getByRole("button", { name: S.create.insert.insert }).click();
        const alert = sheet.getByRole("alert");
        await expect(alert, `${file.name}: la hoja explica que no se pudo`).toBeVisible({ timeout: 30_000 });
        await expect(alert).toContainText(T.errors.title);
        await expect(alert.getByRole("button", { name: es.common.close })).toBeVisible();
        await expect(sheet.getByRole("button", { name: S.create.insert.insert })).not.toHaveAttribute("aria-disabled", "true");
        await closeTopSheet(page);
        expect(await historySteps(page), `${file.name}: el historial no cambia`).toBe(1);
        await expect(page.getByText(S.suite.saved).first()).toBeVisible();
        await expect(topBar(page).getByText(S.suite.pageCount(3))).toBeVisible();
      }
    });

    test("Insertar desde Word, Excel o HTML: un .doc o .xls (formato antiguo) ni se intenta convertir: la hoja explica que es el formato antiguo y solo deja cancelar", async ({
      page,
    }) => {
      await openProPdf(page, { name: "base.pdf", pages: 3, label: "BAS" });
      const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), filler(2000)]);
      for (const name of ["antiguo.doc", "hoja-antigua.xls"]) {
        await page.locator("[data-pro-import-input]").setInputFiles({ name, mimeType: "application/msword", buffer: ole });
        const sheet = page.getByRole("dialog").last();
        await expect(sheet).toContainText(T.errors.legacyOfficeFormat);
        await expect(sheet.getByRole("button", { name: S.create.insert.insert })).toHaveCount(0);
        await sheet.getByRole("button", { name: S.create.insert.cancel }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(await historySteps(page)).toBe(1);
      }
    });

    test("tras un error de importacion, un HTML bueno SI se inserta (la hoja se recupera) y deshacer lo quita", async ({ page }) => {
      await openProPdf(page, { name: "base.pdf", pages: 3, label: "BAS" });
      await page.locator("[data-pro-import-input]").setInputFiles({
        name: "falso.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from("no es un zip"),
      });
      let sheet = page.getByRole("dialog").last();
      await sheet.getByRole("button", { name: S.create.insert.insert }).click();
      await expect(sheet.getByRole("alert")).toBeVisible({ timeout: 30_000 });
      await closeTopSheet(page);

      await page.locator("[data-pro-import-input]").setInputFiles({
        name: "nota.html",
        mimeType: "text/html",
        buffer: Buffer.from("<html><body><h1>Nota insertada</h1><p>Texto de prueba.</p></body></html>"),
      });
      sheet = page.getByRole("dialog").last();
      await sheet.getByRole("button", { name: S.create.insert.insert }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });
      await expect(topBar(page).getByText(/^4 páginas$/)).toBeVisible();
      expect(await historySteps(page)).toBe(2);
      await topBar(page).getByRole("button", { name: S.suite.undo }).click();
      await expect(topBar(page).getByText(S.suite.pageCount(3))).toBeVisible();
    });

    test("Unir PDFs con 11: se añaden 10 y un aviso VISIBLE dice cuantos y cuales se omitieron; «Entendido» lo cierra y el resultado no lleva el omitido", async ({
      page,
    }) => {
      await openPagesWith(page, 2);
      const files: Upload[] = [];
      for (let i = 1; i <= 11; i += 1) {
        files.push({ name: `parte-${String(i).padStart(2, "0")}.pdf`, mimeType: "application/pdf", buffer: await makePdf({ pages: 1, label: `M${i}` }) });
      }
      await page.locator('[data-pages-input="merge"]').setInputFiles(files);
      const sheet = page.getByRole("dialog").last();
      await expect(sheet).toContainText(P.sheets.mergeTitle);
      const omitted = page.locator("[data-pages-omitted]");
      await expect(omitted).toBeVisible();
      await expect(omitted).toHaveAttribute("role", "note");
      await expect(omitted).toContainText(P.announce.omittedTitle(1, 10));
      await expect(omitted).toContainText(P.announce.omittedBody(["parte-11.pdf"], 0));
      await expect(omitted).not.toContainText("parte-10.pdf");
      await expect(sheet.getByRole("listitem")).toHaveCount(10);
      await expect(sheet.getByRole("button", { name: P.sheets.mergeSubmit(10, 10) })).toBeEnabled({ timeout: 30_000 });
      await sheet.getByRole("button", { name: P.sheets.mergeSubmit(10, 10) }).click();
      await expect(page.getByRole("listbox", { name: P.gridLabel(12) }), "2 paginas + 10 documentos de 1 pagina").toBeVisible();
      // El aviso sigue ahi hasta que se pulsa «Entendido».
      await expect(omitted).toBeVisible();
      await omitted.getByRole("button", { name: P.announce.omittedDismiss }).click();
      await expect(omitted).toHaveCount(0);

      await page.getByRole("button", { name: P.status.apply, exact: true }).click();
      await expect(page.locator("[data-pages-chip]")).toHaveText(P.status.noChanges, { timeout: 60_000 });
      await closePagesPanel(page);
      const out = await downloadDoc(page);
      expect(await getPageCount(out.bytes)).toBe(12);
      expect(await getPageText(out.bytes, 3)).toContain("M1-1");
      expect(await getPageText(out.bytes, 12)).toContain("M10-1");
    });

    test("Unir PDFs con 18: «Se omitieron 8 PDF» con los 5 primeros nombres y «y 3 más»; y, con el maximo ya usado, «Insertar desde PDF» tampoco abre nada y lo explica", async ({
      page,
    }) => {
      await openPagesWith(page, 2);
      const files: Upload[] = [];
      for (let i = 1; i <= 18; i += 1) {
        files.push({ name: `doc-${String(i).padStart(2, "0")}.pdf`, mimeType: "application/pdf", buffer: await makePdf({ pages: 1, label: `D${i}` }) });
      }
      await page.locator('[data-pages-input="merge"]').setInputFiles(files);
      const sheet = page.getByRole("dialog").last();
      const omitted = page.locator("[data-pages-omitted]");
      await expect(omitted).toBeVisible();
      await expect(omitted).toContainText(P.announce.omittedTitle(8, 10));
      await expect(omitted).toContainText(
        P.announce.omittedBody(["doc-11.pdf", "doc-12.pdf", "doc-13.pdf", "doc-14.pdf", "doc-15.pdf"], 3),
      );
      await expect(sheet.getByRole("button", { name: P.sheets.mergeSubmit(10, 10) })).toBeEnabled({ timeout: 30_000 });
      await sheet.getByRole("button", { name: P.sheets.mergeSubmit(10, 10) }).click();
      await expect(page.getByRole("listbox", { name: P.gridLabel(12) })).toBeVisible();
      await omitted.getByRole("button", { name: P.announce.omittedDismiss }).click();
      await expect(omitted).toHaveCount(0);

      // Ya hay 10 documentos añadidos sin aplicar: otro PDF por «Insertar desde PDF» no cabe.
      await page.locator('[data-pages-input="pdf"]').setInputFiles(await goodPdf("otro.pdf", 1, "OTR"));
      await expect(omitted).toBeVisible();
      await expect(omitted).toContainText(P.announce.omittedTitle(1, 10));
      await expect(omitted).toContainText("otro.pdf");
      await expect(page.getByRole("dialog").filter({ hasText: P.sheets.pdfTitle })).toHaveCount(0);
      await expect(status(page)).toHaveText(P.announce.limitReached);
      await noHorizontalOverflow(page);
    });
  });
}

/* ------------------------------------------------------------------ *
 * E · Nuevo PDF desde imagenes con archivos que no son imagenes
 * ------------------------------------------------------------------ */

for (const project of VIEWPORTS) {
  test.describe(`PDF Pro · errores al crear · ${project.name}`, () => {
    test.use({ viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

    test("Nuevo PDF desde imagenes: un archivo que no es imagen se omite con aviso y «Crear PDF» no hace nada; una imagen dañada da un error claro y no cambia el documento", async ({
      page,
    }) => {
      await openProPdf(page, { name: "base.pdf", pages: 2 });
      await page.locator("[data-pro-create-input]").setInputFiles({ name: "notas.txt", mimeType: "text/plain", buffer: Buffer.from("hola") });
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();
      await waitUntilStill(sheet);
      await expect(sheet.getByRole("note")).toContainText(S.create.images.notImage("notas.txt"));
      await expect(sheet.getByText(S.create.images.none)).toBeVisible();
      await expect(sheet.getByRole("button", { name: S.create.images.create })).toHaveAttribute("aria-disabled", "true");
      await sheet.getByRole("button", { name: S.create.images.create }).click({ force: true });
      await expect(page.getByRole("heading", { level: 1, name: /base\.pdf/ })).toBeVisible();

      // Una imagen que dice serlo pero esta dañada (cabecera PNG y basura).
      const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), filler(300)]);
      await sheet.locator("[data-new-images-input]").setInputFiles({ name: "rota.png", mimeType: "image/png", buffer: broken });
      await expect(sheet.getByText(/1\. rota\.png/)).toBeVisible();
      await sheet.getByRole("button", { name: S.create.images.create }).click();
      const alert = sheet.locator("[data-error-banner]");
      await expect(alert).toBeVisible({ timeout: 30_000 });
      await expect(alert).not.toContainText(T.errors.unknown);
      await closeTopSheet(page);
      await expect(page.getByRole("heading", { level: 1, name: /base\.pdf/ })).toBeVisible();
      await expect(page.getByText(S.suite.saved).first()).toBeVisible();
      expect(await historySteps(page)).toBe(1);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Regresiones de los hallazgos de arriba
 * ------------------------------------------------------------------ */

test.describe("errores al abrir e insertar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  async function openPagesAndImport(page: Page, file: Upload): Promise<Locator> {
    await openProPdf(page, { name: "base.pdf", pages: 3 });
    await page.locator("[data-pro-import-input]").setInputFiles(file);
    const sheet = page.getByRole("dialog").last();
    await sheet.getByRole("button", { name: S.create.insert.insert }).click();
    return sheet;
  }

  test("un .docx danado (cabecera zip y basura) debe decir «parece dañado», no «Algo ha fallado durante el proceso»", async ({ page }) => {
    knownDefect("`toPdfError` (core.ts) solo reconoce huellas de PDF (`CORRUPT_HINTS`): el error de mammoth «Corrupted zip: can't find end of central directory» cae en `unknown` («Algo ha fallado durante el proceso. Vuelve a intentarlo.») en vez de `corrupt`.");
    const sheet = await openPagesAndImport(page, {
      name: "falso.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.concat([Buffer.from("PK\x03\x04"), filler(600)]),
    });
    await expect(sheet.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("alert")).toContainText(T.errors.corrupt);
  });

  test("un .xlsx danado (cabecera zip y basura) debe decir «parece dañado», no «Algo ha fallado durante el proceso»", async ({ page }) => {
    knownDefect("Igual que .docx: exceljs lanza el mismo «Corrupted zip: can't find end of central directory», que no esta en `CORRUPT_HINTS`, y sale `unknown` en vez de `corrupt`.");
    const sheet = await openPagesAndImport(page, {
      name: "falso.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.concat([Buffer.from("PK\x03\x04"), filler(600)]),
    });
    await expect(sheet.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("alert")).toContainText(T.errors.corrupt);
  });

  test("un .html de 0 bytes debe decir que el archivo esta vacio (0 bytes), no «Necesitas añadir al menos un archivo»", async ({ page }) => {
    knownDefect("`htmlToPdf` (htmlToPdf.ts:661) lanza `empty` («no hay archivos») con un archivo de 0 bytes: el mensaje dice «Necesitas añadir al menos un archivo» en vez de `emptyFile` («El archivo está vacío (0 bytes)»).");
    const sheet = await openPagesAndImport(page, { name: "vacio.html", mimeType: "text/html", buffer: Buffer.alloc(0) });
    await expect(sheet.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("alert")).toContainText(T.errors.emptyFile);
  });

  test("tras cancelar la contraseña de un PDF SOLTADO sobre la zona de carga (sin foco previo) el foco no debe caer a <body>", async ({ page }) => {
    knownDefect("La hoja de contraseña devuelve el foco a lo que lo tenia al abrirse; al soltar un archivo con el raton no habia nada enfocado y `cancelPassword` no mueve el foco: queda en <body> (regla del proyecto: nunca en <body>).");
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    const file = await encryptedPdf();
    await dropPdf(page, file.buffer, file.name);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: T.password.cancel }).click();
    await expect(dialog).toBeHidden();
    await focusNotBody(page);
  });

  test("cerrar con la X el aviso de un archivo roto no debe dejar el foco en <body> (debe pasar a la zona de carga)", async ({ page }) => {
    knownDefect("`ProToolClient`/`ProEmptyState` solo limpian el estado del aviso (`dismissProblem`): el boton X que tenia el foco desaparece y el foco queda en <body> (regla del proyecto: nunca en <body>).");
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await emptyInput(page).setInputFiles(await badFile("garbage"));
    await expectFileProblem(banner(page), { name: "basura.pdf", ...PROBLEM.garbage });
    await banner(page).getByRole("button", { name: es.common.close }).click();
    // Espera a que el aviso termine de salir (mientras sale sigue en el DOM, inerte): solo entonces el foco es el definitivo.
    await expect(page.locator("[data-error-banner]")).toHaveCount(0);
    await focusNotBody(page);
  });

  test("tras «Continuar» con un archivo roto, el foco debe quedarse en el aviso", async ({
    page,
  }) => {
    knownDefect("`ConfirmSheet`/`Sheet` restaura el foco en el boton que la abrio DESPUES de su animacion de salida y se lo quita al aviso que `ProToolClient` acababa de enfocar (sin cambios pendientes el foco SI se queda en el aviso).");
    await openProPdf(page, { name: "informe.pdf", pages: 3 });
    await rotateAll(page);
    await openAnother(page, await badFile("empty"));
    await page.getByRole("dialog").getByRole("button", { name: S.session.replaceConfirm }).click();
    await expectFileProblem(suiteBanner(page), { name: "vacio.pdf", message: T.errors.emptyFile });
    await page.waitForTimeout(2000);
    await bannerHasFocus(suiteBanner(page));
  });

  test("«Entendido» en el aviso de PDF omitidos (maximo de 10) no debe dejar el foco en <body>", async ({ page }) => {
    knownDefect("`PagesTab` cierra el aviso `[data-pages-omitted]` con `setOmitted([])` sin `restoreFocus()` (el aviso de advertencias SI lo hace): el foco queda en <body>.");
    await openProPdf(page, { name: "base.pdf", pages: 2, label: "BAS" });
    await goToTab(page, "pages");
    await expect(grid(page)).toBeVisible();
    const files: Upload[] = [];
    for (let i = 1; i <= 11; i += 1) {
      files.push({ name: `parte-${String(i).padStart(2, "0")}.pdf`, mimeType: "application/pdf", buffer: await makePdf({ pages: 1, label: `M${i}` }) });
    }
    await page.locator('[data-pages-input="merge"]').setInputFiles(files);
    const omitted = page.locator("[data-pages-omitted]");
    await expect(omitted).toBeVisible();
    await closeTopSheet(page);
    await omitted.getByRole("button", { name: P.announce.omittedDismiss }).click();
    await expect(omitted).toHaveCount(0);
    await focusNotBody(page);
  });

  test("un .doc antiguo en «Insertar desde Word…» debe explicar que es el formato antiguo (legacyOfficeFormat), no solo «Elige un .docx, .xlsx o .html»", async ({
    page,
  }) => {
    knownDefect("`detectImportKind` devuelve null para .doc/.xls y la hoja muestra solo «Elige un archivo .docx, .xlsx o .html.»: no se menciona el formato antiguo ni se ofrece la guia de `legacyOfficeFormat`.");
    await openProPdf(page, { name: "base.pdf", pages: 3 });
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), filler(2000)]);
    await page.locator("[data-pro-import-input]").setInputFiles({ name: "antiguo.doc", mimeType: "application/msword", buffer: ole });
    await expect(page.getByRole("dialog").last()).toContainText(T.errors.legacyOfficeFormat);
  });
});
