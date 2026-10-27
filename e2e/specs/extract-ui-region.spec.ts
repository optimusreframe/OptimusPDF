import { expect, test, type Page } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { downloadFile } from "../helpers/downloads";
import { readVault } from "../helpers/sign-vault-flow";
import { installUnavailable, pdfInput, setLanguage, signaturePdf } from "../helpers/extract-ui-flow";

/**
 * «Recortar región» (F7 · U7.4) con el `cropRegion` REAL: pdf.js renderiza solo la zona a 300-600 ppp en el navegador,
 * `inkExtract` quita el fondo y el PNG se comprueba PIXEL A PIXEL (alfa de las esquinas, color de la tinta, tamano). El PDF
 * es sintetico (pdf-lib): una firma de trazos azules junto a «Firma:». Sin motor de deteccion (se simula con el gancho: el motor
 * por defecto ya es el real): solo el recorte manual. Headless siempre.
 */

test.setTimeout(120_000);

type Stats = { width: number; height: number; corners: number[]; opaque: number; transparent: number; inkRgb: [number, number, number] | null };

async function pngStats(bytes: Buffer): Promise<Stats> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let opaque = 0;
  let transparent = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) transparent += 1;
    if (data[i + 3] >= 200) {
      opaque += 1;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
  }
  const at = (x: number, y: number): number => data[(y * image.width + x) * 4 + 3];
  const total = image.width * image.height;
  return {
    width: image.width,
    height: image.height,
    corners: [at(0, 0), at(image.width - 1, 0), at(0, image.height - 1), at(image.width - 1, image.height - 1)],
    opaque: opaque / total,
    transparent: transparent / total,
    inkRgb: opaque > 0 ? [Math.round(r / opaque), Math.round(g / opaque), Math.round(b / opaque)] : null,
  };
}

async function openRegion(page: Page, options: { lang?: "es" | "en" } = {}): Promise<void> {
  await setLanguage(page, options.lang ?? "es");
  // Solo el recorte manual: el motor de deteccion de por defecto es el real, asi que se simula «sin motor» con el gancho.
  await installUnavailable(page);
  await page.goto("/extract-assets");
  await pdfInput(page).setInputFiles(await signaturePdf());
  await page.getByRole("button", { name: options.lang === "en" ? "Find elements" : "Buscar elementos" }).click();
  await expect(page.locator("[data-region-rect]")).toBeVisible({ timeout: 30_000 });
  // La pagina esta pintada (un lienzo con tinta oscura: el titulo y la firma).
  await expect.poll(() => page.evaluate(() => !!document.querySelector("[data-region-page-canvas] canvas")), { timeout: 30_000 }).toBe(true);
}

const rectLabel = (page: Page): Promise<string> => page.locator("[data-region-rect]").getAttribute("aria-label").then((value) => value ?? "");

