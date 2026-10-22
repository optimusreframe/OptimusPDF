import type { Locator, Page } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, openTool, runButton, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { imagePlacements } from "../helpers/pdf-placements";
import { embeddedImages, makePhotoSet, removePhotoSet, type PhotoSet } from "../helpers/photo-set";
import { GRID_GUTTER, MARGIN_POINTS, SHEET_POINTS, layoutPhotoGrid, type PhotosPerPage, type Rect } from "../../src/lib/pdf/photoGrid";

/**
 * Imagenes a PDF · «Fotos por pagina» (1, 2, 4, 6, 8 y 10), navegador real y headless (Chromium y WebKit/iPad).
 *
 * Genera los PDF de verdad y lee con pdf.js DONDE quedo cada imagen en cada hoja (matriz de transformacion de cada
 * `paintImageXObject`): todas caben dentro de la hoja, ninguna se solapa, conservan su proporcion, las columnas son
 * simetricas, y las posiciones coinciden con la composicion pura (`photoGrid.ts`). Ademas, la vista previa de hojas
 * (miniaturas + «N hojas en total» + descripcion textual) y los avisos de los controles.
 */

test.use({ locale: "es-ES" });

/** 13 fotos mezcladas (vertical, horizontal, panoramica, cuadrada) con orientacion EXIF mezclada: 13 no completa ninguna hoja. */
const SHAPES: Array<[number, number]> = [
  [3000, 2250],
  [2250, 3000],
  [4500, 1500],
  [2400, 2400],
];
let set: PhotoSet;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  set = await makePhotoSet({ name: "grid", count: 13, size: (index) => ({ width: SHAPES[index % 4][0], height: SHAPES[index % 4][1] }), distinct: 4 });
});
test.afterAll(() => removePhotoSet(set));

/** Proporcion (ancho/alto) con que se VE cada foto, con su orientacion EXIF aplicada. */
function displayRatio(index: number): number {
  const { width, height, orientation } = set.specs[index];
  return orientation >= 5 ? height / width : width / height;
}

async function open(page: Page, count = 13): Promise<void> {
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(set.paths.slice(0, count));
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
}

function perPageTab(page: Page, value: number): Locator {
  return page.getByRole("tablist", { name: "Fotos por página" }).getByRole("tab", { name: String(value), exact: true });
}

async function choose(page: Page, tablist: string, tab: string): Promise<void> {
  await page.getByRole("tablist", { name: tablist }).getByRole("tab", { name: tab, exact: true }).click();
}

type Options = { perPage: PhotosPerPage; pageSize?: "A4" | "Carta"; orientation?: "Vertical" | "Horizontal" | "Automática"; margin?: "Sin margen" | "Pequeño" | "Grande"; quality?: string };

async function configure(page: Page, options: Options): Promise<void> {
  await choose(page, "Calidad de imagen", options.quality ?? "Compacta");
  await perPageTab(page, options.perPage).click();
  if (options.pageSize) await choose(page, "Tamaño de página", options.pageSize);
  if (options.orientation) await choose(page, "Orientación", options.orientation);
  if (options.margin) await choose(page, "Margen", options.margin);
}

async function generate(page: Page): Promise<Buffer> {
  await runButton(page).click();
  const download = page.getByRole("button", { name: "Descargar", exact: true });
  await expect(download).toBeVisible({ timeout: 120_000 });
  const { bytes } = await downloadFile(page, () => download.click());
  return bytes;
}

/** Colocacion REAL de cada imagen (pdf.js), en puntos con el origen abajo-izquierda, y el tamano de cada hoja. */
async function readPlacements(bytes: Buffer): Promise<{ sheets: Array<{ width: number; height: number; images: Rect[] }> }> {
  const document = await PDFDocument.load(bytes);
  const placements = await imagePlacements(bytes);
  const sheets = Array.from({ length: document.getPageCount() }, (_, index) => {
    const { width, height } = document.getPage(index).getSize();
    const images: Rect[] = placements
      .filter((placed) => placed.page === index)
      .map((placed) => ({
        x: placed.x * width,
        y: height - (placed.y + placed.height) * height,
        width: placed.width * width,
        height: placed.height * height,
      }));
    return { width, height, images };
  });
  return { sheets };
}

const TOL = 1.5;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width - 0.01 && b.x < a.x + a.width - 0.01 && a.y < b.y + b.height - 0.01 && b.y < a.y + a.height - 0.01;
}

