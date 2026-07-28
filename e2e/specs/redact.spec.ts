import { expect, test } from "@playwright/test";
import path from "node:path";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageText } from "../helpers/pdf-inspection";
import { renderPageToPixels } from "../helpers/pdf-render-inspection";

const FIXTURE = path.join(__dirname, "..", "fixtures", "redact-secret.pdf");

/**
 * Zona a censurar en coordenadas normalizadas 0..1 sobre la pagina
 * RENDERIZADA (mismo espacio que usa `RedactCanvas`: origen arriba a la
 * izquierda). Cubre con margen generoso el texto secreto ("SECRET-7F3A9",
 * cerca del borde superior) y el parche magenta (ver
 * e2e/fixtures/generate-fixtures.mjs para las coordenadas PDF exactas).
 * Deja fuera, a proposito, el texto "no redactar..." cerca del borde
 * inferior derecho, que no participa en esta prueba.
 */
const REDACT_ZONE = { x1: 0.02, y1: 0.02, x2: 0.65, y2: 0.62 };

test.describe("redact-pdf", () => {
  test("la caja de censura vuelve el contenido irrecuperable (texto y pixeles), sin tocar la pagina sin censurar", async ({ page }) => {
    await page.goto("/redact-pdf");

    const input = page.locator('input[type="file"]');
    await input.setInputFiles(FIXTURE);

    const host = page.getByTestId("redact-canvas-host");
    await expect(host).toBeVisible();
    // El host es "visible" desde el primer render (placeholder mientras
    // pdf.js renderiza la vista previa a data URL): esperar tambien la
    // imagen real evita medir el tamano transicional del marcador de
    // carga en vez del tamano final de la pagina renderizada.
    await expect(host.locator("img")).toBeVisible();
    const box = await host.boundingBox();
    if (!box) throw new Error("No se pudo medir el area de censura.");

    const start = {
      x: box.x + box.width * REDACT_ZONE.x1,
      y: box.y + box.height * REDACT_ZONE.y1,
    };
    const end = {
      x: box.x + box.width * REDACT_ZONE.x2,
      y: box.y + box.height * REDACT_ZONE.y2,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 10 });
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();

    // La UI confirma que la zona quedo registrada antes de procesar (texto
    // exacto de totalBoxes(1) en strings.ts, ES/EN) -- no una coincidencia
    // parcial contra un contenedor amplio, que puede dar falsos positivos.
    await expect(
      page.getByText(/^(1 zona en el documento|1 area in the document)$/i),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /procesar|process/i }).first().click();

    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: /descargar|download/i }).first().click();
    });

    // El documento entero sigue teniendo 2 paginas: censurar no borra
    // paginas ni las fusiona.
    expect(await getPageCount(bytes)).toBe(2);

    // --- Pagina 1 (censurada): el secreto no debe ser recuperable ---
    const textPage1 = await getPageText(bytes, 1);
    expect(textPage1).not.toContain("SECRET-7F3A9");
    // Pagina entera rasterizada: no debe quedar NINGUN texto seleccionable.
    expect(textPage1.trim()).toBe("");

    const opsPage1 = await getPageOperatorCounts(bytes, 1);
    expect(opsPage1.textPaintOps).toBe(0);
    expect(opsPage1.imagePaintOps).toBeGreaterThan(0);

    // Muestreo de pixeles reales sobre la salida en 3 zonas independientes
    // (no solo el centro del parche): el texto secreto, el parche magenta,
    // y una esquina exterior a la caja que debe seguir en blanco. Probar
    // solo el parche no bastaria -- una pagina entera vuelta negra (un bug
    // real distinto: censurar de mas) tambien pasaria esa unica prueba.
    const rendered = await renderPageToPixels(bytes, 1, 2);

    // Zona del texto "SECRET-7F3A9" (x:40-208, y:250-274 en espacio PDF).
    const secretX = Math.round((124 / 400) * rendered.width);
    const secretY = Math.round(((300 - 262) / 300) * rendered.height);
    const secretSample = rendered.averageColor(secretX - 15, secretY - 8, 30, 16);
    expect(secretSample.r).toBeLessThan(40);
    expect(secretSample.g).toBeLessThan(40);
    expect(secretSample.b).toBeLessThan(40);

    // Zona del parche magenta (x:40-160, y:130-220 en espacio PDF).
    const patchCenterX = Math.round((100 / 400) * rendered.width);
    const patchCenterY = Math.round(((300 - 175) / 300) * rendered.height);
    const patchSample = rendered.averageColor(patchCenterX - 5, patchCenterY - 5, 10, 10);
    expect(patchSample.r).toBeLessThan(40);
    expect(patchSample.g).toBeLessThan(40);
    expect(patchSample.b).toBeLessThan(40);

    // Esquina exterior a la caja de censura (fuera de REDACT_ZONE, lejos
    // tambien del texto "no redactar..."): debe seguir en blanco. Si esto
    // fallara, significaria que se censuro de mas alla de la zona dibujada.
    const outsideX = Math.round(0.92 * rendered.width);
    const outsideY = Math.round(0.08 * rendered.height);
    const outsideSample = rendered.averageColor(outsideX - 10, outsideY - 10, 20, 20);
    expect(outsideSample.r).toBeGreaterThan(230);
    expect(outsideSample.g).toBeGreaterThan(230);
    expect(outsideSample.b).toBeGreaterThan(230);

    // --- Pagina 2 (sin censura): debe seguir intacta ---
    const textPage2 = await getPageText(bytes, 2);
    expect(textPage2).toContain("PUBLIC-MARKER-OK");
    const opsPage2 = await getPageOperatorCounts(bytes, 2);
    expect(opsPage2.textPaintOps).toBeGreaterThan(0);
  });
});
