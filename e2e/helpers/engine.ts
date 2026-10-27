import type { Locator, Page } from "@playwright/test";

/**
 * Diferencias entre motores que las pruebas deben conocer (pruebas cruzadas opcionales en WebKit y Firefox, ver
 * `playwright.config.ts` y `docs/COMPATIBILIDAD-NAVEGADORES.md`). En Chromium todo esto es transparente: los
 * ayudantes devuelven exactamente lo que las pruebas ya hacian.
 */
export type EngineName = "chromium" | "webkit" | "firefox";

export function engineOf(page: Page): EngineName {
  const name = page.context().browser()?.browserType().name();
  return name === "webkit" || name === "firefox" ? name : "chromium";
}

/**
 * `true` en el WebKit de macOS (Safari y el WebKit de Playwright en un Mac), que tiene dos costumbres propias: el
 * Tab solo recorre campos y menus, y un clic no da el foco a un boton. El WebKit de Linux (GTK/WPE, el de un runner de
 * CI) se comporta como Chromium en ambas cosas, asi que ahi las pruebas siguen el camino de siempre.
 */
export function hasSafariFocusModel(page: Page): boolean {
  return engineOf(page) === "webkit" && process.platform === "darwin";
}

/**
 * Tecla que recorre los controles en el motor. Safari (y el WebKit de Playwright en un Mac, que reproduce sus valores
 * por defecto) solo lleva el Tab a campos de texto y menus: los botones, las casillas y los enlaces se alcanzan con
 * Opcion+Tab (salvo que el usuario active «Pulsar Tab para resaltar cada elemento» y el acceso total con teclado).
 */
export function tabKey(page: Page, reverse = false): string {
  const base = reverse ? "Shift+Tab" : "Tab";
  return hasSafariFocusModel(page) ? `Alt+${base}` : base;
}

/**
 * Mensajes de pagina que un motor emite sin que la aplicacion haya fallado y que Chromium no reporta como error de
 * pagina:
 * - «ResizeObserver loop completed with undelivered notifications»: aviso del navegador (WebKit lo lanza como
 *   excepcion de pagina; Chromium solo lo manda a `window.onerror`).
 * - «.../ruta?_rsc=... due to access control checks»: la precarga RSC de `next/link` que WebKit rechaza cuando se
 *   cancela al navegar (recargar o cambiar de pagina con precargas en vuelo). No es un fallo de la aplicacion.
 * - «.../pdf.worker.min.mjs?v=... due to access control checks»: lo mismo para el worker de pdf.js cuando la pagina se
 *   recarga mientras se estaba creando (una carga cancelada, no una carga fallida: esa deja el aviso de error del visor).
 * - «Cannot load blob:http://localhost:PUERTO/<uuid> due to access control checks» (y su version de excepcion de pagina
 *   «ttp://localhost:PUERTO/<uuid> due to access control checks»): WebKit lo escribe cuando se navega con una miniatura
 *   (`<img src=blob:>`) o una lectura de foto en vuelo y la carga se cancela. Medido igual en la version anterior al cambio.
 */
const BENIGN_ENGINE_NOISE: RegExp[] = [
  /^(?:Uncaught )?ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/,
  /\?_rsc=[\w-]+ due to access control checks\.?$/,
  /\/pdf\.worker\.min\.mjs\?v=[\w.]+ due to access control checks\.?$/,
  /^(?:Cannot load blob:h)?(?:ttp:)?(?:\/\/|http:\/\/)localhost:\d+\/[0-9a-f-]{36} due to access control checks\.?$/,
];

export function isBenignEngineNoise(message: string): boolean {
  return BENIGN_ENGINE_NOISE.some((pattern) => pattern.test(message.trim()));
}

/**
 * `true` para las URL de red REALES fuera de la aplicacion (http/https que no son `localhost`). Las URL `blob:` y
 * `data:` son internas (p. ej. el worker de tesseract.js se arranca desde un `blob:`): Chromium no las pasa por
 * `route()`, pero WebKit si, y abortarlas rompe el motor en vez de simular un corte de red.
 */
