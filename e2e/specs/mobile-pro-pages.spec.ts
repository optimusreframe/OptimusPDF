import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { makePdf } from "../helpers/test-files";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { center, openProDoc, openTab, touchEnd, touchMove, touchStart, type Point } from "../helpers/mobile-pro";

/**
 * M2 · GE-03 (reordenar paginas: auto-desplazamiento por tiempo, el sitio se conserva al soltar, la pagina movida queda a la
 * vista y seleccionada, destino visible) y GE-05 (hoja «Paginas» en movil: mas de una fila a la vista, barra de acciones de una
 * fila y «Aplicar cambios» al alcance del pulgar). Gestos REALES por CDP: solo Chromium (iPhone 15 Pro, 393×852, tactil).
 */
const S = PRO_STRINGS.es;
test.setTimeout(120_000);
test.use({ viewport: { width: 393, height: 852 }, locale: "es-ES", hasTouch: true, isMobile: true });

const grid = (page: Page) => page.getByRole("listbox", { name: /Páginas del documento/ });
const card = (page: Page, n: number) => grid(page).getByRole("option", { name: new RegExp(`^Página ${n} de`) });

async function openPages(page: Page, pages = 60): Promise<void> {
  await openProDoc(page, { pages, bytes: await makePdf({ pages, label: "PAG", size: [595, 842] }) });
  await openTab(page, "pages");
  await expect(grid(page)).toBeVisible();
  await expect(grid(page).getByRole("option").first()).toBeVisible();
  // La hoja entra con un muelle: se espera a que deje de moverse.
  const dialog = page.getByRole("dialog").last();
  let previous = "";
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      const now = box ? `${Math.round(box.y)}` : "";
      const same = now === previous;
      previous = now;
      return same;
    }, { intervals: [120], timeout: 8000 })
    .toBe(true);
}

const scrollTopOf = (page: Page) => grid(page).evaluate((element) => (element as HTMLElement).scrollTop);

/** Pagina `n` (base 1) arrastrada desde su asa hasta `to`, con el dedo, soltando al final. */
async function handleOf(page: Page, index: number): Promise<Point> {
  const handle = grid(page).locator("[data-page-id]").nth(index).locator("[data-drag-handle]");
  return center(handle);
}

async function listbox(page: Page) {
  const box = (await grid(page).boundingBox())!;
  return box;
}

