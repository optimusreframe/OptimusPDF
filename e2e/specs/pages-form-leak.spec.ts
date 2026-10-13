import { PDFArray, PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { expect, openTool, runAndDownload, test, uploadFiles } from "../helpers/tool-flow";
import { pdfUpload } from "../helpers/test-files";
import { occurs, rawFileText } from "../../src/lib/pdf/testing/pdfStrings";

/**
 * Wave 9 · lote 2 · D-B7-1: lo que se quita con las paginas no se queda dentro del archivo, tampoco el CAMPO de formulario.
 *
 * Un campo que es un diccionario APARTE de su widget y que nombra el orden de calculo (`/AcroForm /CO`) se quedaba, con su
 * valor, en el PDF que sale de Quitar paginas y de Extraer, y la pantalla decia «Se quitó 1 campo». Aqui las herramientas se
 * usan de verdad (subir, marcar, procesar, descargar) y el archivo descargado se mira desde fuera: por cadenas, en los bytes y
 * en cada flujo descomprimido, y abriendolo con pdf-lib para ver que el campo que se queda sigue siendo un campo con su valor.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const DEAD_VALUE = "VALOR-E2E-DE-LA-PAGINA-3";
const LIVE_VALUE = "VALOR-E2E-DE-LA-PAGINA-1";

/** 4 paginas; el campo `CMP-VIVO` esta en la 1 y el `CMP-MUERTO` en la 3, ambos APARTE de su widget y en el orden de calculo. */
async function makeFormWithCalcOrder(): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [1, 2, 3, 4].map((n) => {
    const page = doc.addPage([300, 400]);
    page.drawText(`PAG-E2E-${n}`, { x: 24, y: 340, size: 18, font });
    return page;
  });
  const form = doc.getForm();
  const live = form.createTextField("CMP-VIVO");
  live.setText(LIVE_VALUE);
  live.addToPage(pages[0], { x: 20, y: 200, width: 240, height: 22 });
  const dead = form.createTextField("CMP-MUERTO");
  dead.setText(DEAD_VALUE);
  dead.addToPage(pages[2], { x: 20, y: 200, width: 240, height: 22 });
  form.acroForm.dict.set(PDFName.of("CO"), doc.context.obj([live.ref, dead.ref]));
  return Buffer.from(await doc.save({ useObjectStreams: true, updateFieldAppearances: false }));
}

async function expectOnlyTheLiveField(bytes: Buffer): Promise<void> {
  const raw = rawFileText(bytes);
  expect(occurs(raw, LIVE_VALUE), "el valor del campo que se queda sigue en el archivo").toBe(true);
  expect(occurs(raw, "CMP-VIVO"), "el nombre del campo que se queda sigue en el archivo").toBe(true);
  expect(occurs(raw, DEAD_VALUE), "el valor del campo de la pagina quitada NO debe seguir en el archivo").toBe(false);
  expect(occurs(raw, "CMP-MUERTO"), "el nombre del campo de la pagina quitada NO debe seguir en el archivo").toBe(false);

  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = loaded.getForm();
  expect(form.getFields().map((field) => field.getName())).toEqual(["CMP-VIVO"]);
  expect(form.getTextField("CMP-VIVO").getText()).toBe(LIVE_VALUE);
  const order = form.acroForm.dict.get(PDFName.of("CO"));
  expect(order instanceof PDFArray ? order.size() : 0).toBe(1);
  // Y sigue siendo editable.
  form.getTextField("CMP-VIVO").setText("EDITADO");
  const again = await PDFDocument.load(await loaded.save());
  expect(again.getForm().getTextField("CMP-VIVO").getText()).toBe("EDITADO");
}

test.describe("el campo de una pagina quitada no se queda en el archivo", () => {
  test("Quitar paginas: la 3 se va con su campo y su valor, y la pantalla lo cuenta con verdad", async ({ page }) => {
    await openTool(page, "remove-pages");
    await uploadFiles(page, pdfUpload("formulario.pdf", await makeFormWithCalcOrder()));
    await expect(page.getByRole("button", { name: "Página 3 — Marcar para eliminar" })).toBeVisible();
    await page.getByLabel("Páginas a eliminar").fill("3");
    const { bytes } = await runAndDownload(page);
    await expect(page.locator("[data-download-notices]")).toContainText("Se quitó 1 campo de formulario de una página que ya no está.");
    await expectOnlyTheLiveField(bytes);
  });

  test("Extraer paginas: sacar las paginas 1 y 2 deja fuera el campo de la 3, con su valor", async ({ page }) => {
    await openTool(page, "extract-pages");
    await uploadFiles(page, pdfUpload("formulario.pdf", await makeFormWithCalcOrder()));
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("1-4");
    await page.getByLabel("Páginas a extraer").fill("1-2");
    const { bytes } = await runAndDownload(page);
    await expect(page.locator("[data-download-notices]")).toContainText("Se quitó 1 campo de formulario de una página que ya no está.");
    await expectOnlyTheLiveField(bytes);
  });
});
