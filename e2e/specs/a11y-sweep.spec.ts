import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

/**
 * W6-C · Barrido de accesibilidad del sistema (reutilizable).
 *
 * Cuatro bloques, todos en Chromium headless:
 *  1. axe-core (color-contrast, aria-valid-attr-value, label, button-name,
 *     link-name = 0 violaciones) en 7 rutas x claro/oscuro x ES/EN x 1280/375
 *     y, en las herramientas, con un archivo cargado y (a 375) con la hoja
 *     "Opciones" abierta.
 *  2. Recorrido de 64 Tab: el primero es «Saltar al contenido» (visible al
 *     enfocarse), Enter lleva el foco a <main> y el siguiente Tab cae dentro;
 *     el foco nunca queda en <body> salvo la salida natural del documento
 *     (justo despues del ultimo control tabulable).
 *  3. Objetivos tactiles (emulacion tactil a 375 px, `elementFromPoint` sobre
 *     el area real): todo control habilitado mide >= 44 px (43 por el redondeo
 *     del muestreo en enteros).
 *  4. `forced-colors: active`: cada control interactivo es distinguible
 *     (borde, contorno o fondo propios, o dentro de un contenedor con borde),
 *     el estado elegido de cada grupo se distingue del resto y el slider y la
 *     casilla marcada pintan pixeles.
 *
 * axe-core llega como dependencia transitiva de eslint-config-next
 * (eslint-plugin-jsx-a11y); no se anadio a package.json.
 *
 * Uso (build de produccion servida en el puerto propio):
 *   npx next build && npx next start -p 3397 &
 *   PW_PORT=3397 npx playwright test e2e/specs/a11y-sweep.spec.ts
 */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const PDF = path.join(__dirname, "..", "fixtures", "core-rotated-pages.pdf");
/** PNG de 1x1 px: lo minimo que acepta jpg-to-pdf como "imagen". */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const AXE_RULES = [
  "color-contrast",
  "aria-valid-attr-value",
  "label",
  "button-name",
  "link-name",
] as const;

type Language = "es" | "en";
type Theme = "light" | "dark";

/** Ruta + como cargarle un archivo (null = sin zona de carga). */
const ROUTES: Array<{ route: string; files: "pdf" | "two-pdf" | "image" | null }> = [
  { route: "/", files: null },
  // Wave 7: la suite de PDF Pro (estado vacio y con un documento abierto).
  { route: "/pdf-pro", files: "pdf" },
  { route: "/merge-pdf", files: "two-pdf" },
  { route: "/compress-pdf", files: "pdf" },
  { route: "/organize-pdf", files: "pdf" },
  { route: "/add-watermark", files: "pdf" },
  { route: "/edit-pdf", files: "pdf" },
  { route: "/sign-pdf", files: "pdf" },
  // N6: sus dos inputs de archivo ocultos no tenian nombre (axe `label` x2).
  { route: "/scan-to-pdf", files: null },
];

async function newContext(
  browser: import("@playwright/test").Browser,
  opts: { width: number; theme: Theme; language: Language; touch?: boolean; forced?: boolean },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.width < 600 ? 812 : 900 },
    colorScheme: opts.theme,
    forcedColors: opts.forced ? "active" : "none",
    hasTouch: opts.touch ?? false,
    isMobile: opts.touch ?? false,
    deviceScaleFactor: opts.touch ? 2 : 1,
  });
  await context.addInitScript(
    ([theme, language]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
        // Avisos de privacidad de Firmar/Editar: no deben tapar la pagina.
        window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
      } catch {
        /* storage bloqueado */
      }
    },
    [opts.theme, opts.language],
  );
  return context;
}

async function load(page: Page, route: string) {
  await page.goto(route, { waitUntil: "networkidle" });
  await page.locator("main#content").waitFor();
}

