import { expect, test, type Page } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { embeddedImages, shapeHash } from "../helpers/pdf-images";
import { imagePlacements, type Placement } from "../helpers/pdf-placements";
import { makeContract, reexport } from "../helpers/template-pdfs";
import { storedTemplates, type StoredField, type StoredTemplate } from "../helpers/template-flow";
import { PAGES, SIGNER_2_ROLE, appliedAndBothSigned, configureBothVariants, notices, signTurn, upload } from "../helpers/template-session-flow";

/**
 * Firma agil · Fase 2 · F2-fix2 (residuales de la 2ª verificacion independiente), navegador real, headless, con plantillas
 * cuyas DOS variantes tienen huecos DISTINTOS (iniciales del firmante 1 a ancho completo en la de 1 firmante; una al lado de
 * la otra, ~6 % del ancho, en la de 2): cambiar de variante mueve y redimensiona los huecos del firmante que se queda.
 *
 *   F1-a  2 → 1 con los dos firmados: la hoja nombra SOLO al firmante 2 y la firma del 1 SOBREVIVE; el PDF lleva sus trazos
 *         una vez, en los huecos de la variante de 1.
 *   F1-b  1 → 2 con la firma del 1 recogida: sigue valiendo, sin dialogo; el 2 firma y el PDF lleva los trazos de los dos.
 *   F1-c  lo mismo con el automapeo (huecos de 1 y de 2 distintos).
 *   F2-a  borrador restaurado (sin aviso) → «Crear plantilla de este documento» → Guardar → «Firmar este documento»: ni
 *         duplica los campos ni invalida las firmas.
 *   F2-b  lo mismo con el aviso presente («Configurar plantilla de este documento»).
 *   OBS   la hoja de confirmacion aisla el fondo (`inert`), Escape y el foco siguen bien.
 *
 * Chromium por defecto; iPad: `PW_BROWSERS=webkit-ipad ... --project=webkit-ipad` con build de produccion y
 * `CSP_SKIP_UPGRADE_INSECURE=1`.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(420_000);

/** La amplitud del trazo es 10 + (semilla % 5) * 12: con 10 (y 17) y 21 (y 28) los cuatro trazos de dos firmantes son distintos. */
const SEEDS: [number, number] = [10, 21];

const NAME = "Mold Test Agreement";
const dialogOf = (page: Page) => page.getByRole("dialog", { name: "¿Cambiar a 1 firmante?" });
const goTo = async (page: Page, step: "1. Firmantes" | "3. Firmar") => page.getByRole("button", { name: step }).click();
const huecos = async (page: Page) => Number(/(\d+) huecos en total/.exec(await page.locator("main").innerText())?.[1] ?? "NaN");

const center = (p: Placement) => ({ x: p.x + p.width / 2, y: p.y + p.height / 2 });
const inside = (p: Placement, f: StoredField, slack = 0.004) => {
  const c = center(p);
  return c.x >= f.rect.x - slack && c.x <= f.rect.x + f.rect.width + slack && c.y >= f.rect.y - slack && c.y <= f.rect.y + f.rect.height + slack;
};

async function downloadSigned(page: Page): Promise<Buffer> {
  return downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
    await page.getByRole("button", { name: /^Descargar/ }).click();
  });
}

