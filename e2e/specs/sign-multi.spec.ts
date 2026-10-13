import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts } from "../helpers/pdf-inspection";
import { stillBox } from "../helpers/engine";

/**
 * Firmar VARIOS documentos a la vez (Wave 4): dos PDF, dos firmantes, huecos en
 * cada documento, ceremonia por bloques y un ZIP con un PDF firmado por
 * documento. Mas retomar la sesion tras recargar.
 *
 * Headless siempre (es el modo por defecto de Playwright; no se abre ventana).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
// Cada caso hace de verdad la ronda completa en un navegador: margen amplio.
test.setTimeout(120_000);

const DOC_A = "Contrato A.pdf";
const DOC_B = "Anexo B.pdf";

async function makePdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 2; index += 1) {
    const page = doc.addPage([400, 300]);
    page.drawText(`${label} pagina ${index}`, { x: 40, y: 250, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

async function uploadTwoDocuments(page: Page) {
  await page.goto("/sign-pdf");
  await page.locator('input[type="file"][accept*="pdf"]').setInputFiles([
    { name: DOC_A, mimeType: "application/pdf", buffer: await makePdf("A") },
    { name: DOC_B, mimeType: "application/pdf", buffer: await makePdf("B") },
  ]);
  await expect(page.getByRole("button", { name: `1. ${DOC_A}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `2. ${DOC_B}` })).toBeVisible();
}

async function defineSigners(page: Page) {
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 1").fill("Ana");
  await page.getByLabel("Nombre del firmante 2").fill("Luis");
}

/** Coloca un hueco de firma del firmante dado sobre la pagina visible del lienzo. */
async function placeSlot(page: Page, signer: string, offsetY: number) {
  await page.getByRole("radio", { name: signer, exact: true }).click();
  await page.getByRole("toolbar").first().getByRole("button", { name: "Firma" }).click();
  const surface = page.locator('img[alt]:not([alt=""])').first();
  await surface.scrollIntoViewIfNeeded();
  // Quieta: tras cambiar de documento la hoja se repinta y WebKit tarda mas (un arrastre sobre la hoja vieja se pierde).
  const box = await stillBox(surface);
  if (!box) throw new Error("no se encontro la pagina del lienzo");
  await page.mouse.move(box.x + 60, box.y + offsetY);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + offsetY + 40, { steps: 5 });
  await page.mouse.up();
}

async function placeSlotsInBothDocuments(page: Page) {
  await page.getByRole("button", { name: "2. Documento" }).click();
  await placeSlot(page, "Ana", 100);
  await placeSlot(page, "Luis", 200);
  await page.getByRole("button", { name: `2. ${DOC_B}` }).click();
  await expect(page.getByRole("button", { name: `2. ${DOC_B}` })).toHaveAttribute("aria-current", "true");
  await expect(page.locator("[data-sequence-live]")).toContainText(`Documento 2 de 2: ${DOC_B}`);
  await placeSlot(page, "Ana", 100);
  await placeSlot(page, "Luis", 200);
  await expect(page.getByText("En este documento: 2 huecos").first()).toBeVisible();
}

async function drawSignature(page: Page) {
  const dialog = page.getByRole("dialog");
  const canvas = dialog.locator("canvas");
  // La hoja entra con un muelle: se espera a que el recuadro deje de moverse.
  let box = await canvas.boundingBox();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(100);
    const next = await canvas.boundingBox();
    if (box && next && next.x === box.x && next.y === box.y) break;
    box = next;
  }
  if (!box) throw new Error("no se encontro el lienzo de firma");
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 8 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 8 });
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Usar esta firma" }).click();
  // La hoja de firma se cierra con una animacion: la senal fiable es que el bloque ya tiene firma.
  await expect(page.getByRole("button", { name: "Ver cómo queda" })).toBeEnabled();
}

/** El turno de un firmante: pasa el dispositivo, crea la firma del bloque y la confirma. */
async function signTurn(page: Page, last: boolean) {
  await page.getByRole("button", { name: "Listo, es mi turno" }).first().click();
  await page.getByRole("button", { name: "Crear mi firma" }).click();
  await drawSignature(page);
  await page.getByRole("button", { name: "Ver cómo queda" }).click();
  await page
    .getByRole("button", { name: last ? "He terminado" : "Pasar al siguiente firmante" })
    .click();
}

