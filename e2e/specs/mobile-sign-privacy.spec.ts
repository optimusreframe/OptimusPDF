import { expect, test } from "@playwright/test";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { makeContract, multiWithTwoSigners, openSign, pdfFile, PHONE_PROFILES, rectOf, waitSheetReady } from "../helpers/mobile-sign";

/**
 * Firmar PDF en movil e iPad (auditoria `docs/AUDITORIA-MOVIL-IPAD.md`):
 *  - ER-03  la primera vez el aviso de privacidad es un resumen corto con «Leer completo» (ya no un muro de texto de
 *           ~1 000 px), y «Entendido» / cerrarlo recuerda que ya se vio;
 *  - SC-01  (hojas) abrir una hoja no mueve la pagina de detras y su contenido empieza arriba, con el foco dentro.
 * Tactil, headless; PDF sintetico.
 */
test.setTimeout(180_000);
const SG = SIGN_STRINGS.es;

for (const profile of PHONE_PROFILES) {
  test.describe(`Firmar · privacidad · ${profile.label}`, () => {
    test.use(profile.use);

    test("ER-03 · la primera vez se ve un resumen corto con «Leer completo»; el texto entero no ocupa la pantalla", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())], { privacySeen: false });
      await multiWithTwoSigners(page);

      const summary = page.locator("[data-privacy-summary]");
      await expect(summary).toBeVisible();
      await expect(summary).toContainText(SG.privacySummary);
      await expect(page.getByText(SG.privacyNoticeBody.slice(0, 40))).toHaveCount(0);
      expect((await rectOf(summary)).height, "el resumen mide menos de 190 px").toBeLessThan(190);

      // «Leer completo» abre el texto entero.
      await page.getByRole("button", { name: SG.privacyReadFull }).click();
      await expect(page.getByText(SG.privacyNoticeBody.slice(0, 40))).toBeVisible();

      // Cerrarlo recuerda que ya se vio: al recargar no vuelve a abrirse solo.
      await page.getByRole("button", { name: SG.confirmClose, exact: true }).first().click();
      await expect(page.getByText(SG.privacyNoticeBody.slice(0, 40))).toHaveCount(0);
      await page.reload();
      await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles([pdfFile(await makeContract())]);
      await page.getByRole("tab", { name: "Varios firmantes" }).click();
      await expect(page.getByRole("button", { name: SG.privacyNoticeToggle })).toBeVisible();
      await expect(page.locator("[data-privacy-summary]")).toHaveCount(0);
      await expect(page.getByText(SG.privacyNoticeBody.slice(0, 40))).toHaveCount(0);
    });

    test("ER-03 · «Entendido» en el resumen lo cierra y recuerda que ya se vio", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())], { privacySeen: false });
      await multiWithTwoSigners(page);
      await page.locator("[data-privacy-summary]").getByRole("button", { name: SG.privacyUnderstood }).click();
      await expect(page.locator("[data-privacy-summary]")).toHaveCount(0);
      await page.reload();
      await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles([pdfFile(await makeContract())]);
      await page.getByRole("tab", { name: "Varios firmantes" }).click();
      await expect(page.locator("[data-privacy-summary]")).toHaveCount(0);
    });

    test("SC-01 · abrir una hoja no mueve la pagina de detras y su contenido empieza arriba", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      const host = await waitSheetReady(page);
      await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(400);

      for (const opener of [SG.createSignature, SG.vaultButton]) {
        const button = page.getByRole("button", { name: opener, exact: true }).first();
        // Los botones estan sobre la hoja: la persona sube hasta ellos; se mide DESDE ahi (Playwright no desplaza solo).
        await button.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(300);
        const before = await page.evaluate(() => Math.round(window.scrollY));
        await button.click();
        const dialog = page.getByRole("dialog").last();
        await expect(dialog).toBeVisible();
        await page.waitForTimeout(700);
        const state = await dialog.evaluate((element) => {
          const scrollers = [element, ...element.querySelectorAll<HTMLElement>("*")].filter((node) => {
            const cs = getComputedStyle(node);
            return (cs.overflowY === "auto" || cs.overflowY === "scroll") && node.scrollHeight > node.clientHeight;
          });
          const active = document.activeElement;
          return {
            tops: scrollers.map((node) => Math.round(node.scrollTop)),
            focusInside: Boolean(active && element.contains(active)),
          };
        });
        expect(state.tops.every((top) => top === 0), `${opener}: contenido desplazado ${JSON.stringify(state.tops)}`).toBe(true);
        expect(state.focusInside, `${opener}: el foco debe quedar dentro de la hoja`).toBe(true);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        const after = await page.evaluate(() => Math.round(window.scrollY));
        expect(Math.abs(after - before), `${opener}: al cerrar la pagina no vuelve donde estaba`).toBeLessThanOrEqual(2);
      }
    });
  });
}
