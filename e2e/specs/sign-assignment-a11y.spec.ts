import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  SIGNER_1,
  SIGNER_2,
  continueToSign,
  defineSigners,
  makeSyntheticPdf,
  openSignAndUpload,
  placeSlot,
  signWholeTurn,
  waitForDraftSettled,
  type SyntheticDoc,
} from "../helpers/sign-flow";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";

/**
 * Firma agil · Fase 1: accesibilidad de las pantallas nuevas con axe-core (0 violaciones) en claro y oscuro, ES y EN, a
 * 1280 y a 375 px:
 *   1. la tabla «¿Quien firma que?» con copias, un aviso de problema y «Deshacer cambio» disponible;
 *   2. la ceremonia por grupos con el orden de los turnos (↑↓);
 *   3. «Revisar antes de descargar» con miniaturas, contadores y un aviso.
 * Ademas: objetivos tactiles >= 44 px (celdas, copias, flechas y miniaturas) y un solo `role="status"` propio de la
 * herramienta por pantalla (la region viva unica), mas el reflujo a tarjetas sin desplazamiento horizontal a 375 px.
 *
 * axe-core llega como dependencia transitiva de eslint-config-next (como en `a11y-sweep.spec.ts`). Headless siempre.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(300_000);

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
const DOC_NAMES = ["Contrato", "Anexo", "Carta"] as const;

async function newContext(browser: Browser, theme: Theme): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: theme,
    locale: "es-ES",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([themeName, key]) => {
      try {
        // UNA sola vez por pestana: una recarga o un cambio de idioma en caliente no se pisan.
        if (window.sessionStorage.getItem("__seeded")) return;
        window.localStorage.setItem("optimuspdf.theme", themeName);
        window.localStorage.setItem("optimuspdf.language", "es");
        window.localStorage.setItem(key, "1");
        window.sessionStorage.setItem("__seeded", "1");
      } catch {
        /* almacenamiento bloqueado */
      }
    },
    [theme, PRIVACY_SEEN_KEY],
  );
  return context;
}

async function switchLanguage(page: Page, to: Language): Promise<void> {
  const button = page.locator("button[aria-pressed]:visible").filter({ hasText: new RegExp(`^${to.toUpperCase()}$`) }).first();
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("lang", to);
}

type Violation = { id: string; help: string; nodes: string[] };

async function runAxe(page: Page): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    // «Continuar» queda pegado abajo (ER-02, auditoria movil/iPad) y flota sobre el contenido que se desplaza por debajo:
    // `target-size` lo cuenta como tapa de cualquier control que quede justo detras en el desplazamiento del momento. Se
    // oculta SOLO durante la medida (la propia pantalla, con el boton, la mide `mobile-sign-a11y.spec.ts`).
    const floating = [...document.querySelectorAll<HTMLElement>("[data-step-actions]")];
    for (const element of floating) element.style.visibility = "hidden";
    let result: Awaited<ReturnType<typeof axe.run>>;
    try {
      result = await axe.run(document.querySelector("main") ?? document, { runOnly: { type: "rule", values: [...rules] } });
    } finally {
      for (const element of floating) element.style.visibility = "";
    }
    return result.violations.map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n")[1] ?? ""}`),
    }));
  }, [...AXE_RULES]);
}

const describeViolations = (violations: Violation[]): string =>
  violations.map((violation) => `${violation.id} (${violation.help}):\n   ${violation.nodes.join("\n   ")}`).join("\n");

/** Las animaciones de entrada de las tarjetas terminan antes de medir contraste. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(900);
}

/** axe en las dos anchuras y los dos idiomas de la pantalla en curso; la deja en ES y a 1280 px. */
async function axeEverywhere(page: Page, label: string, extra?: (page: Page, width: number, language: Language) => Promise<void>): Promise<void> {
  const trace = process.env.A11Y_TRACE;
  const run = async (language: Language, width: number) => {
    await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
    await settle(page);
    if (trace) console.log(`[a11y] ${label} · ${language} · ${width}`);
    const violations = await runAxe(page);
    expect(violations, `${label} · ${language} · ${width}px\n${describeViolations(violations)}`).toEqual([]);
    await extra?.(page, width, language);
  };
  try {
    for (const width of [1280, 375]) await run("es", width);
    await switchLanguage(page, "en");
    for (const width of [375, 1280]) await run("en", width);
  } finally {
    if ((await page.locator("html").getAttribute("lang")) !== "es") await switchLanguage(page, "es");
    await page.setViewportSize({ width: 1280, height: 900 });
  }
}

/** Los controles NUEVOS de la Fase 1 que se tocan con el dedo miden >= 44 px de alto (43,5 por el redondeo). */
async function expectTouchTargets(page: Page, selector: string, label: string): Promise<void> {
  const small = await page.evaluate((query) => {
    const bad: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(query)) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.height < 43.5) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return bad;
  }, selector);
  expect(small, `${label}: objetivos de toque menores de 44 px`).toEqual([]);
  expect(await page.locator(selector).count(), `${label}: hay controles que medir`).toBeGreaterThan(0);
}

async function twoDocs(): Promise<SyntheticDoc[]> {
  return Promise.all(
    DOC_NAMES.slice(0, 2).map(async (name) => ({ name: `${name}.pdf`, mimeType: "application/pdf" as const, buffer: await makeSyntheticPdf(name, 2) })),
  );
}

