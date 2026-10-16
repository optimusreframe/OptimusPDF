import { expect, test, type Page } from "@playwright/test";
import { makeContract, reexport } from "../helpers/template-pdfs";
import { PAGES, configureTwoSigners, notices } from "../helpers/template-session-flow";
import { storedDocuments } from "../helpers/template-flow";

/**
 * Firma agil · Fase 2 · F2-fix · A3c: «Reemplazar PDF» en «Mis documentos» deja la plantilla desactualizada y NO se aplica a
 * ciegas en Firmar. Contratos sinteticos, navegador real, headless (Chromium y `webkit-ipad`).
 *
 *   - la plantilla se configura con el editor sobre el contrato A; en «Mis documentos» aparece como «Plantilla lista»;
 *   - se reemplaza el PDF por OTRO contrato (B): la tarjeta pasa a «Plantilla desactualizada» (icono + texto), con
 *     «Reconfigurar» y «Esta plantilla sigue valiendo»; reemplazar por el mismo contrato reexportado NO la desactualiza;
 *   - «Firmar» abre B en Firmar y NO le aplica la plantilla de A (ni con nivel exacto ni con el mapa identidad): avisa y,
 *     con «Varios firmantes», ofrece el automapeo;
 *   - «Esta plantilla sigue valiendo» quita el aviso y a partir de ahi se aplica; «Reconfigurar» + guardar tambien lo deja al dia.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(300_000);

const NAME = "Mold Test Agreement";
const card = (page: Page) => page.locator("[data-document-id]", { has: page.getByRole("heading", { level: 3, name: NAME, exact: true }) });
const state = (page: Page) => card(page).locator("[data-template-state]");

async function openDocuments(page: Page): Promise<void> {
  await page.goto("/documents");
  await expect(page.getByRole("heading", { level: 1, name: "Mis documentos" })).toBeVisible();
  await expect(card(page)).toBeVisible();
}

async function replacePdf(page: Page, buffer: Buffer): Promise<void> {
  await card(page).getByRole("button", { name: `Más acciones de ${NAME}` }).click();
  const menu = page.getByRole("dialog", { name: NAME });
  await expect(menu).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), menu.getByRole("button", { name: "Reemplazar PDF" }).click()]);
  await chooser.setFiles({ name: "nuevo.pdf", mimeType: "application/pdf", buffer });
}

async function setup(page: Page): Promise<{ a: Buffer; b: Buffer }> {
  const a = await makeContract({ label: NAME, pages: PAGES, signers: 2 });
  const b = await makeContract({ label: "Zulu Totally Different Agreement", pages: PAGES, signers: 2 });
  await configureTwoSigners(page, a, `${NAME}.pdf`);
  await openDocuments(page);
  await expect(state(page)).toHaveAttribute("data-template-state", "ready");
  return { a, b };
}

test("(A3c) reemplazar el PDF por otro contrato: la tarjeta pasa a «desactualizada» y «Firmar» no aplica la plantilla vieja a ciegas", async ({ page }) => {
  const { b } = await setup(page);
  await replacePdf(page, b);

  // Tarjeta: ni ✓ ni «lista»; icono + texto, y las dos salidas.
  await expect(state(page)).toHaveAttribute("data-template-state", "stale");
  await expect(card(page).getByText("Plantilla desactualizada")).toBeVisible();
  await expect(card(page).getByText("Plantilla lista (1 y 2 firmantes)")).toHaveCount(0);
  await expect(state(page).locator("svg")).toHaveCount(1);
  await expect(card(page).getByRole("button", { name: `Reconfigurar plantilla de ${NAME}` })).toBeVisible();
  const keep = card(page).getByRole("button", { name: `La plantilla de ${NAME} sigue valiendo` });
  await expect(keep).toBeVisible();
  for (const button of [keep, card(page).getByRole("button", { name: `Reconfigurar plantilla de ${NAME}` })]) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  expect((await storedDocuments(page))[0]).toMatchObject({ name: NAME });
  // El aviso se guardo de verdad: sobrevive a recargar.
  await page.reload();
  await expect(state(page)).toHaveAttribute("data-template-state", "stale");

  // «Firmar»: B se abre en Firmar y la plantilla de A NO se le aplica.
  await card(page).getByRole("button", { name: `Firmar ${NAME}` }).click();
  await expect(page).toHaveURL(/\/sign-pdf/);
  // El nombre de archivo es el del PDF de reemplazo (`nuevo.pdf`): el documento guardado ahora lleva ese archivo.
  await expect(page.getByText("La plantilla de «nuevo.pdf» está desactualizada")).toBeVisible({ timeout: 25_000 });
  await expect(notices(page).locator('[data-template-notice="applied"]')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Solo yo" })).toHaveAttribute("aria-selected", "true");
  // Con «Varios firmantes» se ofrece el automapeo (lo DETECTADO en B), no los campos de la plantilla de A.
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await expect(notices(page)).toContainText("Detectamos", { timeout: 25_000 });
  await expect(notices(page)).not.toContainText("Plantilla «");
});

test("(A3c-b) «Esta plantilla sigue valiendo» quita el aviso y, desde entonces, Firmar la aplica", async ({ page }) => {
  const { b } = await setup(page);
  await replacePdf(page, b);
  await expect(state(page)).toHaveAttribute("data-template-state", "stale");
  await card(page).getByRole("button", { name: `La plantilla de ${NAME} sigue valiendo` }).click();
  await expect(state(page)).toHaveAttribute("data-template-state", "ready");
  await expect(card(page).getByText("Plantilla desactualizada")).toHaveCount(0);
  await page.reload();
  await expect(state(page)).toHaveAttribute("data-template-state", "ready");
  await card(page).getByRole("button", { name: `Firmar ${NAME}` }).click();
  await expect(page).toHaveURL(/\/sign-pdf/);
  await expect(notices(page)).toContainText(`Plantilla «${NAME}» aplicada`, { timeout: 25_000 });
});

test("(A3c-c) «Reconfigurar» abre el editor con la plantilla; guardarla la deja al día", async ({ page }) => {
  const { b } = await setup(page);
  await replacePdf(page, b);
  await expect(state(page)).toHaveAttribute("data-template-state", "stale");
  await card(page).getByRole("button", { name: `Reconfigurar plantilla de ${NAME}` }).click();
  await expect(page).toHaveURL(/\/sign-pdf/);
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible({ timeout: 25_000 });
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.locator("[data-template-saved]")).toBeVisible();
  await openDocuments(page);
  await expect(state(page)).toHaveAttribute("data-template-state", "ready");
});

test("(A3c-d) reemplazar por el MISMO contrato reexportado no la desactualiza", async ({ page }) => {
  const { a } = await setup(page);
  await replacePdf(page, await reexport(a));
  await expect(page.locator("[data-documents-live]")).toContainText(`Se reemplazó el PDF de «${NAME}».`);
  await expect(state(page)).toHaveAttribute("data-template-state", "ready");
  await expect(card(page).getByText("Plantilla desactualizada")).toHaveCount(0);
});
