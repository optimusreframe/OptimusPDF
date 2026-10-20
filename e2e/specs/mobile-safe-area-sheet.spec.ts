import { expect, test, type Browser } from "@playwright/test";
import {
  boxOf,
  cdpOf,
  host,
  isChromium,
  newTouchContext,
  openSignWithPdf,
  setSafeArea,
  touchDrag,
  type DeviceName,
} from "../helpers/touch-gestures";
import { outsideSafeColumns } from "../helpers/touch-measure";
import { goToTab, openProPdf } from "../helpers/pro-flow";

/**
 * M3 · zonas de seguridad laterales (SC-03), hoja que se cierra deslizando desde el contenido (SC-06) y barra lateral
 * que se pliega en el iPad horizontal (GE-04 de `docs/AUDITORIA-MOVIL-IPAD.md`). Headless siempre.
 *
 * Las zonas de seguridad se emulan con `Emulation.setSafeAreaInsetsOverride` (solo Chromium): no son las de un
 * iPhone real (no verificado en dispositivo).
 */

test.setTimeout(180_000);

async function newPage(browser: Browser, device: DeviceName) {
  const context = await newTouchContext(browser, device);
  const page = await context.newPage();
  return { page, context };
}

/* ------------------------------------------------------------------ *
 * SC-03
 * ------------------------------------------------------------------ */
