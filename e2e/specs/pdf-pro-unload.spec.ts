import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { openProPdf } from "../helpers/pro-flow";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

/**
 * PDF Pro · cerrar la pestaña con cambios (Wave 7 · U8, ronda de correcciones), navegador real y headless.
 *
 * El aviso de «salir de la pagina» lo pone el NAVEGADOR (`beforeunload`): aqui se usa `page.close({ runBeforeUnload })`,
 * que dispara el cuadro de dialogo real, y no solo un evento sintetico.
 *  - sin borrador automatico (apagado en Ajustes) y con cambios: el navegador pregunta;
 *  - con borrador funcionando pero la escritura aun pendiente (justo despues de aplicar): tambien pregunta;
 *  - con el borrador ya guardado: cierra sin molestar;
 *  - sin cambios: cierra sin molestar.
 */

const S = PRO_STRINGS.es;
test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(60_000);

const FLAGS_KEY = "optimuspdf.pro.featureFlags";

/**
 * Cierra la pestaña ejecutando `beforeunload` (`page.close` no espera: el dialogo, si lo hay, llega despues) y devuelve el
 * tipo del dialogo que el navegador mostro (`null` si cerro sin preguntar). `accept` = «Salir»; `dismiss` = «Quedarse».
 */
async function closeWithBeforeUnload(page: Page, choice: "accept" | "dismiss"): Promise<string | null> {
  const closed = page.waitForEvent("close", { timeout: 8000 }).then(
    () => null,
    () => null,
  );
  const dialogEvent = page.waitForEvent("dialog", { timeout: 8000 }).then(
    (dialog) => dialog,
    () => null,
  );
  await page.close({ runBeforeUnload: true });
  const dialog = await Promise.race([dialogEvent, closed]);
  if (!dialog) return null;
  const type = dialog.type();
  if (choice === "accept") {
    await Promise.all([closed, dialog.accept()]);
  } else {
    await dialog.dismiss();
  }
  return type;
}

async function rotate(page: Page): Promise<void> {
  await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
  await expect(page.getByRole("list", { name: S.suite.historyTitle }).getByRole("listitem")).toHaveCount(2);
}

test("sin borrador automatico y con cambios, cerrar la pestaña muestra el aviso real del navegador", async ({ page }) => {
  await page.addInitScript(
    ([key]) => {
      window.localStorage.setItem(key, JSON.stringify({ proAutosave: false }));
    },
    [FLAGS_KEY] as const,
  );
  await openProPdf(page, { name: "sin-borrador.pdf", pages: 2 });
  await rotate(page);
  // Con el aviso, «Quedarse» deja la pagina abierta y con su trabajo.
  expect(await closeWithBeforeUnload(page, "dismiss")).toBe("beforeunload");
  expect(page.isClosed()).toBe(false);
  await expect(page.getByRole("list", { name: S.suite.historyTitle }).getByRole("listitem")).toHaveCount(2);
  // «Salir» cierra de verdad.
  expect(await closeWithBeforeUnload(page, "accept")).toBe("beforeunload");
  expect(page.isClosed()).toBe(true);
});

test("con el borrador funcionando pero la escritura aun pendiente, tambien avisa; ya guardado, no", async ({ page }) => {
  await openProPdf(page, { name: "con-borrador.pdf", pages: 2 });
  // Dentro de la misma tarea (mucho antes de los 600 ms del debounce): aplicar y mirar si el cierre se cancelaria.
  const duringWrite = await page.evaluate(
    async ({ label }) => {
      const button = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
      if (!button) throw new Error(`sin boton ${label}`);
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { label: S.operations.rotateAll90 },
  );
  expect(duringWrite, "con la escritura del borrador pendiente el cierre debe pedir confirmacion").toBe(true);

  // Una vez guardado el borrador, el aviso desaparece (el trabajo ya esta a salvo).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      { timeout: 10_000, message: "tras guardarse el borrador, cerrar ya no debe molestar" },
    )
    .toBe(false);
  expect(await closeWithBeforeUnload(page, "accept"), "ya guardado: debe cerrar sin preguntar").toBeNull();
  expect(page.isClosed()).toBe(true);
});

test("sin cambios, cerrar la pestaña no muestra nada", async ({ page }) => {
  await openProPdf(page, { name: "limpio.pdf", pages: 2 });
  expect(await closeWithBeforeUnload(page, "accept"), "sin cambios: debe cerrar sin preguntar").toBeNull();
  expect(page.isClosed()).toBe(true);
});
