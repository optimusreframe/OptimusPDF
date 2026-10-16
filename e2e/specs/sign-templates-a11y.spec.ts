import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { LINE, chooseForEditor, dragOnSheet, pickTool, placeSignatureBlock, sheet } from "../helpers/template-flow";
import { makeContract } from "../helpers/template-pdfs";
import { PAGES, configureTwoSigners, notices, upload } from "../helpers/template-session-flow";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";

/**
 * Firma agil · Fase 2 · U2.3 + U2.4: accesibilidad con axe-core (0 violaciones) en claro y oscuro, ES y EN, a 1280 y a 375 px de
 *   1. el editor «Configurar plantilla» (con campos colocados a mano, las sugerencias del automapeo, un campo de texto
 *      seleccionado y el aviso de guardado), y
 *   2. los avisos de la aplicacion automatica: «Parece la plantilla (85 %)», «Plantilla aplicada» con paginas a revisar y
 *      «Detectamos N campos» con el panel «Sugerencias (M)».
 * Ademas: controles tactiles >= 44 px y sin desbordes horizontales a 375 px. Headless siempre. axe-core llega como dependencia
 * transitiva. Cada prueba recorre tema x idioma x anchura en UNA sola pagina (el idioma se cambia en caliente con el boton de la
 * cabecera), asi el editor y los avisos se montan una vez por tema.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(480_000);

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

async function newContext(browser: Browser, theme: Theme): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, locale: "es-ES", acceptDownloads: true });
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

/** Las animaciones de entrada terminan antes de medir contraste. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

const TOUCH_SELECTOR = 'button, summary, select, [role="tab"], [role="radio"], input:not([type="hidden"])';

/**
 * Los controles que se tocan con el dedo dentro de `scope` miden >= 44 px de alto (43,5 por el redondeo). Con `skipCanvas` se
 * deja fuera el lienzo de Firmar (su barra de zoom, paginas y herramientas, y la barra del campo seleccionado): es el mismo
 * `DocumentCanvas` de Firmar, de otra unidad, y se mide con puntero fino (36-40 px) como el resto de la herramienta.
 */
