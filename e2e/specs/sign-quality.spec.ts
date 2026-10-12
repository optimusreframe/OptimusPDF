import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  makeFormPdf,
  makeImageOnlyPdf,
  makeLongReportPdf,
  makePresentationPdf,
  makeReceiptPdf,
  makeSmallTextPdf,
  makeTablePdf,
} from "../../src/lib/pdf/testing/signSyntheticPdfs";
import { downloadBytes } from "../helpers/downloads";
import { compareImages, crop, decodePngGray } from "../helpers/image-metrics";
import { renderNativeReference } from "../helpers/native-reference";
import { getPageOperatorCounts, getPageText } from "../helpers/pdf-inspection";

/**
 * Firmar: calidad de render, deteccion de campos conservadora y edicion del
 * texto original (W6-A). Headless siempre (modo por defecto de Playwright).
 *
 *  - Nitidez: la hoja se compara, pixel a pixel (SSIM y energia de gradiente),
 *    con el pdf.js NATIVO del mismo navegador a DPR 1 y 2, y al acercar.
 *  - Campos: recibo, presentacion con degradado, tabla 20x4, pagina solo-imagen
 *    e informe de 16 paginas NO sugieren «Field N»; un formulario real si.
 *  - Editar texto: se edita un texto original, se coloca una firma y se
 *    descarga; con pdf.js se comprueba que el PDF final lleva el texto
 *    editado y la firma.
 */

test.setTimeout(120_000);
test.use({ locale: "es-ES", bypassCSP: true });

const FILE_INPUT = 'input[type="file"][accept*="pdf"]';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function upload(page: Page, name: string, bytes: Uint8Array | Buffer) {
  await page.goto("/sign-pdf");
  await page
    .locator(FILE_INPUT)
    .first()
    .setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.from(bytes) });
  await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
}

/** Espera a que la imagen definitiva (la nitida) este puesta y asentada. */
async function settleImage(page: Page, zoom = 1): Promise<{ natural: number; css: number }> {
  const image = page.locator('img[alt]:not([alt=""])').first();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  let last = { natural: 0, css: 0 };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await image.evaluate((el: HTMLImageElement) => ({ natural: el.naturalWidth, css: el.clientWidth }));
    // Con un tope de memoria (zoom alto) el bitmap no llega al pedido: basta con superar el de zoom 1.
    if (last.natural >= last.css * dpr * zoom * 0.9) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  return last;
}

async function suggestionState(page: Page) {
  const toggle = page.getByRole("switch");
  return {
    toggle: (await toggle.count()) > 0 ? await toggle.first().innerText() : null,
    checked: (await toggle.count()) > 0 ? await toggle.first().getAttribute("aria-checked") : null,
    boxes: await page.locator("[data-suggested]").count(),
    genericLabels: await page.getByText(/^(Campo|Field) \d+$/).count(),
  };
}

/** `true` si el lienzo de dibujo ya tiene algun pixel de tinta (oscuro): el trazo llego al lienzo. */
async function canvasHasInk(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    if (!context) return false;
    const { data } = context.getImageData(0, 0, (element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height);
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 160) return true;
    return false;
  });
}

