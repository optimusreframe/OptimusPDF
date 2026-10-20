import { expect, test, type Page } from "@playwright/test";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import {
  ALL_PROFILES,
  bottomLayers,
  coveredHeight,
  inputFontSizes,
  isHittable,
  makeContract,
  multiWithTwoSigners,
  openPalette,
  openSign,
  pdfFile,
  PHONE_PROFILES,
  rectOf,
  tightButtonPairs,
  waitSheetReady,
} from "../helpers/mobile-sign";
import { drawInOpenComposer } from "../helpers/sign-flow";

/**
 * Firmar PDF en movil e iPad · «Solo yo» (auditoria `docs/AUDITORIA-MOVIL-IPAD.md`):
 *  - ER-01  tras «Usar esta firma» la firma colocada queda VISIBLE y sin nada encima;
 *  - SC-02  las capas fijas de abajo no pasan del ~25 % del alto y la paleta no flota fuera del lienzo ni tapa el pie;
 *  - VI-04  la paleta no solapa la barra de zoom;
 *  - VI-07  botones contiguos a >= 8 px;
 *  - SC-04  campos propios de Firmar a >= 16 px con tactil.
 * Tactil, headless; PDF sintetico. Corre en Chromium (perfiles iOS emulados) y en `webkit-ipad`.
 */
test.setTimeout(180_000);
const SG = SIGN_STRINGS.es;

const SIGNATURE = '[data-element-kind="slot"][data-element-id="solo-signature"][data-drag-mode="move"]';

async function createSoloSignature(page: Page): Promise<void> {
  await page.getByRole("button", { name: SG.createSignature }).first().click();
  await drawInOpenComposer(page, 3);
}

