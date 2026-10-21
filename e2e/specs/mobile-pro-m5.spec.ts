import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { MODE_STRINGS } from "../../src/app/pdf-pro/modes/modeStrings";
import { noHorizontalOverflow, openProDoc, openTab, touchDrag, visibleSheetHeight } from "../helpers/mobile-pro";
import { setSafeArea } from "../helpers/touch-gestures";
import { minGapBetweenControls } from "../helpers/touch-measure";

/**
 * M5 · correcciones tras la verificacion independiente movil/iPad (PDF Pro): N1 (Aplicar tapado por Descargar con zona segura),
 * N2 (la hoja con las herramientas abiertas y plegadas; elegir una herramienta pliega la bandeja), N3 (dock a 320 px), N4 («Editando»
 * recortado), VI-05 (asas de 12 px), VI-07 (botones contiguos) y GE-01 (descubribilidad de «Desplazar» y dos dedos).
 * Los gestos reales usan CDP (`Input.dispatchTouchEvent`, solo Chromium); lo demas mide el DOM y corre en cualquier motor. Headless.
 */
const S = PRO_STRINGS.es;
const M = MODE_STRINGS.es;
test.setTimeout(120_000);

const EDITORS = ["edit", "annotate"] as const;
const isChromiumPage = (page: Page) => page.context().browser()?.browserType().name() === "chromium";

