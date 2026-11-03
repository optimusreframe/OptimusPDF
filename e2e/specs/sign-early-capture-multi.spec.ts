import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { downloadBytes } from "../helpers/downloads";
import { imagePlacements } from "../helpers/pdf-placements";
import {
  DOC_B,
  continueToSign,
  defineSigners,
  draftRows,
  drawInOpenComposer,
  handoffHeading,
  makeOtherDoc,
  makeTwoDocs,
  mergedReviewHeading,
  openSignAndUpload,
  placeSlotsInBothDocuments,
  selectSignMode,
  signWholeTurn,
  turnCounter,
  uploadDocs,
  waitForDraftSettled,
} from "../helpers/sign-flow";
import { ALL_COVERED, NO_FIELDS_NOTE, STATUS, axeViolations, card, collectEarly, openPanel, placeInitialsSlot, status } from "../helpers/early-capture";

/**
 * Firmar PDF · recoger firma e iniciales ANTES o DESPUES de poner los campos con VARIOS documentos. Lo recogido va a los
 * grupos del firmante segun la tabla «¿Quien firma que?» y se sella por documento, aunque aun no haya huecos. Headless siempre.
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3961 npx playwright test sign-early-capture-multi --project=chromium --workers=1
 */
test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
test.setTimeout(240_000);

const ANA = "sg-1";
const LUIS = "sg-2";

/**
 * «Firmar y descargar» procesa la ronda y, al llegar a la pantalla «Listo», el .zip con un PDF por documento se descarga SOLO
 * (Ola 3): la descarga se espera ANTES de pulsar. El nombre del ZIP sale dos veces en pantalla (el archivo y «Se ha descargado
 * «…»»): se toma el texto entero. «Descargar» queda de respaldo.
 */
