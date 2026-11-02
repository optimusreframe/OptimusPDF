import path from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import { minGapBetweenControls } from "../helpers/touch-measure";
import { STRINGS as VIDEO_STRINGS } from "../../src/app/video-converter/strings";

/**
 * Responsive Apple Design · pasada de W-RESP-B (Inicio, Precios, Ajustes, Documentos, Recientes, Sobre nosotros, Privacidad,
 * Downloader, HTML a PDF, Convertidor de imagenes y de video) y de los componentes COMPARTIDOS que tocan (casilla, muestras de
 * color, segmentado, zona de carga, pantalla de descarga, hoja, rejilla de iconos, pie de pagina). Todo en Chromium headless,
 * con datos sinteticos y SIN red (la ruta `/api/html-snapshot` se intercepta).
 *
 *  1. Matriz de rutas x 7 viewports (320, 390, 430, iPad 834 vertical, iPad 1194 horizontal, 1280, 1920): sin desborde horizontal,
 *     sin controles fuera de pantalla, sin texto cortado y, con tacto, todo objetivo >= 44 px. Claro/ES siempre; oscuro/EN en 4.
 *  2. Tipografia grande: la regla de «tipografia ancha» de `nav-optimustools.spec.ts` (DejaVu + 6 %) y la fuente del sistema al 150 %.
 *  3. Estados de las tres herramientas (reposo, con archivo, hoja de opciones, resultado, errores) a 320/390/834/1194, con axe.
 *  4. Patrones compartidos medidos en rutas de otras duenas: muestras de color, segmentado `sm`, casillas.
 *  5. Capacidades: video sin `VideoEncoder`/`VideoDecoder`/`AudioEncoder`, HTML a PDF y conversor de imagenes sin ellos y sin
 *     `createImageBitmap`/`OffscreenCanvas`: mensaje honesto o la ruta de respaldo, nunca una pantalla rota.
 *  6. Hoja de compartir como plan B de la descarga, tope de peso real de la zona de carga, `prefers-reduced-motion`.
 *
 * Uso: PW_PORT=4040 npx playwright test e2e/specs/responsive-resp-b.spec.ts
 */

test.setTimeout(180_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const FIXTURE_PDF = path.resolve(__dirname, "../fixtures/compare-before.pdf");
const VIDEO_ES = VIDEO_STRINGS.es;

type Theme = "light" | "dark";
type Language = "es" | "en";
type Viewport = { name: string; width: number; height: number; touch: boolean };

const VIEWPORTS: Viewport[] = [
  { name: "iPhone SE 320", width: 320, height: 568, touch: true },
  { name: "iPhone 390", width: 390, height: 844, touch: true },
  { name: "iPhone Max 430", width: 430, height: 932, touch: true },
  { name: "iPad vertical 834", width: 834, height: 1194, touch: true },
  { name: "iPad horizontal 1194", width: 1194, height: 834, touch: true },
  { name: "portatil 1280", width: 1280, height: 800, touch: false },
  { name: "ancho 1920", width: 1920, height: 1080, touch: false },
];
const [SE, PHONE, , IPAD_V, IPAD_H] = VIEWPORTS;

/** Las rutas de esta unidad (las del encargo). */
const ROUTES = [
  "/",
  "/pricing",
  "/settings",
  "/documents",
  "/recent",
  "/about",
  "/privacy",
  "/downloader",
  "/html-to-pdf",
  "/image-converter",
  "/video-converter",
];

const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;
const BIG_FONT_CSS = `html { font-size: 150% !important; }`;

type ContextOptions = {
  viewport: Viewport;
  theme?: Theme;
  language?: Language;
  wide?: boolean;
  bigFont?: boolean;
  reducedMotion?: boolean;
  /** Nombres de APIs de `window` que se borran ANTES de cargar la pagina (navegador sin esa capacidad). */
  remove?: string[];
  /** Se ejecuta antes de la pagina (por ejemplo para simular `navigator.share`). */
  init?: string;
};

async function newContext(browser: Browser, options: ContextOptions): Promise<BrowserContext> {
  const { viewport, theme = "light", language = "es", wide = false, bigFont = false, reducedMotion = false, remove = [], init = "" } = options;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    hasTouch: viewport.touch,
    isMobile: viewport.touch && viewport.width < 900,
    deviceScaleFactor: viewport.touch ? 2 : 1,
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([themeValue, languageValue, css, names, extra]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", themeValue as string);
        window.localStorage.setItem("optimuspdf.language", languageValue as string);
      } catch {
        /* almacenamiento bloqueado */
      }
      if (css) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css as string);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      for (const name of names as string[]) {
        try {
          delete (window as unknown as Record<string, unknown>)[name];
        } catch {
          /* no configurable */
        }
      }
      if (extra) new Function(extra as string)();
    },
    [theme, language, [wide ? WIDE_CSS : "", bigFont ? BIG_FONT_CSS : ""].join("\n").trim(), remove, init] as const,
  );
  return context;
}

/* ------------------------------------------------------------------ *
 * Medicion dentro de la pagina
 * ------------------------------------------------------------------ */

/**
 * Hallazgos de layout de la pagina actual. `content` mide solo `main` y el pie (la cabecera y la barra de pestañas son de otra
 * unidad); `page` mide todo. Ignora lo que ya se sabe que NO es un defecto: el enlace «Saltar al contenido», las entradas de
 * archivo visualmente ocultas, los carruseles horizontales a proposito y el indicador del servidor de desarrollo.
 */
