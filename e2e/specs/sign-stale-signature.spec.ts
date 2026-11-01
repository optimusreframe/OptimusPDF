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
 * Si se edita el texto del documento DESPUES de que alguien ya firmo, su firma deja de valer (el sello por documento ya no
 * coincide). Mover, redimensionar o añadir huecos NO invalida nada: la firma y las iniciales ya recogidas se conservan. La pantalla tiene que decir QUE paso y QUIEN debe firmar de nuevo, en la
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

  test("(d7-huecos) VARIOS documentos: mover y añadir huecos DESPUES de que Ana firmo NO le quita la firma ni las iniciales; el turno sigue con Luis", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect(handoffHeading(page, "Luis")).toBeVisible();
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");

    // Vuelve al paso Documento: ARRASTRA el hueco de Ana a otro sitio y suma otro hueco mas para ella.
    await page.getByRole("button", { name: "2. Documento" }).click();
    const anaSlot = page.locator('[data-element-kind="slot"][aria-label^="Ana"]').first();
    await anaSlot.scrollIntoViewIfNeeded();
    // La posicion se mide RELATIVA a la hoja: la ventana puede desplazarse mientras carga.
    const surface = page.locator('img[alt]:not([alt=""])').first();
    const offsetY = async (): Promise<number> => {
      const [slot, sheet] = await Promise.all([anaSlot.boundingBox(), surface.boundingBox()]);
      return slot && sheet ? slot.y - sheet.y : Number.NaN;
    };
    // Quieto: tras volver al paso Documento la hoja se repinta y se desplaza un momento; un arrastre sobre coordenadas viejas se pierde.
    let before = await anaSlot.boundingBox();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await page.waitForTimeout(150);
      const next = await anaSlot.boundingBox();
      if (before && next && next.x === before.x && next.y === before.y) break;
      before = next;
    }
    if (!before) throw new Error("no se encontro el hueco de Ana");
    const startOffset = await offsetY();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 120, { steps: 8 });
    await page.mouse.up();
    await expect.poll(offsetY).toBeGreaterThan(startOffset + 60);
    await placeSlot(page, "Ana", 400);
    await continueToSign(page);

    // Nada se pierde: sin aviso de «volver a firmar», el turno sigue con Luis y la fila de Ana no esta pendiente.
    await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);
    await expect(page.locator('[data-stale-signer="sg-1"]')).toHaveCount(0);
    await expect(handoffHeading(page, "Luis")).toBeVisible();
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
  });
});
