import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { STRINGS } from "../../src/app/scan-to-pdf/strings";
import { expect, importPhotos, WEBKIT_LINUX_CAMERA_REASON, webkitLinuxCamera, installFakeCamera, installScanFakes, waitIdle, waitVideoReady, widthCodedFiles } from "../helpers/scan-ui";

/**
 * Escaner · accesibilidad y tamano de objetivos: axe (WCAG 2.0/2.1/2.2 A y AA, incluida `target-size`) con 0 violaciones en
 * TODAS las pantallas (inicio, retomar, camara, revisar, mas acciones, editor, hoja completa, esquinas, guardar, resultado,
 * salir) x claro/oscuro x ES/EN x 320/375/393/744/834/1194; con una tipografia ANCHA (la DejaVu del CI de Linux) sin desborde
 * horizontal; objetivos >= 44 px con el dedo y >= 24 px siempre; una sola region viva; foco gestionado en cada hoja/paso.
 */
const AXE_PATH = require.resolve("axe-core/axe.min.js");
const WIDTHS = [320, 375, 393, 744, 834, 1194] as const;
type Theme = "light" | "dark";
type Language = "es" | "en";

const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

test.use({ locale: "es-ES", actionTimeout: 15_000 });
test.setTimeout(240_000);

async function newContext(browser: Browser, opts: { width: number; theme: Theme; language: Language; wide?: boolean; touch?: boolean }): Promise<BrowserContext> {
  const touch = opts.touch ?? true;
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.width >= 744 ? 1000 : 780 },
    colorScheme: opts.theme,
    hasTouch: touch,
    isMobile: touch && opts.width < 744,
    locale: opts.language === "es" ? "es-ES" : "en-US",
    deviceScaleFactor: 1,
  });
  await context.addInitScript(
    ([theme, language, css]) => {
      try {
        if (css) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }
        if (window.sessionStorage.getItem("__seeded")) return;
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
        window.sessionStorage.setItem("__seeded", "1");
      } catch {
        /* sin almacenamiento */
      }
    },
    [opts.theme, opts.language, opts.wide ? WIDE_CSS : ""],
  );
  return context;
}

type Violation = { id: string; impact: string | null; nodes: string[] };

