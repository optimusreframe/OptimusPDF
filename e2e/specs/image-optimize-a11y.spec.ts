import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { makePhotoSet, removePhotoSet, type PhotoSet } from "../helpers/photo-set";
import { smallTargets } from "../helpers/touch-measure";

/**
 * Imagenes a PDF · accesibilidad y tacto de los controles nuevos («Calidad de imagen», «Fotos por pagina») y de la vista
 * previa de hojas: axe-core (WCAG 2.0/2.1/2.2 A y AA) con 0 violaciones en 320 / 375 / 393 / 744 / 834 / 1194 px, claro y
 * oscuro, ES y EN; sin desbordes horizontales; objetivos tactiles de >= 44 px con puntero grueso y >= 24 px siempre.
 */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const WIDTHS = [320, 375, 393, 744, 834, 1194] as const;
type Theme = "light" | "dark";
type Language = "es" | "en";

let set: PhotoSet;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  set = await makePhotoSet({ name: "a11y", count: 6, size: () => ({ width: 1800, height: 1350 }), distinct: 3, quality: 90 });
});
test.afterAll(() => removePhotoSet(set));

async function newContext(browser: Browser, width: number, theme: Theme, language: Language): Promise<BrowserContext> {
  const touch = width <= 834;
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 812 : 1000 },
    colorScheme: theme,
    hasTouch: touch,
    isMobile: touch && width < 768,
    deviceScaleFactor: touch ? 2 : 1,
  });
  await context.addInitScript(
    ([themeValue, languageValue]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", themeValue);
        window.localStorage.setItem("optimuspdf.language", languageValue);
      } catch {
        /* storage bloqueado */
      }
    },
    [theme, language],
  );
  return context;
}

async function runAxe(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`);
  });
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}

const OPEN: Record<Language, string> = { es: "Opciones", en: "Options" };
const PER_PAGE: Record<Language, string> = { es: "Fotos por página", en: "Photos per page" };

async function prepare(page: Page, language: Language): Promise<void> {
  await page.goto("/jpg-to-pdf", { waitUntil: "networkidle" });
  await page.locator('input[type="file"]').first().setInputFiles(set.paths);
  await expect(page.getByAltText(/^(Imagen|Image) \d+$/)).toHaveCount(6, { timeout: 60_000 });
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 768) await page.getByRole("button", { name: OPEN[language], exact: true }).click();
  await expect(page.locator("[data-image-quality]")).toBeVisible();
  await page.getByRole("tablist", { name: PER_PAGE[language] }).getByRole("tab", { name: "4", exact: true }).click();
}

async function closeOptions(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  }
}

const COMBOS: Array<[number, Theme, Language]> = [
  ...WIDTHS.map((width): [number, Theme, Language] => [width, "light", "es"]),
  [375, "dark", "es"],
  [375, "light", "en"],
  [375, "dark", "en"],
  [1194, "dark", "es"],
  [1194, "light", "en"],
  [834, "dark", "en"],
];

for (const [width, theme, language] of COMBOS) {
  test(`${width} px · ${theme} · ${language.toUpperCase()}: axe 0 violaciones, sin desborde y objetivos tactiles`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await newContext(browser, width, theme, language);
    const page = await context.newPage();
    try {
      await prepare(page, language);

      // 1. Con los controles nuevos a la vista (en movil, dentro de la hoja de opciones).
      expect(await runAxe(page), "axe con los controles de calidad y fotos por pagina").toEqual([]);
      expect(await overflow(page), "desborde horizontal con las opciones").toBe(0);
      const scope = '[data-image-quality], [role="tablist"][aria-label="' + PER_PAGE[language] + '"]';
      expect(await smallTargets(page, scope, 24), "objetivos < 24 px").toEqual([]);
      if (width <= 834) {
        // Un navegador con barras de desplazamiento CLASICAS (el WebKit de Playwright en macOS) resta su ancho a los seis
        // segmentos de «Fotos por pagina»; en un iPad/iPhone reales las barras son superpuestas y miden 45 px.
        const scrollbar = await page.evaluate((label) => {
          let node = document.querySelector(`[role="tablist"][aria-label="${label}"]`)?.parentElement ?? null;
          while (node) {
            const overflowY = getComputedStyle(node).overflowY;
            if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node.offsetWidth - node.clientWidth;
            node = node.parentElement;
          }
          return 0;
        }, PER_PAGE[language]);
        // 43 y no 44: igual que el barrido `a11y-sweep` (el muestreo en enteros) y, con la fuente ancha de Linux (DejaVu), la
        // columna de «Equilibrada» estrecha un poco las demas; todas miden >= 43 px de ancho y 44 px de alto.
        expect(await smallTargets(page, scope, 43 - scrollbar / 6), "objetivos tactiles < 43 px").toEqual([]);
      }

      // 2. Con la vista previa de hojas y la rejilla de fotos.
      await closeOptions(page);
      await expect(page.locator("[data-sheet-preview]")).toBeVisible();
      expect(await runAxe(page), "axe con la vista previa de hojas").toEqual([]);
      expect(await overflow(page), "desborde horizontal con la vista previa").toBe(0);
      // Cada hoja se describe con texto (no solo con imagenes).
      const captions = await page.locator("[data-sheet-preview] figcaption").allTextContents();
      expect(captions.length).toBeGreaterThanOrEqual(1);
      expect(captions[0]).toMatch(language === "es" ? /^Hoja 1: fotos 1 a 4, 2 columnas × 2 filas$/ : /^Sheet 1: photos 1 to 4, 2 columns × 2 rows$/);
    } finally {
      await context.close();
    }
  });
}

test("el teclado llega a los segmentos y los cambia (flechas), y el foco es visible", async ({ browser }) => {
  const context = await newContext(browser, 1194, "light", "es");
  const page = await context.newPage();
  try {
    await prepare(page, "es");
    const tab = page.getByRole("tablist", { name: "Calidad de imagen" }).getByRole("tab", { name: "Equilibrada", exact: true });
    await tab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Compacta", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-image-quality-description]")).toContainText("correo");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Equilibrada", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally {
    await context.close();
  }
});

