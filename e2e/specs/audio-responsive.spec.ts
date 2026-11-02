import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { describeViolations, makeWav, recordWebm, runAxe, WIDE_CSS } from "../helpers/audio-flow";

/**
 * Responsive de las tres herramientas de audio (OptimusTOOLS · W-MP3), en Chromium headless y con TODAS sus pantallas:
 * vacia, con archivo cargado, procesando (la pantalla modal de progreso) y resultado. Cada pantalla se mide a 320, 390, 430,
 * 834 (iPad vertical), 1194 (iPad horizontal), 1280 y 1920 px, en claro y oscuro, ES y EN, con texto al 150 % (oscuro/ES) y con la
 * tipografia ancha (DejaVu + 6 %) del resto de specs (claro/EN), y comprueba:
 *  - sin desborde horizontal (ni documento ni cajas que asomen por los lados);
 *  - texto no cortado (cajas con `overflow: hidden` sin puntos suspensivos mas estrechas que su texto);
 *  - con tacto: todo control de al menos 44 x 44 px y, entre vecinos de la misma fila, al menos 8 px de separacion;
 *  - lo ultimo de la pagina queda por encima de las barras fijas de abajo (pie de acciones y barra de pestanas) al llegar al final;
 *  - las hojas y la pantalla de progreso caben en la ventana y su accion principal esta a la vista;
 *  - axe sin violaciones;
 *  - barra del reproductor de Audio Studio: Reproducir de 44 px, Deshacer y Rehacer de 44 x 44 con nombre accesible, los
 *    tiempos en UNA linea, y dos filas ordenadas en movil (una sola desde 640 px).
 * El procesamiento se detiene a proposito sustituyendo `Worker` por uno que no contesta (la salida MP3 lo necesita), de modo que
 * la pantalla de progreso permanece el tiempo de medirla; al cancelar se comprueba tambien que la cancelacion no depende del
 * Worker. Audio y video son sinteticos, generados aqui.
 */

test.use({ locale: "es-ES" });
test.use({ actionTimeout: 15_000 });
test.setTimeout(Number(process.env.RESP_TIMEOUT ?? 240_000));

type Viewport = { name: string; width: number; height: number; touch: boolean };
const VIEWPORTS: Viewport[] = [
  { name: "se-320", width: 320, height: 568, touch: true },
  { name: "iphone-390", width: 390, height: 844, touch: true },
  { name: "iphone-max-430", width: 430, height: 932, touch: true },
  { name: "ipad-vertical-834", width: 834, height: 1194, touch: true },
  { name: "ipad-horizontal-1194", width: 1194, height: 834, touch: true },
  { name: "portatil-1280", width: 1280, height: 800, touch: false },
  { name: "ancho-1920", width: 1920, height: 1080, touch: false },
];
type Combo = { theme: "light" | "dark"; language: "es" | "en"; bigText: boolean; wide: boolean };
const COMBOS: Combo[] = [
  { theme: "dark", language: "es", bigText: true, wide: false },
  { theme: "light", language: "en", bigText: false, wide: true },
];

const ROUTES = [
  { path: "/audio-converter", kind: "converter" as const, h1: /Convertidor de audio|Audio Converter/ },
  { path: "/audio-extractor", kind: "extractor" as const, h1: /Extraer audio|Extract audio/ },
  { path: "/audio-studio", kind: "studio" as const, h1: /Audio Studio/ },
];

const BIG_TEXT_CSS = "html { font-size: 150% !important; }";
async function context(browser: Browser, viewport: Viewport, combo: Combo): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch && viewport.width < 900,
    deviceScaleFactor: viewport.touch ? 2 : 1,
    colorScheme: combo.theme,
    locale: combo.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await ctx.addInitScript(
    ([theme, language, css]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
      } catch {
        /* almacenamiento bloqueado */
      }
      if (css) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      // Worker mudo: nunca contesta, asi la salida MP3 se queda «procesando» el tiempo de medir la pantalla de progreso.
      (window as unknown as { Worker: unknown }).Worker = class {
        onmessage = null;
        onerror = null;
        postMessage() {}
        addEventListener() {}
        removeEventListener() {}
        terminate() {}
      };
    },
    [combo.theme, combo.language, [combo.bigText ? BIG_TEXT_CSS : "", combo.wide ? WIDE_CSS : ""].join("\n")],
  );
  return ctx;
}