const AUDIT = `((scopeName) => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const out = [];
  if (scopeName === "page" && doc.scrollWidth > vw + 1) out.push("h-scroll: scrollWidth " + doc.scrollWidth + " > " + vw);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const roots = scopeName === "page" ? [document.body] : [...document.querySelectorAll("main, footer")];
  const ignored = (el) => !!el.closest("[data-skip-link], .sr-only, [aria-hidden='true'], [hidden], [inert], nextjs-portal");
  const scroller = (el) => !!el.closest(".overflow-x-auto, .overflow-x-scroll, [class*='overflow-x-']");
  const label = (el) => (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || el.tagName).trim().replace(/\\s+/g, " ").slice(0, 40);
  const seen = new Set();
  const sel = "a[href], button, input, select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [tabindex]:not([tabindex='-1'])";
  for (const root of roots) {
    for (const el of root.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width <= 2 || r.height <= 2 || cs.visibility === "hidden" || cs.display === "none" || ignored(el)) continue;
      if (el.tagName === "INPUT" && el.type === "file") continue;
      const wrap = el.tagName === "INPUT" ? (el.closest("label") ?? el.labels?.[0] ?? null) : null;
      if (wrap && wrap.getBoundingClientRect().height >= 43.5 && wrap.getBoundingClientRect().width >= 43.5) continue;
      if (!scroller(el) && (r.right > vw + 1 || r.left < -1)) {
        const key = "off:" + label(el);
        if (!seen.has(key)) { seen.add(key); out.push("fuera de pantalla: " + label(el) + " [" + Math.round(r.left) + ".." + Math.round(r.right) + "] ancho " + vw); }
      }
      if (coarse && (r.height < 43.5 || r.width < 43.5)) {
        if (el.tagName === "A" && cs.display === "inline") continue; // enlace dentro de un parrafo (WCAG 2.5.8)
        const key = "tap:" + label(el) + Math.round(r.width) + "x" + Math.round(r.height);
        if (!seen.has(key)) { seen.add(key); out.push("objetivo < 44 px: " + label(el) + " " + Math.round(r.width) + "x" + Math.round(r.height)); }
      }
    }
    for (const el of root.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || ignored(el)) continue;
      if ((cs.overflowX === "hidden" || cs.overflow === "hidden") && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.getBoundingClientRect().width > 4 && (el.textContent || "").trim().length > 2) {
        out.push("texto cortado: " + el.tagName.toLowerCase() + " «" + (el.textContent || "").trim().slice(0, 40) + "» " + el.scrollWidth + ">" + el.clientWidth);
      }
    }
    for (const el of root.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || scroller(el) || getComputedStyle(el).position === "fixed" || el.closest("svg, canvas, pre, code, table, [data-allow-overflow], [inert], nextjs-portal")) continue;
      if (r.right > vw + 1 && !out.some((line) => line.startsWith("desborde:"))) out.push("desborde: " + el.tagName.toLowerCase() + "." + String(el.className).slice(0, 50) + " llega a " + Math.round(r.right) + " de " + vw);
    }
  }
  return out;
})`;

