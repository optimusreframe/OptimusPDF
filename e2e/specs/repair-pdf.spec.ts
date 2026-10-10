import { expect, openTool, runAndDownload, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageText, requiresPassword } from "../helpers/pdf-inspection";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { pdfUpload } from "../helpers/test-files";

/**
 * Reparar PDF con un PDF «solo propietario» (cifrado que restringe imprimir/copiar pero se abre sin
 * contrasena): antes se rechazaba como «cifrado»; ahora se repara una copia sin cifrar, con aviso.
 * Con contrasena de usuario sigue rechazandose en claro.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

async function encrypted(userPassword: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n += 1) {
    document.addPage([300, 400]).drawText(`RESTRINGIDO-${n}`, { x: 24, y: 200, size: 16, font });
  }
  document.encrypt({ userPassword, ownerPassword: "propietaria-1", permissions: { printing: false, copying: false } });
  return Buffer.from(await document.save());
}

test.describe("repair-pdf · cifrado", () => {
  test("solo propietario: se repara una copia sin cifrar y se avisa", async ({ page }) => {
    await openTool(page, "repair-pdf");
    await uploadFiles(page, pdfUpload("restringido.pdf", await encrypted("")));
    const { bytes, filename } = await runAndDownload(page, { timeout: 60_000 });
    expect(filename).toBe("restringido-reparado.pdf");
    await expect(page.getByText(/cifrado de solo propietario/)).toBeVisible();
    expect(await requiresPassword(bytes)).toBe(false);
    expect(await getPageCount(bytes)).toBe(2);
    expect(await getPageText(bytes, 2)).toContain("RESTRINGIDO-2");
  });

  test("con contrasena de usuario sigue diciendo que esta cifrado y no ofrece descargar", async ({ page }) => {
    await openTool(page, "repair-pdf");
    await uploadFiles(page, pdfUpload("cerrado.pdf", await encrypted("secreta-1")));
    await expect(page.getByText(/El documento está cifrado y no se puede reparar sin la contraseña/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Procesar", exact: true })).toBeDisabled();
  });
});
