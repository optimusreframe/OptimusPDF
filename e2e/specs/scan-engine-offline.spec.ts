import { expect, test } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";

/**
 * P1-4 · IMPORTAR FOTOS SIN CONEXION en la herramienta REAL (`/scan-to-pdf`, build de produccion): el motor, scanic y el worker se
 * precargan al abrir la herramienta (con conexion), asi que importar despues SIN ella funciona; y si algo no cargo, el fallo
 * NO queda cacheado (el hilo principal sustituye al worker y se reintenta). Usa los selectores publicos de la herramienta
 * (`input[data-scan-input="library"]`, `[data-page-grid] [data-page-id]`).
 *
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad`.
 */

test.use({ locale: "es-ES" });

/**
 * Corta la RED (toda peticion http/https falla, como sin conexion) SIN usar `context.setOffline`: en WebKit de Linux ese
 * interruptor tambien rompe las URL `blob:` locales (que en un iPad real sin conexion funcionan: no son red) y las fotos no
 * llegarian a decodificarse por un motivo ajeno al producto.
 */
async function cutNetwork(context: import("@playwright/test").BrowserContext, page: import("@playwright/test").Page): Promise<void> {
  await context.route(/^https?:\/\//, (route) => route.abort("internetdisconnected"));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
}
test.setTimeout(180_000);

function photo(seed: number): { name: string; mimeType: string; buffer: Buffer } {
  const canvas = createCanvas(1200, 900);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${60 + seed * 30},90,140)`;
  ctx.fillRect(0, 0, 1200, 900);
  ctx.fillStyle = "#eee";
  for (let i = 0; i < 14; i += 1) ctx.fillRect(100 + (i % 4) * 250, 80 + Math.floor(i / 4) * 200, 180 + seed * 7, 120);
  return { name: `foto-${seed}.jpg`, mimeType: "image/jpeg", buffer: canvas.toBuffer("image/jpeg", 88) };
}

test.describe("importar sin conexion · herramienta real", () => {
  test("con conexion se precarga y SIN ella las fotos se importan (no se descartan ni queda un fallo cacheado)", async ({ page, context }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto("/scan-to-pdf");
    // La precarga corre en reposo; se espera a que el motor, scanic y el worker esten cargados.
    await page.waitForTimeout(4000);
    await cutNetwork(context, page);
    await page.locator('input[data-scan-input="library"]').setInputFiles([photo(1), photo(2), photo(3)]);
    await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByText(/No se pudo procesar/)).toHaveCount(0);
    // Y una segunda tanda, aun sin conexion, tambien.
    await page.locator('input[data-scan-input="library"]').setInputFiles([photo(4)]);
    await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(4, { timeout: 60_000 });
    await context.unroute(/^https?:\/\//);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
