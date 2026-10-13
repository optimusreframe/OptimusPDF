import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageText } from "../helpers/pdf-inspection";
import { colorDistance, renderPageToPixels } from "../helpers/pdf-render-inspection";
import { makeImage } from "../helpers/test-files";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { MODE_STRINGS } from "../../src/app/pdf-pro/modes/modeStrings";
import { EDIT_STRINGS } from "../../src/app/edit-pdf/strings";

/**
 * PDF Pro · modos Editar y Anotar (Wave 7 · U6), navegador real y headless, en 1280×800 y 375×812 tactil:
 * abrir un PDF de varias paginas, girar una pagina desde «Páginas», entrar a Editar, editar un texto existente y
 * anadir una imagen, aplicar y comprobar el PDF con pdf.js; entrar a Anotar, resaltar y dibujar un rectangulo;
 * Ctrl+Z global deshace UNA aplicacion por vez; salir con cambios pregunta; sin errores de consola, sin desbordes,
 * foco nunca en <body> y axe sin violaciones.
 */

const S = PRO_STRINGS.es;
const P = S.pages;
const M = MODE_STRINGS.es;
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const VIEWPORTS = [
  { name: "escritorio 1280×800", width: 1280, height: 800, mobile: false },
  { name: "móvil 375×812", width: 375, height: 812, mobile: true },
] as const;

test.setTimeout(180_000);

type Env = { mobile: boolean };

/* ------------------------------------------------------------------ *
 * Documento de prueba
 * ------------------------------------------------------------------ */

/** Tres paginas A4: la 1 con un texto rojo editable; la 2 y la 3 con su propio rotulo. */
async function makeReport(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage([595, 842]);
  p1.drawText("Informe trimestral", { x: 50, y: 770, size: 26, font: bold });
  p1.drawText("Total a pagar: 1.250,00", { x: 50, y: 600, size: 14, font: helv, color: rgb(0.8, 0.1, 0.1) });
  const p2 = doc.addPage([595, 842]);
  p2.drawText("Pagina dos del informe", { x: 50, y: 770, size: 20, font: helv });
  const p3 = doc.addPage([595, 842]);
  p3.drawText("Pagina tres del informe", { x: 50, y: 770, size: 20, font: helv });
  return Buffer.from(await doc.save());
}

/* ------------------------------------------------------------------ *
 * Ayudas
 * ------------------------------------------------------------------ */

const topBar = (page: Page) => page.locator('[data-pro-region="top"]');
const host = (page: Page) => page.locator("[data-pro-mode-host]");
const modeBar = (page: Page) => page.locator("[data-pro-mode-bar]");
const applyButton = (page: Page) => page.locator("[data-pro-mode-apply]");
const discardButton = (page: Page) => page.locator("[data-pro-mode-discard]");
const palette = (page: Page, id: string) => page.locator(`[data-palette-item="${id}"]`);
const grid = (page: Page) => page.getByRole("listbox", { name: /Páginas del documento/ });
const cardAt = (page: Page, n: number) => grid(page).getByRole("option", { name: new RegExp(`^Página ${n} de`) });
const block = (page: Page, text: string) => page.getByRole("button", { name: new RegExp(`^Texto: ${text}`) });

