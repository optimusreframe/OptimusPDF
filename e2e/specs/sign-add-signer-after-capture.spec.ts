import { expect, test, type Page } from "@playwright/test";
import { bytesOfDownload, downloadBytes } from "../helpers/downloads";
import { imagePlacements } from "../helpers/pdf-placements";
import { makeReceiptPdf } from "../../src/lib/pdf/testing/signSyntheticPdfs";
import {
  continueToSign,
  drawInOpenComposer,
  handoffHeading,
  mergedReviewHeading,
  openSignAndUpload,
  placeSlot,
  roundCompleteHeading,
  startTurn,
  turnCounter,
} from "../helpers/sign-flow";

/**
 * Firmar PDF · Ana firma, DESPUES se suma otro firmante y se reorganizan los huecos de Ana: lo recogido sigue atado a Ana.
 * Cubre el caso del adjuster: un documento, Ana con firma e iniciales, se añade a Luis, se MUEVEN los huecos de Ana y se
 * ponen los de Luis; la ronda sigue con Luis y Ana no vuelve a firmar. Headless siempre.
 */
test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(180_000);

async function placeInitials(page: Page, signer: string, offsetY: number): Promise<void> {
  await page.getByRole("radio", { name: signer, exact: true }).click();
  await page.getByRole("toolbar").first().getByRole("button", { name: "Iniciales" }).click();
  const surface = page.locator('img[alt]:not([alt=""])').first();
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) throw new Error("no se encontro la pagina del lienzo");
  await page.mouse.move(box.x + 300, box.y + offsetY);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + offsetY + 30, { steps: 5 });
  await page.mouse.up();
}

async function dragSlot(page: Page, signer: string, kind: "slot", dx: number, dy: number, index = 0): Promise<void> {
  const node = page.locator(`[data-element-kind="${kind}"][aria-label^="${signer}"]`).nth(index);
  await node.scrollIntoViewIfNeeded();
  let before = await node.boundingBox();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(150);
    const next = await node.boundingBox();
    if (before && next && next.x === before.x && next.y === before.y) break;
    before = next;
  }
  if (!before) throw new Error(`no se encontro el hueco de ${signer}`);
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + dx, before.y + before.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

/** Turno de un firmante con firma E iniciales (dos bloques) hasta la revision. */
async function signAndInitial(page: Page, seed: number, last: boolean): Promise<void> {
  await startTurn(page);
  await page.getByRole("button", { name: "Crear mi firma", exact: true }).click();
  await drawInOpenComposer(page, seed);
  await page.getByRole("button", { name: "Crear mis iniciales", exact: true }).click();
  await drawInOpenComposer(page, seed + 1);
  await page.getByRole("button", { name: "Ver cómo queda" }).click();
  if (!last) {
    await page.getByRole("button", { name: "Pasar al siguiente firmante" }).click();
    return;
  }
  // Ola 3: con el ultimo firmante la revision y el boton final son UNA pantalla («Revisa y descarga»): no hay «He terminado».
  const finish = page.getByRole("button", { name: "He terminado" });
  await expect(finish.or(mergedReviewHeading(page))).toBeVisible();
  if (await finish.isVisible()) await finish.click();
}

