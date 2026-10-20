import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { MODE_STRINGS } from "../../src/app/pdf-pro/modes/modeStrings";
import { center, noHorizontalOverflow, openProDoc, openTab, touchDrag } from "../helpers/mobile-pro";

/**
 * M2 · PDF Pro tactil: SC-05 (el pellizco fuera del visor no acerca la pagina), GE-01 (herramienta armada: interruptor
 * «Desplazar» visible y de 44 px), VI-02 (OCR sin truncar), VI-03 (etiquetas del dock sin tocarse a 320 px), VI-07 (≥ 8 px
 * entre botones contiguos), VI-08 (ayudas tactiles sin «clic» ni «Esc») y SC-04 (campos de 16 px o mas con el dedo).
 * Gestos reales por CDP: solo Chromium; el resto mide el DOM y corre en cualquier motor.
 */
const S = PRO_STRINGS.es;
test.setTimeout(120_000);

async function pageScale(page: Page): Promise<number> {
  return page.evaluate(() => window.visualViewport?.scale ?? 1);
}

test.describe("SC-05 · el pellizco fuera del visor no acerca toda la página", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("pellizcar sobre la cabecera, la barra del visor o el dock no cambia el zoom de la página", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "el pellizco real usa CDP (Input.dispatchTouchEvent), solo Chromium");
    await openProDoc(page, { pages: 3 });
    const cdp: CDPSession = await page.context().newCDPSession(page);
    expect(await pageScale(page)).toBeCloseTo(1, 2);
    for (const selector of ['[data-pro-region="top"]', "[data-pro-viewer-toolbar]", "[data-pro-dock]"]) {
      const at = await center(page.locator(selector));
      const points = (distance: number) => [
        { x: at.x - distance / 2, y: at.y, id: 1 },
        { x: at.x + distance / 2, y: at.y, id: 2 },
      ];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(60) });
      for (let i = 1; i <= 10; i += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(60 + i * 24) });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(200);
      expect(await pageScale(page), `zoom de pagina tras pellizcar ${selector}`).toBeCloseTo(1, 2);
    }
  });
});

test.describe("GE-01 · herramienta armada: «Desplazar»", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("con una herramienta armada hay un interruptor «Desplazar» de 44 px y con él un dedo desplaza la hoja", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "el arrastre real usa CDP (Input.dispatchTouchEvent), solo Chromium");
    await openProDoc(page, { pages: 3 });
    await openTab(page, "edit");
    await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-palette-item="rect"]').click();
    const toggle = page.getByRole("switch", { name: new RegExp(MODE_STRINGS.es.host.panLabel) });
    await expect(toggle).toBeVisible();
    const box = (await toggle.boundingBox())!;
    expect(box.height, "interruptor de 44 px").toBeGreaterThanOrEqual(44);
    expect(box.width, "interruptor de 44 px").toBeGreaterThanOrEqual(44);
    const cdp: CDPSession = await page.context().newCDPSession(page);
    const scroller = page.locator("[data-edit-scroll]");
    const area = (await scroller.boundingBox())!;
    const dragUp = async () => {
      const top = await scroller.evaluate((element) => (element as HTMLElement).scrollTop);
      await touchDrag(page, cdp, { x: area.x + area.width / 2, y: area.y + area.height - 60 }, { x: area.x + area.width / 2, y: area.y + 60 });
      await page.waitForTimeout(250);
      return (await scroller.evaluate((element) => (element as HTMLElement).scrollTop)) - top;
    };
    // Sin el interruptor, la herramienta armada se queda el dedo (dibuja): la hoja no se mueve.
    expect(await dragUp(), "sin «Desplazar» el dedo dibuja").toBeLessThan(5);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await dragUp(), "con «Desplazar» un dedo desplaza la hoja").toBeGreaterThan(40);
    await noHorizontalOverflow(page);
  });
});

test.describe("VI-02 / VI-03 · textos y dock a 320 px", () => {
  for (const language of ["es", "en"] as const) {
    test.describe(language.toUpperCase(), () => {
      test.use({ viewport: { width: 320, height: 568 }, locale: language === "es" ? "es-ES" : "en-US", hasTouch: true, isMobile: true });

      test("VI-02: «Reconocer texto (OCR)» se lee entero (envuelve, no trunca)", async ({ page }) => {
        await openProDoc(page, { pages: 2 });
        await page.getByRole("button", { name: PRO_STRINGS[language].suite.tabs.home, exact: true }).click();
        const open = page.locator('[data-doc-tool-open="ocr"]');
        await expect(open).toBeVisible();
        const clipped = await open.evaluate((button) =>
          Array.from(button.querySelectorAll<HTMLElement>("span")).filter((span) => span.scrollWidth > span.clientWidth + 1 && getComputedStyle(span).overflowX !== "visible").map((span) => span.textContent),
        );
        expect(clipped, "ningun texto del lanzador queda recortado").toEqual([]);
        await noHorizontalOverflow(page);
      });

      test("VI-03: las etiquetas del dock no se tocan ni se solapan", async ({ page }) => {
        await openProDoc(page, { pages: 2 });
        const gaps = await page.locator("[data-pro-dock]").evaluate((dock) => {
          const labels = Array.from(dock.querySelectorAll<HTMLElement>("[data-dock] span")).map((label) => {
            const range = document.createRange();
            range.selectNodeContents(label);
            const box = range.getBoundingClientRect();
            return { text: label.textContent ?? "", left: box.left, right: box.right };
          });
          return labels.slice(1).map((label, index) => ({ pair: `${labels[index].text} / ${label.text}`, gap: label.left - labels[index].right }));
        });
        for (const item of gaps) expect(item.gap, `separacion ${item.pair}`).toBeGreaterThanOrEqual(2);
        await noHorizontalOverflow(page);
      });
    });
  }
});

