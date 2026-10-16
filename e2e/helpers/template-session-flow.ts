/**
 * Piezas comunes de los E2E de «no se pierde trabajo» y «plantilla desactualizada» (F2-fix): configurar la plantilla de 2
 * firmantes con el editor, subir el MISMO contrato reexportado, y los turnos de la ceremonia. Textos en espanol.
 */
import { expect, type Page } from "@playwright/test";
import { drawInOpenComposer, fileInput } from "./sign-flow";
import { LINE, Taps, chooseForEditor, dragOnSheet, pickTool, placeSignatureBlock, sheet, storedTemplates, type StoredTemplate } from "./template-flow";

export const PAGES = 6;
export const SIGNER_1_ROLE = "Asegurado";
export const SIGNER_2_ROLE = "Co-asegurado";

export const notices = (page: Page) => page.locator("[data-template-notices]");

export async function upload(page: Page, name: string, buffer: Buffer): Promise<void> {
  await fileInput(page).setInputFiles({ name, mimeType: "application/pdf", buffer });
}

/** Configura la plantilla de 2 firmantes con el editor, la guarda y devuelve lo guardado. */
export async function configureTwoSigners(page: Page, original: Buffer, name = "Mold Test Agreement.pdf"): Promise<StoredTemplate> {
  await page.goto("/sign-pdf");
  await chooseForEditor(page, { name, buffer: original });
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible();
  await expect(sheet(page)).toBeVisible();
  await pickTool(page, "Iniciales");
  await dragOnSheet(page, { x0: LINE.x0, y0: LINE.y - 0.045, x1: LINE.x1, y1: LINE.y - 0.004 });
  await page.getByRole("button", { name: "Repetir iniciales en todas las páginas" }).click();
  await expect(page.locator("[data-template-note]")).toContainText(`Iniciales repetidas en ${PAGES} páginas, una al lado de la otra`);
  await placeSignatureBlock(page, 2, PAGES - 1);
  await page.getByRole("button", { name: "Guardar plantilla" }).click();
  await expect(page.locator("[data-template-saved]")).toContainText(`Plantilla guardada · aplicada a ${PAGES} páginas`);
  const templates = await storedTemplates(page);
  expect(templates).toHaveLength(1);
  return templates[0];
}

/**
 * Configura la plantilla con las DOS variantes y con huecos DISTINTOS: la de 2 firmantes (iniciales una al lado de la otra,
 * cada una con ~6 % del ancho) y la de 1 firmante (iniciales a ANCHO COMPLETO de la linea, x 0,74 · w 0,13). Es el caso del
 * verificador: cambiar de variante mueve y redimensiona los huecos del firmante que se queda.
 */
export async function configureBothVariants(page: Page, original: Buffer, name = "Mold Test Agreement.pdf"): Promise<StoredTemplate> {
  await configureTwoSigners(page, original, name);
  await page.getByRole("tab", { name: "1 firmante" }).or(page.getByRole("radio", { name: "1 firmante" })).first().click();
  const previous = page.getByRole("button", { name: "Página anterior", exact: true });
  for (let index = 0; index < PAGES; index += 1) {
    if (await previous.isEnabled()) await previous.click();
  }
  await pickTool(page, "Iniciales");
  await dragOnSheet(page, { x0: LINE.x0, y0: LINE.y - 0.045, x1: LINE.x1, y1: LINE.y - 0.004 });
  await page.getByRole("button", { name: "Repetir iniciales en todas las páginas" }).click();
  await placeSignatureBlock(page, 1, PAGES - 1);
  await page.getByRole("button", { name: /Guardar cambios|Guardar plantilla/ }).click();
  await expect.poll(async () => (await storedTemplates(page))[0]?.variants["1"].fields.length ?? 0).toBe(PAGES + 1);
  const [template] = await storedTemplates(page);
  expect(template.variants["2"].fields).toHaveLength(PAGES * 2 + 2);
  const one = template.variants["1"].fields.find((f) => f.type === "initials" && f.pageIndex === 0)!.rect;
  const two = template.variants["2"].fields.find((f) => f.type === "initials" && f.pageIndex === 0 && f.roleIndex === 0)!.rect;
  // La premisa del caso: los huecos de iniciales del firmante 1 son DISTINTOS en las dos variantes.
  expect(one.width).toBeGreaterThan(two.width * 1.5);
  return template;
}

/** Turno completo de un firmante en la ceremonia de UN documento. */
export async function signTurn(page: Page, seed: number, last: boolean): Promise<void> {
  const taps = new Taps(page);
  await taps.click(page.getByRole("button", { name: "Listo, es mi turno" }).first(), "Listo, es mi turno");
  await taps.click(page.getByRole("button", { name: "Crear mi firma", exact: true }), "Crear mi firma");
  await drawInOpenComposer(page, seed);
  await taps.click(page.getByRole("button", { name: "Crear mis iniciales", exact: true }), "Crear mis iniciales");
  await drawInOpenComposer(page, seed + 7);
  await taps.click(page.getByRole("button", { name: "Ver cómo queda" }), "Ver cómo queda");
  await taps.click(page.getByRole("button", { name: last ? "He terminado" : "Pasar al siguiente firmante" }), "terminar turno");
}

/** Plantilla aplicada al contrato reexportado, los dos firmantes han firmado y la pantalla dice «Ya han firmado todos». */
export async function appliedAndBothSigned(page: Page, original: Buffer, reexported: Buffer, configure: typeof configureTwoSigners = configureTwoSigners, seeds: [number, number] = [5, 17]): Promise<void> {
  await configure(page, original);
  await page.reload();
  await upload(page, "Mold Test.pdf", reexported);
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`, { timeout: 20_000 });
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  await signTurn(page, seeds[0], false);
  await expect(page.getByRole("heading", { name: `Pásale el dispositivo a ${SIGNER_2_ROLE}` })).toBeVisible();
  await signTurn(page, seeds[1], true);
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
}