/** El input de archivo que acepta PDF o imagenes (Firmar tiene antes el del .zip de configuracion). */
async function uploadTo(page: Page, kind: "pdf" | "two-pdf" | "image") {
  const input = page
    .locator(
      'input[type="file"][accept*="pdf"], input[type="file"][accept*="image"], input[type="file"][accept*="jpeg"]',
    )
    .first();
  if (kind === "image") {
    await input.setInputFiles([
      { name: "a.png", mimeType: "image/png", buffer: PNG_1X1 },
      { name: "b.png", mimeType: "image/png", buffer: PNG_1X1 },
    ]);
  } else if (kind === "two-pdf") {
    await input.setInputFiles([PDF, PDF]);
  } else {
    await input.setInputFiles(PDF);
  }
  // pdf.js + miniaturas + (Firmar/Editar) lienzo: margen para que se asiente.
  await page.waitForTimeout(2500);
}

async function runAxe(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`),
    }));
  }, AXE_RULES);
}

function describeViolations(violations: Awaited<ReturnType<typeof runAxe>>): string {
  return violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n");
}

/* ------------------------------------------------------------------ *
 * 1. axe-core
 * ------------------------------------------------------------------ */
test.describe("axe-core: 0 violaciones de contraste, aria-valid-attr-value, label, button-name y link-name", () => {
  for (const { route, files } of ROUTES) {
    for (const theme of ["dark", "light"] as const) {
      for (const language of ["es", "en"] as const) {
        for (const width of [1280, 375]) {
          test(`${route} · ${theme} · ${language} · ${width}px`, async ({ browser }) => {
            test.setTimeout(120_000);
            const context = await newContext(browser, { width, theme, language });
            const page = await context.newPage();
            try {
              await load(page, route);
              const empty = await runAxe(page);
              expect(empty, `${route} vacio\n${describeViolations(empty)}`).toEqual([]);

              if (files) {
                await uploadTo(page, files);
                const loaded = await runAxe(page);
                expect(loaded, `${route} con archivo\n${describeViolations(loaded)}`).toEqual([]);

                // A 375 px las opciones viven en una hoja ("Opciones").
                if (width < 600) {
                  const options = page.getByRole("button", { name: /^(opciones|options)/i }).first();
                  if (await options.count()) {
                    await options.click();
                    await page.waitForTimeout(900);
                    const sheet = await runAxe(page);
                    expect(sheet, `${route} con la hoja Opciones\n${describeViolations(sheet)}`).toEqual([]);
                  }
                }
              }
            } finally {
              await context.close();
            }
          });
        }
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. Tab: enlace de salto y ningun foco perdido en <body>
 * ------------------------------------------------------------------ */
test.describe("teclado: saltar al contenido y 64 Tab sin foco en <body>", () => {
  // PDF Pro abre un documento y deja el foco EN su titulo (no en el inicio de la pagina): el primer Tab ya no es
  // «Saltar al contenido», asi que su recorrido con teclado se prueba aparte (`pdf-pro-foundation.spec.ts`).
  for (const { route, files } of ROUTES.filter((entry) => entry.route !== "/pdf-pro")) {
    for (const width of [1280, 375]) {
      test(`${route} · ${width}px`, async ({ browser }) => {
        test.setTimeout(120_000);
        const context = await newContext(browser, { width, theme: "dark", language: "es" });
        const page = await context.newPage();
        try {
          await load(page, route);
          if (files) await uploadTo(page, files);
          await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
          });

          // --- 64 Tab desde el inicio del documento
          const trail: Array<{ name: string; body: boolean; last: boolean; geometry: { x: number; y: number; w: number; h: number; vw: number } }> = [];
          for (let i = 0; i < 64; i += 1) {
            await page.keyboard.press("Tab");
            trail.push(
              await page.evaluate(() => {
                const sel =
                  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
                const tabbable = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
                  if (el.tabIndex < 0) return false;
                  if ((el as HTMLButtonElement).disabled || el.closest("[inert]")) return false;
                  const cs = getComputedStyle(el);
                  const r = el.getBoundingClientRect();
                  return cs.visibility !== "hidden" && cs.display !== "none" && (r.width > 0 || r.height > 0 || el.matches(".sr-only"));
                });
                const active = document.activeElement as HTMLElement | null;
                const body = !active || active === document.body || active === document.documentElement;
                const r = active ? active.getBoundingClientRect() : new DOMRect();
                return {
                  name: body ? "<body>" : `${active!.tagName.toLowerCase()} ${(active!.getAttribute("aria-label") ?? active!.textContent ?? "").trim().slice(0, 28)}`,
                  body,
                  last: !!active && active === tabbable[tabbable.length - 1],
                  geometry: { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth },
                };
              }),
            );
          }

          // --- el primer Tab es el enlace «Saltar al contenido», visible al enfocarse
          const g = trail[0].geometry;
          expect(trail[0].name).toBe("a Saltar al contenido");
          expect(g.w).toBeGreaterThan(40);
          expect(g.h).toBeGreaterThanOrEqual(40);
          expect(g.x).toBeGreaterThanOrEqual(0);
          expect(g.y).toBeGreaterThanOrEqual(0);
          expect(g.x + g.w).toBeLessThanOrEqual(g.vw);

          const lost = trail.flatMap((step, i) =>
            step.body && !(i > 0 && trail[i - 1].last) ? [`#${i + 1} tras «${trail[i - 1]?.name ?? "inicio"}»`] : [],
          );
          expect(lost, `foco perdido en <body> fuera de la salida natural:\n${lost.join("\n")}`).toEqual([]);

          // --- Enter sobre el enlace: el foco va a <main> y el siguiente Tab cae dentro
          await load(page, route);
          await page.keyboard.press("Tab");
          await page.keyboard.press("Enter");
          expect(await page.evaluate(() => document.activeElement?.id)).toBe("content");
          await page.keyboard.press("Tab");
          expect(await page.evaluate(() => !!document.querySelector("main#content")?.contains(document.activeElement))).toBe(true);
        } finally {
          await context.close();
        }
      });
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3. Objetivos tactiles >= 44 px (emulacion tactil, 375 px)
 * ------------------------------------------------------------------ */
