import { expect, test, type Page } from "@playwright/test";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import {
  IPHONE_393,
  SE_375,
  isHittable,
  makeContract,
  multiWithTwoSigners,
  openPalette,
  openSign,
  pdfFile,
  tightButtonPairs,
  waitSheetReady,
  type MobileProfile,
} from "../helpers/mobile-sign";
import { noHorizontalOverflow, openProDoc, openTab, visibleSheetHeight } from "../helpers/mobile-pro";
import { cdpOf, scrollY, sheetPoint, touchDrag, touchTap, unfoldPalette, visibleBand } from "../helpers/touch-gestures";

/**
 * M4 · Integracion de las tres partes (lienzo compartido M3, PDF Pro M2, Firmar M1) en telefono e iPad.
 *  - Firmar DENTRO de PDF Pro (modo hospedado): la hoja se ve (antes 0-16 px a 375 y 393 px de ancho) y la paleta pliega.
 *  - El dock plegable de la paleta y «Continuar» pegado abajo no tapan la barra flotante del campo ni su tirador.
 *  - El dedo sigue desplazando la pagina con una herramienta armada, con la paleta plegada Y con ella abierta.
 *  - «Subir» / «Bajar» de la lista de archivos con separacion de dedo; la hoja «Opciones» no se queda sobre el editor.
 * Tactil, headless; PDF sinteticos. Los gestos de dedo por CDP son de Chromium; el resto corre tambien en `webkit-ipad`.
 */
test.setTimeout(180_000);
const SG = SIGN_STRINGS.es;

/** Hoja visible minima (px) de Firmar dentro de Pro, medida con `elementFromPoint` (nada que la tape cuenta). */
const PRO_SIGN_SHEET: ReadonlyArray<{ w: number; h: number; min: number }> = [
  { w: 375, h: 667, min: 280 },
  { w: 393, h: 852, min: 300 },
  { w: 744, h: 1133, min: 600 },
  { w: 834, h: 1194, min: 700 },
];

