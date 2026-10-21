import { expect, test, type Browser } from "@playwright/test";
import {
  boxOf,
  cdpOf,
  isChromium,
  newTouchContext,
  openSignWithPdf,
  openSoloCanvasWithSignature,
  pickTool,
  revealSheet,
  sheetPoint,
  touchDrag,
  touchTap,
  type DeviceName,
} from "../helpers/touch-gestures";
import { contrastOf, minGapBetweenControls, smallTargets } from "../helpers/touch-measure";
import { goToTab, openProPdf } from "../helpers/pro-flow";

/**
 * M3 · UI base y lienzo compartido en movil e iPad (VI-01, VI-04, VI-05, VI-06, VI-07, SC-04 de
 * `docs/AUDITORIA-MOVIL-IPAD.md`). Headless siempre; PDF sinteticos.
 *
 * Los que no necesitan tacto por CDP corren tambien en WebKit (`PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1`).
 */

test.setTimeout(180_000);

async function newPage(browser: Browser, device: DeviceName, scheme: "light" | "dark" = "light") {
  const context = await newTouchContext(browser, device, { colorScheme: scheme });
  const page = await context.newPage();
  return { page, context };
}

/** Toque en `at` con el motor disponible (CDP en Chromium; `touchscreen` en WebKit). */
async function tap(page: import("@playwright/test").Page, at: { x: number; y: number }): Promise<void> {
  if (isChromium(page)) await touchTap(await cdpOf(page), at);
  else await page.touchscreen.tap(at.x, at.y);
}

/* ------------------------------------------------------------------ *
 * VI-01 · el texto «Crea tu firma para poder colocarla…» no se aplasta ni lo pisan los botones
 * ------------------------------------------------------------------ */
