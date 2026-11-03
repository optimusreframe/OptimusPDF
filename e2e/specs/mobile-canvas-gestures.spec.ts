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
 *  - GE-01: con una herramienta armada el dedo no debe quedarse sin poder mover la pagina (`touch-action: none` en todo el
 *    lienzo era una trampa de scroll). W3-A3 lo resuelve en DOS modos (`docs/PLAN-FIRMA-AGIL.md`, «W3-A3», y `src/lib/touch/README.md`):
 *      · por defecto («Un dedo dibuja» encendido, preferencia `optimuspdf.sign.fingerDraw`): UN dedo dibuja de inmediato (la hoja es
 *        `touch-none`), un arrastre largo y vertical de un dedo no crea nada y recuerda la pista, y DOS dedos mueven la pagina;
 *      · con «Un dedo dibuja» apagado (`"0"` en localStorage o el interruptor): un dedo que desliza desplaza la pagina y no crea nada
 *        (toque = colocar, mantener ~260 ms y arrastrar = dibujar).
 *  - Pellizco propio: acerca la hoja alrededor del punto central de los dedos, sin zoom de pagina.
 *  - GE-06: arrastrar un elemento hacia el borde desplaza (por TIEMPO, no por fotograma) y el pan con zoom llega a
 *    toda la hoja (no a +-400 px).
 *
 * Headless siempre.
 */

test.setTimeout(180_000);

type Session = { page: Page; cdp: CDPSession; close: () => Promise<void> };

/** Preferencia «Un dedo dibuja» (W3-A3): ausente o distinta de `"0"` = encendida; `"0"` = apagada. */
const FINGER_DRAW_KEY = "optimuspdf.sign.fingerDraw";
/** La pista de la primera vez («Un dedo dibuja · dos dedos mueven la pagina») ya se vio: no sale al armar la herramienta. */
const FINGER_HINT_KEY = "optimuspdf.sign.fingerDrawHint";

type PrefOptions = {
  /** `false` deja «Un dedo dibuja» apagado desde el principio (como si la persona lo hubiera apagado antes). */
  fingerDraw?: boolean;
  /** `true` da por vista la pista de la primera vez (para poder comprobar que un arrastre vertical la recuerda). */
  hintSeen?: boolean;
};

/** Escribe las preferencias en localStorage antes de que cargue la pagina (con try/catch: sin almacenamiento no pasa nada). */
async function applyPrefs(context: Awaited<ReturnType<typeof newTouchContext>>, prefs: PrefOptions): Promise<void> {
  await context.addInitScript(
    ([drawKey, hintKey, fingerDraw, hintSeen]) => {
      try {
        if (fingerDraw === false) window.localStorage.setItem(drawKey as string, "0");
        if (hintSeen === true) window.localStorage.setItem(hintKey as string, "1");
      } catch {
        /* sin almacenamiento */
      }
    },
    [FINGER_DRAW_KEY, FINGER_HINT_KEY, prefs.fingerDraw, prefs.hintSeen] as const,
  );
}

