import { PDFDocument } from "@cantoo/pdf-lib";
import { es } from "../../src/lib/locales/es";
import { expect, openTool, runButton, test, uploadFiles } from "../helpers/tool-flow";
import { makeImage, pdfUpload } from "../helpers/test-files";

/**
 * Reconocer texto (OCR) cuando el motor no carga (W6-D): antes la CDN colgada no tenia limite de espera
 * (solo quedaba Cancelar) y sin red salia el generico «Algo ha fallado». Ahora, como en PDF a texto/Word/
 * Markdown, falla en claro (`ocrNetworkFailure`) y se puede reintentar. El OCR real (con red) no se cubre aqui.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

async function scan(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const image = await document.embedJpg(makeImage("jpeg", 300, 400, 9, 80));
  document.addPage([300, 400]).drawImage(image, { x: 0, y: 0, width: 300, height: 400 });
  return Buffer.from(await document.save());
}

/** Los intentos del motor de OCR avisan en consola de que su script no cargo: es lo que se provoca aqui. */
function allowOcrScriptFailure(consoleErrors: string[]) {
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((entry) => !/importScripts.*cdn\.jsdelivr\.net/.test(entry)));
}

test.describe("ocr-pdf · el motor de OCR no carga", () => {
  test("sin red (peticion rechazada): error claro, no «Algo ha fallado», y se puede reintentar", async ({ page, context, consoleErrors }) => {
    await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
    await openTool(page, "ocr-pdf");
    await uploadFiles(page, pdfUpload("escaneo.pdf", await scan()));
    await runButton(page).click();
    const banner = page.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText(es.tool.errors.ocrNetworkFailure);
    await expect(banner).toContainText("No se pudo cargar el motor de OCR. Comprueba tu conexión e inténtalo de nuevo.");
    await expect(page.locator("body")).not.toContainText(es.tool.errors.unknown);
    await expect(page.getByRole("button", { name: "Cancelar", exact: true })).toHaveCount(0);
    await expect(runButton(page)).toBeEnabled();
    allowOcrScriptFailure(consoleErrors);
  });

  test("CDN colgada (peticion que nunca responde): error claro en unos 20 s, no esperar sin limite", async ({ page, context }) => {
    await context.route(
      (url) => url.hostname !== "localhost",
      () => {},
    );
    await openTool(page, "ocr-pdf");
    await uploadFiles(page, pdfUpload("escaneo.pdf", await scan()));
    const started = Date.now();
    await runButton(page).click();
    const banner = page.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 40_000 });
    const seconds = (Date.now() - started) / 1000;
    expect(seconds).toBeGreaterThanOrEqual(18);
    expect(seconds).toBeLessThan(35);
    await expect(banner).toContainText(es.tool.errors.ocrNetworkFailure);
    await expect(page.getByRole("button", { name: "Cancelar", exact: true })).toHaveCount(0);
    await expect(runButton(page)).toBeEnabled();
  });

  test("cancelar mientras espera al motor corta al instante y no deja error", async ({ page, context }) => {
    await context.route(
      (url) => url.hostname !== "localhost",
      () => {},
    );
    await openTool(page, "ocr-pdf");
    await uploadFiles(page, pdfUpload("escaneo.pdf", await scan()));
    await runButton(page).click();
    const cancel = page.getByRole("button", { name: "Cancelar", exact: true });
    await expect(cancel).toBeVisible();
    await cancel.dispatchEvent("click");
    await expect(page.getByRole("status").filter({ hasText: "Proceso cancelado." })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("[data-error-banner]")).toHaveCount(0);
    await expect(runButton(page)).toBeEnabled();
  });
});
