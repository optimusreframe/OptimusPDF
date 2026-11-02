/**
 * Piezas comunes de los E2E de «Recoger firma e iniciales antes o despues de poner los campos» (paso «Firmantes»).
 * Textos en espanol (los de `strings.ts`); PDF sinteticos; SIEMPRE headless.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { drawInOpenComposer } from "./sign-flow";

/** La tarjeta de recogida de un firmante (`sg-1`, `sg-2`...). */
export const card = (page: Page, signerId: string): Locator => page.locator(`[data-early-capture="${signerId}"]`);

/** El estado del firmante en TEXTO. */
export const status = (page: Page, signerId: string): Locator => card(page, signerId).locator("[data-early-status]");

export const STATUS = {
  complete: "Firma e iniciales recogidas",
  signature: "Solo firma",
  initials: "Solo iniciales",
  none: "Sin recoger",
  partial: "Recogida en parte",
  staleText: "Debe volver a firmar · cambió el texto del documento",
  staleDocument: "Debe volver a firmar · cambió el documento",
  staleAdded: "Debe volver a firmar · se añadió un documento a lo que firma",
} as const;

export const NO_FIELDS_NOTE = "Aún no tiene campos: lo recogido se usará cuando se los pongas.";
export const ALL_COVERED = "Todas las firmas e iniciales que hacen falta ya están recogidas: no se pide nada más.";

/** Abre el panel del firmante (si no lo esta ya) y devuelve el grupo del panel. */
export async function openPanel(page: Page, signerId: string, name: string): Promise<Locator> {
  const panel = card(page, signerId).getByRole("group", { name: `Firma e iniciales de ${name}` });
  if (!(await panel.isVisible())) {
    await card(page, signerId)
      .getByRole("button", { name: new RegExp(`^(Recoger firma e iniciales de|Cambiar lo recogido de) ${name}$`) })
      .click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Recoge la firma y/o las iniciales de un firmante desde su tarjeta, con el compositor de siempre, y cierra el panel.
 * Con varios grupos (varios documentos) los botones llevan «· Firma A»: pasa `group`.
 */
export async function collectEarly(
  page: Page,
  signerId: string,
  name: string,
  seed: number,
  parts: { signature?: boolean; initials?: boolean; group?: string; close?: boolean } = {},
): Promise<void> {
  const { signature = true, initials = true, group, close = true } = parts;
  const panel = await openPanel(page, signerId, name);
  const suffix = group ? ` · Firma ${group}` : "";
  if (signature) {
    await panel.getByRole("button", { name: `Crear mi firma${suffix}`, exact: true }).click();
    await drawInOpenComposer(page, seed);
  }
  if (initials) {
    await panel.getByRole("button", { name: `Crear mis iniciales${suffix}`, exact: true }).click();
    await drawInOpenComposer(page, seed + 1);
  }
  if (close) {
    await panel.getByRole("button", { name: "Listo", exact: true }).click();
    await expect(panel).toBeHidden();
  }
}

/** Coloca un hueco de INICIALES del firmante dado (el paso «Documento» ya abierto). */
export async function placeInitialsSlot(page: Page, signer: string, offsetY: number): Promise<void> {
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

/** Arrastra un hueco de firma del firmante (por orden de aparicion) sin soltarlo hasta que la hoja deje de moverse. */
export async function dragSlot(page: Page, signer: string, dx: number, dy: number, index = 0): Promise<void> {
  const node = page.locator(`[data-element-kind="slot"][aria-label^="${signer}"]`).nth(index);
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

/** Centro (fraccion de la hoja) de cada hueco visible del lienzo: donde QUEDARON, para comparar luego con el PDF final. */
export async function slotCenters(page: Page): Promise<Array<{ x: number; y: number }>> {
  const surface = page.locator('img[alt]:not([alt=""])').first();
  const sheet = await surface.boundingBox();
  if (!sheet) throw new Error("no se encontro la hoja");
  const boxes = await page.locator('[data-element-kind="slot"][aria-label]').evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().toJSON()).filter((box) => box.width > 50),
  );
  return boxes.map((box) => ({ x: (box.x + box.width / 2 - sheet.x) / sheet.width, y: (box.y + box.height / 2 - sheet.y) / sheet.height }));
}

/** Cada centro tiene una imagen del PDF a menos de 5 % de la hoja (y no sobran imagenes). */
export function expectPlacementsAt(
  placements: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  centers: ReadonlyArray<{ x: number; y: number }>,
): void {
  expect(placements).toHaveLength(centers.length);
  for (const center of centers) {
    const near = placements.some((p) => Math.abs(p.x + p.width / 2 - center.x) < 0.05 && Math.abs(p.y + p.height / 2 - center.y) < 0.05);
    expect(near, `ninguna firma cerca de ${center.x.toFixed(2)},${center.y.toFixed(2)}`).toBe(true);
  }
}

const AXE_PATH = require.resolve("axe-core/axe.min.js");

/** axe-core (WCAG 2.x A/AA con contraste real) sobre un trozo de la pagina: las violaciones, con el elemento. */
export async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (scope) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run({ include: [scope] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}`);
  }, selector);
}

/** El objetivo mide al menos `min` px de alto y de ancho (43,5 por el redondeo del muestreo, para 44). */
export async function expectTarget(locator: Locator, label: string, min = 24): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} visible`).not.toBeNull();
  expect(box!.height, `${label} alto`).toBeGreaterThanOrEqual(min);
  expect(box!.width, `${label} ancho`).toBeGreaterThanOrEqual(min);
}

/** La pagina no gana scroll horizontal y ningun elemento sin recorte asoma por los lados. */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const clips = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") return true;
      }
      return false;
    };
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right > root.clientWidth + 1 || rect.left < -1) {
        if (clips(element)) continue;
        offenders.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").slice(0, 60)} [${Math.round(rect.left)}..${Math.round(rect.right)}] "${(element.textContent ?? "").trim().slice(0, 40)}"`);
      }
    }
    return { overflow: root.scrollWidth - root.clientWidth, clientWidth: root.clientWidth, offenders: offenders.slice(0, 5) };
  });
  expect(result.overflow, `${label}: scroll horizontal`).toBeLessThanOrEqual(1);
  expect(result.offenders, `${label}: elementos fuera de la pantalla (${result.clientWidth}px)`).toEqual([]);
}
