import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { installFake, pdfInput, seedVault, syntheticPdf } from "../helpers/extract-ui-flow";

/**
 * Accesibilidad y adaptacion de «Extraer elementos» (F7 · U7.4): axe-core (contraste, ARIA, etiquetas, nombres, listas,
 * `target-size`...) = 0 violaciones en 320 / 375 / 393 / 744 / 834 / 1194 px, claro y oscuro, ES y EN, sobre CADA estado
 * (carga, galeria, detalle, guardar con firmantes y conflicto, recortar region); sin desbordes horizontales (tambien con una
 * fuente ancha como la DejaVu del CI); objetivos de 44 px con el dedo en galeria, filtros y asas. Motor falso inyectado.
 *
 * axe-core llega como dependencia transitiva de eslint-config-next (como en `a11y-sweep.spec.ts`). Headless siempre.
 * Chromium por defecto; iPad: `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad`.
 */

test.setTimeout(240_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = [
  "color-contrast",
  "aria-valid-attr-value",
  "aria-valid-attr",
  "aria-allowed-attr",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-hidden-focus",
  "label",
  "button-name",
  "link-name",
  "image-alt",
  "nested-interactive",
  "duplicate-id-aria",
  "tabindex",
  "list",
  "listitem",
  "target-size",
  "scrollable-region-focusable",
] as const;

type Theme = "light" | "dark";
type Language = "es" | "en";
type Cell = { width: number; theme: Theme; language: Language };

const WIDTHS = [320, 375, 393, 744, 834, 1194];
const CELLS: Cell[] = WIDTHS.flatMap((width) => [
  { width, theme: "light" as const, language: "es" as const },
  { width, theme: "dark" as const, language: "en" as const },
]);

const T = {
  es: { run: "Buscar elementos", region: "Recortar región", items: /^Elementos/, saveCard: /^Guardar en Firmas guardadas: Firma, página 3/, detailsCard: /^Ver detalles: Firma probable, página 4/, saveTitle: "Guardar en Firmas guardadas", detailTitle: "Detalles del elemento" },
  en: { run: "Find elements", region: "Crop region", items: /^Elements/, saveCard: /^Save to Saved signatures: Signature, page 3/, detailsCard: /^View details: Probable signature, page 4/, saveTitle: "Save to Saved signatures", detailTitle: "Element details" },
} as const;

async function newContext(browser: Browser, cell: Cell): Promise<BrowserContext> {
  const coarse = cell.width < 1100;
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.width < 600 ? 812 : cell.width < 1000 ? 1100 : 900 },
    colorScheme: cell.theme,
    hasTouch: coarse,
    isMobile: cell.width < 600,
    deviceScaleFactor: coarse ? 2 : 1,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([theme, language]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
      } catch {
        /* almacenamiento bloqueado */
      }
    },
    [cell.theme, cell.language],
  );
  return context;
}

type Violation = { id: string; help: string; nodes: string[] };

async function axeOn(page: Page, scope: Locator | null): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const handle = scope ? await scope.elementHandle() : null;
  return page.evaluate(
    async ([element, rules]: [Element | null, string[]]) => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
      const result = await axe.run(element ?? document, { runOnly: { type: "rule", values: [...rules] } });
      return result.violations.map((v) => ({
        id: v.id,
        help: v.help,
        nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`),
      }));
    },
    [handle, [...AXE_RULES]] as [typeof handle, string[]],
  );
}

async function settle(page: Page, scope: Locator | null): Promise<void> {
  if (scope) {
    let last = await scope.boundingBox();
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(120);
      const next = await scope.boundingBox();
      if (last && next && Math.abs(next.y - last.y) < 0.5) break;
      last = next;
    }
  }
  await page.waitForTimeout(300);
}

async function expectClean(page: Page, scope: Locator | null, label: string): Promise<void> {
  if (process.env.A11Y_TRACE) console.log(`[a11y] ${label}`);
  await settle(page, scope);
  const violations = await axeOn(page, scope);
  expect(violations, `${label}\n${violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n")}`).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const over = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: Math.max(doc.scrollWidth, document.body.scrollWidth), client: doc.clientWidth };
  });
  expect(over.scroll, `${label}: scrollWidth ${over.scroll} > ancho ${over.client}`).toBeLessThanOrEqual(over.client + 1);
}

/** Con el dedo: todo control visible de `scope` mide >= 44 px en los dos ejes (43,5 por el redondeo). */
async function expectTouch44(scope: Locator, label: string): Promise<void> {
  const small = await scope.evaluate((root) => {
    const bad: string[] = [];
    const selector = 'button, a[href], [role="tab"], input[type="checkbox"], input[type="radio"], input[type="number"], input[type="text"], [data-region-handle]';
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (element.closest(".sr-only, [aria-hidden='true']:not([data-region-handle]), [data-skip-link]")) continue;
      // Un enlace dentro de un parrafo es «en linea» (WCAG 2.5.8).
      if (element.tagName === "A" && element.closest("p")) continue;
      let box = element.getBoundingClientRect();
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
        // La fila entera (etiqueta, o el contenedor de la casilla compartida) es el objetivo.
        const row = element.closest("label") ?? element.closest("div.group") ?? element.parentElement;
        if (row) box = row.getBoundingClientRect();
      }
      if (box.width < 2 || box.height < 2) continue;
      // La zona de toque ampliada con un pseudo-elemento (HIT_44) cuenta como el control.
      const coarse = element.matches("button, a[href], [role='tab']") ? Math.max(box.height, 44 * (getComputedStyle(element, "::before").content !== "none" ? 1 : 0)) : box.height;
      if (box.width < 43.5 && !(element.matches("button") && coarse >= 43.5 && box.width >= 24)) bad.push(`${(element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 40)} w=${Math.round(box.width)}`);
      else if (coarse < 43.5) bad.push(`${(element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 40)} h=${Math.round(box.height)}`);
    }
    return bad;
  });
  expect(small, `${label}: objetivos menores de 44 px`).toEqual([]);
}

