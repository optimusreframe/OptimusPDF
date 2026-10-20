import { expect, test, type Page } from "@playwright/test";
import { boxOf, host, isChromium, makeA4Pdf, pickTool, revealSheet, touchTap, cdpOf } from "../helpers/touch-gestures";

/**
 * M3 · axe en el lienzo compartido y la UI base con tacto: claro/oscuro x ES/EN x 320/375/393/744/834/1194.
 * Firmar con un PDF, la herramienta «Texto» armada (el interruptor «Dibujar con el dedo» y la paleta visibles) y un
 * campo colocado (barra flotante). 0 violaciones de contraste, nombres, roles/atributos validos y `target-size` (24 px).
 * Headless siempre.
 */

test.setTimeout(240_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = [
  "color-contrast",
  "aria-valid-attr-value",
  "aria-valid-attr",
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-required-attr",
  "label",
  "button-name",
  "link-name",
  "target-size",
  "nested-interactive",
] as const;

const WIDTHS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
  { width: 744, height: 1133 },
  { width: 834, height: 1194 },
  { width: 1194, height: 834 },
] as const;

async function runAxe(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    type Axe = { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> };
    const axe = (window as unknown as { axe: Axe }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`);
  }, AXE_RULES);
}

for (const theme of ["light", "dark"] as const) {
  for (const language of ["es", "en"] as const) {
    test(`axe · Firmar con la herramienta armada y un campo colocado · ${theme} · ${language}`, async ({ browser }) => {
      for (const size of WIDTHS) {
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 2,
          hasTouch: true,
          isMobile: true,
          colorScheme: theme,
          locale: language === "es" ? "es-ES" : "en-US",
        });
        await context.addInitScript(
          ([t, l]) => {
            try {
              localStorage.setItem("optimuspdf.theme", t);
              localStorage.setItem("optimuspdf.language", l);
              localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
            } catch {
              /* sin almacenamiento */
            }
          },
          [theme, language],
        );
        const page = await context.newPage();
        try {
          await page.goto("/sign-pdf");
          await page
            .locator('input[type="file"][accept*="pdf"]')
            .first()
            .setInputFiles([{ name: "Contrato.pdf", mimeType: "application/pdf", buffer: await makeA4Pdf("Contrato", 2) }]);
          await expect(page.locator('[data-canvas="host"] img').first()).toBeVisible({ timeout: 30_000 });
          await revealSheet(page);
          await pickTool(page, /^Texto$|^Text$/);
          const label = `${size.width}px`;
          const armed = await runAxe(page);
          expect(armed, `herramienta armada · ${label}`).toEqual([]);
          // Un toque coloca el campo: aparece su barra flotante.
          const sheet = await boxOf(host(page));
          // Bajo la barra de zoom (a 320 px ocupa dos filas) y sobre la paleta fija.
          const bar = await boxOf(page.locator("[data-canvas-sticky]"));
          const at = { x: sheet.x + sheet.width * 0.4, y: Math.min(Math.max(sheet.y + sheet.height * 0.3, bar.y + bar.height + 24), size.height - 300) };
          if (isChromium(page)) await touchTap(await cdpOf(page), at);
          else await page.touchscreen.tap(at.x, at.y);
          await expect(page.locator('[data-element-kind="text"][data-drag-mode="move"]')).toHaveCount(1);
          await page.keyboard.press("Escape");
          // La barra flotante (de Firmar) se oculta si no cabe (WebKit, 320 px, ingles): solo se exige en Chromium.
          if (isChromium(page)) await expect(page.locator("[data-floating-bar]"), `barra flotante · ${label}`).toBeVisible();
          await page.waitForTimeout(900);
          expect(await runAxe(page), `campo colocado · ${label}`).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
}
