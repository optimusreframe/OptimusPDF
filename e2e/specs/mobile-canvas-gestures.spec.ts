import { expect, test, type CDPSession, type Page } from "@playwright/test";
import {
  boxOf,
  cdpOf,
  host,
  makeA4Pdf,
  newTouchContext,
  openSoloCanvasWithSignature,
  pickTool,
  revealSheet,
  scrollY,
  touchDrag,
  touchPinch,
  sheetPoint,
  touchTap,
  visibleBand,
  type DeviceName,
} from "../helpers/touch-gestures";

/**
 * M3 · Lienzo compartido en el telefono y el iPad (GE-01, GE-06 de `docs/AUDITORIA-MOVIL-IPAD.md`).
 *
 * Gestos de dedo REALES (`Input.dispatchTouchEvent`, solo Chromium con perfil iOS; en WebKit no hay canal de tacto):
 *  - GE-01: con una herramienta armada, o con zoom, el dedo sobre la hoja NO debe quedarse sin desplazar la pagina
 *    (`touch-action: none` en todo el lienzo era una trampa de scroll). Un toque sigue colocando el elemento.
 *  - Pellizco propio: acerca la hoja alrededor del punto central de los dedos, sin zoom de pagina.
 *  - GE-06: arrastrar un elemento hacia el borde desplaza (por TIEMPO, no por fotograma) y el pan con zoom llega a
 *    toda la hoja (no a +-400 px).
 *
 * Headless siempre.
 */

test.setTimeout(180_000);

type Session = { page: Page; cdp: CDPSession; close: () => Promise<void> };

async function openSession(
  browser: Parameters<typeof newTouchContext>[0],
  device: DeviceName,
  pages = 2,
  size?: readonly [number, number],
): Promise<Session> {
  const context = await newTouchContext(browser, device);
  const page = await context.newPage();
  const cdp = await cdpOf(page);
  await openSoloCanvasWithSignature(page, cdp, pages, size);
  await revealSheet(page);
  return { page, cdp, close: () => context.close() };
}

/** Texto del boton de zoom que muestra el nivel («100 %», «150 %»...). */
async function zoomPercent(page: Page): Promise<number> {
  const label = await page.getByRole("button", { name: /Restablecer zoom|Reset zoom/ }).innerText();
  return Number(label.replace(/[^\d]/g, ""));
}

/** Traslacion (px) y escala del anfitrion de la hoja, leidas de su `transform`. */
async function hostTransform(page: Page): Promise<{ x: number; y: number; scale: number }> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-canvas="host"]');
    const transform = el?.style.transform ?? "";
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\((-?[\d.]+)\)/.exec(transform);
    return match ? { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) } : { x: 0, y: 0, scale: 1 };
  });
}

const zoomIn = (page: Page) => page.getByRole("button", { name: /^Acercar$|^Zoom in$/ }).click();