test("un documento: Ana firma, se añade a Luis y se mueven los huecos de Ana: Ana no vuelve a firmar", async ({ page }) => {
  const receipt = { name: "Recibo.pdf", mimeType: "application/pdf" as const, buffer: Buffer.from(await makeReceiptPdf()) };
  await page.goto("/");
  await openSignAndUpload(page, [receipt]);
  // Solo Ana al principio.
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 1").fill("Ana");
  await page.getByRole("button", { name: "2. Documento" }).click();
  await placeSlot(page, "Ana", 100);
  await placeInitials(page, "Ana", 220);
  await continueToSign(page);
  await signAndInitial(page, 10, true);
  await expect(roundCompleteHeading(page)).toBeVisible();

  // Vuelve, añade a Luis y reorganiza: mueve la firma y las iniciales de Ana y pone los huecos de Luis.
  await page.getByRole("button", { name: "Atrás" }).click();
  await page.getByRole("button", { name: "1. Firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 2").fill("Luis");
  await page.getByRole("button", { name: "2. Documento" }).click();
  await expect(page.locator('[data-element-kind="slot"][aria-label^="Ana"]')).toHaveCount(2);
  await dragSlot(page, "Ana", "slot", 40, 120, 0);
  await dragSlot(page, "Ana", "slot", -40, 90, 1);
  await placeSlot(page, "Luis", 160);
  await placeInitials(page, "Luis", 240);

  // Donde queda cada hueco (centro, como fraccion de la hoja) para comprobar luego el PDF final.
  const surface = page.locator('img[alt]:not([alt=""])').first();
  const sheetBox = await surface.boundingBox();
  if (!sheetBox) throw new Error("no se encontro la hoja");
  const slotBoxes = await page.locator('[data-element-kind="slot"][aria-label]').evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().toJSON()).filter((box) => box.width > 50),
  );
  expect(slotBoxes).toHaveLength(4);
  const centers = slotBoxes.map((box) => ({ x: (box.x + box.width / 2 - sheetBox.x) / sheetBox.width, y: (box.y + box.height / 2 - sheetBox.y) / sheetBox.height }));
  // Los huecos de Ana SI se movieron (ya no estan donde se colocaron: 100 y 220 px bajo la hoja).
  const anaY = await page.locator('[data-element-kind="slot"][aria-label^="Ana"]').evaluateAll((nodes, top) => nodes.map((n) => n.getBoundingClientRect().y - top), sheetBox.y);
  expect(Math.round(anaY[0])).toBeGreaterThan(100 + 60);
  await continueToSign(page);

  // Lo recogido de Ana sigue atado a Ana: sin aviso de «volver a firmar» y el turno es de Luis.
  await expect(page.locator("[data-stale-signatures]")).toHaveCount(0);
  await expect(page.locator('[data-stale-signer="sg-1"]')).toHaveCount(0);
  // Ola 3 (W3-B2): Ana cerro su turno en la pantalla UNICA de revision (sin «He terminado» ni traspaso). Al sumar a Luis, la
  // ceremonia vuelve a esa revision de Ana (lo que firmo, sin volver a pedirselo) con «Pasar al siguiente firmante»: un toque
  // que antes hacia «He terminado». Ana NO vuelve a firmar: sus dos trazos siguen a la vista.
  await expect(page.getByRole("button", { name: "Pasar al siguiente firmante" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Crear mi firma", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Pasar al siguiente firmante" }).click();
  await expect(handoffHeading(page, "Luis")).toBeVisible();
  await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
  await signAndInitial(page, 30, true);
  await expect(roundCompleteHeading(page)).toBeVisible();

  // El PDF final lleva las 4 imagenes (firma e iniciales de cada uno) en los huecos DONDE QUEDARON, incluidos los de Ana ya movidos.
  await page.getByRole("button", { name: "Firmar y descargar" }).click();
  // Ola 3: al terminar el procesado el archivo se descarga SOLO (es el que recibe la persona); «Descargar» queda de respaldo.
  const automatic = page.waitForEvent("download");
  await page.getByRole("button", { name: "No, dejar el nombre como está" }).click();
  const pdf = await bytesOfDownload(await automatic);
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
  const placements = await imagePlacements(pdf);
  expect(placements).toHaveLength(4);
  for (const center of centers) {
    const near = placements.some((p) => Math.abs(p.x + p.width / 2 - center.x) < 0.05 && Math.abs(p.y + p.height / 2 - center.y) < 0.05);
    expect(near, `ninguna firma cerca de ${center.x.toFixed(2)},${center.y.toFixed(2)}`).toBe(true);
  }

  // El respaldo «Descargar» baja el mismo PDF (la segunda descarga): tambien con las 4 imagenes.
  const again = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Descargar" }).click();
  });
  expect(await imagePlacements(again)).toHaveLength(4);
});
