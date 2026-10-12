import { PDFDocument } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { makeImage, makePdf } from "../helpers/test-files";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { es } from "../../src/lib/locales/es";
import { inspectPdf, makeRichPdf, marker, TINY_PNG } from "../../src/lib/pdf/testing/pageAssemblyFixtures";

/**
 * PDF Pro · Paginas (Wave 7 · U4), navegador real y headless, en 1280×800 y 375×812:
 * reordenar (arrastre real con raton y con dedo, y por botones), girar, eliminar, duplicar, pagina en
 * blanco, insertar desde otro PDF, insertar una imagen, unir, extraer y dividir; cada resultado se lee
 * con pdf-lib. Comprueba que se conservan los metadatos, el formulario y los marcadores, que «Aplicar»
 * es UN snapshot y se deshace de golpe, que 60 y 500 paginas van fluidas (cuadricula virtualizada), y
 * que no hay errores de consola, desbordes ni foco en <body>.
 */

const S = PRO_STRINGS.es;
const P = S.pages;
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const VIEWPORTS = [
  { name: "escritorio 1280×800", width: 1280, height: 800, mobile: false },
  { name: "móvil 375×812", width: 375, height: 812, mobile: true },
] as const;

test.setTimeout(120_000);

/* ------------------------------------------------------------------ *
 * Ayudas
 * ------------------------------------------------------------------ */

type Env = { mobile: boolean };

const grid = (page: Page) => page.getByRole("listbox", { name: /Páginas del documento/ });
const cards = (page: Page) => grid(page).getByRole("option");
const cardAt = (page: Page, n: number) => grid(page).getByRole("option", { name: new RegExp(`^Página ${n} de`) });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const chip = (page: Page) => page.locator("[data-pages-chip]");
const topBar = (page: Page) => page.locator('[data-pro-region="top"]');

