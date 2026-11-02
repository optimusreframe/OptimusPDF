import { expect, test } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { imagePlacements } from "../helpers/pdf-placements";
import { optionsText } from "../helpers/sign-options";
import { fileInput, openSignAndUpload, placeSlot } from "../helpers/sign-flow";
import { makeReceiptPdf } from "../../src/lib/pdf/testing/signSyntheticPdfs";
import { makeContract } from "../helpers/template-pdfs";
import { STATUS, ALL_COVERED, card, collectEarly, status } from "../helpers/early-capture";
import { SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, SIGN_PDF_FEATURE_FLAGS_VERSION_KEY } from "../../src/app/sign-pdf/signFeatureFlags";

/**
 * Firmar PDF · recoger firma e iniciales ANTES y despues aplicar el AUTOMAPEO (que crea los campos por firmante): lo ya recogido
 * se respeta (ni se borra ni se pide de nuevo) y el automapeo SI se aplica -- los trazos son del firmante, no del documento, asi
 * que ya no cuentan como «documento ya trabajado». Contrato SINTETICO; headless siempre.
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3961 npx playwright test sign-early-capture-templates --project=chromium --workers=1
 */
test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
test.setTimeout(240_000);

test("(t1) recoger ANTES y pulsar «Detectar campos automáticamente»: aparecen los campos y Ana no vuelve a firmar", async ({ page }) => {
  // Sin aplicacion ni deteccion automaticas: la persona recoge primero y pide el automapeo ella, a mano.
  await page.addInitScript(
    ([key, versionKey]) => {
      window.localStorage.setItem(key, JSON.stringify({ autoDetectFields: false, autoApplyTemplates: false }));
      window.localStorage.setItem(versionKey, "2");
      window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
    },
    [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, SIGN_PDF_FEATURE_FLAGS_VERSION_KEY],
  );
  const contract = await makeContract({ label: "Zulu Unknown Agreement", pages: 3, signers: 1 });
  await page.goto("/sign-pdf");
  await fileInput(page).setInputFiles({ name: "Zulu Unknown.pdf", mimeType: "application/pdf", buffer: contract });
  await expect(page.getByText("Zulu Unknown.pdf").first()).toBeVisible();
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 1").fill("Ana");
  await expect(card(page, "sg-1").getByRole("button", { name: "Recoger firma e iniciales de Ana" })).toBeEnabled({ timeout: 30_000 });
  // Sin deteccion automatica: nadie ha puesto campos todavia.
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-template-notice]")).toHaveCount(0);

  await collectEarly(page, "sg-1", "Ana", 10);
  await expect(status(page, "sg-1")).toHaveText(STATUS.complete);

  // Ahora si: «Detectar campos automaticamente» pone los campos por firmante SOBRE lo ya recogido.
  await page.getByRole("button", { name: "2. Documento" }).click();
  await page.getByRole("button", { name: "Detectar campos automáticamente" }).click();
  const notices = page.locator("[data-template-notices]");
  await expect(notices).toContainText("Detectamos", { timeout: 30_000 });
  const title = (await notices.locator("[data-template-notice]").first().locator("p").first().innerText()).trim();
  const placed = Number(/Detectamos (\d+) campo/.exec(title)?.[1]);
  expect(placed).toBeGreaterThanOrEqual(1);
  // La firmante sigue siendo Ana (el automapeo no la renombra ni la sustituye) y sigue con todo recogido.
  await page.getByRole("button", { name: "1. Firmantes" }).click();
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue("Ana");
  await expect(status(page, "sg-1")).toHaveText(STATUS.complete);
  await expect(card(page, "sg-1").locator("[data-early-no-fields]")).toHaveCount(0);

  // Y la ceremonia no pide nada: todo lo que hacia falta ya estaba recogido.
  await page.getByRole("button", { name: "3. Firmar" }).click();
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await expect(page.locator("[data-all-covered]")).toHaveText(ALL_COVERED);
  await expect(page.getByRole("button", { name: "Listo, es mi turno" })).toHaveCount(0);
  const slots = Number(/(\d+) huecos? en total/.exec(await optionsText(page))?.[1]);
  expect(slots).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Firmar y descargar" }).click();
  await page.getByRole("button", { name: "No, dejar el nombre como está" }).click();
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
  const pdf = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Descargar" }).click();
  });
  // El PDF lleva las firmas e iniciales de Ana en TODOS los huecos que puso el automapeo.
  expect((await imagePlacements(pdf)).length).toBe(slots);
});

test("(t2) aplicar una plantilla guardada («Plantillas») despues de recoger: se aplica a los MISMOS firmantes y lo recogido se conserva", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1"));
  await page.goto("/");
  await openSignAndUpload(page, [{ name: "Recibo.pdf", mimeType: "application/pdf", buffer: Buffer.from(await makeReceiptPdf()) }]);
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 1").fill("Ana");
  await expect(card(page, "sg-1").getByRole("button", { name: "Recoger firma e iniciales de Ana" })).toBeEnabled({ timeout: 30_000 });

  // Una plantilla guardada con un hueco de Ana.
  await page.getByRole("button", { name: "2. Documento" }).click();
  await placeSlot(page, "Ana", 100);
  await page.getByRole("button", { name: "Guardar como plantilla", exact: true }).first().click();
  await page.getByLabel("Nombre de la plantilla").fill("Recibo estandar");
  await page.getByRole("button", { name: "Guardar plantilla" }).click();
  await expect(page.getByText("Plantilla guardada.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Despues Ana recoge su firma e iniciales y se aplica la plantilla.
  await page.getByRole("button", { name: "1. Firmantes" }).click();
  await collectEarly(page, "sg-1", "Ana", 10);
  await expect(status(page, "sg-1")).toHaveText(STATUS.complete);
  await page.getByRole("button", { name: "Plantillas", exact: true }).first().click();
  await page.getByRole("button", { name: "Aplicar", exact: true }).first().click();
  await page.getByRole("dialog", { name: "¿Aplicar esta plantilla?" }).getByRole("button", { name: "Sí, aplicar plantilla" }).click();
  await expect(page.getByRole("button", { name: "2. Documento" })).toHaveAttribute("aria-current", "step", { timeout: 30_000 });

  // Ana sigue siendo Ana, con todo recogido: la plantilla no la sustituyo por un firmante nuevo.
  await page.getByRole("button", { name: "1. Firmantes" }).click();
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue("Ana");
  await expect(status(page, "sg-1")).toHaveText(STATUS.complete);
  await expect(card(page, "sg-1").locator("[data-early-no-fields]")).toHaveCount(0);
  await page.getByRole("button", { name: "3. Firmar" }).click();
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await expect(page.locator("[data-all-covered]")).toHaveText(ALL_COVERED);
});