test.describe("SC-03 · iPhone horizontal: ningun control queda bajo la muesca", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "`setSafeAreaInsetsOverride` solo existe en Chromium");

  const LEFT = 59;
  const RIGHT = 852 - 59;

  test("Inicio, Firmar y PDF Pro dejan sus controles dentro de [59, 793] px", async ({ browser }) => {
    const { page, context } = await newPage(browser, "iphoneLandscape");
    try {
      const cdp = await cdpOf(page);
      await setSafeArea(cdp, { left: 59, right: 59, bottom: 21 });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      expect(await outsideSafeColumns(page, LEFT, RIGHT), "Inicio").toEqual([]);

      await openSignWithPdf(page, 1);
      expect(await outsideSafeColumns(page, LEFT, RIGHT), "Firmar con un PDF").toEqual([]);

      await openProPdf(page, { pages: 2 });
      expect(await outsideSafeColumns(page, LEFT, RIGHT), "PDF Pro con un PDF").toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("la hoja de la firma (pantalla completa) deja sus controles dentro de la zona segura", async ({ browser }) => {
    const { page, context } = await newPage(browser, "iphoneLandscape");
    try {
      const cdp = await cdpOf(page);
      await setSafeArea(cdp, { left: 59, right: 59, bottom: 21 });
      await openSignWithPdf(page, 1);
      await page.getByRole("button", { name: "Crear firma" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(700);
      expect(await outsideSafeColumns(page, LEFT, RIGHT), "hoja de firma").toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("en vertical y sin zona de seguridad nada se mueve (los 16 px de siempre)", async ({ browser }) => {
    const { page, context } = await newPage(browser, "iphone15");
    try {
      await page.goto("/");
      const logo = await page.locator("header a").first().boundingBox();
      expect(logo!.x).toBeGreaterThanOrEqual(15);
      expect(logo!.x).toBeLessThan(20);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * SC-06
 * ------------------------------------------------------------------ */
test.describe("SC-06 · la hoja se cierra deslizando desde el contenido", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "El tacto por CDP solo existe en Chromium");

  async function openConvertSheet(page: import("@playwright/test").Page) {
    await openProPdf(page, { pages: 3 });
    await goToTab(page, "convert");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(700);
    return dialog;
  }

  test("arrastrar hacia abajo desde el contenido, con el contenido arriba del todo, cierra la hoja", async ({ browser }) => {
    const { page, context } = await newPage(browser, "se375");
    try {
      const cdp = await cdpOf(page);
      const dialog = await openConvertSheet(page);
      const scrollable = await dialog.evaluate((el) =>
        [...el.querySelectorAll("*")].some((n) => ["auto", "scroll"].includes(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 4),
      );
      expect(scrollable, "el contenido de la hoja debe desbordar para probar el caso").toBe(true);
      const box = await boxOf(dialog);
      const x = box.x + box.width / 2;
      const y = box.y + box.height * 0.6;
      await touchDrag(cdp, { x, y }, { x, y: y + 300 }, { steps: 12, stepMs: 12 });
      await expect(dialog).toBeHidden({ timeout: 4000 });
    } finally {
      await context.close();
    }
  });

  test("deslizar hacia arriba sigue desplazando el contenido y, ya desplazado, bajar no cierra", async ({ browser }) => {
    const { page, context } = await newPage(browser, "se375");
    try {
      const cdp = await cdpOf(page);
      const dialog = await openConvertSheet(page);
      const box = await boxOf(dialog);
      const x = box.x + box.width / 2;
      const y = box.y + box.height * 0.7;
      const scrollTop = () =>
        dialog.evaluate((el) => {
          const sc = [...el.querySelectorAll("*")].find((n) => ["auto", "scroll"].includes(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 4);
          return sc ? Math.round(sc.scrollTop) : -1;
        });
      await touchDrag(cdp, { x, y }, { x, y: y - 220 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(700);
      const after = await scrollTop();
      expect(after).toBeGreaterThan(60);
      // Bajar un poco (el contenido sigue desplazado a mitad): se desplaza hacia arriba, no se cierra la hoja.
      await touchDrag(cdp, { x, y: y - 100 }, { x, y }, { steps: 8, stepMs: 12 });
      await page.waitForTimeout(500);
      await expect(dialog).toBeVisible();
      expect(await scrollTop()).toBeLessThan(after);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * GE-04
 * ------------------------------------------------------------------ */
test.describe("GE-04 · barra lateral global en el iPad horizontal", () => {
  test("dentro de Firmar y PDF Pro (dedo, < 1280 px) arranca plegada y la hoja gana ancho; se puede desplegar", async ({ browser }) => {
    const { page, context } = await newPage(browser, "ipadLandscape");
    try {
      await openSignWithPdf(page, 1);
      const aside = page.locator("aside").first();
      await expect(aside).toBeVisible();
      expect((await boxOf(aside)).width).toBeLessThan(90);
      expect((await boxOf(host(page))).width).toBeGreaterThanOrEqual(560);
      // Desplegarla (solo esa pantalla).
      await page.getByRole("button", { name: /Expandir|Expand/ }).click();
      await expect.poll(async () => (await boxOf(aside)).width, { timeout: 3000 }).toBeGreaterThan(250);
    } finally {
      await context.close();
    }
  });

  test("fuera de los documentos (Ajustes) y con raton la barra lateral conserva su ancho", async ({ browser, browserName }) => {
    const touch = await newPage(browser, "ipadLandscape");
    try {
      await touch.page.goto("/settings");
      await expect(touch.page.locator("aside").first()).toBeVisible();
      await expect.poll(async () => (await boxOf(touch.page.locator("aside").first())).width, { timeout: 4000 }).toBeGreaterThan(250);
    } finally {
      await touch.context.close();
    }
    // El WebKit del emulador de iPad reporta puntero grueso aunque el contexto no lo pida: la parte de raton es de Chromium.
    if (browserName !== "chromium") return;
    const context = await browser.newContext({ viewport: { width: 1194, height: 834 } });
    const page = await context.newPage();
    try {
      await page.goto("/sign-pdf");
      await expect(page.locator("aside").first()).toBeVisible();
      await expect.poll(async () => (await boxOf(page.locator("aside").first())).width, { timeout: 4000 }).toBeGreaterThan(250);
    } finally {
      await context.close();
    }
  });

  test("guarda de sanidad del motor", async ({ page }) => {
    expect(typeof isChromium(page)).toBe("boolean");
  });
});
