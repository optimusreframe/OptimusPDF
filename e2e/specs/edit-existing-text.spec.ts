import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import { colorDistance, renderPageToPixels } from "../helpers/pdf-render-inspection";

/**
 * Editar el texto EXISTENTE de un PDF, inline y en vivo (Wave 5 · U4a): doble
 * clic sobre un bloque, escribir, estilo desde la barra flotante, mover,
 * deshacer/rehacer, borrar sobre un fondo de color, anadir texto nuevo, una
 * pagina con /Rotate, y exportar. Se comprueba el PDF descargado con pdf.js
 * (texto) y pixel a pixel (la cobertura del original no deja borde).
 *
 * Headless siempre (modo por defecto de Playwright).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

/** Caja (puntos de usuario) del bloque «Nota sobre fondo azul claro»: texto Helvetica 14 pt en (60, 405). */
const NOTE = { x: 60, baseline: 405, size: 14 };
const STRIP = rgb(0.93, 0.95, 1);

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);

  const p1 = doc.addPage([595, 842]);
  p1.drawText("Informe trimestral", { x: 50, y: 770, size: 26, font: bold });
  ["Primera linea de un parrafo de tres lineas", "segunda linea del mismo parrafo escrito", "y tercera linea que cierra el parrafo."].forEach(
    (line, index) => p1.drawText(line, { x: 50, y: 720 - index * 16, size: 12, font: times }),
  );
  p1.drawText("Total a pagar: 1.250,00", { x: 50, y: 600, size: 14, font: helv, color: rgb(0.8, 0.1, 0.1) });
  p1.drawRectangle({ x: 40, y: 380, width: 515, height: 60, color: STRIP });
  p1.drawText("Nota sobre fondo azul claro", { x: NOTE.x, y: NOTE.baseline, size: NOTE.size, font: helv });

  const p2 = doc.addPage([400, 300]);
  p2.setRotation({ type: "degrees", angle: 90 } as never);
  p2.drawText("Pagina dos rotada noventa", { x: 60, y: 200, size: 16, font: helv });
  return Buffer.from(await doc.save());
}

async function openEditor(page: Page) {
  await page.goto("/edit-pdf");
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "informe.pdf",
    mimeType: "application/pdf",
    buffer: await makePdf(),
  });
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 30_000 });
}

const block = (page: Page, text: string) => page.getByRole("button", { name: new RegExp(`^Texto: ${text}`) });

/** El foco nunca debe estar en <body> tras una accion del usuario. */
async function expectFocusNotOnBody(page: Page, label: string) {
  await expect
    .poll(async () => page.evaluate(() => document.activeElement === document.body), { message: label })
    .toBe(false);
}