test.describe("GE-01 · el dedo desplaza la pagina aunque haya herramienta o zoom", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "El tacto por CDP solo existe en Chromium");

  test("con «Texto» armada, deslizar sobre la hoja desplaza la pagina y no crea nada", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      await pickTool(page, /^Texto$|^Text$/);
      const sheet = await boxOf(host(page));
      const before = await scrollY(page);
      const x = sheet.x + sheet.width * 0.5;
      // Sobre el texto de la hoja (la firma colocada esta mas abajo y lleva su propio `touch-none`).
      const y = Math.min(sheet.y + sheet.height * 0.35, 520);
      await touchDrag(cdp, { x, y }, { x, y: y - 260 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(500);
      expect((await scrollY(page)) - before).toBeGreaterThan(120);
      // Deslizar no es colocar: no hay campos nuevos y la herramienta sigue armada.
      await expect(page.locator('[data-element-kind="text"][data-drag-mode="move"]')).toHaveCount(0);
      await expect(host(page)).toHaveAttribute("data-tool", "text");
    } finally {
      await close();
    }
  });

  test("con «Texto» armada, un toque sigue colocando el campo", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      await pickTool(page, /^Texto$|^Text$/);
      await touchTap(cdp, await sheetPoint(page, 0.4, 0.3));
      await expect(page.locator('[data-element-kind="text"][data-drag-mode="move"]')).toHaveCount(1);
    } finally {
      await close();
    }
  });

  test("con la herramienta armada, mantener y arrastrar dibuja un campo del tamano elegido", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      await pickTool(page, /^Texto$|^Text$/);
      const from = await sheetPoint(page, 0.2, 0.25);
      await touchDrag(cdp, from, { x: from.x + 150, y: from.y + 50 }, { holdMs: 450, steps: 10, stepMs: 14 });
      const field = page.locator('[data-element-kind="text"][data-drag-mode="move"]').first();
      await expect(field).toBeVisible();
      const box = await boxOf(field);
      expect(box.width).toBeGreaterThan(110);
      expect(box.width).toBeLessThan(190);
    } finally {
      await close();
    }
  });

  test("con zoom 2x, un dedo mueve la hoja y, en el borde, sigue con la pagina", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      await zoomIn(page);
      await zoomIn(page);
      expect(await zoomPercent(page)).toBe(200);
      // La tarjeta que recorta (no la hoja ampliada, que sale de la pantalla) es lo que se ve.
      const card = await boxOf(host(page).locator(".."));
      const x = card.x + 30;
      const y = Math.min(card.y + card.height * 0.5, 520);
      const t0 = await hostTransform(page);
      const s0 = await scrollY(page);
      await touchDrag(cdp, { x: x + 150, y }, { x, y }, { steps: 8, stepMs: 12 });
      await page.waitForTimeout(250);
      const t1 = await hostTransform(page);
      // El dedo movio la hoja (pan), no la pagina.
      expect(t1.x).toBeLessThan(t0.x - 60);
      expect(Math.abs((await scrollY(page)) - s0)).toBeLessThan(10);
      // Arrastrando hacia arriba una y otra vez: primero pan, y al agotarse, la pagina se desplaza.
      for (let index = 0; index < 10; index += 1) {
        await touchDrag(cdp, { x: x + 80, y: y + 150 }, { x: x + 80, y: y - 150 }, { steps: 8, stepMs: 10 });
        await page.waitForTimeout(80);
      }
      expect(await scrollY(page)).toBeGreaterThan(s0 + 80);
    } finally {
      await close();
    }
  });

  test("pellizco: acerca alrededor del centro de los dedos y no hace zoom de pagina", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      const sheet = await boxOf(host(page));
      const center = { x: sheet.x + sheet.width * 0.72, y: Math.min(sheet.y + sheet.height * 0.55, 500) };
      const norm = (box: { x: number; y: number; width: number; height: number }) => ({
        u: (center.x - box.x) / box.width,
        v: (center.y - box.y) / box.height,
      });
      const before = norm(sheet);
      await touchPinch(cdp, center, 70, 210, { steps: 14, stepMs: 16 });
      await page.waitForTimeout(300);
      expect(await zoomPercent(page)).toBeGreaterThan(200);
      const after = norm(await boxOf(host(page)));
      // El punto de la hoja que estaba bajo los dedos sigue ahi (+-2,5 % de la hoja).
      expect(Math.abs(after.u - before.u)).toBeLessThan(0.025);
      expect(Math.abs(after.v - before.v)).toBeLessThan(0.025);
      // La pagina entera no se acerco.
      expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
    } finally {
      await close();
    }
  });
});