/** Plantilla con las dos variantes, recarga y sube el MISMO contrato reexportado: 2 firmantes con 14 campos. */
async function openWithBothVariants(page: Page): Promise<{ original: Buffer; template: StoredTemplate }> {
  const original = await makeContract({ label: NAME, pages: PAGES, signers: 2 });
  const template = await configureBothVariants(page, original);
  await page.reload();
  await upload(page, "Mold Test.pdf", await reexport(original));
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`, { timeout: 25_000 });
  return { original, template };
}

/** El PDF final de UN firmante con la variante de 1: una linea de iniciales por pagina y su firma, cada cosa UNA vez. */
async function expectOneSignerPdf(bytes: Buffer, template: StoredTemplate, distinctShapes: number) {
  const placements = await imagePlacements(bytes);
  expect(placements, "ni duplicados ni de menos").toHaveLength(PAGES + 1);
  const initialsSlots = template.variants["1"].fields.filter((f) => f.type === "initials");
  for (let pageIndex = 0; pageIndex < PAGES; pageIndex += 1) {
    const onPage = placements.filter((p) => p.page === pageIndex && p.y > 0.8);
    expect(onPage, `iniciales de la pagina ${pageIndex + 1}`).toHaveLength(1);
    expect(inside(onPage[0], initialsSlots.find((f) => f.pageIndex === pageIndex)!), `iniciales dentro del hueco de 1 firmante, pagina ${pageIndex + 1}`).toBe(true);
  }
  const signature = placements.filter((p) => p.page === PAGES - 1 && p.y < 0.7);
  expect(signature).toHaveLength(1);
  expect(inside(signature[0], template.variants["1"].fields.find((f) => f.type === "signature")!)).toBe(true);
  expect(new Set((await embeddedImages(bytes)).map(shapeHash)).size, "trazos distintos").toBe(distinctShapes);
}

/** El PDF final de DOS firmantes: iniciales una al lado de la otra en cada pagina y una firma cada uno. */
async function expectTwoSignersPdf(bytes: Buffer, template: StoredTemplate) {
  const placements = await imagePlacements(bytes);
  expect(placements, "ni duplicados ni de menos").toHaveLength(PAGES * 2 + 2);
  for (let pageIndex = 0; pageIndex < PAGES; pageIndex += 1) {
    const onPage = placements.filter((p) => p.page === pageIndex && p.y > 0.8).sort((a, b) => a.x - b.x);
    expect(onPage, `iniciales de la pagina ${pageIndex + 1}`).toHaveLength(2);
    for (const roleIndex of [0, 1]) {
      const slot = template.variants["2"].fields.find((f) => f.type === "initials" && f.pageIndex === pageIndex && f.roleIndex === roleIndex)!;
      expect(inside(onPage[roleIndex], slot), `iniciales del firmante ${roleIndex + 1}, pagina ${pageIndex + 1}`).toBe(true);
    }
  }
  expect(placements.filter((p) => p.page === PAGES - 1 && p.y < 0.7)).toHaveLength(2);
  expect(new Set((await embeddedImages(bytes)).map(shapeHash)).size, "cuatro trazos distintos").toBe(4);
}

test("(F1-a) 2 → 1 con las iniciales a ancho completo y los dos firmados: la hoja nombra solo al firmante 2 y la firma del 1 sobrevive", async ({ page }) => {
  const { template } = await openWithBothVariants(page);
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  await signTurn(page, SEEDS[0], false);
  await expect(page.getByRole("heading", { name: `Pásale el dispositivo a ${SIGNER_2_ROLE}` })).toBeVisible();
  await signTurn(page, SEEDS[1], true);
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();

  await goTo(page, "1. Firmantes");
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // La hoja habla del firmante 2 y de nadie mas: al 1 no le pasa nada.
  await expect(dialog).toContainText("Cambiar a 1 firmante quitará la firma de Co-asegurado. ¿Continuar?");
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();

  await goTo(page, "1. Firmantes");
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Quitar y cambiar" }).click();
  await expect(dialog).toBeHidden();
  await expect(notices(page)).toContainText(`1 firmante · ${PAGES + 1} campos en ${PAGES} páginas`);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveCount(0);
  await goTo(page, "3. Firmar");
  // La firma y las iniciales del firmante 1 SIGUEN valiendo sobre los huecos nuevos (mas anchos): nadie tiene que volver a firmar.
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await expect(page.getByText(/Debe volver a firmar|cambiaron los huecos/)).toHaveCount(0);
  await expectOneSignerPdf(await downloadSigned(page), template, 2);
});

test("(F1-b) 1 → 2 con la firma del firmante 1 ya recogida: sigue valiendo sin dialogo; el 2 firma y el PDF lleva los trazos de los dos una vez", async ({ page }) => {
  const { template } = await openWithBothVariants(page);
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();
  await expect(notices(page)).toContainText(`1 firmante · ${PAGES + 1} campos`, { timeout: 15_000 });
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  await signTurn(page, SEEDS[0], true);
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();

  await goTo(page, "1. Firmantes");
  await notices(page).getByRole("tab", { name: "2 firmantes" }).click();
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`, { timeout: 15_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await goTo(page, "3. Firmar");
  // El 2 es el que falta; al 1 no se le pide nada ni se habla de huecos cambiados.
  await expect(page.getByRole("heading", { name: `Pásale el dispositivo a ${SIGNER_2_ROLE}` })).toBeVisible();
  await expect(page.getByText(/Debe volver a firmar|cambiaron los huecos/)).toHaveCount(0);
  await signTurn(page, SEEDS[1], true);
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await expectTwoSignersPdf(await downloadSigned(page), template);
});

