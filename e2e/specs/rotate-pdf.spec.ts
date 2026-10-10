import {
  closeOptionsSheet,
  expect,
  openOptionsIfSheet,
  openTool,
  runAndDownload,
  runButton,
  test,
  uploadFiles,
} from "../helpers/tool-flow";
import { getPageCount, getPageSize, getPageText } from "../helpers/pdf-inspection";
import { readPages } from "../helpers/pdf-structure";
import { makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Rotar PDF (W6-D): giro de todo el documento (suma a la rotacion previa),
 * giro por pagina con toque en la miniatura, y un documento de 31 paginas con
 * tamanos mezclados y nombre con acentos. Se comprueba /Rotate y el tamano ya
 * rotado que ve pdfjs, ademas del texto de cada pagina.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const rotations = async (bytes: Buffer) => (await readPages(bytes)).map((p) => p.rotation);
const tile = (page: import("@playwright/test").Page, n: number) =>
  page.getByRole("button", { name: `Página ${n}`, exact: true });

test.describe("rotate-pdf", () => {
  test("«Todo» 90°: se suma a la rotacion que ya traia cada pagina", async ({ page }) => {
    await openTool(page, "rotate-pdf");
    await uploadFiles(
      page,
      pdfUpload("giro.pdf", await makePdf({ pages: 3, label: "G", rotate: (index) => [0, 90, 270][index] })),
    );
    const { bytes, filename } = await runAndDownload(page); // 90° por defecto
    expect(filename).toBe("giro-rotado.pdf");
    expect(await rotations(bytes)).toEqual([90, 180, 0]);
    expect(await getPageCount(bytes)).toBe(3);
    // Pagina 1 (300x400) girada 90° se ve apaisada.
    const size = await getPageSize(bytes, 1);
    expect([Math.round(size.width), Math.round(size.height)]).toEqual([400, 300]);
    expect(await getPageText(bytes, 2)).toContain("G-2");
  });

  test("«Todo» 270°: el ultimo angulo elegido es el que se aplica", async ({ page }) => {
    await openTool(page, "rotate-pdf");
    await uploadFiles(page, pdfUpload("a.pdf", await makePdf({ pages: 2, label: "A" })));
    await page.getByRole("tab", { name: "180°" }).click();
    await page.getByRole("tab", { name: "270°" }).click();
    await expect(page.getByRole("tab", { name: "270°" })).toHaveAttribute("aria-selected", "true");
    const { bytes } = await runAndDownload(page);
    expect(await rotations(bytes)).toEqual([270, 270]);
  });

  test("«Por página»: sin girar nada Procesar esta desactivado; solo cambian las paginas tocadas", async ({ page }) => {
    await openTool(page, "rotate-pdf");
    await uploadFiles(page, pdfUpload("pp.pdf", await makePdf({ pages: 4, label: "P" })));
    await page.getByRole("tab", { name: "Por página" }).click();
    await expect(runButton(page)).toBeDisabled();
    await expect(page.getByText("Ninguna página girada todavía.")).toBeVisible();

    await tile(page, 2).click();
    await tile(page, 2).click(); // 180°
    await tile(page, 4).click(); // 90°
    await expect(page.getByText("2 páginas giradas")).toBeVisible();
    const { bytes } = await runAndDownload(page);
    expect(await rotations(bytes)).toEqual([0, 180, 0, 90]);
    expect(await getPageCount(bytes)).toBe(4);
  });

  test("«Girar todas 90°» y «Dejar todo como estaba»", async ({ page }) => {
    await openTool(page, "rotate-pdf");
    await uploadFiles(page, pdfUpload("t.pdf", await makePdf({ pages: 3, label: "T" })));
    await page.getByRole("tab", { name: "Por página" }).click();
    await expect(tile(page, 3)).toBeVisible(); // «Girar todas» actua sobre las paginas ya leidas
    await page.getByRole("button", { name: "Girar todas 90°" }).click();
    await expect(page.getByText("3 páginas giradas")).toBeVisible();
    await page.getByRole("button", { name: "Dejar todo como estaba" }).click();
    await expect(runButton(page)).toBeDisabled();
    await page.getByRole("button", { name: "Girar todas 90°" }).click();
    const { bytes } = await runAndDownload(page);
    expect(await rotations(bytes)).toEqual([90, 90, 90]);
  });

  test("31 paginas con tamanos mezclados y nombre con acentos/parentesis: salen todas rotadas", async ({ page }) => {
    await openTool(page, "rotate-pdf");
    await uploadFiles(
      page,
      pdfUpload(
        "Planos (versión final) ñ.pdf",
        await makePdf({
          pages: 31,
          label: "PL",
          size: (index) => (index % 2 === 0 ? [300, 400] : [500, 250]),
        }),
      ),
    );
    await page.getByRole("tab", { name: "180°" }).click();
    const { bytes, filename } = await runAndDownload(page, { timeout: 90_000 });
    expect(filename).toBe("Planos (versión final) ñ-rotado.pdf");
    expect(await getPageCount(bytes)).toBe(31);
    expect(new Set(await rotations(bytes))).toEqual(new Set([180]));
    // 180° conserva las dimensiones: la 2.a es apaisada, la 31.a vertical.
    expect((await getPageSize(bytes, 2)).width).toBeCloseTo(500, 0);
    expect((await getPageSize(bytes, 31)).height).toBeCloseTo(400, 0);
    expect(await getPageText(bytes, 31)).toContain("PL-31");
  });
});

test.describe("rotate-pdf · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("por pagina con el dedo: toque en una miniatura y descarga", async ({ page }) => {
    await openTool(page, "rotate-pdf");
    await uploadFiles(page, pdfUpload("movil.pdf", await makePdf({ pages: 3, label: "M" })));
    const sheet = await openOptionsIfSheet(page);
    await sheet!.getByRole("tab", { name: "Por página" }).click();
    await closeOptionsSheet(page, sheet);
    await tile(page, 3).tap();
    await expect(runButton(page)).toBeEnabled(); // el giro de la pagina 3 ya cuenta
    const { bytes } = await runAndDownload(page);
    expect(await rotations(bytes)).toEqual([0, 0, 90]);
  });
});