test.describe("GE-03 · reordenar páginas en el móvil", () => {
  test("el auto-desplazamiento va por TIEMPO (px/s), sube cerca del borde y tiene tope", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "el dedo se emula por CDP (Input.dispatchTouchEvent), solo Chromium");
    await openPages(page);
    const cdp: CDPSession = await page.context().newCDPSession(page);
    const area = await listbox(page);
    const start = await handleOf(page, 0);
    const speeds: Record<string, number> = {};
    await touchStart(cdp, start);
    // Hasta una zona cercana al borde inferior (8 px) y se mantiene.
    for (let i = 1; i <= 10; i += 1) {
      await touchMove(cdp, { x: start.x + 60, y: start.y + ((area.y + area.height - 8 - start.y) * i) / 10 });
      await page.waitForTimeout(20);
    }
    for (const [name, offset] of [["borde", 8], ["cerca", 40]] as const) {
      await touchMove(cdp, { x: start.x + 60, y: area.y + area.height - offset });
      await page.waitForTimeout(250);
      const before = await scrollTopOf(page);
      const t0 = Date.now();
      await page.waitForTimeout(800);
      const after = await scrollTopOf(page);
      speeds[name] = ((after - before) * 1000) / (Date.now() - t0);
    }
    await touchEnd(cdp);
    // Con el dedo a 8 px del borde: rapido pero con tope (≤ 900 px/s a cualquier tasa de fotogramas); a 40 px, mas lento.
    expect(speeds.borde, "px/s a 8 px del borde").toBeGreaterThan(150);
    expect(speeds.borde, "px/s a 8 px del borde: con tope").toBeLessThanOrEqual(900);
    expect(speeds.cerca, "mas cerca del borde, mas rapido").toBeLessThan(speeds.borde);
    expect(speeds.cerca, "a 40 px del borde sigue desplazando").toBeGreaterThan(40);
  });

  test("tras desplazarse y soltar, el scroll se conserva y la página movida queda a la vista y seleccionada", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "el dedo se emula por CDP (Input.dispatchTouchEvent), solo Chromium");
    await openPages(page);
    const cdp: CDPSession = await page.context().newCDPSession(page);
    const area = await listbox(page);
    const start = await handleOf(page, 0);
    await touchStart(cdp, start);
    for (let i = 1; i <= 10; i += 1) {
      await touchMove(cdp, { x: start.x + 60, y: start.y + ((area.y + area.height - 10 - start.y) * i) / 10 });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(1800);
    const during = await scrollTopOf(page);
    expect(during, "se desplazo mientras se arrastraba").toBeGreaterThan(300);
    // Destino VISIBLE mientras se arrastra: el marcador de insercion esta dentro de la cuadricula a la vista.
    const marker = grid(page).locator("[data-drop-marker]");
    await expect(marker).toBeVisible();
    const markerBox = (await marker.boundingBox())!;
    expect(markerBox.y + markerBox.height, "marcador de destino a la vista").toBeGreaterThan(area.y);
    expect(markerBox.y, "marcador de destino a la vista").toBeLessThan(area.y + area.height);
    // Se suelta a mitad de la cuadricula.
    await touchMove(cdp, { x: area.x + area.width / 2, y: area.y + area.height / 2 });
    await page.waitForTimeout(150);
    const beforeDrop = await scrollTopOf(page);
    await touchEnd(cdp);
    await page.waitForTimeout(900);
    const after = await scrollTopOf(page);
    expect(after, "no vuelve al inicio al soltar").toBeGreaterThan(beforeDrop - 400);
    expect(after, "no vuelve al inicio al soltar").toBeGreaterThan(300);
    // La pagina movida (la antigua 1) esta a la vista y seleccionada.
    const moved = grid(page).locator('[role="option"][aria-selected="true"]').first();
    await expect(moved).toBeVisible();
    const box = (await moved.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(area.y - 2);
    expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height + 2);
    await expect(moved).toHaveAttribute("aria-label", /original 1\b/);
  });
});

test.describe("GE-05 · hoja «Páginas» en el móvil", () => {
  test("se ven al menos dos filas completas de páginas y la barra de acciones es de una fila", async ({ page }) => {
    await openPages(page, 24);
    const area = await listbox(page);
    const rows = await grid(page).evaluate((element, bounds) => {
      const tops = new Set<number>();
      for (const option of Array.from(element.querySelectorAll('[role="option"]'))) {
        const box = option.getBoundingClientRect();
        if (box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1) tops.add(Math.round(box.top));
      }
      return tops.size;
    }, { top: area.y, bottom: area.y + area.height });
    expect(rows, "filas de paginas completas a la vista").toBeGreaterThanOrEqual(2);
    const bar = page.locator("[data-pages-toolbar][data-compact]");
    // «Aplicar» y «Descartar» van en la fila del recuento; los botones de pagina (girar, eliminar, mover, mas) en UNA sola fila.
    const tops = await bar.locator('button:not([data-action="apply"]):not([data-action="discard"])').evaluateAll((buttons) => Array.from(new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))));
    expect(tops.length, "los botones de la barra de acciones comparten fila").toBe(1);
  });

  test("«Aplicar cambios» está al alcance del pulgar (mitad inferior de la pantalla)", async ({ page }) => {
    await openPages(page, 6);
    await card(page, 1).click();
    await page.getByRole("button", { name: S.pages.actions.rotateRight, exact: true }).click();
    const apply = page.locator('[data-action="apply"]');
    await expect(apply).toBeVisible();
    const box = (await apply.boundingBox())!;
    expect(box.y + box.height / 2, "«Aplicar cambios» en la mitad inferior").toBeGreaterThan(852 * 0.5);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

export type { Locator };
