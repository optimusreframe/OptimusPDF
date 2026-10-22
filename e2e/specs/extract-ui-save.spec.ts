import { expect, test, type Locator, type Page } from "@playwright/test";
import { readVault } from "../helpers/sign-vault-flow";
import { openAndRun, seedVault } from "../helpers/extract-ui-flow";

/**
 * «Guardar en Firmas guardadas» desde el Extractor (F7 · U7.4): tipo (firma / iniciales) y firmante (uno que ya esta en el
 * baul o «Nuevo firmante»). UNA entrada = un firmante con su firma y sus iniciales: guardar iniciales para quien ya tiene
 * firma COMPLETA su entrada; si ya tiene ese tipo, se elige «Reemplazar» o «Guardar como otro firmante». Se prueba contra
 * el IndexedDB real del navegador. Headless siempre; chromium y (PW_BROWSERS=webkit-ipad) iPad.
 */

test.setTimeout(120_000);

const SIGNATURE_CARD = /^Guardar en Firmas guardadas: Firma, página 3/;
const SECOND_SIGNATURE_CARD = /^Guardar en Firmas guardadas: Firma probable, página 4/;
const INITIALS_CARD = /^Guardar en Firmas guardadas: Iniciales probables/;

async function openSheet(page: Page, card: RegExp): Promise<Locator> {
  await page.getByRole("button", { name: card }).click();
  const sheet = page.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
  await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
  return sheet;
}

/** Elige el firmante por su nombre (el radio lleva su nombre y lo que ya tiene). */
async function pickSigner(sheet: Locator, name: string): Promise<void> {
  await sheet.getByRole("radio", { name: new RegExp(`^${name}`) }).check();
}

async function saveNew(page: Page, card: RegExp, name: string, role = ""): Promise<Locator> {
  const sheet = await openSheet(page, card);
  await sheet.locator("[data-extract-save-name]").fill(name);
  if (role) await sheet.getByLabel("Cargo (opcional)").fill(role);
  await sheet.locator("[data-extract-save-submit]").click();
  await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
  await sheet.getByRole("button", { name: "Cerrar", exact: true }).first().click();
  await expect(sheet).toBeHidden();
  return sheet;
}