test.describe("extract-assets · recortar region (cropRegion real)", () => {
  test("la pagina se pinta con pdf.js y el rectangulo se maneja con el teclado: flechas mueven, Mayus + flechas redimensionan", async ({ page }) => {
    await openRegion(page);
    const dark = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("[data-region-page-canvas] canvas")!;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 3] > 0) count += 1;
      return count;
    });
    expect(dark).toBeGreaterThan(200);
    const rect = page.locator("[data-region-rect]");
    await rect.focus();
    expect(await rectLabel(page)).toContain("izquierda 12 %, arriba 66 %, ancho 40 %, alto 12 %");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await rectLabel(page)).toContain("izquierda 14 %, arriba 66 %, ancho 40 %, alto 12 %");
    await page.keyboard.press("ArrowUp");
    expect(await rectLabel(page)).toContain("arriba 65 %");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    expect(await rectLabel(page)).toContain("ancho 41 %, alto 13 %");
    // El rectangulo no sale de la pagina.
    for (let i = 0; i < 120; i += 1) await page.keyboard.press("ArrowLeft");
    expect(await rectLabel(page)).toContain("izquierda 0 %");
    // La region viva UNICA anuncia el valor tras cada flecha.
    await expect(page.locator("[data-extract-status]")).toContainText("Región: izquierda 0 %");
    expect(await page.locator('[role="status"]').count()).toBe(1);
  });

  test("arrastrar el cuerpo y una asa (puntero) mueve y redimensiona; las asas miden 44 px", async ({ page }) => {
    await openRegion(page);
    const handles = page.locator("[data-region-handle]");
    // Las cuatro esquinas y los bordes largos siempre; las asas de los laterales solo si el borde mide 96 px o mas (a 1280 px la region por
    // defecto mide 84 px de alto: seis asas; en un iPad, mas grande, ya salen las ocho)...
    await expect.poll(() => handles.count()).toBeGreaterThanOrEqual(6);
    // ... y al hacerlo mas alto aparecen las ocho: esquinas y bordes.
    for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Más alto" }).click();
    await expect(handles).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      const box = (await handles.nth(index).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
    const before = await rectLabel(page);
    // El raton de Playwright no desplaza la pagina: se lleva el rectangulo (y sus asas) a la vista antes de medir.
    await page.locator("[data-region-page-canvas]").scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector("[data-region-rect]")!.scrollIntoView({ block: "center" }));
    const body = (await page.locator("[data-region-rect]").boundingBox())!;
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    await page.mouse.down();
    await page.mouse.move(body.x + body.width / 2 + 40, body.y + body.height / 2 - 30, { steps: 5 });
    await page.mouse.up();
    const moved = await rectLabel(page);
    expect(moved).not.toBe(before);
    const se = (await page.locator('[data-region-handle="se"]').boundingBox())!;
    await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
    await page.mouse.down();
    await page.mouse.move(se.x + se.width / 2 + 60, se.y + se.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    const resized = await rectLabel(page);
    const width = (label: string): number => Number(/ancho (\d+) %/.exec(label)![1]);
    expect(width(resized)).toBeGreaterThan(width(moved));
  });

  test("H13 · cualquier asa con el teclado: las flechas mueven ESA esquina o borde y el foco se ve", async ({ page }) => {
    await openRegion(page);
    await page.locator("[data-region-rect]").scrollIntoViewIfNeeded();
    // Con la region mas alta (alto 18 %) caben las asas de los bordes laterales.
    for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Más alto" }).click();
    expect(await rectLabel(page)).toContain("izquierda 12 %, arriba 63 %, ancho 40 %, alto 18 %");
    const nw = page.locator('[data-region-handle="nw"]');
    await nw.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    expect(await rectLabel(page)).toContain("izquierda 11 %, arriba 62 %, ancho 41 %, alto 19 %");
    await page.locator('[data-region-handle="e"]').focus();
    await page.keyboard.press("Shift+ArrowRight");
    expect(await rectLabel(page)).toContain("izquierda 11 %, arriba 62 %, ancho 46 %, alto 19 %");
    await page.locator('[data-region-handle="s"]').focus();
    await page.keyboard.press("ArrowDown");
    expect(await rectLabel(page)).toContain("alto 20 %");
    await expect(page.locator("[data-extract-status]")).toContainText("Región: izquierda 11 %");
  });

  test("H13 · UN solo puntero: tocar un asa y luego tocar la pagina la coloca ahi (sin arrastrar)", async ({ page }) => {
    await openRegion(page);
    await page.evaluate(() => document.querySelector("[data-region-rect]")!.scrollIntoView({ block: "center" }));
    const se = page.locator('[data-region-handle="se"]');
    const seBox = (await se.boundingBox())!;
    // Un toque sin movimiento elige el asa...
    await page.mouse.click(seBox.x + seBox.width / 2, seBox.y + seBox.height / 2);
    await expect(se).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-extract-status]")).toContainText("Elegida: esquina inferior derecha");
    // ... y el siguiente toque en la pagina la coloca ahi: la region crece hacia ese punto.
    const frame = (await page.locator("[data-region-frame]").boundingBox())!;
    await page.mouse.click(frame.x + frame.width * 0.8, frame.y + frame.height * 0.9);
    await expect(se).toHaveAttribute("aria-pressed", "false");
    const label = await rectLabel(page);
    expect(Number(/ancho (\d+) %/.exec(label)![1])).toBeGreaterThanOrEqual(65);
    expect(Number(/alto (\d+) %/.exec(label)![1])).toBeGreaterThanOrEqual(23);
    expect(label).toContain("izquierda 12 %, arriba 66 %");
  });

  test("H13 · «Ajustar sin arrastrar»: ocho botones de 44 px mueven y cambian el ancho y el alto con un toque cada uno", async ({ page }) => {
    await openRegion(page);
    const group = page.locator("[data-region-nudge]");
    await group.scrollIntoViewIfNeeded();
    const buttons = group.locator("button");
    await expect(buttons).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      const box = (await buttons.nth(index).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.width).toBeGreaterThanOrEqual(43.5);
    }
    await page.getByRole("button", { name: "Mover a la derecha" }).click();
    await page.getByRole("button", { name: "Más ancho" }).click();
    await page.getByRole("button", { name: "Más alto" }).click();
    expect(await rectLabel(page)).toContain("izquierda 13 %, arriba 65 %, ancho 42 %, alto 14 %");
    await expect(page.locator("[data-extract-status]")).toContainText("Región: izquierda 13 %");
  });

  test("recorta la firma: PNG con transparencia, tinta azul, esquinas transparentes y tamano de 300 ppp; vista previa y descarga p01-region-01.png", async ({ page }) => {
    await openRegion(page);
    await page.locator("[data-region-rect]").focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-extract-status]")).toContainText("Recorte listo");
    const file = await downloadFile(page, () => page.locator("[data-region-download]").click());
    expect(file.filename).toBe("p01-region-01.png");
    const stats = await pngStats(file.bytes);
    // 180 pt de firma a 300 ppp = 750 px de tinta + margen: ni la pagina entera ni una miga.
    expect(stats.width).toBeGreaterThan(700);
    expect(stats.width).toBeLessThan(1100);
    expect(stats.height).toBeGreaterThan(100);
    expect(stats.height).toBeLessThan(260);
    expect(stats.corners).toEqual([0, 0, 0, 0]);
    expect(stats.transparent).toBeGreaterThan(0.6);
    expect(stats.opaque).toBeGreaterThan(0.005);
    const [r, , b] = stats.inkRgb!;
    expect(b).toBeGreaterThan(r + 40);
    // El resultado cuenta su tamano y una segunda descarga numera el archivo.
    await expect(page.getByText(`${stats.width} × ${stats.height} px`)).toBeVisible();
    const second = await downloadFile(page, () => page.locator("[data-region-download]").click());
    expect(second.filename).toBe("p01-region-02.png");
  });

  test("calidad alta (600 ppp) da una imagen mas grande que la normal; sin «Quitar el fondo» el PNG es opaco y de la region exacta", async ({ page }) => {
    await openRegion(page);
    await page.locator("[data-region-rect]").focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
    const normal = await pngStats((await downloadFile(page, () => page.locator("[data-region-download]").click())).bytes);
    await page.getByRole("radio", { name: "Alta (600 ppp)" }).check();
    // Cambiar un ajuste descarta la vista previa vieja (ya no es de lo que se ve).
    await expect(page.locator("[data-region-result]")).toHaveCount(0);
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
    const high = await pngStats((await downloadFile(page, () => page.locator("[data-region-download]").click())).bytes);
    expect(high.width).toBeGreaterThan(normal.width * 1.6);
    await page.getByText("Quitar el fondo", { exact: true }).click();
    await page.getByRole("radio", { name: "Normal (300 ppp)" }).check();
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
    const raw = await pngStats((await downloadFile(page, () => page.locator("[data-region-download]").click())).bytes);
    // 40 % de 612 pt y 12 % de 792 pt a 300 ppp.
    expect(Math.abs(raw.width - Math.round(0.4 * 612 * (300 / 72)))).toBeLessThanOrEqual(2);
    expect(Math.abs(raw.height - Math.round(0.12 * 792 * (300 / 72)))).toBeLessThanOrEqual(2);
    expect(raw.corners).toEqual([255, 255, 255, 255]);
  });

  test("una region sin tinta lo dice y no deja resultado", async ({ page }) => {
    await openRegion(page);
    await page.locator("[data-region-rect]").focus();
    for (let i = 0; i < 40; i += 1) await page.keyboard.press("ArrowUp");
    await page.locator("[data-region-crop]").click();
    await expect(page.getByText(/No encontramos tinta en esa región/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-region-result]")).toHaveCount(0);
  });

  test("guardar el recorte en Firmas guardadas: origin «extracted», documento de origen y tinta sobre transparencia", async ({ page }) => {
    await openRegion(page);
    await page.locator("[data-region-rect]").focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
    await page.locator("[data-region-save]").click();
    const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    // Lo ya limpio no se vuelve a procesar: no hay selector de color de tinta.
    await expect(sheet.getByRole("radio", { name: "Negro" })).toHaveCount(0);
    await sheet.locator("[data-extract-save-name]").fill("Marta Díaz");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
    const rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("extracted");
    expect(rows[0].sourceDocument).toBe("firma-real.pdf");
    expect(rows[0].signature!.corners.every((alpha) => alpha === 0)).toBe(true);
  });

  test("dos recortes: firma de un firmante nuevo y, con «Recortar otra», sus iniciales -> UNA entrada con ambas", async ({ page }) => {
    await openRegion(page);
    const rect = page.locator("[data-region-rect]");
    await rect.focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
    await page.locator("[data-region-save]").click();
    const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await sheet.locator("[data-extract-save-name]").fill("Marta Díaz");
    await sheet.getByLabel("Cargo (opcional)").fill("Perito");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
    // «Recortar otra»: la hoja se cierra, el recorte guardado se descarta y el foco vuelve al rectangulo.
    await sheet.getByRole("button", { name: "Recortar otra" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator("[data-region-result]")).toHaveCount(0);
    await expect(rect).toBeFocused();
    // Segundo recorte (la misma tinta sirve de «iniciales» de prueba) para el MISMO firmante.
    await page.locator("[data-region-crop]").click();
    await expect(page.locator("[data-region-preview]")).toBeVisible({ timeout: 60_000 });
    await page.locator("[data-region-save]").click();
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole("radio", { name: "Iniciales", exact: true }).check();
    await sheet.getByRole("radio", { name: /^Marta Díaz · Perito/ }).check();
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Iniciales añadidas a Marta Díaz");
    const rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].signatureHash).not.toBeNull();
    expect(rows[0].initialsHash).not.toBeNull();
    expect(rows[0].role).toBe("Perito");
    expect(rows[0].origin).toBe("extracted");
  });

  test("tocar la pagina coloca el rectangulo; cambiar de pestana y volver conserva la pagina y el rectangulo", async ({ page }) => {
    await openRegion(page);
    const frame = (await page.locator("[data-region-frame]").boundingBox())!;
    await page.locator("[data-region-frame]").click({ position: { x: frame.width * 0.5, y: frame.height * 0.3 } });
    const label = await rectLabel(page);
    expect(label).toContain("izquierda 30 %");
    expect(label).toContain("arriba 24 %");
    await page.getByRole("tab", { name: "Elementos" }).click();
    await page.getByRole("tab", { name: "Recortar región" }).click();
    expect(await rectLabel(page)).toBe(label);
  });

});