test.describe("GE-06 · arrastrar con zoom: auto-desplazamiento por tiempo y pan a toda la hoja", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "El tacto por CDP solo existe en Chromium");

  test("arrastrar la firma hacia el borde de arriba desplaza la pagina (por tiempo) y la firma sigue al dedo", async ({
    browser,
  }) => {
    // Hoja alta (595 x 1700): no cabe en la pantalla, asi que arrastrar hacia el borde necesita desplazar.
    const { page, cdp, close } = await openSession(browser, "iphone15", 2, [595, 1700]);
    try {
      const slot = page.locator('[data-element-kind="slot"][data-drag-mode="move"]').first();
      await slot.scrollIntoViewIfNeeded();
      const norm = async () => {
        const sheet = await boxOf(host(page));
        const box = await boxOf(slot);
        return (box.y + box.height / 2 - sheet.y) / sheet.height;
      };
      const before = await scrollY(page);
      const yBefore = await norm();
      const slotBox = await boxOf(slot);
      const from = { x: slotBox.x + slotBox.width / 2, y: slotBox.y + slotBox.height / 2 };
      // Justo bajo la barra de zoom pegajosa (que acaba hacia y = 118): dentro de la zona de borde de la parte libre.
      const target = { x: from.x, y: 128 };
      const started = Date.now();
      await touchDrag(cdp, from, target, { steps: 8, stepMs: 16, endHoldMs: 900 });
      const elapsed = (Date.now() - started) / 1000;
      await page.waitForTimeout(100);
      const delta = before - (await scrollY(page));
      expect(delta).toBeGreaterThan(120);
      // Por tiempo, no por fotograma: nunca mas de ~900 px/s (el auto-scroll por fotograma daba 3 000 px/s a 120 Hz).
      expect(delta / elapsed).toBeLessThan(900);
      // La firma siguio al dedo hacia arriba por la hoja (no se quedo donde estaba al desplazarse la pagina).
      expect(yBefore - (await norm())).toBeGreaterThan(0.12);
    } finally {
      await close();
    }
  });

  test("con zoom 3x el pan llega a TODA la hoja (no se detiene a 400 px)", async ({ browser }) => {
    // iPad horizontal: la hoja mide ~460 px y con zoom 3 su centro puede alejarse 460 px (el limite antiguo era 400).
    const { page, cdp, close } = await openSession(browser, "ipadLandscape");
    try {
      await zoomIn(page);
      await zoomIn(page);
      await zoomIn(page);
      expect(await zoomPercent(page)).toBe(300);
      const sheet = await boxOf(host(page));
      const clip = await boxOf(page.locator('[data-canvas="host"]').locator(".."));
      const y = Math.min(sheet.y + sheet.height / 2, 700);
      for (let index = 0; index < 6; index += 1) {
        await touchDrag(cdp, { x: clip.x + clip.width - 40, y }, { x: clip.x + 40, y }, { steps: 8, stepMs: 10 });
        await page.waitForTimeout(60);
      }
      const t = await hostTransform(page);
      // maxX = ancho * (zoom - 1) / 2: con la hoja de ~460 px son ~460 px, mas que el antiguo limite de 400.
      expect(Math.abs(t.x)).toBeGreaterThan(420);
      const after = await boxOf(host(page));
      expect(after.x + after.width).toBeLessThanOrEqual(clip.x + clip.width + 14);
    } finally {
      await close();
    }
  });

  test("pellizco con deriva grande no se frena a 400 px", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "ipadLandscape");
    try {
      const sheet = await boxOf(host(page));
      const center = { x: sheet.x + sheet.width / 2, y: Math.min(sheet.y + sheet.height / 2, 600) };
      await touchPinch(cdp, center, 90, 300, { steps: 16, stepMs: 14, drift: { x: -520, y: 0 } });
      await page.waitForTimeout(300);
      const t = await hostTransform(page);
      expect(t.scale).toBeGreaterThan(2.2);
      expect(Math.abs(t.x)).toBeGreaterThan(420);
    } finally {
      await close();
    }
  });
});