test.describe("extract-assets · guardar en Firmas guardadas (tipo + firmante)", () => {
  test("firmante nuevo con firma; despues, las iniciales al MISMO firmante dejan UNA entrada con ambas", async ({ page }) => {
    await openAndRun(page, { fileName: "Contrato Pérez.pdf" });
    await saveNew(page, SIGNATURE_CARD, "Ana Pérez", "Ajustadora");
    let rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].signatureHash).not.toBeNull();
    expect(rows[0].initialsHash).toBeNull();
    const id = rows[0].id;

    const sheet = await openSheet(page, INITIALS_CARD);
    // Las iniciales se proponen como tipo y la lista ofrece a Ana con su cargo y lo que ya tiene.
    await expect(sheet.getByRole("radio", { name: "Iniciales", exact: true })).toBeChecked();
    await expect(sheet.getByRole("radio", { name: /^Ana Pérez · Ajustadora/ })).toBeVisible();
    await pickSigner(sheet, "Ana Pérez");
    await expect(sheet.locator("[data-extract-save-name]")).toHaveCount(0);
    await expect(sheet.locator("[data-extract-conflict]")).toHaveCount(0);
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Iniciales añadidas a Ana Pérez");
    rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].signatureHash).not.toBeNull();
    expect(rows[0].initialsHash).not.toBeNull();
    expect(rows[0].role).toBe("Ajustadora");
    expect(rows[0].origin).toBe("extracted");
    expect(rows[0].sourceDocument).toBe("Contrato Pérez.pdf");
  });

  test("si el firmante ya tiene ese tipo hay que elegir: sin elegir no se guarda; «Reemplazar» cambia la imagen y conserva la entrada", async ({ page }) => {
    await openAndRun(page);
    await saveNew(page, SIGNATURE_CARD, "Ana Pérez");
    const before = (await readVault(page))[0];
    const sheet = await openSheet(page, SECOND_SIGNATURE_CARD);
    await pickSigner(sheet, "Ana Pérez");
    const conflict = sheet.locator("[data-extract-conflict]");
    await expect(conflict).toContainText("Ana Pérez ya tiene firma");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(conflict).toContainText("Elige si reemplazas la actual o la guardas como otro firmante.");
    expect((await readVault(page)).length).toBe(1);
    await conflict.getByRole("radio", { name: "Reemplazar la actual" }).check();
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Se reemplazó la firma de Ana Pérez.");
    const rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].signatureHash).not.toBe(before.signatureHash);
  });

  test("«Guardar como otro firmante» pide un nombre DISTINTO y crea una segunda entrada sin tocar la primera", async ({ page }) => {
    await openAndRun(page);
    await saveNew(page, SIGNATURE_CARD, "Ana Pérez");
    const before = (await readVault(page))[0];
    const sheet = await openSheet(page, SECOND_SIGNATURE_CARD);
    await pickSigner(sheet, "Ana Pérez");
    await sheet.getByRole("radio", { name: "Guardar como otro firmante" }).check();
    // Sin nombre, y con el mismo nombre (aunque cambie el acento o las mayusculas), se rechaza.
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.getByText("Escribe el nombre de quien firma.")).toBeVisible();
    await sheet.locator("[data-extract-save-name]").fill("ana perez");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.getByText(/Ya hay un firmante con ese nombre/)).toBeVisible();
    await sheet.locator("[data-extract-save-name]").fill("Beatriz Ruiz");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Guardada en Firmas guardadas: Beatriz Ruiz.");
    const rows = await readVault(page);
    expect(rows.map((row) => row.signerName).sort()).toEqual(["Ana Pérez", "Beatriz Ruiz"]);
    expect(rows.find((row) => row.signerName === "Ana Pérez")!.signatureHash).toBe(before.signatureHash);
  });

  test("un firmante NUEVO con el nombre de uno existente se rechaza: se elige en la lista", async ({ page }) => {
    await openAndRun(page);
    await saveNew(page, SIGNATURE_CARD, "Ana Pérez");
    const sheet = await openSheet(page, INITIALS_CARD);
    await sheet.locator("[data-extract-save-name]").fill("Ana Pérez");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.getByText(/Ya hay un firmante con ese nombre/)).toBeVisible();
    expect(await readVault(page)).toHaveLength(1);
  });

  test("el firmante existente se elige con el teclado (flechas entre los radios) y el tipo con 44 px de alto", async ({ page }) => {
    await openAndRun(page);
    await saveNew(page, SIGNATURE_CARD, "Ana Pérez");
    await saveNew(page, SECOND_SIGNATURE_CARD, "Beatriz Ruiz");
    const sheet = await openSheet(page, INITIALS_CARD);
    const newSigner = sheet.getByRole("radio", { name: "Nuevo firmante" });
    await expect(newSigner).toBeChecked();
    // El selector de tipo: fichas de 44 px.
    for (const name of ["Firma", "Iniciales"]) {
      const box = (await sheet.getByRole("radio", { name, exact: true }).locator("xpath=..").boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
    await newSigner.focus();
    await page.keyboard.press("ArrowUp");
    const checked = sheet.locator('[data-extract-signers] input[type="radio"]:checked');
    await expect(checked).not.toHaveAttribute("data-signer-option", "new");
    await expect(sheet.locator("[data-extract-save-name]")).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect(newSigner).toBeChecked();
    await expect(sheet.locator("[data-extract-save-name]")).toBeVisible();
    // Elegir a uno existente con teclado y guardar completa SU entrada.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await sheet.locator("[data-extract-save-submit]").focus();
    await page.keyboard.press("Enter");
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Iniciales añadidas a");
    const rows = await readVault(page);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.initialsHash !== null)).toHaveLength(1);
  });

  test("baul lleno (30 firmas): un firmante nuevo se rechaza con un mensaje claro; completar uno existente SI cabe", async ({ page }) => {
    await openAndRun(page);
    await saveNew(page, SIGNATURE_CARD, "Ana Pérez");
    await seedVault(page, 29);
    expect(await readVault(page)).toHaveLength(30);
    const sheet = await openSheet(page, SECOND_SIGNATURE_CARD);
    await expect(sheet.getByText(/Firmas guardadas está lleno \(30 firmas\)/)).toBeVisible();
    await sheet.locator("[data-extract-save-name]").fill("Nuevo Firmante");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.getByText(/No hay espacio en Firmas guardadas \(máximo 30 firmas y 20 MB\)/)).toBeVisible();
    expect(await readVault(page)).toHaveLength(30);
    // Completar la entrada de alguien que ya esta: no ocupa una entrada nueva.
    await pickSigner(sheet, "Ana Pérez");
    await sheet.getByRole("radio", { name: "Reemplazar la actual" }).check();
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toBeVisible();
    expect(await readVault(page)).toHaveLength(30);
  });

  test("«Recortar otra» cierra la hoja y lleva a la pestana de recorte", async ({ page }) => {
    await openAndRun(page);
    const sheet = await openSheet(page, SIGNATURE_CARD);
    await sheet.locator("[data-extract-save-name]").fill("Ana Pérez");
    await sheet.locator("[data-extract-save-submit]").click();
    await sheet.getByRole("button", { name: "Recortar otra" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("tab", { name: "Recortar región" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-region-rect]")).toBeVisible({ timeout: 30_000 });
  });

  test("English: the same flow with its own texts", async ({ page }) => {
    await openAndRun(page, { lang: "en" });
    await page.getByRole("button", { name: /^Save to Saved signatures: Signature, page 3/ }).click();
    const sheet = page.getByRole("dialog", { name: "Save to Saved signatures" });
    await expect(sheet.locator("[data-extract-save-preview]")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("radio", { name: "New signer" })).toBeChecked();
    await sheet.locator("[data-extract-save-name]").fill("Ann Smith");
    await sheet.locator("[data-extract-save-submit]").click();
    await expect(sheet.locator("[data-extract-save-done]")).toContainText("Saved to Saved signatures: Ann Smith.");
    await expect(sheet.getByRole("link", { name: "View in Saved signatures" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Crop another" })).toBeVisible();
  });
});
