import { expect, test, type Page } from "@playwright/test";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { makeContract, openSign, pdfFile, safeSheetY, waitSheetReady } from "../helpers/mobile-sign";

/**
 * Firmar PDF en movil e iPad · accesibilidad y desbordes (auditoria `docs/AUDITORIA-MOVIL-IPAD.md`).
 *
 * axe-core (WCAG 2.0/2.1/2.2 A y AA, incluido `target-size`) = 0 violaciones en las pantallas que cambian con esta unidad
 * —aviso de privacidad con resumen, paso de firmantes con «Continuar» pegajoso, paso documento con la paleta plegada /
 * en dock / en carril, traspaso de la ceremonia y la hoja «Opciones» de tablet— en 320, 375, 393, 744, 834 y 1 194 px,
 * tema claro/oscuro y ES/EN, y NINGUNA pantalla gana scroll horizontal (ni con una tipografia ancha forzada, la de DejaVu
 * del CI de Linux) a 320 y 375 px. Tactil, headless.
 */
test.setTimeout(240_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const WIDTHS: Array<{ width: number; height: number }> = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
  { width: 744, height: 1133 },
  { width: 834, height: 1194 },
  { width: 1194, height: 834 },
];

async function axeOnce(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    type Axe = { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> };
    const axe = (window as unknown as { axe: Axe }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  });
}

/**
 * axe en el desplazamiento de la pantalla en curso, arriba del todo y al final de la pagina. «Continuar», la paleta y las
 * barras de abajo son capas pegajosas que, a media pagina, pasan por encima del contenido (como cualquier barra fija):
 * `target-size` lo cuenta como tapa de lo que justo quede detras en ESE desplazamiento, asi que se mide en los dos
 * extremos, donde se queda quieta una persona (inicio y final), y no en un punto cualquiera del recorrido.
 */
async function axeViolations(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const where of ["top", "end"] as const) {
    await page.evaluate((position) => window.scrollTo(0, position === "top" ? 0 : document.documentElement.scrollHeight), where);
    await page.waitForTimeout(250);
    for (const violation of await axeOnce(page)) found.push(`[${where}] ${violation}`);
  }
  return found;
}

async function noHorizontalOverflow(page: Page): Promise<string> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) return `la pagina desborda: ${document.documentElement.scrollWidth} > ${vw}`;
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      const r = element.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(element);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.right > vw + 1 || r.left < -1) {
        let node = element.parentElement;
        let clipped = false;
        while (node && node !== document.body) {
          const overflow = getComputedStyle(node).overflowX;
          if (overflow !== "visible") {
            const pr = node.getBoundingClientRect();
            if (pr.right <= vw + 1 && pr.left >= -1) {
              clipped = true;
              break;
            }
          }
          node = node.parentElement;
        }
        if (!clipped && !element.closest(".sr-only, [aria-hidden=true]")) {
          return `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} fuera de la pantalla (${Math.round(r.left)}..${Math.round(r.right)} de ${vw})`;
        }
      }
    }
    return "";
  });
}

/** Tipografia ANCHA forzada (DejaVu Sans o Verdana, ~15 % mas anchas) y 6 % de espaciado: el peor caso del CI de Linux. */
const WIDE_FONT_CSS = `*, *::before, *::after { font-family: "DejaVu Sans", Verdana, sans-serif !important; letter-spacing: 0.06em !important; }`;

