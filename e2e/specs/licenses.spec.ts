import { expect, test, type Page } from "@playwright/test";
import { audioContext, describeViolations, measureOverflow, runAxe, type Language, type Theme } from "../helpers/audio-flow";

/**
 * Pagina `/licenses` (Licencias y avisos de codigo abierto), en Chromium headless:
 *  - carga con 200, un h1, el aviso «MP3 encoding by LAME» con su enlace y las 24 dependencias de ejecucion;
 *  - ES/EN, claro/oscuro, axe 0 y sin desborde horizontal de 320 a 1920 px (tambien con tipografia ancha);
 *  - enlaces externos seguros (otra pestana, rel) y objetivos de 44 px con tacto;
 *  - se llega desde el pie de pagina y desde «El proyecto»; el ancla #mp3 no queda tapada por la cabecera fija;
 *  - ninguna peticion sale del origen (los enlaces no se precargan).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(90_000);

/** Peticiones de la pagina: todas al propio servidor. */
function watchForeign(page: Page): string[] {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.hostname !== "localhost") foreign.push(request.url());
  });
  return foreign;
}

async function open(page: Page, hash = "") {
  const response = await page.goto(`/licenses${hash}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test.describe("Licencias", () => {
  test("carga con 200 y muestra el aviso de LAME, MPL-2.0 y LGPL, el codigo fuente por version exacta y las 24 dependencias", async ({ page }) => {
    const foreign = watchForeign(page);
    await open(page);
    await expect(page).toHaveTitle(/Licencias y avisos/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Licencias y avisos de código abierto");

    const notice = page.locator("[data-lame-notice]");
    await expect(notice.locator("p[lang=en]")).toContainText("MP3 encoding by LAME");
    await expect(notice.getByRole("link", { name: /LAME/ })).toHaveAttribute("href", "https://lame.sourceforge.io/");

    const mp3 = page.locator("#mp3");
    for (const text of ["mediabunny", "@mediabunny/mp3-encoder", "MPL-2.0", "LGPL, versión 2 o posterior", "3.100", "Archivos sin modificar", "Cómo sustituir LAME", "Emscripten 4.0.21"]) {
      await expect(mp3).toContainText(text);
    }
    for (const href of [
      "https://github.com/Vanilagy/mediabunny/tree/v1.65.0",
      "https://github.com/Vanilagy/mediabunny/tree/v1.65.0/packages/mp3-encoder",
      "https://www.npmjs.com/package/@mediabunny/mp3-encoder/v/1.65.0",
      "https://sourceforge.net/projects/lame/files/lame/3.100/",
      "https://www.mozilla.org/en-US/MPL/2.0/",
      "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html",
    ]) {
      await expect(mp3.locator(`a[href="${href}"]`).first()).toBeAttached();
    }

    await expect(page.locator("[data-packages] > li")).toHaveCount(24);
    await expect(page.locator('[data-package="parse5"]')).toContainText("MIT");
    await expect(page.locator('[data-package="parse5"]')).toContainText("En el servidor");
    await expect(page.locator('[data-package="jszip"]')).toContainText("se usa bajo MIT");
    expect(foreign).toEqual([]);
  });

  test("todo enlace externo abre otra pestana con rel seguro; los textos de licencia son enlaces canonicos (no se pegan)", async ({ page }) => {
    await open(page);
    const issues = await page.evaluate(() => {
      const bad: string[] = [];
      for (const a of document.querySelectorAll<HTMLAnchorElement>('main a[href^="http"], #content a[href^="http"]')) {
        if (a.target !== "_blank" || a.rel !== "noopener noreferrer") bad.push(`${a.href}: target=${a.target} rel=${a.rel}`);
        if (!a.querySelector(".sr-only")) bad.push(`${a.href}: sin aviso de nueva pestana`);
      }
      return { bad, total: document.querySelectorAll('a[href^="http"]').length, length: (document.body.innerText || "").length };
    });
    expect(issues.bad).toEqual([]);
    expect(issues.total).toBeGreaterThan(80);
    expect(issues.length).toBeLessThan(30_000);
  });

  test("ingles: titulo, aviso y secciones salen en ingles", async ({ browser }) => {
    const context = await audioContext(browser, { width: 1280, language: "en" });
    const page = await context.newPage();
    try {
      await open(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Licences and open-source notices");
      await expect(page.locator("#mp3")).toContainText("LGPL, version 2 or later");
      await expect(page.locator("#mp3")).toContainText("How to replace LAME");
      await expect(page.locator('[data-package="jszip"]')).toContainText("used under MIT");
      await expect(page.getByRole("heading", { level: 2, name: "Components included in the app" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("se llega desde el pie de pagina y desde «El proyecto»", async ({ page }) => {
    await page.goto("/privacy", { waitUntil: "networkidle" });
    const footerLink = page.locator('footer a[href="/licenses"]');
    await expect(footerLink).toHaveText("Licencias");
    await footerLink.click();
    await expect(page).toHaveURL(/\/licenses$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Licencias y avisos de código abierto");

    await page.goto("/about", { waitUntil: "networkidle" });
    const card = page.locator("[data-about-licenses]");
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: "Ver licencias y avisos" }).click();
    await expect(page).toHaveURL(/\/licenses$/);
  });

  test("el ancla /licenses#mp3 deja el titulo de la seccion a la vista, por debajo de la cabecera fija (movil)", async ({ browser }) => {
    const context = await audioContext(browser, { width: 375, touch: true });
    const page = await context.newPage();
    try {
      await open(page, "#mp3");
      await expect.poll(async () => page.evaluate(() => Math.round(document.getElementById("mp3-title")?.getBoundingClientRect().top ?? -1))).toBeGreaterThan(40);
      const clear = await page.evaluate(() => {
        const header = document.querySelector("header");
        const bottom = header && getComputedStyle(header).position === "fixed" ? header.getBoundingClientRect().bottom : 0;
        return (document.getElementById("mp3-title")?.getBoundingClientRect().top ?? 0) >= bottom - 1;
      });
      expect(clear).toBe(true);
    } finally {
      await context.close();
    }
  });
});

const MATRIX: Array<{ width: number; theme: Theme; language: Language; wide: boolean }> = [
  { width: 1920, theme: "dark", language: "es", wide: false },
  { width: 1280, theme: "light", language: "en", wide: false },
  { width: 768, theme: "dark", language: "es", wide: false },
  { width: 375, theme: "light", language: "en", wide: false },
  { width: 320, theme: "dark", language: "es", wide: true },
  { width: 320, theme: "light", language: "en", wide: true },
];

test.describe("Licencias · accesibilidad y maquetacion", () => {
  for (const cell of MATRIX) {
    test(`axe 0, sin desborde y objetivos tactiles: ${cell.width}px · ${cell.theme} · ${cell.language}${cell.wide ? " · tipografia ancha" : ""}`, async ({ browser }) => {
      const context = await audioContext(browser, { ...cell, touch: cell.width < 600 });
      const page = await context.newPage();
      try {
        await open(page);
        const axe = await runAxe(page);
        expect(axe, `axe\n${describeViolations(axe)}`).toEqual([]);
        const measured = await measureOverflow(page);
        expect(measured.overflow, JSON.stringify(measured.offenders)).toBeLessThanOrEqual(1);
        expect(measured.offenders).toEqual([]);

        // Nada se corta: ninguna caja con texto es mas ancha que su tarjeta (nombres largos, hashes, licencias compuestas).
        const clipped = await page.evaluate(() => {
          const bad: string[] = [];
          for (const element of document.querySelectorAll<HTMLElement>("#content h3, #content h4, #content li > p, #content a, #content [class*=rounded-full]")) {
            if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible") bad.push(`${element.tagName.toLowerCase()} ${element.textContent?.trim().slice(0, 30)}`);
          }
          return bad;
        });
        expect(clipped).toEqual([]);

        if (cell.width < 600) {
          const small = await page.evaluate(() => {
            const bad: string[] = [];
            for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-packages] a, [data-assets] a, #mp3 ul a")) {
              const rect = a.getBoundingClientRect();
              if (rect.width > 0 && rect.height < 43.5) bad.push(`${(a.textContent ?? "").trim().slice(0, 30)} ${Math.round(rect.height)}px`);
            }
            return bad;
          });
          expect(small, "enlaces de menos de 44 px con tacto").toEqual([]);
        }
        // El texto de cuerpo no baja de 12 px y el contenido principal tiene landmark.
        const sizes = await page.evaluate(() => Math.min(...Array.from(document.querySelectorAll<HTMLElement>("#content p, #content li")).map((element) => parseFloat(getComputedStyle(element).fontSize))));
        expect(sizes).toBeGreaterThanOrEqual(12);
      } finally {
        await context.close();
      }
    });
  }
});
