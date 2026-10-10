import JSZip from "jszip";
import { expect, openTool, runAndDownload, runButton, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageSize, getPageText } from "../helpers/pdf-inspection";
import { readPages } from "../helpers/pdf-structure";
import { makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Eliminar paginas y Extraer paginas (W6-D): lista escrita a mano, miniaturas,
 * estados vacios y documentos largos / con paginas rotadas. Salida verificada
 * con pdfjs, pdf-lib y jszip.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

async function texts(bytes: Buffer): Promise<string[]> {
  const count = await getPageCount(bytes);
  const out: string[] = [];
  for (let n = 1; n <= count; n += 1) out.push((await getPageText(bytes, n)).trim());
  return out;
}

const tile = (page: import("@playwright/test").Page, n: number, action: string) =>
  page.getByRole("button", { name: `Página ${n} — ${action}` });

test.describe("remove-pages", () => {
  test("lista escrita «2, 4-5»: sobreviven 1, 3 y 6, con el nombre de salida", async ({ page }) => {
    await openTool(page, "remove-pages");
    await uploadFiles(page, pdfUpload("seis paginas.pdf", await makePdf({ pages: 6, label: "R" })));
    // El tablero reinicia las marcas al leer el documento: se espera a que este listo antes de escribir.
    await expect(tile(page, 1, "Marcar para eliminar")).toBeVisible();
    await expect(runButton(page)).toBeDisabled(); // nada marcado: no hay nada que quitar

    await page.getByLabel("Páginas a eliminar").fill("2, 4-5");
    await expect(page.getByText("3 páginas marcadas · Quedan 3 de 6 páginas")).toBeVisible();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("seis paginas-sin-paginas.pdf");
    expect(await texts(bytes)).toEqual(["R-1", "R-3", "R-6"]);
  });

  test("miniaturas: se marcan y se desmarcan; «Quitar todas las marcas» devuelve Procesar a desactivado", async ({ page }) => {
    await openTool(page, "remove-pages");
    await uploadFiles(page, pdfUpload("t.pdf", await makePdf({ pages: 4, label: "T" })));
    await tile(page, 1, "Marcar para eliminar").click();
    await tile(page, 3, "Marcar para eliminar").click();
    await expect(page.getByLabel("Páginas a eliminar")).toHaveValue("1, 3");
    // Se arrepiente de la 1.
    await tile(page, 1, "Conservar esta página").click();
    await expect(page.getByLabel("Páginas a eliminar")).toHaveValue("3");

    await page.getByRole("button", { name: "Quitar todas las marcas" }).click();
    await expect(runButton(page)).toBeDisabled();
    await tile(page, 2, "Marcar para eliminar").click();
    const { bytes } = await runAndDownload(page);
    expect(await texts(bytes)).toEqual(["T-1", "T-3", "T-4"]);
  });

  test("no se pueden eliminar todas las paginas: avisa y Procesar queda desactivado", async ({ page }) => {
    await openTool(page, "remove-pages");
    await uploadFiles(page, pdfUpload("t.pdf", await makePdf({ pages: 3 })));
    await expect(tile(page, 3, "Marcar para eliminar")).toBeVisible();
    await page.getByLabel("Páginas a eliminar").fill("1-3");
    await expect(page.getByText("No puedes eliminar todas las páginas: al menos una tiene que quedarse.").first()).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
    await page.getByLabel("Páginas a eliminar").fill("1-x");
    await expect(page.getByText("Revisa el formato: solo números y rangos dentro del documento.").first()).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
  });

  test("32 paginas con paginas rotadas: quitar 1-30 deja las 2 ultimas con su rotacion", async ({ page }) => {
    await openTool(page, "remove-pages");
    await uploadFiles(
      page,
      pdfUpload(
        "Largo (rotado) año.pdf",
        await makePdf({ pages: 32, label: "L", size: [300, 400], rotate: (index) => (index >= 30 ? 90 : 0) }),
      ),
    );
    await expect(tile(page, 32, "Marcar para eliminar")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Páginas a eliminar").fill("1-30");
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Largo (rotado) año-sin-paginas.pdf");
    expect(await texts(bytes)).toEqual(["L-31", "L-32"]);
    expect((await readPages(bytes)).map((p) => p.rotation)).toEqual([90, 90]);
    const size = await getPageSize(bytes, 1);
    expect([Math.round(size.width), Math.round(size.height)]).toEqual([400, 300]);
  });
});

test.describe("extract-pages", () => {
  test("«Un PDF» con «2, 5»: un documento con solo esas paginas", async ({ page }) => {
    await openTool(page, "extract-pages");
    await uploadFiles(page, pdfUpload("origen.pdf", await makePdf({ pages: 6, label: "E" })));
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("1-6");
    await page.getByLabel("Páginas a extraer").fill("2, 5");
    await expect(page.getByLabel("Opciones").getByText("2 de 6 páginas elegidas")).toBeVisible();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("origen-extraido.pdf");
    expect(await texts(bytes)).toEqual(["E-2", "E-5"]);
  });

  test("«Uno por página» con 3 paginas elegidas: un ZIP con 3 PDF de una pagina", async ({ page }) => {
    await openTool(page, "extract-pages");
    await uploadFiles(page, pdfUpload("Acta (2024) ñ.pdf", await makePdf({ pages: 5, label: "Z", size: [280, 380] })));
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("1-5"); // tablero listo
    await page.getByLabel("Páginas a extraer").fill("1, 3, 5");
    await page.getByRole("tab", { name: "Uno por página" }).click();
    await expect(page.getByText("Se generarán 3 PDF dentro de un ZIP.")).toBeVisible();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Acta (2024) ñ-extraido.zip");
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["Acta (2024) ñ-1.pdf", "Acta (2024) ñ-3.pdf", "Acta (2024) ñ-5.pdf"]);
    for (const [index, name] of names.entries()) {
      const pdf = Buffer.from(await zip.files[name].async("uint8array"));
      expect(await getPageCount(pdf)).toBe(1);
      expect(await getPageText(pdf, 1)).toContain(`Z-${[1, 3, 5][index]}`);
    }
  });

  test("lista vacia: Procesar desactivado con su motivo; invertir «1, 2» elige 3 y 4", async ({ page }) => {
    await openTool(page, "extract-pages");
    await uploadFiles(page, pdfUpload("v.pdf", await makePdf({ pages: 4, label: "V" })));
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("1-4");

    // Con todo elegido, invertir no deja nada: avisa y no toca la seleccion.
    await page.getByRole("button", { name: "Invertir la selección" }).click();
    await expect(page.getByText("Elige al menos una página.").first()).toBeVisible();
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("1-4");

    await page.getByLabel("Páginas a extraer").fill("");
    await expect(runButton(page)).toBeDisabled();
    await page.getByLabel("Páginas a extraer").fill("1, 2");
    await page.getByRole("button", { name: "Invertir la selección" }).click();
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("3-4");
    await tile(page, 4, "Sacar de la extracción").click();
    const { bytes } = await runAndDownload(page);
    expect(await texts(bytes)).toEqual(["V-3"]);
  });

  test("documento largo (36 paginas): extraer las 3 ultimas conserva su orden", async ({ page }) => {
    await openTool(page, "extract-pages");
    await uploadFiles(page, pdfUpload("largo.pdf", await makePdf({ pages: 36, label: "G", size: [240, 320] })));
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("1-36");
    await page.getByLabel("Páginas a extraer").fill("34-36");
    const { bytes } = await runAndDownload(page);
    expect(await texts(bytes)).toEqual(["G-34", "G-35", "G-36"]);
  });
});