for (const size of WIDTHS) {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["es", "en"] as const) {
      const S = SIGN_STRINGS[language];
      test.describe(`Firmar · axe y desbordes · ${size.width}x${size.height} · ${theme} · ${language}`, () => {
        test.use({
          viewport: size,
          hasTouch: true,
          isMobile: true,
          deviceScaleFactor: 2,
          colorScheme: theme,
          locale: language === "es" ? "es-ES" : "en-US",
        });

        test("solo yo: sheet + paleta (plegada en movil, dock en tablet, carril en escritorio) y hoja «Opciones»", async ({ page }) => {
          await openSign(page, [pdfFile(await makeContract())], { language, theme });
          const host = await waitSheetReady(page);
          await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await page.waitForTimeout(400);
          expect(await axeViolations(page), "axe con la hoja y la paleta").toEqual([]);
          expect(await noHorizontalOverflow(page), "desborde horizontal").toBe("");
          if (size.width >= 768 && size.width < 1280) {
            await page.getByRole("button", { name: "Options", exact: false }).or(page.getByRole("button", { name: "Opciones" })).first().click();
            await expect(page.getByRole("dialog")).toBeVisible();
            await page.waitForTimeout(700);
            expect(await axeViolations(page), "axe con la hoja «Opciones» de tablet").toEqual([]);
          }
          // Paleta abierta en telefono.
          if (size.width < 768) {
            await page.keyboard.press("Escape");
            const fab = page.locator("[data-palette-fab]");
            await fab.click();
            await expect(page.getByRole("toolbar")).toBeVisible();
            expect(await axeViolations(page), "axe con la paleta abierta").toEqual([]);
            expect(await noHorizontalOverflow(page), "desborde con la paleta abierta").toBe("");
          }
        });

        test("varios firmantes: aviso de privacidad (resumen), paso 1, paso 2 y traspaso", async ({ page }) => {
          await openSign(page, [pdfFile(await makeContract())], { language, theme, privacySeen: false });
          await page.getByRole("tab", { name: S.modeMulti }).click();
          await page.getByRole("button", { name: S.addSigner }).click();
          await page.getByRole("button", { name: S.addSigner }).click();
          await page.getByLabel(S.signerNameLabel(1)).fill("Ana");
          await page.getByLabel(S.signerNameLabel(2)).fill("Luis");
          await expect(page.locator("[data-privacy-summary]")).toBeVisible();
          expect(await axeViolations(page), "axe con el resumen de privacidad").toEqual([]);
          expect(await noHorizontalOverflow(page), "desborde con el resumen").toBe("");
          await page.getByRole("button", { name: S.privacyUnderstood }).click();
          expect(await axeViolations(page), "axe en el paso de firmantes").toEqual([]);
          expect(await noHorizontalOverflow(page), "desborde en el paso de firmantes").toBe("");

          await page.getByRole("button", { name: `2. ${S.stepDocument}` }).click();
          const host = await waitSheetReady(page);
          await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await page.waitForTimeout(300);
          expect(await axeViolations(page), "axe en el paso documento").toEqual([]);
          expect(await noHorizontalOverflow(page), "desborde en el paso documento").toBe("");

          // Hueco para cada firmante y traspaso.
          const placeOne = async (signer: string, fraction: number) => {
            await page.getByRole("radio", { name: signer, exact: true }).click();
            const fab = page.locator("[data-palette-fab]");
            if (await fab.count()) await fab.click();
            await page.getByRole("toolbar").first().getByRole("button", { name: S.fieldSignature, exact: true }).click();
            await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
            const box = await host.locator("img").first().boundingBox();
            if (!box) throw new Error("sin hoja");
            const y = await safeSheetY(page, box.y, box.height, fraction);
            await page.mouse.move(box.x + 50, y);
            await page.mouse.down();
            await page.mouse.move(box.x + 150, y + 40, { steps: 4 });
            await page.mouse.up();
          };
          await placeOne("Ana", 0.3);
          await placeOne("Luis", 0.5);
          await page.getByRole("button", { name: S.next }).click();
          await expect(page.getByRole("heading", { name: S.handoffTitle("Ana") })).toBeVisible();
          await page.waitForTimeout(300);
          expect(await axeViolations(page), "axe en el traspaso").toEqual([]);
          expect(await noHorizontalOverflow(page), "desborde en el traspaso").toBe("");
        });

        if (size.width <= 375 && theme === "light") {
          test("tipografia ancha forzada: ninguna pantalla desborda en horizontal", async ({ page }) => {
            await openSign(page, [pdfFile(await makeContract())], { language, theme, privacySeen: false });
            await page.addStyleTag({ content: WIDE_FONT_CSS });
            await page.getByRole("tab", { name: S.modeMulti }).click();
            await page.getByRole("button", { name: S.addSigner }).click();
            await page.getByRole("button", { name: S.addSigner }).click();
            await page.getByLabel(S.signerNameLabel(1)).fill("Ana");
            await page.getByLabel(S.signerNameLabel(2)).fill("Luis");
            expect(await noHorizontalOverflow(page), "resumen de privacidad con tipografia ancha").toBe("");
            await page.getByRole("button", { name: S.privacyReadFull }).click();
            expect(await noHorizontalOverflow(page), "texto completo con tipografia ancha").toBe("");
            await page.getByRole("button", { name: `2. ${S.stepDocument}` }).click();
            const host = await waitSheetReady(page);
            await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
            const fab = page.locator("[data-palette-fab]");
            if (await fab.count()) await fab.click();
            expect(await noHorizontalOverflow(page), "paso documento con la paleta abierta y tipografia ancha").toBe("");
          });
        }
      });
    }
  }
}
