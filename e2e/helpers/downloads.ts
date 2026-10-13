import type { Download, Page } from "@playwright/test";

/**
 * Dispara `action` y espera la descarga real que produce, devolviendo sus
 * bytes ya leidos. No usamos rutas de disco propias: Playwright ya guarda
 * la descarga en un temporal que gestiona el, `download.path()` basta.
 */
export async function downloadBytes(
  page: Page,
  action: () => Promise<void>,
): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    action(),
  ]);
  return readDownload(download);
}

async function readDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) {
    throw new Error("La descarga no genero un archivo temporal legible.");
  }
  const fs = await import("node:fs/promises");
  return fs.readFile(path);
}

/**
 * Igual que `downloadBytes`, pero devuelve tambien el nombre que propone el navegador. Se normaliza a NFC: WebKit en
 * macOS propone el nombre en NFD (la «ñ» llega como «n» + tilde combinada), el mismo texto con otros bytes.
 */
export async function downloadFile(
  page: Page,
  action: () => Promise<void>,
): Promise<{ bytes: Buffer; filename: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    action(),
  ]);
  return { bytes: await readDownload(download), filename: download.suggestedFilename().normalize("NFC") };
}
