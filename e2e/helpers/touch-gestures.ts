/**
 * Gestos tactiles REALES para los E2E moviles/iPad (unidad M3 · lienzo compartido, safe-area y UI base).
 *
 * `page.touchscreen.tap` solo sabe tocar. Para arrastrar, pellizcar o mantener se envian eventos de tacto de bajo nivel
 * por el protocolo de DevTools (`Input.dispatchTouchEvent`), que Chromium trata como un dedo de verdad: pasa por el
 * reconocedor de gestos (desplazamiento, `touch-action`, `pointercancel`). WebKit no expone ese canal: los E2E que usan
 * estas piezas son de Chromium (perfil iOS) y se saltan en los otros motores con `test.skip(!isChromium)`.
 *
 * Todo es headless. Los PDF son sinteticos (pdf-lib), jamas los reales del usuario.
 */
import { expect, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";

export type Point = { x: number; y: number };

/** Perfiles de dispositivo (Chromium con agente de usuario de iOS: no hay otro motor que acepte tacto por CDP). */
export const DEVICES = {
  se320: { width: 320, height: 568, dpr: 2 },
  se375: { width: 375, height: 667, dpr: 2 },
  iphone15: { width: 393, height: 852, dpr: 3 },
  iphoneLandscape: { width: 852, height: 393, dpr: 3 },
  ipadMini: { width: 744, height: 1133, dpr: 2 },
  ipadPortrait: { width: 834, height: 1194, dpr: 2 },
  ipadLandscape: { width: 1194, height: 834, dpr: 2 },
} as const;
export type DeviceName = keyof typeof DEVICES;

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export function isChromium(page: Page): boolean {
  return page.context().browser()?.browserType().name() === "chromium";
}

/** Contexto tactil (`pointer: coarse`, `hover: none`) con las medidas del dispositivo. */
export async function newTouchContext(
  browser: Browser,
  device: DeviceName,
  options: { colorScheme?: "light" | "dark"; locale?: "es-ES" | "en-US" } = {},
): Promise<BrowserContext> {
  const spec = DEVICES[device];
  const isPhone = device.startsWith("se") || device.startsWith("iphone");
  return browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: spec.dpr,
    hasTouch: true,
    isMobile: true,
    userAgent: isPhone ? IPHONE_UA : IPAD_UA,
    colorScheme: options.colorScheme ?? "light",
    locale: options.locale ?? "es-ES",
  });
}

export async function cdpOf(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Un dedo de `from` a `to` en `steps` pasos (cada `stepMs`); `holdMs` espera quieto antes de mover. */
export async function touchDrag(
  cdp: CDPSession,
  from: Point,
  to: Point,
  { steps = 14, stepMs = 16, holdMs = 0, endHoldMs = 0 }: { steps?: number; stepMs?: number; holdMs?: number; endHoldMs?: number } = {},
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  if (holdMs) await sleep(holdMs);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }],
    });
    await sleep(stepMs);
  }
  if (endHoldMs) await sleep(endHoldMs);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Un dedo por una ruta de puntos; el dedo se queda `endHoldMs` en el ultimo antes de levantarse. */
export async function touchPath(
  cdp: CDPSession,
  points: readonly Point[],
  { stepMs = 16, holdMs = 0, endHoldMs = 0 }: { stepMs?: number; holdMs?: number; endHoldMs?: number } = {},
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: points[0].x, y: points[0].y, id: 1 }] });
  if (holdMs) await sleep(holdMs);
  for (const point of points.slice(1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
    await sleep(stepMs);
  }
  if (endHoldMs) await sleep(endHoldMs);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Toque corto (sin mover) en `point`. */
export async function touchTap(cdp: CDPSession, point: Point, holdMs = 40): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  await sleep(holdMs);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Pellizco de dos dedos alrededor de `center`: la distancia pasa de `d0` a `d1` (px). */
export async function touchPinch(
  cdp: CDPSession,
  center: Point,
  d0: number,
  d1: number,
  { steps = 12, stepMs = 16, drift }: { steps?: number; stepMs?: number; drift?: Point } = {},
): Promise<void> {
  const fingers = (distance: number, shift: Point) => [
    { x: center.x + shift.x - distance / 2, y: center.y + shift.y, id: 1 },
    { x: center.x + shift.x + distance / 2, y: center.y + shift.y, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(d0, { x: 0, y: 0 }) });
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const shift = drift ? { x: drift.x * t, y: drift.y * t } : { x: 0, y: 0 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(d0 + (d1 - d0) * t, shift) });
    await sleep(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Zonas de seguridad del dispositivo (muesca, isla, indicador de inicio): `Emulation.setSafeAreaInsetsOverride`. */
export async function setSafeArea(
  cdp: CDPSession,
  insets: { top?: number; bottom?: number; left?: number; right?: number },
): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: insets.top ?? 0, bottom: insets.bottom ?? 0, left: insets.left ?? 0, right: insets.right ?? 0 },
  });
}