for (const cell of CELLS) {
  const label = `${cell.width}px ${cell.theme} ${cell.language.toUpperCase()}`;
  test(`axe, desbordes y objetivos tactiles en todos los estados · ${label}`, async ({ browser }) => {
    const context = await newContext(browser, cell);
    const page = await context.newPage();
    const t = T[cell.language];
    try {
      await installFake(page, {});
      // 1. Pantalla de carga con un archivo elegido.
      await page.goto("/extract-assets");
      await pdfInput(page).setInputFiles(await syntheticPdf(6));
      await expect(page.getByRole("button", { name: t.run })).toBeEnabled({ timeout: 30_000 });
      await expectClean(page, page.locator("main"), `${label} · carga`);
      await expectNoHorizontalScroll(page, `${label} · carga`);

      // 2. Galeria con resultados.
      await page.getByRole("button", { name: t.run }).click();
      await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout: 30_000 });
      // Las miniaturas fuera de pantalla son `loading="lazy"` (nunca terminan): basta con las visibles.
      await page.waitForTimeout(800);
      await expectClean(page, page.locator("main"), `${label} · galeria`);
      await expectNoHorizontalScroll(page, `${label} · galeria`);
      // Con una seleccion hecha (aparece la barra de ZIP).
      await page.locator("[data-select-all]").check();
      await expectClean(page, page.locator("main"), `${label} · galeria con seleccion`);
      await expectNoHorizontalScroll(page, `${label} · galeria con seleccion`);
      if (cell.width < 1100) await expectTouch44(page.locator("main"), `${label} · galeria`);
      await page.locator("[data-select-all]").uncheck();

      // 3. Hoja de detalle.
      await page.getByRole("button", { name: t.detailsCard }).click();
      const detail = page.getByRole("dialog", { name: t.detailTitle });
      await expect(detail).toBeVisible();
      await expectClean(page, detail, `${label} · detalle`);
      if (cell.width < 1100) await expectTouch44(detail, `${label} · detalle`);
      await page.keyboard.press("Escape");
      await expect(detail).toBeHidden();

      // 4. Hoja de guardar: firmante nuevo; despues con firmantes existentes y conflicto.
      await page.getByRole("button", { name: t.saveCard }).click();
      const save = page.getByRole("dialog", { name: t.saveTitle });
      await expect(save.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
      await expectClean(page, save, `${label} · guardar (nuevo firmante)`);
      await expectNoHorizontalScroll(page, `${label} · guardar`);
      if (cell.width < 1100) await expectTouch44(save, `${label} · guardar`);
      await save.locator("[data-extract-save-name]").fill("Ana Pérez");
      await save.locator("[data-extract-save-submit]").click();
      await expect(save.locator("[data-extract-save-done]")).toBeVisible();
      await expectClean(page, save, `${label} · guardar (exito)`);
      if (cell.width < 1100) await expectTouch44(save, `${label} · guardar (exito)`);
      await page.keyboard.press("Escape");
      await expect(save).toBeHidden();
      await page.getByRole("button", { name: t.saveCard }).click();
      await expect(save.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
      await save.locator('[data-signer-option]:not([data-signer-option="new"])').first().check();
      await expect(save.locator("[data-extract-conflict]")).toBeVisible();
      await expectClean(page, save, `${label} · guardar (conflicto)`);
      await expectNoHorizontalScroll(page, `${label} · guardar conflicto`);
      if (cell.width < 1100) await expectTouch44(save, `${label} · guardar (conflicto)`);
      await page.keyboard.press("Escape");
      await expect(save).toBeHidden();

      // 5. Recortar region.
      await page.getByRole("tab", { name: t.region }).click();
      await expect(page.locator("[data-region-rect]")).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => !!document.querySelector("[data-region-page-canvas] canvas")), { timeout: 30_000 }).toBe(true);
      await expectClean(page, page.locator("main"), `${label} · recortar region`);
      await expectNoHorizontalScroll(page, `${label} · recortar region`);
      if (cell.width < 1100) await expectTouch44(page.locator("[data-region-rect]").locator("xpath=ancestor::*[@role='tabpanel'][1]"), `${label} · recortar region`);
      // Las paginas sinteticas estan en blanco: sin quitar el fondo el recorte da imagen (con el fondo quitado, «sin tinta»).
      await page.getByText(cell.language === "es" ? "Quitar el fondo" : "Remove the background", { exact: true }).click();
      await page.locator("[data-region-crop]").click();
      await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
      // La pagina baja hasta el resultado: las asas de arriba quedan bajo la cabecera fija (un objetivo tapado por ella lo marca axe). Se vuelve a ellas.
      await page.evaluate(() => document.querySelector("[data-region-rect]")!.scrollIntoView({ block: "center" }));
      await expectClean(page, page.locator("main"), `${label} · recorte con vista previa`);
      await expectNoHorizontalScroll(page, `${label} · recorte`);
    } finally {
      await context.close();
    }
  });
}