test("(F1-c) automapeo: con los dos firmados «1 firmante» pide confirmar solo por el 2, Cancelar conserva y Quitar y cambiar deja firmado al 1", async ({ page }) => {
  const unknown = await makeContract({ label: "Zulu Unknown Agreement", pages: 5, signers: 2 });
  await page.goto("/sign-pdf");
  await upload(page, "Zulu Unknown.pdf", unknown);
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await expect(notices(page)).toContainText("Detectamos", { timeout: 30_000 });
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  await signTurn(page, 3, false);
  await signTurn(page, 17, true);
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();

  await goTo(page, "1. Firmantes");
  const tab = notices(page).getByRole("tab", { name: "1 firmante" });
  await tab.click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("quitará la firma de Co-asegurado");
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2_ROLE);
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();

  await goTo(page, "1. Firmantes");
  await tab.click();
  await dialog.getByRole("button", { name: "Quitar y cambiar" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveCount(0);
  const slots = await huecos(page);
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await expect(page.getByText(/Debe volver a firmar|cambiaron los huecos/)).toHaveCount(0);
  const bytes = await downloadSigned(page);
  // Los trazos del firmante 1 (firma + iniciales) una vez en cada hueco que la pantalla cuenta: ni de mas ni de menos.
  expect(await imagePlacements(bytes)).toHaveLength(slots);
  expect(new Set((await embeddedImages(bytes)).map(shapeHash)).size).toBe(2);
});

async function saveFromEditorAndSign(page: Page, openName: RegExp): Promise<void> {
  await page.getByRole("button", { name: openName }).click({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible({ timeout: 25_000 });
  await page.getByRole("button", { name: /Guardar cambios|Guardar plantilla/ }).click();
  await expect(page.locator("[data-template-saved]")).toBeVisible();
  await page.getByRole("button", { name: "Firmar este documento" }).click();
  await expect(notices(page).locator('[data-template-notice="applied"]')).toBeVisible({ timeout: 25_000 });
}

test("(F2-a) borrador restaurado SIN aviso → Crear plantilla de este documento → Guardar → Firmar este documento: no duplica los campos ni invalida las firmas", async ({ page }) => {
  const original = await makeContract({ label: NAME, pages: PAGES, signers: 2 });
  await appliedAndBothSigned(page, original, await reexport(original), configureBothVariants, SEEDS);
  const template = (await storedTemplates(page))[0];
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForTimeout(2500);
  // Sin el aviso: el borrador se restauro (los archivos restaurados no reciben plantilla encima).
  await expect(page.locator("[data-template-notice]")).toHaveCount(0);
  await goTo(page, "1. Firmantes");
  const before = await huecos(page);
  expect(before).toBe(PAGES * 2 + 2);
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await goTo(page, "1. Firmantes");

  await saveFromEditorAndSign(page, /Crear plantilla de este documento|Configurar plantilla de este documento/);
  await goTo(page, "1. Firmantes");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await huecos(page), "los campos no se duplican (14, no 28)").toBe(before);
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await expect(page.getByText(/Debe volver a firmar|cambiaron los huecos/)).toHaveCount(0);
  await expectTwoSignersPdf(await downloadSigned(page), template);
});

test("(F2-b) con el aviso presente y las firmas hechas, Configurar plantilla de este documento → Guardar → Firmar este documento no pierde ni duplica", async ({ page }) => {
  const original = await makeContract({ label: NAME, pages: PAGES, signers: 2 });
  await appliedAndBothSigned(page, original, await reexport(original), configureBothVariants, SEEDS);
  const template = (await storedTemplates(page))[0];
  await goTo(page, "1. Firmantes");
  const before = await huecos(page);
  await saveFromEditorAndSign(page, /Configurar plantilla de este documento|Crear plantilla de este documento/);
  await goTo(page, "1. Firmantes");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await huecos(page)).toBe(before);
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await expect(page.getByText(/Debe volver a firmar|cambiaron los huecos/)).toHaveCount(0);
  await expectTwoSignersPdf(await downloadSigned(page), template);
});

test("(OBS) la hoja de confirmación aísla el fondo: todo lo demás queda inert, Tab no sale, Escape cancela y devuelve el foco", async ({ page }, testInfo) => {
  await openWithBothVariants(page);
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  await signTurn(page, SEEDS[0], false);
  await signTurn(page, SEEDS[1], true);
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
  await goTo(page, "1. Firmantes");
  const tab = notices(page).getByRole("tab", { name: "1 firmante" });
  await tab.click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();

  const isolation = () =>
    page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]');
      const others = [...document.body.children].filter((element) => !element.contains(modal) && !["SCRIPT", "STYLE"].includes(element.tagName));
      return {
        modalInert: !!modal?.closest("[inert]"),
        othersInert: others.length > 0 && others.every((element) => element.hasAttribute("inert")),
        noticesInert: !!document.querySelector("[data-template-notices]")?.closest("[inert]"),
      };
    });
  expect(await isolation()).toEqual({ modalInert: false, othersInert: true, noticesInert: true });

  // El foco no sale de la hoja con Tab / Shift+Tab (solo Chromium: WebKit de escritorio no recorre botones con Tab por defecto).
  if (testInfo.project.name === "chromium") {
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press(index < 5 ? "Tab" : "Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
  }
  // Escape cancela sin tocar nada, destapa el fondo y devuelve el foco al segmento (el foco devuelto solo se comprueba en Chromium).
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("[inert]")).toHaveCount(0);
  if (testInfo.project.name === "chromium") await expect(tab).toBeFocused();
  await expect(notices(page).getByRole("tab", { name: "2 firmantes" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2_ROLE);

  // Reabrir y cerrar tocando el fondo (el scrim): tambien cancela y destapa.
  await tab.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(page.locator("[inert]")).toHaveCount(0);
  await goTo(page, "3. Firmar");
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
});