async function axeScan(page: Page, context: string | null): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (scope) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[]; html: string }> }> }> } }).axe;
    const target = scope ? { include: [[scope]], exclude: [["nextjs-portal"]] } : { exclude: [["nextjs-portal"]] };
    const result = await axe.run(target, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${n.html.slice(0, 140)}`) }));
  }, context);
}

type Offender = { tag: string; cls: string; text: string; left: number; right: number };

/** Elementos que asoman por los lados de la pantalla sin quedar recortados por un ancestro con desplazamiento. */
async function overflow(page: Page): Promise<{ page: number; offenders: Offender[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    const clips = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const x = getComputedStyle(parent).overflowX;
        if (x === "auto" || x === "scroll" || x === "hidden" || x === "clip") return true;
      }
      return false;
    };
    const offenders: Array<{ tag: string; cls: string; text: string; left: number; right: number }> = [];
    for (const element of document.querySelectorAll("body *")) {
      // El resto de la pagina (cabecera, barra lateral, barra de pestanas, pie) es del sistema, no de esta herramienta.
      if (element.closest("nextjs-portal,[inert],[data-scan-live-host],[data-chrome],header,footer,aside,nav")) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.left < -1 || rect.right > width + 1) {
        const style = getComputedStyle(element);
        if (style.position === "fixed" && rect.left >= -1 && rect.right <= width + 1) continue;
        if (clips(element)) continue;
        if (element.closest("[data-scan-layer],[role=dialog]")) {
          const layer = element.closest("[data-scan-layer],[role=dialog]")!;
          const box = layer.getBoundingClientRect();
          if (rect.left >= box.left - 1 && rect.right <= box.right + 1) continue;
        }
        offenders.push({ tag: element.tagName.toLowerCase(), cls: String(element.getAttribute("class") ?? "").slice(0, 80), text: (element.textContent ?? "").trim().slice(0, 40), left: Math.round(rect.left), right: Math.round(rect.right) });
      }
    }
    return { page: Math.max(0, root.scrollWidth - width), offenders: offenders.slice(0, 6) };
  });
}

type Problems = string[];

async function check(page: Page, problems: Problems, label: string, scope: string | null) {
  // Las transiciones de color (tema, estado pulsado) dejan colores a medias: axe mediria un contraste que nadie ve.
  await page.waitForTimeout(450);
  const violations = await axeScan(page, scope);
  for (const v of violations) problems.push(`[axe] ${label}: ${v.id} (${v.impact}) ${v.nodes.join(" | ")}`);
  const over = await overflow(page);
  // El desplazamiento horizontal de la pagina solo cuenta si algun elemento de ESTA herramienta lo causa.
  if (over.page > 1 && over.offenders.length > 0) problems.push(`[desborde] ${label}: la pagina gana ${over.page} px de scroll horizontal`);
  for (const o of over.offenders) problems.push(`[desborde] ${label}: <${o.tag} class="${o.cls}"> «${o.text}» ${o.left}..${o.right}`);
}

/** La fuente forzada ES mas ancha que Arial (si no, la prueba no probaria nada en esta maquina). */
async function expectWideFontActive(page: Page): Promise<void> {
  const ratio = await page.evaluate(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    const probe = "Identificación y reverso en una sola hoja";
    context.font = "16px Arial";
    const narrow = context.measureText(probe).width;
    context.font = '16px "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif';
    return context.measureText(probe).width / narrow;
  });
  expect(ratio, "la fuente ancha forzada debe medir al menos un 8 % mas que Arial").toBeGreaterThan(1.08);
}

/** Recorre todas las pantallas de la herramienta en una celda de la matriz. */
async function tour(page: Page, language: Language, wide = false, camera = true): Promise<Problems> {
  const s = STRINGS[language];
  const problems: Problems = [];
  await installScanFakes(page);
  await installFakeCamera(page);
  await page.goto("/scan-to-pdf");
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page.locator("[data-start]")).toBeVisible();
  if (wide) await expectWideFontActive(page);
  await check(page, problems, "inicio", null);

  // Camara (WebKit en Linux no la entrega de forma fiable: ver `webkitLinuxCamera`)
  if (camera) {
    await page.locator('[data-camera-action="start"]').first().click();    await waitVideoReady(page);    await page.locator('[data-camera-action="auto"]').click();    await check(page, problems, "camara", "[data-camera-stage]");    await page.locator('[data-camera-action="capture"]').click();    await expect(page.locator("[data-camera-count]")).toContainText("1");    await check(page, problems, "camara con captura", "[data-camera-stage]");    await page.locator('[data-camera-action="close"]').click();    await expect(page.locator("[data-camera-stage]")).toHaveCount(0);
  }

  // Revisar con avisos de calidad
  const names = ["a.jpg", "b-blank.jpg", "c-blurry.jpg", "d-glare.jpg", "e-sideways.jpg", "f-dup.jpg", "g-nodoc.jpg"];
  await importPhotos(page, widthCodedFiles(names.length, { names }));
  await expect(page.locator("[data-review]")).toBeVisible();
  await waitIdle(page);
  await page.waitForTimeout(400);
  await check(page, problems, "revisar", null);

  // Mas acciones
  await page.locator('[data-tile-action="more"]').first().click();
  await expect(page.locator("[data-more-sheet]")).toBeVisible();
  await page.waitForTimeout(500);
  await check(page, problems, "mas acciones", "[data-more-sheet]");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-more-sheet]")).toHaveCount(0);

  // Seleccion
  await page.locator('[data-review-action="select"]').click();
  await page.locator("[data-page-grid] [data-page-main]").first().click();
  await check(page, problems, "seleccion", null);
  await page.locator('[data-review-action="select"]').click();

  // Editor (filtro y ajustes)
  await page.locator("[data-page-grid] [data-page-main]").first().click();
  await expect(page.locator("[data-page-editor]")).toBeVisible();
  await check(page, problems, "editor", "[data-page-editor]");
  await page.locator("[data-page-editor]").getByRole("tab").nth(1).click();
  await check(page, problems, "editor ajustes", "[data-page-editor]");

  // Esquinas
  await page.locator('[data-editor-action="crop"]').click();
  await expect(page.locator("[data-corner-editor]")).toBeVisible();
  await page.waitForTimeout(1500);
  await check(page, problems, "esquinas", "[data-corner-editor]");
  await page.locator("[data-corner-editor] [data-editor-action=close]").click();

  // Hoja completa
  await page.locator('[data-editor-action="sheet"]').click();
  await expect(page.locator("[data-sheet-viewer]")).toBeVisible();
  await check(page, problems, "hoja completa", "[data-sheet-viewer]");
  await page.locator('[data-sheet-action="close"]').click();
  await expect(page.locator("[data-sheet-viewer]")).toHaveCount(0);
  // La hoja se abrio ENCIMA del editor: cerrarla devuelve al editor (con el foco en el boton que la abrio).
  await expect(page.locator('[data-editor-action="sheet"]')).toBeFocused();
  await page.locator('[data-editor-action="done"]').click();
  await expect(page.locator("[data-page-editor]")).toHaveCount(0);

  // Guardar
  await page.locator('[data-review-action="save"]').click();
  await expect(page.locator("[data-save-screen]")).toBeVisible();
  await page.waitForTimeout(400);
  await check(page, problems, "guardar", null);
  await page.locator('[data-save-action="create"]').click();
  await expect(page.locator("[data-result]")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await check(page, problems, "resultado", null);

  // Retomar (volver a la herramienta con la sesion guardada)
  await page.goto("/scan-to-pdf");
  await expect(page.locator("[data-resume-banner]")).toBeVisible();
  await check(page, problems, "retomar", null);
  await page.locator('[data-resume-action="resume"]').click();
  await expect(page.locator("[data-review]")).toBeVisible();
  // Salir
  await page.goBack();
  await expect(page.getByRole("dialog", { name: s.leaveTitle })).toBeVisible();
  await page.waitForTimeout(600);
  await check(page, problems, "salir", "[role=dialog]");
  return problems;
}

for (const theme of ["light", "dark"] as const) {
  for (const language of ["es", "en"] as const) {
    for (const width of WIDTHS) {
      test(`axe 0 violaciones y sin desborde · ${theme} · ${language} · ${width}px`, async ({ browser, browserName }) => {
        const context = await newContext(browser, { width, theme, language });
        const page = await context.newPage();
        const problems = await tour(page, language, false, !webkitLinuxCamera(browserName));
        await context.close();
        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
  }
}

test.describe("con raton (sin tacto): los objetivos miden >= 24 px reales (axe target-size)", () => {
  for (const width of [375, 1194] as const) {
    test(`axe 0 violaciones y sin desborde · raton · ${width}px`, async ({ browser, browserName }) => {
      const context = await newContext(browser, { width, theme: "light", language: "es", touch: false });
      const page = await context.newPage();
      const problems = await tour(page, "es", false, !webkitLinuxCamera(browserName));
      await context.close();
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});

test.describe("tipografia ancha (DejaVu del CI de Linux)", () => {
  for (const width of [320, 375] as const) {
    for (const language of ["es", "en"] as const) {
      test(`sin desborde horizontal ni violaciones · ${language} · ${width}px`, async ({ browser, browserName }) => {
        const context = await newContext(browser, { width, theme: "dark", language, wide: true });
        const page = await context.newPage();
        const problems = await tour(page, language, true, !webkitLinuxCamera(browserName));
        await context.close();
        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
  }
});

test("objetivos tactiles: >= 44 px con el dedo en los controles de la camara, la cuadricula y las barras", async ({ browser, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  const context = await newContext(browser, { width: 375, theme: "light", language: "es" });
  const page = await context.newPage();
  await installScanFakes(page);
  await installFakeCamera(page);
  await page.goto("/scan-to-pdf");
  const small: string[] = [];
  const measure = async (label: string, selector: string, min = 43.5) => {
    const found = await page.locator(selector).evaluateAll((nodes) => nodes.filter((node) => !node.closest("[inert]")).map((node) => ({ label: node.getAttribute("aria-label") ?? (node.textContent ?? "").trim().slice(0, 30), box: node.getBoundingClientRect() })));
    for (const item of found) {
      if (item.box.width < 1 || item.box.height < 1) continue;
      if (item.box.height < min || item.box.width < min) small.push(`${label}: «${item.label}» ${Math.round(item.box.width)}x${Math.round(item.box.height)}`);
    }
  };
  await measure("inicio", "[data-start] button");
  await page.locator('[data-camera-action="start"]').first().click();
  await waitVideoReady(page);
  await measure("camara", "[data-camera-stage] button");
  await page.locator('[data-camera-action="close"]').click();
  await importPhotos(page, widthCodedFiles(4, { names: ["a.jpg", "b-blank.jpg", "c-blurry.jpg", "d.jpg"] }));
  await waitIdle(page);
  await measure("cuadricula", "[data-page-grid] button");
  await measure("barra", "[data-review-bar] button");
  await measure("cabecera", "[data-review] > div:first-child button");
  expect(small, small.join("\n")).toEqual([]);
  await context.close();
});

test("una sola region viva y el foco nunca cae en <body> al abrir y cerrar cada capa", async ({ browser, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  const context = await newContext(browser, { width: 393, theme: "light", language: "es" });
  const page = await context.newPage();
  await installScanFakes(page);
  await installFakeCamera(page);
  await page.goto("/scan-to-pdf");
  await page.locator('[data-camera-action="start"]').first().click();
  await waitVideoReady(page);
  await expect(page.locator("[data-camera-stage] [data-camera-action=capture]")).toBeFocused();
  await page.locator('[data-camera-action="auto"]').click();
  await page.locator('[data-camera-action="capture"]').click();
  await page.locator('[data-camera-action="done"]').click();
  await expect(page.locator("[data-review]")).toBeVisible();
  const notBody = () => page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null);
  await expect.poll(notBody).toBe(true);
  await waitIdle(page);
  await page.locator("[data-page-grid] [data-page-main]").first().click();
  await expect(page.locator('[data-editor-action="done"]')).toBeFocused();
  await page.locator('[data-editor-action="done"]').click();
  await expect.poll(notBody).toBe(true);
  expect(await page.locator("[role=status][aria-live]").count()).toBe(1);
  await context.close();
});
