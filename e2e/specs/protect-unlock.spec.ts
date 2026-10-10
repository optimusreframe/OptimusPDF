import type { Page } from "@playwright/test";
import { expect, openTool, runAndDownload, runButton, test, uploadFiles } from "../helpers/tool-flow";
import {
  getPageCount,
  getPageText,
  getPermissions,
  PERMISSION,
  requiresPassword,
} from "../helpers/pdf-inspection";
import { hasPdfHeader } from "../helpers/pdf-structure";
import { makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Proteger PDF y Desbloquear PDF (W6-D): ida y vuelta con contrasena, con la
 * salida verificada con pdfjs (PasswordException con/sin contrasena correcta,
 * texto intacto, permisos) y casos limite: contrasena con acentos, solo
 * permisos sin contrasena de apertura, confirmacion distinta y contrasena
 * equivocada al desbloquear.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const password = (page: Page) => page.getByLabel("Contraseña", { exact: true });
const confirm = (page: Page) => page.getByLabel("Repite la contraseña", { exact: true });
const checkbox = (page: Page, name: RegExp | string) => page.getByRole("checkbox", { name });

/** Los Checkbox llevan la etiqueta encima del input: se alternan por la etiqueta, como un dedo. */
async function toggle(page: Page, text: string) {
  await page.locator("label", { hasText: text }).click();
}

async function unlockWith(page: Page, name: string, bytes: Buffer, secret: string) {
  await openTool(page, "unlock-pdf");
  await uploadFiles(page, pdfUpload(name, bytes));
  await page.getByLabel("Contraseña de apertura").fill(secret);
  await page.getByRole("button", { name: "Abrir y comprobar" }).click();
}

test.describe("protect-pdf + unlock-pdf", () => {
  test("ida y vuelta: proteger con contrasena y desbloquear devuelve el mismo contenido sin cifrar", async ({ page }) => {
    const original = await makePdf({ pages: 3, label: "SECRETO", size: [280, 380] });

    await openTool(page, "protect-pdf");
    await uploadFiles(page, pdfUpload("Contrato (final).pdf", original));
    await expect(runButton(page)).toBeDisabled(); // sin contrasena no hay nada que cifrar
    await password(page).fill("clave-segura-77");
    await confirm(page).fill("clave-segura-77");
    const protectedOut = await runAndDownload(page);
    expect(protectedOut.filename).toBe("Contrato (final)-protegido.pdf");
    expect(hasPdfHeader(protectedOut.bytes)).toBe(true);

    // Cifrado de verdad: sin contrasena y con una mala pdfjs lo rechaza; con la buena se abre.
    expect(await requiresPassword(protectedOut.bytes)).toBe(true);
    expect(await requiresPassword(protectedOut.bytes, "otra-clave")).toBe(true);
    expect(await requiresPassword(protectedOut.bytes, "clave-segura-77")).toBe(false);
    expect(await getPageCount(protectedOut.bytes, "clave-segura-77")).toBe(3);
    expect(await getPageText(protectedOut.bytes, 2, "clave-segura-77")).toContain("SECRETO-2");

    // Vuelta: Desbloquear con la contrasena.
    await unlockWith(page, protectedOut.filename, protectedOut.bytes, "clave-segura-77");
    await expect(runButton(page)).toBeEnabled();
    const unlocked = await runAndDownload(page);
    expect(unlocked.filename).toBe("Contrato (final)-protegido-desbloqueado.pdf");
    expect(await requiresPassword(unlocked.bytes)).toBe(false);
    expect(await getPageCount(unlocked.bytes)).toBe(3);
    for (const n of [1, 2, 3]) expect(await getPageText(unlocked.bytes, n)).toContain(`SECRETO-${n}`);
    expect(await getPermissions(unlocked.bytes)).toBeNull();
  });

  test("contrasena con acentos (Latin-1): se abre con ella y solo con ella, y Desbloquear la acepta", async ({ page }) => {
    const secret = "contraseña-ñandú-7";
    await openTool(page, "protect-pdf");
    await uploadFiles(page, pdfUpload("acentos.pdf", await makePdf({ pages: 1, label: "ACENTO" })));
    await password(page).fill(secret);
    await confirm(page).fill(secret);
    const { bytes } = await runAndDownload(page);
    expect(await requiresPassword(bytes)).toBe(true);
    expect(await requiresPassword(bytes, secret)).toBe(false);
    expect(await getPageText(bytes, 1, secret)).toContain("ACENTO-1");

    await unlockWith(page, "acentos-protegido.pdf", bytes, secret);
    const unlocked = await runAndDownload(page);
    expect(await requiresPassword(unlocked.bytes)).toBe(false);
    expect(await getPageText(unlocked.bytes, 1)).toContain("ACENTO-1");
  });

  // Regresion W6-D (corregido): una contrasena con caracteres fuera de Latin-1 hacia fallar `document.encrypt`
  // y la herramienta mostraba «El PDF esta protegido con contrasena», que describia otro problema. El cifrado
  // del PDF (RC4/AES-128) solo guarda bytes Latin-1, asi que ahora se avisa EN LINEA, antes de procesar,
  // senalando los caracteres, y Procesar queda desactivado.
  test("contrasena con caracteres fuera de Latin-1 (€, chino, emoji): aviso en linea con los caracteres, Procesar desactivado y nunca «ya esta protegido»", async ({ page }) => {
    await openTool(page, "protect-pdf");
    await uploadFiles(page, pdfUpload("euro.pdf", await makePdf({ pages: 1, label: "EUR" })));
    await password(page).fill("clave€7密😀");
    await confirm(page).fill("clave€7密😀");
    await expect(runButton(page)).toBeDisabled();
    const reason = page.getByText(/La contraseña solo puede contener caracteres Latin-1/).first();
    await expect(reason).toBeVisible();
    await expect(reason).toContainText("€ 密 😀");
    await expect(page.locator("[data-error-banner]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("protegido con contraseña");

    // Quitando esos caracteres se puede proteger y se abre con la contrasena.
    await password(page).fill("clave-7");
    await confirm(page).fill("clave-7");
    await expect(runButton(page)).toBeEnabled();
    const { bytes } = await runAndDownload(page);
    expect(await requiresPassword(bytes, "clave-7")).toBe(false);
    expect(await requiresPassword(bytes)).toBe(true);
  });

  test("confirmacion distinta: aviso, Procesar desactivado con motivo; al igualarlas se habilita", async ({ page }) => {
    await openTool(page, "protect-pdf");
    await uploadFiles(page, pdfUpload("c.pdf", await makePdf({ pages: 1 })));
    await password(page).fill("abcd1234");
    await confirm(page).fill("abcd12");
    await expect(page.getByText("Las dos contraseñas no coinciden.").first()).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
    await confirm(page).fill("abcd1234");
    await expect(runButton(page)).toBeEnabled();
    await password(page).fill("ab");
    await confirm(page).fill("ab");
    await expect(page.getByText("Usa al menos 4 caracteres.").first()).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
  });

  test("solo restricciones (sin contrasena de apertura): abre sin pedirla, sin permiso de imprimir ni copiar; Desbloquear lo libera", async ({ page }) => {
    await openTool(page, "protect-pdf");
    await uploadFiles(page, pdfUpload("permisos.pdf", await makePdf({ pages: 2, label: "PERM" })));
    await password(page).fill("duena-1234");
    await confirm(page).fill("duena-1234");
    await toggle(page, "Requiere contraseña para abrir el archivo");
    await expect(checkbox(page, /Requiere contraseña para abrir/)).not.toBeChecked();
    await toggle(page, "Imprimir");
    await toggle(page, "Copiar texto e imágenes");
    await expect(checkbox(page, "Imprimir")).not.toBeChecked();
    const protectedOut = await runAndDownload(page);

    expect(await requiresPassword(protectedOut.bytes)).toBe(false);
    const flags = await getPermissions(protectedOut.bytes);
    expect(flags).not.toBeNull();
    expect(flags).not.toContain(PERMISSION.PRINT);
    expect(flags).not.toContain(PERMISSION.COPY);
    expect(flags).toContain(PERMISSION.MODIFY_ANNOTATIONS);
    expect(await getPageText(protectedOut.bytes, 1)).toContain("PERM-1");

    // Desbloquear: no pide contrasena y la salida ya no lleva restricciones.
    await openTool(page, "unlock-pdf");
    await uploadFiles(page, pdfUpload(protectedOut.filename, protectedOut.bytes));
    await expect(runButton(page)).toBeEnabled({ timeout: 30_000 });
    const unlocked = await runAndDownload(page);
    expect(await getPermissions(unlocked.bytes)).toBeNull();
    expect(await getPageCount(unlocked.bytes)).toBe(2);
  });

  test("desbloquear con una contrasena equivocada avisa y no deja procesar; con la buena, si", async ({ page }) => {
    const bytes = await makePdf({ pages: 1, label: "SEC", userPassword: "correcta-99" });
    await unlockWith(page, "cerrado.pdf", bytes, "equivocada");
    await expect(page.getByText("Esa contraseña no abre el documento. Revísala y vuelve a intentarlo.")).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
    await page.getByLabel("Contraseña de apertura").fill("correcta-99");
    await page.getByRole("button", { name: "Abrir y comprobar" }).click();
    await expect(runButton(page)).toBeEnabled();
    const { bytes: out, filename } = await runAndDownload(page);
    expect(filename).toBe("cerrado-desbloqueado.pdf");
    expect(await requiresPassword(out)).toBe(false);
    expect(await getPageText(out, 1)).toContain("SEC-1");
  });

  test("documento de 31 paginas: protegido y desbloqueado conserva todas las paginas", async ({ page }) => {
    await openTool(page, "protect-pdf");
    await uploadFiles(page, pdfUpload("largo.pdf", await makePdf({ pages: 31, label: "LG", size: [240, 320] })));
    await password(page).fill("largo-1234");
    await confirm(page).fill("largo-1234");
    const protectedOut = await runAndDownload(page);
    expect(await getPageCount(protectedOut.bytes, "largo-1234")).toBe(31);
    await unlockWith(page, protectedOut.filename, protectedOut.bytes, "largo-1234");
    const unlocked = await runAndDownload(page);
    expect(await getPageCount(unlocked.bytes)).toBe(31);
    expect(await getPageText(unlocked.bytes, 31)).toContain("LG-31");
  });
});

test.describe("protect-pdf · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("contrasena escrita en la hoja de opciones y descarga cifrada", async ({ page }) => {
    await openTool(page, "protect-pdf");
    await uploadFiles(page, pdfUpload("movil.pdf", await makePdf({ pages: 1, label: "MOV" })));
    await page.getByRole("button", { name: "Opciones", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Contraseña", { exact: true }).fill("movil-1234");
    await dialog.getByLabel("Repite la contraseña", { exact: true }).fill("movil-1234");
    await dialog.getByRole("button", { name: "Cerrar" }).first().click();
    await expect(dialog).toBeHidden();
    const { bytes } = await runAndDownload(page);
    expect(await requiresPassword(bytes)).toBe(true);
    expect(await getPageText(bytes, 1, "movil-1234")).toContain("MOV-1");
  });
});