async function cdpFor(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** El editor ya pinto la hoja del modo. */
async function openMode(page: Page, mode: (typeof EDITORS)[number]): Promise<void> {
  await openProDoc(page, { pages: 3 });
  await openTab(page, mode);
  await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
  await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

const toggle = (page: Page): Locator => page.locator("[data-pro-fold-toggle]");

async function isTrayOpen(page: Page): Promise<boolean> {
  return (await toggle(page).getAttribute("aria-expanded")) === "true";
}

/** Deja la bandeja de herramientas en el estado pedido con el boton de la barra del modo. */
async function setTray(page: Page, open: boolean): Promise<void> {
  if ((await isTrayOpen(page)) !== open) await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", open ? "true" : "false");
  await page.waitForTimeout(250);
}

/** Alto (px) de la region con desplazamiento del editor (el reparto del alto, sin lo que flota encima). */
async function scrollAreaHeight(page: Page): Promise<number> {
  return Math.round((await page.locator("[data-edit-scroll]").boundingBox())!.height);
}

/** Elige una herramienta: si la paleta esta en la bandeja y esta cerrada, la abre antes. */
async function pickTool(page: Page, id: string): Promise<void> {
  const item = page.locator(`[data-palette-item="${id}"]`);
  if (!(await item.isVisible())) await setTray(page, true);
  await item.click();
}

/* ------------------------------------------------------------------ *
 * N1 · «Aplicar» ya no queda tapado por «Descargar» (zona segura de un iPhone horizontal)
 * ------------------------------------------------------------------ */
const LANDSCAPE = [
  { name: "iPhone horizontal 852×393 (zona segura 59 px)", width: 852, height: 393, inset: 59 },
  { name: "iPhone Pro Max horizontal 932×430 (zona segura 59 px)", width: 932, height: 430, inset: 59 },
  { name: "iPhone mini/X horizontal 812×375 (zona segura 47 px)", width: 812, height: 375, inset: 47 },
  { name: "móvil apaisado 800×360 (zona segura 44 px)", width: 800, height: 360, inset: 44 },
  { name: "iPhone SE horizontal 667×375 (sin zona segura)", width: 667, height: 375, inset: 0 },
  { name: "iPhone 5/SE 1.ª gen horizontal 568×320 (sin zona segura)", width: 568, height: 320, inset: 0 },
  // Ancho FORZADO (700 con 59 de zona segura por lado: no cabe todo): lo que no cabe se sale por la derecha, pero nunca se pisa.
  { name: "ventana estrecha 700×360 (zona segura 59 px, no cabe todo)", width: 700, height: 360, inset: 59, tight: true },
] as const;

for (const profile of LANDSCAPE) {
  test.describe(`N1 · cabecera con la barra del modo · ${profile.name}`, () => {
    test.use({ viewport: { width: profile.width, height: profile.height }, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editar" : "Anotar"}: ningún control de la cabecera se pisa con otro y todos quedan dentro de la zona segura`, async ({ page }) => {
        test.skip(!isChromiumPage(page), "`Emulation.setSafeAreaInsetsOverride` solo existe en Chromium");
        await setSafeArea(await cdpFor(page), { left: profile.inset, right: profile.inset, bottom: 21 });
        await openMode(page, mode);
        const report = await page.evaluate(
          ({ inset, width }) => {
            const controls = Array.from(document.querySelectorAll<HTMLElement>('[data-pro-region="top"] button, [data-pro-region="top"] [role="switch"]'))
              .map((element) => ({ element, box: element.getBoundingClientRect() }))
              .filter((item) => item.box.width > 6 && item.box.height > 6 && getComputedStyle(item.element).visibility !== "hidden");
            const name = (element: HTMLElement) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 20);
            const overlaps: string[] = [];
            for (let i = 0; i < controls.length; i += 1) {
              for (let j = i + 1; j < controls.length; j += 1) {
                const a = controls[i].box;
                const b = controls[j].box;
                const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (ox > 1 && oy > 1) overlaps.push(`${name(controls[i].element)} × ${name(controls[j].element)} (${Math.round(ox)}×${Math.round(oy)})`);
              }
            }
            const outside = controls.filter((item) => item.box.left < inset - 1 || item.box.right > width - inset + 1).map((item) => name(item.element));
            const apply = document.querySelector<HTMLElement>("[data-pro-mode-apply]")!;
            const at = apply.getBoundingClientRect();
            const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
            const hitRight = document.elementFromPoint(at.right - 4, at.top + at.height / 2);
            return {
              count: controls.length,
              overlaps,
              outside,
              applyHit: !!hit && apply.contains(hit),
              applyRightHit: !!hitRight && apply.contains(hitRight),
            };
          },
          { inset: profile.inset, width: profile.width },
        );
        expect(report.count, "la cabecera pinta sus controles").toBeGreaterThan(4);
        expect(report.overlaps, "controles de la cabecera que se pisan").toEqual([]);
        if (!("tight" in profile)) expect(report.outside, "controles fuera de la zona segura").toEqual([]);
        expect(report.applyHit, "el centro de «Aplicar» es de «Aplicar»").toBe(true);
        expect(report.applyRightHit, "el borde derecho de «Aplicar» tambien (antes caia en «Descargar»)").toBe(true);
        await noHorizontalOverflow(page);
      });
    }
  });
}

test.describe("N1 · sin zona segura nada cambia y no hay botones muertos de deshacer/rehacer", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("con un modo abierto la cabecera del móvil no pinta el deshacer/rehacer global (apagados) y el escritorio sí", async ({ page }) => {
    await openMode(page, "edit");
    await expect(page.locator('[data-pro-region="top"]').getByRole("button", { name: S.suite.undo })).toHaveCount(0);
    await expect(page.locator('[data-pro-region="top"]').getByRole("button", { name: S.suite.redo })).toHaveCount(0);
    // El deshacer del MODO sigue en su paleta.
    await setTray(page, true);
    await expect(page.locator('[data-palette-item="undo"]')).toBeVisible();
  });
});

/* ------------------------------------------------------------------ *
 * N2 · la hoja con las herramientas abiertas, plegadas y tras elegir una
 * ------------------------------------------------------------------ */
