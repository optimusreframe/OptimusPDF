import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { engineOf, tabKey } from "../helpers/engine";

/**
 * Menu movil y de tablet (docs/PLAN-OPTIMUSTOOLS.md): una hoja con el MISMO contenido y orden que la barra lateral, abierta desde
 * la quinta pestaña «Menú» de la barra inferior (<768 px) o desde el boton «Menú» de la cabecera (768-1023 px). Todo en Chromium
 * headless:
 *  1. iPhone 375 (tactil) · claro y oscuro · ES y EN: pestañas, estructura, orden, pie (idioma y tema), axe.
 *  2. Objetivos >= 44 px y sin desborde: 375, 320 con tipografia ancha (y todo desplegado), tablet con la fuente al 150 %.
 *  3. Cierre (Escape, velo, X, enlace, arrastre, Atras), foco que vuelve al disparador, foco atrapado, fondo `inert` y sin scroll.
 *  4. Desplegables, buscador, plataformas del Downloader no enfocables, persistencia de secciones, idioma y tema.
 *  5. iPad 834 vertical (hoja de tablet) y 1194 horizontal (barra lateral de escritorio con Licencias), y el cambio de ancho con la hoja abierta.
 *  6. Telefono horizontal (hoja a pantalla completa), 320x568 (pie al final de la lista) y reduced motion.
 *
 * Uso: PW_PORT=4010 npx playwright test e2e/specs/nav-mobile-menu.spec.ts
 */

test.setTimeout(150_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = [
  "color-contrast",
  "aria-valid-attr-value",
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-hidden-focus",
  "nested-interactive",
  "label",
  "button-name",
  "link-name",
  "list",
  "listitem",
  // Propias de una hoja modal con un area desplazable y un campo de busqueda.
  "aria-dialog-name",
  "aria-input-field-name",
  "scrollable-region-focusable",
  "tabindex",
] as const;

const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

type Theme = "light" | "dark";
type Language = "es" | "en";

const TEXT = {
  es: {
    primaryNav: "Navegación principal",
    menu: "Menú",
    closeMenu: "Cerrar menú",
    categories: ["Organizar", "Optimizar", "Convertir a PDF", "Convertir desde PDF", "Editar y analizar", "Seguridad"],
    groups: ["Downloader", "Audio Studio", "Converter"],
    suites: ["OptimusPDF", "OptimusSCAN", "OptimusTOOLS"],
    scan: "Escanear a PDF",
    soon: "Pronto",
    more: "Próximamente…",
    toggle: "Mostrar u ocultar",
    theme: ["Claro", "Oscuro", "Sistema"],
    settings: "Ajustes",
    licenses: "Licencias",
    search: "Buscar herramienta…",
    empty: "Sin resultados",
    tabs: ["Inicio", "Mis documentos", "Recientes", "Ajustes", "Menú"],
  },
  en: {
    primaryNav: "Primary navigation",
    menu: "Menu",
    closeMenu: "Close menu",
    categories: ["Organise", "Optimise", "Convert to PDF", "Convert from PDF", "Edit and analyse", "Security"],
    groups: ["Downloader", "Audio Studio", "Converter"],
    suites: ["OptimusPDF", "OptimusSCAN", "OptimusTOOLS"],
    scan: "Scan to PDF",
    soon: "Soon",
    more: "More soon…",
    toggle: "Show or hide",
    theme: ["Light", "Dark", "System"],
    settings: "Settings",
    licenses: "Licenses",
    search: "Search a tool…",
    empty: "No results",
    tabs: ["Home", "My documents", "Recent", "Settings", "Menu"],
  },
} as const;

const PLATFORMS = ["Instagram", "Facebook", "TikTok", "X", "Threads", "Telegram"];

type Opts = {
  width: number;
  height: number;
  theme?: Theme;
  language?: Language;
  touch?: boolean;
  wide?: boolean;
  reducedMotion?: boolean;
  /** Tamano de fuente de la raiz en % (la fuente del sistema al 150 %: todo el diseno esta en rem). */
  rootFont?: number;
};

async function newContext(browser: Browser, opts: Opts): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    colorScheme: opts.theme ?? "dark",
    hasTouch: opts.touch ?? true,
    isMobile: opts.touch ?? true,
    deviceScaleFactor: 2,
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  await context.addInitScript(
    ([theme, language, css, wide, rootFont]) => {
      if (wide) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      if (rootFont) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(`html { font-size: ${rootFont}% !important; }`);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      // Semilla UNA vez por pestaña: asi se puede cambiar de tema o idioma y recargar sin que se pise la eleccion.
      try {
        if (window.sessionStorage.getItem("__nav_seeded")) return;
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
        window.sessionStorage.setItem("__nav_seeded", "1");
      } catch {
        /* documento opaco (about:blank): sin almacenamiento */
      }
    },
    [opts.theme ?? "dark", opts.language ?? "es", WIDE_CSS, opts.wide ?? false, opts.rootFont ?? 0] as const,
  );
  return context;
}