async function expectTouchTargets(page: Page, scope: string, label: string, skipCanvas = false): Promise<void> {
  const small = await page.evaluate(
    ({ root, query, except }) => {
      const bad: string[] = [];
      const container = document.querySelector(root);
      if (!container) return [`no hay ${root}`];
      // El bloque hijo directo del contenedor que lleva el lienzo.
      const canvasBlock = except ? Array.from(container.children).find((child) => child.querySelector('[data-canvas="host"]')) : undefined;
      let seen = 0;
      for (const element of container.querySelectorAll<HTMLElement>(query)) {
        if (canvasBlock?.contains(element)) continue;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
          // Casilla visible: la etiqueta que la envuelve es el objetivo (min-h-11).
          const wrapper = element.closest("label");
          if (wrapper) {
            seen += 1;
            const box = wrapper.getBoundingClientRect();
            if (box.height < 43.5) bad.push(`label "${(wrapper.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
            continue;
          }
        }
        const box = element.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;
        seen += 1;
        if (box.height < 43.5) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      return seen === 0 ? [`no hay controles que medir en ${root}`] : bad;
    },
    { root: scope, query: TOUCH_SELECTOR, except: skipCanvas },
  );
  expect(small, `${label}: objetivos de toque menores de 44 px`).toEqual([]);
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label}: desborde horizontal`).toBeLessThanOrEqual(1);
}

/**
 * axe + 44 px + desborde en las dos anchuras y los dos idiomas de la pantalla en curso (ES 1280, ES 375, EN 375, EN 1280);
 * la deja en ES y a 1280 px.
 */
async function everywhere(page: Page, label: string, scope: string, skipCanvas = false): Promise<void> {
  const run = async (language: Language, width: number) => {
    await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
    await settle(page);
    const here = `${label} · ${language} · ${width}px`;
    const violations = await runAxe(page, scope);
    expect(violations, `${here}\n${describeViolations(violations)}`).toEqual([]);
    await expectTouchTargets(page, scope, here, skipCanvas);
    if (width < 600) await expectNoOverflow(page, here);
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

async function editorCell(browser: Browser, theme: Theme): Promise<void> {
  const context = await newContext(browser, theme);
  const page = await context.newPage();
  try {
    // Un contrato con la pagina de firmas «dudosa»: da campos seguros Y sugerencias.
    const contract = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2, extras: true });
    await page.goto("/sign-pdf");
    await chooseForEditor(page, { name: "Mold Test Agreement.pdf", buffer: contract });
    const editor = page.locator("[data-template-editor]");
    await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible();
    await expect(sheet(page)).toBeVisible();

    // Campos colocados a mano: iniciales repetidas en todas las paginas y el bloque de firmas.
    await pickTool(page, "Iniciales");
    await dragOnSheet(page, { x0: LINE.x0, y0: LINE.y - 0.045, x1: LINE.x1, y1: LINE.y - 0.004 });
    await page.getByRole("button", { name: "Repetir iniciales en todas las páginas" }).click();
    await expect(page.locator("[data-template-note]")).toContainText(`Iniciales repetidas en ${PAGES} páginas`);
    await placeSignatureBlock(page, 2, PAGES - 1);

    // Automapeo del editor: lo seguro queda colocado y lo dudoso aparece en «Sugerencias (M)».
    await page.getByRole("button", { name: "Detectar campos automáticamente" }).click();
    await expect(editor).toContainText(/Colocamos \d+ campos? con seguridad/, { timeout: 30_000 });
    await expect(editor.getByRole("heading", { name: /^Sugerencias \(\d+\)$/ })).toBeVisible();

    // Un campo de texto seleccionado: su etiqueta, su origen de dato y (si es fecha) la regla «hoy».
    await pickTool(page, "Seleccionar");
    const next = page.getByRole("button", { name: "Página siguiente" });
    for (let index = 0; index < PAGES - 1; index += 1) if (await next.isEnabled()) await next.click();
    await expect(page.getByText(`Página ${PAGES} de`)).toBeVisible();
    await selectAnyTextField(page);
    await expect(editor.locator("[data-text-field-panel]")).toBeVisible();
    await settle(page);

    await everywhere(page, `${theme} · editor con campos y sugerencias`, "[data-template-editor]", true);

    // El aviso de guardado (la sesion de guardado persiste el PDF base y la plantilla).
    await page.getByRole("button", { name: "Guardar plantilla" }).click();
    await expect(page.locator("[data-template-saved]")).toContainText("Plantilla guardada", { timeout: 30_000 });
    await everywhere(page, `${theme} · editor con el aviso de guardado`, "[data-template-editor]", true);
  } finally {
    await context.close();
  }
}

async function noticesCell(browser: Browser, theme: Theme): Promise<void> {
  const context = await newContext(browser, theme);
  const page = await context.newPage();
  try {
    const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
    await configureTwoSigners(page, original, "Mold Test Agreement.pdf");

    // 1. «Parece la plantilla (85 %)»: una pagina con unas pocas lineas distintas. Nada se aplica hasta decir «Usar».
    await page.reload();
    const revised = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2, tweakedPages: [2] });
    await upload(page, "Mold Test revisado.pdf", revised);
    const asking = page.locator('[data-template-notice="asking"]');
    await expect(asking).toContainText(/Parece la plantilla «Mold Test Agreement» \(\d+ %\)/, { timeout: 25_000 });
    await everywhere(page, `${theme} · «Parece la plantilla»`, "[data-template-notices]");

    // 2. «Plantilla aplicada» con la pagina a revisar y el panel de campos pendientes abierto.
    await notices(page).getByRole("button", { name: "Usar", exact: true }).click();
    await expect(notices(page)).toContainText("Plantilla «Mold Test Agreement» aplicada");
    await notices(page).getByRole("button", { name: "Revisar la página 3 (2)" }).click();
    await expect(notices(page).locator("[data-template-pending] li")).toHaveCount(2);
    await everywhere(page, `${theme} · «Plantilla aplicada» con páginas a revisar`, "[data-template-notices]");
  } finally {
    await context.close();
  }

  // 3. Documento desconocido en «Varios firmantes»: «Detectamos N campos» y el panel «Sugerencias (M)». Contexto limpio: un
  //    borrador restaurado de lo anterior mandaria sobre el archivo nuevo y nunca recibiria el automapeo.
  const fresh = await newContext(browser, theme);
  const second = await fresh.newPage();
  try {
    await second.goto("/sign-pdf");
    const unknown = await makeContract({ label: "Zulu Unknown Agreement", pages: 5, signers: 2, extras: true });
    await upload(second, "Zulu Unknown.pdf", unknown);
    await expect(second.getByText("Zulu Unknown.pdf").first()).toBeVisible();
    await second.getByRole("tab", { name: "Varios firmantes" }).click();
    await expect(notices(second)).toContainText("Detectamos", { timeout: 25_000 });
    const suggestions = second.getByRole("button", { name: /^Sugerencias \(\d+\)$/ });
    await expect(suggestions).toBeVisible();
    await suggestions.click();
    await expect(notices(second).locator("[data-template-pending] li").first()).toBeVisible();
    await everywhere(second, `${theme} · «Detectamos N campos» y «Sugerencias»`, "[data-template-notices]");
  } finally {
    await fresh.close();
  }
}

test("(a11y) editor «Configurar plantilla» con campos, sugerencias del automapeo y aviso de guardado · claro/oscuro · ES/EN · 1280/375", async ({ browser }) => {
  for (const theme of ["light", "dark"] as const) await editorCell(browser, theme);
});

test("(a11y) avisos de aplicación automática: «Parece (85 %)», «Plantilla aplicada» con páginas a revisar y «Detectamos N campos» con «Sugerencias» · claro/oscuro · ES/EN · 1280/375", async ({ browser }) => {
  for (const theme of ["light", "dark"] as const) await noticesCell(browser, theme);
});

/** Selecciona un campo de texto (nombre, fecha...) de la pagina visible: abre el panel con su etiqueta y su origen de dato. */
async function selectAnyTextField(page: Page): Promise<void> {
  const fields = page.locator('[data-element-kind="text"][data-drag-mode="move"]');
  await expect(fields.first()).toBeVisible();
  await fields.first().click();
}
