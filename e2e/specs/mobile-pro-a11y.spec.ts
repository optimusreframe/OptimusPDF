import { expect, test, type Page } from "@playwright/test";
import { openProDoc, openTab, noHorizontalOverflow } from "../helpers/mobile-pro";

/**
 * M2 · axe sobre PDF Pro en las pantallas del informe (320, 375, 393, 430, 744, 834 y 1194 px) × claro/oscuro × ES/EN: la suite
 * (cabecera, barra del modo, dock/raíl, interruptor «Desplazar», hojas) con 0 violaciones de WCAG 2.2 AA, INCLUIDO
 * `target-size` (objetivos tactiles de 24 px; el CI de GitHub usa una tipografia ancha). Solo se analiza la suite
 * (`[data-pro-suite]`) y las hojas abiertas: la cabecera y el pie de la web son de otra unidad.
 */
const AXE_PATH = require.resolve("axe-core/axe.min.js");
test.setTimeout(150_000);

const SIZES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
  { width: 430, height: 932 },
  { width: 744, height: 1133 },
  { width: 834, height: 1194 },
  { width: 1194, height: 834 },
] as const;

async function runAxe(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(
      { include: [["[data-pro-suite]"], ['[role="dialog"]']] },
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } },
    );
    return result.violations.map((violation) => `${violation.id} (${violation.help}):\n   ${violation.nodes.slice(0, 6).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n")[1] ?? ""}`).join("\n   ")}`);
  });
}

for (const size of SIZES) {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["es", "en"] as const) {
      test.describe(`axe · PDF Pro · ${size.width}×${size.height} · ${theme} · ${language}`, () => {
        test.use({
          viewport: size,
          colorScheme: theme,
          locale: language === "es" ? "es-ES" : "en-US",
          hasTouch: true,
          isMobile: true,
        });

        test("inicio, Editar (con «Desplazar») y Páginas", async ({ page }) => {
          await page.addInitScript(([l]) => {
            try {
              window.localStorage.setItem("optimuspdf.language", l);
            } catch {
              /* sin almacenamiento */
            }
          }, [language]);
          await openProDoc(page, { pages: 6 });
          await page.waitForTimeout(800);
          expect(await runAxe(page), "inicio").toEqual([]);
          await noHorizontalOverflow(page);

          await openTab(page, "edit");
          await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(500);
          // Con una herramienta armada aparece «Desplazar» y, en movil, el boton de plegar.
          const tool = page.locator('[data-palette-item="rect"]');
          if (await tool.isVisible().catch(() => false)) await tool.click();
          expect(await runAxe(page), "Editar").toEqual([]);
          await noHorizontalOverflow(page);
          const fold = page.locator("[data-pro-fold-toggle]");
          if (await fold.isVisible().catch(() => false)) {
            // Se revisan los dos estados (barras plegadas y desplegadas) y se sigue con las barras a la vista (el dock vuelve).
            for (let pass = 0; pass < 2; pass += 1) {
              const expanded = (await fold.getAttribute("aria-expanded")) === "true";
              await fold.click();
              await page.waitForTimeout(300);
              expect(await runAxe(page), expanded ? "Editar con las barras plegadas" : "Editar con las barras a la vista").toEqual([]);
              await noHorizontalOverflow(page);
            }
            if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
          }
          // (M6) Anotar con la barra del modo de iconos (deshacer/rehacer/«Desplazar»/«Descartar»/«Aplicar»), la bandeja de una fila y sus dos estados.
          await openTab(page, "annotate");
          await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(500);
          expect(await runAxe(page), "Anotar").toEqual([]);
          const annotateFold = page.locator("[data-pro-fold-toggle]");
          if (await annotateFold.isVisible().catch(() => false)) {
            for (let pass = 0; pass < 2; pass += 1) {
              const expanded = (await annotateFold.getAttribute("aria-expanded")) === "true";
              await annotateFold.click();
              await page.waitForTimeout(300);
              expect(await runAxe(page), expanded ? "Anotar con las barras plegadas" : "Anotar con las barras a la vista").toEqual([]);
              await noHorizontalOverflow(page);
            }
          }
          await openTab(page, "pages");
          await expect(page.locator("[data-pages-grid]")).toBeVisible();
          await page.waitForTimeout(1200);
          expect(await runAxe(page), "Páginas").toEqual([]);
          await noHorizontalOverflow(page);
        });
      });
    }
  }
}