async function openPro(page: Page, bytes: Buffer, name = "informe.pdf"): Promise<void> {
  await page.goto("/pdf-pro");
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
  await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible();
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

/** Abre la herramienta de la barra (pestaña en escritorio, boton del dock en movil). */
async function pickTool(page: Page, env: Env, name: string): Promise<void> {
  if (env.mobile) await page.getByRole("button", { name, exact: true }).click();
  else await page.getByRole("tab", { name }).click();
}

async function closePanel(page: Page, env: Env): Promise<void> {
  if (!env.mobile) return;
  const dialogs = page.getByRole("dialog");
  if ((await dialogs.count()) === 0) return;
  await dialogs.last().getByRole("button", { name: "Cerrar", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function openPagesPanel(page: Page, env: Env): Promise<void> {
  await pickTool(page, env, S.suite.tabs.pages);
  await expect(grid(page)).toBeVisible();
  await expect(cardAt(page, 1)).toBeVisible();
  if (env.mobile) await waitUntilStill(page.getByRole("dialog").last());
}

/** Gira la pagina `n` a la derecha desde «Páginas» y aplica (UN snapshot). */
async function rotatePageFromPages(page: Page, env: Env, n: number): Promise<void> {
  await openPagesPanel(page, env);
  await cardAt(page, n).click();
  await page.getByRole("button", { name: P.actions.rotateRight, exact: true }).click();
  await page.getByRole("button", { name: P.status.apply, exact: true }).click();
  await expect(page.locator("[data-pages-chip]")).toHaveText(P.status.noChanges);
  await closePanel(page, env);
}

async function downloadCurrent(page: Page, env: Env): Promise<Buffer> {
  await closePanel(page, env);
  const result = await downloadFile(page, async () => {
    await topBar(page).getByRole("button", { name: S.suite.download }).click();
  });
  return result.bytes;
}

async function enterMode(page: Page, env: Env, name: "Editar" | "Anotar"): Promise<void> {
  await pickTool(page, env, name);
  await expect(host(page)).toBeVisible();
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(palette(page, "select")).toBeVisible();
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
}

async function focusNotBody(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null), {
      message: "el foco nunca queda en <body>",
    })
    .toBe(true);
}

/** Selecciona un bloque de texto y lo abre para editar: doble clic (raton) o dos toques (dedo). */
async function openBlockEditor(page: Page, env: Env, text: string): Promise<Locator> {
  const target = block(page, text);
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  if (env.mobile) {
    const rect = (await target.boundingBox())!;
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
  } else {
    await target.dblclick();
  }
  const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
  await expect(editor).toBeFocused();
  return editor;
}

/** Arrastra sobre la hoja de edicion, entre dos puntos relativos a su caja. */
async function dragOnSheet(page: Page, env: Env, from: [number, number], to: [number, number]): Promise<void> {
  const sheet = page.locator("[data-edit-canvas]").first();
  await sheet.evaluate((el) => el.scrollIntoView({ block: "start" }));
  const box = (await sheet.boundingBox())!;
  const a = { x: box.x + box.width * from[0], y: box.y + Math.min(box.height * from[1], 400) };
  const b = { x: box.x + box.width * to[0], y: box.y + Math.min(box.height * to[1], 460) };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function inspectModeA11y(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe;
    const result = await axe.run("[data-pro-mode-host]", {});
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 140)).join(" | ")}`);
  });
}

/* ------------------------------------------------------------------ *
 * Por viewport
 * ------------------------------------------------------------------ */

for (const viewport of VIEWPORTS) {
  test.describe(`PDF Pro · Editar y Anotar · ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      locale: "es-ES",
      hasTouch: viewport.mobile,
      isMobile: viewport.mobile,
    });
    const env: Env = { mobile: viewport.mobile };

    test("girar una pagina, editar un texto existente y anadir una imagen: UN snapshot que se lee con pdf.js", async ({ page }) => {
      await openPro(page, await makeReport());

      // 1) Girar la pagina 2 desde «Páginas» (un snapshot de operacion).
      await rotatePageFromPages(page, env, 2);

      // 2) Entrar a Editar: el visor suelta el PDF y el modo ocupa su sitio.
      await enterMode(page, env, "Editar");
      await expect(page.locator("[data-pro-viewer-scroller]")).toHaveCount(0);
      await expect(modeBar(page)).toContainText(M.host.editing);
      await expect(applyButton(page)).toHaveAttribute("aria-disabled", "true");
      await noHorizontalOverflow(page);

      // 3) Editar el texto existente. El modo entra en la pagina que se miraba (la 2, que se acaba de girar): se
      // pasa a la 1 con el teclado, donde esta el texto.
      await palette(page, "select").focus();
      await page.keyboard.press("[");
      await expect(page.getByRole("textbox", { name: EDIT_STRINGS.es.inline.goToPageLabel })).toHaveValue("1");
      const editor = await openBlockEditor(page, env, "Total a pagar");
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("Total pagado: 99,00");
      await expect(editor).toHaveText("Total pagado: 99,00");
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await expect(modeBar(page)).toContainText(M.host.dirty);

      // 4) Anadir una imagen desde el selector.
      await palette(page, "image").click();
      await page.locator("[data-image-input]").setInputFiles({
        name: "sello.png",
        mimeType: "image/png",
        buffer: makeImage("png", 64, 64, 3),
      });
      await expect(page.locator('[data-element-kind="image"]').first()).toBeVisible();
      await focusNotBody(page);

      // 5) Aplicar: UN snapshot «Edición (2)», vuelta al visor, foco en la pestaña de origen.
      await applyButton(page).click();
      await expect(host(page)).toHaveCount(0);
      await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible();
      await expect(page.locator("[data-pro-mode-result]")).toContainText(M.host.appliedTitle(M.edit.label(2)));
      await expect(page.locator("[data-pro-mode-result]")).toContainText("1 texto editado");
      await focusNotBody(page);
      await noHorizontalOverflow(page);

      // 6) El PDF resultante, leido con pdf.js: texto nuevo, imagen, giro y paginas intactas.
      const bytes = await downloadCurrent(page, env);
      expect(await getPageCount(bytes)).toBe(3);
      const page1Text = await getPageText(bytes, 1);
      expect(page1Text).toContain("Total pagado: 99,00");
      // Wave 8 · F2: el importe original se ELIMINA del flujo (pdf.js ya no lo extrae).
      expect(page1Text).not.toContain("1.250,00");
      expect(await getPageText(bytes, 2)).toContain("Pagina dos del informe");
      expect(await getPageText(bytes, 3)).toContain("Pagina tres del informe");
      expect((await getPageOperatorCounts(bytes, 1)).imagePaintOps).toBeGreaterThanOrEqual(1);
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPage(1).getRotation().angle).toBe(90);
      expect(loaded.getPage(0).getRotation().angle).toBe(0);

      // 7) Ctrl+Z global deshace UNA aplicacion por vez: primero la edicion, luego el giro.
      await pickTool(page, env, S.suite.tabs.convert);
      await closePanel(page, env);
      await page.locator('[data-pro-region="top"] h1').focus();
      await page.keyboard.press("ControlOrMeta+Z");
      const afterFirstUndo = await downloadCurrent(page, env);
      expect(await getPageText(afterFirstUndo, 1)).toContain("Total a pagar: 1.250,00");
      expect((await PDFDocument.load(afterFirstUndo)).getPage(1).getRotation().angle).toBe(90);
      await page.keyboard.press("ControlOrMeta+Z");
      const afterSecondUndo = await downloadCurrent(page, env);
      expect((await PDFDocument.load(afterSecondUndo)).getPage(1).getRotation().angle).toBe(0);
      await expect(topBar(page).getByRole("button", { name: S.suite.undo })).toHaveAttribute("aria-disabled", "true");
    });

    test("Anotar: resaltar y anadir un rectangulo, aplicar «Anotaciones (2)» y comprobar el resultado", async ({ page }) => {
      await openPro(page, await makeReport());
      await enterMode(page, env, "Anotar");
      await expect(modeBar(page)).toContainText(M.host.annotating);
      // Paleta de anotacion: resaltador, figuras, marca, texto, nota e imagen.
      for (const id of ["select", "highlight", "rect", "ellipse", "line", "check", "text", "note", "image"]) {
        await expect(palette(page, id)).toBeVisible();
      }
      await expect(page.locator("[data-flatten-toggle]")).toHaveCount(0);

      await palette(page, "highlight").click();
      await dragOnSheet(page, env, [0.12, 0.1], [0.55, 0.13]);
      await palette(page, "rect").click();
      await dragOnSheet(page, env, [0.2, 0.3], [0.6, 0.4]);
      await expect(modeBar(page)).toContainText(M.host.dirty);

      await applyButton(page).click();
      await expect(host(page)).toHaveCount(0);
      await expect(page.locator("[data-pro-mode-result]")).toContainText(M.host.appliedTitle(M.annotate.label(2)));
      await focusNotBody(page);

      const bytes = await downloadCurrent(page, env);
      expect(await getPageCount(bytes)).toBe(3);
      // El texto original sigue ahi (se anota ENCIMA) y el resaltado amarillo ha tenido que pintar pixeles.
      expect(await getPageText(bytes, 1)).toContain("Informe trimestral");
      const rendered = await renderPageToPixels(bytes, 1, 1);
      let yellow = 0;
      const target = { r: 255, g: 250, b: 225, a: 255 };
      for (let y = 0; y < rendered.height; y += 3) {
        for (let x = 0; x < rendered.width; x += 3) {
          if (colorDistance(rendered.pixelAt(x, y), target) < 14) yellow += 1;
        }
      }
      expect(yellow, "el resaltado se ve en la pagina").toBeGreaterThan(20);
      // Y el rectangulo rojo (INK_COLORS[0]) tambien.
      let red = 0;
      const rose = { r: 225, g: 29, b: 72, a: 255 };
      for (let y = 0; y < rendered.height; y += 2) {
        for (let x = 0; x < rendered.width; x += 2) {
          if (colorDistance(rendered.pixelAt(x, y), rose) < 30) red += 1;
        }
      }
      expect(red, "el rectangulo se ve en la pagina").toBeGreaterThan(20);
    });

    test("salir con cambios sin aplicar pregunta: seguir, descartar y salir, o aplicar y salir", async ({ page }) => {
      await openPro(page, await makeReport());
      await enterMode(page, env, "Anotar");
      await palette(page, "rect").click();
      await dragOnSheet(page, env, [0.2, 0.3], [0.6, 0.4]);
      await expect(modeBar(page)).toContainText(M.host.dirty);

      // Otra pestaña con cambios: pregunta.
      await pickTool(page, env, S.suite.tabs.protect);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(M.host.leaveTitle);
      // «Seguir editando»: nada cambia.
      await dialog.getByRole("button", { name: M.host.leaveStay }).click();
      await expect(dialog).toHaveCount(0);
      await expect(host(page)).toBeVisible();
      await expect(modeBar(page)).toContainText(M.host.dirty);
      await focusNotBody(page);

      // «Descartar y salir»: sin snapshot (el documento sigue como se abrio).
      await pickTool(page, env, S.suite.tabs.protect);
      await page.getByRole("dialog").getByRole("button", { name: M.host.leaveDiscard }).click();
      await expect(host(page)).toHaveCount(0);
      await closePanel(page, env);
      await expect(topBar(page).getByRole("button", { name: S.suite.undo })).toHaveAttribute("aria-disabled", "true");
      await expect(topBar(page)).toContainText(S.suite.saved);

      // Otra vez, ahora «Aplicar y salir»: UN snapshot y se llega a la pestaña pedida.
      await enterMode(page, env, "Anotar");
      await palette(page, "ellipse").click();
      await dragOnSheet(page, env, [0.2, 0.3], [0.5, 0.4]);
      await pickTool(page, env, S.suite.tabs.pages);
      await page.getByRole("dialog").getByRole("button", { name: M.host.leaveApply }).click();
      await expect(host(page)).toHaveCount(0);
      await expect(grid(page)).toBeVisible();
      await closePanel(page, env);
      await expect(topBar(page)).toContainText(S.suite.unsaved);
      await focusNotBody(page);
      await topBar(page).getByRole("button", { name: S.suite.undo }).click();
      await expect(topBar(page).getByRole("button", { name: S.suite.undo })).toHaveAttribute("aria-disabled", "true");
    });

    test("dentro del modo Ctrl+Z deshace el editor y no el documento; Descartar sin cambios vuelve al visor", async ({ page }) => {
      await openPro(page, await makeReport());
      await rotatePageFromPages(page, env, 1);
      await enterMode(page, env, "Anotar");
      await palette(page, "rect").click();
      await dragOnSheet(page, env, [0.2, 0.3], [0.6, 0.4]);
      await expect(modeBar(page)).toContainText(M.host.dirty);
      await palette(page, "select").focus();
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(modeBar(page)).toContainText(M.host.clean);
      // Los botones de deshacer del documento estan apagados dentro del modo.
      await expect(topBar(page).getByRole("button", { name: S.suite.undo })).toHaveAttribute("aria-disabled", "true");
      await discardButton(page).click();
      await expect(host(page)).toHaveCount(0);
      await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible();
      await focusNotBody(page);
      // El giro sigue aplicado: el modo no deshizo el documento.
      const bytes = await downloadCurrent(page, env);
      expect((await PDFDocument.load(bytes)).getPage(0).getRotation().angle).toBe(90);
    });

    test("accesibilidad: axe sin violaciones en Editar y en Anotar, sin desbordes y con objetivos tactiles", async ({ page }) => {
      await openPro(page, await makeReport());
      await enterMode(page, env, "Editar");
      expect(await inspectModeA11y(page)).toEqual([]);
      await noHorizontalOverflow(page);
      await discardButton(page).click();
      await expect(host(page)).toHaveCount(0);
      await enterMode(page, env, "Anotar");
      expect(await inspectModeA11y(page)).toEqual([]);
      await noHorizontalOverflow(page);
      if (viewport.mobile) {
        const small = await page.evaluate(() =>
          [...document.querySelectorAll("[data-pro-mode-bar] button, [data-tool-palette] button")]
            .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent?.trim(), ...el.getBoundingClientRect().toJSON() }))
            .filter((el) => el.width < 43.5 || el.height < 43.5)
            .map((el) => el.name),
        );
        expect(small, "objetivos tactiles de 44 px").toEqual([]);
      }
    });

    test("la barra del modo, la paleta y la hoja caben en la region sin tapar la barra del documento", async ({ page }) => {
      await openPro(page, await makeReport());
      await enterMode(page, env, "Editar");
      const regions = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
        return {
          top: rect('[data-pro-region="top"]'),
          bar: rect("[data-pro-mode-bar]"),
          palette: rect("[data-tool-palette]"),
          scroller: rect("[data-edit-scroll]"),
          vh: window.innerHeight,
        };
      });
      expect(regions.bar!.top).toBeGreaterThanOrEqual(regions.top!.bottom - 1);
      expect(regions.scroller!.bottom).toBeLessThanOrEqual(regions.vh + 1);
      expect(regions.palette!.bottom).toBeLessThanOrEqual(regions.vh + 1);
      await focusNotBody(page);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Solo escritorio: atajos y paleta de comandos
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · atajos de los modos (escritorio)", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "es-ES" });

  test("E abre Editar, A abre Anotar, y dentro del modo E es la elipse", async ({ page }) => {
    await openPro(page, await makeReport());
    await page.locator('[data-pro-region="top"] h1').focus();
    await page.keyboard.press("e");
    await expect(host(page)).toHaveAttribute("data-mode", "edit");
    await expect(palette(page, "select")).toBeFocused();
    await page.keyboard.press("e");
    await expect(host(page)).toHaveAttribute("data-mode", "edit");
    await expect(palette(page, "ellipse")).toHaveAttribute("aria-pressed", "true");
    await discardButton(page).click();
    await expect(host(page)).toHaveCount(0);
    await page.locator('[data-pro-region="top"] h1').focus();
    await page.keyboard.press("a");
    await expect(host(page)).toHaveAttribute("data-mode", "annotate");
  });

  test("E y A NO abren nada si el foco esta en un campo de texto", async ({ page }) => {
    await openPro(page, await makeReport());
    const pageInput = page.getByRole("textbox", { name: S.viewer.pageInputLabel });
    await pageInput.focus();
    await page.keyboard.type("ea");
    await expect(host(page)).toHaveCount(0);
  });

  test("la paleta de comandos ofrece Editar texto, Anotar, Añadir imagen y arma la herramienta", async ({ page }) => {
    await openPro(page, await makeReport());
    await page.locator('[data-pro-region="top"] h1').focus();
    await page.keyboard.press("ControlOrMeta+K");
    const input = page.getByRole("combobox");
    await input.fill(M.commands.highlight);
    await page.getByRole("option", { name: new RegExp(M.commands.highlight) }).first().click();
    await expect(host(page)).toHaveAttribute("data-mode", "annotate");
    await expect(palette(page, "highlight")).toHaveAttribute("aria-pressed", "true");
    await focusNotBody(page);
  });

  test("el visor suelta su PDF mientras se edita (ningun lienzo del visor en el DOM) y lo recupera", async ({ page }) => {
    await openPro(page, await makeReport());
    await expect
      .poll(() => page.locator("[data-pro-viewer-scroller] canvas, [data-pro-viewer-scroller] img").count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await enterMode(page, { mobile: false }, "Editar");
    await expect(page.locator("[data-pro-viewer-scroller]")).toHaveCount(0);
    await expect(page.locator("[data-pro-thumbs], [data-pro-region='thumbs']")).toHaveCount(0);
    await discardButton(page).click();
    await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible();
  });

  test("recargar con cambios sin aplicar recupera el borrador del editor (borrador compartido)", async ({ page }) => {
    const bytes = await makeReport();
    await openPro(page, bytes);
    await enterMode(page, { mobile: false }, "Anotar");
    await palette(page, "rect").click();
    await dragOnSheet(page, { mobile: false }, [0.2, 0.3], [0.6, 0.4]);
    await expect(modeBar(page)).toContainText(M.host.dirty);
    // Da tiempo al autoguardado (calma de 350 ms) y recarga con el mismo archivo.
    await page.waitForTimeout(900);
    await page.reload();
    await page.locator('input[type="file"]').first().setInputFiles({ name: "informe.pdf", mimeType: "application/pdf", buffer: bytes });
    await expect(page.getByRole("heading", { level: 1, name: /informe\.pdf/ })).toBeVisible();
    await enterMode(page, { mobile: false }, "Anotar");
    await expect(page.locator('[data-notice="restored"]')).toBeVisible();
    await expect(modeBar(page)).toContainText(M.host.dirty);
    await discardButton(page).click();
    await page.getByRole("dialog").getByRole("button", { name: M.host.discardConfirm }).click();
    await expect(host(page)).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ *
 * Ventanas bajas: la paleta del editor embebido tiene que ser alcanzable
 * ------------------------------------------------------------------ */

for (const size of [
  { width: 1280, height: 600 },
  { width: 1366, height: 600 },
  { width: 1280, height: 700 },
] as const) {
  test.describe(`PDF Pro · paleta del editor en ${size.width}×${size.height}`, () => {
    test.use({ viewport: size, locale: "es-ES" });

    for (const mode of ["Editar", "Anotar"] as const) {
      test(`${mode}: cada boton de la paleta queda dentro del viewport o se alcanza con el scroll interno y recibe el clic`, async ({ page }) => {
        await openPro(page, await makeReport());
        await enterMode(page, { mobile: false }, mode);
        const toolbar = page.locator("[data-tool-palette]");
        const items = toolbar.locator("[data-palette-item]");
        const count = await items.count();
        expect(count).toBeGreaterThanOrEqual(10);
        // La paleta nunca se sale de la ventana ni tapa el enlace de privacidad.
        const box = (await toolbar.boundingBox())!;
        expect(box.y + box.height, "el borde inferior de la paleta cabe en la ventana").toBeLessThanOrEqual(size.height + 1);
        const privacy = (await page.locator("[data-edit-privacy]").boundingBox())!;
        expect(box.y + box.height, "la paleta no tapa «Privacidad»").toBeLessThanOrEqual(privacy.y + 1);
        for (let i = 0; i < count; i += 1) {
          const item = items.nth(i);
          await item.scrollIntoViewIfNeeded();
          const rect = (await item.boundingBox())!;
          expect(rect.y, `boton ${i} dentro del viewport (arriba)`).toBeGreaterThanOrEqual(0);
          expect(rect.y + rect.height, `boton ${i} dentro del viewport (abajo)`).toBeLessThanOrEqual(size.height + 1);
          // El punto central recibe el clic: no lo tapa otro elemento.
          const hit = await item.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return top === el || el.contains(top);
          });
          expect(hit, `el boton ${i} recibe el raton`).toBe(true);
        }
        // Y las herramientas del final (Nota/Imagen en Anotar, Deshacer/Rehacer siempre) se pueden pulsar de verdad.
        await palette(page, mode === "Anotar" ? "note" : "image").scrollIntoViewIfNeeded();
        await palette(page, mode === "Anotar" ? "note" : "rect").click();
        await expect(palette(page, mode === "Anotar" ? "note" : "rect")).toHaveAttribute("aria-pressed", "true");
        await palette(page, "redo").scrollIntoViewIfNeeded();
        await expect(palette(page, "redo")).toBeVisible();
        await expect(palette(page, "undo")).toBeVisible();
      });
    }
  });
}