const SHEET_PROFILES = [
  { name: "iPhone SE 320×568", width: 320, height: 568, minSheet: 300, landscape: false },
  { name: "iPhone SE 375×667", width: 375, height: 667, minSheet: 395, landscape: false },
  { name: "iPhone 15 Pro 393×852", width: 393, height: 852, minSheet: 500, landscape: false },
  { name: "iPhone horizontal 852×393", width: 852, height: 393, minSheet: 225, landscape: true },
  { name: "móvil apaisado 800×360", width: 800, height: 360, minSheet: 195, landscape: true },
] as const;

for (const profile of SHEET_PROFILES) {
  test.describe(`N2 · hoja y herramientas · ${profile.name}`, () => {
    test.use({ viewport: { width: profile.width, height: profile.height }, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      const label = mode === "edit" ? "Editar" : "Anotar";

      test(`${label}: abrir las herramientas no le quita alto a la hoja y elegir una las pliega`, async ({ page }) => {
        await openMode(page, mode);

        // Herramientas abiertas: la bandeja flota sobre la hoja, el reparto del alto es el mismo que plegada.
        await setTray(page, true);
        const open = await scrollAreaHeight(page);
        const tray = page.locator("[data-pro-tray]");
        await expect(tray).toBeVisible();
        const trayBox = (await tray.boundingBox())!;
        expect(trayBox.y, "la bandeja no se sale por arriba de la pantalla").toBeGreaterThanOrEqual(0);
        expect(trayBox.y + trayBox.height, "la bandeja queda sobre la barra del modo, dentro de la pantalla").toBeLessThanOrEqual(profile.height);
        await setTray(page, false);
        const folded = await scrollAreaHeight(page);
        expect(Math.abs(open - folded), `alto de la zona de la hoja abierta (${open}) y plegada (${folded})`).toBeLessThanOrEqual(1);
        expect(await visibleSheetHeight(page, mode), `hoja visible plegada en ${profile.name}`).toBeGreaterThanOrEqual(profile.minSheet);

        // Elegir una herramienta: la bandeja se pliega sola y el boton nombra la herramienta activa.
        await pickTool(page, mode === "edit" ? "text" : "rect");
        await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
        await expect(tray).toBeHidden();
        const name = mode === "edit" ? "Texto" : "Rectángulo";
        await expect(toggle(page)).toHaveAttribute("aria-label", new RegExp(`^${M.host.showToolsActive(".*").replace(/[()]/g, "\\$&")}$`));
        await expect(toggle(page)).toHaveAttribute("aria-label", new RegExp(name, "i"));
        await expect(toggle(page)).toHaveAttribute("data-tool-active", /.+/);
        expect(await visibleSheetHeight(page, mode), `hoja visible tras elegir una herramienta en ${profile.name}`).toBeGreaterThanOrEqual(profile.minSheet);
        await noHorizontalOverflow(page);

        // Cambiar de herramienta: un toque abre, otro elige (y vuelve a plegar).
        await toggle(page).click();
        await page.locator(`[data-palette-item="${mode === "edit" ? "rect" : "ellipse"}"]`).click();
        await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
      });
    }

    test("las ocho herramientas y deshacer/rehacer se alcanzan con el dedo (≥ 44 px) con las herramientas abiertas", async ({ page }) => {
      await openMode(page, "edit");
      await setTray(page, true);
      const items = page.locator("[data-tool-palette] [data-palette-item]");
      expect(await items.count()).toBeGreaterThanOrEqual(10);
      const small: string[] = [];
      const outside: string[] = [];
      for (let index = 0; index < (await items.count()); index += 1) {
        const item = items.nth(index);
        const box = await item.boundingBox();
        const id = (await item.getAttribute("data-palette-item")) ?? String(index);
        if (!box) continue;
        // Con la paleta en columna (horizontal) las ultimas filas se alcanzan desplazando su propia columna.
        if (box.width < 43.5 || box.height < 43.5) small.push(`${id} ${Math.round(box.width)}×${Math.round(box.height)}`);
        if (!profile.landscape && (box.y < 0 || box.y + box.height > profile.height)) outside.push(id);
      }
      expect(small, "botones de la paleta menores de 44 px").toEqual([]);
      expect(outside, "botones de la paleta fuera de la pantalla").toEqual([]);
    });
  });
}

test.describe("N2 · bandeja: teclado y barra del modo", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("Escape cierra la bandeja y devuelve el foco al botón de herramientas", async ({ page }) => {
    await openMode(page, "edit");
    await setTray(page, true);
    await page.locator('[data-tool-palette] [data-palette-item="select"]').focus();
    await page.keyboard.press("Escape");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-pro-fold-toggle") ?? false)).toBe(true);
  });

  test("abrir la bandeja con el botón lleva el foco a la herramienta activa (teclado)", async ({ page }) => {
    await openMode(page, "edit");
    await setTray(page, false);
    await toggle(page).focus();
    await page.keyboard.press("Enter");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-tool-palette]"))).toBe(true);
  });

  test("la barra del modo, la hoja y el dock no se desplazan al abrir y cerrar la bandeja", async ({ page }) => {
    await openMode(page, "annotate");
    const before = await page.locator("[data-pro-mode-bar]").boundingBox();
    await setTray(page, true);
    const during = await page.locator("[data-pro-mode-bar]").boundingBox();
    await setTray(page, false);
    expect(Math.round(during!.y), "la barra del modo no sube al abrir la bandeja").toBe(Math.round(before!.y));
    expect(await page.evaluate(() => window.scrollY), "la pagina no se desplaza").toBe(0);
  });
});

