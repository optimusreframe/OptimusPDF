/**
 * Piezas comunes de los E2E de flujo de herramientas (W6-D): abrir una
 * herramienta, subir archivos, abrir el panel de opciones en movil, procesar y
 * descargar con las comprobaciones de la pantalla «Listo» (nombre, foco en
 * «Descargar»), y un guardian de consola que hace fallar la prueba si la
 * pagina escribe errores. SIEMPRE headless (valor por defecto de Playwright).
 */
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { downloadFile } from "./downloads";

/** Errores de consola y excepciones no capturadas de la pagina durante la prueba. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      await use(errors);
      expect(errors, "la pagina no debe escribir errores en la consola").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export type UploadFile = { name: string; mimeType: string; buffer: Buffer };

/** Abre `/<slug>` y espera a que la herramienta pinte su titulo. */
export async function openTool(page: Page, slug: string): Promise<void> {
  await page.goto(`/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** Sube archivos al primer selector de archivos de la pagina. */
export async function uploadFiles(page: Page, ...files: UploadFile[]): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(files);
}

/** «Procesar» visible (el de la barra movil es `md:hidden`): siempre uno solo por pantalla. */
export function runButton(page: Page): Locator {
  return page.getByRole("button", { name: "Procesar", exact: true });
}

export function downloadButton(page: Page): Locator {
  return page.getByRole("button", { name: "Descargar", exact: true });
}

/** En movil (< 768 px) las opciones viven en una hoja: se abre con «Opciones». En escritorio no hace nada. */
export async function openOptionsIfSheet(page: Page): Promise<Locator | null> {
  if ((page.viewportSize()?.width ?? 1280) >= 768) return null;
  await page.getByRole("button", { name: "Opciones", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Cierra la hoja de opciones de movil (si se abrio) para llegar a «Procesar». */
export async function closeOptionsSheet(page: Page, dialog: Locator | null): Promise<void> {
  if (!dialog) return;
  const done = dialog.getByRole("button", { name: /^(Listo|Aplicar|Cerrar)$/ }).first();
  if (await done.isVisible()) await done.click();
  else await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

export type Downloaded = { bytes: Buffer; filename: string };

/**
 * Pulsa «Procesar», espera la pantalla «Listo» (el foco debe quedar en
 * «Descargar», y el nombre que muestra debe ser el de la descarga) y descarga.
 */
export async function runAndDownload(
  page: Page,
  options: { timeout?: number } = {},
): Promise<Downloaded> {
  const timeout = options.timeout ?? 60_000;
  const run = runButton(page);
  await expect(run).toBeEnabled();
  await run.click();
  const download = downloadButton(page);
  await expect(download).toBeVisible({ timeout });
  await expect(download).toBeFocused();
  const result = await downloadFile(page, async () => {
    await download.click();
  });
  await expect(page.getByText(result.filename, { exact: true })).toBeVisible();
  return result;
}

/** Texto visible del resumen (`data-download-summary`) de la pantalla «Listo», si lo hay. */
export function downloadSummary(page: Page): Locator {
  return page.locator("[data-download-summary]");
}
