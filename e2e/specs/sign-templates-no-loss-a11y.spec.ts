import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { makeContract, reexport } from "../helpers/template-pdfs";
import { PAGES, configureTwoSigners, notices, upload } from "../helpers/template-session-flow";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";

/**
 * Firma agil · Fase 2 · F2-fix: accesibilidad con axe-core (0 violaciones) en claro y oscuro, ES y EN, a 1280 y a 375 px de
 *   1. la hoja de confirmacion «¿Cambiar a 1 firmante?» (y el aviso «Plantilla aplicada» que la abre) y
 *   2. la tarjeta «Plantilla desactualizada» de «Mis documentos».
 * Ademas: botones de la hoja >= 44 px y sin desbordes a 375 px. Headless siempre. axe-core llega como dependencia transitiva.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(420_000);

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
  "heading-order",
  "scrollable-region-focusable",
  "target-size",
] as const;

type Language = "es" | "en";
type Theme = "light" | "dark";
const WIDTHS = [1280, 375] as const;

async function newContext(browser: Browser, theme: Theme): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, locale: "es-ES", acceptDownloads: true });
  await context.addInitScript(
    ([themeName, key]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", themeName);
        window.localStorage.setItem(key, "1");
      } catch {
        /* almacenamiento bloqueado */
      }
    },
    [theme, PRIVACY_SEEN_KEY],
  );
  return context;
}

async function setLanguage(page: Page, language: Language): Promise<void> {
  await page.evaluate((lang) => window.localStorage.setItem("optimuspdf.language", lang), language);
}

type Violation = { id: string; help: string; nodes: string[] };

async function runAxe(page: Page, selector: string): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(
    async ({ rules, scope }) => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
      const root = document.querySelector(scope);
      if (!root) throw new Error(`no hay ${scope}`);
      const result = await axe.run(root, { runOnly: { type: "rule", values: [...rules] } });
      return result.violations.map((violation) => ({
        id: violation.id,
        help: violation.help,
        nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n")[1] ?? ""}`),
      }));
    },
    { rules: [...AXE_RULES], scope: selector },
  );
}

const describeViolations = (violations: Violation[]): string => violations.map((violation) => `${violation.id} (${violation.help}):\n   ${violation.nodes.join("\n   ")}`).join("\n");

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

for (const theme of ["light", "dark"] as const) {
  test(`(a11y) hoja «¿Cambiar a 1 firmante?» y tarjeta «Plantilla desactualizada» · ${theme} · ES/EN · 1280/375`, async ({ browser }) => {
    const context = await newContext(browser, theme);
    const page = await context.newPage();
    try {
      const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
      await configureTwoSigners(page, original, "Mold Test Agreement.pdf");

      for (const language of ["es", "en"] as const) {
        for (const width of WIDTHS) {
          const label = `${theme} · ${language} · ${width}px`;
          await page.setViewportSize({ width, height: width === 1280 ? 900 : 800 });
          await page.goto("/sign-pdf");
          await setLanguage(page, language);
          await page.reload();
          await upload(page, "Mold Test.pdf", await reexport(original));
          await expect(page.locator('[data-template-notice="applied"]')).toBeVisible({ timeout: 25_000 });
          // Un nombre real para el firmante 2 y «1 firmante»: abre la hoja de confirmacion.
          await page.getByLabel(language === "es" ? "Nombre del firmante 2" : "Name of signer 2").fill("Marta Ruiz");
          await notices(page).getByRole("tab").first().click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          await expect(dialog).toContainText(language === "es" ? "quitará al firmante Marta Ruiz" : "will remove signer Marta Ruiz");
          await settle(page);
          const buttons = dialog.getByRole("button");
          const count = await buttons.count();
          for (let index = 0; index < count; index += 1) {
            const box = await buttons.nth(index).boundingBox();
            if (box && box.width > 0) expect(box.height, `${label}: boton ${index} de la hoja`).toBeGreaterThanOrEqual(43.5);
          }
          expect(await runAxe(page, '[role="dialog"]'), `${label}: hoja de confirmacion`).toEqual([]);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${label}: desborde horizontal`).toBeLessThanOrEqual(1);
          await dialog.getByRole("button").filter({ hasText: language === "es" ? /^Cancelar$/ : /^Cancel$/ }).click();
          await expect(dialog).toBeHidden();
          // El aviso ya sin la hoja (con «Deshacer» oculto por el nombre escrito).
          expect(await runAxe(page, "[data-template-notices]"), `${label}: aviso de plantilla aplicada`).toEqual([]);
        }
      }

      // La tarjeta desactualizada de «Mis documentos».
      await page.setViewportSize({ width: 1280, height: 900 });
      await setLanguage(page, "es");
      await page.goto("/documents");
      const card = page.locator("[data-document-id]").first();
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: /^Más acciones de/ }).click();
      const menu = page.getByRole("dialog");
      const other = await makeContract({ label: "Zulu Totally Different Agreement", pages: PAGES, signers: 2 });
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), menu.getByRole("button", { name: "Reemplazar PDF" }).click()]);
      await chooser.setFiles({ name: "nuevo.pdf", mimeType: "application/pdf", buffer: other });
      await expect(card.locator('[data-template-state="stale"]')).toBeVisible({ timeout: 25_000 });
      for (const language of ["es", "en"] as const) {
        for (const width of WIDTHS) {
          const label = `${theme} · ${language} · ${width}px`;
          await page.setViewportSize({ width, height: width === 1280 ? 900 : 800 });
          await setLanguage(page, language);
          await page.reload();
          await expect(page.locator('[data-template-state="stale"]')).toBeVisible();
          await settle(page);
          expect(await runAxe(page, "main"), `${label}: tarjeta desactualizada`).toEqual([]);
          const cardBox = await page.locator("[data-document-id]").first().boundingBox();
          expect(cardBox!.width, `${label}: tarjeta dentro de la pantalla`).toBeLessThanOrEqual(width);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${label}: desborde horizontal de /documents`).toBeLessThanOrEqual(1);
          for (const button of await page.locator("[data-document-id]").first().getByRole("button").all()) {
            const box = await button.boundingBox();
            if (box && box.width > 0) expect(box.height, `${label}: boton de la tarjeta`).toBeGreaterThanOrEqual(43.5);
          }
        }
      }
    } finally {
      await context.close();
    }
  });
}

void describeViolations;
