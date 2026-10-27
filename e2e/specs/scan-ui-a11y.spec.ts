import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { STRINGS } from "../../src/app/scan-to-pdf/strings";
import { expect, importPhotos, scanFiles, WEBKIT_LINUX_CAMERA_REASON, webkitLinuxCamera, installFakeCamera, installScanFakes, waitIdle, waitVideoReady, widthCodedFiles } from "../helpers/scan-ui";

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

async function newContext(browser: Browser, opts: { width: number; height?: number; theme: Theme; language: Language; wide?: boolean; touch?: boolean; fontScale?: number }): Promise<BrowserContext> {
  const touch = opts.touch ?? true;
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height ?? (opts.width >= 744 ? 1000 : 780) },
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
    [opts.theme, opts.language, `${opts.wide ? WIDE_CSS : ""}${opts.fontScale ? `html { font-size: ${opts.fontScale}% !important; }` : ""}`],
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

/**
 * Nada de lo que se ve en la zona de contenido de Revisar queda TAPADO: la barra inferior no invade la zona, esta dentro de la
 * ventana, y el punto central de cada control visible es de ese control (no de la barra ni de otra capa).
 */
async function coverage(page: Page, problems: Problems, label: string) {
  const found = await page.evaluate(() => {
    const scroller = document.querySelector("[data-shell-scroll]");
    const bar = document.querySelector("[data-shell-bar]");
    if (!scroller) return [];
    const out: string[] = [];
    const area = scroller.getBoundingClientRect();
    const head = document.querySelector("[data-shell-top]");
    const stuck = head && getComputedStyle(head).position === "sticky" ? head.getBoundingClientRect().bottom : area.top;
    const flow = document.querySelector("[data-screen-shell]")?.getAttribute("data-shell-mode") === "flow";
    if (bar) {
      const box = bar.getBoundingClientRect();
      if (!flow && area.bottom > box.top + 1) out.push(`la barra (${Math.round(box.top)}) invade la zona de contenido (${Math.round(area.bottom)})`);
      if (box.bottom > window.innerHeight + 1 || box.top < 0) out.push(`la barra queda fuera de la ventana (${Math.round(box.top)}..${Math.round(box.bottom)} de ${window.innerHeight})`);
    }
    for (const element of scroller.querySelectorAll("button, a[href], input, [role=button]")) {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1 || element.closest("[inert]")) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (y < Math.max(area.top, stuck) + 1 || y > area.bottom - 1 || x < 0 || x > window.innerWidth) continue;
      const hit = document.elementFromPoint(x, y);
      // Una casilla va debajo de su rotulo (el rotulo ES el objetivo): no cuenta como tapada.
      if (element instanceof HTMLInputElement && hit && Array.from(element.labels ?? []).some((label) => label.contains(hit))) continue;
      if (hit && !element.contains(hit) && !hit.contains(element)) out.push(`${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 24)} tapado por <${hit.tagName.toLowerCase()} ${String(hit.getAttribute("data-shell-bar") ?? hit.getAttribute("class") ?? "").slice(0, 40)}>`);
    }
    return out.slice(0, 6);
  });
  for (const item of found) problems.push(`[tapado] ${label}: ${item}`);
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
async function tour(page: Page, language: Language, wide = false, camera = true, onlyReview = false): Promise<Problems> {
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
  const names = ["a.jpg", "b-blank.jpg", "c-blurry.jpg", "d-glare.jpg", "e-sideways.jpg", "f-dup.jpg", "g-nodoc.jpg", "h-sparse.jpg"];
  await importPhotos(page, scanFiles(names));
  await expect(page.locator("[data-review]")).toBeVisible();
  await waitIdle(page);
  await page.waitForTimeout(400);
  await check(page, problems, "revisar", null);
  await coverage(page, problems, "revisar");
  // Al final de la lista: la barra sigue pegada abajo y nada queda tapado ni solapado.
  await page.locator("[data-shell-scroll]").evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await page.waitForTimeout(300);
  await check(page, problems, "revisar (final de la lista)", null);
  await coverage(page, problems, "revisar (final de la lista)");
  // A medio desplazamiento: una hoja queda PARCIALMENTE bajo la cabecera pegajosa. Lo que se ve de cada control debe seguir midiendo
  // >= 24 px (axe `target-size`) o estar del todo oculto, y nada debe quedar tapado por la barra inferior.
  for (const offset of [90, 170, 330]) {
    await page.locator("[data-shell-scroll]").evaluate((node, y) => node.scrollTo(0, y), offset);
    await page.waitForTimeout(250);
    await check(page, problems, `revisar (desplazada ${offset})`, null);
    await coverage(page, problems, `revisar (desplazada ${offset})`);
  }
  await page.locator("[data-shell-scroll]").evaluate((node) => node.scrollTo(0, 0));
  if (onlyReview) return problems;

  // Confirmacion de «Quitar hojas en blanco» (miniaturas con casillas)
  if ((await page.locator('[data-review-action="remove-blanks"]').count()) > 0) {
    await page.locator('[data-review-action="remove-blanks"]').click();
    await expect(page.locator("[data-blanks-sheet]")).toBeVisible();
    await page.waitForTimeout(500);
    await check(page, problems, "quitar blancos", "[role=dialog]");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-blanks-sheet]")).toHaveCount(0);
  }

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
  await coverage(page, problems, "guardar");
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

