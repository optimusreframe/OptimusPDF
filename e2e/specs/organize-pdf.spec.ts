import type { Page } from "@playwright/test";
import { expect, openTool, runAndDownload, runButton, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageSize, getPageText } from "../helpers/pdf-inspection";
import { readPages } from "../helpers/pdf-structure";
import { makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Organizar PDF (W6-D): reordenar + quitar + girar + pagina en blanco en un solo
 * pase, el estado «sin cambios» y un documento largo. La salida se verifica con
 * pdfjs (texto, tamano) y pdf-lib (/Rotate).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

/** Las fichas del tablero, en orden de documento final. */
const tiles = (page: Page) => page.locator("li").filter({ has: page.getByRole("button", { name: "Mover antes" }) });
const action = (page: Page, index: number, name: string) =>
  tiles(page).nth(index).getByRole("button", { name, exact: true });

async function texts(bytes: Buffer): Promise<string[]> {
  const count = await getPageCount(bytes);
  const out: string[] = [];
  for (let n = 1; n <= count; n += 1) out.push((await getPageText(bytes, n)).trim());
  return out;
}

test.describe("organize-pdf", () => {
  test("reordenar + quitar + girar + pagina en blanco: la salida respeta el plan completo", async ({ page }) => {
    await openTool(page, "organize-pdf");
    await uploadFiles(
      page,
      pdfUpload("plan.pdf", await makePdf({ pages: 5, label: "O", size: (index) => [300 + index * 20, 400] })),
    );
    await expect(tiles(page)).toHaveCount(5);
    // Sin tocar nada el plan es identico al documento: no hay nada que procesar.
    await expect(runButton(page)).toBeDisabled();

    await action(page, 1, "Quitar esta página").click(); // [1,3,4,5]
    await expect(tiles(page)).toHaveCount(4);
    await action(page, 3, "Mover antes").click(); // [1,3,5,4]
    await action(page, 1, "Girar 90 grados").click(); // la pagina 3 gira
    await action(page, 0, "Insertar página en blanco después").click(); // [1,B,3,5,4]
    await expect(tiles(page)).toHaveCount(5);
    await expect(page.getByText("5 páginas en el documento final (4 de 5 originales, 1 en blanco)")).toBeVisible();

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("plan-organizado.pdf");
    expect(await texts(bytes)).toEqual(["O-1", "", "O-3", "O-5", "O-4"]);
    const pages = await readPages(bytes);
    expect(pages.map((p) => p.rotation)).toEqual([0, 0, 90, 0, 0]);
    // Cada pagina conserva su tamano (la 3.a, girada, se ve apaisada).
    const widths = await Promise.all([1, 3, 4, 5].map(async (n) => Math.round((await getPageSize(bytes, n)).width)));
    expect(widths).toEqual([300, 400, 380, 360]);
    const blank = await getPageSize(bytes, 2);
    expect(blank.width).toBeGreaterThan(0);
    expect(blank.height).toBeGreaterThan(0);
  });

  test("«Deshacer cambios» vuelve al documento original y Procesar se desactiva", async ({ page }) => {
    await openTool(page, "organize-pdf");
    await uploadFiles(page, pdfUpload("u.pdf", await makePdf({ pages: 3, label: "U" })));
    await expect(tiles(page)).toHaveCount(3);
    await action(page, 2, "Mover antes").click();
    await expect(runButton(page)).toBeEnabled();
    await page.getByRole("button", { name: "Deshacer cambios" }).click();
    await expect(runButton(page)).toBeDisabled();
    await expect(page.getByText("3 de 3 páginas en el documento final")).toBeVisible();
  });

  test("la ultima pagina que queda no se puede quitar", async ({ page }) => {
    await openTool(page, "organize-pdf");
    await uploadFiles(page, pdfUpload("dos.pdf", await makePdf({ pages: 2, label: "D" })));
    await expect(tiles(page)).toHaveCount(2);
    await action(page, 0, "Quitar esta página").click();
    await expect(tiles(page)).toHaveCount(1);
    await expect(action(page, 0, "Quitar esta página")).toBeDisabled();
    await expect(page.getByText("Tiene que quedar al menos una página.")).toBeVisible();
    const { bytes } = await runAndDownload(page);
    expect(await texts(bytes)).toEqual(["D-2"]);
  });

  test("33 paginas con nombre con acentos: la ultima pasa a ser la primera y una gira", async ({ page }) => {
    await openTool(page, "organize-pdf");
    await uploadFiles(
      page,
      pdfUpload("Libro (borrador) ñ.pdf", await makePdf({ pages: 33, label: "LB", size: [260, 340] })),
    );
    await expect(tiles(page)).toHaveCount(33, { timeout: 30_000 });
    for (let step = 0; step < 32; step += 1) await action(page, 32 - step, "Mover antes").click();
    await action(page, 0, "Girar 90 grados").click();
    const { bytes, filename } = await runAndDownload(page, { timeout: 90_000 });
    expect(filename).toBe("Libro (borrador) ñ-organizado.pdf");
    expect(await getPageCount(bytes)).toBe(33);
    expect(await getPageText(bytes, 1)).toContain("LB-33");
    expect(await getPageText(bytes, 2)).toContain("LB-1");
    expect(await getPageText(bytes, 33)).toContain("LB-32");
    expect((await readPages(bytes))[0].rotation).toBe(90);
  });
});

test.describe("organize-pdf · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("las acciones se ven sin hover: quitar una pagina con el dedo y descargar", async ({ page }) => {
    await openTool(page, "organize-pdf");
    await uploadFiles(page, pdfUpload("movil.pdf", await makePdf({ pages: 3, label: "MV" })));
    await expect(tiles(page)).toHaveCount(3);
    await action(page, 1, "Quitar esta página").tap();
    await expect(tiles(page)).toHaveCount(2);
    const { bytes } = await runAndDownload(page);
    expect(await texts(bytes)).toEqual(["MV-1", "MV-3"]);
  });
});