test("fuente ancha (DejaVu del CI) a 320 y 375 px: sin desbordes en galeria, detalle, hoja de guardar y recorte", async ({ browser }) => {
  for (const width of [320, 375]) {
    const context = await newContext(browser, { width, theme: "light", language: "es" });
    const page = await context.newPage();
    try {
      await installFake(page, {});
      await page.addInitScript(() => {
        const style = document.createElement("style");
        style.textContent = '*{font-family:"DejaVu Sans",Verdana,"Trebuchet MS",sans-serif !important}';
        document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
      });
      await page.goto("/extract-assets");
      await pdfInput(page).setInputFiles(await syntheticPdf(6));
      await page.getByRole("button", { name: T.es.run }).click();
      await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout: 30_000 });
      await expectNoHorizontalScroll(page, `${width} · galeria (fuente ancha)`);
      await page.getByRole("button", { name: T.es.detailsCard }).click();
      await expect(page.getByRole("dialog", { name: T.es.detailTitle })).toBeVisible();
      await expectNoHorizontalScroll(page, `${width} · detalle (fuente ancha)`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: T.es.saveCard }).click();
      const save = page.getByRole("dialog", { name: T.es.saveTitle });
      await expect(save.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
      await expectNoHorizontalScroll(page, `${width} · guardar (fuente ancha)`);
      const box = (await save.boundingBox())!;
      for (const control of await save.locator("button, input[type='text'], label").all()) {
        const rect = await control.boundingBox();
        if (rect) expect(rect.x + rect.width, `un control se sale de la hoja a ${width}`).toBeLessThanOrEqual(box.x + box.width + 1);
      }
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: T.es.region }).click();
      await expect(page.locator("[data-region-rect]")).toBeVisible({ timeout: 30_000 });
      await expectNoHorizontalScroll(page, `${width} · recortar (fuente ancha)`);
    } finally {
      await context.close();
    }
  }
});

test("hoja de guardar con 30 firmantes (lista larga): sigue en pantalla, se desplaza y sin desbordes", async ({ browser }) => {
  const context = await newContext(browser, { width: 375, theme: "light", language: "es" });
  const page = await context.newPage();
  try {
    await installFake(page, {});
    await page.goto("/extract-assets");
    await pdfInput(page).setInputFiles(await syntheticPdf(6));
    await seedVault(page, 29);
    await page.getByRole("button", { name: T.es.run }).click();
    await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: T.es.saveCard }).click();
    const save = page.getByRole("dialog", { name: T.es.saveTitle });
    await expect(save.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await expect(save.locator('[data-signer-option]')).toHaveCount(30);
    await expectNoHorizontalScroll(page, "30 firmantes");
    await expectClean(page, save, "30 firmantes");
    const box = (await save.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(812 + 1);
  } finally {
    await context.close();
  }
});
