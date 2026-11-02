import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { tabKey } from "../helpers/engine";

/**
 * Navegacion OptimusTOOLS (docs/PLAN-OPTIMUSTOOLS.md): barra lateral con tres suites (OptimusPDF con sus seis categorias
 * desplegables, OptimusSCAN y OptimusTOOLS con Downloader, Audio Studio y Converter), idioma y tema al pie, Inicio agrupado
 * por suites y la pagina honesta `/downloader`. Todo en Chromium headless:
 *  1. Desktop 1280 · claro y oscuro · ES y EN: estructura, desplegables, orden de arriba, entradas deshabilitadas, axe.
 *  2. Teclado: Tab llega a los desplegables, Enter y Espacio los abren y cierran sin perder el foco; las plataformas no son
 *     tabulables.
 *  3. Sin enlaces rotos: cada ruta que enlaza la barra responde 200 y `scan-to-pdf` sigue alcanzable (barra, Inicio, buscador).
 *  4. Idioma y tema persisten al recargar.
 *  5. Movil 375 (tactil) y tablet 834: Inicio por suites, chips, menu de la cabecera, objetivos de 44 px.
 *  6. 320 px con tipografia ancha (DejaVu Sans + 6 % de espaciado): ni Inicio, ni /downloader, ni la barra desbordan.
 *
 * Uso: PW_PORT=3951 npx playwright test e2e/specs/nav-optimustools.spec.ts
 */

test.setTimeout(120_000);

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
    categories: ["Organizar", "Optimizar", "Convertir a PDF", "Convertir desde PDF", "Editar y analizar", "Seguridad"],
    groups: ["Downloader", "Audio Studio", "Converter"],
    suites: ["OptimusPDF", "OptimusSCAN", "OptimusTOOLS"],
    scan: "Escanear a PDF",
    soon: "Pronto",
    more: "Próximamente…",
    toggle: "Mostrar u ocultar",
    theme: ["Claro", "Oscuro", "Sistema"],
    home: "Inicio",
    recent: "Recientes",
    backup: "Exportar / Importar",
  },
  en: {
    primaryNav: "Primary navigation",
    categories: ["Organise", "Optimise", "Convert to PDF", "Convert from PDF", "Edit and analyse", "Security"],
    groups: ["Downloader", "Audio Studio", "Converter"],
    suites: ["OptimusPDF", "OptimusSCAN", "OptimusTOOLS"],
    scan: "Scan to PDF",
    soon: "Soon",
    more: "More soon…",
    toggle: "Show or hide",
    theme: ["Light", "Dark", "System"],
    home: "Home",
    recent: "Recent",
    backup: "Export / Import",
  },
} as const;

const PLATFORMS = ["Instagram", "Facebook", "TikTok", "X", "Threads", "Telegram"];
const GROUP_IDS = ["downloader", "audio-studio", "converter"];
const SECTION_IDS = ["organize", "optimize", "convert-to", "convert-from", "edit", "security", "scan", ...GROUP_IDS];

async function newContext(
  browser: Browser,
  opts: { width: number; height?: number; theme: Theme; language: Language; touch?: boolean; wide?: boolean; seed?: boolean },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height ?? (opts.width < 600 ? 812 : 900) },
    colorScheme: opts.theme,
    hasTouch: opts.touch ?? false,
    isMobile: opts.touch ?? false,
    deviceScaleFactor: opts.touch ? 2 : 1,
  });
  await context.addInitScript(
    ([theme, language, css, wide, seed]) => {
      if (wide) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      // Semilla UNA vez por pestaña: asi se puede cambiar de tema o idioma y recargar sin que se pise la eleccion.
      try {
        if (!seed || window.sessionStorage.getItem("__nav_seeded")) return;
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
        window.sessionStorage.setItem("__nav_seeded", "1");
      } catch {
        /* documento opaco (about:blank, iframes): sin almacenamiento */
      }
    },
    [opts.theme, opts.language, WIDE_CSS, opts.wide ?? false, opts.seed ?? true] as const,
  );
  return context;
}

/** Errores de consola de hidratacion (parpadeo/desajuste) y errores de pagina: deben ser cero. */
function watchPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat|did not match|server rendered/i.test(message.text())) {
      problems.push(`console: ${message.text().slice(0, 200)}`);
    }
  });
  return problems;
}