test.describe("letra al 150 % (ajuste de accesibilidad del sistema)", () => {
  for (const [width, height] of [[320, 568], [393, 852]] as const) {
    for (const language of ["es", "en"] as const) {
      test(`sin desborde ni violaciones ni controles tapados · ${language} · ${width}px`, async ({ browser }) => {
        // Letra al 150 % Y fuente ancha a la vez: lo peor que puede pasar en un movil Android pequeño.
        const context = await newContext(browser, { width, height, theme: "light", language, fontScale: 150, wide: true });
        const page = await context.newPage();
        // Sin camara: su capa a pantalla completa con letra al 150 % es otra pantalla (ver «Fuera de alcance» de la documentacion).
        const problems = await tour(page, language, true, false, true);
        await context.close();
        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
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
  await measure("cabecera", "[data-review] [data-shell-top] button");
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

test.describe("contraste con muchas miniaturas (insignia del numero y asa de arrastre sobre fondo oscuro)", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["es", "en"] as const) {
      for (const width of [320, 375, 768] as const) {
        test(`axe color-contrast con 14 miniaturas · ${theme} · ${language} · ${width}px`, async ({ browser }) => {
          const context = await newContext(browser, { width, theme, language });
          const page = await context.newPage();
          const problems: Problems = [];
          await installScanFakes(page);
          await page.goto("/scan-to-pdf");
          await expect(page.locator("[data-start]")).toBeVisible();
          await importPhotos(page, scanFiles(Array.from({ length: 14 }, (_, index) => `p${index + 1}.jpg`)));
          await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(14, { timeout: 60_000 });
          await waitIdle(page);
          await check(page, problems, "14 miniaturas", null);
          // Con la lista al final (lo que el verificador midio: fallaba a partir de ~11 hojas).
          await page.locator("[data-shell-scroll]").evaluate((node) => node.scrollTo(0, node.scrollHeight));
          await check(page, problems, "14 miniaturas (final)", null);
          await context.close();
          expect(problems, problems.join("\n")).toEqual([]);
        });
      }
    }
  }
});

test.describe("cabecera pegajosa: ningun control queda a medias bajo ella al desplazar la lista (1024×768 y moviles)", () => {
  for (const [width, height] of [[1024, 768], [768, 1024], [375, 667]] as const) {
    test(`axe target-size con la lista a distintas alturas · ${width}×${height}`, async ({ browser }) => {
      const context = await newContext(browser, { width, height, theme: "light", language: "es" });
      const page = await context.newPage();
      const problems: Problems = [];
      await installScanFakes(page);
      await page.goto("/scan-to-pdf");
      await importPhotos(page, scanFiles(Array.from({ length: 16 }, (_, index) => `p${index + 1}.jpg`)));
      await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(16, { timeout: 60_000 });
      await waitIdle(page);
      // Alturas arbitrarias: incluidas las que dejan un asa o un chip justo en el borde de la cabecera.
      for (const offset of [20, 47, 63, 88, 119, 151, 203, 262, 333, 410, 503]) {
        await page.locator("[data-shell-scroll]").evaluate((node, y) => node.scrollTo(0, y), offset);
        await page.waitForTimeout(150);
        await check(page, problems, `desplazada ${offset}`, null);
      }
      await context.close();
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});
