import type { Page } from "@playwright/test";
import JSZip from "jszip";
import {
  closeOptionsSheet,
  downloadButton,
  expect,
  openOptionsIfSheet,
  openTool,
  runAndDownload,
  runButton,
  test,
  uploadFiles,
} from "../helpers/tool-flow";
import { getPageCount, getPageOperatorCounts, getPageSize } from "../helpers/pdf-inspection";
import { readJpegDimensions } from "../helpers/jpeg-dimensions";
import { imageUpload, makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Imagen a PDF y PDF a JPG (W6-D). Imagen a PDF: tamano de pagina, orientacion,
 * margen, orden y ZIP. PDF a JPG: numero y tipo de las imagenes, resolucion
 * real (ancho x alto en pixeles), seleccion de paginas y paginas rotadas.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const sizeOf = async (bytes: Buffer, n: number) => {
  const size = await getPageSize(bytes, n);
  return [Math.round(size.width * 100) / 100, Math.round(size.height * 100) / 100];
};

const imageCards = (page: Page) => page.locator("li").filter({ has: page.getByAltText(/^Imagen \d+$/) });

test.describe("jpg-to-pdf", () => {
  test("A4 sin margen (orientacion automatica por defecto): una pagina A4 por imagen, JPEG y PNG, con la imagen pintada", async ({ page }) => {
    await openTool(page, "jpg-to-pdf");
    await uploadFiles(
      page,
      imageUpload("uno.jpg", "jpeg", 400, 300, 1),
      imageUpload("dos.png", "png", 200, 300, 2),
      imageUpload("tres.jpg", "jpeg", 300, 300, 3),
    );
    await expect(imageCards(page)).toHaveCount(3);
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("documento-convertido.pdf");
    expect(await getPageCount(bytes)).toBe(3);
    // La apaisada (400x300) da una pagina horizontal; la vertical y la cuadrada, verticales.
    expect(await sizeOf(bytes, 1)).toEqual([841.89, 595.28]);
    expect(await sizeOf(bytes, 2)).toEqual([595.28, 841.89]);
    expect(await sizeOf(bytes, 3)).toEqual([595.28, 841.89]);
    for (const n of [1, 2, 3]) {
      expect((await getPageOperatorCounts(bytes, n)).imagePaintOps).toBeGreaterThanOrEqual(1);
    }
  });

  test("Carta + orientacion automatica: la imagen apaisada da una pagina horizontal", async ({ page }) => {
    await openTool(page, "jpg-to-pdf");
    await uploadFiles(
      page,
      imageUpload("ancha.jpg", "jpeg", 400, 200, 4),
      imageUpload("alta.jpg", "jpeg", 200, 400, 5),
    );
    await page.getByRole("tab", { name: "Carta" }).click();
    await expect(page.getByRole("tab", { name: "Automática" })).toHaveAttribute("aria-selected", "true");
    const { bytes } = await runAndDownload(page);
    expect(await sizeOf(bytes, 1)).toEqual([792, 612]);
    expect(await sizeOf(bytes, 2)).toEqual([612, 792]);
  });

  test("«Ajustar» con margen pequeno y orden cambiado: cada pagina mide su imagen + 2 x 24 y respeta el orden", async ({ page }) => {
    await openTool(page, "jpg-to-pdf");
    await uploadFiles(
      page,
      imageUpload("a.jpg", "jpeg", 120, 80, 6),
      imageUpload("b.png", "png", 90, 150, 7),
      imageUpload("c.jpg", "jpeg", 60, 60, 8),
    );
    await page.getByRole("tab", { name: "Ajustar" }).click();
    await page.getByRole("tab", { name: "Pequeño" }).click();
    // La imagen 3 sube dos puestos: c, a, b.
    await imageCards(page).nth(2).getByRole("button", { name: "Subir" }).click();
    await imageCards(page).nth(1).getByRole("button", { name: "Subir" }).click();
    const { bytes } = await runAndDownload(page);
    expect(await getPageCount(bytes)).toBe(3);
    expect(await sizeOf(bytes, 1)).toEqual([108, 108]);
    expect(await sizeOf(bytes, 2)).toEqual([168, 128]);
    expect(await sizeOf(bytes, 3)).toEqual([138, 198]);
  });

  test("sin unir: un ZIP con un PDF por imagen, con nombres con acentos y parentesis", async ({ page }) => {
    await openTool(page, "jpg-to-pdf");
    await uploadFiles(
      page,
      imageUpload("foto año (1).jpg", "jpeg", 100, 100, 9),
      imageUpload("Escaneo único.png", "png", 100, 50, 10),
    );
    await page.locator("label", { hasText: "Unir todas en un PDF" }).click();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("documento-convertido.zip");
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["Escaneo único.pdf", "foto año (1).pdf"]);
    const pdf = Buffer.from(await zip.files["foto año (1).pdf"].async("uint8array"));
    expect(await getPageCount(pdf)).toBe(1);
  });

  // Regresion W6-D (corregido): con «Unir todas en un PDF» apagado, dos imagenes con el mismo nombre base
  // (foto.jpg y foto.png) colgaban la pestana (`replaceExtension` devolvia siempre «foto.pdf» y el bucle de
  // nombres unicos no terminaba). Ahora salen «foto.pdf» y «foto (2).pdf». El limite de 15 s detecta el cuelgue.
  test("dos imagenes con el mismo nombre base sin unir: salen foto.pdf y foto (2).pdf, sin colgarse", async ({ page }) => {
    await openTool(page, "jpg-to-pdf");
    await uploadFiles(
      page,
      imageUpload("foto.jpg", "jpeg", 80, 60, 11),
      imageUpload("foto.png", "png", 80, 60, 12),
    );
    await page.locator("label", { hasText: "Unir todas en un PDF" }).click();
    const { bytes } = await runAndDownload(page, { timeout: 15_000 });
    const names = Object.keys((await JSZip.loadAsync(bytes)).files).sort();
    expect(names).toEqual(["foto (2).pdf", "foto.pdf"]);
  });

  test("31 imagenes pequenas: 31 paginas y una se quita de la lista antes de procesar", async ({ page }) => {
    await openTool(page, "jpg-to-pdf");
    await uploadFiles(page, ...Array.from({ length: 31 }, (_, index) => imageUpload(`img-${String(index).padStart(2, "0")}.jpg`, "jpeg", 40 + index, 40, 20 + index)));
    await expect(imageCards(page)).toHaveCount(31, { timeout: 30_000 });
    await page.getByRole("tab", { name: "Ajustar" }).click();
    await page.getByRole("button", { name: "Quitar", exact: true }).first().click();
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    expect(await getPageCount(bytes)).toBe(30);
    // La primera pagina es la imagen 2 (41 px de ancho): la 1 se quito.
    expect((await sizeOf(bytes, 1))[0]).toBe(41);
  });
});

