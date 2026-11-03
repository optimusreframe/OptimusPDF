import { expect, test, type Locator, type Page } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { imagePlacements } from "../helpers/pdf-placements";
import { makeReceiptPdf } from "../../src/lib/pdf/testing/signSyntheticPdfs";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { stillBox } from "../helpers/engine";
import {
  continueToSign,
  draftRows,
  handoffHeading,
  makeOtherDoc,
  mergedReviewHeading,
  openSignAndUpload,
  placeSlot,
  roundCompleteHeading,
  singleDraftCount,
  startTurn,
  turnCounter,
  drawInOpenComposer,
  uploadDocs,
} from "../helpers/sign-flow";
import {
  ALL_COVERED,
  NO_FIELDS_NOTE,
  STATUS,
  axeViolations,
  card,
  collectEarly,
  dragSlot,
  expectPlacementsAt,
  openPanel,
  placeInitialsSlot,
  slotCenters,
  status,
} from "../helpers/early-capture";

/**
 * Firmar PDF · recoger la firma y las iniciales de cada firmante ANTES o DESPUES de poner los campos (paso «Firmantes»).
 * UN documento. Lo recogido queda atado al firmante, no a los campos: añadir, mover o reorganizar campos no lo pierde, y la
 * ceremonia solo pide lo que falte. Solo editar el texto original o cambiar de documento lo invalida.
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3961 npx playwright test sign-early-capture --project=chromium --workers=1
 *
 * Headless siempre (modo por defecto de Playwright). PDF sinteticos; ningun dato real.
 */
test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(240_000);

const SG = SIGN_STRINGS.es;
const ANA = "sg-1";
const LUIS = "sg-2";

async function receipt() {
  return { name: "Recibo.pdf", mimeType: "application/pdf" as const, buffer: Buffer.from(await makeReceiptPdf()) };
}

/** Sube el recibo, elige «Varios firmantes» y da de alta a Ana (y a Luis si se pide). */
async function start(page: Page, signers: 1 | 2 = 2): Promise<void> {
  await page.goto("/");
  await openSignAndUpload(page, [await receipt()]);
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  if (signers === 2) await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 1").fill("Ana");
  if (signers === 2) await page.getByLabel("Nombre del firmante 2").fill("Luis");
  // Sin huella aun no se puede recoger: el boton se habilita cuando el documento esta comprobado.
  await expect(card(page, ANA).getByRole("button", { name: "Recoger firma e iniciales de Ana" })).toBeEnabled({ timeout: 20_000 });
}

/**
 * «Firmar y descargar» de la pantalla final. Ola 3: el archivo se descarga SOLO al llegar al resultado, asi que la descarga se
 * espera ANTES de contestar la pregunta del nombre (lo que arranca el procesado); «Descargar» queda de respaldo en pantalla.
 */
async function download(page: Page): Promise<Buffer> {
  await page.getByRole("button", { name: "Firmar y descargar" }).click();
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "No, dejar el nombre como está" }).click();
  });
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 60_000 });
  return bytes;
}

/** Turno de un firmante en la ceremonia creando solo lo que FALTA (`parts`), hasta la revision y el traspaso. */
async function ceremonyTurn(page: Page, seed: number, parts: { signature?: boolean; initials?: boolean }, last: boolean): Promise<void> {
  // Con UNA sola persona no hay traspaso (la captura se ve ya): solo se pulsa «Listo, es mi turno» si se pinta el traspaso.
  const handoff = page.getByRole("heading", { name: /^Pásale el dispositivo a / });
  await expect(handoff.or(page.getByRole("heading", { name: /^Firma de / }))).toBeVisible();
  if (await handoff.isVisible()) await startTurn(page);
  if (parts.signature) {
    await page.getByRole("button", { name: "Crear mi firma", exact: true }).click();
    await drawInOpenComposer(page, seed);
  }
  if (parts.initials) {
    await page.getByRole("button", { name: "Crear mis iniciales", exact: true }).click();
    await drawInOpenComposer(page, seed + 1);
  }
  await page.getByRole("button", { name: "Ver cómo queda" }).click();
  if (last) {
    // Ola 3: con el ULTIMO firmante, nada pendiente y sin bloqueos, la revision y el boton final son UNA pantalla («Revisa y descarga»).
    await expect(mergedReviewHeading(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "He terminado" })).toHaveCount(0);
    return;
  }
  await page.getByRole("button", { name: "Pasar al siguiente firmante" }).click();
}