/**
 * Espera a que terminen las entradas animadas (fundidos y escalas de motion: un boton a media escala mide 43 px y un texto a medio
 * fundido da un contraste falso). Las de CSS se esperan por su promesa; las de motion, por tiempo.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  await page.waitForTimeout(650);
}

async function audit(page: Page, scope: "page" | "content" = "page", settled = false): Promise<string[]> {
  if (settled) await settle(page);
  return page.evaluate(`${AUDIT}(${JSON.stringify(scope)})`) as Promise<string[]>;
}

const AXE_RULES = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } };

/** Violaciones de axe de la pagina (WCAG 2.x A/AA), sin las reglas que no miden esta unidad (landmarks de pagina). */
async function axeViolations(page: Page): Promise<string[]> {
  await settle(page);
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as {
      axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> };
    }).axe;
    const result = await axe.run({ exclude: [["nextjs-portal"]] }, rules);
    return result.violations
      .filter((violation) => !["region", "landmark-one-main", "page-has-heading-one"].includes(violation.id))
      .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 4).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`);
  }, AXE_RULES);
}

async function goto(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "networkidle" });
  await page.locator("main#content").waitFor();
}

/* ------------------------------------------------------------------ *
 * Archivos sinteticos
 * ------------------------------------------------------------------ */

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** PNG RGB con un degradado, escrito a mano (sin dependencias). */
function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = 128;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

const PNG = makePng(640, 480);
const HTML_FILE = Buffer.from(`<!doctype html><html><head><title>Prueba</title></head><body><h1>Titulo de prueba</h1><p>${"Texto sintetico de ejemplo. ".repeat(40)}</p></body></html>`);

let webmCache: Buffer | null = null;
/** Un WebM de ~1 s generado DENTRO de la pagina con el grabador del propio navegador (ningun video en el repositorio). */
async function makeWebm(page: Page): Promise<Buffer> {
  if (webmCache) return webmCache;
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext("2d")!;
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.start();
    for (let i = 0; i < 20; i += 1) {
      context.fillStyle = `hsl(${i * 18},80%,50%)`;
      context.fillRect(0, 0, 320, 240);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  });
  webmCache = Buffer.from(base64, "base64");
  return webmCache;
}

const upload = (page: Page, file: { name: string; mimeType: string; buffer: Buffer } | string | Array<{ name: string; mimeType: string; buffer: Buffer }>) =>
  page.locator("input[type=file]").first().setInputFiles(file);

/** `POST /api/html-snapshot` interceptado: nunca hay red. `fail` = error del servidor; si no, una pagina sintetica. */
async function mockSnapshot(page: Page): Promise<void> {
  await page.route("**/api/html-snapshot", (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { url?: string };
    if (String(body.url).includes("falla")) {
      return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "unreachable" }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        html: HTML_FILE.toString(),
        finalUrl: "https://ejemplo.com/un/articulo/con/una/direccion/muy/larga/que/no/cabe-en-una-linea-de-movil?x=1",
        title: "Un artículo de prueba con un título algo largo para ver cómo envuelve",
        notes: [
          { code: "scripts-ignored", count: 2 },
          { code: "fonts-omitted", count: 1 },
        ],
      }),
    });
  });
}

/* ------------------------------------------------------------------ *
 * 1. Matriz de rutas x viewports
 * ------------------------------------------------------------------ */
for (const viewport of VIEWPORTS) {
  test(`matriz · ${viewport.name} · claro · ES: ${ROUTES.length} rutas sin desborde, sin texto cortado y con objetivos de 44 px`, async ({ browser }) => {
    const context = await newContext(browser, { viewport });
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      for (const route of ROUTES) {
        await goto(page, route);
        for (const finding of await audit(page)) failures.push(`${route} · ${finding}`);
      }
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

for (const viewport of [SE, PHONE, IPAD_V, IPAD_H]) {
  test(`matriz · ${viewport.name} · oscuro · EN`, async ({ browser }) => {
    const context = await newContext(browser, { viewport, theme: "dark", language: "en" });
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      for (const route of ROUTES) {
        await goto(page, route);
        for (const finding of await audit(page)) failures.push(`${route} · ${finding}`);
      }
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

/* ------------------------------------------------------------------ *
 * 2. Tipografia grande
 * ------------------------------------------------------------------ */
for (const viewport of [SE, PHONE, IPAD_V]) {
  test(`tipografia ancha (DejaVu + 6 %) · ${viewport.name}: ninguna ruta desborda`, async ({ browser }) => {
    const context = await newContext(browser, { viewport, wide: true });
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      for (const route of ROUTES) {
        await goto(page, route);
        for (const finding of await audit(page)) failures.push(`${route} · ${finding}`);
      }
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

for (const viewport of [SE, PHONE, IPAD_V]) {
  test(`fuente del sistema al 150 % · ${viewport.name}: el contenido y el pie no desbordan ni cortan texto`, async ({ browser }) => {
    const context = await newContext(browser, { viewport, bigFont: true });
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      for (const route of ROUTES) {
        await goto(page, route);
        for (const finding of await audit(page, "content")) failures.push(`${route} · ${finding}`);
      }
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

test("fuente al 150 % + tipografia ancha a 768 px: el pie no desborda y sus enlaces no se parten en filas sueltas", async ({ browser }) => {
  const context = await newContext(browser, { viewport: { name: "tableta 768", width: 768, height: 1024, touch: true }, wide: true, bigFont: true });
  const page = await context.newPage();
  try {
    for (const route of ["/about", "/image-converter"]) {
      await goto(page, route);
      expect(await audit(page, "content"), route).toEqual([]);
      const footer = await page.evaluate(() => {
        const element = document.querySelector("footer")!;
        return { scroll: element.scrollWidth, client: element.clientWidth };
      });
      expect(footer.scroll, route).toBeLessThanOrEqual(footer.client + 1);
    }
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 3. Inicio: iconos del movil, chips, buscador
 * ------------------------------------------------------------------ */
for (const language of ["es", "en"] as const) {
  test(`Inicio · ${language}: las etiquetas de los iconos no se cortan (320 y 390 px) y las columnas se reparten por ancho`, async ({ browser }) => {
    for (const viewport of [SE, PHONE]) {
      const context = await newContext(browser, { viewport, language });
      const page = await context.newPage();
      try {
        await goto(page, "/");
        const tiles = await page.evaluate(() => {
          const labels = [...document.querySelectorAll<HTMLElement>("ul.sm\\:hidden li a > span:nth-of-type(2)")];
          const columns = new Set<number>();
          for (const label of labels) columns.add(Math.round(label.closest("li")!.getBoundingClientRect().left));
          return {
            count: labels.length,
            cut: labels
              .filter((label) => label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1)
              .map((label) => label.textContent),
            columns: columns.size,
            narrow: labels.filter((label) => label.getBoundingClientRect().right > document.documentElement.clientWidth).length,
          };
        });
        expect(tiles.count, viewport.name).toBeGreaterThan(30);
        expect(tiles.cut, viewport.name).toEqual([]);
        expect(tiles.narrow, viewport.name).toBe(0);
        // 3 columnas a 320 px, 4 desde 360 (como la pantalla de inicio de iOS).
        expect(tiles.columns, viewport.name).toBe(viewport.width < 360 ? 3 : 4);
      } finally {
        await context.close();
      }
    }
  });
}

test("Inicio · con la letra al 150 % las columnas bajan en vez de partir palabras", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE, bigFont: true });
  const page = await context.newPage();
  try {
    await goto(page, "/");
    const columns = await page.evaluate(() => {
      const lefts = new Set<number>();
      for (const item of document.querySelectorAll<HTMLElement>("ul.sm\\:hidden li")) lefts.add(Math.round(item.getBoundingClientRect().left));
      return lefts.size;
    });
    expect(columns).toBeLessThanOrEqual(3);
    expect(await audit(page, "content")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Inicio · los chips de categoria miden 44 px de alto con >= 8 px entre ellos", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE });
  const page = await context.newPage();
  try {
    await goto(page, "/");
    const chips = await page.evaluate(() => {
      const links = [...document.querySelectorAll<HTMLElement>("nav ul li a[data-category]")];
      const rects = links.map((link) => link.getBoundingClientRect());
      const gaps = rects.slice(1).map((rect, index) => Math.round((rect.left - rects[index].right) * 10) / 10);
      return { count: links.length, minHeight: Math.min(...rects.map((rect) => rect.height)), minGap: Math.min(...gaps) };
    });
    expect(chips.count).toBeGreaterThanOrEqual(9);
    expect(chips.minHeight).toBeGreaterThanOrEqual(43.5);
    expect(chips.minGap).toBeGreaterThanOrEqual(7.5);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 4. Precios: el desborde de 320 px
 * ------------------------------------------------------------------ */
for (const language of ["es", "en"] as const) {
  test(`Precios · ${language} · 320 px: las tarjetas caben (el boton largo parte en lineas) y nada sale de la pantalla`, async ({ browser }) => {
    const context = await newContext(browser, { viewport: SE, language, wide: true });
    const page = await context.newPage();
    try {
      await goto(page, "/pricing");
      expect(await audit(page)).toEqual([]);
      const cards = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main .material-regular")].map((card) => Math.round(card.getBoundingClientRect().right)));
      expect(Math.max(...cards)).toBeLessThanOrEqual(320);
    } finally {
      await context.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 5. Estados de las herramientas
 * ------------------------------------------------------------------ */
const STATE_VIEWPORTS = [SE, PHONE, IPAD_V, IPAD_H];

/**
 * En movil (< 768 px) las opciones viven en una hoja que abre el boton «Opciones» de la barra de accion: se espera a que exista
 * y se abre. En tableta y escritorio es un panel lateral (no hay boton) y no se hace nada. Devuelve si se abrio la hoja.
 */
async function openOptionsIfSheet(page: Page, opener: RegExp): Promise<boolean> {
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;
  if (!mobile) return false;
  await page.getByRole("button", { name: opener }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return true;
}

for (const viewport of STATE_VIEWPORTS) {
  test(`HTML a PDF · ${viewport.name}: direccion web (reposo, invalida, error, leida, opciones) y archivo HTML`, async ({ browser }) => {
    const context = await newContext(browser, { viewport });
    const page = await context.newPage();
    await mockSnapshot(page);
    const failures: string[] = [];
    const check = async (state: string) => {
      for (const finding of await audit(page, "page", true)) failures.push(`${state} · ${finding}`);
    };
    try {
      await goto(page, "/html-to-pdf");
      await check("reposo");
      await page.getByRole("textbox").first().fill("esto no es una direccion ::");
      await check("direccion invalida");
      await page.getByRole("textbox").first().fill("ejemplo.com/falla");
      await page.getByRole("button", { name: /^Consultar$/ }).click();
      await expect(page.locator("[data-error-banner]")).toBeVisible();
      await check("error del servidor");
      await page.getByRole("textbox").first().fill("ejemplo.com/ok");
      await page.getByRole("button", { name: /^Consultar$/ }).click();
      await expect(page.locator("[data-snapshot-summary]")).toBeVisible();
      await check("pagina leida");
      if (await openOptionsIfSheet(page, /^Opciones$/)) {
        await check("hoja de opciones");
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeHidden();
      }
      // Quitar la pagina y probar el modo archivo.
      await page.getByRole("button", { name: /^Quitar/ }).first().click();
      await page.getByRole("tab", { name: "Archivo HTML" }).click();
      await check("archivo HTML (reposo)");
      await upload(page, { name: "pagina-con-un-nombre-bastante-largo-para-ver-como-envuelve-en-el-movil.html", mimeType: "text/html", buffer: HTML_FILE });
      await expect(page.getByRole("button", { name: /^Procesar$/ }).last()).toBeVisible();
      await check("archivo HTML (cargado)");
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });

  test(`Convertidor de imagenes · ${viewport.name}: reposo, lote, opciones y resultado`, async ({ browser }) => {
    const context = await newContext(browser, { viewport });
    const page = await context.newPage();
    const failures: string[] = [];
    const check = async (state: string) => {
      for (const finding of await audit(page, "page", true)) failures.push(`${state} · ${finding}`);
    };
    try {
      await goto(page, "/image-converter");
      await check("reposo");
      await upload(page, [
        { name: "foto-1.png", mimeType: "image/png", buffer: PNG },
        { name: "una-foto-con-un-nombre-largo-que-no-cabe-en-una-sola-linea-del-movil-2.png", mimeType: "image/png", buffer: PNG },
      ]);
      await expect(page.getByRole("button", { name: /^Procesar$/ }).last()).toBeVisible();
      await check("lote cargado");
      if (await openOptionsIfSheet(page, /^Opciones$/)) {
        await check("hoja de opciones");
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeHidden();
      }
      await page.getByRole("button", { name: /^Procesar$/ }).last().click();
      await expect(page.getByRole("heading", { name: "Listo" })).toBeVisible({ timeout: 30_000 });
      await check("resultado");
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });

  test(`Convertidor de video · ${viewport.name}: reposo, con archivo, opciones, resultado y archivo malo`, async ({ browser }) => {
    const context = await newContext(browser, { viewport });
    const page = await context.newPage();
    const failures: string[] = [];
    const check = async (state: string) => {
      for (const finding of await audit(page, "page", true)) failures.push(`${state} · ${finding}`);
    };
    try {
      await goto(page, "/video-converter");
      await expect(page.getByRole("heading", { name: VIDEO_ES.idleTitle })).toBeVisible();
      await check("reposo");
      const webm = await makeWebm(page);
      await upload(page, { name: "clip.webm", mimeType: "video/webm", buffer: webm });
      await expect(page.locator("[data-video-estimate]")).toBeVisible({ timeout: 20_000 });
      await check("con archivo");
      if (await openOptionsIfSheet(page, /^Opciones$/)) {
        await check("hoja de opciones");
        await page.getByRole("tab", { name: "WebM" }).click();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeHidden();
      } else {
        await page.getByRole("tab", { name: "WebM" }).click();
      }
      await page.getByRole("button", { name: /^Convertir$/ }).last().click();
      await expect(page.getByRole("heading", { name: "Listo" })).toBeVisible({ timeout: 60_000 });
      await check("resultado");
      // Archivo malo.
      await goto(page, "/video-converter");
      await upload(page, { name: "no-es-un-video.mp4", mimeType: "video/mp4", buffer: Buffer.from("esto no es un video") });
      await expect(page.locator("[data-error-banner]")).toBeVisible({ timeout: 20_000 });
      await check("archivo malo");
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

for (const [mode, viewport] of [
  ["150", SE],
  ["150", PHONE],
  ["150", IPAD_V],
  ["ancha", SE],
  ["ancha", PHONE],
] as const) {
  test(`${mode === "150" ? "letra al 150 %" : "tipografia ancha (DejaVu + 6 %)"} · ${viewport.name}: errores, archivo cargado y resultado de las tres herramientas no desbordan`, async ({ browser }) => {
    // Con la letra al 150 % Y la tipografia ancha a 320 px la cabecera y la barra de pestañas (de otra unidad) ensanchan la
    // pagina por si solas (372 px) y arrastran a las barras fijas: ese cruce no mide esta unidad.
    const context = await newContext(browser, { viewport, bigFont: mode === "150", wide: mode === "ancha" });
    const page = await context.newPage();
    await mockSnapshot(page);
    const failures: string[] = [];
    const check = async (state: string) => {
      for (const finding of await audit(page, "content", true)) failures.push(`${state} · ${finding}`);
    };
    try {
      await goto(page, "/html-to-pdf");
      await page.getByRole("textbox").first().fill("ejemplo.com/falla");
      await page.getByRole("button", { name: /^Consultar$/ }).click();
      await expect(page.locator("[data-error-banner]")).toBeVisible();
      await check("html · error");
      await page.getByRole("textbox").first().fill("ejemplo.com/ok");
      await page.getByRole("button", { name: /^Consultar$/ }).click();
      await expect(page.locator("[data-snapshot-summary]")).toBeVisible();
      await check("html · pagina leida");

      await goto(page, "/image-converter");
      await check("imagenes · reposo");
      await upload(page, { name: "foto-con-un-nombre-largo.png", mimeType: "image/png", buffer: PNG });
      await expect(page.getByRole("button", { name: /^Procesar$/ }).last()).toBeVisible();
      await check("imagenes · cargada");
      await page.getByRole("button", { name: /^Procesar$/ }).last().click();
      await expect(page.getByRole("heading", { name: "Listo" })).toBeVisible({ timeout: 30_000 });
      await check("imagenes · resultado");

      await goto(page, "/video-converter");
      await check("video · reposo");
      await upload(page, { name: "clip.webm", mimeType: "video/webm", buffer: await makeWebm(page) });
      await expect(page.locator("[data-video-estimate]")).toBeVisible({ timeout: 20_000 });
      await check("video · cargado");
      await goto(page, "/video-converter");
      await upload(page, { name: "no-es-un-video.mp4", mimeType: "video/mp4", buffer: Buffer.from("esto no es un video") });
      await expect(page.locator("[data-error-banner]")).toBeVisible({ timeout: 20_000 });
      await check("video · archivo malo");
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

for (const viewport of [SE, PHONE, IPAD_V]) {
  test(`Ajustes · ${viewport.name}: las hojas de exportar e importar caben, no desbordan y su foco no escapa`, async ({ browser }) => {
    const context = await newContext(browser, { viewport });
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      await goto(page, "/settings");
      for (const opener of ["[data-backup-export-open]", "[data-backup-import-open]"]) {
        await page.locator(opener).scrollIntoViewIfNeeded();
        await page.locator(opener).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        for (const finding of await audit(page, "page", true)) failures.push(`${opener} · ${finding}`);
        for (const violation of await axeViolations(page)) failures.push(`${opener} · axe ${violation}`);
        // El alto de la hoja nunca pasa del 88 % de la ventana visible y Tab no saca el foco de ella.
        const height = await dialog.evaluate((element) => element.getBoundingClientRect().height / window.innerHeight);
        if (viewport.width < 768) expect(height).toBeLessThanOrEqual(0.89);
        for (let i = 0; i < 12; i += 1) {
          await page.keyboard.press("Tab");
          expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `${opener} Tab ${i + 1}`).toBe(true);
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }
    } finally {
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

/* ------------------------------------------------------------------ *
 * 6. Axe en las pantallas tocadas (claro/oscuro, ES/EN)
 * ------------------------------------------------------------------ */
for (const theme of ["light", "dark"] as const) {
  for (const language of ["es", "en"] as const) {
    test(`axe (WCAG 2 A/AA, ${theme}, ${language}) · rutas de la unidad, pie incluido`, async ({ browser }) => {
      const context = await newContext(browser, { viewport: PHONE, theme, language });
      const page = await context.newPage();
      const failures: string[] = [];
      try {
        for (const route of ROUTES) {
          await goto(page, route);
          for (const violation of await axeViolations(page)) failures.push(`${route} · ${violation}`);
        }
      } finally {
        await context.close();
      }
      expect(failures).toEqual([]);
    });
  }
}

test("axe · estados con archivo de las tres herramientas (claro y oscuro)", async ({ browser }) => {
  const failures: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    const context = await newContext(browser, { viewport: IPAD_V, theme });
    const page = await context.newPage();
    await mockSnapshot(page);
    try {
      await goto(page, "/html-to-pdf");
      await page.getByRole("textbox").first().fill("ejemplo.com/falla");
      await page.getByRole("button", { name: /^Consultar$/ }).click();
      await expect(page.locator("[data-error-banner]")).toBeVisible();
      for (const violation of await axeViolations(page)) failures.push(`${theme} html error · ${violation}`);
      await page.getByRole("textbox").first().fill("ejemplo.com/ok");
      await page.getByRole("button", { name: /^Consultar$/ }).click();
      await expect(page.locator("[data-snapshot-summary]")).toBeVisible();
      for (const violation of await axeViolations(page)) failures.push(`${theme} html leida · ${violation}`);

      await goto(page, "/image-converter");
      await upload(page, { name: "foto.png", mimeType: "image/png", buffer: PNG });
      await expect(page.getByRole("button", { name: /^Procesar$/ }).last()).toBeVisible();
      for (const violation of await axeViolations(page)) failures.push(`${theme} imagenes cargada · ${violation}`);
      await page.getByRole("button", { name: /^Procesar$/ }).last().click();
      await expect(page.getByRole("heading", { name: "Listo" })).toBeVisible({ timeout: 30_000 });
      for (const violation of await axeViolations(page)) failures.push(`${theme} imagenes resultado · ${violation}`);

      await goto(page, "/video-converter");
      await upload(page, { name: "clip.webm", mimeType: "video/webm", buffer: await makeWebm(page) });
      await expect(page.locator("[data-video-estimate]")).toBeVisible({ timeout: 20_000 });
      for (const violation of await axeViolations(page)) failures.push(`${theme} video cargado · ${violation}`);
    } finally {
      await context.close();
    }
  }
  expect(failures).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 7. Patrones compartidos medidos en rutas de otras duenas
 * ------------------------------------------------------------------ */
for (const viewport of [PHONE, IPAD_V]) {
  test(`patron · ${viewport.name}: muestras de color de 44 x 44 con >= 8 px entre ellas (marca de agua y numerar)`, async ({ browser }) => {
    const context = await newContext(browser, { viewport });
    const page = await context.newPage();
    try {
      for (const route of ["/add-watermark", "/add-page-numbers"]) {
        await goto(page, route);
        await upload(page, FIXTURE_PDF);
        await expect(page.getByRole("button", { name: /^Procesar$/ }).last()).toBeVisible({ timeout: 20_000 });
        // En movil las opciones viven en una hoja.
        await openOptionsIfSheet(page, /^Opciones$/);
        const group = page.getByRole("radiogroup", { name: /Color/i }).first();
        await expect(group).toBeVisible();
        const swatches = await group.evaluate((element) =>
          [...element.querySelectorAll<HTMLElement>("[role=radio]")].map((radio) => {
            const rect = radio.getBoundingClientRect();
            return { w: Math.round(rect.width), h: Math.round(rect.height), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }),
        );
        expect(swatches.length, route).toBeGreaterThanOrEqual(6);
        for (const swatch of swatches) {
          expect(swatch.w, route).toBeGreaterThanOrEqual(44);
          expect(swatch.h, route).toBeGreaterThanOrEqual(44);
        }
        // Vecinas de la misma fila: el hueco entre cajas de 44 px es >= 8 px.
        for (let i = 1; i < swatches.length; i += 1) {
          const sameRow = Math.abs(swatches[i].top - swatches[i - 1].top) < 4;
          if (sameRow) expect(swatches[i].left - swatches[i - 1].right, route).toBeGreaterThanOrEqual(7.5);
        }
        expect(await audit(page), route).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });
}

for (const viewport of [PHONE, IPAD_V]) {
  test(`patron · ${viewport.name}: el segmentado pequeño de Tachar mide 44 px de alto con tacto`, async ({ browser }) => {
    const context = await newContext(browser, { viewport });
    const page = await context.newPage();
    try {
      await goto(page, "/redact-pdf");
      await upload(page, FIXTURE_PDF);
      const lists = page.getByRole("tablist");
      await expect(lists.first()).toBeVisible({ timeout: 20_000 });
      const heights = await lists.evaluateAll((nodes) =>
        nodes.filter((node) => node.getBoundingClientRect().height > 2).map((node) => ({ label: node.getAttribute("aria-label"), h: Math.round(node.getBoundingClientRect().height), tabs: [...node.querySelectorAll("[role=tab]")].map((tab) => Math.round(tab.getBoundingClientRect().height)) })),
      );
      expect(heights.length).toBeGreaterThanOrEqual(1);
      for (const list of heights) {
        expect(list.h, String(list.label)).toBeGreaterThanOrEqual(43.5);
        for (const tab of list.tabs) expect(tab, String(list.label)).toBeGreaterThanOrEqual(43.5);
      }
    } finally {
      await context.close();
    }
  });
}

test("patron · Ajustes: cada casilla tiene una etiqueta de >= 44 px de alto y alternarla funciona al tocar el texto", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE });
  const page = await context.newPage();
  try {
    await goto(page, "/settings");
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>("main input[type=checkbox]")].map((input) => {
        const label = input.closest("label") ?? input.labels?.[0] ?? null;
        const rect = label?.getBoundingClientRect();
        return { wrapped: !!label, h: rect ? Math.round(rect.height) : 0, w: rect ? Math.round(rect.width) : 0 };
      }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    for (const box of boxes) {
      expect(box.wrapped).toBe(true);
      expect(box.h).toBeGreaterThanOrEqual(43.5);
      expect(box.w).toBeGreaterThanOrEqual(200);
    }
    const input = page.locator("main input[type=checkbox]").first();
    const first = page.locator(`main label[for="${await input.getAttribute("id")}"]`).first();
    const before = await input.isChecked();
    // Tocar el texto (no la caja) alterna la casilla.
    await first.scrollIntoViewIfNeeded();
    const box = (await first.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width - 12, box.y + box.height / 2);
    await expect.poll(() => input.isChecked()).toBe(!before);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 8. Zona de carga: el tope que dice es el real; pantalla de descarga: su frase
 * ------------------------------------------------------------------ */
test("zona de carga · imagenes dice 64 MB (32 MB en iPhone/iPad), video dice 4 GB y los PDF siguen en 100 MB", async ({ browser }) => {
  const context = await newContext(browser, { viewport: { name: "escritorio", width: 1280, height: 800, touch: false } });
  const page = await context.newPage();
  try {
    await goto(page, "/image-converter");
    await expect(page.getByText(/hasta\s64\sMB/)).toBeVisible();
    await expect(page.getByText(/100\sMB/)).toHaveCount(0);
    await goto(page, "/video-converter");
    await expect(page.getByText(/hasta\s4\sGB/).first()).toBeVisible();
    await expect(page.getByText(/4,0/)).toHaveCount(0);
    await goto(page, "/merge-pdf");
    await expect(page.getByText(/hasta\s100\sMB/)).toBeVisible();
  } finally {
    await context.close();
  }
  // iPhone: el tope de imagenes baja a 32 MB.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    hasTouch: true,
    isMobile: true,
  });
  await phone.addInitScript(() => window.localStorage.setItem("optimuspdf.language", "es"));
  const phonePage = await phone.newPage();
  try {
    await goto(phonePage, "/image-converter");
    await expect(phonePage.getByText(/hasta\s32\sMB/)).toBeVisible();
  } finally {
    await phone.close();
  }
});

for (const language of ["es", "en"] as const) {
  test(`pantalla de descarga · ${language}: la imagen y el video no se llaman «documento»`, async ({ browser }) => {
    const context = await newContext(browser, { viewport: { name: "escritorio", width: 1280, height: 800, touch: false }, language });
    const page = await context.newPage();
    try {
      await goto(page, "/image-converter");
      await upload(page, { name: "foto.png", mimeType: "image/png", buffer: PNG });
      await page.getByRole("button", { name: /^(Procesar|Process)$/ }).last().click();
      await expect(page.locator("#download-title")).toBeVisible({ timeout: 30_000 });
      const section = page.locator("section[aria-labelledby='download-title']");
      await expect(section).toContainText(language === "es" ? "Tu archivo está preparado para descargar." : "Your file is ready to download.");
      await expect(section).not.toContainText(/documento|document\b/i);

      await goto(page, "/video-converter");
      await upload(page, { name: "clip.webm", mimeType: "video/webm", buffer: await makeWebm(page) });
      await expect(page.locator("[data-video-estimate]")).toBeVisible({ timeout: 20_000 });
      await page.getByRole("tab", { name: "WebM" }).click();
      await page.getByRole("button", { name: /^(Convertir|Convert)$/ }).last().click();
      await expect(page.locator("#download-title")).toBeVisible({ timeout: 60_000 });
      await expect(section).toContainText(language === "es" ? "Tu video está preparado para descargar." : "Your video is ready to download.");
    } finally {
      await context.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 9. Hoja de compartir como plan B de la descarga
 * ------------------------------------------------------------------ */
const FAKE_SHARE = (mode: "ok" | "abort" | "fail") => `
  window.__shared = [];
  Object.defineProperty(navigator, "canShare", { configurable: true, value: (data) => !!data && Array.isArray(data.files) && data.files.length > 0 });
  Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => {
    window.__shared.push((data.files || []).map((file) => file.name + "|" + file.type + "|" + file.size));
    ${mode === "abort" ? 'throw new DOMException("cancelado", "AbortError");' : mode === "fail" ? 'throw new DOMException("no", "NotAllowedError");' : ""}
  } });