test.describe("edit-pdf: edicion del texto existente", () => {
  test("editar en vivo, estilo, mover, deshacer/rehacer, borrar sobre color, texto nuevo y exportar", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await openEditor(page);
    await expect(page.locator("[data-analysis-status]")).toHaveText("");

    // 1. Doble clic abre el editor con el texto del bloque y el foco dentro.
    const total = block(page, "Total a pagar");
    await total.scrollIntoViewIfNeeded();
    await total.dblclick();
    const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("Total a pagar: 1.250,00");

    // La barra flotante queda QUIETA enseguida (solo opacidad al entrar): una caja que se mueve ~1 s hacia que cualquier
    // medida de posicion (un dedo, un clic automatico con reintentos) acabara desplazando la pagina y ocultandola.
    await expect(page.locator("[data-floating-bar]")).toBeVisible();
    await page.waitForTimeout(350);
    const moved = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const bar = document.querySelector("[data-floating-bar]")!;
          let previous = JSON.stringify(bar.getBoundingClientRect());
          let changes = 0;
          let frames = 0;
          const tick = () => {
            const now = JSON.stringify(bar.getBoundingClientRect());
            if (now !== previous) changes += 1;
            previous = now;
            frames += 1;
            if (frames < 12) requestAnimationFrame(tick);
            else resolve(changes);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(moved, "la barra seguia moviendose 350 ms despues de aparecer").toBe(0);

    // 2. Escribir en vivo: el texto cambia en el propio documento.
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Total pagado: 99,00");
    await expect(editor).toHaveText("Total pagado: 99,00");

    // 3. Estilo desde la barra flotante sin salir del editor (el foco sigue en el texto).
    await page.getByRole("button", { name: "Aumentar el tamaño" }).click();
    await page.getByRole("button", { name: "Negrita" }).click();
    await page.getByRole("button", { name: "Elegir el color" }).click();
    await page.getByRole("button", { name: "Color azul" }).click();
    await expect(editor).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Tamaño en puntos" })).toHaveValue("15");
    await expect(page.getByRole("button", { name: "Negrita" })).toHaveAttribute("aria-pressed", "true");

    // 4. Esc termina y el foco vuelve al bloque (nunca a <body>).
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(block(page, "Total pagado")).toBeFocused();

    // 5. Mover con las flechas (una pulsacion = un paso de historial).
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowDown");

    // 6. Borrar el texto de una nota sobre fondo de color: cubierto sin borde.
    const note = block(page, "Nota sobre fondo azul claro");
    await note.focus();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("button", { name: "Texto vacío" })).toBeFocused();

    // 7. Deshacer y rehacer con el teclado y con la paleta.
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(block(page, "Nota sobre fondo azul claro")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(page.getByRole("button", { name: "Texto vacío" })).toBeVisible();
    await page.getByRole("button", { name: "Deshacer", exact: true }).click();
    await expect(block(page, "Nota sobre fondo azul claro")).toBeVisible();
    await page.getByRole("button", { name: "Rehacer", exact: true }).click();
    await expect(page.getByRole("button", { name: "Texto vacío" })).toBeVisible();
    await expectFocusNotOnBody(page, "tras deshacer/rehacer");

    // 8. Texto nuevo con la herramienta T.
    await page.getByRole("button", { name: "Añadir texto" }).click();
    const sheet = page.locator("[data-page-index='0']");
    const height = (await sheet.boundingBox())!.height;
    // `click` con posicion desplaza la hoja hasta el punto (el raton suelto no sale de la ventana).
    await sheet.click({ position: { x: 80, y: height - 160 } });
    await page.keyboard.type("Texto nuevo añadido");
    await page.keyboard.press("Escape");
    await expectFocusNotOnBody(page, "tras anadir texto");

    // 9. Pagina 2 (con /Rotate 90): editar un bloque.
    await page.getByRole("button", { name: "Página siguiente" }).click();
    const rotated = block(page, "Pagina dos rotada noventa");
    await rotated.waitFor();
    await rotated.dblclick();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Pagina dos editada");
    await page.keyboard.press("Escape");
    await expectFocusNotOnBody(page, "tras editar en la pagina rotada");

    // Sin desbordes horizontales.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // 10. Exportar y comprobar el PDF descargado.
    await page.getByRole("button", { name: "Procesar" }).first().click();
    await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar" }).click();
    });

    expect(await getPageCount(bytes)).toBe(2);
    const text1 = await getPageText(bytes, 1);
    expect(text1).toContain("Total pagado: 99,00");
    expect(text1).toContain("Texto nuevo añadido");
    expect(text1).toContain("Informe trimestral"); // lo que no se toco sigue ahi
    const text2 = await getPageText(bytes, 2);
    expect(text2).toContain("Pagina dos editada");

    // 11. La cobertura del texto borrado no deja borde visible (> 1 px) sobre el fondo azul.
    const scale = 2;
    const rendered = await renderPageToPixels(bytes, 1, scale);
    const left = Math.round(NOTE.x * scale);
    const right = Math.round((NOTE.x + 170) * scale);
    const top = Math.round((842 - (NOTE.baseline + NOTE.size * 0.718)) * scale);
    const bottom = Math.round((842 - (NOTE.baseline - NOTE.size * 0.207)) * scale);
    const strip = { r: Math.round(STRIP.red * 255), g: Math.round(STRIP.green * 255), b: Math.round(STRIP.blue * 255), a: 255 };
    // Dentro de la caja del texto original: solo fondo (sin tinta).
    const inside = rendered.averageColor(left + 2, top + 2, right - left - 4, bottom - top - 4);
    expect(colorDistance(inside, strip)).toBeLessThan(6);
    // Y en una banda de 2 px justo fuera de la caja (por los cuatro lados) el color es el mismo: sin marco.
    for (const [x, y, w, h] of [
      [left - 3, top - 3, right - left + 6, 2],
      [left - 3, bottom + 1, right - left + 6, 2],
      [left - 3, top, 2, bottom - top],
    ] as const) {
      expect(colorDistance(rendered.averageColor(x, y, w, h), strip)).toBeLessThan(6);
    }

    expect(errors).toEqual([]);
  });

  test("una pagina sin texto avisa de que parece un escaneo y deja anadir texto", async ({ page }) => {
    await page.goto("/edit-pdf");
    const blank = await PDFDocument.create();
    blank.addPage([400, 500]);
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "escaneo.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await blank.save()),
    });
    await expect(page.locator("[data-analysis-status]")).toHaveText(
      "Esta página parece un escaneo: no tiene texto que editar. Puedes añadir texto, imágenes y formas encima.",
      { timeout: 30_000 },
    );
    // El aviso ofrece la accion «Añadir texto» (la misma herramienta de la paleta).
    await page.locator("[data-scanned-add-text]").click();
    await expect(page.locator("[data-tool-hint]")).not.toHaveText("");
    await page.locator("[data-page-index='0']").click({ position: { x: 60, y: 80 } });
    await page.keyboard.type("Sobre un escaneo");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Procesar" }).first().click();
    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar" }).click();
    });
    expect(await getPageText(bytes, 1)).toContain("Sobre un escaneo");
  });
});

test.describe("edit-pdf en movil (375 x 812, tactil)", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("tocar selecciona, tocar de nuevo edita, sin desbordes y con objetivos tactiles de 44 px", async ({ page }) => {
    await openEditor(page);
    const total = block(page, "Total a pagar");
    // Al centro de la pantalla: la paleta y la barra de accion fijas tapan el borde inferior.
    await total.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const rect = (await total.boundingBox())!;
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await expect(total).toHaveAttribute("aria-pressed", "true");
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await expect(page.getByRole("textbox", { name: "Editando el texto del bloque" })).toBeFocused();
    await page.keyboard.type(" EUR");

    // La barra de Editar entra solo con opacidad (sin escala): se mide en cuanto esta; el sondeo cubre la hoja de «Mas».
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            [...document.querySelectorAll("[data-floating-bar] button, [data-floating-bar] select, [data-tool-palette] button, [data-resize-handle]")]
              .map((el) => ({ name: el.getAttribute("aria-label") ?? (el as HTMLElement).dataset.resizeHandle, ...el.getBoundingClientRect().toJSON() }))
              .filter((el) => el.width < 43.5 || el.height < 43.5)
              .map((el) => el.name),
          ),
        { timeout: 5000 },
      )
      .toEqual([]);

    const bar = await page.locator("[data-floating-bar]").boundingBox();
    expect(bar!.x).toBeGreaterThanOrEqual(0);
    expect(bar!.x + bar!.width).toBeLessThanOrEqual(375);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