async function threeDocs(): Promise<SyntheticDoc[]> {
  return Promise.all(
    DOC_NAMES.map(async (name) => ({ name: `${name}.pdf`, mimeType: "application/pdf" as const, buffer: await makeSyntheticPdf(name, 2) })),
  );
}

/** Un hueco de firma de cada firmante en cada documento (paso «Documento»). */
async function placeSlots(page: Page, docNames: readonly string[]): Promise<void> {
  await page.getByRole("button", { name: "2. Documento" }).click();
  for (const [index, name] of docNames.entries()) {
    const tab = page.getByRole("button", { name: `${index + 1}. ${name}.pdf` });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-current", "true");
    if (index > 0) await expect(page.locator("[data-sequence-live]")).toContainText(`Documento ${index + 1} de ${docNames.length}: ${name}.pdf`);
    await placeSlot(page, SIGNER_1, 100);
    await placeSlot(page, SIGNER_2, 200);
  }
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`axe-core en las pantallas de la Fase 1 · ${theme}`, () => {
    test("tabla «¿Quién firma qué?» (con copias, un problema y «Deshacer cambio») y celdas de 44 px", async ({ browser }) => {
      const context = await newContext(browser, theme);
      const page = await context.newPage();
      try {
        await openSignAndUpload(page, await threeDocs());
        await defineSigners(page);
        // Algo que ensenar: un grupo partido, copias y el aviso de un hueco sin firmante.
        await placeSlots(page, DOC_NAMES);
        await page.getByRole("button", { name: "1. Firmantes" }).click();
        await page.getByRole("button", { name: "Por grupos" }).click();
        await page.getByRole("button", { name: "Una copia más en todos los documentos" }).click();
        await page.getByRole("button", { name: "Ana en Carta: Firma B" }).click();
        await page.getByRole("button", { name: "Ana en Carta: no firma" }).click().catch(() => undefined);
        await expect(page.getByRole("grid", { name: /Quién firma cada documento/ })).toBeVisible();
        await expect(page.getByRole("button", { name: "Deshacer cambio" })).toBeEnabled();

        await axeEverywhere(page, `tabla · ${theme}`, async (current, width) => {
          if (width < 600) {
            // Tarjetas: sin desplazamiento horizontal y con el nombre del firmante junto a cada celda.
            const overflow = await current.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow, "sin scroll horizontal a 375 px").toBeLessThanOrEqual(1);
            const row = current.getByRole("grid").getByRole("row").nth(1);
            await expect(row).toHaveCSS("display", "flex");
          } else {
            const row = current.getByRole("grid").getByRole("row").nth(1);
            await expect(row).toHaveCSS("display", "grid");
          }
        });
        const liveInTable = await page.getByRole("grid").evaluate(
          (grid) => grid.closest("section")!.querySelectorAll("[role='status'], [role='alert'], [aria-live]").length,
        );
        expect(liveInTable, "regiones vivas dentro de la tabla (el anuncio va por la region unica de la herramienta)").toBe(0);
        const cell = page.getByRole("button", { name: /Ana en Contrato/ }).first();
        const box = await cell.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
        await expectTouchTargets(page, "[data-cell], [role='gridcell'] button", "tabla (celdas y copias)");
      } finally {
        await context.close();
      }
    });

    test("ceremonia con el orden de los turnos y «Revisar antes de descargar»", async ({ browser }) => {
      const context = await newContext(browser, theme);
      const page = await context.newPage();
      try {
        await openSignAndUpload(page, await twoDocs());
        await defineSigners(page);
        await placeSlots(page, DOC_NAMES.slice(0, 2));
        await continueToSign(page);
        // Traspaso: lista de turnos con ↑ ↓.
        await expect(page.getByRole("button", { name: `Bajar a ${SIGNER_1}` })).toBeVisible();
        await axeEverywhere(page, `ceremonia con orden · ${theme}`);
        await expectTouchTargets(page, "button[aria-label^='Subir a'], button[aria-label^='Bajar a']", "ceremonia (flechas de turno)");

        await signWholeTurn(page, 1, 10, false);
        await signWholeTurn(page, 1, 20, true);
        await expect(page.getByRole("heading", { name: "Revisar antes de descargar" })).toBeVisible();
        await waitForDraftSettled(page);
        // Las miniaturas llegan de una en una: todas listas antes de medir.
        await expect(page.locator("[data-review-page] img")).toHaveCount(2, { timeout: 30_000 });
        await axeEverywhere(page, `revisar antes de descargar · ${theme}`, async (current, width) => {
          const overflow = await current.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `sin scroll horizontal a ${width} px`).toBeLessThanOrEqual(1);
        });
        await expectTouchTargets(page, "[data-review-page]", "revisión (miniaturas)");
        // La revision no crea regiones vivas propias: la ceremonia y la herramienta ya tienen la suya (una sola).
        const live = await page.getByRole("heading", { name: "Revisar antes de descargar" }).evaluate(
          (heading) => heading.closest("section")!.querySelectorAll("[role='status'], [role='alert'], [aria-live]").length,
        );
        expect(live, "regiones vivas dentro de «Revisar antes de descargar»").toBe(0);
      } finally {
        await context.close();
      }
    });
  });
}
