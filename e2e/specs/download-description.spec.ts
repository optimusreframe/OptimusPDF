import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { expectDescriptionWithoutRepeats } from "../helpers/accessible-description";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";

/**
 * D3 (Wave 9 · B7) · la descripcion accesible del boton «Descargar» NO repite los avisos, medida en Chromium real.
 *
 * `aria-describedby` apuntaba al grupo de avisos Y a su lista; Chromium calcula la descripcion de cada elemento referenciado
 * con todo su contenido, asi que la lista se leia dos veces. Las pruebas de jsdom no lo detectan: aqui se lee el arbol de
 * accesibilidad real (CDP `Accessibility.getFullAXTree`) en Firmar y en Editar PDF, con avisos de verdad en pantalla.
 */

test.setTimeout(150_000);
test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

const SG = SIGN_STRINGS.es;
const ORIGINAL_TITLE = "Receipt from Acme Studio";

/** El titulo en un Form XObject que comparten DOS paginas: el motor no lo puede quitar y avisa (resumen + titulo + avisos). */
async function makeSharedTitlePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const xobject = doc.context.register(
    doc.context.stream(`BT /F1 22 Tf 0 0 Td (${ORIGINAL_TITLE}) Tj ET`, {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, -10, 400, 30],
      Matrix: [1, 0, 0, 1, 56, 730],
      Resources: { Font: { F1: font.ref } },
    }),
  );
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([612, 792]);
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
  }
  return Buffer.from(await doc.save());
}

async function settled(page: Page): Promise<void> {
  // La pantalla entra con un fundido: se espera a que termine para medir.
  await expect
    .poll(() =>
      page.evaluate(() => {
        for (let el: Element | null = document.querySelector('section[aria-labelledby="download-title"]'); el; el = el.parentElement) {
          if (getComputedStyle(el).opacity !== "1") return false;
        }
        return true;
      }),
    )
    .toBe(true);
}

test("Firmar: la descripcion de «Descargar» lee el resumen, el titulo y cada aviso UNA vez", async ({ page }) => {
  await page.goto("/sign-pdf");
  await page
    .locator('input[type="file"][accept*="pdf"]')
    .first()
    .setInputFiles({ name: "compartido.pdf", mimeType: "application/pdf", buffer: await makeSharedTitlePdf() });
  await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: SG.toolEditText }).click();
  const title = page.locator('[data-block-layer] [aria-label*="Receipt from"]').first();
  await title.waitFor({ timeout: 20_000 });
  await title.dblclick();
  const editor = page.locator("[data-inline-editor]");
  await expect(editor).toBeVisible();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Recibo editado");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: SG.toolSelect }).click();
  await page.getByRole("button", { name: "Procesar" }).click();
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
  await settled(page);

  const description = await expectDescriptionWithoutRepeats(page);
  // Y sigue diciendo lo importante: el resumen, el motivo y la salida recomendada.
  expect(description).toContain("no se pudo quitar el original");
  expect(description).toContain("Sobre el texto editado");
  expect(description).toContain("Aplanar página");
});

test("Editar PDF: la descripcion de «Descargar» lee el resumen, el titulo y cada aviso UNA vez", async ({ page }) => {
  await page.goto("/edit-pdf");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "compartido.pdf", mimeType: "application/pdf", buffer: await makeSharedTitlePdf() });
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
  const block = page.getByRole("button", { name: /^Texto: Receipt from/ });
  await expect(block).toBeVisible({ timeout: 30_000 });
  await block.dblclick();
  const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Recibo editado");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Procesar" }).first().click();
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 120_000 });
  await settled(page);

  const description = await expectDescriptionWithoutRepeats(page);
  expect(description).toContain("sigue bajo la edición");
});