`;

test("plan B movil: con hoja de compartir aparece «Compartir o guardar…», comparte el archivo y cancelar no descarga", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE, init: FAKE_SHARE("abort") });
  const page = await context.newPage();
  try {
    await goto(page, "/image-converter");
    await upload(page, { name: "foto.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: /^Procesar$/ }).last().click();
    const share = page.locator("[data-download-share]");
    await expect(share).toBeVisible({ timeout: 30_000 });
    expect((await share.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    let downloads = 0;
    page.on("download", () => (downloads += 1));
    await share.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: string[][] }).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as { __shared: string[][] }).__shared[0]);
    expect(shared[0]).toMatch(/^foto-convertida\.jpg\|image\/jpeg\|\d+$/);
    // Cerrar la hoja sin elegir destino NO descarga nada por detras.
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
  } finally {
    await context.close();
  }
});

test("plan B movil: si el sistema rechaza compartir, el archivo se descarga y se explica", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE, init: FAKE_SHARE("fail") });
  const page = await context.newPage();
  try {
    await goto(page, "/image-converter");
    await upload(page, { name: "foto.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: /^Procesar$/ }).last().click();
    const share = page.locator("[data-download-share]");
    await expect(share).toBeVisible({ timeout: 30_000 });
    const { filename } = await downloadFile(page, () => share.click());
    expect(filename).toBe("foto-convertida.jpg");
    await expect(page.getByRole("status").filter({ hasText: /No se pudo abrir la hoja de compartir/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("plan B movil: con raton, o sin hoja de compartir, la pantalla es la de siempre (sin boton extra)", async ({ browser }) => {
  const mouse = await newContext(browser, { viewport: { name: "escritorio", width: 1280, height: 800, touch: false }, init: FAKE_SHARE("ok") });
  const mousePage = await mouse.newPage();
  const touch = await newContext(browser, { viewport: PHONE });
  const touchPage = await touch.newPage();
  try {
    for (const page of [mousePage, touchPage]) {
      await goto(page, "/image-converter");
      await upload(page, { name: "foto.png", mimeType: "image/png", buffer: PNG });
      await page.getByRole("button", { name: /^Procesar$/ }).last().click();
      await expect(page.locator("#download-title")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-download-share]")).toHaveCount(0);
    }
  } finally {
    await mouse.close();
    await touch.close();
  }
});

/* ------------------------------------------------------------------ *
 * 10. Capacidades ausentes
 * ------------------------------------------------------------------ */
test("video sin VideoEncoder: pagina informativa honesta, sin zona de carga, con salidas (ES, EN, claro y oscuro, 320 y 834)", async ({ browser }) => {
  for (const [viewport, theme, language] of [
    [SE, "light", "es"],
    [IPAD_V, "dark", "en"],
  ] as const) {
    const context = await newContext(browser, { viewport, theme, language, remove: ["VideoEncoder"] });
    const page = await context.newPage();
    try {
      await goto(page, "/video-converter");
      const view = page.locator("[data-video-unsupported]");
      await expect(view).toHaveAttribute("data-video-unsupported", "no-video-encoder");
      await expect(view.getByRole("heading", { name: VIDEO_STRINGS[language].unsupportedTitle })).toBeVisible();
      await expect(view).toContainText(VIDEO_STRINGS[language].unsupported["no-video-encoder"]);
      await expect(page.locator("input[type=file]")).toHaveCount(0);
      await expect(view.getByRole("link").first()).toBeVisible();
      expect(await audit(page)).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test("video sin VideoDecoder: pagina informativa con su motivo; sin AudioEncoder: la herramienta sigue funcionando", async ({ browser }) => {
  const noDecoder = await newContext(browser, { viewport: PHONE, remove: ["VideoDecoder"] });
  const decoderPage = await noDecoder.newPage();
  const noAudio = await newContext(browser, { viewport: PHONE, remove: ["AudioEncoder"] });
  const audioPage = await noAudio.newPage();
  try {
    await goto(decoderPage, "/video-converter");
    await expect(decoderPage.locator("[data-video-unsupported]")).toHaveAttribute("data-video-unsupported", "no-video-decoder");
    await expect(decoderPage.locator("[data-video-unsupported]")).toContainText(VIDEO_ES.unsupported["no-video-decoder"]);

    await goto(audioPage, "/video-converter");
    await expect(audioPage.getByRole("heading", { name: VIDEO_ES.idleTitle })).toBeVisible();
    await expect(audioPage.locator("[data-video-unsupported]")).toHaveCount(0);
    await upload(audioPage, { name: "clip.webm", mimeType: "video/webm", buffer: await makeWebm(audioPage) });
    await expect(audioPage.locator("[data-video-estimate]")).toBeVisible({ timeout: 20_000 });
    expect(await audit(audioPage)).toEqual([]);
  } finally {
    await noDecoder.close();
    await noAudio.close();
  }
});

test("HTML a PDF sin VideoEncoder/VideoDecoder/AudioEncoder: no depende de WebCodecs y convierte un archivo HTML en un PDF", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE, remove: ["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder"] });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  try {
    await goto(page, "/html-to-pdf");
    await expect(page.getByRole("heading", { name: "HTML a PDF", level: 1 })).toBeVisible();
    await page.getByRole("tab", { name: "Archivo HTML" }).click();
    await upload(page, { name: "pagina.html", mimeType: "text/html", buffer: HTML_FILE });
    await page.getByRole("button", { name: /^Procesar$/ }).last().click();
    await expect(page.getByRole("heading", { name: "Listo" })).toBeVisible({ timeout: 60_000 });
    const { bytes, filename } = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar$/ }).click());
    expect(filename).toMatch(/\.pdf$/);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(problems).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Convertidor de imagenes sin createImageBitmap ni OffscreenCanvas: usa la ruta de respaldo y convierte", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE, remove: ["createImageBitmap", "OffscreenCanvas"] });
  const page = await context.newPage();
  try {
    await goto(page, "/image-converter");
    await upload(page, { name: "foto.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: /^Procesar$/ }).last().click();
    await expect(page.getByRole("heading", { name: "Listo" })).toBeVisible({ timeout: 30_000 });
    const { bytes, filename } = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar$/ }).click());
    expect(filename).toBe("foto-convertida.jpg");
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 11. Hoja: alto en dvh y foco atrapado en los controles TABULABLES
 * ------------------------------------------------------------------ */
test("hoja de opciones: alto maximo en dvh y Tab no escapa desde el ultimo control tabulable (el segmentado de Margen)", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE });
  const page = await context.newPage();
  await mockSnapshot(page);
  try {
    await goto(page, "/html-to-pdf");
    await page.getByRole("textbox").first().fill("ejemplo.com/ok");
    await page.getByRole("button", { name: /^Consultar$/ }).click();
    await expect(page.locator("[data-snapshot-summary]")).toBeVisible();
    await page.getByRole("button", { name: /^Opciones$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const sheet = await dialog.evaluate((element) => ({ height: element.getBoundingClientRect().height, viewport: window.innerHeight, maxHeight: getComputedStyle(element).maxHeight }));
    expect(sheet.height).toBeLessThanOrEqual(sheet.viewport * 0.88 + 1);
    expect(sheet.maxHeight).not.toBe("none");
    // El foco empieza dentro; recorrer con Tab muchas veces nunca lo saca de la hoja.
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Mayus+Tab ${i + 1}`).toBe(true);
    }
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 12. prefers-reduced-motion y separacion de controles
 * ------------------------------------------------------------------ */
