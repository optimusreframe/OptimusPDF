import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { drawInOpenComposer, fileInput } from "../helpers/sign-flow";
import { makeContract } from "../helpers/template-pdfs";
import { openEditorWithFile, placeInitialsLine, placeSignatureBlock } from "../helpers/template-flow";
import { downloadBytes } from "../helpers/downloads";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";

/**
 * Firma agil · Fase 2 (U2.3/U2.4): las pantallas NUEVAS de plantillas no desbordan en horizontal a 375 ni a 320 px con una
 * tipografia ANCHA (DejaVu Sans / Verdana + 6 % de espaciado), en claro y oscuro, ES y EN, con y sin tactil: el editor
 * «Configurar plantilla» (con sugerencias y un campo de texto), la pregunta «Parece la plantilla X», el aviso de plantilla
 * aplicada con las paginas a revisar, el aviso del automapeo con sus sugerencias y la oferta final «¿Guardar como plantilla?».
 * Misma medida que `sign-wide-font.spec.ts`. Headless siempre.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(240_000);

/** Pantallas de telefono: las anchuras mas habituales (iPhone 375) y las mas estrechas que aun se usan (320). */
const PHONE_WIDTHS = [375, 320] as const;
const PHONE_HEIGHT = 812;
const DESKTOP = { width: 1280, height: 900 } as const;

/**
 * Fuente ancha de sustitucion y un 6 % de espaciado entre letras (la guia WCAG 1.4.12 de espaciado de texto llega a 12 %),
 * aplicados con `!important` a toda la pagina. Es un margen, no el caso real: solo DejaVu Sans ya desbordaba 3 px.
 */
const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

type Theme = "light" | "dark";
type Language = "es" | "en";
type Cell = { theme: Theme; language: Language; touch: boolean };

const CELLS: Cell[] = [
  { theme: "light", language: "es", touch: true },
  { theme: "dark", language: "en", touch: true },
  { theme: "dark", language: "es", touch: false },
  { theme: "light", language: "en", touch: false },
];

/** Contexto con tema, idioma y tipografia ancha desde la primera carga (una hoja de estilo adoptada: no toca el DOM). */
async function newWideContext(browser: Browser, cell: Cell): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: cell.theme,
    hasTouch: cell.touch,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([theme, language, css]) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      // UNA sola vez por pestana: una recarga no pisa el idioma que la prueba cambie despues.
      if (window.sessionStorage.getItem("__seeded")) return;
      window.localStorage.setItem("optimuspdf.theme", theme);
      window.localStorage.setItem("optimuspdf.language", language);
      window.sessionStorage.setItem("__seeded", "1");
    },
    [cell.theme, cell.language, WIDE_CSS],
  );
  return context;
}

/** La fuente forzada ES mas ancha que Arial (si no, la prueba no probaria nada en esta maquina). */
async function expectWideFontActive(page: Page, language: Language): Promise<void> {
  // `<html lang>` sale de la build como «es» y pasa al idioma guardado cuando React hidrata (useSyncExternalStore). Con la CPU
  // apretada (runner de CI) eso tarda mas que el primer vistazo: sin esperar, `fitsEverywhere` tomaba «es» por el idioma de
  // origen de una celda EN y la prueba buscaba «Several signers» en una pantalla en espanol.
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  const ratio = await page.evaluate(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    const probe = "Sí, firmar otro con los mismos firmantes";
    context.font = "16px Arial";
    const narrow = context.measureText(probe).width;
    context.font = '16px "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif';
    return context.measureText(probe).width / narrow;
  });
  expect(ratio, "la fuente ancha forzada debe medir al menos un 8 % mas que Arial").toBeGreaterThan(1.08);
  const applied = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(applied).toMatch(/DejaVu Sans|Verdana|Trebuchet/);
}

type Offender = { tag: string; cls: string; text: string; left: number; right: number; width: number };
type Measure = { overflow: number; clientWidth: number; offenders: Offender[] };

/** Cuanto se desborda la pagina y que elementos asoman por los lados de la pantalla sin quedar recortados. */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const clips = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") return true;
      }
      return false;
    };
    const offenders: Array<{ tag: string; cls: string; text: string; left: number; right: number; width: number }> = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      // Lo invisible (enlace de salto, texto solo para lectores: 1 px) no cuenta.
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right <= clientWidth + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      if (clips(element)) continue;
      offenders.push({
        tag: element.tagName.toLowerCase(),
        cls: String(element.getAttribute("class") ?? "").slice(0, 110),
        text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
      });
    }
    return { overflow: root.scrollWidth - clientWidth, clientWidth, offenders: offenders.slice(0, 8) };
  });
}

/** Mide hasta que se asienta (las tarjetas entran con una animacion): falla si tras 3 s sigue desbordando. */
async function expectFits(page: Page, label: string): Promise<void> {
  let last: Measure | null = null;
  await expect
    .poll(
      async () => {
        last = await measure(page);
        return last.overflow <= 1 && last.offenders.length === 0;
      },
      { message: `«${label}» no desborda en horizontal`, timeout: 3500, intervals: [150, 250, 400] },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `«${label}» desborda a ${last?.clientWidth} px (scrollWidth - clientWidth = ${last?.overflow}); elementos fuera: ${JSON.stringify(last?.offenders)}\n${String(error)}`,
      );
    });
}

/** Cambia de idioma con el selector de la cabecera (el unico visible en pantalla de telefono). */
async function switchLanguage(page: Page, to: Language): Promise<void> {
  const button = page.locator("button[aria-pressed]:visible").filter({ hasText: new RegExp(`^${to.toUpperCase()}$`) }).first();
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("lang", to);
}

