import { expect, test, type Page } from "@playwright/test";
import { roundCompleteHeading } from "../helpers/sign-flow";
import { makeContract, reexport } from "../helpers/template-pdfs";
import { PAGES, SIGNER_1_ROLE, SIGNER_2_ROLE, appliedAndBothSigned, configureTwoSigners, notices, signTurn, upload } from "../helpers/template-session-flow";

/**
 * Firma agil · Fase 2 · F2-fix (defectos MAYORES hallados por la verificacion independiente), navegador real, headless:
 *
 *   A1  cambiar el nº de firmantes con trabajo hecho (firma, iniciales, nombre real) NO lo descarta en silencio: pide
 *       confirmar; «Cancelar» conserva todo; «Quitar y cambiar» quita solo lo anunciado. Sin nada que perder: inmediato.
 *   A2  «Deshacer» del aviso «Plantilla ... aplicada» solo se ofrece mientras no haya trabajo de la persona; con firmas o
 *       nombres puestos el aviso queda informativo y nada se borra.
 *
 * Chromium por defecto; iPad: `PW_BROWSERS=webkit-ipad ... --project=webkit-ipad` con build de produccion y
 * `CSP_SKIP_UPGRADE_INSECURE=1`.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(300_000);

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "¿Cambiar a 1 firmante?" });
const goTo = async (page: Page, step: "1. Firmantes" | "3. Firmar") => page.getByRole("button", { name: step }).click();

test("(A1) con la firma y el nombre real del firmante 2, «1 firmante» pide confirmar: Cancelar conserva todo y Quitar y cambiar quita solo lo anunciado", async ({ page }, testInfo) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await appliedAndBothSigned(page, original, await reexport(original));

  // Volver a «1. Firmantes» y escribir un nombre real para el firmante 2 (el caso del verificador).
  await goTo(page, "1. Firmantes");
  await page.getByLabel("Nombre del firmante 2").fill("Marta Ruiz");
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();

  // Hoja de confirmacion: dice QUE se quita, con dos botones de >= 44 px y el foco dentro.
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Cambiar a 1 firmante quitará la firma de Marta Ruiz. ¿Continuar?");
  const confirm = dialog.getByRole("button", { name: "Quitar y cambiar" });
  const cancel = dialog.getByRole("button", { name: "Cancelar", exact: true });
  for (const button of [confirm, cancel]) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  // Mientras tanto NO se ha tocado nada: siguen los dos firmantes y el aviso sigue en «2 firmantes».
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue("Marta Ruiz");
  await expect(notices(page).getByRole("tab", { name: "2 firmantes" })).toHaveAttribute("aria-selected", "true");

  // Cancelar: todo sigue igual, tambien lo firmado.
  await cancel.click();
  await expect(dialog).toBeHidden();
  if (testInfo.project.name === "chromium") await expect(notices(page).getByRole("tab", { name: "1 firmante" })).toBeFocused();
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1_ROLE);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue("Marta Ruiz");
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`);
  await goTo(page, "3. Firmar");
  await expect(roundCompleteHeading(page)).toBeVisible();
  await expect(page.getByText(/Falta/)).toHaveCount(0);

  // Confirmar: se quita al firmante 2 (y su firma), no al 1.
  await goTo(page, "1. Firmantes");
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Quitar y cambiar" }).click();
  await expect(dialog).toBeHidden();
  await expect(notices(page)).toContainText(`1 firmante · ${PAGES + 1} campos en ${PAGES} páginas`);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveCount(0);
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1_ROLE);
  await goTo(page, "3. Firmar");
  // La firma y las iniciales del firmante 1 siguen valiendo: no hay nadie mas que firmar.
  await expect(roundCompleteHeading(page)).toBeVisible();

  // Volver a 2 firmantes no pregunta (no hay nada que perder) y trae un firmante nuevo, sin firmar.
  await goTo(page, "1. Firmantes");
  await notices(page).getByRole("tab", { name: "2 firmantes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2_ROLE);
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: `Pásale el dispositivo a ${SIGNER_2_ROLE}` })).toBeVisible();
});

test("(A1-b) sin nada que perder el cambio de firmantes es inmediato y sin diálogo", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await configureTwoSigners(page, original);
  await page.reload();
  await upload(page, "Mold Test.pdf", await reexport(original));
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`, { timeout: 20_000 });
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  // Solo firma el firmante 1; el 2 no ha hecho nada y conserva su nombre generico.
  await signTurn(page, 5, false);
  await goTo(page, "1. Firmantes");
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();
  await expect(notices(page)).toContainText(`1 firmante · ${PAGES + 1} campos`);
  await expect(dialogOf(page)).toHaveCount(0);
  await goTo(page, "3. Firmar");
  await expect(roundCompleteHeading(page)).toBeVisible();
});

test("(A2) «Deshacer» solo mientras no haya trabajo tuyo: con un nombre escrito o con firmas el aviso queda informativo y nada se borra", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await configureTwoSigners(page, original);
  await page.reload();
  await upload(page, "Mold Test.pdf", await reexport(original));
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`, { timeout: 20_000 });
  const undo = notices(page).getByRole("button", { name: "Deshacer", exact: true });
  await expect(undo).toBeVisible();

  // Un nombre real escrito: Deshacer ya no se ofrece; escribir de nuevo el del rol lo devuelve.
  await page.getByLabel("Nombre del firmante 1").fill("Ana López");
  await expect(undo).toHaveCount(0);
  await expect(notices(page).getByRole("button", { name: "Ir a firmar" })).toBeVisible();
  await page.getByLabel("Nombre del firmante 1").fill(SIGNER_1_ROLE);
  await expect(undo).toBeVisible();

  // Firmas recogidas: Deshacer tampoco se ofrece y NADA desaparece.
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  await signTurn(page, 5, false);
  await signTurn(page, 17, true);
  await expect(roundCompleteHeading(page)).toBeVisible();
  await goTo(page, "1. Firmantes");
  await expect(notices(page)).toContainText("Plantilla «Mold Test Agreement» aplicada");
  await expect(undo).toHaveCount(0);
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1_ROLE);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2_ROLE);
  await expect(page.getByRole("tab", { name: "Varios firmantes" })).toHaveAttribute("aria-selected", "true");
  await goTo(page, "3. Firmar");
  await expect(roundCompleteHeading(page)).toBeVisible();
});

test("(A2-b) sin trabajo hecho «Deshacer» sigue quitando lo que puso la plantilla (campos, firmantes y modo)", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await configureTwoSigners(page, original);
  await page.reload();
  await upload(page, "Mold Test.pdf", await reexport(original));
  await expect(notices(page)).toContainText("aplicada", { timeout: 20_000 });
  await notices(page).getByRole("button", { name: "Deshacer", exact: true }).click();
  await expect(page.locator("[data-template-notice]")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Solo yo" })).toHaveAttribute("aria-selected", "true");
});