/** Con UNA sola persona en la ronda no hay traspaso: se ve ya la captura de esa persona y se dice por que. */
async function expectSoleSignerCapture(page: Page, name: string): Promise<void> {
  await expect(handoffHeading(page, name)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: `Firma de ${name}` })).toBeVisible();
  await expect(page.getByText("Firma una sola persona: no hace falta pasar el dispositivo.")).toBeVisible();
}

test.describe("un documento · las dos maneras", () => {
  test("(a) recoger PRIMERO, poner los campos DESPUES: sin campos no rompe nada, los campos movidos usan lo recogido y Ana no vuelve a firmar", async ({ page }) => {
    await start(page);

    // Ana recoge firma e iniciales ANTES de que exista ningun campo; Luis no.
    await expect(status(page, ANA)).toHaveText(STATUS.none);
    await collectEarly(page, ANA, "Ana", 10);
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await expect(status(page, LUIS)).toHaveText(STATUS.none);
    // Con trazo recogido y SIN campos se dice en una linea y no se rompe nada.
    await expect(card(page, ANA).locator("[data-early-no-fields]")).toHaveText(NO_FIELDS_NOTE);
    await expect(card(page, LUIS).locator("[data-early-no-fields]")).toHaveCount(0);

    // Ahora los campos: los de Ana (firma e iniciales) y la firma de Luis. Despues se REORGANIZAN los de Ana.
    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Ana", 100);
    await placeInitialsSlot(page, "Ana", 220);
    await placeSlot(page, "Luis", 330);
    await dragSlot(page, "Ana", 40, 120, 0);
    await dragSlot(page, "Ana", -40, 60, 1);
    const centers = await slotCenters(page);
    expect(centers).toHaveLength(3);

    // Vuelve a Firmantes: Ana sigue completa (mover los campos no la toco) y ya no se dice «aun no tiene campos».
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await expect(card(page, ANA).locator("[data-early-no-fields]")).toHaveCount(0);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await continueToSign(page);

    // La ceremonia salta a Luis: Ana ya esta cubierta y no hay aviso de «volver a firmar».
    await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);
    await expect(handoffHeading(page, "Luis")).toBeVisible();
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
    await expect(page.locator('[data-stale-signer="sg-1"]')).toHaveCount(0);
    await ceremonyTurn(page, 30, { signature: true, initials: false }, true);

    // El PDF lleva cada firma en el hueco de su dueño, donde quedo (3 imagenes: la firma y las iniciales de Ana y la de Luis).
    const pdf = await download(page);
    expectPlacementsAt(await imagePlacements(pdf), centers);
  });

  test("(b) poner los campos PRIMERO, recoger DESPUES: la ceremonia lo dice claro y deja descargar sin pedir nada", async ({ page }) => {
    await start(page);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Ana", 100);
    await placeInitialsSlot(page, "Ana", 220);
    await placeSlot(page, "Luis", 330);
    await placeInitialsSlot(page, "Luis", 420);
    const centers = await slotCenters(page);
    expect(centers).toHaveLength(4);

    // Con campos y sin trazo: no hay aviso de «aun no tiene campos» (ya los tienen).
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.none);
    await collectEarly(page, ANA, "Ana", 10);
    await collectEarly(page, LUIS, "Luis", 20);
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await expect(status(page, LUIS)).toHaveText(STATUS.complete);
    await expect(page.locator("[data-early-no-fields]")).toHaveCount(0);

    await page.getByRole("button", { name: "3. Firmar" }).click();
    // Nadie pendiente: no hay traspaso ni turno que pedir, y se dice claro.
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await expect(page.locator("[data-all-covered]")).toHaveText(ALL_COVERED);
    await expect(page.getByRole("button", { name: "Listo, es mi turno" })).toHaveCount(0);
    await expect(turnCounter(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeEnabled();

    const pdf = await download(page);
    expectPlacementsAt(await imagePlacements(pdf), centers);
  });

  test("(c) mezcla: recogi la firma y añado un hueco de iniciales: la ceremonia pide SOLO las iniciales", async ({ page }) => {
    await start(page, 1);
    await collectEarly(page, ANA, "Ana", 10, { signature: true, initials: false });
    await expect(status(page, ANA)).toHaveText(STATUS.signature);

    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Ana", 100);
    await placeInitialsSlot(page, "Ana", 220);
    const centers = await slotCenters(page);
    await continueToSign(page);

    // Ana es la unica persona de la ronda: sin traspaso, la captura se ve ya.
    await expectSoleSignerCapture(page, "Ana");
    // La firma ya esta (no se vuelve a pedir "Crear mi firma"); falta solo las iniciales.
    await expect(page.getByRole("button", { name: "Crear mi firma", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Crear mis iniciales", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ver cómo queda" })).toBeDisabled();
    await page.getByRole("button", { name: "Crear mis iniciales", exact: true }).click();
    await drawInOpenComposer(page, 40);
    await page.getByRole("button", { name: "Ver cómo queda" }).click();
    // Ola 3: pantalla unica «Revisa y descarga» (sin «He terminado»).
    await expect(mergedReviewHeading(page)).toBeVisible();

    // Y en Firmantes ahora esta completa, sin que hiciera falta tocarla.
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await page.getByRole("button", { name: "3. Firmar" }).click();
    const pdf = await download(page);
    expectPlacementsAt(await imagePlacements(pdf), centers);
  });

  test("(c2) mezcla: Ana recogida, Luis firma en la ceremonia y Ana mueve sus campos DESPUES de todo: nadie vuelve a firmar", async ({ page }) => {
    await start(page);
    await collectEarly(page, ANA, "Ana", 10);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Ana", 100);
    await placeSlot(page, "Luis", 330);
    await continueToSign(page);
    await expect(handoffHeading(page, "Luis")).toBeVisible();
    await ceremonyTurn(page, 30, { signature: true }, true);

    // Despues de firmar todos: se reorganiza el campo de Ana y se vuelve a la ronda: nada que repetir.
    await page.getByRole("button", { name: "Atrás" }).click();
    await dragSlot(page, "Ana", 50, 140, 0);
    const centers = await slotCenters(page);
    // Con todos ya cubiertos la ceremonia no tiene turno que mostrar (sin «Turno N de M»): se pasa al paso 3 directo.
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);
    // Todo recogido: la pantalla unica del ultimo turno («Revisa y descarga») o, si ya se paso de ella, «Ya han firmado todos».
    await expect(roundCompleteHeading(page)).toBeVisible();
    const pdf = await download(page);
    expectPlacementsAt(await imagePlacements(pdf), centers);
  });
});

