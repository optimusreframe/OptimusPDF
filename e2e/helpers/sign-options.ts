/**
 * El panel «Opciones» de Firmar es una columna a la derecha solo desde 1 280 px; en tablet (768-1279 px: iPad vertical y
 * horizontal) y en movil es una HOJA que abre el boton «Opciones» (GE-02 / GE-04 de la auditoria movil/iPad). Estas piezas
 * dejan que una misma prueba lea o use el panel en cualquier ancho.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Abre el panel (si es una hoja) y devuelve su raiz; `close` lo cierra si lo abrio ella. */
export async function openOptions(page: Page): Promise<{ root: Locator; close: () => Promise<void> }> {
  const aside = page.locator('aside[aria-label="Opciones"]');
  if (await aside.isVisible()) return { root: aside, close: async () => {} };
  await page.getByRole("button", { name: "Opciones", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Opciones" });
  await expect(dialog).toBeVisible();
  return {
    root: dialog,
    close: async () => {
      if (await dialog.isVisible()) {
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }
    },
  };
}

/** El texto del panel «Opciones» en este momento. */
export async function optionsText(page: Page): Promise<string> {
  const { root, close } = await openOptions(page);
  const text = await root.innerText();
  await close();
  return text;
}
