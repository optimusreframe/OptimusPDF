import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { MODE_STRINGS } from "../../src/app/pdf-pro/modes/modeStrings";
import { noHorizontalOverflow, openProDoc, openTab, visibleSheetHeight } from "../helpers/mobile-pro";
import { setSafeArea } from "../helpers/touch-gestures";
import { minGapBetweenControls } from "../helpers/touch-measure";

/**
 * M6 · cierre de movil/iPad tras la segunda verificacion independiente (docs/VERIFICACION-MOVIL-IPAD-2.md): H1 (la barra del modo
 * de Editar/Anotar a 428-440 px y en todo el rango de telefonos), H2 (700×360 con zona segura), H3 (ancho de la hoja estable),
 * N4 («Editando» recortado entre 480 y 530 px), VI-07 (paleta de tablet) y la usabilidad de editar con el dedo: deshacer/rehacer
 * siempre a la vista, bandeja compacta, «Inicio»/idioma dentro del modo en horizontal, texto de 16 px, zoom legible y avisos que
 * no tapan la hoja. Headless; los gestos con dedo real (CDP) solo en Chromium.
 */
test.setTimeout(150_000);

const EDITORS = ["edit", "annotate"] as const;
type Mode = (typeof EDITORS)[number];
const isChromiumPage = (page: Page) => page.context().browser()?.browserType().name() === "chromium";
const cdpFor = (page: Page): Promise<CDPSession> => page.context().newCDPSession(page);
const MS = { es: MODE_STRINGS.es, en: MODE_STRINGS.en } as const;

async function openMode(page: Page, mode: Mode, pages = 3): Promise<void> {
  await openProDoc(page, { pages });
  await openTab(page, mode);
  await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
  await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

const toggle = (page: Page) => page.locator("[data-pro-fold-toggle]");

async function setTray(page: Page, open: boolean): Promise<void> {
  if (((await toggle(page).getAttribute("aria-expanded")) === "true") !== open) await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", open ? "true" : "false");
  await page.waitForTimeout(250);
}

async function pickTool(page: Page, id: string): Promise<void> {
  const item = page.locator(`[data-palette-item="${id}"]`);
  if (!(await item.isVisible())) await setTray(page, true);
  await item.click();
}

/** Mide la barra del modo: dentro de la pantalla, sin solapes, objetivos, separacion y toques que llegan. */
async function barReport(page: Page, insetLeft: number, insetRight: number) {
  return page.evaluate(
    ({ insetLeft, insetRight }) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bar = document.querySelector<HTMLElement>("[data-pro-mode-bar]")!;
      const visible = (element: Element) => {
        const box = element.getBoundingClientRect();
        const cs = getComputedStyle(element);
        return box.width > 6 && box.height > 6 && cs.visibility !== "hidden" && cs.display !== "none" && !element.closest(".sr-only");
      };
      const name = (element: Element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28);
      const controls = Array.from(bar.querySelectorAll<HTMLElement>("button, [role='switch']")).filter(visible);
      const rows = controls.map((element) => {
        const box = element.getBoundingClientRect();
        // Centro y los dos bordes a media altura (las esquinas de un boton redondo no son del boton).
        const probes = [
          [box.left + box.width / 2, box.top + box.height / 2],
          [box.left + 3, box.top + box.height / 2],
          [box.right - 3, box.top + box.height / 2],
        ];
        const reach = probes.every(([x, y]) => {
          const top = document.elementFromPoint(Math.min(vw - 1, Math.max(0, x)), Math.min(vh - 1, Math.max(0, y)));
          return !!top && (element === top || element.contains(top));
        });
        // El icono de un boton redondo o de icono no se aplasta (relleno + icono mayores que la caja dejaban un punto de 4 px).
        const icon = element.querySelector("svg")?.getBoundingClientRect();
        return { name: name(element), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, reach, iconW: icon?.width ?? 16, iconH: icon?.height ?? 16 };
      });
      const gaps: string[] = [];
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const a = rows[i];
          const b = rows[j];
          const overlapV = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          const gap = Math.max(b.left - a.right, a.left - b.right);
          if (overlapV > 8 && gap < 7.5) gaps.push(`${a.name} | ${b.name}: ${Math.round(gap * 10) / 10}`);
        }
      }
      const apply = bar.querySelector<HTMLElement>("[data-pro-mode-apply]")!;
      const discard = bar.querySelector<HTMLElement>("[data-pro-mode-discard]")!;
      return {
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rows,
        outside: rows.filter((row) => row.left < insetLeft - 0.5 || row.right > vw - insetRight + 0.5 || row.top < -0.5 || row.bottom > vh + 0.5).map((row) => `${row.name} [${Math.round(row.left)}..${Math.round(row.right)}]`),
        gaps,
        unreachable: rows.filter((row) => !row.reach).map((row) => row.name),
        squashed: rows.filter((row) => row.iconW < 12 || row.iconH < 12).map((row) => `${row.name} icono ${Math.round(row.iconW)}×${Math.round(row.iconH)}`),
        tiny: rows.filter((row) => row.width < 43.5 || row.height < 43.5).map((row) => `${row.name} ${Math.round(row.width)}×${Math.round(row.height)}`),
        applyName: apply.getAttribute("aria-label") ?? apply.textContent?.trim(),
        discardName: discard.getAttribute("aria-label") ?? discard.textContent?.trim(),
        applyBox: apply.getBoundingClientRect().toJSON(),
        discardBox: discard.getBoundingClientRect().toJSON(),
        vw,
      };
    },
    { insetLeft, insetRight },
  );
}