/** PDF sintetico A4 con texto (no apaisado, para que la hoja sea alta en el telefono). */
export async function makeA4Pdf(label: string, pages = 2, size: readonly [number, number] = [595, 842]): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= pages; index += 1) {
    const sheet = doc.addPage([size[0], size[1]]);
    sheet.drawText(`${label} pagina ${index}`, { x: 50, y: size[1] - 62, size: 24, font });
    for (let line = 0; line < 30; line += 1) {
      sheet.drawText(`Clausula ${line + 1}. Texto de ejemplo del contrato que no importa.`, {
        x: 50,
        y: size[1] - 102 - line * 22,
        size: 11,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
    }
  }
  return Buffer.from(await doc.save());
}

/** Abre /sign-pdf, sube un A4 de `pages` hojas y espera a que el lienzo muestre la hoja. */
export async function openSignWithPdf(page: Page, pages = 2, size?: readonly [number, number]): Promise<void> {
  await page.addInitScript(() => {
    try {
      // El aviso de privacidad ya visto: no ocupa 1 000 px antes del lienzo.
      localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
    } catch {
      /* sin almacenamiento */
    }
  });
  await page.goto("/sign-pdf");
  await page
    .locator('input[type="file"][accept*="pdf"]')
    .first()
    .setInputFiles([{ name: "Contrato.pdf", mimeType: "application/pdf", buffer: await makeA4Pdf("Contrato", pages, size) }]);
  await expect(page.locator('[data-canvas="host"] img').first()).toBeVisible({ timeout: 30_000 });
}

/** Traza una firma con el dedo en el compositor abierto y pulsa «Usar esta firma». */
export async function drawSignatureWithTouch(page: Page, cdp: CDPSession): Promise<void> {
  const dialog = page.getByRole("dialog");
  const canvas = dialog.locator("canvas").first();
  await expect(canvas).toBeVisible();
  let box = await canvas.boundingBox();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(100);
    const next = await canvas.boundingBox();
    if (box && next && next.x === box.x && next.y === box.y) break;
    box = next;
  }
  if (!box) throw new Error("sin lienzo de firma");
  const at = (a: number, b: number): Point => ({ x: box!.x + box!.width * a, y: box!.y + box!.height * b });
  await touchPath(cdp, [at(0.1, 0.5), at(0.3, 0.3), at(0.5, 0.65), at(0.7, 0.35), at(0.9, 0.5)]);
  await dialog.getByRole("button", { name: /Usar esta firma|Use this signature/ }).click();
  // (M6 · H2) 5 s no bastaban en el CI de GitHub (2 CPU cargadas): el compositor recorta y codifica el PNG de la firma antes de
  // cerrarse. Es una espera de la prueba, no del producto: se da el mismo margen que al resto de esperas de carga del archivo.
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

/** Lienzo de «Solo yo» con la firma ya colocada (el flujo de un ajustador: subir, crear firma, usarla). */
export async function openSoloCanvasWithSignature(
  page: Page,
  cdp: CDPSession,
  pages = 2,
  size?: readonly [number, number],
): Promise<void> {
  await openSignWithPdf(page, pages, size);
  await page.getByRole("button", { name: /Crear firma|Create signature/ }).first().click();
  await drawSignatureWithTouch(page, cdp);
  await expect(page.locator(".sign-field-box").first()).toBeVisible({ timeout: 15_000 });
}

export function host(page: Page): Locator {
  return page.locator('[data-canvas="host"]');
}

export async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}

/** Lleva la hoja a la vista dejando margen arriba para la barra de zoom. */
export async function revealSheet(page: Page): Promise<void> {
  await host(page).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  await page.waitForTimeout(250);
}

export async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("sin caja");
  return box;
}

/**
 * En un telefono (< 768 px) la paleta de Firmar llega PLEGADA en un boton con la herramienta activa (SC-02 de la
 * auditoria): si lo esta, la abre. En tablet y escritorio la paleta ya esta abierta y no hace nada.
 */
export async function unfoldPalette(page: Page): Promise<void> {
  const fab = page.locator("[data-palette-fab]");
  if (await fab.isVisible().catch(() => false)) {
    await fab.click();
    await expect(page.getByRole("toolbar", { name: /Herramientas del documento|Document tools/ })).toBeVisible();
  }
}

/** Elige una herramienta de la paleta (la abre antes si esta plegada); en un telefono elegir una la vuelve a plegar. */
export async function pickTool(page: Page, name: RegExp): Promise<void> {
  await unfoldPalette(page);
  await page.getByRole("toolbar", { name: /Herramientas del documento|Document tools/ }).getByRole("button", { name }).click();
  await page.waitForTimeout(250);
}

/**
 * Franja de la pantalla que de verdad ve la persona: por arriba, hasta donde llega la barra de zoom pegajosa; por abajo,
 * hasta la capa fija o pegajosa mas alta que toca el borde inferior (tab bar, barra «Opciones/Procesar», «Continuar» y el
 * dock plegable de la paleta). Medida independiente de la que usa el propio lienzo.
 */
export async function visibleBand(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const sticky = document.querySelector("[data-canvas-sticky]")?.getBoundingClientRect();
    let bottom = vh;
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const cs = getComputedStyle(element);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = element.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.height < 24 || r.top < vh * 0.4 || r.bottom < vh - 220) continue;
      bottom = Math.min(bottom, r.top);
    }
    // La barra de zoom pegada arriba (en Pro, arriba de la region que se desplaza, ya bajo la cabecera de Firmar).
    return { top: sticky && sticky.top < vh * 0.5 ? sticky.bottom : 0, bottom };
  });
}

/**
 * Un punto DENTRO de lo que se ve de la hoja (la fraccion `fx`/`fy` de su caja, recortada a la franja visible con
 * 40 px de margen): tras «Usar esta firma» la pagina queda desplazada hasta la firma y la parte alta de la hoja puede
 * estar bajo la barra de zoom, asi que «el 30 % del alto de la hoja» ya no es un sitio que se pueda tocar.
 */
export async function sheetPoint(page: Page, fx = 0.4, fy = 0.3): Promise<Point> {
  const sheet = await boxOf(host(page));
  const band = await visibleBand(page);
  const top = Math.max(sheet.y, band.top) + 40;
  const bottom = Math.min(sheet.y + sheet.height, band.bottom) - 40;
  const wanted = sheet.y + sheet.height * fy;
  return { x: sheet.x + sheet.width * fx, y: Math.max(top, Math.min(wanted, bottom)) };
}