test("prefers-reduced-motion: los botones y el segmentado no animan desplazamientos ni escalas", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE, reducedMotion: true });
  const page = await context.newPage();
  try {
    await goto(page, "/html-to-pdf");
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll("main button")].slice(0, 6).map((button) => ({ duration: getComputedStyle(button).transitionDuration, property: getComputedStyle(button).transitionProperty })),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const entry of durations) {
      // Bajo reduced motion solo se transicionan propiedades de fundido/color, y en menos de 0,2 s.
      for (const value of entry.duration.split(",")) expect(parseFloat(value)).toBeLessThanOrEqual(0.2);
      expect(entry.property).not.toMatch(/\b(transform|scale|translate|height|width)\b/);
    }
  } finally {
    await context.close();
  }
});

test("separacion de controles contiguos (>= 8 px) en el pie y en las acciones de un aviso de error", async ({ browser }) => {
  const context = await newContext(browser, { viewport: PHONE });
  const page = await context.newPage();
  await mockSnapshot(page);
  try {
    await goto(page, "/about");
    const footer = await minGapBetweenControls(page, "footer nav");
    expect(footer === null || footer.gap >= 7.5, JSON.stringify(footer)).toBe(true);
    await goto(page, "/html-to-pdf");
    await page.getByRole("textbox").first().fill("ejemplo.com/falla");
    await page.getByRole("button", { name: /^Consultar$/ }).click();
    await expect(page.locator("[data-error-banner]")).toBeVisible();
    const banner = await minGapBetweenControls(page, "[data-error-banner]");
    expect(banner === null || banner.gap >= 7.5, JSON.stringify(banner)).toBe(true);
  } finally {
    await context.close();
  }
});