async function openSession(
  browser: Parameters<typeof newTouchContext>[0],
  device: DeviceName,
  pages = 2,
  size?: readonly [number, number],
  prefs: PrefOptions = {},
): Promise<Session> {
  const context = await newTouchContext(browser, device);
  await applyPrefs(context, prefs);
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

/** Campos de texto colocados (el contenedor movible de cada uno). */
const TEXT_FIELDS = '[data-element-kind="text"][data-drag-mode="move"]';
const FINGER_SWITCH = "[data-finger-draw-toggle]";
const FINGER_HINT = "[data-finger-hint]";

/** Lleva la hoja al centro de la pantalla: asi un arrastre vertical corto queda lejos de las zonas de borde (auto-desplazamiento). */
async function centerSheet(page: Page): Promise<void> {
  await host(page).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(350);
}

test.describe("GE-01 · gestos de un dedo y de dos con una herramienta armada (por defecto un dedo dibuja; apagado, desplaza)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "El tacto por CDP solo existe en Chromium");

  test("con «Un dedo dibuja» apagado y «Texto» armada, deslizar sobre la hoja desplaza la pagina y no crea nada", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15", 2, undefined, { fingerDraw: false });
    try {
      await pickTool(page, /^Texto$|^Text$/);
      // La preferencia apagada se leyo: el interruptor lo dice y la hoja deja pasar el desplazamiento del dedo.
      await expect(page.locator(FINGER_SWITCH)).toHaveAttribute("aria-checked", "false");
      const sheet = await boxOf(host(page));
      const before = await scrollY(page);
      const x = sheet.x + sheet.width * 0.5;
      // Sobre el texto de la hoja (la firma colocada esta mas abajo y lleva su propio `touch-none`).
      const y = Math.min(sheet.y + sheet.height * 0.35, 520);
      await touchDrag(cdp, { x, y }, { x, y: y - 260 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(500);
      expect((await scrollY(page)) - before).toBeGreaterThan(120);
      // Deslizar no es colocar: no hay campos nuevos y la herramienta sigue armada.
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(0);
      await expect(host(page)).toHaveAttribute("data-tool", "text");
    } finally {
      await close();
    }
  });

  test("por defecto, con «Texto» armada, un dedo que arrastra sobre la hoja crea el campo y la pagina no se desplaza", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      await pickTool(page, /^Texto$|^Text$/);
      // Por defecto «Un dedo dibuja» esta encendido y la hoja no cede el gesto al navegador.
      await expect(page.locator(FINGER_SWITCH)).toHaveAttribute("aria-checked", "true");
      await expect(host(page)).toHaveCSS("touch-action", "none");
      await centerSheet(page);
      const from = await sheetPoint(page, 0.2, 0.4);
      const before = await scrollY(page);
      // Sin esperar quieto: el dedo dibuja de inmediato (a diferencia del modo apagado). El dedo sigue apoyado 600 ms para medir
      // la pagina MIENTRAS dibuja (al soltar, el campo nuevo se abre para escribir y el navegador puede acercarlo a la vista).
      const drag = touchDrag(cdp, from, { x: from.x + 150, y: from.y + 50 }, { steps: 10, stepMs: 14, endHoldMs: 600 });
      await page.waitForTimeout(10 * 14 + 300);
      const during = await scrollY(page);
      await drag;
      const field = page.locator(TEXT_FIELDS).first();
      await expect(field).toBeVisible();
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(1);
      const box = await boxOf(field);
      expect(box.width).toBeGreaterThan(110);
      expect(box.width).toBeLessThan(190);
      // La pagina no se movio con el dedo y la herramienta sigue armada para el siguiente campo.
      expect(Math.abs(during - before), "la pagina no se desplazo mientras el dedo dibujaba").toBeLessThan(10);
      await expect(host(page)).toHaveAttribute("data-tool", "text");
    } finally {
      await close();
    }
  });

  test("por defecto, un arrastre largo y vertical de un dedo no crea nada, no desplaza y recuerda la pista", async ({ browser }) => {
    // La pista de la primera vez ya se vio: al armar «Texto» no hay pista y el arrastre vertical es lo que la devuelve.
    const { page, cdp, close } = await openSession(browser, "iphone15", 2, undefined, { hintSeen: true });
    try {
      await pickTool(page, /^Texto$|^Text$/);
      await expect(page.locator(FINGER_HINT)).toHaveCount(0);
      await centerSheet(page);
      // Al margen derecho de la hoja: la firma colocada (centro-abajo) captura su propio dedo y no es la hoja.
      const from = await sheetPoint(page, 0.85, 0.7);
      const before = await scrollY(page);
      await touchDrag(cdp, from, { x: from.x, y: from.y - 140 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(400);
      // Desplazar con un dedo es el habito, no un campo estrecho y alto: nada creado, la pagina donde estaba y la pista de vuelta.
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(0);
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThan(10);
      await expect(page.locator(FINGER_HINT)).toBeVisible();
      await expect(host(page)).toHaveAttribute("data-tool", "text");
    } finally {
      await close();
    }
  });

  test("por defecto, con «Texto» armada, dos dedos arrastrando desplazan la pagina y no crean nada ni cambian el zoom", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      await pickTool(page, /^Texto$|^Text$/);
      await centerSheet(page);
      // Sobre el texto de la hoja, por encima de la firma colocada.
      const center = await sheetPoint(page, 0.5, 0.4);
      const before = await scrollY(page);
      // Misma separacion de dedos todo el gesto (sin pellizco): los dos suben 200 px.
      await touchPinch(cdp, center, 120, 120, { steps: 12, stepMs: 14, drift: { x: 0, y: -200 } });
      await page.waitForTimeout(500);
      expect((await scrollY(page)) - before).toBeGreaterThan(100);
      expect(await zoomPercent(page)).toBe(100);
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(0);
      await expect(host(page)).toHaveAttribute("data-tool", "text");
    } finally {
      await close();
    }
  });

  for (const fingerDraw of [true, false]) {
    test(`con «Texto» armada y «Un dedo dibuja» ${fingerDraw ? "encendido" : "apagado"}, un toque sigue colocando el campo`, async ({ browser }) => {
      const { page, cdp, close } = await openSession(browser, "iphone15", 2, undefined, { fingerDraw });
      try {
        await pickTool(page, /^Texto$|^Text$/);
        await touchTap(cdp, await sheetPoint(page, 0.4, 0.3));
        await expect(page.locator(TEXT_FIELDS)).toHaveCount(1);
      } finally {
        await close();
      }
    });
  }

  for (const fingerDraw of [true, false]) {
    test(`con la herramienta armada y «Un dedo dibuja» ${fingerDraw ? "encendido" : "apagado"}, mantener y arrastrar dibuja un campo del tamano elegido`, async ({
      browser,
    }) => {
      const { page, cdp, close } = await openSession(browser, "iphone15", 2, undefined, { fingerDraw });
      try {
        await pickTool(page, /^Texto$|^Text$/);
        const from = await sheetPoint(page, 0.2, 0.25);
        await touchDrag(cdp, from, { x: from.x + 150, y: from.y + 50 }, { holdMs: 450, steps: 10, stepMs: 14 });
        const field = page.locator(TEXT_FIELDS).first();
        await expect(field).toBeVisible();
        const box = await boxOf(field);
        expect(box.width).toBeGreaterThan(110);
        expect(box.width).toBeLessThan(190);
      } finally {
        await close();
      }
    });
  }

  test("el interruptor «Un dedo dibuja» cambia entre los dos modos y se recuerda", async ({ browser }) => {
    const { page, cdp, close } = await openSession(browser, "iphone15");
    try {
      await pickTool(page, /^Texto$|^Text$/);
      const toggle = page.locator(FINGER_SWITCH);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(await page.evaluate((key) => window.localStorage.getItem(key), FINGER_DRAW_KEY)).toBe("0");
      // Apagado, un dedo que desliza desplaza la pagina (el modo de siempre).
      await centerSheet(page);
      const from = await sheetPoint(page, 0.85, 0.7);
      const before = await scrollY(page);
      await touchDrag(cdp, from, { x: from.x, y: from.y - 160 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(500);
      expect((await scrollY(page)) - before).toBeGreaterThan(80);
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(0);
      // Encendido otra vez: queda guardado y el dedo vuelve a dibujar.
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(await page.evaluate((key) => window.localStorage.getItem(key), FINGER_DRAW_KEY)).toBe("1");
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

  /** Abre PDF Pro con un PDF alto, entra en Firmar y arma «Texto». La region que se desplaza es la de la hoja (no la pagina). */
  async function openProSign(browser: Parameters<typeof newTouchContext>[0], prefs: PrefOptions = {}) {
    const context = await newTouchContext(browser, "iphone15");
    await applyPrefs(context, prefs);
    const page = await context.newPage();
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
    return { context, page, cdp, region };
  }

  test("con «Un dedo dibuja» apagado y «Texto» armada, un dedo sobre la hoja desplaza la region de la hoja y no crea nada", async ({ browser }) => {
    const { context, page, cdp, region } = await openProSign(browser, { fingerDraw: false });
    try {
      await expect(page.locator(FINGER_SWITCH)).toHaveAttribute("aria-checked", "false");
      // Un punto de la hoja que SI se ve: la cabecera de Firmar (conmutadores y avisos) no se desplaza y ocupa la franja de arriba.
      const { x, y } = await sheetPoint(page, 0.5, 0.5);
      const before = await region();
      await touchDrag(cdp, { x, y }, { x, y: y - 220 }, { steps: 10, stepMs: 12 });
      await page.waitForTimeout(500);
      expect((await region()) - before).toBeGreaterThan(120);
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("por defecto, con «Texto» armada, un dedo que arrastra sobre la hoja crea el campo y la region no se desplaza", async ({ browser }) => {
    const { context, page, cdp, region } = await openProSign(browser);
    try {
      await expect(page.locator(FINGER_SWITCH)).toHaveAttribute("aria-checked", "true");
      await expect(host(page)).toHaveCSS("touch-action", "none");
      const from = await sheetPoint(page, 0.2, 0.5);
      const before = await region();
      // El dedo sigue apoyado 600 ms para medir la region MIENTRAS dibuja (al soltar el campo se abre para escribir).
      const drag = touchDrag(cdp, from, { x: from.x + 150, y: from.y + 50 }, { steps: 10, stepMs: 14, endHoldMs: 600 });
      await page.waitForTimeout(10 * 14 + 300);
      const during = await region();
      await drag;
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(1);
      expect(Math.abs(during - before), "la region no se desplazo mientras el dedo dibujaba").toBeLessThan(10);
      await expect(host(page)).toHaveAttribute("data-tool", "text");
    } finally {
      await context.close();
    }
  });

  test("por defecto, con «Texto» armada, dos dedos arrastrando desplazan la region de la hoja y no crean nada", async ({ browser }) => {
    const { context, page, cdp, region } = await openProSign(browser);
    try {
      const center = await sheetPoint(page, 0.5, 0.6);
      const before = await region();
      await touchPinch(cdp, center, 120, 120, { steps: 12, stepMs: 14, drift: { x: 0, y: -220 } });
      await page.waitForTimeout(500);
      expect((await region()) - before).toBeGreaterThan(100);
      await expect(page.locator(TEXT_FIELDS)).toHaveCount(0);
      await expect(host(page)).toHaveAttribute("data-tool", "text");
    } finally {
      await context.close();
    }
  });
});