/** Errores de hidratacion y de pagina: deben ser cero. */
function watchPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat|did not match|server rendered|aria-controls|Warning:/i.test(message.text())) {
      problems.push(`console: ${message.text().slice(0, 200)}`);
    }
  });
  return problems;
}

async function gotoPage(page: Page, route = "/"): Promise<void> {
  await page.goto(route);
  await page.locator("main#content").waitFor();
}

const dialogOf = (page: Page, language: Language) => page.getByRole("dialog", { name: TEXT[language].menu });
const menuNav = (page: Page, language: Language) => dialogOf(page, language).getByRole("navigation", { name: TEXT[language].menu });
const tabBar = (page: Page) => page.locator("nav[data-chrome='tabbar']");
const tabTrigger = (page: Page, language: Language) => tabBar(page).getByRole("button", { name: TEXT[language].menu });
const headerTrigger = (page: Page, language: Language) => page.locator("header").getByRole("button", { name: TEXT[language].menu });

/** Espera a que la hoja deje de moverse (entrada con muelle) antes de medir. */
async function settled(page: Page, language: Language): Promise<void> {
  const dialog = dialogOf(page, language);
  await dialog.waitFor();
  let last = "";
  await expect
    .poll(
      async () => {
        const box = await dialog.boundingBox();
        const now = box ? `${box.x.toFixed(1)},${box.y.toFixed(1)},${box.width.toFixed(1)},${box.height.toFixed(1)}` : "";
        const same = now !== "" && now === last;
        last = now;
        return same;
      },
      { timeout: 8000, intervals: [120, 120, 120, 200, 200, 300] },
    )
    .toBe(true);
}

async function openFromTab(page: Page, language: Language): Promise<void> {
  await tabTrigger(page, language).tap();
  await settled(page, language);
}

async function openFromHeader(page: Page, language: Language): Promise<void> {
  await headerTrigger(page, language).click();
  await settled(page, language);
}

async function closed(page: Page, language: Language): Promise<void> {
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 8000 });
  void language;
}

async function runAxe(page: Page): Promise<string[]> {
  // axe mide el contraste con el color VIVO: si un enlace aun cambia de color por una transicion (carga o cambio de tema) la medicion cae a mitad de camino.
  await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running"));
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as {
      axe: {
        run: (
          ctx: unknown,
          opts: unknown,
        ) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }>;
      };
    }).axe;
    // El pie de pagina (Footer.tsx) no es de este spec (ver nav-optimustools.spec.ts): aqui se mide la hoja y la barra.
    const result = await axe.run({ exclude: [["footer"]] }, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map(
      (v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`,
    );
  }, AXE_RULES);
}

/** Desborde horizontal de la pagina (como en nav-optimustools.spec.ts) y de lo que hay DENTRO de la hoja (su area desplazable recorta en X). */
async function overflows(page: Page): Promise<{ page: number; pageOffenders: string[]; sheet: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    const clips = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") return true;
      }
      return false;
    };
    const pageOffenders: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right <= width + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      if (clips(element)) continue;
      pageOffenders.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").slice(0, 50)} «${(element.textContent ?? "").trim().slice(0, 24)}» ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
    const sheet: string[] = [];
    const dialog = document.querySelector("[role='dialog']");
    if (dialog) {
      const box = dialog.getBoundingClientRect();
      for (const element of dialog.querySelectorAll("*")) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1.5 || rect.height <= 1.5) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
        if (rect.right <= box.right + 1 && rect.left >= box.left - 1) continue;
        sheet.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").slice(0, 50)} «${(element.textContent ?? "").trim().slice(0, 24)}» ${Math.round(rect.left)}..${Math.round(rect.right)} (hoja ${Math.round(box.left)}..${Math.round(box.right)})`);
      }
      const scroller = dialog.querySelector(".overflow-y-auto");
      if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) sheet.push(`scroller scrollWidth ${scroller.scrollWidth} > ${scroller.clientWidth}`);
    }
    return { page: root.scrollWidth - width, pageOffenders: pageOffenders.slice(0, 6), sheet: sheet.slice(0, 6) };
  });
}

/** Cajas de los controles interactivos visibles de un contenedor. */
async function targetBoxes(scope: Locator): Promise<Array<{ name: string; width: number; height: number }>> {
  return scope.evaluate((root) => {
    const result: Array<{ name: string; width: number; height: number }> = [];
    for (const element of root.querySelectorAll<HTMLElement>("a[href], button, input:not([type='hidden']), [role='tab']")) {
      if (element.closest("[aria-hidden='true']")) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
      result.push({
        name: `${element.tagName.toLowerCase()} «${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 28)}»`,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      });
    }
    return result;
  });
}

const activeInside = (dialog: Locator) => dialog.evaluate((node) => node.contains(document.activeElement));

/* ------------------------------------------------------------------ *
 * 1. iPhone 375: pestañas y estructura (claro/oscuro, ES/EN)
 * ------------------------------------------------------------------ */