test.describe("API del lienzo: «ver este hueco» (scrollIntoViewRect)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "El lienzo se prepara con el tacto de Chromium");

  /** Pide el desplazamiento por el evento de `window` (el mismo contrato que `apiRef.scrollIntoViewRect`). */
  const reveal = (page: Page, rect: { x: number; y: number; width: number; height: number }, options: object = {}) =>
    page.evaluate(
      ([rect, options]) => window.dispatchEvent(new CustomEvent("optimus:canvas:reveal", { detail: { rect, options } })),
      [rect, options] as const,
    );

  /**
   * Centro (px de pantalla) de una fraccion de la hoja y la zona libre: entre la barra de zoom y la capa fija o pegajosa
   * mas alta de abajo (tab bar, barra «Opciones/Procesar» y el dock plegable de la paleta), medida con `visibleBand`.
   */
  const probe = async (page: Page, rect: { x: number; y: number; width: number; height: number }) => {
    const band = await visibleBand(page);
    return page.evaluate(
      ([rect, band]) => {
        const sheet = document.querySelector<HTMLElement>('[data-canvas="host"]')!.getBoundingClientRect();
        return {
          top: sheet.top + rect.y * sheet.height,
          bottom: sheet.top + (rect.y + rect.height) * sheet.height,
          left: sheet.left + rect.x * sheet.width,
          right: sheet.left + (rect.x + rect.width) * sheet.width,
          freeTop: band.top,
          freeBottom: band.bottom,
          vw: innerWidth,
        };
      },
      [rect, band] as const,
    );
  };

  test("lleva un hueco del pie de una hoja alta a la zona libre (sin tapar por la barra de zoom ni la paleta)", async ({ browser }) => {
    const { page, close } = await openSession(browser, "iphone15", 2, [595, 1700]);
    try {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
      const rect = { x: 0.3, y: 0.9, width: 0.3, height: 0.04 };
      await reveal(page, rect);
      await page.waitForTimeout(400);
      const at = await probe(page, rect);
      expect(at.top).toBeGreaterThanOrEqual(at.freeTop);
      expect(at.bottom).toBeLessThanOrEqual(at.freeBottom);
      // Centrado en la zona libre (+-40 px).
      expect(Math.abs((at.top + at.bottom) / 2 - (at.freeTop + at.freeBottom) / 2)).toBeLessThan(40);
    } finally {
      await close();
    }
  });

  test("con zoom 2x tambien mueve la hoja para dejar el hueco de una esquina dentro de lo que se ve", async ({ browser }) => {
    const { page, close } = await openSession(browser, "iphone15", 2, [595, 1700]);
    try {
      await zoomIn(page);
      await zoomIn(page);
      expect(await zoomPercent(page)).toBe(200);
      const rect = { x: 0.78, y: 0.9, width: 0.15, height: 0.03 };
      await reveal(page, rect);
      await page.waitForTimeout(400);
      const at = await probe(page, rect);
      expect(at.left).toBeGreaterThanOrEqual(0);
      expect(at.right).toBeLessThanOrEqual(at.vw);
      expect(at.top).toBeGreaterThanOrEqual(at.freeTop);
      expect(at.bottom).toBeLessThanOrEqual(at.freeBottom);
    } finally {
      await close();
    }
  });

  test("pedir un hueco de OTRA pagina cambia de pagina y lo deja a la vista", async ({ browser }) => {
    const { page, close } = await openSession(browser, "iphone15", 3, [595, 1700]);
    try {
      const rect = { x: 0.3, y: 0.5, width: 0.3, height: 0.04 };
      await reveal(page, rect, { pageIndex: 2 });
      await expect(page.getByText(/Página 3 de 3|3 \/ 3|Page 3 of 3/).first()).toBeVisible({ timeout: 8000 });
      await page.waitForTimeout(600);
      const at = await probe(page, rect);
      expect(at.top).toBeGreaterThanOrEqual(at.freeTop);
      expect(at.bottom).toBeLessThanOrEqual(at.freeBottom);
    } finally {
      await close();
    }
  });
});

test.describe("PDF Pro · Firmar usa el mismo lienzo", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "El tacto por CDP solo existe en Chromium");

  test("con «Texto» armada, un dedo sobre la hoja desplaza la region de la hoja y no crea nada", async ({ browser }) => {
    const context = await newTouchContext(browser, "iphone15");
    const page = await context.newPage();
    try {
      const cdp = await cdpOf(page);
      await page.goto("/pdf-pro");
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles({ name: "informe.pdf", mimeType: "application/pdf", buffer: await makeA4Pdf("PRO", 3, [595, 1700]) });
      await page.locator('[data-dock="sign"]').click();
      await host(page).scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const region = () =>
        page.evaluate(() => {
          for (let node: Element | null = document.querySelector('[data-canvas="host"]'); node; node = node.parentElement) {
            if (getComputedStyle(node).overflowY === "auto" && node.scrollHeight > node.clientHeight) return Math.round(node.scrollTop);
          }
          return -1;
        });
      await pickTool(page, /^Texto$|^Text$/);
      // Un punto de la hoja que SI se ve: la cabecera de Firmar (conmutadores y avisos) no se desplaza y ocupa la franja de arriba.
      const { x, y } = await sheetPoint(page, 0.5, 0.5);
      const before = await region();
      await touchDrag(cdp, { x, y }, { x, y: y - 220 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(500);
      expect((await region()) - before).toBeGreaterThan(120);
      await expect(page.locator('[data-element-kind="text"][data-drag-mode="move"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
