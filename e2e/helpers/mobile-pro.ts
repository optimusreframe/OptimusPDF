/**
 * Piezas comunes de los E2E «PDF Pro en movil e iPad» (M2): perfiles de pantalla, abrir un PDF sintetico, medir la zona de la
 * hoja de un modo y gestos tactiles REALES (CDP `Input.dispatchTouchEvent`, solo Chromium). SIEMPRE headless.
 */
import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect } from "./tool-flow";
import { makePdf } from "./test-files";

export type Profile = {
  name: string;
  width: number;
  height: number;
  /** Alto minimo (px) de la hoja visible en Editar y Anotar. */
  minSheet: number;
  /** Cabe una hoja de pagina util en los modos de Pro (VP-01). */
  landscape?: boolean;
};

/** Pantallas del informe de auditoria (docs/AUDITORIA-MOVIL-IPAD.md §0). */
export const PROFILES: readonly Profile[] = [
  { name: "iPhone SE 320×568", width: 320, height: 568, minSheet: 190 },
  { name: "iPhone SE 375×667", width: 375, height: 667, minSheet: 300 },
  { name: "iPhone 15 Pro 393×852", width: 393, height: 852, minSheet: 330 },
  { name: "iPhone horizontal 852×393", width: 852, height: 393, minSheet: 150, landscape: true },
  { name: "móvil apaisado 800×360", width: 800, height: 360, minSheet: 130, landscape: true },
  { name: "iPad mini 744×1133", width: 744, height: 1133, minSheet: 500 },
  { name: "iPad Pro vertical 834×1194", width: 834, height: 1194, minSheet: 600 },
  { name: "iPad Pro horizontal 1194×834", width: 1194, height: 834, minSheet: 400, landscape: true },
] as const;

export const isCompactProfile = (profile: Profile): boolean => profile.width < 768 || profile.height < 480;

export async function openProDoc(page: Page, options: { pages?: number; name?: string; bytes?: Buffer } = {}): Promise<void> {
  const name = options.name ?? "informe.pdf";
  const bytes = options.bytes ?? (await makePdf({ pages: options.pages ?? 3, label: "MOV", size: [595, 842] }));
  await page.goto("/pdf-pro");
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
}

/** Va a una pestaña: dock (movil), pestañas (escritorio). */
export async function openTab(page: Page, tab: "home" | "pages" | "edit" | "annotate" | "sign" | "protect" | "convert"): Promise<void> {
  const dock = page.locator(`[data-dock="${tab}"]`);
  if (await dock.isVisible().catch(() => false)) await dock.click();
  else await page.locator(`[role="tab"][data-tab="${tab}"]`).click();
}

/**
 * Alto (px) de la hoja que se VE de verdad en un modo: cuenta, a pasos de 4 px, los puntos del eje central de la pantalla donde
 * lo que hay encima (`elementFromPoint`) es el lienzo de la pagina o algo que cuelga de el. Ni lo que queda fuera de la
 * pantalla ni lo que tapa una barra cuenta.
 */
export async function visibleSheetHeight(page: Page, mode: "edit" | "annotate" | "sign"): Promise<number> {
  return page.evaluate((which) => {
    const host = document.querySelector("[data-pro-mode-host]");
    if (!host) return -1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sheets = Array.from(host.querySelectorAll<HTMLElement>("canvas, img")).filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 120 && box.height > 120;
    });
    if (sheets.length === 0) return 0;
    // El area de la hoja: la region con desplazamiento del editor, o el propio lienzo.
    const stage = which === "sign" ? null : host.querySelector<HTMLElement>("[data-edit-scroll]");
    let counted = 0;
    for (let y = 0; y < vh; y += 4) {
      const x = Math.min(vw - 2, Math.max(2, Math.round(sheets[0].getBoundingClientRect().left + sheets[0].getBoundingClientRect().width / 2)));
      const top = document.elementFromPoint(Math.min(x, vw - 2), y);
      if (!top) continue;
      const hit = which === "sign" ? sheets.some((sheet) => sheet === top || sheet.parentElement?.contains(top)) : stage?.contains(top) === true;
      if (hit) counted += 4;
    }
    return counted;
  }, mode);
}

/* ------------------------------------------------------------------ *
 * Gestos tactiles reales (Chromium)
 * ------------------------------------------------------------------ */

export type Point = { x: number; y: number };

export async function touchStart(cdp: CDPSession, point: Point): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
}
export async function touchMove(cdp: CDPSession, point: Point): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1 }] });
}
export async function touchEnd(cdp: CDPSession): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Arrastre con un dedo de `from` a `to` en `steps` pasos. */
export async function touchDrag(page: Page, cdp: CDPSession, from: Point, to: Point, steps = 14): Promise<void> {
  await touchStart(cdp, from);
  for (let i = 1; i <= steps; i += 1) {
    await touchMove(cdp, { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
    await page.waitForTimeout(16);
  }
  await touchEnd(cdp);
}

export async function center(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("el elemento no tiene caja");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function noHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
}