test.describe("N2 · la barra de zoom y páginas cabe en una fila a 320 px", () => {
  test.use({ viewport: { width: 320, height: 568 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("una sola fila y el total de páginas sigue en el nombre accesible", async ({ page }) => {
    await openMode(page, "edit");
    const nav = page.locator("[data-nav-embedded]");
    expect((await nav.boundingBox())!.height, "alto de la barra de zoom y páginas").toBeLessThan(60);
    await expect(nav.getByText(/Página 1 de 3/)).toBeAttached();
    await noHorizontalOverflow(page);
  });
});

/* ------------------------------------------------------------------ *
 * N3 · el dock a 320 px se desplaza y 375/393 caben las siete
 * ------------------------------------------------------------------ */
for (const language of ["es", "en"] as const) {
  for (const width of [320, 375, 393] as const) {
    test.describe(`N3 · dock · ${language.toUpperCase()} · ${width} px`, () => {
      test.use({ viewport: { width, height: 700 }, locale: language === "es" ? "es-ES" : "en-US", hasTouch: true, isMobile: true });

      test("celdas de al menos 44 px, etiquetas dentro de su celda y sin tocarse", async ({ page }) => {
        await openProDoc(page, { pages: 2 });
        const report = await page.locator("[data-pro-dock]").evaluate((dock) => {
          const cells = Array.from(dock.querySelectorAll<HTMLElement>("[data-dock]"));
          const rows = cells.map((cell) => {
            const box = cell.getBoundingClientRect();
            const label = cell.querySelector<HTMLElement>("span")!;
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            return { id: cell.dataset.dock ?? "", w: box.width, h: box.height, left: box.left, right: box.right, textLeft: text.left, textRight: text.right, text: label.textContent ?? "" };
          });
          const gaps = rows.slice(1).map((row, index) => ({ pair: `${rows[index].text} / ${row.text}`, gap: row.textLeft - rows[index].textRight }));
          return {
            scrolls: dock.scrollWidth > dock.clientWidth + 1,
            small: rows.filter((row) => row.w < 43.5 || row.h < 43.5).map((row) => `${row.text} ${Math.round(row.w)}×${Math.round(row.h)}`),
            clipped: rows.filter((row) => row.textLeft < row.left + 1 || row.textRight > row.right - 1).map((row) => row.text),
            gaps,
          };
        });
        expect(report.small, "celdas menores de 44 px").toEqual([]);
        expect(report.clipped, "etiquetas que se salen de su celda").toEqual([]);
        for (const item of report.gaps) expect(item.gap, `separación entre etiquetas ${item.pair}`).toBeGreaterThanOrEqual(6);
        if (width === 320) expect(report.scrolls, "a 320 px las siete celdas no caben: el dock se desplaza").toBe(true);
        else expect(report.scrolls, `a ${width} px las siete celdas caben sin desplazar`).toBe(false);
        await noHorizontalOverflow(page);
      });
    });
  }
}

test.describe("N3 · el dock a 320 px llega hasta la última celda", () => {
  test.use({ viewport: { width: 320, height: 568 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("desplazado al final, «Convertir» se ve entera y se puede pulsar", async ({ page }) => {
    await openProDoc(page, { pages: 2 });
    const dock = page.locator("[data-pro-dock]");
    await dock.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const last = page.locator('[data-dock="convert"]');
    const box = (await last.boundingBox())!;
    expect(box.x + box.width, "la última celda termina dentro de la pantalla").toBeLessThanOrEqual(320.5);
    await last.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

/* ------------------------------------------------------------------ *
 * N4 · «Editando» / «Anotando» se lee entero o no se pinta
 * ------------------------------------------------------------------ */
for (const width of [360, 375, 393, 430, 600] as const) {
  test.describe(`N4 · nombre del modo · ${width} px`, () => {
    test.use({ viewport: { width, height: 800 }, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editando" : "Anotando"}: ni «E…» ni «A…»`, async ({ page }) => {
        await openMode(page, mode);
        const name = page.locator("[data-pro-mode-name]");
        const info = await name.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { visible: box.width > 4 && box.height > 4, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, text: element.textContent ?? "" };
        });
        // O se ve entero, o el texto queda solo para lectores de pantalla (el dock ya marca la pestaña activa).
        if (info.visible) expect(info.scrollWidth, `«${info.text}» se ve recortado`).toBeLessThanOrEqual(info.clientWidth + 1);
        await expect(page.locator("[data-pro-mode-bar]")).toContainText(mode === "edit" ? "Editando" : "Anotando");
        await expect(page.locator(`[data-dock="${mode}"]`)).toHaveAttribute("aria-current", "page");
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * VI-05 · las asas de redimensionar se agarran con el dedo
 * ------------------------------------------------------------------ */
test.describe("VI-05 · asas de redimensionar", () => {
  test.describe("con el dedo (iPad Pro horizontal)", () => {
    test.use({ viewport: { width: 1194, height: 834 }, locale: "es-ES", hasTouch: true, isMobile: true });

    test("el área de agarre mide al menos 44 px de ancho y recibe el toque a 20 px de la línea", async ({ page }) => {
      await openProDoc(page, { pages: 3 });
      const handles = page.locator("[data-pro-resize]");
      await expect(handles.first()).toBeVisible();
      // El reparto de los paneles se asienta tras medir la fila: se espera a que el asa deje de moverse.
      await page.waitForTimeout(800);
      const report = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-pro-resize]")).map((handle) => {
          const box = handle.getBoundingClientRect();
          const label = handle.getAttribute("aria-label");
          const owner = (dx: number) => document.elementFromPoint(box.x + box.width / 2 + dx, box.y + box.height / 2)?.closest("[data-pro-resize]")?.getAttribute("aria-label") ?? null;
          return { label, width: box.width, left: owner(-20), right: owner(20) };
        }),
      );
      expect(report.length, "hay asas de redimensionar").toBeGreaterThan(0);
      for (const item of report) {
        expect(item.width, `ancho del área de agarre de «${item.label}»`).toBeGreaterThanOrEqual(44);
        expect(item.left, "el toque a 20 px a la izquierda de la línea llega al asa").toBe(item.label);
        expect(item.right, "el toque a 20 px a la derecha de la línea llega al asa").toBe(item.label);
      }
    });
  });

  test.describe("con ratón (escritorio)", () => {
    test.use({ viewport: { width: 1280, height: 800 }, locale: "es-ES" });

    test("el área de agarre mide al menos 24 px (antes 12)", async ({ page }) => {
      await openProDoc(page, { pages: 3 });
      const handles = page.locator("[data-pro-resize]");
      await expect(handles.first()).toBeVisible();
      for (let index = 0; index < (await handles.count()); index += 1) {
        expect((await handles.nth(index).boundingBox())!.width).toBeGreaterThanOrEqual(24);
      }
    });
  });
});

/* ------------------------------------------------------------------ *
 * VI-07 · ≥ 8 px entre botones contiguos con el dedo
 * ------------------------------------------------------------------ */
test.describe("VI-07 · botones contiguos de Editar y Páginas", () => {
  test.describe("iPad mini 744×1133", () => {
    test.use({ viewport: { width: 744, height: 1133 }, locale: "es-ES", hasTouch: true, isMobile: true });

    test("barra de zoom y páginas del editor: «Página siguiente» y «Miniaturas» ya no se tocan", async ({ page }) => {
      await openMode(page, "edit");
      const worst = await minGapBetweenControls(page, "[data-nav-embedded]");
      expect(worst === null || worst.gap >= 8, `separación mínima ${JSON.stringify(worst)}`).toBe(true);
      await setTray(page, true);
      const palette = await minGapBetweenControls(page, "[data-pro-tray] [data-tool-palette]");
      expect(palette === null || palette.gap >= 8, `paleta ${JSON.stringify(palette)}`).toBe(true);
    });

    test("barra de acciones de Páginas", async ({ page }) => {
      await openProDoc(page, { pages: 6 });
      await openTab(page, "pages");
      await expect(page.locator("[data-pages-toolbar]").first()).toBeVisible();
      await page.waitForTimeout(900);
      const worst = await minGapBetweenControls(page, "[data-pages-toolbar]");
      expect(worst === null || worst.gap >= 8, `separación mínima ${JSON.stringify(worst)}`).toBe(true);
    });
  });

  for (const width of [320, 393] as const) {
    test.describe(`iPhone ${width} px`, () => {
      test.use({ viewport: { width, height: width === 320 ? 568 : 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

      test("paleta (Deshacer/Rehacer incluidos) y barra de zoom del editor", async ({ page }) => {
        await openMode(page, "annotate");
        const nav = await minGapBetweenControls(page, "[data-nav-embedded]");
        expect(nav === null || nav.gap >= 8, `barra de zoom ${JSON.stringify(nav)}`).toBe(true);
        await setTray(page, true);
        const palette = await minGapBetweenControls(page, "[data-pro-tray] [data-tool-palette]");
        expect(palette === null || palette.gap >= 8, `paleta ${JSON.stringify(palette)}`).toBe(true);
      });
    });
  }
});

/* ------------------------------------------------------------------ *
 * GE-01 · «Desplazar» y dos dedos con una herramienta armada
 * ------------------------------------------------------------------ */
test.describe("GE-01 · descubribilidad del desplazamiento con una herramienta armada", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("«Desplazar» muestra su texto junto a la herramienta armada y el aviso sale UNA sola vez", async ({ page }) => {
    await openMode(page, "edit");
    const pan = page.getByRole("switch", { name: new RegExp(M.host.panLabel) });
    await expect(pan).toBeVisible();
    // Texto corto a la vista (no solo un icono).
    const label = await pan.locator("span").first().boundingBox();
    expect(label && label.width > 20, "el texto «Desplazar» se ve").toBe(true);
    await expect(page.locator("[data-pro-pan-first-hint]")).toHaveCount(0);

    await pickTool(page, "rect");
    const hint = page.locator("[data-pro-pan-first-hint]");
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(M.host.panFirstHint);
    // No bloquea los toques sobre la hoja ni tapa la barra del modo.
    expect(await hint.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    const hintBox = (await hint.boundingBox())!;
    const barBox = (await page.locator("[data-pro-mode-bar]").boundingBox())!;
    expect(hintBox.y + hintBox.height, "el aviso queda sobre la barra del modo").toBeLessThanOrEqual(barBox.y + 1);

    // Activar «Desplazar» lo retira; y en la siguiente visita (mismo navegador) no vuelve a salir.
    await pan.click();
    await expect(hint).toHaveCount(0);
    await openProDoc(page, { pages: 3, name: "otro.pdf" });
    await openTab(page, "edit");
    await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
    await pickTool(page, "rect");
    await page.waitForTimeout(400);
    await expect(page.locator("[data-pro-pan-first-hint]")).toHaveCount(0);
  });

  test("el aviso se anuncia por la región viva única de PDF Pro", async ({ page }) => {
    await openMode(page, "annotate");
    await pickTool(page, "rect");
    await expect(page.locator('[role="status"]').filter({ hasText: M.host.panFirstHint }).first()).toBeAttached();
  });

  test("con una herramienta armada dos dedos SIEMPRE desplazan la hoja (sin activar «Desplazar») y pellizcar hace zoom", async ({ page }) => {
    test.skip(!isChromiumPage(page), "el tacto real usa CDP (Input.dispatchTouchEvent), solo Chromium");
    await openMode(page, "edit");
    // Con zoom la hoja es mas alta que la zona: hay recorrido para desplazar.
    await page.getByRole("button", { name: /Acercar/ }).first().click();
    await page.getByRole("button", { name: /Acercar/ }).first().click();
    await page.waitForTimeout(400);
    await pickTool(page, "rect");
    const scroller = page.locator("[data-edit-scroll]");
    const area = (await scroller.boundingBox())!;
    const cdp = await cdpFor(page);
    const top = () => scroller.evaluate((element) => (element as HTMLElement).scrollTop);
    const at = { x: area.x + area.width / 2, y: area.y + area.height * 0.7 };

    // Un dedo (herramienta armada) NO desplaza: dibuja.
    const one = await top();
    await touchDrag(page, cdp, { x: at.x, y: at.y }, { x: at.x, y: at.y - 160 });
    await page.waitForTimeout(250);
    expect(Math.abs((await top()) - one), "un dedo con la herramienta armada no desplaza").toBeLessThan(5);

    // Dos dedos que suben a la vez: la hoja se desplaza.
    const before = await top();
    const fingers = (dy: number) => [
      { x: at.x - 40, y: at.y + dy, id: 1 },
      { x: at.x + 40, y: at.y + dy, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(0) });
    for (let step = 1; step <= 12; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(-14 * step) });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
    expect((await top()) - before, "dos dedos desplazan la hoja con la herramienta armada").toBeGreaterThan(60);

    // El pellizco hace zoom de la hoja (no de la pagina).
    const zoomText = () => page.locator("[data-nav-embedded]").getByText(/\d+ ?%/).first().textContent();
    const zoomBefore = Number.parseInt((await zoomText()) ?? "0", 10);
    const pinchAt = { x: at.x, y: area.y + area.height / 2 };
    const pinch = (distance: number) => [
      { x: pinchAt.x - distance / 2, y: pinchAt.y, id: 1 },
      { x: pinchAt.x + distance / 2, y: pinchAt.y, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pinch(80) });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pinch(80 - step * 5) });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
    const zoomAfter = Number.parseInt((await zoomText()) ?? "0", 10);
    expect(zoomAfter, "pellizcar hacia dentro aleja la hoja").toBeLessThan(zoomBefore);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1), "la página no se amplía").toBeCloseTo(1, 2);
  });
});
