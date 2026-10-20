import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { expect, test, type Page } from "@playwright/test";
import { isBenignEngineNoise } from "../helpers/engine";

/**
 * Paleta de herramientas de «Editar» en el movil (Wave 10 · C-A3), tactil, headless, claro y oscuro, en 375x812 y
 * 360x640: TODOS los botones (herramientas, deshacer, rehacer) miden >= 44 px, caen dentro de la ventana y ningun otro
 * elemento los tapa (`elementFromPoint` en el centro y en las cuatro esquinas de cada boton).
 *
 * Defecto que se vigila: en «Editar PDF» (herramienta suelta) la paleta es una banda fija que se colocaba a una
 * distancia FIJA (9,25 rem) del borde de abajo, pensada para una barra de «Procesar» de 4,75 rem. Con el motivo de
 * «Procesar» desactivado («Haz un cambio en el documento para poder exportarlo.», lo primero que se ve al abrir el
 * editor) la barra mide mas (y a 360 px el texto da dos lineas, y en WebKit mas aun): la barra (`z-30`) tapaba la
 * mitad de la segunda fila de la paleta (`z-20`). Ahora la paleta mide las barras fijas de abajo y se coloca encima.
 *
 * Ademas del caso «con motivo» (al abrir) se prueba el de «sin motivo» (tras editar un texto) y el modo Editar de PDF
 * Pro, donde la paleta va en el flujo de la pagina.
 */

test.setTimeout(180_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");

/** El motivo de «Procesar» que pinta la barra fija del movil (el de escritorio, `-main`, esta oculto). */
const BAR_REASON = '[data-run-reason][id$="-bar"]';

const VIEWPORTS = [
  { name: "375x812", width: 375, height: 812 },
  { name: "360x640", width: 360, height: 640 },
] as const;
const SCHEMES = ["light", "dark"] as const;

async function makeReport(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Contrato de servicios", { x: 50, y: 770, size: 24, font });
  page.drawText("Total a pagar: 1.250,00", { x: 50, y: 600, size: 14, font, color: rgb(0.8, 0.1, 0.1) });
  const second = doc.addPage([595, 842]);
  second.drawText("Pagina dos", { x: 50, y: 770, size: 20, font });
  return Buffer.from(await doc.save());
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isBenignEngineNoise(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (!isBenignEngineNoise(error.message)) errors.push(error.message);
  });
  return errors;
}

/** La paleta y la barra de abajo ya no se mueven (muelles, fuentes, medida de las barras). */
async function settle(page: Page): Promise<void> {
  const read = () =>
    page.evaluate(() => {
      const rect = (el: Element | null) => (el ? JSON.stringify(el.getBoundingClientRect().toJSON()) : "");
      const bar = document.querySelector('[data-run-reason][id$="-bar"]')?.parentElement ?? null;
      return rect(document.querySelector("[data-tool-palette]")) + rect(bar);
    });
  let previous = await read();
  let same = 0;
  for (let attempt = 0; attempt < 60 && same < 4; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await read();
    same = next === previous ? same + 1 : 0;
    previous = next;
  }
}

type Report = {
  buttons: number;
  small: string[];
  outside: string[];
  covered: string[];
  overflow: number;
  palette: { top: number; bottom: number };
};