const TOUCH_ROUTES: Array<{ route: string; files: "pdf" | "two-pdf" | "image"; sheet?: boolean }> = [
  { route: "/merge-pdf", files: "two-pdf" },
  { route: "/organize-pdf", files: "pdf", sheet: true },
  { route: "/jpg-to-pdf", files: "image", sheet: true },
  { route: "/crop-pdf", files: "pdf", sheet: true },
  { route: "/redact-pdf", files: "pdf", sheet: true },
  { route: "/pdf-to-markdown", files: "pdf", sheet: true },
  { route: "/split-pdf", files: "pdf", sheet: true },
  { route: "/compress-pdf", files: "pdf", sheet: true },
  { route: "/add-watermark", files: "pdf", sheet: true },
  { route: "/add-page-numbers", files: "pdf", sheet: true },
  { route: "/sign-pdf", files: "pdf" },
];

/** Mide el area tactil REAL de cada control (elementFromPoint en cruz desde su centro). */
const PROBE = (inDialog: boolean) => `(() => {
  const ROOT = ${inDialog ? "document.querySelector('[role=dialog]')" : "document"};
  if (!ROOT) return [];
  const SEL = 'button, a[href], input:not([type=hidden]), select, summary, textarea, [role=tab], [role=radio], [role=checkbox], [role=switch], [role=slider]';
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[inert],[aria-hidden=true]'); };
  const hits = (el, x, y) => { const h = document.elementFromPoint(x, y); return !!h && (el === h || el.contains(h) || (el.labels && [...el.labels].some((l) => l === h || l.contains(h)))); };
  const out = [];
  for (const el of [...ROOT.querySelectorAll(SEL)].filter((e) => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && visible(e))) {
    // Enlaces de texto en linea (dentro de un parrafo) no son objetivos de este criterio.
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    if (!hits(el, cx, cy)) continue; // tapado por una barra fija: no se puede medir sin desplazar
    const ext = (dx, dy) => { let n = 0; for (let i = 1; i <= 60; i++) { const x = cx + dx * i, y = cy + dy * i; if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hits(el, x, y)) break; n = i; } return n; };
    out.push({ name: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40), tag: el.tagName.toLowerCase(), w: ext(-1, 0) + ext(1, 0) + 1, h: ext(0, -1) + ext(0, 1) + 1 });
  }
  return out;
})()`;