test.describe("jpg-to-pdf · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("Carta + Vertical desde la hoja de opciones fuerzan una pagina vertical aunque la imagen sea apaisada", async ({ page }) => {
    await openTool(page, "jpg-to-pdf");
    await uploadFiles(page, imageUpload("m.jpg", "jpeg", 300, 200, 30));
    const sheet = await openOptionsIfSheet(page);
    await sheet!.getByRole("tab", { name: "Carta" }).click();
    await sheet!.getByRole("tab", { name: "Vertical" }).click();
    await closeOptionsSheet(page, sheet);
    const { bytes } = await runAndDownload(page);
    expect(await sizeOf(bytes, 1)).toEqual([612, 792]);
  });
});

/* ------------------------------------------------------------------ *
 * PDF a JPG
 * ------------------------------------------------------------------ */

async function unzipJpgs(bytes: Buffer): Promise<Array<{ name: string; bytes: Buffer }>> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).sort();
  return Promise.all(names.map(async (name) => ({ name, bytes: Buffer.from(await zip.files[name].async("uint8array")) })));
}

test.describe("pdf-to-jpg", () => {
  test("3 paginas a 2x: un ZIP con 3 JPG de 600x800 px (la apaisada, 800x600)", async ({ page }) => {
    await openTool(page, "pdf-to-jpg");
    await uploadFiles(
      page,
      pdfUpload(
        "Presentación (v2).pdf",
        await makePdf({ pages: 3, label: "J", size: (index) => (index === 2 ? [400, 300] : [300, 400]) }),
      ),
    );
    await expect(page.getByRole("img", { name: /^Página \d+$/ })).toHaveCount(3);
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Presentación (v2)-imagenes.zip");
    const images = await unzipJpgs(bytes);
    expect(images.map((image) => image.name)).toEqual(["pagina-1.jpg", "pagina-2.jpg", "pagina-3.jpg"]);
    for (const image of images) expect(image.bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(images.map((image) => readJpegDimensions(image.bytes))).toEqual([
      { width: 600, height: 800 },
      { width: 600, height: 800 },
      { width: 800, height: 600 },
    ]);
  });

  test("una sola pagina a 1x se descarga como JPG suelto y una pagina rotada 90° sale apaisada", async ({ page }) => {
    await openTool(page, "pdf-to-jpg");
    await uploadFiles(page, pdfUpload("giro.pdf", await makePdf({ pages: 1, label: "R", rotate: () => 90 })));
    await page.getByRole("tab", { name: "1x" }).click();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("giro-imagenes.jpg");
    expect(bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(readJpegDimensions(bytes)).toEqual({ width: 400, height: 300 });
  });

  test("«Elegir» paginas: solo las marcadas entran en el ZIP", async ({ page }) => {
    await openTool(page, "pdf-to-jpg");
    await uploadFiles(page, pdfUpload("cuatro.pdf", await makePdf({ pages: 4, label: "C" })));
    await page.getByRole("tab", { name: "Elegir" }).click();
    // Todas empiezan marcadas: se desmarcan la 1 y la 3.
    await page.getByRole("button", { name: "Página 1", exact: true }).click();
    await page.getByRole("button", { name: "Página 3", exact: true }).click();
    const { bytes } = await runAndDownload(page);
    const images = await unzipJpgs(bytes);
    expect(images.map((image) => image.name)).toEqual(["pagina-2.jpg", "pagina-4.jpg"]);
  });

  test("calidad: 50% pesa menos que 100% y ambos son JPEG validos", async ({ page }) => {
    const upload = pdfUpload("calidad.pdf", await makePdf({ pages: 1, label: "Q", size: [400, 400] }));
    const sizes: number[] = [];
    for (const quality of ["50", "100"]) {
      await openTool(page, "pdf-to-jpg");
      await uploadFiles(page, upload);
      await page.getByRole("slider", { name: "Calidad JPG" }).fill(quality);
      const { bytes } = await runAndDownload(page);
      expect(readJpegDimensions(bytes)).toEqual({ width: 800, height: 800 });
      sizes.push(bytes.length);
    }
    expect(sizes[0]).toBeLessThan(sizes[1]);
  });

  test("documento de 32 paginas: 32 JPG en el ZIP con numeracion de 2 cifras", async ({ page }) => {
    await openTool(page, "pdf-to-jpg");
    await uploadFiles(page, pdfUpload("largo.pdf", await makePdf({ pages: 32, label: "L", size: [200, 280] })));
    await page.getByRole("tab", { name: "1x" }).click();
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    const images = await unzipJpgs(bytes);
    expect(images).toHaveLength(32);
    expect(images[0].name).toBe("pagina-01.jpg");
    expect(images[31].name).toBe("pagina-32.jpg");
  });

  test("cancelar una conversion larga (80 paginas a 3x): avisa sin error, no descarga y se puede volver a procesar", async ({ page }) => {
    await openTool(page, "pdf-to-jpg");
    await uploadFiles(page, pdfUpload("enorme.pdf", await makePdf({ pages: 80, label: "CAN", size: [400, 560] })));
    await page.getByRole("tab", { name: "3x" }).click();
    await runButton(page).click();
    const cancel = page.getByRole("button", { name: "Cancelar", exact: true });
    await expect(cancel).toBeVisible();
    // El boton entra animado y se vuelve a pintar con cada avance: sin esperas de «estable», como un toque rapido.
    await cancel.dispatchEvent("click");
    await expect(page.getByRole("status").filter({ hasText: "Proceso cancelado." })).toBeVisible();
    await expect(downloadButton(page)).toHaveCount(0);
    await expect(page.locator("[data-error-banner]")).toHaveCount(0);
    await expect(runButton(page)).toBeEnabled();

    // Tras cancelar, la herramienta sigue sirviendo: 1x termina y trae las 80 imagenes.
    await page.getByRole("tab", { name: "1x" }).click();
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    expect(await unzipJpgs(bytes)).toHaveLength(80);
  });
});