test.describe("un documento · sin campos", () => {
  test("(i) Ana con trazo recogido y SIN campos, Luis con el suyo: no se estampa nada de Ana, no queda pendiente y se avisa", async ({ page }) => {
    await start(page);
    await collectEarly(page, ANA, "Ana", 10);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Luis", 200);
    const centers = await slotCenters(page);
    expect(centers).toHaveLength(1);
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await expect(card(page, ANA).locator("[data-early-no-fields]")).toHaveText(NO_FIELDS_NOTE);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await continueToSign(page);
    // La ronda solo tiene a Luis: Ana no tiene campos y no cuenta como pendiente ni como turno.
    await expect(turnCounter(page)).toHaveText("Turno 1 de 1");
    // Luis es la unica persona con turno: sin traspaso, su captura se ve ya.
    await expectSoleSignerCapture(page, "Luis");
    await ceremonyTurn(page, 30, { signature: true }, true);
    const pdf = await download(page);
    // UNA sola imagen: la de Luis, en su hueco.
    expectPlacementsAt(await imagePlacements(pdf), centers);
  });
});

test.describe("un documento · estado, invalidacion y borrado", () => {
  test("(d) editar el texto original invalida lo recogido, tambien en el paso Firmantes, y volver a recoger lo arregla", async ({ page }, testInfo) => {
    const touch = (testInfo.project.use as { hasTouch?: boolean }).hasTouch === true;
    await start(page, 1);
    await collectEarly(page, ANA, "Ana", 10);
    await expect(status(page, ANA)).toHaveText(STATUS.complete);

    await page.getByRole("button", { name: "2. Documento" }).click();
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
    await page.keyboard.type("Recibo editado por Optimus");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await page.getByRole("button", { name: SG.toolSelect }).click();

    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.staleText);
    const notice = page.locator("[data-stale-signatures]");
    await expect(notice).toContainText("La firma de Ana ya no es válida porque cambiaste el texto del documento: Ana debe volver a firmar.");
    // El icono acompaña, pero lo que lo dice es el TEXTO; y la tarjeta + el aviso no tienen violaciones de accesibilidad.
    expect(await axeViolations(page, '[data-early-capture="sg-1"]')).toEqual([]);
    expect(await axeViolations(page, "[data-stale-signatures]")).toEqual([]);

    // Recoger de nuevo sobre el texto ya editado lo deja vigente (parte de cero: no se mezcla con lo caducado).
    await collectEarly(page, ANA, "Ana", 50, { signature: true, initials: false });
    await expect(status(page, ANA)).toHaveText(STATUS.signature);
    await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);
  });

  test("(e) cambiar de archivo (otro documento) invalida lo recogido: no se reaplica a un documento que su dueño no vio", async ({ page }) => {
    await start(page, 1);
    await collectEarly(page, ANA, "Ana", 10);
    await expect(status(page, ANA)).toHaveText(STATUS.complete);

    // Se quita el recibo y se sube OTRO documento: Ana firmo sobre el primero, asi que en el nuevo no tiene nada recogido.
    await page.getByRole("button", { name: "Quitar", exact: true }).first().click();
    await uploadDocs(page, [await makeOtherDoc("Otro.pdf", "Z")]);
    // Ola 3: una ronda con los mismos firmantes arranca en el paso Documento («Firman: Ana · Cambiar»): se vuelve a Firmantes
    // para ver lo recogido.
    await expect(page.getByText("Firman: Ana").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(card(page, ANA)).toBeVisible({ timeout: 30_000 });
    await expect(status(page, ANA)).toHaveText(STATUS.none);

    // Y en la ceremonia le toca firmar a ella: la firma del documento anterior no se estampa en este.
    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Ana", 100);
    await continueToSign(page);
    await expectSoleSignerCapture(page, "Ana");
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeDisabled();
  });

  test("(f) recargar y retomar: lo recogido sobrevive, «Quitar» lo vacia y «Borrar datos» no deja nada", async ({ page }) => {
    await start(page, 2);
    await collectEarly(page, ANA, "Ana", 10);
    await collectEarly(page, LUIS, "Luis", 20, { signature: true, initials: false });
    await expect(status(page, LUIS)).toHaveText(STATUS.signature);
    // El borrador ya contiene los trazos (sin ningun campo todavia).
    await expect.poll(async () => (await draftRows(page)).map((row) => row.strokes).join(","), { timeout: 20_000 }).toBe("2");
    expect((await draftRows(page))[0].fields).toBe(0);

    await page.reload();
    await expect(card(page, ANA).getByRole("button", { name: "Cambiar lo recogido de Ana" })).toBeVisible({ timeout: 30_000 });
    await expect(status(page, ANA)).toHaveText(STATUS.complete);
    await expect(status(page, LUIS)).toHaveText(STATUS.signature);

    // «Quitar» vacia a Ana y deja a Luis.
    await card(page, ANA).getByRole("button", { name: "Quitar lo recogido de Ana" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.none);
    await expect(status(page, LUIS)).toHaveText(STATUS.signature);
    await expect.poll(async () => (await draftRows(page)).map((row) => row.strokes).join(","), { timeout: 20_000 }).toBe("1");

    // «Borrar datos» de la herramienta vacia los borradores (y con ellos lo recogido): al recargar no queda nada.
    await page.getByRole("button", { name: "Borrar datos", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Borrar datos", exact: true }).click();
    await expect(page.getByText("Datos borrados.")).toBeVisible();
    await expect.poll(async () => (await draftRows(page)).length, { timeout: 15_000 }).toBe(0);
    expect(await singleDraftCount(page)).toBe(0);
    await page.goto("/sign-pdf");
    await expect(page.getByText("Tienes una firma sin terminar")).toHaveCount(0);
  });

  test("(g) quitar un firmante quita su trazo; el firmante nuevo no hereda nada", async ({ page }) => {
    await start(page, 2);
    await collectEarly(page, ANA, "Ana", 10);
    await collectEarly(page, LUIS, "Luis", 20);
    await expect.poll(async () => (await draftRows(page)).map((row) => row.strokes).join(","), { timeout: 20_000 }).toBe("2");

    await page.getByRole("button", { name: "Quitar a Ana" }).click();
    await expect(card(page, ANA)).toHaveCount(0);
    await expect.poll(async () => (await draftRows(page)).map((row) => row.strokes).join(","), { timeout: 20_000 }).toBe("1");
    // Un firmante nuevo empieza sin nada recogido.
    await page.getByRole("button", { name: "Añadir firmante" }).click();
    await expect(status(page, "sg-3")).toHaveText(STATUS.none);
    await expect(status(page, LUIS)).toHaveText(STATUS.complete);
  });

  test("(h) usar una firma guardada del baul para recoger (sin dibujar)", async ({ page }) => {
    await start(page, 1);
    // Se recuerda una firma en el baul al recogerla (casilla «Recordar en este dispositivo»).
    const panel = await openPanel(page, ANA, "Ana");
    await panel.getByRole("button", { name: "Crear mi firma", exact: true }).click();
    const dialog = page.getByRole("dialog");
    // La hoja entra con un muelle: se espera a que deje de moverse antes de tocar la casilla.
    await stillBox(dialog.locator("canvas"));
    // La casilla va bajo su etiqueta (que recibe el toque): se marca tocando el texto.
    await dialog.getByText("Recordar en este dispositivo", { exact: true }).click();
    await expect(dialog.getByRole("checkbox", { name: /Recordar en este dispositivo/ })).toBeChecked();
    await drawInOpenComposer(page, 10);
    await expect(status(page, ANA)).toHaveText(STATUS.signature);
    // Se quita y se vuelve a recoger USANDO la guardada.
    await panel.getByRole("button", { name: "Listo", exact: true }).click();
    await card(page, ANA).getByRole("button", { name: "Quitar lo recogido de Ana" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.none);
    const again = await openPanel(page, ANA, "Ana");
    await again.getByRole("button", { name: "Usar una guardada para: Firma" }).click();
    const vault = page.getByRole("dialog");
    await vault.getByRole("button", { name: /^Usar/ }).first().click();
    await expect(status(page, ANA)).toHaveText(STATUS.signature);
  });

  test("(j) firma rapida (Ola 3): con una firma guardada, «Firmar todo con mi firma guardada» firma en un toque, deja ver como queda y el PDF baja solo", async ({ page }) => {
    await start(page, 1);
    // Se recuerda una firma en el baul al recogerla y se quita lo recogido: solo queda la guardada en el dispositivo.
    const panel = await openPanel(page, ANA, "Ana");
    await panel.getByRole("button", { name: "Crear mi firma", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await stillBox(dialog.locator("canvas"));
    await dialog.getByText("Recordar en este dispositivo", { exact: true }).click();
    await expect(dialog.getByRole("checkbox", { name: /Recordar en este dispositivo/ })).toBeChecked();
    await drawInOpenComposer(page, 10);
    await panel.getByRole("button", { name: "Listo", exact: true }).click();
    await card(page, ANA).getByRole("button", { name: "Quitar lo recogido de Ana" }).click();
    await expect(status(page, ANA)).toHaveText(STATUS.none);

    await page.getByRole("button", { name: "2. Documento" }).click();
    await placeSlot(page, "Ana", 100);
    const centers = await slotCenters(page);
    expect(centers).toHaveLength(1);
    await continueToSign(page);

    // Una sola persona: sin traspaso. La tarjeta de la firma guardada va arriba y el resumen dice lo que se va a firmar.
    await expectSoleSignerCapture(page, "Ana");
    await expect(page.locator("[data-ceremony-summary]")).toContainText(/Firmas: 1 · Iniciales: 0/);
    await page.getByRole("button", { name: "Firmar todo con mi firma guardada" }).click();

    // Pantalla unica «Revisa y descarga»: lo firmado a la vista, «Deshacer» y el boton final, sin «He terminado».
    await expect(mergedReviewHeading(page)).toBeVisible();
    await expect(page.locator("[data-quick-sign-undo]")).toBeVisible();
    await expect(page.getByRole("button", { name: "He terminado" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeEnabled();

    // «Deshacer» devuelve la captura (el boton final se apaga) y volver a firmar con la guardada lo deja como estaba.
    await page.locator("[data-quick-sign-undo]").click();
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeDisabled();
    await page.getByRole("button", { name: "Firmar todo con mi firma guardada" }).click();
    await expect(mergedReviewHeading(page)).toBeVisible();

    const pdf = await download(page);
    expectPlacementsAt(await imagePlacements(pdf), centers);
  });
});