for (const profile of ALL_PROFILES) {
  test.describe(`Firmar · solo yo · ${profile.label}`, () => {
    test.use(profile.use);

    test("ER-01 · tras «Usar esta firma» la firma colocada se ve entera y sin nada encima", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await waitSheetReady(page);
      await createSoloSignature(page);
      const signature = page.locator(SIGNATURE);
      await expect(signature).toBeAttached({ timeout: 15_000 });
      await expect
        .poll(async () => {
          const hit = await isHittable(signature);
          return hit.ok ? "ok" : hit.reason;
        }, { timeout: 12_000, message: "la firma recien colocada debe quedar visible y sin barras encima" })
        .toBe("ok");
    });

    test("ER-01 · con la hoja ampliada la firma nueva tambien se ve (se vuelve a 100 %)", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      const host = await waitSheetReady(page);
      const zoomIn = page.getByRole("button", { name: SG.zoomIn, exact: true });
      await zoomIn.evaluate((element) => element.scrollIntoView({ block: "center" }));
      for (let step = 0; step < 2; step += 1) await zoomIn.click(); // 1 -> 1,5 -> 2
      await expect(page.getByRole("button", { name: SG.resetZoomButton, exact: true })).toBeEnabled();
      await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await createSoloSignature(page);
      const signature = page.locator(SIGNATURE);
      await expect(signature).toBeAttached({ timeout: 15_000 });
      await expect
        .poll(async () => {
          const hit = await isHittable(signature);
          return hit.ok ? "ok" : hit.reason;
        }, { timeout: 12_000, message: "con zoom, la firma recien colocada debe quedar visible y sin barras encima" })
        .toBe("ok");
    });

    test("SC-02 · la paleta no flota fuera del lienzo y no tapa el pie de la hoja", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      const host = await waitSheetReady(page);
      const dock = page.locator("[data-tool-palette], [data-palette-fab]");
      const vh = page.viewportSize()?.height ?? 0;

      // En la cabecera de la pagina (config, aviso, teclado): la paleta no flota sobre ese texto.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
      const hostTop = (await rectOf(host)).top;
      for (const element of await dock.all()) {
        if (!(await element.isVisible())) continue;
        const r = await rectOf(element);
        expect(r.top, "la paleta solo se ve sobre la hoja (no sobre el texto de arriba)").toBeGreaterThanOrEqual(hostTop - 16);
      }

      // Al final de la pagina: el pie de la hoja queda por encima de la paleta.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(250);
      const sheet = await rectOf(host);
      for (const element of await dock.all()) {
        if (!(await element.isVisible())) continue;
        const r = await rectOf(element);
        const coversFoot = r.top < sheet.bottom - 2 && r.bottom > sheet.bottom - 60 && r.right > sheet.left && r.left < sheet.right;
        expect(coversFoot, `la paleta (${Math.round(r.top)}..${Math.round(r.bottom)}) tapa el pie de la hoja (${Math.round(sheet.bottom)}); vh ${vh}`).toBe(false);
      }
    });

    test("VI-04 · la paleta no solapa la barra de zoom en ningun punto del desplazamiento", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await waitSheetReady(page);
      const total = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        await page.evaluate((y) => window.scrollTo(0, y), Math.round(total * fraction));
        await page.waitForTimeout(200);
        const overlap = await page.evaluate(() => {
          const zoom = document.querySelector("[data-canvas-sticky]");
          // Solo las posiciones de trabajo: la hoja ocupa al menos el 35 % de la ventana (al pasar de largo el final de la hoja,
          // la paleta pegajosa sube con ella por debajo de cualquier barra pegada: eso es desplazamiento, no un solape en reposo).
          const sheet = document.querySelector('[data-canvas="host"]')?.getBoundingClientRect();
          const visibleSheet = sheet ? Math.max(0, Math.min(sheet.bottom, innerHeight) - Math.max(sheet.top, 0)) : 0;
          if (visibleSheet < innerHeight * 0.35) return "ok";
          const palettes = [...document.querySelectorAll("[data-tool-palette], [data-palette-fab]")];
          if (!zoom) return "sin barra de zoom";
          const z = zoom.getBoundingClientRect();
          for (const palette of palettes) {
            const cs = getComputedStyle(palette);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            const p = palette.getBoundingClientRect();
            if (p.width === 0 || p.height === 0) continue;
            const w = Math.min(z.right, p.right) - Math.max(z.left, p.left);
            const h = Math.min(z.bottom, p.bottom) - Math.max(z.top, p.top);
            if (w > 2 && h > 2) return `solapa ${Math.round(w)}x${Math.round(h)} (zoom ${Math.round(z.top)}..${Math.round(z.bottom)}, paleta ${Math.round(p.top)}..${Math.round(p.bottom)})`;
          }
          return "ok";
        });
        expect(overlap, `desplazamiento ${Math.round(fraction * 100)} %`).toBe("ok");
      }
    });

    test("VI-07 · botones contiguos a >= 8 px (paleta abierta y pantalla de solo yo)", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      const host = await waitSheetReady(page);
      await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await openPalette(page);
      await page.waitForTimeout(300);
      // La cabecera global y el selector segmentado no son de Firmar; el aviso de «E-sign» tampoco.
      const bad = await tightButtonPairs(page, "main");
      expect(bad, `pares de botones a menos de 8 px:\n${bad.join("\n")}`).toEqual([]);
    });

    test("SC-04 · los campos de texto propios de Firmar miden >= 16 px con tactil", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await multiWithTwoSigners(page);
      // Paso 1: nombres de los firmantes.
      let sizes = await inputFontSizes(page, "main");
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.filter((item) => item.px < 16), "campos < 16 px en el paso 1").toEqual([]);

      // Paso 2: el campo de texto que se escribe sobre la hoja.
      await page.getByRole("button", { name: "2. Documento" }).click();
      const host = await waitSheetReady(page);
      await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const toolbar = await openPalette(page);
      await toolbar.getByRole("button", { name: SG.fieldTypeText, exact: true }).click();
      const box = await rectOf(host.locator("img").first());
      // Un punto de la hoja que se ve (la hoja esta centrada en la ventana: su mitad alta puede quedar fuera de la pantalla).
      await page.mouse.click(box.left + 100, Math.round((page.viewportSize()?.height ?? 700) * 0.4));
      const field = page.locator('[data-canvas="host"] input[type="text"], [data-canvas="host"] input:not([type])').first();
      await field.waitFor({ state: "visible", timeout: 8000 });
      sizes = await inputFontSizes(page, '[data-canvas="host"]');
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.filter((item) => item.px < 16), "campo de texto de la hoja < 16 px").toEqual([]);
    });
  });
}

for (const profile of PHONE_PROFILES) {
  test.describe(`Firmar · capas fijas · ${profile.label}`, () => {
    test.use(profile.use);

    test("SC-02 · paleta + barra «Opciones/Procesar» + tab bar no pasan del 25 % del alto", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      const host = await waitSheetReady(page);
      // Trabajando sobre la hoja: su borde de arriba al 20 % de la ventana y el resto de la hoja por debajo, de modo que la
      // paleta (pegajosa) esta pegada abajo, sobre las barras fijas.
      await host.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().top - window.innerHeight * 0.2));
      await page.waitForTimeout(400);
      const vh = page.viewportSize()?.height ?? 0;
      const layers = await bottomLayers(page);
      const covered = coveredHeight(layers, vh);
      expect(
        covered / vh,
        `capas fijas: ${layers.map((layer) => `${layer.label}@${layer.top}-${layer.bottom}${layer.painted ? "" : " (transparente)"}`).join(", ")} = ${covered} de ${vh} px`,
      ).toBeLessThanOrEqual(0.25);
    });
  });
}