async function downloadZip(page: import("@playwright/test").Page): Promise<Record<string, Buffer>> {
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
  });
  await expect(page.getByText("Firmados - 2 documentos.zip", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible();
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, Buffer> = {};
  for (const name of Object.keys(zip.files).sort()) out[name] = Buffer.from(await zip.file(name)!.async("uint8array"));
  return out;
}

async function start(page: import("@playwright/test").Page, mode: "same" | "independent"): Promise<void> {
  await page.goto("/");
  await openSignAndUpload(page, await makeTwoDocs());
  await defineSigners(page);
  await selectSignMode(page, mode);
  await expect(card(page, ANA).getByRole("button", { name: "Recoger firma e iniciales de Ana" })).toBeEnabled({ timeout: 30_000 });
}

test.describe("varios documentos · las dos maneras", () => {
  test("(m1) «Una firma para todos»: recoger a Ana PRIMERO, poner campos en los dos documentos, firmar Luis en la ceremonia", async ({ page }) => {
    await start(page, "same");
    await expect(status(page, ANA)).toHaveText(STATUS.none);
    await collectEarly(page, ANA, "Ana", 10);
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await expect(card(page, ANA).locator("[data-early-no-fields]")).toHaveText(NO_FIELDS_NOTE);
    await expect(status(page, LUIS)).toHaveText(STATUS.none);
    // El borrador ya lleva la firma de Ana (un solo grupo) sin ningun hueco.
    await expect.poll(async () => (await draftRows(page)).map((row) => `${row.kind}:${row.strokes}:${row.fields}`).join(","), { timeout: 20_000 }).toBe("session:1:0");

    await placeSlotsInBothDocuments(page);
    await continueToSign(page);
    // Ana ya estaba cubierta: el turno es de Luis y no hay aviso de «volver a firmar».
    await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);
    await expect(handoffHeading(page, "Luis")).toBeVisible();
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
    await signWholeTurn(page, 1, 30, true);
    // Ola 3: con el ultimo firmante la revision y el boton final son UNA pantalla («Revisa y descarga»).
    await expect(mergedReviewHeading(page)).toBeVisible();

    // Cada PDF lleva 2 imagenes (la firma de Ana y la de Luis), en SU hueco.
    const files = await downloadZip(page);
    expect(Object.keys(files)).toHaveLength(2);
    for (const pdf of Object.values(files)) expect(await imagePlacements(pdf)).toHaveLength(2);
  });

  test("(m2) «Una firma para todos»: campos PRIMERO, recoger a los dos DESPUES: la ceremonia lo dice claro y no pide nada", async ({ page }) => {
    await start(page, "same");
    await placeSlotsInBothDocuments(page);
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.locator("[data-early-no-fields]")).toHaveCount(0);
    await collectEarly(page, ANA, "Ana", 10);
    await collectEarly(page, LUIS, "Luis", 20);
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await expect(status(page, LUIS)).toHaveText(STATUS.complete);

    await page.getByRole("button", { name: "3. Firmar" }).click();
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await expect(page.locator("[data-all-covered]")).toHaveText(ALL_COVERED);
    await expect(page.getByRole("button", { name: "Listo, es mi turno" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeEnabled();
    const files = await downloadZip(page);
    for (const pdf of Object.values(files)) expect(await imagePlacements(pdf)).toHaveLength(2);
  });

  test("(m3) «Una firma por documento»: dos grupos para Ana, uno por documento; recoger los dos grupos y poner campos despues", async ({ page }) => {
    await start(page, "independent");
    const panel = await openPanel(page, ANA, "Ana");
    // Con dos grupos cada fila lleva el nombre del grupo y sus documentos.
    await expect(panel.getByText(/^Firma A — para: Contrato A/)).toBeVisible();
    await expect(panel.getByText(/^Firma B — para: Anexo B/)).toBeVisible();

    // Solo el grupo A: Ana queda «a medias».
    await collectEarly(page, ANA, "Ana", 10, { group: "A", close: false });
    await expect(status(page, ANA)).toHaveText(STATUS.partial);
    await expect(panel).toContainText("Falta algo en alguno de los grupos");
    // El otro grupo.
    await collectEarly(page, ANA, "Ana", 30, { group: "B" });
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    // Luis tambien tiene un grupo por documento.
    await collectEarly(page, LUIS, "Luis", 50, { group: "A", close: false });
    await collectEarly(page, LUIS, "Luis", 70, { group: "B" });
    await expect(status(page, LUIS)).toHaveText(STATUS.complete);

    await placeSlotsInBothDocuments(page);
    // Con todos cubiertos no hay «Turno N de M» que esperar: se pasa al paso 3 directo.
    await page.getByRole("button", { name: "Continuar" }).click();
    // Nadie pendiente: los trazos de los dos grupos de Ana y el de Luis (que cubre ambos documentos) ya valen.
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await expect(page.locator("[data-all-covered]")).toHaveText(ALL_COVERED);
    const files = await downloadZip(page);
    for (const pdf of Object.values(files)) expect(await imagePlacements(pdf)).toHaveLength(2);
  });

  test("(m4) la ceremonia pide solo lo que falta: recogi la firma de Ana y hay un hueco de iniciales en cada documento", async ({ page }) => {
    await start(page, "same");
    await collectEarly(page, ANA, "Ana", 10, { signature: true, initials: false });
    await expect(status(page, ANA)).toHaveText(STATUS.signature);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeInitialsSlot(page, "Ana", 150);
    await page.getByRole("button", { name: `2. ${DOC_B}` }).click();
    await expect(page.getByRole("button", { name: `2. ${DOC_B}` })).toHaveAttribute("aria-current", "true");
    await placeInitialsSlot(page, "Ana", 150);
    await continueToSign(page);
    // Luis no tiene campos: Ana es la unica persona con turno y no hay traspaso, su captura se ve ya.
    await expect(handoffHeading(page, "Ana")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Firma de Ana" })).toBeVisible();
    await expect(page.getByText("Firma una sola persona: no hace falta pasar el dispositivo.")).toBeVisible();
    // La firma ya esta (no se vuelve a pedir); falta solo las iniciales.
    await expect(page.getByRole("button", { name: "Crear mi firma", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Crear mis iniciales", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ver cómo queda" })).toBeDisabled();
    await page.getByRole("button", { name: "Crear mis iniciales", exact: true }).click();
    await drawInOpenComposer(page, 44);
    await page.getByRole("button", { name: "Ver cómo queda" }).click();
    // Ola 3: pantalla unica «Revisa y descarga» (sin «He terminado»).
    await expect(mergedReviewHeading(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "He terminado" })).toHaveCount(0);
  });
});

test.describe("varios documentos · invalidacion, recarga y borrado", () => {
  test("(m5) recargar: lo recogido sobrevive (borrador de sesion); cambiar un documento por otro lo invalida", async ({ page }) => {
    await start(page, "same");
    await collectEarly(page, ANA, "Ana", 10);
    await waitForDraftSettled(page);
    await expect.poll(async () => (await draftRows(page)).map((row) => row.strokes).join(","), { timeout: 20_000 }).toBe("1");

    await page.reload();
    await expect(card(page, ANA).getByRole("button", { name: "Cambiar lo recogido de Ana" })).toBeVisible({ timeout: 30_000 });
    await expect(status(page, ANA)).toHaveText(STATUS.complete);

    // Se quita el documento B y se sube otro distinto: la firma de Ana no la vio sobre ese documento -> debe volver a firmar.
    await page.getByRole("button", { name: "Quitar", exact: true }).nth(1).click();
    await uploadDocs(page, [await makeOtherDoc("Otro anexo.pdf", "Z")]);
    // Se quita un documento y entra otro: el nuevo nadie lo vio, y el estado lo dice con su propio motivo.
    await expect(status(page, ANA)).toHaveText(STATUS.staleAdded, { timeout: 20_000 });
    await expect(page.locator("[data-stale-signatures]")).toContainText("La firma de Ana ya no es válida porque se añadió un documento a lo que firma");
    expect(await axeViolations(page, '[data-early-capture="sg-1"]')).toEqual([]);
  });

  test("(m6) quitar a un firmante quita sus trazos de todos los grupos y «Borrar datos» vacia el borrador", async ({ page }) => {
    await start(page, "independent");
    await collectEarly(page, ANA, "Ana", 10, { group: "A" });
    await collectEarly(page, ANA, "Ana", 20, { group: "B" });
    await collectEarly(page, LUIS, "Luis", 40, { group: "A" });
    await expect.poll(async () => (await draftRows(page)).map((row) => row.strokes).join(","), { timeout: 20_000 }).toBe("3");

    await page.getByRole("button", { name: "Quitar lo recogido de Ana" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.none);
    // Luis solo recogio su grupo A: queda a medias.
    await expect(status(page, LUIS)).toHaveText(STATUS.partial);
    await expect.poll(async () => (await draftRows(page)).map((row) => row.strokes).join(","), { timeout: 20_000 }).toBe("1");

    await page.getByRole("button", { name: "Borrar datos", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Borrar datos", exact: true }).click();
    await expect(page.getByText("Datos borrados.")).toBeVisible();
    await expect.poll(async () => (await draftRows(page)).length, { timeout: 15_000 }).toBe(0);
  });
});