/** «Firmar y descargar» procesa la ronda y deja la pantalla «Listo»: de ahi se descarga el .zip. */
async function signAndDownload(page: Page): Promise<Buffer> {
  await page.getByRole("button", { name: "Firmar y descargar" }).click();
  await expect(page.getByText("Firmados - 2 documentos.zip")).toBeVisible({ timeout: 60_000 });
  return downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Descargar" }).click();
  });
}

/** Cuantos borradores de SESION hay ahora mismo en IndexedDB (lo que ve el navegador). */
async function sessionDraftCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => resolve(-1);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("sessionMeta")) {
            db.close();
            resolve(-1);
            return;
          }
          const count = db.transaction("sessionMeta", "readonly").objectStore("sessionMeta").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
  );
}

test.describe("sign-pdf con varios documentos", () => {
  test("dos PDF, dos firmantes, ceremonia por bloques y un ZIP con un PDF firmado por documento", async ({ page }) => {
    await uploadTwoDocuments(page);
    await defineSigners(page);
    await placeSlotsInBothDocuments(page);
    await page.getByRole("button", { name: "Continuar" }).click();

    await signTurn(page, false);
    await signTurn(page, true);

    const bytes = await signAndDownload(page);

    // El resultado de varios documentos es UN zip con cada PDF por separado.
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      "Ana y Luis - Anexo B-firmado.pdf",
      "Ana y Luis - Contrato A-firmado.pdf",
    ]);

    for (const name of names) {
      const pdf = Buffer.from(await zip.file(name)!.async("uint8array"));
      // 2 paginas del documento + la pagina del certificado de finalizacion (activo por defecto).
      expect(await getPageCount(pdf)).toBe(3);
      // Pagina 1: las dos firmas (una imagen por hueco); pagina 2, sin huecos: ninguna.
      const first = await getPageOperatorCounts(pdf, 1);
      expect(first.imagePaintOps).toBe(2);
      const second = await getPageOperatorCounts(pdf, 2);
      expect(second.imagePaintOps).toBe(0);
    }
  });

  test("retomar la sesion tras recargar: los dos documentos, los firmantes y los huecos siguen ahi", async ({ page }) => {
    await uploadTwoDocuments(page);
    await defineSigners(page);
    await placeSlotsInBothDocuments(page);

    // El autoguardado tiene ~800 ms de calma: se espera al borrador REAL.
    await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);

    await page.reload();
    await expect(page.getByRole("button", { name: `1. ${DOC_A}` })).toHaveCount(0);

    await page.getByRole("button", { name: "Ver borradores" }).click();
    const sheet = page.getByRole("dialog", { name: "Borradores guardados" });
    await expect(sheet.getByText("2 documentos")).toBeVisible();
    await expect(sheet.getByText(`${DOC_A}, ${DOC_B}`)).toBeVisible();
    await sheet.getByRole("button", { name: "Reanudar" }).click();

    await expect(page.getByRole("button", { name: `1. ${DOC_A}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `2. ${DOC_B}` })).toBeVisible();
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue("Ana");
    await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue("Luis");
    // Los huecos de ambos documentos se conservaron.
    await expect(page.getByText("4 huecos de firma").first()).toBeVisible();

    // Y se puede seguir: la ceremonia se completa y descarga el ZIP.
    await page.getByRole("button", { name: "3. Firmar" }).click();
    await signTurn(page, false);
    await signTurn(page, true);
    const bytes = await signAndDownload(page);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toHaveLength(2);
  });

  test("recargar a los 100 ms de editar no pierde la ultima edicion (volcado en beforeunload)", async ({ page }) => {
    await uploadTwoDocuments(page);
    await defineSigners(page);
    await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
    // Una edicion y recarga casi inmediata: el debounce aun no ha disparado.
    await page.getByLabel("Nombre del firmante 2").fill("Luis Ultimo");
    await page.waitForTimeout(100);
    await page.reload();
    const lastName = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const request = indexedDB.open("optimuspdf-sign-drafts");
          request.onsuccess = () => {
            const db = request.result;
            const all = db.transaction("sessionMeta", "readonly").objectStore("sessionMeta").getAll();
            all.onsuccess = () => {
              db.close();
              resolve(all.result[0]?.signers?.[1]?.name ?? "");
            };
          };
        }),
    );
    expect(lastName).toBe("Luis Ultimo");
  });
});
