import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, openTool, runAndDownload, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageSize, getPageText } from "../helpers/pdf-inspection";
import { makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Unir PDF (W6-D): subir 3 PDF de tamanos distintos, reordenar archivos y
 * paginas, quitar una pagina del plan y verificar la SALIDA con pdfjs.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const fileRow = (page: import("@playwright/test").Page, name: string) =>
  page.locator("li", { hasText: name }).filter({ has: page.getByRole("button", { name: "Subir" }) }).first();

async function pageTexts(bytes: Buffer): Promise<string[]> {
  const count = await getPageCount(bytes);
  const texts: string[] = [];
  for (let n = 1; n <= count; n += 1) texts.push((await getPageText(bytes, n)).trim());
  return texts;
}

test.describe("merge-pdf", () => {
  test("3 PDF: se reordena un archivo y la salida trae las paginas en ese orden y con su tamano", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(
      page,
      pdfUpload("a.pdf", await makePdf({ pages: 2, label: "AAA", size: [300, 400] })),
      pdfUpload("b.pdf", await makePdf({ pages: 3, label: "BBB", size: [200, 300] })),
      pdfUpload("c.pdf", await makePdf({ pages: 1, label: "CCC", size: [500, 300] })),
    );
    // La rejilla de paginas ya refleja las 6 paginas.
    await expect(page.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(6);

    // c.pdf sube dos puestos: c, a, b.
    await fileRow(page, "c.pdf").getByRole("button", { name: "Subir" }).click();
    await fileRow(page, "c.pdf").getByRole("button", { name: "Subir" }).click();
    await expect(page.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(6);

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("documento-unido.pdf");
    expect(await pageTexts(bytes)).toEqual(["CCC-1", "AAA-1 ", "AAA-2", "BBB-1", "BBB-2", "BBB-3"].map((t) => t.trim()));
    const sizes = await Promise.all([1, 2, 3, 4, 6].map((n) => getPageSize(bytes, n)));
    expect(sizes.map((s) => [Math.round(s.width), Math.round(s.height)])).toEqual([
      [500, 300],
      [300, 400],
      [300, 400],
      [200, 300],
      [200, 300],
    ]);
    await expect(page.getByRole("heading", { name: /listo|hecho/i })).toBeVisible();
  });

  test("una pagina se mueve y otra se quita del plan; el resultado respeta ambos cambios", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(
      page,
      pdfUpload("uno.pdf", await makePdf({ pages: 2, label: "UNO" })),
      pdfUpload("dos.pdf", await makePdf({ pages: 2, label: "DOS" })),
    );
    const tiles = page.getByRole("button", { name: /^Página \d+$/ });
    await expect(tiles).toHaveCount(4);

    // Pagina 1 (UNO-1) pasa a la 2.a posicion: UNO-2, UNO-1, DOS-1, DOS-2.
    await page.getByRole("button", { name: "Bajar", exact: true }).nth(2).click();
    // Se quita la 3.a pagina del plan (DOS-1).
    await page.getByRole("button", { name: "Quitar", exact: true }).nth(4).click();
    await expect(tiles).toHaveCount(3);

    const { bytes } = await runAndDownload(page);
    expect(await pageTexts(bytes)).toEqual(["UNO-2", "UNO-1", "DOS-2"]);
  });

  test("nombres con acentos, espacios y parentesis, y un PDF de 40 paginas: salen las 42", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(
      page,
      pdfUpload("Informe (final) ñandú v2.pdf", await makePdf({ pages: 40, label: "GRANDE", size: [220, 320] })),
      pdfUpload("Anexo único (copia).pdf", await makePdf({ pages: 2, label: "ANEXO", size: [220, 320] })),
    );
    await expect(page.getByText("Informe (final) ñandú v2.pdf").first()).toBeVisible();
    await expect(page.getByText("Anexo único (copia).pdf").first()).toBeVisible();
    // El plan de paginas se lee archivo a archivo: se espera a que esten las 42.
    await expect(page.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(42, { timeout: 60_000 });

    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    expect(await getPageCount(bytes)).toBe(42);
    expect(await getPageText(bytes, 40)).toContain("GRANDE-40");
    expect(await getPageText(bytes, 41)).toContain("ANEXO-1");
    // El resultado se reabre sin errores con otro lector (pdf-lib).
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(42);
  });

  // Regresion W6-D (corregido): `PageThumbnailGrid` publicaba el plan de paginas archivo a archivo, tras
  // renderizar las miniaturas del anterior, y un «Procesar» en ese intervalo perdia en silencio las paginas
  // de los archivos sin leer (40 en vez de 42). Ahora el plan se publica completo, y si no lo esta se
  // unen todas las paginas de todos los archivos. Se pulsa «Procesar» sin esperar a las miniaturas.
  test("«Procesar» pulsado mientras se leen las paginas NO debe perder las de los archivos pendientes", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(
      page,
      pdfUpload("grande.pdf", await makePdf({ pages: 40, label: "GRANDE", size: [220, 320] })),
      pdfUpload("anexo.pdf", await makePdf({ pages: 2, label: "ANEXO", size: [220, 320] })),
    );
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    expect(await getPageCount(bytes)).toBe(42);
    expect(await getPageText(bytes, 40)).toContain("GRANDE-40");
    expect(await getPageText(bytes, 42)).toContain("ANEXO-2");
  });

  test("«Procesar» inmediato tras reordenar archivos conserva todas las paginas en el nuevo orden", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(
      page,
      pdfUpload("grande.pdf", await makePdf({ pages: 30, label: "G", size: [220, 320] })),
      pdfUpload("anexo.pdf", await makePdf({ pages: 3, label: "AX", size: [220, 320] })),
    );
    await fileRow(page, "anexo.pdf").getByRole("button", { name: "Subir" }).click();
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    expect(await getPageCount(bytes)).toBe(33);
    expect(await getPageText(bytes, 1)).toContain("AX-1");
    expect(await getPageText(bytes, 4)).toContain("G-1");
    expect(await getPageText(bytes, 33)).toContain("G-30");
  });

  test("con un solo archivo «Procesar» no esta disponible", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(page, pdfUpload("solo.pdf", await makePdf({ pages: 2 })));
    await expect(page.getByRole("button", { name: "Procesar", exact: true })).toBeDisabled();
  });
});

test.describe("merge-pdf · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("subir 2 PDF, unir y descargar con el dedo", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(
      page,
      pdfUpload("m1.pdf", await makePdf({ pages: 1, label: "MOV1" })),
      pdfUpload("m2.pdf", await makePdf({ pages: 2, label: "MOV2" })),
    );
    await expect(page.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(3);
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("documento-unido.pdf");
    expect(await getPageCount(bytes)).toBe(3);
  });
});

/** «Procesar» no se esconde bajo el pliegue aunque haya muchas miniaturas: vive en el pie del panel de opciones. */
for (const height of [720, 800, 900]) {
  test.describe(`merge-pdf · 1280x${height}`, () => {
    test.use({ viewport: { width: 1280, height } });

    test("con 40 paginas de miniaturas, «Procesar» queda visible sin desplazar la pagina", async ({ page }) => {
      await openTool(page, "merge-pdf");
      await uploadFiles(
        page,
        pdfUpload("uno.pdf", await makePdf({ pages: 20, label: "U" })),
        pdfUpload("dos.pdf", await makePdf({ pages: 20, label: "D" })),
      );
      await expect(page.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(40, { timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Procesar", exact: true })).toHaveCount(1);
      const box = await page.getByRole("button", { name: "Procesar", exact: true }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      await expect(page.getByText("40 páginas en el documento final")).toBeVisible();
    });
  });
}