for (const theme of ["light", "dark"] as const) {
  for (const language of ["es", "en"] as const) {
    test.describe(`iPhone 375 · ${theme} · ${language}`, () => {
      const T = TEXT[language];

      test("cinco pestañas (la quinta es el boton «Menú») y la hoja tiene el contenido de la barra lateral en su orden", async ({ browser }) => {
        const context = await newContext(browser, { width: 375, height: 812, theme, language });
        const page = await context.newPage();
        const problems = watchPageProblems(page);
        try {
          await gotoPage(page);
          await expect(page.locator("aside").first()).toBeHidden();
          const items = tabBar(page).locator("li > a, li > button");
          await expect(items).toHaveText([...T.tabs]);
          expect(await items.evaluateAll((nodes) => nodes.map((n) => n.tagName))).toEqual(["A", "A", "A", "A", "BUTTON"]);
          const trigger = tabTrigger(page, language);
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
          await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
          await expect(trigger).not.toHaveAttribute("aria-controls", /.+/);

          await openFromTab(page, language);
          const dialog = dialogOf(page, language);
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          const controlled = await trigger.getAttribute("aria-controls");
          expect(controlled).toBeTruthy();
          expect(await dialog.locator(`[id="${controlled}"]`).count()).toBe(1);
          await expect(dialog).toHaveAttribute("aria-modal", "true");

          const nav = menuNav(page, language);
          // Arriba: Inicio, Recientes, PDF Pro. Abajo: Documentos, Ajustes, Precios, Proyecto, Licencias.
          const hrefs = await nav.locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
          expect(hrefs.slice(0, 3)).toEqual(["/", "/recent", "/pdf-pro"]);
          expect(hrefs.slice(-5)).toEqual(["/documents", "/settings", "/pricing", "/about", "/licenses"]);
          // Tres suites en orden, cada una con su lista nombrada.
          for (const suite of T.suites) await expect(nav.getByRole("list", { name: suite })).toBeAttached();
          const order = await nav.locator("li > p").allTextContents();
          expect(order.filter((text) => (T.suites as readonly string[]).includes(text.trim()))).toEqual([...T.suites]);
          // Seis categorias y tres grupos: desplegables cerrados, con `aria-expanded`.
          for (const label of [...T.categories, ...T.groups]) {
            await expect(nav.getByRole("button", { name: `${T.toggle} ${label}` })).toHaveAttribute("aria-expanded", "false");
          }
          await expect(nav.getByRole("list", { name: T.suites[1] }).getByRole("link", { name: T.scan })).toHaveAttribute("href", "/scan-to-pdf");
          // «Próximamente…» es una nota (ni enlace ni boton).
          const more = nav.getByText(T.more);
          expect(await more.evaluate((node) => !!node.closest("a, button"))).toBe(false);
          // Licencias: enlace a /licenses.
          await expect(nav.getByRole("link", { name: T.licenses })).toHaveAttribute("href", "/licenses");
          // Pie: idioma y tema, y siempre a la vista (esta pegado al borde inferior de la hoja).
          await expect(dialog.getByRole("group", { name: language === "es" ? "Idioma" : "Language" })).toBeVisible();
          await expect(dialog.getByRole("tablist").getByRole("tab")).toHaveText([...T.theme]);
          const footer = dialog.locator("[data-menu-footer]");
          await expect(footer).toBeInViewport({ ratio: 1 });
          expect(problems, problems.join("\n")).toEqual([]);
        } finally {
          await context.close();
        }
      });

      test("axe: contraste, ARIA, nombres y listas sin violaciones con la hoja abierta (y con todo desplegado)", async ({ browser }) => {
        const context = await newContext(browser, { width: 375, height: 812, theme, language });
        const page = await context.newPage();
        try {
          await gotoPage(page);
          expect(await runAxe(page), "cerrada").toEqual([]);
          await openFromTab(page, language);
          expect(await runAxe(page), "abierta").toEqual([]);
          const closedToggles = menuNav(page, language).locator("button[aria-expanded='false']");
          while ((await closedToggles.count()) > 0) await closedToggles.first().click();
          expect(await runAxe(page), "todo desplegado").toEqual([]);
          // Buscando.
          await dialogOf(page, language).getByRole("searchbox").fill("pdf");
          expect(await runAxe(page), "buscando").toEqual([]);
        } finally {
          await context.close();
        }
      });
    });
  }
}

/* ------------------------------------------------------------------ *
 * 2. Objetivos tactiles y desborde
 * ------------------------------------------------------------------ */
