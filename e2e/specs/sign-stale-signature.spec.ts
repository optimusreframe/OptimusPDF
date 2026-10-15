import { expect, test, type Locator, type Page } from "@playwright/test";
import { makeReceiptPdf } from "../../src/lib/pdf/testing/signSyntheticPdfs";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import {
  collectFirstSigner,
  continueToSign,
  defineSigners,
  handoffHeading,
  makeTwoDocs,
  openSignAndUpload,
  placeSlot,
  placeSlotsInSingleDocument,
  signWholeTurn,
  turnCounter,
} from "../helpers/sign-flow";

/**
 * Firmar PDF · una firma ya hecha que deja de valer (F0-fix, D7).
 *
 * Si se edita el texto del documento (o se cambian sus huecos de firma) DESPUES de que alguien ya firmo, su firma deja de
 * valer (el sello por documento ya no coincide). La pantalla tiene que decir QUE paso y QUIEN debe firmar de nuevo, en la
 * ceremonia y en la lista de la ronda, y el turno vuelve a esa persona.
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3861 npx playwright test sign-stale-signature --project=chromium
 *
 * Headless siempre (modo por defecto de Playwright).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(180_000);

const SG = SIGN_STRINGS.es;
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const EDITED_TITLE = "Recibo editado por Optimus";
const FRASE_TEXTO = "La firma de Ana ya no es válida porque cambiaste el texto del documento: Ana debe volver a firmar.";
const FRASE_HUECOS = "La firma de Ana ya no es válida porque cambiaste los huecos de firma del documento: Ana debe volver a firmar.";

async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (scope) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run({ include: [scope] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}`);
  }, selector);
}

/** «Editar texto» -> el titulo del recibo -> `text`. Con el dedo, un toque selecciona y el siguiente edita. */
async function editTitle(page: Page, text: string, touch: boolean): Promise<void> {
  await page.getByRole("button", { name: SG.toolEditText }).click();
  const title: Locator = page.locator('[data-block-layer] [aria-label*="Receipt from"]').first();
  await title.waitFor({ timeout: 20_000 });
  if (touch) {
    await title.tap();
    await title.tap();
  } else {
    await title.dblclick();
  }
  const editor = page.locator("[data-inline-editor]");
  await expect(editor).toBeVisible();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  await expect(editor).toContainText(text);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: SG.toolSelect }).click();
  await expect(page.locator("[data-edit-text-panel]")).toContainText(SG.editTextCount(1));
}

test.describe("D7 · una firma que dejo de valer", () => {
  test("(d7-text) UN documento: Ana firma, se edita el texto original, y la pantalla dice que su firma ya no vale y que Ana debe volver a firmar", async ({ page }, testInfo) => {
    const touch = (testInfo.project.use as { hasTouch?: boolean }).hasTouch === true;
    const receipt = { name: "Recibo.pdf", mimeType: "application/pdf" as const, buffer: Buffer.from(await makeReceiptPdf()) };
    await page.goto("/");
    await openSignAndUpload(page, [receipt]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await continueToSign(page);
    // Ana firma y le pasa el aparato a Luis.
    await signWholeTurn(page, 1, 10, false);
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
    await expect(handoffHeading(page, "Luis")).toBeVisible();
    await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);

    // Se vuelve al documento y se edita el texto ORIGINAL: el sello de Ana ya no coincide.
    await page.getByRole("button", { name: "2. Documento" }).click();
    await editTitle(page, EDITED_TITLE, touch);
    await continueToSign(page);

    const notice = page.locator("[data-stale-signatures]");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(FRASE_TEXTO);
    // El turno VUELVE a Ana (aunque iba por Luis) y la lista de la ronda dice por que esta pendiente.
    await expect(handoffHeading(page, "Ana")).toBeVisible();
    await expect(turnCounter(page)).toHaveText("Turno 1 de 2");
    const row = page.locator('[data-stale-signer="sg-1"]');
    await expect(row).toContainText("Debe volver a firmar · cambió el texto del documento");
    // Luis nunca firmo: sigue «Sin firmar», sin aviso de «volver a firmar».
    await expect(notice).not.toContainText("Luis");
    expect(await axeViolations(page, "[data-stale-signatures]")).toEqual([]);
    expect(await axeViolations(page, '[data-stale-signer="sg-1"]'), "fila de la ronda con el motivo").toEqual([]);

    // Ana firma de nuevo sobre el documento ya editado: desaparece su aviso y la ronda sigue con Luis.
    await signWholeTurn(page, 1, 15, false);
    await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);
    await expect(handoffHeading(page, "Luis")).toBeVisible();
    await signWholeTurn(page, 1, 25, true);
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  });

  test("(d7-huecos) VARIOS documentos: se añade un hueco despues de que Ana firmo; el aviso dice «los huecos de firma», el turno vuelve a Ana, y pasa axe en claro/ES y oscuro/EN/375 px", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect(handoffHeading(page, "Luis")).toBeVisible();

    // Vuelve al paso Documento (se queda en el documento 1) y suma un hueco mas para Ana.
    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Ana", 160);
    await continueToSign(page);

    const notice = page.locator("[data-stale-signatures]");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(FRASE_HUECOS);
    await expect(handoffHeading(page, "Ana")).toBeVisible();
    const row = page.locator('[data-stale-signer="sg-1"]');
    await expect(row).toContainText("Debe volver a firmar · cambiaron los huecos de firma");
    expect(await axeViolations(page, "[data-stale-signatures]")).toEqual([]);
    expect(await axeViolations(page, '[data-stale-signer="sg-1"]'), "fila de la ronda con el motivo").toEqual([]);

    // Claro/ES/1280 ya medido; ahora oscuro, ingles y 375 px sobre la MISMA sesion (se restaura sola desde `?s=`).
    await expect.poll(() => new URL(page.url()).searchParams.get("s")).toMatch(/^s-/);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      window.localStorage.setItem("optimuspdf.theme", "dark");
      window.localStorage.setItem("optimuspdf.language", "en");
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    const noticeEn = page.locator("[data-stale-signatures]");
    await expect(noticeEn).toContainText("Ana's signature is no longer valid because you changed the signature spots of the document: Ana must sign again.", { timeout: 20_000 });
    await expect(page.locator('[data-stale-signer="sg-1"]')).toContainText("Must sign again · the signature spots changed");
    await page.waitForTimeout(600);
    expect(await axeViolations(page, "[data-stale-signatures]")).toEqual([]);
    expect(await axeViolations(page, '[data-stale-signer="sg-1"]'), "fila de la ronda con el motivo").toEqual([]);
    const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
  });
});
