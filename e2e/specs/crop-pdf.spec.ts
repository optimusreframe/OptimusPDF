import type { Locator, Page } from "@playwright/test";
import { expect, openTool, runAndDownload, runButton, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageSize } from "../helpers/pdf-inspection";
import { readPages } from "../helpers/pdf-structure";
import { makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Recortar PDF (W6-D): se arrastran los tiradores de verdad (raton y dedo) y se
 * comprueba el CropBox resultante (proporcional a cada pagina, MediaBox
 * intacta), el alcance «solo la pagina visible» y las paginas rotadas.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(90_000);

type Rect = { x: number; y: number; width: number; height: number };

const selection = (page: Page) => page.getByRole("group", { name: "Área que se conserva" });
const handle = (page: Page, mode: string) => page.locator(`[data-drag-mode="${mode}"]`).first();

/** Seleccion actual leida de los porcentajes del recuadro (fraccion 0..1 de la pagina mostrada). */
async function readRect(group: Locator): Promise<Rect> {
  return group.evaluate((element) => {
    const style = (element as HTMLElement).style;
    const fraction = (value: string) => parseFloat(value) / 100;
    return {
      x: fraction(style.left),
      y: fraction(style.top),
      width: fraction(style.width),
      height: fraction(style.height),
    };
  });
}

/** Al centro de la ventana: en movil las barras fijas de abajo tapan lo que solo esta «dentro» del viewport. */
async function centerInViewport(locator: Locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
}

async function drag(page: Page, from: Locator, dx: number, dy: number) {
  await centerInViewport(from);
  const box = await from.boundingBox();
  if (!box) throw new Error("el tirador no tiene caja");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function waitForPreview(page: Page) {
  await expect(selection(page)).toBeVisible();
  await expect(page.getByRole("img", { name: "Área que se conserva" })).toBeVisible();
}

test.describe("crop-pdf", () => {
  test("recorte por defecto en 3 paginas de tamanos distintos: CropBox proporcional y MediaBox intacta", async ({ page }) => {
    await openTool(page, "crop-pdf");
    const sizes: Array<[number, number]> = [[300, 400], [500, 300], [200, 200]];
    await uploadFiles(page, pdfUpload("Plano (v2).pdf", await makePdf({ pages: 3, label: "CR", size: (index) => sizes[index] })));
    await waitForPreview(page);
    await expect(page.getByText("Selección 88 × 88 %")).toBeVisible();

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Plano (v2)-recortado.pdf");
    const pages = await readPages(bytes);
    expect(pages).toHaveLength(3);
    for (const [index, [w, h]] of sizes.entries()) {
      const { mediaBox, cropBox } = pages[index];
      expect(mediaBox).toMatchObject({ x: 0, y: 0, width: w, height: h });
      expect(cropBox.x).toBeCloseTo(w * 0.06, 1);
      expect(cropBox.y).toBeCloseTo(h * 0.06, 1);
      expect(cropBox.width).toBeCloseTo(w * 0.88, 1);
      expect(cropBox.height).toBeCloseTo(h * 0.88, 1);
      const view = await getPageSize(bytes, index + 1);
      expect(view.width).toBeCloseTo(w * 0.88, 1);
    }
  });

  test("arrastrar tiradores: la esquina inferior derecha y la superior izquierda se mueven y el CropBox lo refleja", async ({ page }) => {
    await openTool(page, "crop-pdf");
    await uploadFiles(page, pdfUpload("t.pdf", await makePdf({ pages: 2, label: "TR", size: [400, 600] })));
    await waitForPreview(page);
    const before = await readRect(selection(page));

    await drag(page, handle(page, "se"), -120, -100);
    await drag(page, handle(page, "nw"), 60, 80);
    const after = await readRect(selection(page));
    expect(after.width).toBeLessThan(before.width - 0.05);
    expect(after.height).toBeLessThan(before.height - 0.05);
    await expect(page.getByText(`Selección ${Math.round(after.width * 100)} × ${Math.round(after.height * 100)} %`)).toBeVisible();

    const { bytes } = await runAndDownload(page);
    for (const n of [0, 1]) {
      const { cropBox, mediaBox } = (await readPages(bytes))[n];
      expect(cropBox.width).toBeCloseTo(after.width * 400, 0);
      expect(cropBox.height).toBeCloseTo(after.height * 600, 0);
      expect(cropBox.x).toBeCloseTo(after.x * 400, 0);
      // El origen de la seleccion es arriba-izquierda; el del PDF, abajo-izquierda.
      expect(cropBox.y).toBeCloseTo((1 - after.y - after.height) * 600, 0);
      expect(mediaBox).toMatchObject({ width: 400, height: 600 });
    }
  });

  test("«Solo la pagina visible» (pagina 2 de 3): unicamente esa pagina cambia de CropBox", async ({ page }) => {
    await openTool(page, "crop-pdf");
    await uploadFiles(page, pdfUpload("solo.pdf", await makePdf({ pages: 3, label: "SO", size: [300, 400] })));
    await waitForPreview(page);
    await page.getByRole("tab", { name: "Solo la página visible" }).click();
    await page.getByRole("button", { name: "Página siguiente" }).click();
    await expect(page.getByText("Página 2 de 3")).toBeVisible();
    await waitForPreview(page);
    await drag(page, handle(page, "se"), -80, -80);

    const { bytes } = await runAndDownload(page);
    const pages = await readPages(bytes);
    const full = (index: number) => pages[index].cropBox.width === 300 && pages[index].cropBox.height === 400;
    expect([full(0), full(1), full(2)]).toEqual([true, false, true]);
    expect(pages[1].cropBox.width).toBeLessThan(300 * 0.88);
  });

  test("«Restablecer selección» devuelve el recuadro al 88 × 88 %", async ({ page }) => {
    await openTool(page, "crop-pdf");
    await uploadFiles(page, pdfUpload("r.pdf", await makePdf({ pages: 1, size: [300, 400] })));
    await waitForPreview(page);
    await drag(page, handle(page, "se"), -150, -150);
    await expect(page.getByText("Selección 88 × 88 %")).toBeHidden();
    await page.getByRole("button", { name: "Restablecer selección" }).click();
    await expect(page.getByText("Selección 88 × 88 %")).toBeVisible();
    await expect(runButton(page)).toBeEnabled();
  });

  test("32 paginas con una rotada 90° y nombre con acentos: todas quedan recortadas en la misma proporcion", async ({ page }) => {
    await openTool(page, "crop-pdf");
    await uploadFiles(
      page,
      pdfUpload("Álbum (copia) ñ.pdf", await makePdf({ pages: 32, label: "AL", size: [300, 400], rotate: (index) => (index === 1 ? 90 : 0) })),
    );
    await waitForPreview(page);
    const { bytes, filename } = await runAndDownload(page, { timeout: 90_000 });
    expect(filename).toBe("Álbum (copia) ñ-recortado.pdf");
    expect(await getPageCount(bytes)).toBe(32);
    // La pagina vertical se ve 264 x 352; la rotada, apaisada, 352 x 264 (mismo 88 % del area visible).
    const first = await getPageSize(bytes, 1);
    const rotated = await getPageSize(bytes, 2);
    expect([first.width, first.height].map(Math.round)).toEqual([264, 352]);
    expect([rotated.width, rotated.height].map(Math.round)).toEqual([352, 264]);
    expect((await readPages(bytes))[1].rotation).toBe(90);
  });
});

test.describe("crop-pdf · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("el recuadro se ajusta con el dedo (pointer events tactiles) y se descarga el recorte", async ({ page }) => {
    await openTool(page, "crop-pdf");
    await uploadFiles(page, pdfUpload("movil.pdf", await makePdf({ pages: 1, label: "MV", size: [300, 400] })));
    await waitForPreview(page);
    const before = await readRect(selection(page));
    // Zona de toque de 44 px aunque el tirador mida 20: un punto a 20 px de su centro sigue siendo del tirador.
    await centerInViewport(handle(page, "se"));
    const hit = await handle(page, "se").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.x + box.width / 2 - 20;
      const y = box.y + box.height / 2 - 20;
      const found = document.elementFromPoint(x, y);
      return { size: Math.round(box.width), isHandle: found === element };
    });
    expect(hit).toEqual({ size: 20, isHandle: true });
    // Gesto tactil real por CDP sobre el tirador sureste.
    await centerInViewport(handle(page, "se"));
    const box = await handle(page, "se").boundingBox();
    if (!box) throw new Error("sin tirador");
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 40, y: y - 60 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 80, y: y - 120 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await readRect(selection(page))).width).toBeLessThan(before.width - 0.05);
    const after = await readRect(selection(page));

    const { bytes } = await runAndDownload(page);
    const { cropBox } = (await readPages(bytes))[0];
    expect(cropBox.width).toBeCloseTo(after.width * 300, 0);
    expect(cropBox.height).toBeCloseTo(after.height * 400, 0);
  });
});