for (const size of PRO_SIGN_SHEET) {
  test.describe(`Firmar dentro de PDF Pro · ${size.w}x${size.h}`, () => {
    test.use({ viewport: { width: size.w, height: size.h }, locale: "es-ES", hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

    test(`la hoja visible mide al menos ${size.min} px y nada desborda`, async ({ page }) => {
      await openProDoc(page);
      await openTab(page, "sign");
      await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
      await expect(page.locator('[data-pro-mode-host] [data-canvas="host"] img').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(800);
      expect(await visibleSheetHeight(page, "sign"), "hoja visible de Firmar en Pro").toBeGreaterThanOrEqual(size.min);
      await noHorizontalOverflow(page);
    });

    test("«Aplicar», «Descartar» y el dock de Pro quedan a la vista y sin nada encima (ni el boton de la paleta)", async ({ page }) => {
      await openProDoc(page);
      await openTab(page, "sign");
      await expect(page.locator('[data-pro-mode-host] [data-canvas="host"] img').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(600);
      for (const selector of ["[data-pro-mode-apply]", "[data-pro-mode-discard]"]) {
        const control = page.locator(selector);
        await expect(control).toBeVisible();
        const hit = await isHittable(control);
        expect(hit.ok, `${selector}: ${hit.reason}`).toBe(true);
      }
      if (size.w < 768) {
        const dock = page.locator("[data-pro-dock]");
        for (const button of await dock.getByRole("button").all()) {
          const hit = await isHittable(button);
          expect(hit.ok, `dock de Pro: ${hit.reason}`).toBe(true);
        }
      }
    });
  });
}

test.describe("Firmar dentro de PDF Pro · paleta en el telefono (393x852)", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("con las herramientas visibles la paleta es un boton plegado que se abre y se vuelve a plegar al elegir", async ({ page }) => {
    await openProDoc(page);
    await openTab(page, "sign");
    await expect(page.locator('[data-pro-mode-host] [data-canvas="host"] img').first()).toBeVisible({ timeout: 30_000 });
    const fab = page.locator("[data-palette-fab]");
    await expect(fab).toBeVisible();
    // El boton esta anclado dentro de la region de Firmar (no flota sobre la barra del modo ni sobre el dock de Pro).
    const inside = await fab.evaluate((el) => Boolean(el.closest("[data-pro-mode-scroll]")));
    expect(inside).toBe(true);
    const box = (await fab.boundingBox())!;
    const bar = (await page.locator("[data-pro-mode-bar]").first().boundingBox())!;
    expect(box.y + box.height, "no pisa la barra de «Aplicar»").toBeLessThanOrEqual(bar.y + 1);
    await fab.click();
    const toolbar = page.getByRole("toolbar", { name: SG.paletteLabel });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Texto", exact: true }).click();
    await expect(fab).toBeVisible();
    await expect(toolbar).toBeHidden();
  });

  test("un toque en el boton de la paleta la abre sin desplazar la hoja", async ({ page }) => {
    await openProDoc(page);
    await openTab(page, "sign");
    await expect(page.locator('[data-pro-mode-host] [data-canvas="host"] img').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    const region = () => page.locator("[data-pro-mode-scroll]").evaluate((el) => Math.round(el.scrollTop));
    const before = await region();
    const box = (await page.locator("[data-palette-fab]").boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole("toolbar", { name: SG.paletteLabel })).toBeVisible();
    await page.waitForTimeout(400);
    expect(Math.abs((await region()) - before), "la region no se movio").toBeLessThan(4);
  });

  test("«Ocultar herramientas» pliega tambien el boton de la paleta y «Mostrar» lo devuelve", async ({ page }) => {
    await openProDoc(page);
    await openTab(page, "sign");
    await expect(page.locator('[data-pro-mode-host] [data-canvas="host"] img').first()).toBeVisible({ timeout: 30_000 });
    const toggle = page.locator("[data-pro-fold-toggle]");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator("[data-pro-mode-host]")).toHaveAttribute("data-chrome", "collapsed");
    await expect(page.locator("[data-palette-fab]")).toBeHidden();
    await toggle.click();
    await expect(page.locator("[data-palette-fab]")).toBeVisible();
  });
});

/* ------------------------------------------------------------------ *
 * El dock plegable y «Continuar» no tapan la barra flotante del campo ni su tirador
 * ------------------------------------------------------------------ */

async function openDocumentStep(page: Page): Promise<void> {
  await openSign(page, [pdfFile(await makeContract("Contrato", 2))]);
  await multiWithTwoSigners(page);
  await page.getByRole("button", { name: "2. Documento" }).click();
  await waitSheetReady(page);
}

for (const profile of [SE_375, IPHONE_393] as MobileProfile[]) {
  test.describe(`Firmar · dock y «Continuar» · ${profile.label}`, () => {
    test.use(profile.use);

    test("un campo colocado justo sobre el dock: su barra flotante y su tirador siguen a la vista y sin nada encima", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "el toque se emula por CDP (Input.dispatchTouchEvent), solo Chromium");
      await openDocumentStep(page);
      await page.getByRole("radio", { name: "Ana", exact: true }).click();
      const toolbar = await openPalette(page);
      await toolbar.getByRole("button", { name: "Texto", exact: true }).click();
      await expect(page.locator("[data-palette-fab]")).toBeVisible();
      // «Continuar» pegado abajo (a la derecha) y el boton de la paleta (a la izquierda) comparten la franja de abajo.
      await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
      await page.evaluate(() => document.querySelector('[data-canvas="host"]')?.scrollIntoView({ block: "start" }));
      await page.evaluate(() => window.scrollBy(0, -80));
      await page.waitForTimeout(300);
      const cdp = await cdpOf(page);
      for (const fx of [0.5, 0.85]) {
        const band = await visibleBand(page);
        const at = await sheetPoint(page, fx, 0.5);
        // Se toca lo mas abajo posible de la zona visible: 44 px sobre el dock.
        await touchTap(cdp, { x: at.x, y: band.bottom - 44 });
        const field = page.locator('[data-element-kind="text"][data-drag-mode="move"]').last();
        await expect(field).toBeVisible();
        await page.keyboard.press("Escape");
        const bar = page.locator("[data-floating-bar]");
        await expect(bar).toBeVisible();
        await page.waitForTimeout(900);
        for (const button of await bar.getByRole("button").all()) {
          const hit = await isHittable(button);
          expect(hit.ok, `barra flotante (x ${fx}): ${hit.reason}`).toBe(true);
        }
        const handle = page.locator('[data-drag-mode="resize"]').last();
        if (await handle.isVisible().catch(() => false)) {
          const hit = await isHittable(handle);
          expect(hit.ok, `tirador (x ${fx}): ${hit.reason}`).toBe(true);
        }
        // El campo no queda DEBAJO del dock ni de las barras fijas.
        const after = await visibleBand(page);
        const box = (await field.boundingBox())!;
        expect(box.y + box.height, "el campo queda por encima de las capas fijas").toBeLessThanOrEqual(after.bottom + 1);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate(() => document.querySelector('[data-canvas="host"]')?.scrollIntoView({ block: "start" }));
        await page.evaluate(() => window.scrollBy(0, -80));
        await page.waitForTimeout(300);
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * El dedo sigue desplazando con la herramienta armada: paleta plegada y paleta abierta
 * ------------------------------------------------------------------ */

test.describe("Firmar · el dedo desplaza con una herramienta armada · 393x852", () => {
  test.use(IPHONE_393.use);

  for (const open of [false, true]) {
    test(`paleta ${open ? "ABIERTA" : "plegada"}: deslizar sobre la hoja desplaza la pagina y no crea nada`, async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "el dedo se emula por CDP (Input.dispatchTouchEvent), solo Chromium");
      await openSign(page, [pdfFile(await makeContract("Contrato", 3))]);
      await waitSheetReady(page);
      const toolbar = await openPalette(page);
      await toolbar.getByRole("button", { name: "Texto", exact: true }).click();
      if (open) await unfoldPalette(page);
      expect(await page.getByRole("toolbar", { name: SG.paletteLabel }).isVisible()).toBe(open);
      await page.evaluate(() => document.querySelector('[data-canvas="host"]')?.scrollIntoView({ block: "start" }));
      await page.evaluate(() => window.scrollBy(0, -60));
      await page.waitForTimeout(300);
      const cdp = await cdpOf(page);
      const from = await sheetPoint(page, 0.5, 0.35);
      const before = await scrollY(page);
      await touchDrag(cdp, from, { x: from.x, y: from.y - 160 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(500);
      expect((await scrollY(page)) - before, "la pagina se desplazo con el dedo").toBeGreaterThan(80);
      await expect(page.locator('[data-element-kind="text"][data-drag-mode="move"]')).toHaveCount(0);
      await expect(page.locator('[data-canvas="host"]').first()).toHaveAttribute("data-tool", "text");
    });
  }
});

/* ------------------------------------------------------------------ *
 * Lista de archivos y editor de plantillas
 * ------------------------------------------------------------------ */

test.describe("Firmar · lista de archivos · 393x852", () => {
  test.use(IPHONE_393.use);

  test("«Subir» y «Bajar» miden 44 px y quedan a 8 px o mas entre si y del resto", async ({ page }) => {
    await openSign(page, [
      pdfFile(await makeContract("Uno"), "uno.pdf"),
      pdfFile(await makeContract("Dos"), "dos.pdf"),
    ]);
    const up = page.getByRole("button", { name: "Subir", exact: true });
    const down = page.getByRole("button", { name: "Bajar", exact: true });
    await expect(down.first()).toBeVisible();
    for (const button of [...(await up.all()), ...(await down.all())]) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
    const tight = (await tightButtonPairs(page, "main")).filter((pair) => /Subir|Bajar|Quitar/.test(pair));
    expect(tight, tight.join("\n")).toEqual([]);
  });
});

test.describe("Firmar · editor de plantillas en el telefono · 393x852", () => {
  test.use(IPHONE_393.use);

  test("abrir el editor desde «Opciones» cierra la hoja «Opciones» (no se queda encima)", async ({ page }) => {
    await openSign(page, [pdfFile(await makeContract("Contrato", 1))]);
    await multiWithTwoSigners(page);
    await page.getByRole("button", { name: "Opciones", exact: true }).first().click();
    const options = page.getByRole("dialog", { name: "Opciones" });
    await expect(options).toBeVisible();
    await options.getByRole("button", { name: /plantilla de este documento/ }).click();
    await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog", { name: "Opciones" })).toHaveCount(0);
  });
});