export function isExternalNetworkUrl(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "localhost";
}

/**
 * El aviso de consola que deja el motor de OCR (tesseract.js) cuando se corta la red a su CDN: Chromium escribe
 * «importScripts ... cdn.jsdelivr.net ... failed to load»; WebKit reenvia el error del worker a la pagina como
 * «Load failed» (excepcion de pagina). Es lo que las pruebas de «sin red» provocan a proposito.
 */
export const OCR_SCRIPT_FAILURE = /importScripts.*cdn\.jsdelivr\.net|^pageerror: Load failed$/;

/**
 * Activa un boton como lo haria quien navega con el teclado en Safari. Safari (WebKit en macOS) no da el foco a un boton al
 * hacer clic con el raton: el foco se queda en el contenedor enfocable mas cercano (p. ej. `<main tabindex="-1">`) y
 * la logica de «devolver el foco a su sitio» ya no encuentra un <body> que corregir. Las pruebas de FOCO usan esto para
 * ejercitar la misma ruta que un usuario de teclado o de lector de pantalla (Enter sobre el boton enfocado); en
 * Chromium y Firefox es un clic normal.
 */
export async function activate(button: Locator): Promise<void> {
  if (!hasSafariFocusModel(button.page())) {
    await button.click();
    return;
  }
  await button.focus();
  await button.page().keyboard.press("Enter");
}

/**
 * Clic de raton real en el centro del control, sin la comprobacion de «visible, estable y a la vista» de
 * `locator.click()`. En WebKit esa comprobacion desplaza la pagina por su cuenta cuando se encadenan clics sobre los
 * botones de la barra flotante de Editar (la pagina saltaba cientos de px y el boton quedaba fuera de la ventana: el
 * clic nunca llegaba). Un puntero de verdad no hace eso (el mismo recorrido con `page.mouse` no mueve la pagina). En
 * Chromium y Firefox es el clic de siempre.
 */
export async function pointerClick(target: Locator): Promise<void> {
  const page = target.page();
  if (engineOf(page) !== "webkit") {
    await target.click();
    return;
  }
  // Sin la espera de `click()`, hay que esperar aqui a que el control este quieto (un popover que sale con animacion).
  await target.waitFor({ state: "visible" });
  let previous = "";
  let still = 0;
  let box = await target.boundingBox();
  for (let attempt = 0; attempt < 60 && still < 3; attempt += 1) {
    await page.waitForTimeout(50);
    box = await target.boundingBox();
    const now = box ? `${box.x}:${box.y}:${box.width}:${box.height}` : "";
    still = now !== "" && now === previous ? still + 1 : 0;
    previous = now;
  }
  if (!box) throw new Error("pointerClick: el control no tiene caja");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Caja del control una vez QUIETA (misma posicion y tamano en 3 muestras seguidas, de 50 ms): para ratón manual (`page.mouse`). */
export async function stillBox(target: Locator, timeoutMs = 3000): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const page = target.page();
  let previous = "";
  let still = 0;
  let box = await target.boundingBox();
  for (let elapsed = 0; elapsed < timeoutMs && still < 3; elapsed += 50) {
    await page.waitForTimeout(50);
    box = await target.boundingBox();
    const now = box ? `${box.x}:${box.y}:${box.width}:${box.height}` : "";
    still = now !== "" && now === previous ? still + 1 : 0;
    previous = now;
  }
  return box;
}

/**
 * Pulsa `target` hasta que `done()` se cumple (como quien ve que el clic no hizo nada y vuelve a pulsar). En WebKit un
 * clic justo despues de montarse o cambiar una zona (tras volver a una pestana, tras aplicar) puede perderse sin error;
 * Chromium nunca lo pierde, asi que alli se pulsa una sola vez y `done()` ya se cumple.
 */
export async function clickUntil(target: Locator, done: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const page = target.page();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return;
    await target.click();
    const settled = Date.now() + 2_500;
    while (Date.now() < settled) {
      if (await done()) return;
      await page.waitForTimeout(100);
    }
  }
  throw new Error(`clickUntil: el clic no tuvo efecto en ${timeoutMs} ms`);
}