/* ------------------------------------------------------------------ *
 * Medidas dentro de la pagina
 * ------------------------------------------------------------------ */

type Probe = { problems: string[]; coarse: boolean; docOverflow: number };

/** Medidas en la pagina (el cuerpo de la funcion se serializa: no puede usar nada de fuera). */
function probePage(touch: boolean): Probe {
  const problems: string[] = [];
  const doc = document.documentElement;
  // Si algo de la aplicacion (la barra de pestanas, a 320 px con texto al 150 %) ensancha el documento, un movil amplia la ventana de
  // diseno hasta ese ancho y las barras fijas se estiran con ella: se mide contra esa ventana, no contra los 320 px fisicos.
  const vw = doc.scrollWidth > doc.clientWidth + 1 ? Math.max(doc.clientWidth, window.innerWidth) : doc.clientWidth;
  const vh = window.innerHeight;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const docOverflow = Math.max(0, doc.scrollWidth - doc.clientWidth);

  // Desborde de LO DE LA HERRAMIENTA (`#content` y hojas/pantalla de progreso): cualquier caja que asome por los lados y no
  // este recortada a proposito por un contenedor. Lo de la cabecera, el pie y la barra de pestanas se anota aparte.
  const roots = [document.getElementById("content"), ...Array.from(document.querySelectorAll<HTMLElement>("[role=dialog]"))].filter((element): element is HTMLElement => element !== null);
  const clipped = (element: Element): boolean => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") return true;
    }
    return false;
  };
  const seenBoxes = new Set<string>();
  for (const root of roots) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 1.5 || rect.height <= 1.5 || style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      if (element.closest("[inert],[aria-hidden=true],.sr-only")) continue;
      if (rect.right > vw + 1.5 || rect.left < -1.5) {
        if (clipped(element)) continue;
        const key = `${element.tagName}${Math.round(rect.left)}${Math.round(rect.right)}`;
        if (seenBoxes.has(key)) continue;
        seenBoxes.add(key);
        if (seenBoxes.size <= 4) problems.push(`desborde: <${element.tagName.toLowerCase()}> «${(element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28)}» [${Math.round(rect.left)}..${Math.round(rect.right)}] de ${vw}`);
      }
    }
  }

  // Solo lo de la herramienta (`#content`) y sus hojas/pantalla de progreso: la cabecera, el pie y la barra de pestanas son de la
  // aplicacion y tienen sus propias pruebas.
  const interactive = Array.from(
    document.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[role=button],[role=radio],[role=slider],[role=checkbox],[tabindex]:not([tabindex='-1'])"),
  ).filter((element) => {
    if (!element.closest("#content,[role=dialog]")) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 2 || rect.height <= 2 || style.visibility === "hidden" || style.display === "none") return false;
    if (element.closest("[aria-hidden=true],[hidden],[inert]")) return false;
    if (element.matches("input[type=file]")) return false; // el selector real esta oculto a la vista: el boton visible lo abre
    if (element.matches("a[href^='#']") && element.textContent?.includes("contenido")) return false; // «Saltar al contenido»
    return true;
  });
  const label = (element: HTMLElement) => (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || element.tagName).trim().replace(/\s+/g, " ").slice(0, 36);

  for (const element of interactive) {
    const rect = element.getBoundingClientRect();
    if (rect.right > vw + 1 || rect.left < -1) problems.push(`fuera de pantalla: «${label(element)}» [${Math.round(rect.left)}..${Math.round(rect.right)}] de ${vw}`);
    if (touch && coarse) {
      const inline = element.tagName === "A" && getComputedStyle(element).display === "inline"; // excepcion de WCAG 2.5.8: enlaces dentro de un parrafo
      if (!inline && (rect.height < 43.5 || rect.width < 43.5)) problems.push(`objetivo pequeno: «${label(element)}» ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
  }

  // Separacion entre vecinos de una misma fila (solo con tacto): al menos 8 px, entre controles hermanos.
  if (touch && coarse) {
    for (let i = 0; i < interactive.length; i += 1) {
      for (let j = i + 1; j < interactive.length; j += 1) {
        const a = interactive[i];
        const b = interactive[j];
        if (a.parentElement !== b.parentElement) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const sameRow = Math.abs(ra.top + ra.height / 2 - (rb.top + rb.height / 2)) < Math.min(ra.height, rb.height) / 2;
        if (!sameRow) continue;
        const gap = Math.max(rb.left - ra.right, ra.left - rb.right);
        if (gap >= -0.5 && gap < 7.5) problems.push(`separacion ${Math.round(gap)} px < 8 entre «${label(a)}» y «${label(b)}»`);
        // Hermanos que se pisan.
        const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 2 && overlapY > 2) problems.push(`se pisan «${label(a)}» y «${label(b)}»`);
      }
    }
  }

  // Texto cortado: cajas con `overflow: hidden` mas estrechas que su texto y sin puntos suspensivos.
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (element.closest("[inert],[aria-hidden=true]")) continue;
    const clips = style.overflowX === "hidden" || style.overflow === "hidden";
    const rect = element.getBoundingClientRect();
    if (clips && element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 0 && style.textOverflow !== "ellipsis" && element.children.length === 0 && rect.width > 4 && (element.textContent || "").trim().length > 2) {
      problems.push(`texto cortado: ${element.tagName.toLowerCase()} «${(element.textContent || "").trim().slice(0, 30)}» ${element.scrollWidth}>${element.clientWidth}`);
    }
  }

  // Hojas y pantalla de progreso: caben en la ventana (100dvh) y su accion principal esta a la vista.
  for (const dialog of Array.from(document.querySelectorAll<HTMLElement>("[role=dialog]"))) {
    const rect = dialog.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) continue;
    if (rect.top < -1 || rect.bottom > vh + 2 || rect.left < -1 || rect.right > vw + 1) problems.push(`dialogo fuera de la ventana: top ${Math.round(rect.top)} bottom ${Math.round(rect.bottom)} de ${vh}`);
    const primary = Array.from(dialog.querySelectorAll<HTMLElement>("button")).find((button) => /^(Procesar|Process|Cancelar|Cancel)$/.test((button.textContent || "").trim()));
    if (primary) {
      const rb = primary.getBoundingClientRect();
      if (rb.bottom > vh + 2 || rb.top < -1) problems.push(`accion principal del dialogo fuera de la ventana: «${label(primary)}» ${Math.round(rb.top)}..${Math.round(rb.bottom)} de ${vh}`);
    }
  }
  return { problems, coarse, docOverflow };
}

/** Al llegar al final de la pagina, lo ultimo queda por encima de las barras fijas de abajo (pie de acciones, pestanas). */
async function bottomClearance(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const vh = window.innerHeight;
    const vw = document.documentElement.clientWidth;
    let barTop = vh;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const style = getComputedStyle(element);
      if (style.position !== "fixed" || style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width >= vw * 0.85 && rect.height > 20 && rect.height < vh * 0.6 && rect.bottom >= vh - 2 - parseFloat(style.bottom || "0") && rect.top > vh * 0.3 && !element.closest("[role=dialog]")) {
        barTop = Math.min(barTop, rect.top);
      }
    }
    let contentBottom = 0;
    let last = "";
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("#content *"))) {
      const style = getComputedStyle(element);
      if (style.position === "fixed" || style.display === "none" || style.visibility === "hidden" || element.closest("[inert]")) continue;
      let insideFixed = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (getComputedStyle(parent).position === "fixed") insideFixed = true;
      }
      if (insideFixed) continue; // lo que vive DENTRO de la barra fija es la propia barra
      const rect = element.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      if ((element.textContent || "").trim().length === 0 && element.children.length === 0 && !element.matches("button,input,select,svg,canvas")) continue;
      if (rect.bottom > contentBottom && rect.bottom <= vh + 4) {
        contentBottom = rect.bottom;
        last = `${element.tagName.toLowerCase()} «${(element.textContent || "").trim().slice(0, 24)}»`;
      }
    }
    window.scrollTo(0, 0);
    return contentBottom > barTop + 1 ? [`contenido tapado por una barra fija: ${last} termina en ${Math.round(contentBottom)} y la barra empieza en ${Math.round(barTop)}`] : [];
  });
}

/** Barra del reproductor de Audio Studio: tamanos, nombres accesibles, una linea de tiempos y orden de las filas. */
async function transportProblems(page: Page, width: number): Promise<string[]> {
  return page.evaluate((viewportWidth) => {
    const problems: string[] = [];
    const bar = document.querySelector<HTMLElement>("[data-testid=transport-bar]");
    if (!bar) return ["falta la barra del reproductor"];
    const play = bar.querySelector<HTMLElement>("[data-action=play]");
    const undo = bar.querySelector<HTMLElement>("[data-action=undo]");
    const redo = bar.querySelector<HTMLElement>("[data-action=redo]");
    const clock = bar.querySelector<HTMLElement>("[data-testid=clock]");
    if (!play || !undo || !redo || !clock) return ["faltan controles en la barra del reproductor"];
    const [rp, ru, rr, rc] = [play, undo, redo, clock].map((element) => element.getBoundingClientRect());
    // Medidas en rem: con el texto al 150 % los controles crecen con el (66 px), nunca bajan de 44.
    const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
    if (rp.height < 43.5) problems.push(`Reproducir mide ${Math.round(rp.height)} px de alto`);
    for (const [name, rect] of [["Deshacer", ru], ["Rehacer", rr]] as const) {
      if (rect.width < 43.5 || rect.height < 43.5 || Math.abs(rect.width - rect.height) > 1 || Math.abs(rect.width - 44 * scale) > 1.5) {
        problems.push(`${name} mide ${Math.round(rect.width)}x${Math.round(rect.height)}, no 44x44 (x${scale} de texto)`);
      }
    }
    for (const [name, element] of [["Deshacer", undo], ["Rehacer", redo]] as const) {
      if (!element.getAttribute("aria-label")) problems.push(`${name} no tiene aria-label`);
      if ((element.textContent || "").trim().length > 0) problems.push(`${name} deberia ser solo icono`);
      if (!element.querySelector("svg") || element.querySelector("svg")!.getBoundingClientRect().width < 16) problems.push(`${name}: el icono es mas pequeno de 16 px`);
    }
    const gap = rr.left - ru.right;
    if (gap < 7.5) problems.push(`Deshacer y Rehacer separados por ${Math.round(gap)} px`);
    // Tiempos en UNA linea: la caja de texto tiene un unico rectangulo de linea y no se parte.
    const style = getComputedStyle(clock);
    if (style.whiteSpace !== "nowrap" || !style.fontVariantNumeric.includes("tabular-nums")) problems.push(`los tiempos no son nowrap/tabulares (${style.whiteSpace}, ${style.fontVariantNumeric})`);
    const lineHeight = parseFloat(style.lineHeight) || rc.height;
    if (rc.height > lineHeight * 1.2) problems.push(`los tiempos ocupan ${Math.round(rc.height)} px de alto (una linea son ${Math.round(lineHeight)})`);
    const text = (clock.textContent || "").replace(/\s+/g, " ");
    if (!/\d:\d\d\.\d\d \/ \d:\d\d\.\d\d/.test(text)) problems.push(`formato de tiempos inesperado: «${text}»`);
    // Filas: desde 640 px todo en una (los centros coinciden); por debajo, Reproducir y los iconos arriba y los tiempos debajo.
    const centers = [rp, ru, rr, rc].map((rect) => rect.top + rect.height / 2);
    if (viewportWidth >= 640) {
      if (Math.max(...centers) - Math.min(...centers) > 8) problems.push(`en ${viewportWidth} px la barra deberia ir en una fila (centros ${centers.map(Math.round)})`);
      if (!(rp.right <= rc.left + 1 && rc.right <= ru.left + 1)) problems.push("orden de izquierda a derecha: Reproducir, tiempos, Deshacer, Rehacer");
    } else {
      if (rc.top < Math.max(rp.bottom, ru.bottom, rr.bottom) - 1) problems.push("en movil los tiempos deberian ir en una segunda fila, debajo");
      // Con texto normal, Reproducir y los iconos comparten la primera fila; con texto muy grande los iconos pueden bajar, pero nunca pisarse.
      if (scale <= 1.2 && Math.abs(rp.top - ru.top) > 8) problems.push("en movil Reproducir y los iconos deberian compartir la primera fila");
      const boxes = [rp, ru, rr];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const ox = Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left);
          const oy = Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top);
          if (ox > 1 && oy > 1) problems.push("dos controles de la barra del reproductor se pisan");
        }
      }
    }
    for (const rect of [rp, ru, rr, rc]) if (rect.right > viewportWidth + 1 || rect.left < -1) problems.push("un control de la barra se sale de la pantalla");
    return problems;
  }, width);
}

/* ------------------------------------------------------------------ *
 * Recorrido de cada herramienta
 * ------------------------------------------------------------------ */

const input = (page: Page) => page.locator('input[type="file"]').first();
const run = (page: Page) => page.getByRole("button", { name: /^(Procesar|Process)$/ }).first();
const download = (page: Page) => page.getByRole("button", { name: /^(Descargar|Download)$/ });
const mp3Radio = (page: Page) => page.locator('[role="radio"][data-format="mp3"]');
let webmCache: Buffer | null = null;

async function open(page: Page, route: (typeof ROUTES)[number]) {
  await page.goto(route.path, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: route.h1 })).toBeVisible();
}

async function addFile(page: Page, route: (typeof ROUTES)[number]) {
  if (route.kind === "extractor") {
    webmCache ??= await recordWebm(page, { audio: true, video: true, ms: 900 });
    await input(page).setInputFiles({ name: "escena-con-un-nombre-algo-largo.webm", mimeType: "video/webm", buffer: webmCache });
    await expect(page.getByText(/escena-con-un-nombre/)).toBeVisible();
    await expect(run(page)).toBeEnabled({ timeout: 30_000 });
  } else {
    await input(page).setInputFiles([
      { name: "grabacion-con-un-nombre-algo-largo.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 4, sampleRate: 22050, channels: 1 }) },
      { name: "aviso.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1, sampleRate: 22050, channels: 1, frequency: 880 }) },
    ]);
    if (route.kind === "studio") {
      await expect(page.getByRole("slider", { name: /Forma de onda|Audio waveform/ })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-action=play]")).toBeEnabled({ timeout: 30_000 }); // deja de estar «ocupado»: los botones pasan de gris a su color
    } else await expect(run(page)).toBeEnabled({ timeout: 30_000 });
  }
  await expect(page.getByText(/Comprobando qué formatos|Checking which formats/)).toBeHidden({ timeout: 10_000 });
}

/** Elige MP3, abriendo antes la hoja de opciones si esta en movil. Devuelve true si dejo una hoja abierta. */
async function pickMp3(page: Page, route: (typeof ROUTES)[number]): Promise<void> {
  if (route.kind !== "studio" && !(await mp3Radio(page).isVisible())) {
    await page.getByRole("button", { name: /^(Opciones|Options)$/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  await expect(mp3Radio(page)).toBeVisible();
  await mp3Radio(page).scrollIntoViewIfNeeded();
  await mp3Radio(page).click();
  await expect(mp3Radio(page)).toHaveAttribute("aria-checked", "true");
}

/** Audita la pantalla actual y devuelve los problemas con la etiqueta de la pantalla delante. */
async function audit(page: Page, label: string, viewport: Viewport, options: { axe?: boolean; bottom?: boolean; known?: RegExp } = {}): Promise<string[]> {
  const out: string[] = [];
  // Las transiciones de color (un boton que deja de estar desactivado) falsean el contraste mientras corren: se espera a que acaben.
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))), new Promise((resolve) => setTimeout(resolve, 2000))]);
  });
  const log = (step: string) => process.env.RESP_LOG && console.log(`   ${label} · ${step}`);
  log("sonda");
  const probe = await page.evaluate(probePage, viewport.touch);
  out.push(...probe.problems);
  // El desborde del documento sin culpa de la herramienta viene de la cabecera/pie de la aplicacion: se anota, no se cuenta.
  if (probe.docOverflow > 1 && probe.problems.every((problem) => !problem.startsWith("desborde"))) {
    const note = `${label}: el documento desborda ${Math.round(probe.docOverflow)} px por la cabecera, el pie o la barra de pestanas de la aplicacion`;
    if (!test.info().annotations.some((annotation) => annotation.description === note)) test.info().annotations.push({ type: "chrome-overflow", description: note });
  }
  log("barras");
  if (options.bottom !== false) out.push(...(await bottomClearance(page)));
  log("axe");
  if (options.axe !== false) {
    const violations = await runAxe(page);
    if (violations.length > 0) out.push(`axe:\n${describeViolations(violations)}`);
  }
  // Defectos CONOCIDOS de componentes compartidos que esta pasada no puede tocar (ver el informe): se anotan, no se cuentan.
  const known = options.known ? out.filter((problem) => options.known!.test(problem)) : [];
  for (const problem of known) test.info().annotations.push({ type: "shared-defect", description: `${label}: ${problem}` });
  // Sin duplicados (el mismo control puede salir varias veces).
  return Array.from(new Set(out.filter((problem) => !known.includes(problem)))).map((problem) => `[${label}] ${problem}`);
}

for (const viewport of VIEWPORTS) {
  for (const combo of COMBOS) {
    const title = `${viewport.name} (${viewport.width}x${viewport.height}) · ${combo.theme} · ${combo.language}${combo.bigText ? " · texto al 150 %" : ""}${combo.wide ? " · tipografia ancha" : ""}`;
    test(`audio: todas las pantallas sin desborde, objetivos de 44 px y barras sin tapar contenido: ${title}`, async ({ browser }) => {
      const ctx = await context(browser, viewport, combo);
      const page = await ctx.newPage();
      const problems: string[] = [];
      try {
        for (const route of ROUTES) {
          if (process.env.RESP_ONLY && !process.env.RESP_ONLY.split(",").includes(route.kind)) continue; // depuracion: RESP_ONLY=studio
          const where = (state: string) => {
            if (process.env.RESP_LOG) console.log(`${viewport.name} ${combo.language} ${route.kind} · ${state}`);
            return `${route.kind} · ${state}`;
          };

          // 1 · vacia
          await open(page, route);
          problems.push(...(await audit(page, where("vacia"), viewport)));

          // 2 · cargada
          await open(page, route);
          await addFile(page, route);
          problems.push(...(await audit(page, where("cargada"), viewport)));
          if (route.kind === "studio") problems.push(...(await transportProblems(page, viewport.width)).map((problem) => `[${where("cargada")}] ${problem}`));
          // La hoja de opciones en movil: caben en la ventana y «Procesar» esta a la vista.
          if (route.kind !== "studio" && viewport.width < 768) {
            await page.getByRole("button", { name: /^(Opciones|Options)$/ }).click();
            await expect(page.getByRole("dialog")).toBeVisible();
            await page.waitForTimeout(700); // fin de la animacion de subida de la hoja
            problems.push(...(await audit(page, where("hoja de opciones"), viewport, { bottom: false })));
            await page.keyboard.press("Escape");
            await expect(page.getByRole("dialog")).toBeHidden();
          }

          // 3 · procesando (Worker mudo: la pantalla de progreso se queda) y cancelar
          await pickMp3(page, route);
          if (route.kind !== "studio" && viewport.width < 768) await page.keyboard.press("Escape");
          if (route.kind === "studio") await page.getByRole("button", { name: /^(Exportar audio|Export audio)$/ }).click();
          else await run(page).click();
          const overlay = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: /^(Cancelar|Cancel)$/ }) });
          await expect(overlay).toBeVisible({ timeout: 15_000 });
          await page.waitForTimeout(500); // fin de la animacion de entrada
          problems.push(...(await audit(page, where("procesando"), viewport, { bottom: false })));
          await overlay.getByRole("button", { name: /^(Cancelar|Cancel)$/ }).click();
          await expect(overlay).toBeHidden({ timeout: 10_000 });

          // 4 · resultado (WAV, sin Worker)
          await open(page, route);
          await addFile(page, route);
          if (route.kind === "studio") {
            await page.getByRole("button", { name: /^(Exportar audio|Export audio)$/ }).click();
            await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 60_000 });
          } else {
            await run(page).click();
            await expect(download(page)).toBeVisible({ timeout: 60_000 });
          }
          await expect(page.getByRole("dialog")).toHaveCount(0); // la pantalla de progreso ya salio del todo
          await page.waitForTimeout(400);
          // `DownloadScreen` (compartido, no es de audio): su boton «Descargar» (size lg, sin `wrap`) mide 336 px a 320 px con texto al 150 %.
          const sharedDownload = viewport.width <= 320 && combo.bigText ? /«(Descargar|Download)»/ : undefined;
          problems.push(...(await audit(page, where("resultado"), viewport, { known: sharedDownload })));
        }
      } finally {
        await ctx.close();
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
}