/** Comprobaciones independientes de la composicion pura: caben, no se solapan, conservan la proporcion. */
function checkSheets(sheets: Array<{ width: number; height: number; images: Rect[] }>, perPage: number, count: number, margin: number): void {
  expect(sheets).toHaveLength(Math.ceil(count / perPage));
  let seen = 0;
  sheets.forEach((sheet, sheetIndex) => {
    const expectedHere = Math.min(perPage, count - sheetIndex * perPage);
    expect(sheet.images, `hoja ${sheetIndex + 1}: fotos`).toHaveLength(expectedHere);
    sheet.images.forEach((rect, k) => {
      expect(rect.x, `hoja ${sheetIndex + 1} foto ${k + 1} dentro (izq)`).toBeGreaterThanOrEqual(margin - TOL);
      expect(rect.y, `hoja ${sheetIndex + 1} foto ${k + 1} dentro (abajo)`).toBeGreaterThanOrEqual(margin - TOL);
      expect(rect.x + rect.width, `hoja ${sheetIndex + 1} foto ${k + 1} dentro (der)`).toBeLessThanOrEqual(sheet.width - margin + TOL);
      expect(rect.y + rect.height, `hoja ${sheetIndex + 1} foto ${k + 1} dentro (arriba)`).toBeLessThanOrEqual(sheet.height - margin + TOL);
      // Proporcion de la foto original (con su orientacion EXIF), sin deformar ni recortar.
      expect(rect.width / rect.height, `hoja ${sheetIndex + 1} foto ${k + 1} proporcion`).toBeCloseTo(displayRatio(seen + k), 1);
      sheet.images.forEach((other, j) => {
        if (j > k) expect(overlaps(rect, other), `hoja ${sheetIndex + 1}: fotos ${k + 1} y ${j + 1} no se solapan`).toBe(false);
      });
    });
    seen += expectedHere;
  });
}

/** Lo que dice el modulo puro para ESTAS fotos (sus proporciones vistas) y la misma configuracion. */
function expectedSheets(perPage: PhotosPerPage, options: Options, count = 13) {
  const pageSize = SHEET_POINTS[options.pageSize === "Carta" ? "letter" : "a4"];
  const margin = MARGIN_POINTS[options.margin === "Grande" ? "large" : options.margin === "Pequeño" ? "small" : "none"];
  const photos = Array.from({ length: count }, (_, index) => ({ width: displayRatio(index) * 1000, height: 1000 }));
  return layoutPhotoGrid(photos, {
    perPage,
    pageSize,
    orientation: options.orientation === "Horizontal" ? "landscape" : "portrait",
    margin,
  });
}

const MATRIX: Options[] = [
  { perPage: 1, margin: "Pequeño" },
  { perPage: 2, margin: "Pequeño" },
  { perPage: 4, margin: "Pequeño" },
  { perPage: 6, margin: "Pequeño" },
  { perPage: 8, margin: "Pequeño" },
  { perPage: 10, margin: "Pequeño" },
  { perPage: 4, pageSize: "Carta", margin: "Grande" },
  { perPage: 6, orientation: "Horizontal", margin: "Sin margen" },
  { perPage: 2, orientation: "Horizontal", pageSize: "Carta", margin: "Pequeño" },
  { perPage: 10, orientation: "Horizontal", margin: "Grande" },
];

