import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  closeOptionsSheet,
  expect,
  openOptionsIfSheet,
  openTool,
  runAndDownload,
  test,
  uploadFiles,
} from "../helpers/tool-flow";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import { makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Dividir PDF (W6-D): rangos (ZIP con un PDF por tramo), fijo cada N, extraer
 * seleccion (un PDF) y un documento de 35 paginas con nombre con acentos,
 * espacios y parentesis. La salida se abre con pdfjs / jszip.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

/** Nombre -> bytes de cada PDF del ZIP, en orden alfabetico. */
async function unzipPdfs(bytes: Buffer): Promise<Array<{ name: string; bytes: Buffer }>> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  return Promise.all(
    names.map(async (name) => ({ name, bytes: Buffer.from(await zip.files[name].async("uint8array")) })),
  );
}

async function texts(bytes: Buffer): Promise<string[]> {
  const count = await getPageCount(bytes);
  const out: string[] = [];
  for (let n = 1; n <= count; n += 1) out.push((await getPageText(bytes, n)).trim());
  return out;
}

async function loadPlanned(page: import("@playwright/test").Page, count: number) {
  // El tablero ya leyo el documento cuando el tramo por defecto llega a la ultima pagina.
  await expect(page.getByRole("spinbutton", { name: "Hasta" }).first()).toHaveValue(String(count));
}

test.describe("split-pdf", () => {
  test("rangos: 1-3 y 4-fin salen como dos PDF dentro de un ZIP con su nombre", async ({ page }) => {
    await openTool(page, "split-pdf");
    await uploadFiles(page, pdfUpload("Informe trimestral.pdf", await makePdf({ pages: 6, label: "INF" })));
    await loadPlanned(page, 6);

    await page.getByRole("spinbutton", { name: "Hasta" }).first().fill("3");
    await page.getByRole("button", { name: "Añadir otro tramo" }).click();
    // El segundo tramo arranca justo despues del primero y llega al final.
    await expect(page.getByRole("spinbutton", { name: "Desde" }).nth(1)).toHaveValue("4");
    await expect(page.getByRole("spinbutton", { name: "Hasta" }).nth(1)).toHaveValue("6");
    await expect(page.getByText("Saldrán 2 documentos dentro de un ZIP.")).toBeVisible();

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Informe trimestral-dividido.zip");
    const parts = await unzipPdfs(bytes);
    expect(parts.map((part) => part.name)).toEqual([
      "Informe trimestral-1-3.pdf",
      "Informe trimestral-4-6.pdf",
    ]);
    expect(await texts(parts[0].bytes)).toEqual(["INF-1", "INF-2", "INF-3"]);
    expect(await texts(parts[1].bytes)).toEqual(["INF-4", "INF-5", "INF-6"]);
  });

  test("rangos con «Juntar» activado: un unico PDF con solo las paginas de los tramos", async ({ page }) => {
    await openTool(page, "split-pdf");
    await uploadFiles(page, pdfUpload("doc.pdf", await makePdf({ pages: 6, label: "J" })));
    await loadPlanned(page, 6);

    await page.getByRole("spinbutton", { name: "Desde" }).first().fill("2");
    await page.getByRole("spinbutton", { name: "Hasta" }).first().fill("3");
    await page.getByRole("button", { name: "Añadir otro tramo" }).click();
    await page.getByRole("spinbutton", { name: "Desde" }).nth(1).fill("6");
    await page.getByRole("spinbutton", { name: "Hasta" }).nth(1).fill("6");
    await page.locator("label", { hasText: "Juntar todos los tramos en un solo PDF" }).click();
    await expect(page.getByText("Saldrá un único PDF.")).toBeVisible();

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("doc-dividido.pdf");
    expect(await texts(bytes)).toEqual(["J-2", "J-3", "J-6"]);
  });

  test("cada N: 5 paginas de 2 en 2 dan 3 documentos (2, 2 y 1)", async ({ page }) => {
    await openTool(page, "split-pdf");
    await uploadFiles(page, pdfUpload("cinco.pdf", await makePdf({ pages: 5, label: "N" })));
    await loadPlanned(page, 5);
    await page.getByRole("tab", { name: "Cada N" }).click();
    await expect(page.getByText("Saldrán 3 documentos dentro de un ZIP.")).toBeVisible();

    const { bytes } = await runAndDownload(page);
    const parts = await unzipPdfs(bytes);
    expect(parts.map((part) => part.name)).toEqual(["cinco-1-2.pdf", "cinco-3-4.pdf", "cinco-5.pdf"]);
    expect(await Promise.all(parts.map((part) => getPageCount(part.bytes)))).toEqual([2, 2, 1]);
    expect(await texts(parts[2].bytes)).toEqual(["N-5"]);
  });

  test("extraer una seleccion escrita a mano deja un unico PDF con esas paginas", async ({ page }) => {
    await openTool(page, "split-pdf");
    await uploadFiles(page, pdfUpload("sel.pdf", await makePdf({ pages: 6, label: "S" })));
    await loadPlanned(page, 6);
    await page.getByRole("tab", { name: "Extraer" }).click();
    await page.getByRole("tab", { name: "Selección" }).click();
    await page.getByLabel("Páginas", { exact: true }).fill("1, 3-4");
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("sel-dividido.pdf");
    expect(await texts(bytes)).toEqual(["S-1", "S-3", "S-4"]);
  });

  test("35 paginas con nombre con acentos, espacios y parentesis: cada N=10 da 4 partes con ese nombre", async ({ page }) => {
    await openTool(page, "split-pdf");
    const name = "Año fiscal (borrador) ñandú.pdf";
    await uploadFiles(page, pdfUpload(name, await makePdf({ pages: 35, label: "AF", size: [250, 350] })));
    await loadPlanned(page, 35);
    await page.getByRole("tab", { name: "Cada N" }).click();
    await page.getByRole("spinbutton", { name: "Páginas por documento" }).fill("10");
    await expect(page.getByText("Saldrán 4 documentos dentro de un ZIP.")).toBeVisible();

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Año fiscal (borrador) ñandú-dividido.zip");
    const parts = await unzipPdfs(bytes);
    expect(parts.map((part) => part.name)).toEqual([
      "Año fiscal (borrador) ñandú-1-10.pdf",
      "Año fiscal (borrador) ñandú-11-20.pdf",
      "Año fiscal (borrador) ñandú-21-30.pdf",
      "Año fiscal (borrador) ñandú-31-35.pdf",
    ]);
    expect(await Promise.all(parts.map((part) => getPageCount(part.bytes)))).toEqual([10, 10, 10, 5]);
    expect((await PDFDocument.load(parts[3].bytes)).getPageCount()).toBe(5);
  });
});

test.describe("split-pdf · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("cada N desde la hoja de opciones: 4 paginas de 2 en 2 dan un ZIP con 2 PDF", async ({ page }) => {
    await openTool(page, "split-pdf");
    await uploadFiles(page, pdfUpload("movil.pdf", await makePdf({ pages: 4, label: "M" })));
    const sheet = await openOptionsIfSheet(page);
    expect(sheet).not.toBeNull();
    await sheet!.getByRole("tab", { name: "Cada N" }).click();
    await expect(sheet!.getByText("Saldrán 2 documentos dentro de un ZIP.")).toBeVisible();
    await closeOptionsSheet(page, sheet);

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("movil-dividido.zip");
    expect((await unzipPdfs(bytes)).map((part) => part.name)).toEqual(["movil-1-2.pdf", "movil-3-4.pdf"]);
  });
});