/**
 * La pantalla en curso, a 375 y a 320 px, en el idioma actual y (si `both`) tambien en el otro; deja el idioma como
 * estaba y la ventana en escritorio.
 */
async function fitsEverywhere(page: Page, label: string, options: { both?: boolean } = {}): Promise<void> {
  const original = (await page.locator("html").getAttribute("lang")) === "en" ? "en" : "es";
  const other: Language = original === "es" ? "en" : "es";
  try {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: PHONE_HEIGHT });
      await expectFits(page, `${label} · ${original} · ${width}px`);
    }
    if (options.both !== false) {
      await switchLanguage(page, other);
      for (const width of [...PHONE_WIDTHS].reverse()) {
        await page.setViewportSize({ width, height: PHONE_HEIGHT });
        await expectFits(page, `${label} · ${other} · ${width}px`);
      }
      await switchLanguage(page, original);
    }
  } finally {
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(150);
  }
}


const notices = (page: Page) => page.locator("[data-template-notices]");

async function configureAndSave(page: Page, original: Buffer): Promise<void> {
  await openEditorWithFile(page, { name: "Mold Test Agreement.pdf", buffer: original });
  await placeInitialsLine(page);
  await page.getByRole("button", { name: "Repetir iniciales en todas las páginas" }).click();
  await placeSignatureBlock(page, 2, 5);
  await page.getByRole("button", { name: "Guardar plantilla" }).click();
  await expect(page.locator("[data-template-saved]")).toBeVisible();
}

for (const cell of CELLS) {
  test(`${cell.theme} · ${cell.language} · ${cell.touch ? "tactil" : "raton"}: editor, avisos y oferta final de plantillas`, async ({ browser }) => {
    const context = await newWideContext(browser, cell);
    await context.addInitScript(([key]) => window.localStorage.setItem(key, "1"), [PRIVACY_SEEN_KEY]);
    const page = await context.newPage();
    try {
      // Los textos de este recorrido son los de la interfaz en espanol: se vuelve a ES si la celda es EN (cada pantalla se mide en los dos idiomas).
      const original = await makeContract({ label: "Mold Test Agreement", pages: 6, signers: 2 });
      await page.goto("/sign-pdf");
      await expectWideFontActive(page, cell.language);
      if (cell.language === "en") await switchLanguage(page, "es");
      const unknown = await makeContract({ label: "Zulu Unknown Agreement", pages: 5, signers: 2, extras: true });

      // 1. El editor con deteccion, sugerencias y un campo de texto seleccionado.
      await openEditorWithFile(page, { name: "Zulu.pdf", buffer: unknown });
      await page.getByRole("button", { name: "Detectar campos automáticamente" }).click();
      await expect(page.getByRole("heading", { name: /^Sugerencias \(\d+\)$/ })).toBeVisible({ timeout: 20_000 });
      await fitsEverywhere(page, "editor de plantillas");
      await page.getByRole("button", { name: "Cerrar", exact: true }).click();
      await page.getByRole("button", { name: "Salir sin guardar" }).click();

      // 2. Guardar una plantilla y ver los avisos al cargar el PDF.
      await page.goto("/sign-pdf");
      await configureAndSave(page, original);
      await fitsEverywhere(page, "editor guardado");
      await page.goto("/sign-pdf");
      await fileInput(page).setInputFiles({ name: "Revisado.pdf", mimeType: "application/pdf", buffer: await makeContract({ label: "Mold Test Agreement", pages: 6, signers: 2, tweakedPages: [2] }) });
      await expect(notices(page)).toContainText("Parece la plantilla", { timeout: 20_000 });
      await fitsEverywhere(page, "pregunta «Parece la plantilla»");
      await notices(page).getByRole("button", { name: "Usar", exact: true }).click();
      await notices(page).getByRole("button", { name: /^Revisar la página 3/ }).click();
      await fitsEverywhere(page, "plantilla aplicada con paginas a revisar");

      // 3. Automapeo con sugerencias.
      await page.goto("/sign-pdf");
      await fileInput(page).setInputFiles({ name: "Zulu.pdf", mimeType: "application/pdf", buffer: unknown });
      await page.getByRole("tab", { name: "Varios firmantes" }).click();
      await expect(notices(page)).toContainText("Detectamos", { timeout: 20_000 });
      await notices(page).getByRole("button", { name: /^Sugerencias \(\d+\)$/ }).click();
      await fitsEverywhere(page, "automapeo con sugerencias");

      // 4. La oferta final, tras firmar.
      await page.getByRole("button", { name: "Ir a firmar" }).click();
      for (const [seed, last] of [[3, false], [17, true]] as const) {
        await page.getByRole("button", { name: "Listo, es mi turno" }).first().click();
        await page.getByRole("button", { name: "Crear mi firma", exact: true }).click();
        await drawInOpenComposer(page, seed);
        await page.getByRole("button", { name: "Crear mis iniciales", exact: true }).click();
        await drawInOpenComposer(page, seed + 7);
        await page.getByRole("button", { name: "Ver cómo queda" }).click();
        await page.getByRole("button", { name: last ? "He terminado" : "Pasar al siguiente firmante" }).click();
      }
      await downloadBytes(page, async () => {
        await page.getByRole("button", { name: "Firmar y descargar" }).click();
        await page.getByRole("button", { name: /^Descargar/ }).click();
      });
      await expect(page.locator("[data-template-offer]")).toBeVisible();
      await fitsEverywhere(page, "oferta «¿Guardar como plantilla?»");
    } finally {
      await context.close();
    }
  });
}