test.describe("objetivos tactiles: >= 44 px con puntero grueso (375 px, emulacion tactil)", () => {
  for (const { route, files, sheet } of TOUCH_ROUTES) {
    test(route, async ({ browser }) => {
      test.setTimeout(120_000);
      const context = await newContext(browser, { width: 375, theme: "dark", language: "es", touch: true });
      const page = await context.newPage();
      try {
        await load(page, route);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        await uploadTo(page, files);

        const small: string[] = [];
        const measured = async (inDialog: boolean, where: string) => {
          const list = (await page.evaluate(PROBE(inDialog))) as Array<{ name: string; tag: string; w: number; h: number }>;
          for (const item of list) if (item.w < 43 || item.h < 43) small.push(`[${where}] ${item.tag} «${item.name}» ${item.w}x${item.h}`);
          return list.length;
        };
        const count = await measured(false, "pagina");
        expect(count).toBeGreaterThan(5);

        if (sheet) {
          const options = page.getByRole("button", { name: /^(opciones|options)/i }).first();
          if (await options.count()) {
            await options.click();
            await page.waitForTimeout(900);
            await measured(true, "hoja Opciones");
          }
        }
        expect(small, `controles por debajo de 44 px:\n${small.join("\n")}`).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 4. forced-colors: active
 * ------------------------------------------------------------------ */
const FORCED_ROUTES: Array<{ route: string; files: "pdf" | null }> = [
  { route: "/", files: null },
  { route: "/compress-pdf", files: "pdf" },
  { route: "/add-watermark", files: "pdf" },
  { route: "/add-page-numbers", files: "pdf" },
  { route: "/organize-pdf", files: "pdf" },
];

const FORCED_AUDIT = `(() => {
  const px = (v) => parseFloat(v) || 0;
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.classList.contains('sr-only') && !el.closest('[inert]'); };
  const hasBorder = (cs) => ['Top','Right','Bottom','Left'].some((s) => px(cs['border'+s+'Width']) > 0 && cs['border'+s+'Style'] !== 'none');
  const hasOutline = (cs) => px(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none';
  const canvas = getComputedStyle(document.body).backgroundColor;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgb = (c) => { cx.clearRect(0,0,1,1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0,0,1,1); return [...cx.getImageData(0,0,1,1).data]; };
  const lum = (c) => { const m = rgb(c); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const bordered = (el) => { let p = el.parentElement; for (let i = 0; p && i < 4; i++, p = p.parentElement) if (hasBorder(getComputedStyle(p))) return true; return false; };
  const out = { controls: 0, indistinct: [], groups: [] };
  const sel = 'button, [role=tab], [role=radio], [role=switch], input[type=checkbox], select';
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    out.controls++;
    const cs = getComputedStyle(el);
    const inner = el.querySelector('[class*=border], [class*=ring]');
    const own = hasBorder(cs) || hasOutline(cs) || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== canvas) || (inner && hasBorder(getComputedStyle(inner)));
    if (own || bordered(el)) continue;
    if (contrast(cs.color, canvas) >= 4.5) continue; // solo texto/icono con colores del sistema
    out.indistinct.push((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30));
  }
  const sig = (el) => { const cs = getComputedStyle(el); return [cs.borderTopWidth, cs.borderTopColor, cs.outlineStyle === 'none' ? '' : cs.outlineColor + cs.outlineWidth, cs.backgroundColor].join('|'); };
  for (const g of document.querySelectorAll('[role=radiogroup], [role=tablist]')) {
    if (!vis(g)) continue;
    const items = [...g.querySelectorAll('[role=radio], [role=tab]')].filter(vis);
    const picked = items.filter((e) => e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true');
    let distinct;
    if (g.getAttribute('role') === 'tablist') {
      const thumb = g.querySelector('span[aria-hidden=true]');
      const t = thumb ? getComputedStyle(thumb) : null;
      distinct = !!t && px(t.borderTopWidth) >= 2 && t.borderTopColor !== getComputedStyle(g).borderTopColor;
    } else {
      const others = items.filter((e) => !picked.includes(e));
      distinct = picked.length > 0 && others.length > 0 && picked.every((s) => others.every((o) => sig(s) !== sig(o)));
    }
    out.groups.push({ label: g.getAttribute('aria-label') || g.getAttribute('role'), distinct });
  }
  return out;
})()`;

/** Pixeles distintos del lienzo dentro del elemento (decodifica el PNG del navegador). */
async function inkPixels(page: Page, locator: ReturnType<Page["locator"]>, pad = 3): Promise<number> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) return 0;
  const buffer = await page.screenshot({
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  // Canvas del propio navegador: sin dependencias nuevas.
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 60) n += 1;
    }
    return n;
  }, buffer.toString("base64"));
}

test.describe("forced-colors: active — controles distinguibles", () => {
  for (const { route, files } of FORCED_ROUTES) {
    for (const width of [1280, 375]) {
      test(`${route} · ${width}px`, async ({ browser }, testInfo) => {
        test.setTimeout(120_000);
        const context = await newContext(browser, { width, theme: "dark", language: "en", forced: true });
        const page = await context.newPage();
        try {
          await load(page, route);
          expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
          if (files) {
            await uploadTo(page, files);
            if (width < 600) {
              const options = page.getByRole("button", { name: /^options/i }).first();
              if (await options.count()) {
                await options.click();
                await page.waitForTimeout(900);
              }
            }
          }
          const audit = (await page.evaluate(FORCED_AUDIT)) as {
            controls: number;
            indistinct: string[];
            groups: Array<{ label: string; distinct: boolean }>;
          };
          await testInfo.attach(`forced-${route.replace(/\W+/g, "_")}-${width}.png`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          expect(audit.controls).toBeGreaterThan(0);
          expect(audit.indistinct, `controles sin borde ni contraste: ${audit.indistinct.join(", ")}`).toEqual([]);
          const same = audit.groups.filter((g) => !g.distinct).map((g) => g.label);
          expect(same, `la opcion elegida no se distingue en: ${same.join(", ")}`).toEqual([]);

          // Slider y casilla marcada: pintan pixeles (antes de W6-C el slider era invisible).
          const slider = page.locator('input[type="range"]').first();
          if (width >= 1280 && (await slider.count())) {
            expect(await inkPixels(page, slider, 2)).toBeGreaterThan(300);
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  test("la casilla marcada se rellena en Highlight y se distingue de la desmarcada (compress-pdf)", async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await newContext(browser, { width: 1280, theme: "dark", language: "en", forced: true });
    const page = await context.newPage();
    try {
      await load(page, "/compress-pdf");
      await uploadTo(page, "pdf");
      const box = page.getByRole("checkbox").first();
      await box.scrollIntoViewIfNeeded();
      const read = () =>
        box.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, border: cs.borderTopColor, width: cs.borderTopWidth };
        });
      const off = await read();
      await box.check({ force: true });
      await page.waitForTimeout(400);
      const on = await read();
      expect(parseFloat(off.width)).toBeGreaterThan(0);
      expect(on.bg).not.toBe(off.bg);
    } finally {
      await context.close();
    }
  });
});