test.describe("VI-01 · estado vacio del lienzo de «Solo yo»", () => {
  for (const device of ["se320", "se375", "iphone15", "ipadMini", "ipadPortrait"] as DeviceName[]) {
    test(`${device}: el texto tiene ancho legible y no se solapa con los botones`, async ({ browser }) => {
      const { page, context } = await newPage(browser, device);
      try {
        await openSignWithPdf(page, 1);
        // Con el layout de tablet el mismo texto sale tambien como aviso del panel de opciones: el del lienzo es el primero.
        const note = page.getByText("Crea tu firma para poder colocarla sobre el documento.").first();
        await expect(note).toBeVisible();
        // Una sola lectura en la pagina (sin animaciones a medias entre medida y medida): el texto y los botones que lo acompanan.
        const read = await note.evaluate((el) => {
          const box = (node: Element) => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          const row = el.parentElement!;
          return { note: box(el), buttons: [...row.querySelectorAll("button")].map((button) => ({ name: button.textContent?.trim() ?? "", ...box(button) })) };
        });
        // Una palabra por linea eran ~40 px: una columna legible mide al menos 200 px (o todo el ancho si no cabe).
        expect(read.note.width).toBeGreaterThanOrEqual(Math.min(200, page.viewportSize()!.width - 64));
        // Como mucho cuatro lineas (interlineado de ~20 px, fuente ancha incluida).
        expect(read.note.height).toBeLessThan(96);
        const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
          a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
        expect(read.buttons.length).toBeGreaterThan(0);
        for (const button of read.buttons) expect(overlaps(read.note, button), `texto y «${button.name}» se solapan`).toBe(false);
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * VI-04 · la paleta flotante no queda tapada por la barra de zoom ni por la hoja
 * ------------------------------------------------------------------ */
test.describe("VI-04 · la paleta del lienzo siempre se puede tocar", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Usa el tacto de Chromium para crear la firma");

  for (const device of ["se375", "iphone15", "ipadLandscape"] as DeviceName[]) {
    test(`${device}: recorriendo la pagina, ningun boton de la paleta queda cubierto por otro elemento`, async ({ browser }) => {
      const { page, context } = await newPage(browser, device);
      try {
        const cdp = await cdpOf(page);
        await openSoloCanvasWithSignature(page, cdp, 3);
        const failures: string[] = [];
        for (const y of [0, 200, 400, 600, 800, 1000, 1200, 1500, 2000, 99999]) {
          await page.evaluate((top) => window.scrollTo(0, top), y);
          await page.waitForTimeout(160);
          const covered = await page.evaluate(() => {
            const bad: string[] = [];
            for (const button of document.querySelectorAll<HTMLElement>("[data-palette-item]")) {
              const r = button.getBoundingClientRect();
              // Solo los botones que se ven enteros: uno a medio salir de la pantalla no es un solapamiento.
              if (r.top < 0 || r.bottom > innerHeight || r.width < 2) continue;
              const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              if (hit && hit !== button && !button.contains(hit)) {
                bad.push(`${button.dataset.paletteItem} tapado por ${hit.getAttribute("aria-label") ?? hit.tagName}`);
              }
            }
            return bad;
          });
          if (covered.length) failures.push(`scrollY=${y}: ${covered.join("; ")}`);
        }
        expect(failures).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * VI-05 · objetivos de 44 px con puntero grueso en los layouts de iPad
 * ------------------------------------------------------------------ */
test.describe("VI-05 · objetivos tactiles de 44 px", () => {
  for (const device of ["ipadPortrait", "ipadLandscape", "iphone15"] as DeviceName[]) {
    test(`${device}: la cabecera, la barra lateral y los botones de «Firmar» miden 44 px`, async ({ browser }) => {
      const { page, context } = await newPage(browser, device);
      try {
        await page.goto("/sign-pdf");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const small = [
          ...(await smallTargets(page, "header")),
          ...(await smallTargets(page, "aside")),
          ...(await smallTargets(page, "main")),
        ];
        expect(small, `controles por debajo de 44 px en ${device}`).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test("iphone15: zoom, paginas, «Quitar todo de esta pagina» y la barra del campo miden 44 px", async ({ browser }) => {
    const { page, context } = await newPage(browser, "iphone15");
    try {
      await openSignWithPdf(page, 2);
      expect(await smallTargets(page, "[data-canvas-sticky]"), "barra de zoom y paginas").toEqual([]);
      const clear = page.getByRole("button", { name: /Quitar todo de esta p[aá]gina/ });
      await expect(clear.first()).toBeVisible();
      expect((await boxOf(clear.first())).height).toBeGreaterThanOrEqual(43.5);
      // Barra del campo seleccionado: se arma «Texto» y se toca la hoja.
      await revealSheet(page);
      await pickTool(page, /^Texto$|^Text$/);
      await tap(page, await sheetPoint(page, 0.4, 0.3));
      await expect(page.locator('[data-element-kind="text"][data-drag-mode="move"]')).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-floating-bar]")).toBeVisible();
      // La barra entra con un muelle (escala 0,96 -> 1): se mide ya asentada.
      await page.waitForTimeout(900);
      expect(await smallTargets(page, "[data-floating-bar]")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("iphone15: el tirador de tamano tiene una zona de agarre de al menos 44 px aunque se dibuje de 24", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "La firma se crea con el tacto de Chromium");
    const { page, context } = await newPage(browser, "iphone15");
    try {
      const cdp = await cdpOf(page);
      await openSoloCanvasWithSignature(page, cdp, 1);
      const handle = page.locator('[data-drag-mode="resize"]').first();
      await handle.scrollIntoViewIfNeeded();
      const box = await boxOf(handle);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // A 20 px del centro (zona de 44 px) el toque sigue llegando al tirador.
      const reach = await page.evaluate(
        ([x, y]) => {
          const hit = (px: number, py: number) => Boolean(document.elementFromPoint(px, py)?.closest('[data-drag-mode="resize"]'));
          return [hit(x + 20, y), hit(x - 20, y), hit(x, y + 20), hit(x, y - 20)];
        },
        [cx, cy],
      );
      expect(reach).toEqual([true, true, true, true]);
    } finally {
      await context.close();
    }
  });
});

test.describe("VI-05 · tirador de un elemento diminuto", () => {
  test("iphone15: el tirador que sale de la caja tambien tiene 44 px de zona de agarre y no pisa el cuerpo del campo", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "El campo se dibuja con el tacto de Chromium");
    const { page, context } = await newPage(browser, "iphone15");
    try {
      const cdp = await cdpOf(page);
      await openSignWithPdf(page, 1);
      await revealSheet(page);
      await pickTool(page, /^Texto$|^Text$/);
      const from = await sheetPoint(page, 0.3, 0.3);
      // Mantener y arrastrar dibuja un campo de ~26 x 16 px: diminuto (los dos lados < 40 px).
      await touchDrag(cdp, from, { x: from.x + 26, y: from.y + 16 }, { holdMs: 450, steps: 6, stepMs: 14 });
      const field = page.locator('[data-element-kind="text"][data-drag-mode="move"]').first();
      await expect(field).toBeVisible();
      await page.keyboard.press("Escape");
      const handle = page.locator('[data-drag-mode="resize"]').first();
      await expect(handle).toBeVisible();
      const f = await boxOf(field);
      // La barra del campo puede cubrir parte de la zona (es un vecino, no el tirador): se mide la caja de su pseudo-elemento.
      const zone = await handle.evaluate((el) => {
        const style = getComputedStyle(el, "::before");
        return { w: parseFloat(style.width), h: parseFloat(style.height) };
      });
      expect(zone.w, "zona de agarre (ancho)").toBeGreaterThanOrEqual(43.5);
      expect(zone.h, "zona de agarre (alto)").toBeGreaterThanOrEqual(43.5);
      // El centro del campo sigue siendo del campo (el tirador no lo pisa).
      const body = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest("[data-drag-mode]")?.getAttribute("data-drag-mode"),
        [f.x + f.width / 2, f.y + f.height / 2],
      );
      expect(body).toBe("move");
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * VI-06 · botones deshabilitados legibles (>= 3:1) y que no parecen activos
 * ------------------------------------------------------------------ */
test.describe("VI-06 · estado deshabilitado", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: «Procesar» deshabilitado se lee a >= 4,5:1 y no es azul`, async ({ browser }) => {
      const { page, context } = await newPage(browser, "iphone15", scheme);
      try {
        await openSignWithPdf(page, 1);
        const run = page.getByRole("button", { name: "Procesar" });
        await expect(run).toBeVisible();
        await expect(run).toBeDisabled();
        const reading = await contrastOf(run);
        expect(reading.ratio, `contraste ${reading.fg} sobre ${reading.bg}`).toBeGreaterThanOrEqual(4.5);
        expect(reading.opacity).toBe(1);
        // No parece activo: el relleno no es el azul de marca (b >> r).
        const [r, , b] = reading.bg.match(/\d+/g)!.map(Number);
        expect(b - r, `relleno ${reading.bg}`).toBeLessThan(40);
      } finally {
        await context.close();
      }
    });

    test(`${scheme}: los secundarios y «ghost» deshabilitados se leen a >= 3:1`, async ({ browser }) => {
      const { page, context } = await newPage(browser, "iphone15", scheme);
      try {
        await openSignWithPdf(page, 1);
        // Sin elementos, «Quitar todo de esta pagina» (secundario) y «Borrar todo el documento» (ghost) estan deshabilitados.
        const buttons = page.locator("main button:disabled").filter({ hasText: /Quitar|Borrar/ });
        const count = await buttons.count();
        expect(count).toBeGreaterThan(0);
        for (let index = 0; index < count; index += 1) {
          const reading = await contrastOf(buttons.nth(index));
          expect(reading.ratio, `${await buttons.nth(index).innerText()}: ${reading.fg} sobre ${reading.bg}`).toBeGreaterThanOrEqual(3);
        }
      } finally {
        await context.close();
      }
    });
  }

  test("PDF Pro: «Aplicar» (aria-disabled) tambien se lee a >= 4,5:1", async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const { page, context } = await newPage(browser, "iphone15", scheme);
      try {
        await openProPdf(page, { pages: 2 });
        await goToTab(page, "edit");
        const apply = page.locator("[data-pro-mode-apply]");
        await expect(apply).toBeVisible();
        await expect(apply).toHaveAttribute("aria-disabled", "true");
        const reading = await contrastOf(apply);
        expect(reading.ratio, `${scheme}: ${reading.fg} sobre ${reading.bg}`).toBeGreaterThanOrEqual(4.5);
      } finally {
        await context.close();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * VI-07 · separacion entre objetivos contiguos
 * ------------------------------------------------------------------ */
test.describe("VI-07 · separacion de 8 px entre botones contiguos", () => {
  for (const device of ["iphone15", "ipadPortrait"] as DeviceName[]) {
    test(`${device}: la barra de zoom y paginas separa sus botones al menos 8 px`, async ({ browser }) => {
      const { page, context } = await newPage(browser, device);
      try {
        await openSignWithPdf(page, 3);
        const closest = await minGapBetweenControls(page, "[data-canvas-sticky]");
        expect(closest, "barra de zoom").not.toBeNull();
        expect(closest!.gap, closest!.pair).toBeGreaterThanOrEqual(8);
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * SC-04 · campos de texto de 16 px con tacto (sin zoom de Safari)
 * ------------------------------------------------------------------ */
test.describe("SC-04 · entradas >= 16 px", () => {
  test("el campo que se escribe sobre la hoja mide 16 px y se ve a su tamano (escalado), llenando el hueco", async ({ browser }) => {
    const { page, context } = await newPage(browser, "iphone15");
    try {
      await openSignWithPdf(page, 1);
      await revealSheet(page);
      await pickTool(page, /^Texto$|^Text$/);
      await tap(page, await sheetPoint(page, 0.4, 0.3));
      const input = page.locator("input[data-canvas-input]");
      await expect(input).toBeVisible();
      const fontSize = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
      // Ocupa exactamente el hueco (la escala compensa los 16 px).
      const group = page.locator('[data-element-kind="text"][data-drag-mode="move"]').first();
      const g = await boxOf(group);
      const i = await boxOf(input);
      expect(Math.abs(i.width - g.width)).toBeLessThan(5);
      expect(Math.abs(i.height - g.height)).toBeLessThan(5);
    } finally {
      await context.close();
    }
  });

  test("iPad horizontal: ningun campo visible de PDF Pro ni de la barra lateral baja de 16 px", async ({ browser }) => {
    const { page, context } = await newPage(browser, "ipadLandscape");
    try {
      await openProPdf(page, { pages: 3 });
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden";
          })
          .map((el) => ({ n: el.getAttribute("aria-label") || el.className.toString().slice(0, 30), fs: parseFloat(getComputedStyle(el).fontSize) }))
          .filter((x) => x.fs < 16),
      );
      expect(small).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("con raton nada cambia: el buscador de la barra lateral conserva su tamano de escritorio", async ({ browser, browserName }) => {
    // El WebKit del emulador de iPad reporta puntero grueso aunque el contexto no lo pida.
    test.skip(browserName !== "chromium", "puntero grueso en WebKit-iPad");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-ES" });
    const page = await context.newPage();
    try {
      await page.goto("/");
      const size = await page.getByRole("searchbox", { name: "Buscar herramienta…", exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeLessThan(16);
    } finally {
      await context.close();
    }
  });
});