/* ------------------------------------------------------------------ *
 * H1 · la barra del modo se adapta de 320 a 744 px: «Aplicar» y «Descartar» nunca quedan cortados ni tapados
 * ------------------------------------------------------------------ */
const PORTRAIT_WIDTHS = [
  { width: 320, height: 568 },
  { width: 360, height: 740 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 393, height: 852 },
  { width: 412, height: 915 },
  { width: 428, height: 926 },
  { width: 430, height: 932 },
  { width: 440, height: 956 },
  { width: 744, height: 1133 },
] as const;

for (const size of PORTRAIT_WIDTHS) {
  for (const language of ["es", "en"] as const) {
    // Español en todos los anchos y mode; inglés (otro texto en los botones) en los que el informe midió.
    if (language === "en" && ![320, 375, 393, 430, 440].includes(size.width)) continue;
    test.describe(`H1 · barra del modo · ${size.width}×${size.height} · ${language.toUpperCase()}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, locale: language === "es" ? "es-ES" : "en-US", hasTouch: true, isMobile: true });

      for (const mode of EDITORS) {
        test(`${mode === "edit" ? "Editar" : "Anotar"}: sin desborde, «Aplicar» y «Descartar» enteros, a 44 px y sin tapar`, async ({ page }) => {
          await openMode(page, mode);
          const report = await barReport(page, 0, 0);
          expect(report.docOverflow, "el documento no se desborda a la derecha").toBeLessThanOrEqual(0);
          expect(report.outside, "controles de la barra fuera de la pantalla").toEqual([]);
          expect(report.unreachable, "controles de la barra tapados por otro elemento").toEqual([]);
          expect(report.squashed, "iconos de la barra aplastados").toEqual([]);
          expect(report.tiny, "objetivos de la barra menores de 44 px").toEqual([]);
          expect(report.gaps, "controles contiguos a menos de 8 px").toEqual([]);
          expect(report.applyName).toBe(MS[language].host.apply);
          expect(report.discardName).toBe(MS[language].host.discard);
          expect(report.applyBox.right, "«Aplicar» termina dentro de la pantalla").toBeLessThanOrEqual(size.width - 4);
          // Y pegado al borde derecho (a 8 px, como el resto de la barra): el hueco sobrante queda entre la izquierda y la derecha, no a la derecha.
          expect(report.applyBox.right, "«Aplicar» pegado al borde derecho de la barra").toBeGreaterThanOrEqual(size.width - 16);
          expect(report.discardBox.left, "«Descartar» empieza dentro de la pantalla").toBeGreaterThanOrEqual(4);
          await noHorizontalOverflow(page);
        });
      }
    });
  }
}

const LANDSCAPE_BARS = [
  { name: "iPhone 5/SE 1.ª gen 568×320", width: 568, height: 320, inset: 0 },
  { name: "iPhone SE 667×375", width: 667, height: 375, inset: 0 },
  { name: "ventana estrecha 700×360 (zona segura 59 px)", width: 700, height: 360, inset: 59 },
  { name: "móvil apaisado 800×360 (zona segura 44 px)", width: 800, height: 360, inset: 44 },
  { name: "iPhone 812×375 (zona segura 47 px)", width: 812, height: 375, inset: 47 },
  { name: "iPhone 15 Pro 852×393 (zona segura 59 px)", width: 852, height: 393, inset: 59 },
  { name: "iPhone Pro Max 932×430 (zona segura 59 px)", width: 932, height: 430, inset: 59 },
] as const;

for (const profile of LANDSCAPE_BARS) {
  test.describe(`H1/H2 · barra del modo en la cabecera · ${profile.name}`, () => {
    test.use({ viewport: { width: profile.width, height: profile.height }, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editar" : "Anotar"}: nada se sale de la zona segura, ni se pisa, ni desborda (sin excepciones)`, async ({ page }) => {
        test.skip(!isChromiumPage(page), "`Emulation.setSafeAreaInsetsOverride` solo existe en Chromium");
        await setSafeArea(await cdpFor(page), { left: profile.inset, right: profile.inset, bottom: 21 });
        await openMode(page, mode);
        const report = await barReport(page, profile.inset, profile.inset);
        expect(report.outside, "controles de la barra fuera de la zona segura").toEqual([]);
        expect(report.unreachable, "controles tapados").toEqual([]);
        expect(report.squashed, "iconos de la barra aplastados").toEqual([]);
        expect(report.gaps, "controles contiguos a menos de 8 px").toEqual([]);
        expect(report.tiny, "objetivos menores de 44 px").toEqual([]);
        // Toda la cabecera (no solo la barra): ningun control fuera de la zona segura ni pisado por otro.
        const header = await page.evaluate(
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
                if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(`${name(controls[i].element)} × ${name(controls[j].element)}`);
              }
            }
            return {
              overlaps,
              outside: controls.filter((item) => item.box.left < inset - 1 || item.box.right > width - inset + 1).map((item) => name(item.element)),
              docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          },
          { inset: profile.inset, width: profile.width },
        );
        expect(header.overlaps, "controles de la cabecera que se pisan").toEqual([]);
        expect(header.outside, "controles de la cabecera fuera de la zona segura").toEqual([]);
        expect(header.docOverflow, "sin desborde horizontal del documento").toBeLessThanOrEqual(0);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * N4 · «Editando» / «Anotando» se lee entero o no se pinta, entre 480 y 640 px
 * ------------------------------------------------------------------ */
for (const width of [480, 500, 520, 530, 560, 600, 640] as const) {
  test.describe(`N4 · nombre del modo · ${width} px`, () => {
    test.use({ viewport: { width, height: 800 }, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editando" : "Anotando"} se lee entero (nunca «E…» ni «Anotan…»)`, async ({ page }) => {
        await openMode(page, mode);
        const info = await page.locator("[data-pro-mode-name]").evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { visible: box.width > 4 && box.height > 4 && !element.closest(".sr-only"), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, text: element.textContent ?? "" };
        });
        if (info.visible) expect(info.scrollWidth, `«${info.text}» se ve recortado`).toBeLessThanOrEqual(info.clientWidth + 1);
        const report = await barReport(page, 0, 0);
        expect(report.outside).toEqual([]);
        expect(report.docOverflow).toBeLessThanOrEqual(0);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * GE-01 · «Desplazar» enseña su texto cuando sobra sitio (700 px o mas) y es un icono con nombre accesible cuando no
 * ------------------------------------------------------------------ */
for (const size of [
  { width: 393, height: 852, text: false },
  { width: 744, height: 1133, text: true },
] as const) {
  test.describe(`GE-01 · rótulo de «Desplazar» · ${size.width} px`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, locale: "es-ES", hasTouch: true, isMobile: true });

    test(size.text ? "con 700 px o más se ve el texto «Desplazar»" : "con menos de 700 px es un icono de 44 px cuyo nombre accesible es «Desplazar»", async ({ page }) => {
      await openMode(page, "edit");
      const pan = page.getByRole("switch", { name: MS.es.host.panLabel });
      await expect(pan).toBeVisible();
      const label = (await pan.locator("span").first().boundingBox())!;
      expect(label.width > 20 && label.height > 8, `texto visible (${Math.round(label.width)}×${Math.round(label.height)})`).toBe(size.text);
      expect((await pan.boundingBox())!.width).toBeGreaterThanOrEqual(43.5);
    });
  });
}

/* ------------------------------------------------------------------ *
 * (a) Deshacer / Rehacer: botones de 44 px SIEMPRE a la vista en la barra del modo
 * ------------------------------------------------------------------ */
for (const size of [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
] as const) {
  test.describe(`(a) deshacer/rehacer en la barra del modo · ${size.width} px`, () => {
    test.use({ viewport: size, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editar" : "Anotar"}: los dos botones están en la barra con la bandeja cerrada y funcionan`, async ({ page }) => {
        await openMode(page, mode);
        await setTray(page, false);
        const bar = page.locator("[data-pro-mode-bar]");
        const undo = bar.getByRole("button", { name: /^Deshacer/ });
        const redo = bar.getByRole("button", { name: /^Rehacer/ });
        await expect(undo).toBeVisible();
        await expect(redo).toBeVisible();
        for (const button of [undo, redo]) {
          const box = (await button.boundingBox())!;
          expect(box.width, "ancho del botón").toBeGreaterThanOrEqual(43.5);
          expect(box.height, "alto del botón").toBeGreaterThanOrEqual(43.5);
        }
        await expect(undo).toHaveAttribute("aria-disabled", "true");
        await expect(redo).toHaveAttribute("aria-disabled", "true");

        // Dibuja un rectángulo (Anotar) o añade un cuadro de texto (Editar): el historial se llena.
        await pickTool(page, mode === "edit" ? "text" : "rect");
        const sheet = (await page.locator("[data-edit-scroll] canvas").first().boundingBox())!;
        const at = { x: sheet.x + sheet.width * 0.4, y: sheet.y + Math.min(sheet.height * 0.3, 140) };
        if (mode === "annotate") {
          await page.mouse.move(at.x, at.y);
          await page.mouse.down();
          await page.mouse.move(at.x + 40, at.y + 30, { steps: 6 });
          await page.mouse.up();
        } else {
          await page.mouse.click(at.x, at.y);
          // El editor tarda en montarse y enfocarse (con la CPU cargada se perdia lo tecleado antes): se espera a que tenga el foco.
          await expect(page.locator("[data-inline-editor]")).toBeFocused();
          await page.keyboard.type("hola");
          await page.keyboard.press("Shift+Enter");
        }
        await expect(undo).not.toHaveAttribute("aria-disabled", "true");
        await undo.click();
        await expect(undo).toHaveAttribute("aria-disabled", "true");
        await expect(redo).not.toHaveAttribute("aria-disabled", "true");
        await redo.click();
        await expect(redo).toHaveAttribute("aria-disabled", "true");
        // Ya no hay copia dentro de la bandeja de una sola fila (no se duplican).
        await setTray(page, true);
        await expect(page.locator('[data-pro-tray] [data-palette-item="undo"]')).toHaveCount(0);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * (b) bandeja compacta: una sola fila de herramientas y ≥ 50 % de la hoja visible con ella abierta
 * ------------------------------------------------------------------ */
for (const size of [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
] as const) {
  test.describe(`(b) bandeja compacta · ${size.width} px`, () => {
    test.use({ viewport: size, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editar" : "Anotar"}: con la bandeja abierta queda al menos la mitad de la hoja y las herramientas van en una fila desplazable`, async ({ page }) => {
        await openMode(page, mode);
        await setTray(page, false);
        const folded = await visibleSheetHeight(page, mode);
        await setTray(page, true);
        const open = await visibleSheetHeight(page, mode);
        expect(open, `hoja visible con la bandeja abierta (${open}) frente a plegada (${folded})`).toBeGreaterThanOrEqual(Math.ceil(folded * 0.5));
        const tops = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-pro-tray] [data-tool-palette] [data-palette-item]")).map((element) => Math.round(element.getBoundingClientRect().top)),
        );
        expect(tops.length, "herramientas en la bandeja").toBeGreaterThanOrEqual(6);
        expect(new Set(tops).size, "todas en la misma fila").toBe(1);
        const palette = page.locator("[data-pro-tray] [data-tool-palette]");
        expect(await palette.evaluate((element) => getComputedStyle(element).overflowX), "la fila se desplaza").toMatch(/auto|scroll/);
        // La fila llega hasta la última herramienta con el dedo.
        const lastId = await page.locator("[data-pro-tray] [data-tool-palette] [data-palette-item]").last().getAttribute("data-palette-item");
        await palette.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        const last = (await page.locator(`[data-pro-tray] [data-palette-item="${lastId}"]`).boundingBox())!;
        expect(last.x + last.width, "la última herramienta se alcanza").toBeLessThanOrEqual(size.width + 0.5);
        const small = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-pro-tray] button")).filter((button) => {
            const box = button.getBoundingClientRect();
            return box.width > 2 && (box.width < 43.5 || box.height < 43.5);
          }).map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim()),
        );
        expect(small, "botones de la bandeja menores de 44 px").toEqual([]);
        await noHorizontalOverflow(page);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * (b2) en un movil horizontal estrecho (< 768 px) la paleta no cabe como columna: va en la bandeja y se alcanza
 * ------------------------------------------------------------------ */
for (const size of [
  { width: 667, height: 375 },
  { width: 568, height: 320 },
] as const) {
  test.describe(`(b2) herramientas en horizontal estrecho · ${size.width}×${size.height}`, () => {
    test.use({ viewport: size, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editar" : "Anotar"}: al abrir las herramientas la paleta se ve entera (nada encima) y elegir una la arma`, async ({ page }) => {
        await openMode(page, mode);
        await setTray(page, true);
        const id = mode === "edit" ? "text" : "rect";
        const item = page.locator(`[data-pro-tray] [data-palette-item="${id}"]`);
        await expect(item).toBeVisible();
        const covered = await item.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return !(top && (element === top || element.contains(top)));
        });
        expect(covered, "la herramienta está tapada por otro elemento").toBe(false);
        await item.click();
        await expect(toggle(page)).toHaveAttribute("aria-label", /activa/);
        await noHorizontalOverflow(page);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * (c) en horizontal la cabecera de la web no está: «Inicio» e idioma dentro del modo
 * ------------------------------------------------------------------ */
for (const size of [
  { width: 852, height: 393 },
  { width: 667, height: 375 },
] as const) {
  test.describe(`(c) salir al inicio y cambiar de idioma · ${size.width}×${size.height}`, () => {
    test.use({ viewport: size, locale: "es-ES", hasTouch: true, isMobile: true });

    test("el menú «Más» trae «Inicio» e idioma (44 px) aunque no haya cabecera de la web", async ({ page }) => {
      await openMode(page, "edit");
      await expect(page.locator("[data-site-header]")).toBeHidden();
      const more = page.getByRole("button", { name: "Más acciones" });
      const box = (await more.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      await more.click();
      const menu = page.getByRole("menu", { name: "Más acciones" });
      const home = menu.getByRole("menuitem", { name: /inicio/i });
      const language = menu.getByRole("menuitem", { name: /English/ });
      await expect(home).toBeVisible();
      await expect(language).toBeVisible();
      for (const item of [home, language]) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      await language.click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("[data-pro-mode-apply]")).toHaveAccessibleName("Apply");
    });

    test("«Inicio» con cambios sin aplicar pregunta antes de salir y con confirmar va a la página de inicio", async ({ page }) => {
      await openMode(page, "annotate");
      await pickTool(page, "rect");
      const sheet = (await page.locator("[data-edit-scroll] canvas").first().boundingBox())!;
      await page.mouse.move(sheet.x + sheet.width * 0.4, sheet.y + 40);
      await page.mouse.down();
      await page.mouse.move(sheet.x + sheet.width * 0.4 + 40, sheet.y + 70, { steps: 5 });
      await page.mouse.up();
      await page.getByRole("button", { name: "Más acciones" }).click();
      await page.getByRole("menu", { name: "Más acciones" }).getByRole("menuitem", { name: /inicio/i }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /^Descartar y salir/ }).click();
      await expect(page).toHaveURL(/\/$/);
    });
  });
}

/* ------------------------------------------------------------------ *
 * (d) el cuadro de texto sobre la hoja mide 16 px con el dedo (Safari no acerca la página)
 * ------------------------------------------------------------------ */
test.describe("(d) cuadro de texto de Editar con el dedo", () => {
  test.use({ viewport: { width: 375, height: 667 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("el cuadro de texto que se escribe mide ≥ 16 px y se ve al tamaño del PDF", async ({ page }) => {
    await openMode(page, "edit");
    await pickTool(page, "text");
    const sheet = (await page.locator("[data-edit-scroll] canvas").first().boundingBox())!;
    await page.mouse.click(sheet.x + sheet.width * 0.4, sheet.y + 80);
    const editor = page.locator("[data-inline-editor]");
    await expect(editor).toBeVisible();
    const info = await editor.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { fontPx: Number.parseFloat(getComputedStyle(element).fontSize), width: box.width, height: box.height };
    });
    expect(info.fontPx, "tamaño de letra computado del campo").toBeGreaterThanOrEqual(16);
    // Visualmente sigue siendo del tamaño del PDF (un cuadro de 12 pt a ~0,58 px/pt): no se ve gigante.
    expect(info.height, "alto visible del cuadro").toBeLessThan(60);
    await page.keyboard.type("Prueba de texto");
    await expect(editor).toContainText("Prueba de texto");
  });
});

/* ------------------------------------------------------------------ *
 * (e) la barra de zoom enseña el porcentaje a 375 px y no se parte en dos filas
 * ------------------------------------------------------------------ */
for (const size of [
  { width: 375, height: 667, pages: 3, percent: true },
  { width: 393, height: 852, pages: 12, percent: true },
  { width: 360, height: 740, pages: 3, percent: false },
] as const) {
  test.describe(`(e) barra de zoom · ${size.width} px · ${size.pages} páginas`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, locale: "es-ES", hasTouch: true, isMobile: true });

    test("el porcentaje se ve y la barra cabe en una fila", async ({ page }) => {
      await openMode(page, "edit", size.pages);
      const nav = page.locator("[data-nav-embedded]");
      if (size.percent) {
        const percent = nav.getByText(/^\d+ ?%$/).first();
        await expect(percent).toBeVisible();
        const box = (await percent.boundingBox())!;
        expect(box.width > 20 && box.height > 8, `el porcentaje se ve de verdad (${Math.round(box.width)}×${Math.round(box.height)})`).toBe(true);
      }
      expect((await nav.boundingBox())!.height, "alto de la barra de zoom (una fila)").toBeLessThan(60);
      const worst = await minGapBetweenControls(page, "[data-nav-embedded]");
      expect(worst === null || worst.gap >= 8, `separación mínima ${JSON.stringify(worst)}`).toBe(true);
      await noHorizontalOverflow(page);
    });
  });
}

/* ------------------------------------------------------------------ *
 * (f) los avisos de la herramienta no se quedan tapando la hoja
 * ------------------------------------------------------------------ */
test.describe("(f) avisos de la herramienta · 320 px", () => {
  test.use({ viewport: { width: 320, height: 568 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("el aviso de la herramienta armada y el de «Desplazar» se retiran solos a los 4 s y dejan la hoja libre", async ({ page }) => {
    await openMode(page, "edit");
    await pickTool(page, "rect");
    const hint = page.locator("[data-tool-hint-box]");
    const panHint = page.locator("[data-pro-pan-first-hint]");
    await expect(hint).toBeVisible();
    const hintBox = (await hint.boundingBox())!;
    const sheet = (await page.locator("[data-edit-scroll]").boundingBox())!;
    const coversAtFirst = Math.max(0, Math.min(hintBox.y + hintBox.height, sheet.y + sheet.height) - Math.max(hintBox.y, sheet.y));
    // Mientras se lee, el aviso es breve (≤ 20 % de la hoja visible).
    expect(coversAtFirst, "alto del aviso sobre la hoja mientras se lee").toBeLessThanOrEqual(Math.round(sheet.height * 0.2));
    await page.waitForTimeout(4600);
    // Sin reintentos largos: a los ~4,6 s del aviso ya debe haberse retirado (con 7 s, como antes, `toHaveCount` esperaria y pasaria).
    await expect(panHint).toHaveCount(0, { timeout: 800 });
    const after = await hint.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { height: box.height, text: element.textContent ?? "" };
    });
    expect(after.height, "el aviso ya no ocupa sitio sobre la hoja").toBeLessThanOrEqual(2);
    // El texto sigue en el DOM para lectores de pantalla.
    expect(after.text.length).toBeGreaterThan(10);
    expect(await visibleSheetHeight(page, "edit"), "hoja visible tras los avisos").toBeGreaterThanOrEqual(290);
  });
});

/* ------------------------------------------------------------------ *
 * VI-07 · 8 px entre botones contiguos de la paleta en columna de las tablets
 * ------------------------------------------------------------------ */
for (const size of [
  { name: "iPad Pro vertical 834×1194", width: 834, height: 1194 },
  { name: "iPad Pro horizontal 1194×834", width: 1194, height: 834 },
  { name: "tablet Android 800×1280", width: 800, height: 1280 },
] as const) {
  test.describe(`VI-07 · paleta en columna · ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of EDITORS) {
      test(`${mode === "edit" ? "Editar" : "Anotar"}: ≥ 8 px entre botones (Deshacer/Rehacer y herramientas)`, async ({ page }) => {
        await openMode(page, mode);
        await expect(page.locator("[data-tool-palette]").first()).toBeVisible();
        const worst = await minGapBetweenControls(page, "[data-tool-palette]");
        expect(worst === null || worst.gap >= 8, `separación mínima ${JSON.stringify(worst)}`).toBe(true);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * VI-07 · cabecera del documento en SE 320 (Deshacer/Rehacer a 4 px) y sin desborde
 * ------------------------------------------------------------------ */
for (const width of [320, 360] as const) {
  test.describe(`VI-07 · cabecera del documento · ${width} px`, () => {
    test.use({ viewport: { width, height: 700 }, locale: "es-ES", hasTouch: true, isMobile: true });

    test("Deshacer, Rehacer, Descargar y Más están a 8 px o más y sin desborde", async ({ page }) => {
      await openProDoc(page, { pages: 3 });
      const worst = await minGapBetweenControls(page, '[data-pro-region="top"]');
      expect(worst === null || worst.gap >= 8, `separación mínima ${JSON.stringify(worst)}`).toBe(true);
      await noHorizontalOverflow(page);
    });
  });
}

/* ------------------------------------------------------------------ *
 * H3 · la hoja no oscila de ancho (axe `scrollable-region-focusable` intermitente en WebKit)
 * ------------------------------------------------------------------ */
test.describe("H3 · ancho de la hoja estable · 375×812", () => {
  test.use({ viewport: { width: 375, height: 812 }, locale: "es-ES", hasTouch: true, isMobile: true });

  for (const mode of EDITORS) {
    test(`${mode === "edit" ? "Editar" : "Anotar"}: el ancho de la tarjeta de la hoja no cambia y el recorte no se desplaza en horizontal`, async ({ page }) => {
      await openMode(page, mode);
      const samples: { card: number; clipClient: number; clipScroll: number }[] = [];
      for (let i = 0; i < 12; i += 1) {
        samples.push(
          await page.evaluate(() => {
            const clip = document.querySelector<HTMLElement>("[data-edit-clip]")!;
            const card = clip.closest<HTMLElement>(".surface-card")!;
            return { card: Math.round(card.getBoundingClientRect().width), clipClient: clip.clientWidth, clipScroll: clip.scrollWidth };
          }),
        );
        await page.waitForTimeout(150);
      }
      expect(new Set(samples.map((sample) => sample.card)).size, `anchos de la tarjeta ${JSON.stringify(samples.map((s) => s.card))}`).toBe(1);
      for (const sample of samples) expect(sample.clipScroll, "la zona de recorte no se desplaza en horizontal").toBeLessThanOrEqual(sample.clipClient);
    });
  }
});
