import { expect, test } from "../helpers/tool-flow";
import { PROFILES, noHorizontalOverflow, openProDoc, openTab, visibleSheetHeight, type Profile } from "../helpers/mobile-pro";

/**
 * M2 · VP-01 (BLOQUEANTE) y GE-02 (parte de PDF Pro): en cada pantalla del informe de auditoria, Editar y Anotar dejan una
 * hoja de tamaño util aunque haya cabecera, barra del modo, paleta, avisos y dock. Mide la hoja que se VE de verdad
 * (`elementFromPoint`), sin desbordes. Chromium con emulacion tactil de movil (el reparto no depende del motor; WebKit-iPad
 * lo corre con su propio perfil, 834×1194).
 */
test.setTimeout(90_000);

for (const profile of PROFILES) {
  test.describe(`PDF Pro · hoja en modos · ${profile.name}`, () => {
    test.use({ viewport: { width: profile.width, height: profile.height }, locale: "es-ES", hasTouch: true, isMobile: true });

    for (const mode of ["edit", "annotate"] as const) {
      test(`${mode === "edit" ? "Editar" : "Anotar"}: la hoja visible mide al menos ${profile.minSheet} px`, async ({ page }) => {
        await openProDoc(page);
        await openTab(page, mode);
        await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
        await expect(page.locator("[data-edit-scroll] canvas, [data-edit-scroll] img").first()).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(600);
        const height = await visibleSheetHeight(page, mode);
        expect(height, `hoja visible en ${profile.name}`).toBeGreaterThanOrEqual(profile.minSheet);
        await noHorizontalOverflow(page);
      });
    }

    for (const mode of ["edit", "annotate", "sign"] as const) {
      test(`${mode}: «Aplicar» y «Descartar» a la vista${profile.width < 768 && profile.height >= 480 ? " y al alcance del pulgar (mitad inferior, ER-02)" : ""}`, async ({ page }) => {
        await openProDoc(page);
        await openTab(page, mode);
        await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
        for (const selector of ["[data-pro-mode-apply]", "[data-pro-mode-discard]"]) {
          const control = page.locator(selector);
          await expect(control).toBeVisible();
          const box = (await control.boundingBox())!;
          expect(box.y, `${selector} dentro de la pantalla`).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height, `${selector} dentro de la pantalla`).toBeLessThanOrEqual(profile.height);
          expect(box.width, `${selector} de al menos 44 px`).toBeGreaterThanOrEqual(44);
          expect(box.height, `${selector} de al menos 44 px`).toBeGreaterThanOrEqual(44);
          // ER-02: en un telefono vertical la accion primaria vive en la mitad inferior de la pantalla.
          if (profile.width < 768 && profile.height >= 480) {
            expect(box.y + box.height / 2, `${selector} al alcance del pulgar`).toBeGreaterThan(profile.height * 0.55);
          }
        }
        await noHorizontalOverflow(page);
      });
    }
  });
}

export type { Profile };
