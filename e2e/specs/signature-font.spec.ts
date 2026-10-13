import { expect, test, type Browser } from "@playwright/test";
import path from "node:path";

/**
 * W6-C · N1: la firma escrita (Caveat se baja bajo demanda, `preload: false`)
 * debe exportarse con la MISMA fuente que muestra la vista previa. Se retrasa
 * el .woff2 0 / 1 / 6 s, se escribe un nombre y se guarda de inmediato, 20
 * veces por retraso, cada una en un contexto limpio (fuente fria): el PNG
 * exportado mide lo mismo que con la fuente ya cargada (±1 px) o aparece el
 * aviso de fuente de respaldo (6 s supera el tope de 4 s), pero nunca sale
 * una firma silenciosamente distinta.
 */
const PDF = path.join(__dirname, "..", "fixtures", "core-rotated-pages.pdf");
const NAME = "Maria Gonzalez";
const RUNS = 20;

async function exportOnce(browser: Browser, delayMs: number, waitForFont: boolean, withoutArial = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("optimuspdf.language", "es");
    localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
    // Registra cada PNG que sale de un canvas (la firma exportada es el ultimo).
    const w = window as unknown as { __png: Array<[number, number]> };
    w.__png = [];
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, type?: string, ...rest: unknown[]) {
      if (!type || type === "image/png") w.__png.push([this.width, this.height]);
      return (original as (...a: unknown[]) => string).call(this, type, ...rest);
    } as typeof original;
  });
  const page = await context.newPage();
  if (withoutArial) {
    // Emula un equipo sin Arial (el runner Linux de CI, Android, ChromeOS): una cara `local(Arial)` (la «Caveat
    // Fallback» que Next genera por defecto) quedaria en estado "error" y `document.fonts.check()` devolveria false
    // para toda la pila aunque Caveat estuviera cargada. En macOS Arial existe, asi que se rompe a proposito.
    await page.route("**/_next/static/**/*.css", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replaceAll("local(Arial)", "local(__sin_arial_instalado__)");
      await route.fulfill({ response, body });
    });
  }
  // Solo se retrasa la fuente.
  await page.route("**/_next/static/media/*.woff2", async (route) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.continue();
  });
  try {
    await page.goto("/sign-pdf", { waitUntil: "networkidle" });
    await page
      .locator('input[type="file"][accept*="pdf"]')
      .first()
      .setInputFiles(PDF);
    // Con la hoja ya pintada: un clic justo despues de subir el archivo (mientras el documento aun se carga) se pierde
    // en WebKit y la hoja de firma no se abre.
    await page.locator('img[alt]:not([alt=""])').first().waitFor();
    await page.getByRole("button", { name: "Crear firma" }).first().click();
    await page.getByRole("tab", { name: "Escribir" }).click();
    if (waitForFont) {
      await page.waitForFunction(() =>
        [...document.fonts].some((f) => f.family.includes("Caveat") && f.status === "loaded"),
      );
    }
    await page.locator("#signature-typed").fill(NAME);
    await page.getByRole("button", { name: "Usar esta firma" }).click();
    // Guardado = la hoja del compositor se cierra (el PNG exportado es el ultimo
    // que salio de un canvas justo antes); aviso = aparece el estado de la fuente.
    const outcome = await Promise.race([
      page.locator("[data-font-notice]").waitFor({ timeout: 15_000 }).then(() => "notice" as const),
      page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 }).then(() => "exported" as const),
    ]);
    const size = await page.evaluate(() => {
      const list = (window as unknown as { __png: Array<[number, number]> }).__png;
      const last = list[list.length - 1];
      return last ? { width: last[0], height: last[1] } : null;
    });
    const stillOpen = await page.getByRole("dialog").isVisible();
    return { outcome, size, stillOpen };
  } finally {
    await context.close();
  }
}

test.describe("firma escrita: la fuente exportada es la de la vista previa", () => {
  let reference: { width: number; height: number };

  test.beforeAll(async ({ browser }) => {
    const base = await exportOnce(browser, 0, true);
    expect(base.outcome).toBe("exported");
    reference = base.size!;
    expect(reference.width).toBeGreaterThan(100);
  });

  test("equipo sin Arial: con Caveat cargada se guarda sin aviso de fuente y con el mismo tamano", async ({ browser }) => {
    const { outcome, size } = await exportOnce(browser, 0, true, true);
    expect(outcome, "con la fuente cargada no debe salir el aviso de «la fuente no cargo»").toBe("exported");
    expect(Math.abs(size!.width - reference.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(size!.height - reference.height)).toBeLessThanOrEqual(1);
  });

  for (const delay of [0, 1000, 6000]) {
    test(`.woff2 retrasado ${delay} ms: guardar de inmediato ${RUNS} veces`, async ({ browser }) => {
      test.setTimeout(delay === 6000 ? 600_000 : 300_000);
      const results: string[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const { outcome, size, stillOpen } = await exportOnce(browser, delay, false);
        if (outcome === "notice") {
          // Aviso mostrado y NADA exportado en silencio: la hoja sigue abierta.
          expect(stillOpen, `#${i + 1}: aviso y aun asi se cerro/exporto`).toBe(true);
          results.push("aviso");
          continue;
        }
        expect(Math.abs(size!.width - reference.width), `#${i + 1} ancho ${size!.width} vs ${reference.width}`).toBeLessThanOrEqual(1);
        expect(Math.abs(size!.height - reference.height), `#${i + 1} alto ${size!.height} vs ${reference.height}`).toBeLessThanOrEqual(1);
        results.push("igual");
      }
      test.info().annotations.push({ type: "resultados", description: `${delay} ms: ${results.join(",")}` });
      // Con retraso de 6 s (> 4 s de tope) el aviso es lo esperado; con menos, la firma sale igual.
      if (delay < 4000) expect(results.every((r) => r === "igual")).toBe(true);
    });
  }
});
