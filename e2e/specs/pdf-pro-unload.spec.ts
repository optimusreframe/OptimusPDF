import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { goToTab, openProPdf } from "../helpers/pro-flow";
import { holdExport } from "../helpers/export-gate";
import { makePdf } from "../helpers/test-files";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

/**
 * PDF Pro · cerrar la pestaña con cambios (Wave 7 · U8, ronda de correcciones), navegador real y headless.
 *
 * El aviso de «salir de la pagina» lo pone el NAVEGADOR (`beforeunload`): aqui se usa `page.close({ runBeforeUnload })`,
 * que dispara el cuadro de dialogo real, y no solo un evento sintetico.
 *  - sin borrador automatico (apagado en Ajustes) y con cambios: el navegador pregunta;
 *  - con borrador funcionando pero la escritura aun pendiente (justo despues de aplicar): tambien pregunta;
 *  - con el borrador ya guardado: cierra sin molestar;
 *  - sin cambios: cierra sin molestar;
 *  - (Wave 10 · C-B2) con una EXPORTACION en curso, aunque no haya cambios: el navegador pregunta («Quedarse» la deja
 *    correr); al terminar o cancelarla, cierra sin molestar.
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

test("con el borrador funcionando pero la escritura aun pendiente, tambien avisa; ya guardado, no", async ({ page, browserName }) => {
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
  if (browserName === "webkit") {
    // El WebKit de Playwright no completa `page.close({ runBeforeUnload: true })` en una pagina con manejadores de
    // `beforeunload` (la de «sin cambios», sin el borrador, si cierra): se queda sin cerrar ni mostrar dialogo. Es del
    // arnes, no de la aplicacion; lo que importa aqui (el aviso se retira al guardarse el borrador) ya lo prueba el
    // sondeo con el evento sintetico de arriba.
    test.info().annotations.push({ type: "sin-cobertura", description: "cierre real con borrador guardado: page.close(runBeforeUnload) no termina en el WebKit de Playwright" });
    return;
  }
  expect(await closeWithBeforeUnload(page, "accept"), "ya guardado: debe cerrar sin preguntar").toBeNull();
  expect(page.isClosed()).toBe(true);
});

test("sin cambios, cerrar la pestaña no muestra nada", async ({ page }) => {
  await openProPdf(page, { name: "limpio.pdf", pages: 2 });
  expect(await closeWithBeforeUnload(page, "accept"), "sin cambios: debe cerrar sin preguntar").toBeNull();
  expect(page.isClosed()).toBe(true);
});

/*
 * Wave 10 · C-B2: cerrar o recargar con una exportacion EN CURSO. El archivo que se iba a descargar vive solo en esta
 * pestaña, asi que el navegador debe preguntar aunque el documento no tenga cambios. La exportacion se mantiene viva de
 * forma determinista con la compuerta de `e2e/helpers/export-gate.ts` (no depende de la velocidad de la maquina).
 */
const E = S.export;
const exportIndicator = (page: Page) => page.locator("[data-export-indicator]");

/** Pulsa «Exportar a imagenes» (JPG por defecto) en la pestaña «Convertir» y espera a que la compuerta la retenga. */
async function startHeldImageExport(page: Page, gate: Awaited<ReturnType<typeof holdExport>>): Promise<void> {
  await goToTab(page, "convert");
  const target = page.locator('[data-export="images"]');
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await target.getByRole("button", { name: E.formats.images.title }).click();
  await gate.whenHeld();
  await expect(exportIndicator(page)).toBeVisible();
}

/** ¿Se cancelaria el cierre ahora? (el evento sintetico: lo que ve el manejador, sin abrir un dialogo). */
const beforeUnloadPrevented = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

test("con una exportacion en curso (y sin cambios) cerrar la pestaña muestra el aviso real; «Quedarse» la deja correr", async ({ page }) => {
  await openProPdf(page, { name: "acta.pdf", bytes: await makePdf({ pages: 24, label: "ACTA", size: [612, 792] }) });
  expect(await beforeUnloadPrevented(page), "antes de exportar: sin cambios, sin aviso").toBe(false);
  const gate = await holdExport(page, { pages: 2 });
  await startHeldImageExport(page, gate);
  expect(await beforeUnloadPrevented(page), "exportando: el cierre debe pedir confirmacion").toBe(true);
  // El aviso lo pone el navegador de verdad; «Quedarse» deja la pagina y la exportacion como estaban.
  expect(await closeWithBeforeUnload(page, "dismiss")).toBe("beforeunload");
  expect(page.isClosed()).toBe(false);
  await expect(exportIndicator(page)).toBeVisible();
  // Tambien desde otra pestaña de la suite.
  await goToTab(page, "pages");
  expect(await beforeUnloadPrevented(page)).toBe(true);
  // «Salir» cierra de verdad.
  expect(await closeWithBeforeUnload(page, "accept")).toBe("beforeunload");
  expect(page.isClosed()).toBe(true);
});

test("al cancelar la exportacion el aviso se retira y cerrar ya no pregunta", async ({ page, browserName }) => {
  await openProPdf(page, { name: "acta.pdf", bytes: await makePdf({ pages: 24, label: "ACTA", size: [612, 792] }) });
  const gate = await holdExport(page, { pages: 2 });
  await startHeldImageExport(page, gate);
  expect(await beforeUnloadPrevented(page)).toBe(true);
  await exportIndicator(page).getByRole("button", { name: E.indicator.cancelLabel("imágenes") }).click();
  await expect(exportIndicator(page)).toBeHidden();
  await expect.poll(() => beforeUnloadPrevented(page), { message: "cancelada: el cierre ya no debe molestar" }).toBe(false);
  await gate.releaseAll();
  if (browserName === "webkit") {
    test.info().annotations.push({ type: "sin-cobertura", description: "cierre real sin aviso: page.close(runBeforeUnload) no termina en el WebKit de Playwright" });
    return;
  }
  expect(await closeWithBeforeUnload(page, "accept"), "cancelada: debe cerrar sin preguntar").toBeNull();
  expect(page.isClosed()).toBe(true);
});

test("al terminar la exportacion el aviso se retira y cerrar ya no pregunta", async ({ page, browserName }) => {
  await openProPdf(page, { name: "acta.pdf", bytes: await makePdf({ pages: 24, label: "ACTA", size: [612, 792] }) });
  const gate = await holdExport(page, { pages: 2 });
  await startHeldImageExport(page, gate);
  expect(await beforeUnloadPrevented(page)).toBe(true);
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await gate.releaseAll();
  expect((await download).suggestedFilename()).toBe("acta-imagenes.zip");
  await expect(exportIndicator(page)).toBeHidden();
  await expect.poll(() => beforeUnloadPrevented(page), { message: "terminada: el cierre ya no debe molestar" }).toBe(false);
  if (browserName === "webkit") {
    test.info().annotations.push({ type: "sin-cobertura", description: "cierre real sin aviso: page.close(runBeforeUnload) no termina en el WebKit de Playwright" });
    return;
  }
  expect(await closeWithBeforeUnload(page, "accept"), "terminada: debe cerrar sin preguntar").toBeNull();
  expect(page.isClosed()).toBe(true);
});