/** Mide la paleta como la veria un dedo: tamano, dentro de la ventana y qué hay realmente en cada punto de cada boton. */
async function probePalette(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const palette = document.querySelector<HTMLElement>("[data-tool-palette]")!;
    const small: string[] = [];
    const outside: string[] = [];
    const covered: string[] = [];
    const describe = (el: Element | null) =>
      el ? `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}.${String(el.className).split(" ").slice(0, 3).join(".")}` : "nada";
    const buttons = Array.from(palette.querySelectorAll<HTMLElement>("button"));
    for (const button of buttons) {
      const id = button.dataset.paletteItem ?? "?";
      const rect = button.getBoundingClientRect();
      if (rect.width < 43.5 || rect.height < 43.5) small.push(`${id} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      if (rect.top < -0.5 || rect.left < -0.5 || rect.bottom > window.innerHeight + 0.5 || rect.right > window.innerWidth + 0.5) {
        outside.push(`${id} (${Math.round(rect.top)}..${Math.round(rect.bottom)} de ${window.innerHeight})`);
      }
      for (const [fx, fy] of [[0.5, 0.5], [0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        const top = document.elementFromPoint(x, y);
        if (!(top === button || (top && button.contains(top)))) covered.push(`${id}@${fx},${fy} -> ${describe(top)}`);
      }
    }
    const box = palette.getBoundingClientRect();
    return {
      buttons: buttons.length,
      small,
      outside,
      covered,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      palette: { top: box.top, bottom: box.bottom },
    };
  });
}

async function expectReachable(page: Page, label: string): Promise<Report> {
  await settle(page);
  const report = await probePalette(page);
  expect(report.buttons, `${label}: botones de la paleta`).toBeGreaterThanOrEqual(10);
  expect(report.small, `${label}: botones de menos de 44 px`).toEqual([]);
  expect(report.outside, `${label}: botones fuera de la ventana`).toEqual([]);
  expect(report.covered, `${label}: puntos de botones tapados por otro elemento`).toEqual([]);
  expect(report.overflow, `${label}: desborde horizontal`).toBeLessThanOrEqual(0);
  return report;
}

/** Ejecuta axe sobre un contexto de la pagina y devuelve las violaciones (id + nodo). */
async function axeViolations(page: Page, context: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (selector) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe;
    const result = await axe.run(selector, {});
    return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 120)}`));
  }, context);
}

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`movil tactil ${viewport.name} · ${scheme}`, () => {
      test.use({
        locale: "es-ES",
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
        colorScheme: scheme,
      });

      test("Editar PDF: toda la paleta se alcanza con el dedo, al abrir (con motivo de «Procesar») y tras un cambio", async ({ page }) => {
        const errors = trackErrors(page);
        await page.goto("/edit-pdf");
        await page.locator('input[type="file"]').first().setInputFiles({
          name: "informe.pdf",
          mimeType: "application/pdf",
          buffer: await makeReport(),
        });
        await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
        await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 30_000 });

        // 1) Al abrir: «Procesar» desactivado con su motivo dentro de la barra (la barra mas alta).
        await expect(page.locator(BAR_REASON)).toBeVisible();
        const initial = await expectReachable(page, `al abrir ${viewport.name} ${scheme}`);

        // axe sobre la paleta y sobre el editor entero: sin violaciones.
        expect(await axeViolations(page, "[data-tool-palette]"), "axe en la paleta").toEqual([]);
        expect(await axeViolations(page, "[data-edit-workspace]"), "axe en el editor").toEqual([]);

        // 2) Armar una herramienta no cambia el reparto (el boton activo sigue entero y sin tapar).
        await page.getByRole("toolbar").getByRole("button", { name: "Añadir texto", exact: true }).tap();
        await expect(page.getByRole("toolbar").getByRole("button", { name: "Añadir texto", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expectReachable(page, `herramienta armada ${viewport.name} ${scheme}`);
        await page.getByRole("toolbar").getByRole("button", { name: "Añadir texto", exact: true }).tap();

        // 3) Tras editar un texto existente el motivo desaparece (la barra baja de alto) y la paleta sigue entera.
        const total = page.getByRole("button", { name: /^Texto: Total a pagar/ });
        await total.evaluate((el) => el.scrollIntoView({ block: "center" }));
        // Un toque selecciona (sale la barra del texto y el editor puede desplazar la pagina para dejarle sitio) y el
        // siguiente edita: el segundo toque se da donde el bloque esta DESPUES del primero.
        for (let tap = 0; tap < 2; tap += 1) {
          await page.waitForTimeout(400);
          const box = (await total.boundingBox())!;
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        }
        const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
        await expect(editor).toBeFocused();
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type("Pagado 99,00");
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: /^Texto: Pagado 99,00/ })).toBeVisible();
        await expect(page.locator(BAR_REASON)).toHaveCount(0);
        const changed = await expectReachable(page, `tras editar ${viewport.name} ${scheme}`);
        // Sin motivo la barra es mas baja: la paleta baja con ella (no se queda flotando a la altura del caso anterior).
        expect(changed.palette.bottom, "la paleta baja cuando la barra se acorta").toBeGreaterThan(initial.palette.bottom + 4);
        expect(errors).toEqual([]);
      });

      test("PDF Pro · modo Editar: toda la paleta se alcanza con el dedo", async ({ page }) => {
        const errors = trackErrors(page);
        await page.goto("/pdf-pro");
        await page.locator('input[type="file"]').first().setInputFiles({
          name: "informe.pdf",
          mimeType: "application/pdf",
          buffer: await makeReport(),
        });
        await expect(page.locator("[data-pro-viewer-scroller]")).toBeVisible();
        await page.locator('[data-dock="edit"]').tap();
        await expect(page.locator('[data-pro-editor] [data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
        // M2 · VP-01: en un alto pequeño (< 720 px: 360x640) PDF Pro arranca con las barras del modo PLEGADAS para dar sitio a la
        // hoja; la paleta se alcanza con UN toque en «Mostrar herramientas» (boton de 44 px de la barra de abajo). Una vez a la
        // vista, la comprobacion es la de siempre: todos los botones miden >= 44 px, caen en la ventana y nada los tapa.
        const fold = page.locator("[data-pro-fold-toggle]");
        if ((await fold.getAttribute("aria-expanded")) === "false") await fold.tap();
        await expect(page.locator("[data-tool-palette]")).toBeVisible();
        await expectReachable(page, `Pro Editar ${viewport.name} ${scheme}`);
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe("escritorio 1280x800 (sin cambios)", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  test("la paleta sigue siendo una columna pegada al lado, sin la banda fija del movil", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "informe.pdf",
      mimeType: "application/pdf",
      buffer: await makeReport(),
    });
    await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
    const facts = await page.evaluate(() => {
      const palette = document.querySelector<HTMLElement>("[data-tool-palette]")!;
      const style = getComputedStyle(palette);
      const rect = palette.getBoundingClientRect();
      return { position: style.position, width: rect.width, height: rect.height, bottomVar: palette.style.getPropertyValue("--edit-palette-bottom") };
    });
    expect(facts.position).toBe("sticky");
    expect(facts.width).toBeLessThan(80);
    expect(facts.height).toBeGreaterThan(300);
    // La distancia medida es solo del movil: en escritorio la paleta no lleva ninguna variable.
    expect(facts.bottomVar).toBe("");
    // En escritorio los botones miden 44x40 (puntero fino) y la columna empieza donde la hoja (parte puede quedar bajo el
    // pliegue): no se mide alcance, solo que es la columna de siempre.
    expect(await page.locator("[data-tool-palette] button").count()).toBeGreaterThanOrEqual(10);
  });
});