for (const options of MATRIX) {
  const label = `${options.perPage} por hoja · ${options.pageSize ?? "A4"} · ${options.orientation ?? "Automática"} · margen ${options.margin ?? "Sin margen"}`;
  test(`13 fotos, ${label}: cada foto en su sitio dentro de la hoja (pdf.js)`, async ({ page }) => {
    test.setTimeout(180_000);
    await open(page);
    await configure(page, options);
    const bytes = await generate(page);
    const { sheets } = await readPlacements(bytes);
    const margin = MARGIN_POINTS[options.margin === "Grande" ? "large" : options.margin === "Pequeño" ? "small" : "none"];
    checkSheets(sheets, options.perPage, 13, margin);

    // Hoja vertical salvo «Horizontal»; y las posiciones reales son las de la composicion pura.
    const expected = expectedSheets(options.perPage, options);
    // Una foto por hoja y «Automática»: cada pagina toma la orientacion de su foto (ruta de siempre), no la de la cuadricula.
    const perPhotoOrientation = options.perPage === 1 && !options.orientation;
    sheets.forEach((sheet, index) => {
      if (perPhotoOrientation) return;
      // Con una foto por hoja y «Automática» cada pagina sigue a su foto; con varias, «Automática» es vertical.
      if (options.perPage > 1 || options.orientation) expect(sheet.width < sheet.height, `hoja ${index + 1} vertical`).toBe(options.orientation !== "Horizontal");
      expect(sheet.width).toBeCloseTo(expected[index].pageWidth, 1);
      sheet.images.forEach((rect, k) => {
        const want = expected[index].photos[k].rect;
        expect(rect.x, `hoja ${index + 1} foto ${k + 1} x`).toBeCloseTo(want.x, 0);
        expect(rect.y, `hoja ${index + 1} foto ${k + 1} y`).toBeCloseTo(want.y, 0);
        expect(Math.abs(rect.width - want.width), `hoja ${index + 1} foto ${k + 1} ancho`).toBeLessThan(TOL);
        expect(Math.abs(rect.height - want.height), `hoja ${index + 1} foto ${k + 1} alto`).toBeLessThan(TOL);
      });
    });

    if (options.perPage >= 4) {
      // Simetria respecto al eje vertical: en cada fila completa las dos fotos estan a la misma distancia del eje (con la
      // misma celda), y la separacion entre columnas es la fija (gutter).
      const full = sheets[0];
      const cell = expected[0].photos;
      for (let row = 0; row < options.perPage / 2; row += 1) {
        const left = cell[row * 2].cell;
        const right = cell[row * 2 + 1].cell;
        expect(full.width / 2 - left.x).toBeCloseTo(right.x + right.width - full.width / 2, 6);
        expect(right.x - (left.x + left.width)).toBeCloseTo(GRID_GUTTER, 6);
      }
    }
  });
}

test("la vista previa de hojas: descripcion de cada hoja, «N hojas en total» y se actualiza con cada cambio", async ({ page }) => {
  await open(page);
  // Con una foto por hoja no hay vista previa de hojas (ya esta la rejilla de miniaturas).
  await expect(page.locator("[data-sheet-preview]")).toHaveCount(0);

  await perPageTab(page, 4).click();
  const preview = page.locator("[data-sheet-preview]");
  await expect(preview).toBeVisible();
  await expect(preview.locator("[data-sheet-total]")).toContainText("4 hojas en total");
  await expect(preview.locator("[data-sheet-total]")).toContainText("Se muestran las primeras 3.");
  await expect(preview.locator("[data-sheet]")).toHaveCount(3);
  await expect(preview.getByText("Hoja 1: fotos 1 a 4, 2 columnas × 2 filas")).toBeVisible();
  await expect(preview.getByText("Hoja 3: fotos 9 a 12, 2 columnas × 2 filas")).toBeVisible();
  await expect(preview.locator('[data-sheet-index="0"] [data-sheet-photo]')).toHaveCount(4);

  await perPageTab(page, 6).click();
  await expect(preview.locator("[data-sheet-total]")).toContainText("3 hojas en total");
  await expect(preview.locator("[data-sheet-total]")).not.toContainText("Se muestran");
  await expect(preview.getByText("Hoja 1: fotos 1 a 6, 2 columnas × 3 filas")).toBeVisible();
  await expect(preview.getByText("Hoja 3: foto 13, 2 columnas × 3 filas")).toBeVisible();

  await perPageTab(page, 2).click();
  await expect(preview.getByText("Hoja 1: fotos 1 a 2, 1 columna × 2 filas")).toBeVisible();

  // Tamano de hoja, orientacion y margen se notan en la vista previa.
  const ratio = async () => preview.locator('[data-sheet-index="0"]').evaluate((element) => element.getBoundingClientRect().width / element.getBoundingClientRect().height);
  await perPageTab(page, 4).click();
  const portrait = await ratio();
  expect(portrait).toBeCloseTo(595.28 / 841.89, 1);
  await choose(page, "Orientación", "Horizontal");
  expect(await ratio()).toBeCloseTo(841.89 / 595.28, 1);
  await choose(page, "Orientación", "Automática");
  await choose(page, "Tamaño de página", "Carta");
  expect(await ratio()).toBeCloseTo(612 / 792, 1);
  // El margen mueve las fotos hacia dentro.
  const firstLeft = async () => preview.locator('[data-sheet-index="0"] [data-sheet-photo="0"]').evaluate((element) => (element as HTMLElement).style.left);
  await choose(page, "Margen", "Sin margen");
  const noMargin = parseFloat(await firstLeft());
  await choose(page, "Margen", "Grande");
  expect(parseFloat(await firstLeft())).toBeGreaterThan(noMargin);

  // Las fotos de la vista previa van en su sitio: ninguna se sale de la hoja ni se solapa (en porcentajes).
  const boxes = await preview.locator('[data-sheet-index="0"] [data-sheet-photo]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = (node as HTMLElement).style;
      return { l: parseFloat(style.left), t: parseFloat(style.top), w: parseFloat(style.width), h: parseFloat(style.height) };
    }),
  );
  for (const box of boxes) {
    expect(box.l).toBeGreaterThanOrEqual(-0.01);
    expect(box.t).toBeGreaterThanOrEqual(-0.01);
    expect(box.l + box.w).toBeLessThanOrEqual(100.01);
    expect(box.t + box.h).toBeLessThanOrEqual(100.01);
  }
});