async function drawSignature(page: Page) {
  const dialog = page.getByRole("dialog");
  const canvas = dialog.locator("canvas");
  // La hoja entra con un muelle: con CPU lenta (runner de CI) un trazo hecho mientras aun se mueve cae FUERA del lienzo
  // (el arrastre selecciona texto y «Usar esta firma» avisa de que no hay nada). Se espera a que la caja no cambie en
  // varias lecturas seguidas y, si aun asi no hubo tinta, se vuelve a dibujar.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let box = await canvas.boundingBox();
    let same = 0;
    for (let read = 0; read < 60 && same < 3; read += 1) {
      await page.waitForTimeout(100);
      const next = await canvas.boundingBox();
      same = box && next && next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height ? same + 1 : 0;
      box = next;
    }
    if (!box) throw new Error("no se encontro el lienzo de firma");
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 8 });
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    if (await canvasHasInk(canvas)) break;
  }
  expect(await canvasHasInk(canvas), "el trazo debe dejar tinta en el lienzo antes de guardar").toBe(true);
  await dialog.getByRole("button", { name: "Usar esta firma" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/* ------------------------------------------------------------------ *
 * 1. Nitidez frente a pdf.js nativo
 * ------------------------------------------------------------------ */

for (const dpr of [1, 2]) {
  test.describe(`nitidez a DPR ${dpr} (1280x800)`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });

    test("la hoja es tan nitida como el render nativo de pdf.js (no un JPEG estirado)", async ({ page }) => {
      const errors = trackErrors(page);
      const bytes = await makeSmallTextPdf();
      await upload(page, "texto-pequeno.pdf", bytes);
      const meta = await settleImage(page);
      const image = page.locator('img[alt]:not([alt=""])').first();

      // El bitmap tiene los pixeles que se ven (ancho x DPR), no 595 ni 900 fijos.
      expect(meta.natural).toBeGreaterThanOrEqual(Math.floor(meta.css * dpr * 0.98));
      expect(await image.getAttribute("src")).toMatch(/^blob:/);

      await image.scrollIntoViewIfNeeded();

      // (1) El BITMAP que pone la aplicacion (lo que de verdad decide la nitidez) frente al pdf.js nativo del mismo
      // navegador a su mismo tamano en pixeles: mismo motor y mismas opciones, asi que ha de ser identico. No depende
      // del compositor (posicion fraccionaria, barra de desplazamiento clasica de Linux). En macOS sale SSIM 1, dif. 0.
      const natural = await decodePngGray(
        Buffer.from(
          await image.evaluate(async (el: HTMLImageElement) => {
            const blob = await (await fetch(el.src)).blob();
            const url = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.readAsDataURL(blob);
            });
            return url.split(",")[1];
          }),
          "base64",
        ),
      );
      const nativeReference = await renderNativeReference(page, bytes, 1, natural.width);
      const nh = Math.min(natural.height, nativeReference.height);
      const ny0 = Math.round(nh * 0.04);
      const nhh = Math.round(nh * 0.5);
      const bitmap = compareImages(crop(natural, 0, ny0, natural.width, nhh), crop(nativeReference, 0, ny0, nativeReference.width, nhh), {
        margin: 10,
        maxShift: 2,
      });
      expect(bitmap.ssim, `bitmap: ${JSON.stringify(bitmap)}`).toBeGreaterThan(0.999);
      expect(bitmap.meanAbsDiff).toBeLessThan(0.5);
      expect(bitmap.sharpnessRatio).toBeGreaterThan(0.98);

      // (2) Lo que se VE (captura de la hoja ya compuesta). Depende de la plataforma (en el runner Linux sale
      // SSIM 0,989 a DPR 1 y dif. media 1,48 a DPR 2; causa probable: remuestreo del compositor / barra de
      // desplazamiento clasica de Linux sobre la hoja, no reproducible en macOS), asi que el umbral se fija MEDIDO con controles negativos (en macOS):
      // desplazar 0,25 px da SSIM 0,962 (DPR 1) / 0,979 (DPR 2) y dif. 4,7 / 3,9; reescalar a 0,75, medio tamano o
      // un JPEG de 900 px estirado dan SSIM 0,85-0,95, dif. >= 5,2 y nitidez 0,37-0,64. Se exige lo que ningun
      // control cumple y el runner si: SSIM > 0,98, dif. < 2,5 y nitidez > 0,9 (CI: 0,989 / 1,48).
      const shot = await decodePngGray(await image.screenshot({ type: "png" }));
      const reference = await renderNativeReference(page, bytes, 1, shot.width);
      const h = Math.min(shot.height, reference.height);
      const y0 = Math.round(h * 0.04);
      const hh = Math.round(h * 0.5);
      const result = compareImages(crop(shot, 0, y0, shot.width, hh), crop(reference, 0, y0, reference.width, hh), {
        margin: 10,
        maxShift: 2,
      });
      expect(result.ssim, `captura: ${JSON.stringify(result)}`).toBeGreaterThan(0.98);
      expect(result.meanAbsDiff).toBeLessThan(2.5);
      expect(result.sharpnessRatio).toBeGreaterThan(0.9);
      expect(errors).toEqual([]);
    });

    test("al acercar (x3) vuelve a dibujar a mayor resolucion: sigue nitido", async ({ page }) => {
      await upload(page, "texto-pequeno.pdf", await makeSmallTextPdf());
      const before = await settleImage(page);
      const zoomIn = page.getByRole("button", { name: "Acercar" });
      await zoomIn.click();
      await zoomIn.click();
      await zoomIn.click();
      await expect(page.getByRole("button", { name: "Restablecer zoom" })).toHaveText("300 %");
      const after = await settleImage(page, 3);
      // Mas pixeles que a zoom 1 (con tope de memoria, pero claramente mas que antes).
      expect(after.natural).toBeGreaterThan(before.natural * 1.8);
      expect(after.natural).toBeLessThanOrEqual(4096);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 2. Campos sugeridos conservadores
 * ------------------------------------------------------------------ */

test.describe("campos sugeridos (1280x800)", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  const documents: Array<[string, () => Promise<Uint8Array>]> = [
    ["recibo.pdf", makeReceiptPdf],
    ["presentacion.pdf", makePresentationPdf],
    ["tabla.pdf", () => makeTablePdf(20)],
    ["informe-16p.pdf", () => makeLongReportPdf(16)],
  ];

  for (const [name, make] of documents) {
    test(`${name}: ni un campo sugerido ni «Field N» (antes decenas)`, async ({ page }) => {
      const errors = trackErrors(page);
      await upload(page, name, await make());
      await page.waitForTimeout(2500);
      const state = await suggestionState(page);
      expect(state.toggle).toBeNull();
      expect(state.boxes).toBe(0);
      expect(state.genericLabels).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test("pagina solo-imagen: 0 sugerencias; la busqueda en escaneadas es una accion explicita", async ({ page }) => {
    await upload(page, "solo-imagen.pdf", await makeImageOnlyPdf());
    await page.waitForTimeout(2500);
    const state = await suggestionState(page);
    expect(state.boxes).toBe(0);
    expect(state.genericLabels).toBe(0);
    // No corre sola: solo se ofrece el boton.
    const scan = page.getByRole("button", { name: "Buscar huecos en páginas escaneadas" });
    await expect(scan).toBeVisible();
    await scan.click();
    // Lo hallado (o «no se encontraron») se anuncia y entra como sugerencia, sin «Field N».
    await expect(page.getByText(/Se encontr(ó|aron) \d+ posibles? huecos?|No se encontraron huecos/).first()).toBeAttached({
      timeout: 30_000,
    });
    expect((await suggestionState(page)).genericLabels).toBe(0);
  });

  test("formulario real: interruptor «Campos sugeridos (N)» apagado con mas de 8; encendido pinta los huecos y las etiquetas reales", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const { bytes, genuine } = await makeFormPdf();
    await upload(page, "formulario.pdf", bytes);
    const toggle = page.getByRole("switch");
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    const text = await toggle.innerText();
    const count = Number(/\((\d+)\)/.exec(text)?.[1]);
    expect(count).toBeGreaterThanOrEqual(Math.ceil(genuine * 0.9));
    expect(count).toBeLessThanOrEqual(genuine);
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(await page.locator("[data-suggested]").count()).toBe(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await page.locator("[data-suggested]").count()).toBe(count);
    // Las etiquetas son las del documento («Nombre:»), nunca «Campo N».
    await expect(page.getByText("Nombre:", { exact: true }).first()).toBeAttached();
    expect((await suggestionState(page)).genericLabels).toBe(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await page.locator("[data-suggested]").count()).toBe(0);
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Editar texto original + firmar + descargar
 * ------------------------------------------------------------------ */

const EDITED_TITLE = "Recibo editado por Optimus";

async function editFirstTitle(page: Page, touch: boolean) {
  await page.getByRole("button", { name: "Editar texto" }).click();
  const title: Locator = page.locator('[data-block-layer] [aria-label*="Receipt from"]').first();
  await title.waitFor({ timeout: 20_000 });
  if (touch) {
    // Con el dedo: un toque selecciona y el siguiente edita.
    await title.tap();
    await title.tap();
  } else {
    await title.dblclick();
  }
  const editor = page.locator("[data-inline-editor]");
  await expect(editor).toBeVisible();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(EDITED_TITLE);
  await expect(editor).toContainText(EDITED_TITLE);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
}

async function signEditedReceipt(page: Page, touch: boolean) {
  const errors = trackErrors(page);
  await upload(page, "recibo.pdf", await makeReceiptPdf());
  await page.getByRole("button", { name: "Crear firma" }).first().click();
  await drawSignature(page);
  // La firma recien creada se coloca sola en la pagina visible.
  await expect(page.getByRole("group", { name: /firma colocada/i }).first()).toBeVisible({ timeout: 15_000 });

  await editFirstTitle(page, touch);
  // Vuelve a Seleccionar: lo editado sigue pintado y los controles de firma vuelven a responder.
  await page.getByRole("button", { name: "Seleccionar" }).click();
  await expect(page.locator("[data-edit-text-layer]").first()).toHaveAttribute("inert", "");
  await expect(page.locator('[data-text-view]').first()).toContainText(EDITED_TITLE);
  await expect(page.locator("[data-edit-text-panel]")).toContainText("1 texto editado");

  await page.getByRole("button", { name: "Procesar" }).click();
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Descargar" }).click();
  });

  const text = await getPageText(bytes, 1);
  expect(text).toContain(EDITED_TITLE);
  const counts = await getPageOperatorCounts(bytes, 1);
  expect(counts.imagePaintOps).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
}

test.describe("editar el texto original y firmar", () => {
  test.describe("escritorio 1280x800", () => {
    test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true });

    test("se edita un texto del PDF, se coloca la firma y el PDF final lleva ambos", async ({ page }) => {
      await signEditedReceipt(page, false);
    });

    test("Editar texto convive con los atajos: E activa, Esc vuelve; sin desbordes", async ({ page }) => {
      await upload(page, "recibo.pdf", await makeReceiptPdf());
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("e");
      await expect(page.getByRole("button", { name: "Editar texto" })).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Editar texto" })).toHaveAttribute("aria-pressed", "false");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });

  test.describe("movil tactil 375x812", () => {
    test.use({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      acceptDownloads: true,
    });

    test("en el movil se edita con toques, se firma y se descarga sin desbordes", async ({ page }) => {
      await signEditedReceipt(page, true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test("los controles nuevos miden al menos 44 px y la hoja es nitida a DPR 3", async ({ page }) => {
      await upload(page, "formulario.pdf", (await makeFormPdf()).bytes);
      const toggle = page.getByRole("switch");
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      const tool = page.getByRole("button", { name: "Editar texto" });
      expect((await tool.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      const meta = await settleImage(page);
      expect(meta.natural).toBeGreaterThanOrEqual(Math.floor(meta.css * 3 * 0.98));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});

test.describe("detalles de la segunda ronda", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });

  test("una edicion SIN firma descarga «-editado.pdf» (no «-firmado»)", async ({ page }) => {
    const errors = trackErrors(page);
    await upload(page, "recibo.pdf", await makeReceiptPdf());
    await editFirstTitle(page, false);
    await page.getByRole("button", { name: "Seleccionar" }).click();
    await page.getByRole("button", { name: "Procesar" }).click();
    await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Descargar" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("recibo-editado.pdf");
    expect(errors).toEqual([]);
  });

  test("«Exportar configuración» (Varios firmantes) avisa de que las ediciones de texto no se incluyen", async ({ page }) => {
    await upload(page, "recibo.pdf", await makeReceiptPdf());
    await page.getByRole("tab", { name: "Varios firmantes" }).click();
    await page.getByRole("button", { name: "2. Documento" }).click();
    const notice = page.locator("[data-export-edits-notice]");
    await expect(notice).toHaveText("");
    await editFirstTitle(page, false);
    await expect(notice).toContainText("no se incluyen en la configuración");
  });
});

test.describe("colores forzados", () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });

  test("el interruptor «Campos sugeridos» distingue encendido y apagado (Highlight / ButtonFace, pulgar a un lado u otro)", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await upload(page, "formulario.pdf", (await makeFormPdf()).bytes);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const toggle = page.getByRole("switch");
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    const read = () =>
      toggle.evaluate((el) => {
        const thumb = el.querySelector("[data-switch-thumb]") as HTMLElement;
        const track = el.querySelector("[data-switch-track]") as HTMLElement;
        return {
          background: getComputedStyle(el).backgroundColor,
          color: getComputedStyle(el).color,
          thumbLeft: thumb.getBoundingClientRect().left - track.getBoundingClientRect().left,
          trackBorder: getComputedStyle(track).borderTopWidth,
          trackColor: getComputedStyle(track).borderTopColor,
          thumbFill: getComputedStyle(thumb).backgroundColor,
        };
      });
    await page.waitForTimeout(450);
    const off = await read();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    // Las transiciones de color y del pulgar duran ~200 ms: se lee el estado ya asentado.
    await page.waitForTimeout(450);
    const on = await read();
    expect(on.background).not.toBe(off.background);
    expect(on.thumbLeft).toBeGreaterThan(off.thumbLeft + 6);
    // La pista tiene borde y el pulgar es visible (no transparente) en ambos estados.
    expect(parseFloat(on.trackBorder)).toBeGreaterThan(0);
    expect(parseFloat(off.trackBorder)).toBeGreaterThan(0);
    // El pulgar NO se confunde con el fondo del boton en ningun estado (se vacia a Canvas con colores no-sistema).
    expect(on.thumbFill).not.toBe(on.background);
    expect(off.thumbFill).not.toBe(off.background);
  });
});