test.describe("VI-08 · ayudas táctiles en Editar", () => {
  for (const language of ["es", "en"] as const) {
    test.describe(language.toUpperCase(), () => {
      test.use({ viewport: { width: 393, height: 852 }, locale: language === "es" ? "es-ES" : "en-US", hasTouch: true, isMobile: true });

      test("la ayuda de la herramienta armada no habla de clic ni de Esc", async ({ page }) => {
        await openProDoc(page, { pages: 2 });
        await openTab(page, "edit");
        await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
        for (const tool of ["text", "rect", "highlight", "check"]) {
          await page.locator(`[data-palette-item="${tool}"]`).click();
          const hint = (await page.locator("[data-tool-hint]").textContent()) ?? "";
          expect(hint.length, `ayuda de ${tool}`).toBeGreaterThan(10);
          expect(hint, `ayuda de ${tool} sin «clic» ni «Esc»`).not.toMatch(/\b(clic|click|haz clic|Esc)\b/i);
        }
      });
    });
  }
});

test.describe("VI-07 · separación entre botones contiguos", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

  async function minGap(page: Page, selector: string): Promise<{ pair: string; gap: number } | null> {
    return page.locator(selector).first().evaluate((root) => {
      const boxes = Array.from(root.querySelectorAll<HTMLElement>("button, a[href]"))
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter((item) => item.box.width > 0 && item.box.height > 0);
      let worst: { pair: string; gap: number } | null = null;
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i].box;
          const b = boxes[j].box;
          const overlapV = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapV < 8) continue;
          const gap = Math.max(b.left - a.right, a.left - b.right);
          if (gap < 8 && (!worst || gap < worst.gap)) {
            const name = (item: HTMLElement) => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim().slice(0, 24);
            worst = { pair: `${name(boxes[i].element)} | ${name(boxes[j].element)}`, gap };
          }
        }
      }
      return worst;
    });
  }

  test("barra del visor, cabecera y barra del modo", async ({ page }) => {
    await openProDoc(page, { pages: 3 });
    expect(await minGap(page, "[data-pro-viewer-toolbar]"), "barra del visor").toBeNull();
    expect(await minGap(page, '[data-pro-region="top"]'), "cabecera del documento").toBeNull();
    await openTab(page, "edit");
    await expect(page.locator("[data-pro-mode-bar]")).toBeVisible();
    expect(await minGap(page, "[data-pro-mode-bar]"), "barra del modo").toBeNull();
  });
});

test.describe("SC-04 · campos de 16 px o más con el dedo", () => {
  test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

  const smallFonts = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select"))
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((element) => ({ name: element.getAttribute("aria-label") ?? element.id ?? element.tagName, size: parseFloat(getComputedStyle(element).fontSize) }))
        .filter((item) => item.size < 16),
    );

  test("«Ir a la página», la paleta de comandos y los campos de las herramientas", async ({ page }) => {
    await openProDoc(page, { pages: 3 });
    expect(await smallFonts(page), "visor").toEqual([]);
    await page.getByRole("button", { name: S.suite.tabs.protect, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(900);
    expect(await smallFonts(page), "panel Proteger").toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: S.shell.more, exact: true }).click();
    await page.getByRole("menuitem", { name: S.shell.paletteItem }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(600);
    expect(await smallFonts(page), "paleta de comandos").toEqual([]);
  });
});

test.describe("GE-02 · iPad vertical: la hoja del visor es grande", () => {
  test.use({ viewport: { width: 834, height: 1194 }, locale: "es-ES", hasTouch: true, isMobile: true });

  test("el visor mide al menos 480 px de ancho con el panel de herramientas abierto", async ({ page }) => {
    await openProDoc(page, { pages: 3 });
    await expect(page.locator('[data-pro-slot="viewer"]')).toBeVisible();
    const box = (await page.locator('[data-pro-slot="viewer"]').boundingBox())!;
    expect(box.width, "ancho del visor en un iPad vertical").toBeGreaterThanOrEqual(480);
    await noHorizontalOverflow(page);
  });
});