test("con varias fotos por hoja «Ajustar» usa A4 con aviso; con un PDF por imagen el selector queda inerte", async ({ page }) => {
  await open(page, 6);
  await choose(page, "Tamaño de página", "Ajustar");
  await perPageTab(page, 4).click();
  await expect(page.getByText("Con varias fotos por hoja, «Ajustar» usa tamaño A4.")).toBeVisible();
  await expect(page.locator("[data-per-page-hint]")).toContainText("4 fotos por hoja: 2 columnas × 2 filas");
  await choose(page, "Calidad de imagen", "Original");
  const bytes = await generate(page);
  const document = await PDFDocument.load(bytes);
  expect(document.getPageCount()).toBe(2);
  expect(document.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
  expect(document.getPage(0).getHeight()).toBeCloseTo(841.89, 1);

  // «Unir todas en un PDF» desmarcado: una foto por hoja (ZIP), el selector no se puede usar.
  await page.goto("/jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(set.paths.slice(0, 2));
  await expect(page.locator("[data-image-quality]")).toBeVisible();
  await page.locator("label", { hasText: "Unir todas en un PDF" }).click();
  await expect(page.getByRole("checkbox", { name: "Unir todas en un PDF" })).not.toBeChecked();
  await expect(page.locator("[data-per-page-hint]")).toContainText("cada foto va en su propia página");
  await expect(page.locator('div[inert] [role="tablist"][aria-label="Fotos por página"]')).toHaveCount(1);
});

test("«Original» con varias fotos por hoja no toca ningun byte de ninguna foto (solo cambia la composicion)", async ({ page }) => {
  await open(page, 6);
  await configure(page, { perPage: 4, quality: "Original" });
  const bytes = await generate(page);
  const images = await embeddedImages(bytes);
  expect(images).toHaveLength(6);
  for (let index = 0; index < 6; index += 1) {
    expect(images[index].filter).toContain("DCTDecode");
    expect(Buffer.compare(Buffer.from(images[index].bytes), set.buffers[index]), `foto ${index + 1} identica`).toBe(0);
  }
  const { sheets } = await readPlacements(bytes);
  expect(sheets).toHaveLength(2);
  expect(sheets[0].images).toHaveLength(4);
  expect(sheets[1].images).toHaveLength(2);
});

test("con 4 o mas fotos por hoja el PDF pesa mucho menos: cada foto lleva solo los pixeles de su celda", async ({ page }) => {
  const sizes: Record<number, number> = {};
  for (const perPage of [1, 4, 10] as const) {
    await open(page);
    await configure(page, { perPage, quality: "Equilibrada" });
    sizes[perPage] = (await generate(page)).length;
  }
  console.log(`[photo-grid] 13 fotos, Equilibrada: 1 por hoja ${(sizes[1] / 1e6).toFixed(1)} MB, 4 por hoja ${(sizes[4] / 1e6).toFixed(1)} MB, 10 por hoja ${(sizes[10] / 1e6).toFixed(1)} MB`);
  expect(sizes[4]).toBeLessThan(sizes[1] * 0.75);
  expect(sizes[10]).toBeLessThan(sizes[4]);
});

test("la estimacion antes de generar tiene en cuenta las fotos por hoja", async ({ page }) => {
  await open(page);
  const estimate = page.locator("[data-image-quality-estimate]");
  const read = async (): Promise<number> => {
    await expect(estimate).toContainText("≈");
    const text = (await estimate.textContent()) ?? "";
    const match = /≈\s*([\d.,]+)\s*(KB|MB|GB)/.exec(text);
    if (!match) throw new Error(`sin estimacion: ${text}`);
    return Number(match[1].replace(",", ".")) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as "KB" | "MB" | "GB"]);
  };
  await perPageTab(page, 1).click();
  const one = await read();
  await perPageTab(page, 10).click();
  await expect.poll(read).toBeLessThan(one * 0.8);
});