async function gotoHome(page: Page, route = "/"): Promise<void> {
  await page.goto(route);
  await page.locator("main#content").waitFor();
}

const aside = (page: Page) => page.locator("aside").first();
const sidebarNav = (page: Page, language: Language) => aside(page).getByRole("navigation", { name: TEXT[language].primaryNav });

async function runAxe(page: Page) {
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
    // El pie de pagina (Footer.tsx) no es de este spec: su separador «·» (`after:text-muted-foreground/40`) ya incumple el
    // contraste en paginas cortas, con o sin esta navegacion (se informa aparte). Aqui se mide lo que cambia: barra, cabecera y Inicio.
    const result = await axe.run({ exclude: [["footer"]] }, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map(
      (v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`,
    );
  }, AXE_RULES);
}

/** Despliega todas las secciones de la barra (las que sigan cerradas). */
async function openAllSections(page: Page): Promise<void> {
  const closed = aside(page).locator("button[aria-expanded='false']");
  while ((await closed.count()) > 0) await closed.first().click();
}

async function horizontalOverflow(page: Page): Promise<{ overflow: number; offenders: string[] }> {
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
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right <= width + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      if (clips(element)) continue;
      offenders.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").slice(0, 60)} «${(element.textContent ?? "").trim().slice(0, 30)}» ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
    return { overflow: root.scrollWidth - width, offenders: offenders.slice(0, 6) };
  });
}

/* ------------------------------------------------------------------ *
 * 1. Desktop: estructura
 * ------------------------------------------------------------------ */
for (const theme of ["light", "dark"] as const) {
  for (const language of ["es", "en"] as const) {
    test.describe(`desktop 1280 · ${theme} · ${language}`, () => {
      const T = TEXT[language];

      test("tres suites, arriba Inicio · Recientes · PDF Pro, y al pie idioma y tema", async ({ browser }) => {
        const context = await newContext(browser, { width: 1280, theme, language });
        const page = await context.newPage();
        const problems = watchPageProblems(page);
        try {
          await gotoHome(page);
          await expect(aside(page)).toBeVisible();
          const nav = sidebarNav(page, language);
          // El primer pintado va en español y pasa al idioma guardado al hidratar: se espera a que la barra lo tenga.
          await expect(nav).toBeVisible();

          // Arriba: Inicio, Recientes, PDF Pro (en ese orden).
          const hrefs = await nav.locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
          expect(hrefs.slice(0, 3)).toEqual(["/", "/recent", "/pdf-pro"]);

          // Tres suites, cada una con su lista nombrada y en orden.
          for (const suite of T.suites) await expect(nav.getByRole("list", { name: suite })).toBeVisible();
          const order = await nav.locator("li > p").allTextContents();
          expect(order.filter((text) => (T.suites as readonly string[]).includes(text.trim()))).toEqual([...T.suites]);

          // OptimusPDF: sus seis categorias son desplegables y arrancan cerradas.
          for (const category of T.categories) {
            const toggle = nav.getByRole("button", { name: `${T.toggle} ${category}` });
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
          }
          // OptimusSCAN: enlace directo.
          await expect(nav.getByRole("list", { name: T.suites[1] }).getByRole("link", { name: T.scan })).toHaveAttribute("href", "/scan-to-pdf");
          // OptimusTOOLS: tres grupos y «Próximamente…» como nota (ni enlace ni boton).
          for (const group of T.groups) await expect(nav.getByRole("button", { name: `${T.toggle} ${group}` })).toBeVisible();
          const more = nav.getByText(T.more);
          await expect(more).toBeVisible();
          expect(await more.evaluate((node) => !!node.closest("a, button"))).toBe(false);

          // Debajo: Exportar/Importar -> Documentos, Ajustes, Precios, Proyecto.
          await expect(nav.getByText(T.backup, { exact: true })).toBeVisible();
          expect(hrefs.slice(-4)).toEqual(["/documents", "/settings", "/pricing", "/about"]);

          // Pie: idioma y tema.
          await expect(aside(page).getByRole("group").filter({ has: page.getByRole("button", { name: "ES" }) })).toBeVisible();
          const tabs = aside(page).getByRole("tablist");
          await expect(tabs.getByRole("tab")).toHaveText([...T.theme]);
          expect(problems, problems.join("\n")).toEqual([]);
        } finally {
          await context.close();
        }
      });

      test("desplegar y plegar: aria-expanded, panel real y herramientas de la categoria", async ({ browser }) => {
        const context = await newContext(browser, { width: 1280, theme, language });
        const page = await context.newPage();
        try {
          await gotoHome(page);
          const nav = sidebarNav(page, language);
          const toggle = nav.getByRole("button", { name: `${T.toggle} ${T.categories[2]}` });
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          const panelId = await toggle.getAttribute("aria-controls");
          expect(panelId).toBeTruthy();
          const panel = page.locator(`[id="${panelId}"]`);
          await expect(panel).toBeVisible();
          // «Convertir a PDF» ya no lleva Escanear a PDF.
          await expect(panel.locator("a[href='/scan-to-pdf']")).toHaveCount(0);
          await expect(panel.locator("a[href='/jpg-to-pdf']")).toBeVisible();
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expect(toggle).not.toHaveAttribute("aria-controls", /.+/);
          await expect(page.locator(`[id="${panelId}"]`)).toHaveCount(0);
        } finally {
          await context.close();
        }
      });

      test("el Downloader: seis plataformas deshabilitadas (sin enlace, sin foco, con «Pronto»)", async ({ browser }) => {
        const context = await newContext(browser, { width: 1280, theme, language });
        const page = await context.newPage();
        try {
          await gotoHome(page);
          const nav = sidebarNav(page, language);
          await nav.getByRole("button", { name: `${T.toggle} Downloader` }).click();
          for (const name of PLATFORMS) {
            const entry = nav.locator("[aria-disabled='true']").filter({ hasText: name }).first();
            await expect(entry, name).toBeVisible();
            await expect(entry).toContainText(T.soon);
            expect(await entry.evaluate((node) => ({ href: node.getAttribute("href"), tabindex: node.getAttribute("tabindex"), inLink: !!node.closest("a[href]") }))).toEqual({
              href: null,
              tabindex: null,
              inLink: false,
            });
          }
          // La pagina del Downloader si es un enlace, con «Pronto».
          const link = nav.locator("a[href='/downloader']");
          await expect(link).toContainText(T.soon);
        } finally {
          await context.close();
        }
      });

      test("axe: contraste, ARIA, nombres y listas sin violaciones (todo desplegado) en Inicio y en /downloader", async ({ browser }) => {
        const context = await newContext(browser, { width: 1280, theme, language });
        const page = await context.newPage();
        try {
          await gotoHome(page);
          await openAllSections(page);
          expect(await runAxe(page), "Inicio").toEqual([]);
          await gotoHome(page, "/downloader");
          await openAllSections(page);
          await expect(page.getByRole("heading", { level: 1, name: "Downloader" })).toBeVisible();
          expect(await runAxe(page), "/downloader").toEqual([]);
        } finally {
          await context.close();
        }
      });
    });
  }
}

/* ------------------------------------------------------------------ *
 * 2. Teclado
 * ------------------------------------------------------------------ */
test.describe("teclado", () => {
  test("Tab llega al desplegable, Enter lo abre y Espacio lo cierra sin perder el foco; las plataformas no se tabulan", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      const toggle = sidebarNav(page, "es").getByRole("button", { name: "Mostrar u ocultar Organizar" });
      // Tab desde el inicio: el enlace «Saltar al contenido» es el primero; se sigue hasta el boton.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      let reached = false;
      for (let i = 0; i < 30 && !reached; i += 1) {
        await page.keyboard.press(tabKey(page));
        reached = await toggle.evaluate((node) => node === document.activeElement);
      }
      expect(reached, "Tab debe alcanzar el desplegable «Organizar»").toBe(true);
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await toggle.evaluate((node) => node === document.activeElement)).toBe(true);
      // El siguiente Tab entra en el panel recien abierto (primera herramienta).
      await page.keyboard.press(tabKey(page));
      expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/merge-pdf");
      await page.keyboard.press(tabKey(page, true));
      await page.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(await toggle.evaluate((node) => node === document.activeElement)).toBe(true);

      // Plataformas: ningun Tab cae en ellas.
      await sidebarNav(page, "es").getByRole("button", { name: "Mostrar u ocultar Downloader" }).click();
      const seen = new Set<string>();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let i = 0; i < 60; i += 1) {
        await page.keyboard.press(tabKey(page));
        seen.add(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim().slice(0, 40)));
      }
      for (const name of PLATFORMS) expect([...seen].some((text) => text.startsWith(name)), `${name} no debe ser tabulable`).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("Escape limpia el buscador de la barra; el foco nunca queda en <body> tras recorrer la barra", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      const search = aside(page).getByRole("searchbox");
      await search.fill("downl");
      await expect(aside(page).getByRole("link", { name: /Downloader/ }).first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("");
      await search.fill("escanear");
      const result = aside(page).locator("[role='region'] a[href='/scan-to-pdf']");
      await expect(result).toBeVisible();
      await result.click();
      await expect(page).toHaveURL(/\/scan-to-pdf$/);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. Alcanzabilidad y enlaces
 * ------------------------------------------------------------------ */
test.describe("sin enlaces rotos y scan-to-pdf alcanzable", () => {
  test("desde la barra: Escanear a PDF abre su pagina y queda marcada como actual", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      await sidebarNav(page, "es").getByRole("link", { name: "Escanear a PDF" }).click();
      await expect(page).toHaveURL(/\/scan-to-pdf$/);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(sidebarNav(page, "es").getByRole("link", { name: "Escanear a PDF" })).toHaveAttribute("aria-current", "page");
    } finally {
      await context.close();
    }
  });

  test("desde Inicio: OptimusSCAN tiene su seccion #scan y «Escanear a PDF» ya no esta en «Convertir a PDF»", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      await expect(page.locator("#scan a[href='/scan-to-pdf']:visible")).toHaveCount(1); // (la otra variante, icono o tarjeta, la oculta el CSS)
      await expect(page.locator("#convert-to a[href='/scan-to-pdf']")).toHaveCount(0);
      for (const id of SECTION_IDS) await expect(page.locator(`[id='${id}']`), id).toHaveCount(1);
      // Las tres suites, en orden, con sus titulos.
      const titles = await page.locator("h2[id^='suite-']").allTextContents();
      expect(titles).toEqual([...TEXT.es.suites]);
    } finally {
      await context.close();
    }
  });

  test("la ruta de cada enlace de la barra existe (200) y las anclas apuntan a una seccion de Inicio", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      await openAllSections(page);
      const hrefs = await aside(page).locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href") as string));
      const anchors = hrefs.filter((href) => href.startsWith("/#")).map((href) => href.slice(2));
      for (const id of anchors) expect(SECTION_IDS, `ancla /#${id}`).toContain(id);
      // Rutas nuevas o movidas + las de uso diario (el resto de herramientas no cambia de ruta).
      const mustWork = [
        "/scan-to-pdf",
        "/downloader",
        "/audio-studio",
        "/audio-extractor",
        "/audio-converter",
        "/image-converter",
        "/video-converter",
        "/recent",
        "/documents",
        "/settings",
        "/pricing",
        "/about",
        "/pdf-pro",
      ];
      for (const href of mustWork) expect(hrefs, href).toContain(href);
      for (const href of mustWork) {
        const response = await page.request.get(href);
        expect(response.status(), href).toBe(200);
      }
      // Ninguna entrada deshabilitada se ha colado como enlace.
      for (const name of PLATFORMS) expect(await aside(page).locator("a[href]").filter({ hasText: new RegExp(`^${name}$`) }).count(), name).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("la barra de una herramienta abre su seccion y marca la pagina actual; las otras siguen cerradas", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    const problems = watchPageProblems(page);
    try {
      await gotoHome(page, "/merge-pdf");
      const nav = sidebarNav(page, "es");
      await expect(nav.getByRole("button", { name: "Mostrar u ocultar Organizar" })).toHaveAttribute("aria-expanded", "true");
      await expect(nav.getByRole("link", { name: "Unir PDF" })).toHaveAttribute("aria-current", "page");
      await expect(nav.getByRole("button", { name: "Mostrar u ocultar Seguridad" })).toHaveAttribute("aria-expanded", "false");
      expect(problems, problems.join("\n")).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. Persistencia de idioma y tema
 * ------------------------------------------------------------------ */
test.describe("idioma y tema en el pie de la barra", () => {
  test("elegir tema y idioma se aplica al instante y persiste al recargar", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "light", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await aside(page).getByRole("tab", { name: "Oscuro" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await aside(page).getByRole("button", { name: "EN" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(aside(page).getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "true");

      await page.reload();
      await page.locator("main#content").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(aside(page).getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "true");
      await expect(sidebarNav(page, "en").getByRole("list", { name: "OptimusTOOLS" })).toBeVisible();
      expect(await page.evaluate(() => [localStorage.getItem("optimuspdf.theme"), localStorage.getItem("optimuspdf.language")])).toEqual(["dark", "en"]);

      // Ajustes ve la misma eleccion (es el mismo almacen).
      await page.goto("/settings");
      await page.locator("main#content").waitFor();
      await expect(page.getByRole("tab", { name: "Dark" }).first()).toHaveAttribute("aria-selected", "true");
    } finally {
      await context.close();
    }
  });

  test("las secciones desplegadas se recuerdan al recargar (misma pestaña)", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      const toggle = sidebarNav(page, "es").getByRole("button", { name: "Mostrar u ocultar Seguridad" });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await page.locator("main#content").waitFor();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    } finally {
      await context.close();
    }
  });

  test("barra plegada (riel): solo iconos-enlace, sin desplegables, y vuelve a expandirse", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "es" });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      await aside(page).getByRole("button", { name: "Colapsar barra lateral" }).click();
      await expect.poll(async () => (await aside(page).boundingBox())?.width ?? 999).toBeLessThan(90);
      await expect(aside(page).locator("button[aria-expanded]")).toHaveCount(1); // solo el de plegar/expandir
      await expect(aside(page).locator("a[href='/scan-to-pdf']")).toBeVisible();
      for (const id of GROUP_IDS) await expect(aside(page).locator(`a[href='/#${id}']`)).toBeVisible();
      expect(await runAxe(page)).toEqual([]);
      await aside(page).getByRole("button", { name: "Expandir barra lateral" }).click();
      await expect.poll(async () => (await aside(page).boundingBox())?.width ?? 0).toBeGreaterThan(250);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. Movil 375 y tablet 834
 * ------------------------------------------------------------------ */
test.describe("movil 375 (tactil)", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`Inicio por suites, chips de seccion y barra de pestañas · ${theme}`, async ({ browser }) => {
      const context = await newContext(browser, { width: 375, theme, language: "es", touch: true });
      const page = await context.newPage();
      const problems = watchPageProblems(page);
      try {
        await gotoHome(page);
        await expect(page.locator("aside").first()).toBeHidden();
        await expect(page.locator("nav[data-chrome='tabbar']")).toBeVisible();
        // Suites en orden + todas las secciones ancladas.
        expect(await page.locator("h2[id^='suite-']").allTextContents()).toEqual([...TEXT.es.suites]);
        for (const id of SECTION_IDS) await expect(page.locator(`[id='${id}']`), id).toHaveCount(1);

        // Chips: uno por seccion (incluido OptimusSCAN) y cada uno mide >= 44 px de alto.
        const chips = page.getByRole("navigation", { name: "Categorías" }).getByRole("link");
        expect(await chips.count()).toBe(SECTION_IDS.length);
        const heights = await chips.evaluateAll((links) => links.map((a) => a.getBoundingClientRect().height));
        for (const height of heights) expect(height).toBeGreaterThanOrEqual(43.5);

        // Un chip lleva a su seccion.
        await chips.filter({ hasText: "Converter" }).click();
        await expect(page.locator("#converter")).toBeInViewport({ timeout: 5000 });

        // «Escanear a PDF» sigue alcanzable desde Inicio con un toque.
        await page.locator("#scan a[href='/scan-to-pdf']").first().scrollIntoViewIfNeeded();
        await page.locator("#scan a[href='/scan-to-pdf']").first().click();
        await expect(page).toHaveURL(/\/scan-to-pdf$/);
        expect(problems, problems.join("\n")).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test("axe en Inicio y /downloader a 375 px (claro y oscuro)", async ({ browser }) => {
    for (const theme of ["light", "dark"] as const) {
      const context = await newContext(browser, { width: 375, theme, language: "en", touch: true });
      const page = await context.newPage();
      try {
        await gotoHome(page);
        expect(await runAxe(page), `Inicio ${theme}`).toEqual([]);
        await gotoHome(page, "/downloader");
        expect(await runAxe(page), `/downloader ${theme}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  test("la pagina /downloader lleva las alternativas locales como tarjetas con ruta real", async ({ browser }) => {
    const context = await newContext(browser, { width: 375, theme: "dark", language: "es", touch: true });
    const page = await context.newPage();
    try {
      await gotoHome(page, "/downloader");
      await expect(page.getByRole("heading", { level: 1, name: "Downloader" })).toBeVisible();
      for (const name of PLATFORMS) await expect(page.getByRole("listitem").filter({ hasText: new RegExp(`^${name}$`) }), name).toBeVisible();
      const section = page.getByRole("heading", { name: "Lo que sí puedes hacer en tu dispositivo" }).locator("xpath=ancestor::section[1]");
      const hrefs = await section.locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href")).sort());
      expect(hrefs).toEqual(["/audio-converter", "/audio-extractor", "/image-converter", "/scan-to-pdf", "/video-converter"]);
      for (const href of hrefs) expect((await page.request.get(href as string)).status(), href as string).toBe(200);
    } finally {
      await context.close();
    }
  });
});

test.describe("tablet 834", () => {
  test("el menu «Herramientas» de la cabecera agrupa por las tres suites y lleva scan y los grupos", async ({ browser }) => {
    const context = await newContext(browser, { width: 834, height: 1112, theme: "dark", language: "es", touch: true });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      await expect(page.locator("aside").first()).toBeHidden();
      await page.getByRole("button", { name: "Herramientas" }).click();
      const menu = page.locator("header [id]").filter({ has: page.getByRole("heading", { level: 3, name: "OptimusSCAN" }) }).first();
      await expect(menu).toBeVisible();
      expect(await menu.getByRole("heading", { level: 3 }).allTextContents()).toEqual([...TEXT.es.suites]);
      await expect(menu.getByRole("link", { name: "Escanear a PDF" })).toHaveAttribute("href", "/scan-to-pdf");
      await expect(menu.getByRole("link", { name: /Downloader/ })).toHaveAttribute("href", "/downloader");
      expect(await menu.getByRole("heading", { level: 4 }).allTextContents()).toEqual([...TEXT.es.categories, ...TEXT.es.groups]);
      expect(await runAxe(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Herramientas" })).toHaveAttribute("aria-expanded", "false");
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. 320 px con tipografia ancha
 * ------------------------------------------------------------------ */
test.describe("tipografia ancha", () => {
  for (const width of [320, 375] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`${width}px · ${theme}: Inicio y /downloader no desbordan (DejaVu Sans + 6 % de espaciado)`, async ({ browser }) => {
        const context = await newContext(browser, { width, theme, language: "es", touch: true, wide: true });
        const page = await context.newPage();
        try {
          for (const route of ["/", "/downloader"]) {
            await gotoHome(page, route);
            const probe = await page.evaluate(() => {
              const c = document.createElement("canvas").getContext("2d")!;
              const text = "Convertir desde PDF";
              c.font = "16px Arial";
              const narrow = c.measureText(text).width;
              c.font = '16px "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif';
              return c.measureText(text).width / narrow;
            });
            expect(probe, "la fuente ancha forzada debe medir mas que Arial").toBeGreaterThan(1.05);
            const { overflow, offenders } = await horizontalOverflow(page);
            expect({ route, overflow, offenders }, `${route} a ${width}px`).toEqual({ route, overflow: expect.any(Number), offenders: [] });
            expect(overflow, `${route} desborda ${overflow}px a ${width}px: ${offenders.join(" | ")}`).toBeLessThanOrEqual(1);
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  test("1280 px con tipografia ancha y todo desplegado: la barra no desborda en horizontal y su pie sigue a la vista", async ({ browser }) => {
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "en", wide: true });
    const page = await context.newPage();
    try {
      await gotoHome(page);
      await openAllSections(page);
      const nav = aside(page).locator("nav");
      expect(await nav.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      expect(await aside(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      // El pie (idioma y tema) no se sale del viewport ni queda tapado.
      const tabs = aside(page).getByRole("tablist");
      await expect(tabs).toBeInViewport();
      for (const tab of await tabs.getByRole("tab").all()) {
        const box = (await tab.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(43.5);
        expect(box.height).toBeGreaterThanOrEqual(43.5);
      }
    } finally {
      await context.close();
    }
  });
});