async function openProWith(page: Page, env: Env, bytes: Buffer, name = "informe.pdf"): Promise<void> {
  await page.goto("/pdf-pro");
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
  await openPagesPanel(page, env);
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

async function openPagesPanel(page: Page, env: Env): Promise<void> {
  if (env.mobile) await page.getByRole("button", { name: S.suite.tabs.pages, exact: true }).click();
  else await page.getByRole("tab", { name: S.suite.tabs.pages }).click();
  await expect(grid(page)).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
  if (env.mobile) await waitUntilStill(page.getByRole("dialog").last());
}

/** Cierra la hoja del panel (movil) para llegar a la barra del documento. */
async function closePanel(page: Page, env: Env): Promise<void> {
  if (!env.mobile) return;
  // Con paginas seleccionadas, Escape primero suelta la seleccion: se cierra con el boton de la hoja.
  await page.getByRole("dialog").last().getByRole("button", { name: "Cerrar", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function downloadCurrent(page: Page, env: Env): Promise<Buffer> {
  await closePanel(page, env);
  const result = await downloadFile(page, async () => {
    await topBar(page).getByRole("button", { name: S.suite.download }).click();
  });
  return result.bytes;
}

/** Abre «Más» y pulsa una accion (barra compacta del panel y de la hoja). */
async function viaMore(page: Page, name: string): Promise<void> {
  await button(page, P.actions.more).click();
  await page.getByRole("dialog").last().getByRole("button", { name, exact: true }).click();
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

/** Etiquetas de las primeras `count` tarjetas («Página 3 de 8 (original 5)»). */
async function labels(page: Page, count = 12): Promise<string[]> {
  return (await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).slice(0, count);
}

/** `original N` de cada tarjeta, en orden (la que no lo dice es la N-esima original). */
async function originals(page: Page, count: number): Promise<number[]> {
  const items = await labels(page, count);
  return items.map((label, index) => {
    const match = /original (\d+)/.exec(label);
    return match ? Number(match[1]) : index + 1;
  });
}

async function dragWithMouse(page: Page, from: Locator, to: Locator, where: "left" | "right" = "left"): Promise<void> {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 20, { steps: 4 });
  await page.mouse.move(where === "left" ? b.x + 8 : b.x + b.width - 8, b.y + b.height / 2, { steps: 14 });
  await page.mouse.up();
}

async function dragWithTouch(
  page: Page,
  cdp: CDPSession,
  from: Locator,
  to: Locator,
  where: "left" | "right" = "left",
): Promise<void> {
  const handle = from.locator("[data-drag-handle]");
  const h = (await handle.boundingBox())!;
  const b = (await to.boundingBox())!;
  const area = (await grid(page).boundingBox())!;
  const start = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  const end = {
    x: where === "left" ? b.x + 8 : b.x + b.width - 8,
    // El destino tiene que caer dentro de la parte visible de la cuadricula.
    y: Math.max(area.y + 10, Math.min(b.y + b.height / 2, area.y + area.height - 10)),
  };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
  for (let i = 1; i <= 14; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x + ((end.x - start.x) * i) / 14, y: start.y + ((end.y - start.y) * i) / 14, id: 1 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Selecciona SOLO esa pagina (clic con raton: sustituye la seleccion en escritorio y en movil). */
async function pickOnly(page: Page, n: number): Promise<void> {
  await cardAt(page, n).click();
}

/** Anade una pagina a la seleccion: Ctrl/Cmd+clic con raton, un toque con el dedo (alterna). */
async function pickAdd(page: Page, env: Env, n: number): Promise<void> {
  if (env.mobile) await cardAt(page, n).tap();
  else await cardAt(page, n).click({ modifiers: ["ControlOrMeta"] });
}

const RICH = {
  pages: 8,
  title: "Informe anual",
  author: "Ana Pérez",
  form: true,
  outline: true,
  links: true,
} as const;

/* ------------------------------------------------------------------ *
 * Por viewport
 * ------------------------------------------------------------------ */

for (const viewport of VIEWPORTS) {
  test.describe(`PDF Pro · Páginas · ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      locale: "es-ES",
      hasTouch: viewport.mobile,
      isMobile: viewport.mobile,
    });
    const env: Env = { mobile: viewport.mobile };

    test("reordenar (arrastre real), girar, eliminar y duplicar: UN snapshot que conserva metadatos, formulario y marcadores, y se deshace de golpe", async ({
      page,
      context,
    }) => {
      const bytes = Buffer.from(await makeRichPdf(RICH));
      await openProWith(page, env, bytes);
      await expect(cards(page)).toHaveCount(8);
      await expect(chip(page)).toHaveText(P.status.noChanges);
      await noHorizontalOverflow(page);

      // 1) Reordenar ARRASTRANDO la primera pagina a la derecha de la segunda.
      if (viewport.mobile) {
        await dragWithTouch(page, await context.newCDPSession(page), cardAt(page, 1), cardAt(page, 2), "right");
      } else {
        await dragWithMouse(page, cardAt(page, 1), cardAt(page, 2), "right");
      }
      await expect(chip(page)).toHaveText(P.status.changes(1));
      expect(await originals(page, 8)).toEqual([2, 1, 3, 4, 5, 6, 7, 8]);

      // 2) Girar a la derecha la segunda (la antigua 1) y a la izquierda la quinta.
      await pickOnly(page, 2);
      await button(page, P.actions.rotateRight).click();
      await pickOnly(page, 5);
      await button(page, P.actions.rotateLeft).click();
      await expect(cardAt(page, 2)).toContainText("90°");
      await expect(cardAt(page, 5)).toContainText("270°");

      // 3) Eliminar las paginas 7 y 8 (clic + Ctrl/dedo).
      await pickOnly(page, 7);
      await pickAdd(page, env, 8);
      await button(page, P.actions.remove).click();
      await expect(cards(page)).toHaveCount(6);
      await focusNotBody(page);

      // 4) Duplicar la primera.
      await pickOnly(page, 3);
      await button(page, P.actions.duplicate).click();
      await expect(cards(page)).toHaveCount(7);
      await expect(cardAt(page, 4)).toContainText(P.card.copyOf(3));
      await expect(chip(page)).toHaveText(P.status.changes(5));
      await noHorizontalOverflow(page);

      // 5) Aplicar: UN snapshot con etiqueta descriptiva.
      await button(page, P.status.apply).click();
      await expect(chip(page)).toHaveText(P.status.noChanges);
      await focusNotBody(page);
      const result = await downloadCurrent(page, env);
      const info = await inspectPdf(new Uint8Array(result));
      expect(info.pageCount).toBe(7);
      expect(info.title).toBe("Informe anual");
      expect(info.author).toBe("Ana Pérez");
      // Orden final: 2, 1 (girada 90), 3, copia de 3, 4, 5 (girada 270), 6.
      expect(info.markers).toEqual([marker(1), marker(0), marker(2), marker(2), marker(3), marker(4), marker(5)]);
      expect(info.widths).toEqual([301, 300, 302, 302, 303, 304, 305]);
      expect(info.rotations).toEqual([0, 90, 0, 0, 0, 270, 0]);
      expect(info.fieldNames.sort()).toEqual(["campo-1", "campo-2", "campo-3", "campo-4", "campo-5", "campo-6"]);
      expect(info.outlineTitles.length).toBe(6);
      expect(info.pageObjects).toBe(7);

      // 6) Historial global: dos pasos (Original + este) y un solo «Deshacer» los revierte todos.
      await topBar(page).getByRole("button", { name: S.suite.undo }).click();
      await openPagesPanel(page, env);
      await expect(cards(page)).toHaveCount(8);
      const undone = await downloadCurrent(page, env);
      expect((await inspectPdf(new Uint8Array(undone))).rotations).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    test("pagina en blanco, otro PDF, una imagen y unir: se aplican de una vez y el resultado es el esperado", async ({ page }) => {
      const base = Buffer.from(await makeRichPdf({ pages: 3, title: "Base", form: true }));
      await openProWith(page, env, base);

      // En blanco despues de la pagina 1.
      await cardAt(page, 1).click();
      await viaMore(page, P.actions.insertBlank);
      await page.getByRole("dialog").last().getByRole("button", { name: P.sheets.blankSubmit }).click();
      await expect(cards(page)).toHaveCount(4);

      // Desde otro PDF: paginas 2 y 3 al final.
      const other = await makePdf({ pages: 4, label: "OTRO", size: [500, 700] });
      await page.locator('[data-pages-input="pdf"]').setInputFiles({ name: "otro.pdf", mimeType: "application/pdf", buffer: other });
      const sheet = page.getByRole("dialog").last();
      await expect(sheet.getByRole("option")).toHaveCount(4);
      await sheet.getByRole("button", { name: P.sheets.pdfSelectNone }).click();
      await sheet.getByRole("option").nth(1).click();
      if (viewport.mobile) await sheet.getByRole("option").nth(2).tap();
      else await sheet.getByRole("option").nth(2).click({ modifiers: ["ControlOrMeta"] });
      await sheet.getByRole("radio", { name: P.sheets.positionEnd }).click();
      await sheet.getByRole("button", { name: P.sheets.pdfSubmit(2) }).click();
      await expect(cards(page)).toHaveCount(6);

      // Una imagen al principio.
      await page.locator('[data-pages-input="images"]').setInputFiles({
        name: "foto.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG),
      });
      const images = page.getByRole("dialog").last();
      await images.getByRole("radio", { name: P.sheets.positionStart }).click();
      await images.getByRole("button", { name: P.sheets.imagesSubmit(1) }).click();
      await expect(cards(page)).toHaveCount(7);

      // Unir otro PDF completo al final.
      const third = await makePdf({ pages: 2, label: "TERCERO", size: [450, 450] });
      await page.locator('[data-pages-input="merge"]').setInputFiles({ name: "tercero.pdf", mimeType: "application/pdf", buffer: third });
      const merge = page.getByRole("dialog").last();
      await expect(merge.getByRole("button", { name: P.sheets.mergeSubmit(1, 2) })).toBeEnabled();
      await merge.getByRole("button", { name: P.sheets.mergeSubmit(1, 2) }).click();
      await expect(cards(page)).toHaveCount(9);
      await noHorizontalOverflow(page);

      await button(page, P.status.apply).click();
      await expect(chip(page)).toHaveText(P.status.noChanges, { timeout: 30_000 });
      const out = await downloadCurrent(page, env);
      const info = await inspectPdf(new Uint8Array(out));
      expect(info.pageCount).toBe(9);
      expect(info.title).toBe("Base");
      // imagen(A4) | 1 | blanca | 2 | 3 | otro-2 | otro-3 | tercero-1 | tercero-2
      expect(info.widths).toEqual([595.28, 300, 300, 301, 302, 500, 500, 450, 450]);
      expect(info.markers[1]).toBe(marker(0));
      expect(info.markers[2]).toBeUndefined();
      expect(info.fieldNames.sort()).toEqual(["campo-1", "campo-2", "campo-3"]);
      expect(info.pageObjects).toBe(9);
    });

    test("extraer y dividir descargan lo esperado sin tocar el documento; abrir como nuevo reemplaza el documento", async ({ page }) => {
      const bytes = Buffer.from(await makeRichPdf({ pages: 6, title: "Libro", form: true, outline: true }));
      await openProWith(page, env, bytes, "libro.pdf");

      // Extraer 2 paginas.
      await pickOnly(page, 2);
      await pickAdd(page, env, 5);
      await viaMore(page, P.actions.extract);
      const extractSheet = page.getByRole("dialog").last();
      const extracted = await downloadFile(page, async () => {
        await extractSheet.getByRole("button", { name: P.sheets.extractDownload }).click();
      });
      expect(extracted.filename).toBe("libro-extraido.pdf");
      const part = await inspectPdf(new Uint8Array(extracted.bytes));
      expect(part.markers).toEqual([marker(1), marker(4)]);
      expect(part.title).toBe("Libro");
      expect(part.fieldNames.sort()).toEqual(["campo-2", "campo-5"]);
      await expect(chip(page)).toHaveText(P.status.noChanges);

      // Dividir por rangos.
      await viaMore(page, P.actions.split);
      const split = page.getByRole("dialog").last();
      await split.getByLabel(P.sheets.splitRangesLabel).fill("1-2, 3, 4-6");
      await expect(split.getByText(/Se crearán 3 archivos/)).toBeVisible();
      const zipped = await downloadFile(page, async () => {
        await split.getByRole("button", { name: P.sheets.splitSubmit }).click();
      });
      expect(zipped.filename).toBe("libro-dividido.zip");
      const zip = await JSZip.loadAsync(zipped.bytes);
      expect(Object.keys(zip.files).sort()).toEqual(["libro-1-2.pdf", "libro-3.pdf", "libro-4-6.pdf"]);
      const last = await PDFDocument.load(await zip.files["libro-4-6.pdf"].async("uint8array"));
      expect(last.getPageCount()).toBe(3);

      // Abrir lo extraido como documento nuevo (pide confirmacion).
      await pickOnly(page, 3);
      await viaMore(page, P.actions.extract);
      const again = page.getByRole("dialog").last();
      await again.getByRole("button", { name: P.sheets.extractOpen }).click();
      await page.getByRole("button", { name: P.sheets.extractOpenConfirm }).click();
      // En movil la hoja del panel sigue abierta y el organizador ya muestra el documento nuevo.
      await expect(cards(page)).toHaveCount(1);
      await closePanel(page, env);
      await expect(page.getByRole("heading", { level: 1, name: /libro-extraido\.pdf/ })).toBeVisible();
    });

    test("teclado: Tab entra en la cuadricula, flechas/Espacio/Supr/R/D y Ctrl+Mayús+flechas; el foco nunca cae en <body>", async ({ page }) => {
      test.skip(viewport.mobile, "los atajos de teclado se prueban en escritorio");
      const bytes = Buffer.from(await makeRichPdf({ pages: 6 }));
      await openProWith(page, env, bytes);
      await cardAt(page, 1).focus();
      await expect(cardAt(page, 1)).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(cardAt(page, 2)).toBeFocused();
      await page.keyboard.press("Space");
      await expect(cardAt(page, 2)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Control+Shift+ArrowRight");
      expect(await originals(page, 6)).toEqual([1, 3, 2, 4, 5, 6]);
      await page.keyboard.press("r");
      await expect(cardAt(page, 3)).toContainText("90°");
      await page.keyboard.press("d");
      await expect(cards(page)).toHaveCount(7);
      await page.keyboard.press("Delete");
      await expect(cards(page)).toHaveCount(6);
      await focusNotBody(page);
      // Ctrl+Z deshace dentro del organizador y no toca el historial del documento.
      await page.keyboard.press("Control+z");
      await expect(cards(page)).toHaveCount(7);
      await page.keyboard.press("Control+Shift+z");
      await expect(cards(page)).toHaveCount(6);
      await page.keyboard.press("Control+a");
      await expect(chip(page)).toContainText("cambio");
      await expect(page.locator("[data-pages-selection]")).toContainText("6 de 6");
    });

    test("accesibilidad: axe sin violaciones en la pestaña, sin desbordes, y objetivos táctiles de 44 px", async ({ page }) => {
      const bytes = Buffer.from(await makeRichPdf({ pages: 10 }));
      await openProWith(page, env, bytes);
      await cardAt(page, 2).click();
      await page.addScriptTag({ path: AXE_PATH });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe;
        const result = await axe.run("[data-pages-tab]", {
          runOnly: ["color-contrast", "aria-valid-attr-value", "label", "button-name", "aria-required-attr", "aria-allowed-attr", "aria-roles", "aria-required-children", "aria-required-parent"],
        });
        return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(" | ")}`);
      });
      expect(violations).toEqual([]);
      await noHorizontalOverflow(page);
      if (viewport.mobile) {
        const buttons = page.locator("[data-pages-toolbar] button");
        const count = await buttons.count();
        expect(count).toBeGreaterThan(5);
        for (let i = 0; i < count; i += 1) {
          const ok = await buttons.nth(i).evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // La zona de toque (pseudo-elemento de 44 px) tiene que llegar a este control.
            return [cy - 21, cy + 21].every((y) => {
              const hit = document.elementFromPoint(cx, y);
              return hit !== null && (hit === el || el.contains(hit));
            });
          });
          expect(ok, `objetivo tactil del boton ${i}`).toBe(true);
        }
      }
    });

    test("con forced-colors la seleccion sigue distinguiéndose (borde grueso del sistema)", async ({ page }) => {
      const bytes = Buffer.from(await makeRichPdf({ pages: 4 }));
      await openProWith(page, env, bytes);
      await page.emulateMedia({ forcedColors: "active" });
      await cardAt(page, 2).click();
      const widths = await cards(page).evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopWidth));
      expect(widths[1]).toBe("3px");
      expect(widths[0]).toBe("1px");
    });

    test("modo oscuro: contraste AA en las tarjetas y los botones", async ({ page }) => {
      const bytes = Buffer.from(await makeRichPdf({ pages: 4 }));
      await page.emulateMedia({ colorScheme: "dark" });
      await openProWith(page, env, bytes);
      await cardAt(page, 1).click();
      await page.addScriptTag({ path: AXE_PATH });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe;
        const result = await axe.run("[data-pages-tab]", { runOnly: ["color-contrast"] });
        return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 100)).join(" | ")}`);
      });
      expect(violations).toEqual([]);
    });

    test("60 paginas: se pintan unas decenas, se desplaza hasta el final y se reordena la ultima", async ({ page }) => {
      const bytes = await makePdf({ pages: 60, label: "SESENTA" });
      await openProWith(page, env, bytes);
      expect(await cards(page).count()).toBeLessThan(40);
      const scroller = grid(page);
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
      await expect(cardAt(page, 60)).toBeVisible();
      expect(await cards(page).count()).toBeLessThan(40);
      await cardAt(page, 60).click();
      for (let i = 0; i < 3; i += 1) await button(page, P.actions.moveBefore).click();
      await expect(chip(page)).toHaveText(P.status.changes(3));
      await button(page, P.status.apply).click();
      await expect(chip(page)).toHaveText(P.status.noChanges);
      const out = await PDFDocument.load(await downloadCurrent(page, env));
      expect(out.getPageCount()).toBe(60);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 500 paginas
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · Páginas · 500 páginas", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "es-ES" });

  test("fluido con 500 paginas: DOM acotado, seleccionar pares, eliminar y aplicar sin perder ninguna impar", async ({ page }) => {
    const bytes = await makePdf({ pages: 500, label: "QUINIENTAS" });
    const env: Env = { mobile: false };
    await openProWith(page, env, bytes);
    await expect(cards(page).first()).toBeVisible();
    expect(await cards(page).count()).toBeLessThan(60);

    // Desplazamiento continuo: el DOM no crece y el hilo principal no se bloquea.
    const frames = await page.evaluate(async () => {
      const scroller = document.querySelector("[data-pages-grid]") as HTMLElement;
      const gaps: number[] = [];
      let last = performance.now();
      const total = scroller.scrollHeight - scroller.clientHeight;
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const step = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          const progress = Math.min(1, (now - start) / 2500);
          scroller.scrollTop = total * progress;
          if (progress < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      gaps.sort((a, b) => a - b);
      return { frames: gaps.length, p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps[gaps.length - 1], rendered: document.querySelectorAll("[data-page-id]").length };
    });
    test.info().annotations.push({ type: "scroll-500", description: JSON.stringify(frames) });
    expect(frames.rendered).toBeLessThan(80);
    expect(frames.p95, "p95 de la duracion de un cuadro al desplazar 500 paginas (ms)").toBeLessThan(80);
    await expect(cardAt(page, 500)).toBeVisible();

    // Seleccion de pares, eliminar y aplicar.
    await button(page, P.actions.more).click();
    await page.getByRole("dialog").last().getByRole("button", { name: P.actions.selectEven, exact: true }).click();
    await expect(page.locator("[data-pages-selection]")).toContainText("250 de 500");
    await button(page, P.actions.remove).click();
    await expect(page.locator("[data-pages-selection]")).toContainText(P.status.none);
    expect(await originals(page, 6)).toEqual([1, 3, 5, 7, 9, 11]);
    const started = Date.now();
    await button(page, P.status.apply).click();
    await expect(chip(page)).toHaveText(P.status.noChanges, { timeout: 60_000 });
    const applyMs = Date.now() - started;
    test.info().annotations.push({ type: "apply-500", description: `${applyMs} ms` });
    const result = await PDFDocument.load(await downloadCurrent(page, env));
    expect(result.getPageCount()).toBe(250);
    await focusNotBody(page);
  });

  test("500 paginas: arrastrar la ultima al principio con el raton", async ({ page }) => {
    const bytes = await makePdf({ pages: 500, label: "QUI" });
    await openProWith(page, { mobile: false }, bytes);
    await page.locator("[data-pages-grid]").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
    });
    await cardAt(page, 500).click();
    // 499 desplazamientos de a uno serian demasiados: se arrastra y se sube con la rueda sin soltar.
    const a = (await cardAt(page, 500).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 - 20, { steps: 4 });
    await page.mouse.wheel(0, -400_000);
    await expect
      .poll(() => page.locator("[data-pages-grid]").evaluate((el) => el.scrollTop), { timeout: 10_000, intervals: [100] })
      .toBeLessThan(5);
    const box = (await page.locator("[data-pages-grid]").boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 130, { steps: 6 });
    await page.mouse.up();
    await expect(chip(page)).toHaveText(P.status.changes(1));
    await expect(cardAt(page, 1)).toContainText(P.card.original(500));
  });
});

/* ------------------------------------------------------------------ *
 * Casos que no dependen del viewport
 * ------------------------------------------------------------------ */

test.describe("PDF Pro · Páginas · casos", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "es-ES" });
  const env: Env = { mobile: false };

  test("eliminar paginas con marcador avisa de lo que se quita y los marcadores restantes siguen apuntando bien", async ({ page }) => {
    const bytes = Buffer.from(await makeRichPdf({ pages: 6, outline: true, links: true, pageLabels: true }));
    await openProWith(page, env, bytes);
    await pickOnly(page, 2);
    await button(page, P.actions.remove).click();
    await button(page, P.status.apply).click();
    const notices = page.getByRole("region", { name: P.status.warningsTitle });
    await expect(notices).toBeVisible();
    await expect(notices).toContainText("marcadores");
    await expect(notices).toContainText("numeración");
    const info = await inspectPdf(new Uint8Array(await downloadCurrent(page, env)));
    expect(info.outlineTitles).toEqual(["Capitulo 1", "Capitulo 3", "Capitulo 4", "Capitulo 5", "Capitulo 6"]);
    expect(info.outlineTargets).toEqual([0, 1, 2, 3, 4]);
    expect(info.hasPageLabels).toBe(false);
  });

  test("un PDF cifrado al insertar pide contraseña y un archivo roto se explica", async ({ page }) => {
    await openProWith(page, env, Buffer.from(await makeRichPdf({ pages: 2 })));
    const encrypted = await makePdf({ pages: 2, label: "CIF", userPassword: "secreto" });
    await page.locator('[data-pages-input="pdf"]').setInputFiles({ name: "cifrado.pdf", mimeType: "application/pdf", buffer: encrypted });
    await page.getByLabel("Contraseña", { exact: true }).fill("secreto");
    await page.getByRole("button", { name: "Abrir documento" }).click();
    const sheet = page.getByRole("dialog").last();
    await expect(sheet.getByRole("option")).toHaveCount(2);
    await sheet.getByRole("button", { name: P.sheets.close }).click();
    await page.locator('[data-pages-input="pdf"]').setInputFiles({ name: "roto.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nno es un pdf de verdad") });
    const broken = page.getByRole("dialog").last();
    await expect(broken.getByText(es.tool.errors.corrupt)).toBeVisible();
    await expect(broken.getByRole("option")).toHaveCount(0);
  });

  test("una imagen real (PNG de ruido) se inserta como pagina A4", async ({ page }) => {
    await openProWith(page, env, Buffer.from(await makeRichPdf({ pages: 2 })));
    await page.locator('[data-pages-input="images"]').setInputFiles({
      name: "ruido.png",
      mimeType: "image/png",
      buffer: makeImage("png", 120, 80, 3),
    });
    const sheet = page.getByRole("dialog").last();
    await sheet.getByRole("button", { name: P.sheets.imagesSubmit(1) }).click();
    await button(page, P.status.apply).click();
    await expect(chip(page)).toHaveText(P.status.noChanges, { timeout: 30_000 });
    const info = await inspectPdf(new Uint8Array(await downloadCurrent(page, env)));
    expect(info.pageCount).toBe(3);
    // Imagen apaisada en A4 con orientacion automatica: pagina apaisada.
    expect(info.widths[2]).toBeCloseTo(841.89, 1);
  });

  test("al volver a la pestaña los cambios sin aplicar siguen ahi, y se pueden descartar", async ({ page }) => {
    await openProWith(page, env, Buffer.from(await makeRichPdf({ pages: 4 })));
    await cardAt(page, 2).click();
    await button(page, P.actions.remove).click();
    await expect(chip(page)).toHaveText(P.status.changes(1));
    await page.getByRole("tab", { name: S.suite.tabs.home }).click();
    await page.getByRole("tab", { name: S.suite.tabs.pages }).click();
    await expect(chip(page)).toHaveText(P.status.changes(1));
    await expect(cards(page)).toHaveCount(3);
    await button(page, P.status.discard).click();
    await page.getByRole("button", { name: P.status.discardConfirm, exact: true }).click();
    await expect(cards(page)).toHaveCount(4);
    await expect(chip(page)).toHaveText(P.status.noChanges);
  });

  test("deshacer global (barra del documento) con cambios sin aplicar descarta el plan y avisa", async ({ page }) => {
    await openProWith(page, env, Buffer.from(await makeRichPdf({ pages: 4 })));
    // Un primer snapshot (girar todas) para que haya algo que deshacer en el documento.
    await cardAt(page, 1).click();
    await button(page, P.actions.rotateRight).click();
    await button(page, P.status.apply).click();
    await expect(chip(page)).toHaveText(P.status.noChanges);
    await cardAt(page, 2).click();
    await button(page, P.actions.remove).click();
    await expect(cards(page)).toHaveCount(3);
    await topBar(page).getByRole("button", { name: S.suite.undo }).click();
    await expect(cards(page)).toHaveCount(4);
    await expect(chip(page)).toHaveText(P.status.noChanges);
  });
});