test.describe("objetivos de 44 px y sin desborde", () => {
  for (const width of [375, 320] as const) {
    test(`${width} px (tactil): todos los controles de la barra inferior y de la hoja miden >= 44 px, con todo desplegado`, async ({ browser }) => {
      const context = await newContext(browser, { width, height: width === 320 ? 640 : 812, theme: "dark", language: "es" });
      const page = await context.newPage();
      try {
        await gotoPage(page);
        for (const box of await targetBoxes(tabBar(page))) {
          expect(box.height, `barra: ${box.name}`).toBeGreaterThanOrEqual(43.5);
          expect(box.width, `barra: ${box.name}`).toBeGreaterThanOrEqual(43.5);
        }
        await openFromTab(page, "es");
        const closedToggles = menuNav(page, "es").locator("button[aria-expanded='false']");
        while ((await closedToggles.count()) > 0) await closedToggles.first().click();
        const boxes = await targetBoxes(dialogOf(page, "es"));
        expect(boxes.length).toBeGreaterThan(60);
        for (const box of boxes) {
          expect(box.height, `hoja: ${box.name}`).toBeGreaterThanOrEqual(43.5);
          expect(box.width, `hoja: ${box.name}`).toBeGreaterThanOrEqual(43.5);
        }
      } finally {
        await context.close();
      }
    });
  }

  for (const width of [320, 375] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`${width} px · ${theme} con tipografia ancha (DejaVu Sans + 6 % de espaciado): ni la pagina, ni la barra, ni la hoja (todo desplegado) desbordan`, async ({ browser }) => {
        const context = await newContext(browser, { width, height: 700, theme, language: "es", wide: true });
        const page = await context.newPage();
        try {
          await gotoPage(page);
          const probe = await page.evaluate(() => {
            const c = document.createElement("canvas").getContext("2d")!;
            const text = "Convertir desde PDF";
            c.font = "16px Arial";
            const narrow = c.measureText(text).width;
            c.font = '16px "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif';
            return c.measureText(text).width / narrow;
          });
          expect(probe, "la fuente ancha forzada debe medir mas que Arial").toBeGreaterThan(1.05);
          const before = await overflows(page);
          expect(before.page, `cerrada: ${before.pageOffenders.join(" | ")}`).toBeLessThanOrEqual(1);
          expect(before.pageOffenders).toEqual([]);
          // Las cinco pestañas caben en el ancho (ninguna se sale por la derecha) y miden >= 44 px.
          for (const rect of await tabBar(page).locator("li").evaluateAll((items) => items.map((i) => i.getBoundingClientRect()))) {
            expect(rect.right, "pestaña dentro del ancho").toBeLessThanOrEqual(width + 0.5);
            expect(rect.width).toBeGreaterThanOrEqual(43.5);
          }
          await openFromTab(page, "es");
          const closedToggles = menuNav(page, "es").locator("button[aria-expanded='false']");
          while ((await closedToggles.count()) > 0) await closedToggles.first().click();
          const open = await overflows(page);
          expect(open.sheet, `hoja: ${open.sheet.join(" | ")}`).toEqual([]);
          expect(open.page, `abierta: ${open.pageOffenders.join(" | ")}`).toBeLessThanOrEqual(1);
          // Hasta el final de la lista: Licencias y el pie (idioma, tema) se alcanzan sin salirse del ancho.
          await menuNav(page, "es").getByRole("link", { name: "Licencias" }).scrollIntoViewIfNeeded();
          await dialogOf(page, "es").getByRole("tablist").scrollIntoViewIfNeeded();
          await expect(dialogOf(page, "es").getByRole("tablist")).toBeInViewport();
          for (const tab of await dialogOf(page, "es").getByRole("tablist").getByRole("tab").all()) {
            const box = (await tab.boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(43.5);
            expect(box.height).toBeGreaterThanOrEqual(43.5);
          }
        } finally {
          await context.close();
        }
      });
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3. Cierre, foco, fondo
 * ------------------------------------------------------------------ */
test.describe("cierre, foco y fondo", () => {
  test("Escape, la X y el velo cierran, y el foco vuelve al disparador (aunque Safari no lo enfoque al pulsar)", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      const trigger = tabTrigger(page, "es");
      const isFocused = () => trigger.evaluate((node) => node === document.activeElement);

      // Escape.
      await openFromTab(page, "es");
      await page.keyboard.press("Escape");
      await closed(page, "es");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(await isFocused(), "Escape").toBe(true);

      // La X (su nombre accesible es «Cerrar menú»).
      await openFromTab(page, "es");
      await dialogOf(page, "es").getByRole("button", { name: "Cerrar menú" }).tap();
      await closed(page, "es");
      expect(await isFocused(), "X").toBe(true);

      // Toque en el velo (la franja de 12 px que deja la hoja arriba).
      await openFromTab(page, "es");
      await page.touchscreen.tap(187, 5);
      await closed(page, "es");
      expect(await isFocused(), "velo").toBe(true);
    } finally {
      await context.close();
    }
  });

  test("arrastrar la hoja hacia abajo desde su cabecera la cierra (con velocidad); un arrastre corto la devuelve a su sitio", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      const dialog = dialogOf(page, "es");
      const start = (await dialog.boundingBox())!;
      // Arrastre corto y lento (50 px en ~0,5 s, sin velocidad al soltar): la hoja sigue al puntero 1:1 y vuelve a su sitio.
      await page.mouse.move(120, start.y + 40);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) {
        await page.mouse.move(120, start.y + 40 + step * 5);
        await page.waitForTimeout(50);
      }
      expect((await dialog.boundingBox())!.y - start.y, "sigue al puntero").toBeGreaterThan(30);
      await page.waitForTimeout(250);
      await page.mouse.up();
      await settled(page, "es");
      expect(Math.abs((await dialog.boundingBox())!.y - start.y)).toBeLessThan(2);
      await expect(dialog).toBeVisible();
      // Arrastre largo y rapido: se cierra.
      await page.mouse.move(120, start.y + 40);
      await page.mouse.down();
      await page.mouse.move(120, start.y + 520, { steps: 6 });
      await page.mouse.up();
      await closed(page, "es");
      await expect(tabTrigger(page, "es")).toHaveAttribute("aria-expanded", "false");
    } finally {
      await context.close();
    }
  });

  test("al pulsar un enlace la hoja se cierra y la pagina cambia; Atras cierra la hoja sin tocar el historial", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      const lengthBefore = await page.evaluate(() => history.length);
      await openFromTab(page, "es");
      expect(await page.evaluate(() => history.length), "abrir la hoja no empuja historial").toBe(lengthBefore);
      await menuNav(page, "es").getByRole("link", { name: "Ajustes" }).tap();
      await expect(page).toHaveURL(/\/settings$/);
      await closed(page, "es");
      const lengthAfterNav = await page.evaluate(() => history.length);
      expect(lengthAfterNav).toBe(lengthBefore + 1);

      // Con la hoja abierta, el boton Atras del navegador navega (como siempre) y la hoja se cierra al cambiar la ruta.
      await openFromTab(page, "es");
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await closed(page, "es");
      await expect(page.locator("main#content")).toBeVisible();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    } finally {
      await context.close();
    }
  });

  test("una categoria (ancla de Inicio) lleva a su seccion y cierra la hoja", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      await menuNav(page, "es").locator("a[href='/#security']").tap();
      await closed(page, "es");
      await expect(page.locator("#security")).toBeInViewport({ timeout: 8000 });
    } finally {
      await context.close();
    }
  });

  test("fondo `inert` y sin scroll: con la hoja abierta la pagina no se desplaza (rueda y teclado) y todo vuelve al cerrar", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await page.evaluate(() => window.scrollTo(0, 400));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
      const scrollBefore = await page.evaluate(() => window.scrollY);
      await openFromTab(page, "es");
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      // Todos los demas hijos de <body> estan inertes; la hoja no.
      const inert = await page.evaluate(() => {
        const dialog = document.querySelector("[role='dialog']")!;
        const root = dialog.closest("body > *")!;
        return Array.from(document.body.children)
          .filter((el) => el !== root && !["SCRIPT", "STYLE"].includes(el.tagName))
          .map((el) => el.hasAttribute("inert"));
      });
      expect(inert.length).toBeGreaterThan(0);
      expect(inert.every(Boolean)).toBe(true);
      // Rueda sobre el velo y sobre la hoja: la pagina de fondo no se mueve; el interior de la hoja si. (El WebKit movil de
      // Playwright no emite rueda: alli solo se comprueba el bloqueo por `overflow: hidden` y la contencion del scroll.)
      const scroller = await (async () => {
        if (engineOf(page) === "webkit") {
          await page.evaluate(() => document.querySelector("[role='dialog'] .overflow-y-auto")!.scrollTo(0, 300));
        } else {
          await page.mouse.move(187, 5);
          await page.mouse.wheel(0, 600);
          await page.mouse.move(187, 400);
          await page.mouse.wheel(0, 3000);
          await page.waitForTimeout(250);
          expect(await page.evaluate(() => window.scrollY), "el fondo no se desplaza").toBe(scrollBefore);
        }
        return page.evaluate(() => {
          const s = document.querySelector("[role='dialog'] .overflow-y-auto")!;
          return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight, behavior: getComputedStyle(s).overscrollBehaviorY };
        });
      })();
      expect(scroller.top, "la lista de la hoja se desplaza").toBeGreaterThan(50);
      expect(scroller.behavior).toBe("contain");
      // Cerrar: el scroll del fondo vuelve y estaba donde se dejo.
      await page.keyboard.press("Escape");
      await closed(page, "es");
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
      expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    } finally {
      await context.close();
    }
  });

  test("el foco queda atrapado en la hoja: ni Tab ni Mayus+Tab llegan a la pagina de debajo", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      const dialog = dialogOf(page, "es");
      // Al abrirse el foco entra en la hoja (el propio dialogo: sin abrir el teclado del telefono).
      expect(await activeInside(dialog)).toBe(true);
      expect(await dialog.evaluate((node) => document.activeElement === node)).toBe(true);
      for (let i = 0; i < 70; i += 1) {
        await page.keyboard.press(tabKey(page));
        expect(await activeInside(dialog), `Tab ${i + 1}`).toBe(true);
      }
      for (let i = 0; i < 70; i += 1) {
        await page.keyboard.press(tabKey(page, true));
        expect(await activeInside(dialog), `Mayus+Tab ${i + 1}`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test("las plataformas del Downloader no son enfocables ni siquiera con la hoja entera desplegada", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      const nav = menuNav(page, "es");
      await nav.getByRole("button", { name: "Mostrar u ocultar Downloader" }).click();
      for (const name of PLATFORMS) {
        const entry = nav.locator("[aria-disabled='true']").filter({ hasText: name }).first();
        await expect(entry, name).toBeVisible();
        await expect(entry).toContainText("Pronto");
        expect(await entry.evaluate((node) => ({ href: node.getAttribute("href"), tabindex: node.getAttribute("tabindex"), inLink: !!node.closest("a[href]") }))).toEqual({ href: null, tabindex: null, inLink: false });
      }
      const seen = new Set<string>();
      for (let i = 0; i < 80; i += 1) {
        await page.keyboard.press(tabKey(page));
        seen.add(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim().slice(0, 40)));
      }
      for (const name of PLATFORMS) expect([...seen].some((text) => text.startsWith(name)), `${name} no debe ser tabulable`).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("el pie (idioma y tema) esta pegado abajo y no salta al desplazar hasta el final", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      const dialog = dialogOf(page, "es");
      const footer = dialog.locator("[data-menu-footer]");
      const gap = async () => {
        const f = (await footer.boundingBox())!;
        const d = (await dialog.boundingBox())!;
        return Math.round((d.y + d.height - (f.y + f.height)) * 10) / 10;
      };
      // Tocando el borde de la hoja (0) y de la pantalla, antes y despues de desplazar hasta el final.
      const top = await gap();
      await dialog.locator(".overflow-y-auto").evaluate((node) => node.scrollTo(0, node.scrollHeight));
      await page.waitForTimeout(250);
      const end = await gap();
      expect(Math.abs(top), "pegado abajo").toBeLessThanOrEqual(1.5);
      expect(Math.abs(end - top), "sin salto al llegar al final").toBeLessThanOrEqual(1.5);
      await expect(footer).toBeInViewport({ ratio: 1 });
      // El ultimo enlace de la lista (Licencias) queda por encima del pie, no tapado.
      const last = (await menuNav(page, "es").getByRole("link", { name: "Licencias" }).boundingBox())!;
      const f = (await footer.boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(f.y + 1);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. Desplegables, buscador, idioma y tema
 * ------------------------------------------------------------------ */
test.describe("desplegables, buscador, idioma y tema", () => {
  test("los desplegables se abren y cierran con toque, Enter y Espacio, y se recuerdan en la misma pestaña (tambien en la barra lateral)", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      const nav = menuNav(page, "es");
      const toggle = nav.getByRole("button", { name: "Mostrar u ocultar Seguridad" });
      await toggle.tap();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const panelId = await toggle.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      await expect(nav.locator(`[id="${panelId}"]`).getByRole("link", { name: "Proteger PDF" })).toBeVisible();
      // Teclado: Enter cierra y Espacio abre, sin perder el foco.
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).not.toHaveAttribute("aria-controls", /.+/);
      expect(await toggle.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await toggle.evaluate((node) => node === document.activeElement)).toBe(true);
      // Se guarda la eleccion (la misma clave que la barra lateral) y sobrevive a cerrar/abrir y a recargar.
      expect(await page.evaluate(() => sessionStorage.getItem("optimuspdf.sidebarSections"))).toBe('{"security":true}');
      await page.keyboard.press("Escape");
      await closed(page, "es");
      await openFromTab(page, "es");
      await expect(menuNav(page, "es").getByRole("button", { name: "Mostrar u ocultar Seguridad" })).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await page.locator("main#content").waitFor();
      await openFromTab(page, "es");
      await expect(menuNav(page, "es").getByRole("button", { name: "Mostrar u ocultar Seguridad" })).toHaveAttribute("aria-expanded", "true");
    } finally {
      await context.close();
    }
  });

  test("buscador: filtra sin tildes ni mayusculas, anuncia el numero de resultados, Escape lo limpia y elegir uno navega y cierra", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      const dialog = dialogOf(page, "es");
      const search = dialog.getByRole("searchbox", { name: "Buscar herramienta…" });
      await search.fill("ESCANEAR");
      await expect(dialog.getByRole("status")).toHaveText("1 resultado");
      await expect(menuNav(page, "es").locator("li a[href='/scan-to-pdf']")).toBeVisible();
      await expect(menuNav(page, "es").getByRole("button", { name: /Mostrar u ocultar/ })).toHaveCount(0);
      // El campo con dedo mide 16 px o mas (Safari no acerca la pagina al enfocarlo).
      expect(await search.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
      await search.fill("zzzzqq");
      await expect(dialog.getByRole("status")).toHaveText("Sin resultados");
      await search.fill("downl");
      await expect(menuNav(page, "es").getByRole("link", { name: /Downloader/ }).first()).toBeVisible();
      // Escape con texto lo borra y NO cierra; con el campo vacio, si.
      await search.focus();
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("");
      await expect(dialog).toBeVisible();
      await expect(menuNav(page, "es").getByRole("button", { name: /Mostrar u ocultar/ }).first()).toBeVisible();
      await search.fill("escanear");
      await menuNav(page, "es").getByRole("link", { name: "Escanear a PDF" }).tap();
      await expect(page).toHaveURL(/\/scan-to-pdf$/);
      await closed(page, "es");
    } finally {
      await context.close();
    }
  });

  test("idioma y tema desde la hoja: se aplican al instante, traducen la propia hoja y persisten al recargar", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "light", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await openFromTab(page, "es");
      const dialog = dialogOf(page, "es");
      await dialog.getByRole("tab", { name: "Oscuro" }).tap();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await dialog.getByRole("button", { name: "EN", exact: true }).tap();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      // La hoja sigue abierta y ahora habla ingles.
      await expect(dialogOf(page, "en")).toBeVisible();
      await expect(dialogOf(page, "en").getByRole("button", { name: "Close menu" })).toBeVisible();
      await expect(menuNav(page, "en").getByRole("link", { name: "Licenses" })).toBeVisible();
      await expect(dialogOf(page, "en").getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "true");
      expect(await page.evaluate(() => [localStorage.getItem("optimuspdf.theme"), localStorage.getItem("optimuspdf.language")])).toEqual(["dark", "en"]);

      await page.reload();
      await page.locator("main#content").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(tabTrigger(page, "en")).toBeVisible();
      await openFromTab(page, "en");
      await expect(dialogOf(page, "en").getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "true");
      // Ajustes ve la misma eleccion (es el mismo almacen).
      await page.keyboard.press("Escape");
      await closed(page, "en");
      await page.goto("/settings");
      await page.locator("main#content").waitFor();
      await expect(page.getByRole("tab", { name: "Dark" }).first()).toHaveAttribute("aria-selected", "true");
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. iPad: 834 vertical (hoja de tablet), 1194 horizontal (barra lateral)
 * ------------------------------------------------------------------ */
test.describe("iPad", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["es", "en"] as const) {
      test(`834 vertical · ${theme} · ${language}: el boton «${TEXT[language].menu}» de la cabecera abre la misma hoja, centrada y dentro de la pantalla`, async ({ browser }) => {
        const T = TEXT[language];
        const context = await newContext(browser, { width: 834, height: 1112, theme, language });
        const page = await context.newPage();
        const problems = watchPageProblems(page);
        try {
          await gotoPage(page);
          await expect(page.locator("aside").first()).toBeHidden();
          await expect(tabBar(page)).toBeHidden();
          const trigger = headerTrigger(page, language);
          await expect(trigger).toBeVisible();
          // Ya no hay popover «Herramientas».
          await expect(page.getByRole("button", { name: "Herramientas" })).toHaveCount(0);
          // Un toque fuera de la tarjeta (sobre el velo) la cierra y el foco vuelve al boton.
          await openFromHeader(page, language);
          await page.mouse.click(20, 20);
          await closed(page, language);
          expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true);
          await openFromHeader(page, language);
          const dialog = dialogOf(page, language);
          const box = (await dialog.boundingBox())!;
          expect(box.width).toBeLessThanOrEqual(513);
          expect(box.x).toBeGreaterThan(100);
          expect(box.x + box.width).toBeLessThan(834 - 100);
          expect(box.y).toBeGreaterThan(0);
          expect(box.y + box.height).toBeLessThan(1112);
          const nav = menuNav(page, language);
          const hrefs = await nav.locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
          expect(hrefs.slice(0, 3)).toEqual(["/", "/recent", "/pdf-pro"]);
          expect(hrefs.slice(-5)).toEqual(["/documents", "/settings", "/pricing", "/about", "/licenses"]);
          for (const suite of T.suites) await expect(nav.getByRole("list", { name: suite })).toBeAttached();
          await expect(nav.getByRole("list", { name: T.suites[1] }).getByRole("link", { name: T.scan })).toHaveAttribute("href", "/scan-to-pdf");
          await expect(dialog.getByRole("tablist").getByRole("tab")).toHaveText([...T.theme]);
          expect(await runAxe(page)).toEqual([]);
          for (const target of await targetBoxes(dialog)) {
            expect(target.height, target.name).toBeGreaterThanOrEqual(43.5);
            expect(target.width, target.name).toBeGreaterThanOrEqual(43.5);
          }
          // Escape cierra y el foco vuelve al boton de la cabecera.
          await page.keyboard.press("Escape");
          await closed(page, language);
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
          expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true);
          expect(problems, problems.join("\n")).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  for (const width of [768, 834] as const) {
    test(`${width} px con la fuente del sistema al 150 % y tipografia ancha: ni la cabecera ni la hoja desbordan`, async ({ browser }) => {
      const context = await newContext(browser, { width, height: 1024, theme: "dark", language: "es", wide: true, rootFont: 150 });
      const page = await context.newPage();
      try {
        await gotoPage(page);
        // El pie de pagina (Footer.tsx) no es de este spec y a 768 px con la fuente al 150 % ya desborda por su cuenta
        // («Proyecto de Optimus Reframe», 51 px): se informa aparte. Aqui se mide la cabecera, la barra y la hoja.
        await page.addStyleTag({ content: "footer { display: none !important; }" });
        const before = await overflows(page);
        expect(before.page, `cabecera: ${before.pageOffenders.join(" | ")}`).toBeLessThanOrEqual(1);
        expect(before.pageOffenders).toEqual([]);
        await openFromHeader(page, "es");
        const closedToggles = menuNav(page, "es").locator("button[aria-expanded='false']");
        while ((await closedToggles.count()) > 0) await closedToggles.first().click();
        const open = await overflows(page);
        expect(open.sheet, open.sheet.join(" | ")).toEqual([]);
        expect(open.page, `abierta: ${open.pageOffenders.join(" | ")}`).toBeLessThanOrEqual(1);
        const box = (await dialogOf(page, "es").boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(1024);
        await dialogOf(page, "es").getByRole("tablist").scrollIntoViewIfNeeded();
        await expect(dialogOf(page, "es").getByRole("tablist")).toBeInViewport();
      } finally {
        await context.close();
      }
    });
  }

  test("1194 horizontal (tactil): manda la barra lateral de escritorio, sin boton «Menú», y su pie lleva Licencias", async ({ browser }) => {
    const context = await newContext(browser, { width: 1194, height: 834, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      const aside = page.locator("aside").first();
      await expect(aside).toBeVisible();
      await expect(page.locator("header[data-site-header]")).toBeHidden();
      await expect(tabBar(page)).toBeHidden();
      const nav = aside.getByRole("navigation", { name: "Navegación principal" });
      const hrefs = await nav.locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
      expect(hrefs.slice(0, 3)).toEqual(["/", "/recent", "/pdf-pro"]);
      expect(hrefs.slice(-5)).toEqual(["/documents", "/settings", "/pricing", "/about", "/licenses"]);
      const licenses = nav.getByRole("link", { name: "Licencias" });
      await expect(licenses).toHaveAttribute("href", "/licenses");
      const box = (await licenses.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5); // puntero grueso
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("al ensanchar la ventana con la hoja abierta (834 -> 1194) la hoja se cierra sola y manda la barra lateral; al estrechar no se pierde", async ({ browser }) => {
    const context = await newContext(browser, { width: 834, height: 1112, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromHeader(page, "es");
      await page.setViewportSize({ width: 1194, height: 834 });
      await closed(page, "es");
      await expect(page.locator("aside").first()).toBeVisible();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
      expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
      // Telefono -> tablet con la hoja abierta: sigue siendo LA MISMA hoja (no se duplica) y el foco vuelve al disparador visible.
      await page.setViewportSize({ width: 375, height: 812 });
      await openFromTab(page, "es");
      await page.setViewportSize({ width: 834, height: 1112 });
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await closed(page, "es");
      expect(await headerTrigger(page, "es").evaluate((node) => node === document.activeElement)).toBe(true);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. Alturas cortas y reduced motion
 * ------------------------------------------------------------------ */
test.describe("alturas cortas y movimiento reducido", () => {
  test("telefono horizontal 812x375: la hoja ocupa toda la pantalla, se desplaza hasta Licencias y el pie y se cierra con la X", async ({ browser }) => {
    const context = await newContext(browser, { width: 812, height: 375, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromHeader(page, "es");
      const dialog = dialogOf(page, "es");
      const box = (await dialog.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(373);
      expect(box.width).toBeGreaterThanOrEqual(810);
      const open = await overflows(page);
      expect(open.sheet).toEqual([]);
      expect(open.page).toBeLessThanOrEqual(1);
      // El pie no se pega (ocuparia media pantalla): esta al final de la lista y se alcanza.
      await dialog.locator(".overflow-y-auto").evaluate((node) => node.scrollTo(0, node.scrollHeight));
      await expect(dialog.getByRole("tablist")).toBeInViewport();
      await expect(menuNav(page, "es").getByRole("link", { name: "Licencias" })).toBeInViewport();
      await dialog.getByRole("button", { name: "Cerrar menú" }).click();
      await closed(page, "es");
    } finally {
      await context.close();
    }
  });

  test("320x568 (iPhone SE): el pie no se pega, esta al final de la lista y se alcanza; la hoja cabe en la pantalla", async ({ browser }) => {
    const context = await newContext(browser, { width: 320, height: 568, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await openFromTab(page, "es");
      const dialog = dialogOf(page, "es");
      const box = (await dialog.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(568.5);
      expect(await dialog.locator("[data-menu-footer]").evaluate((node) => getComputedStyle(node).position)).toBe("static");
      await dialog.locator(".overflow-y-auto").evaluate((node) => node.scrollTo(0, node.scrollHeight));
      await expect(dialog.getByRole("tablist")).toBeInViewport();
      await expect(dialog.getByRole("group", { name: "Idioma" })).toBeInViewport();
    } finally {
      await context.close();
    }
  });

  test("movimiento reducido: la hoja abre y cierra sin desplazamiento (fundido) y sigue siendo operable", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, height: 812, theme: "dark", language: "es", reducedMotion: true });
    const page = await context.newPage();
    try {
      await gotoPage(page);
      await tabTrigger(page, "es").tap();
      const dialog = dialogOf(page, "es");
      await dialog.waitFor();
      // Sin deslizamiento: nunca pasa por una posicion desplazada hacia abajo.
      const offset = await dialog.evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform === "none" ? undefined : getComputedStyle(node).transform).m42);
      expect(Math.abs(offset)).toBeLessThan(2);
      await settled(page, "es");
      await menuNav(page, "es").getByRole("button", { name: "Mostrar u ocultar Organizar" }).tap();
      await page.keyboard.press("Escape");
      await closed(page, "es");
    } finally {
      await context.close();
    }
  });
});
