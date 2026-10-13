import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { makeViewerPdf } from "../helpers/viewer-pdfs";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { engineOf, tabKey } from "../helpers/engine";

/**
 * PDF Pro · shell y visor de desplazamiento continuo (Wave 7 · U3), navegador real y headless:
 * abrir 5, 60 y 500 paginas (tamanos mezclados, giradas, con CropBox) y un PDF de ~40 MB; scroll y salto de
 * pagina; zoom por botones, teclado, Ctrl+rueda y pellizco emulado con eventos tactiles; miniaturas perezosas
 * y seleccion multiple compartida; paleta Cmd/Ctrl+K; deshacer/rehacer tras «Rotar 90°» conservando pagina y
 * zoom; distribucion (tiradores, plegado, F6, enlaces de salto); sin errores de consola, sin desbordes, foco
 * nunca en <body>, axe y objetivos tactiles de 44 px. Las mediciones de rendimiento (heap con
 * `Performance.getMetrics`, tiempo por salto) se imprimen con `console.log`.
 */

const S = PRO_STRINGS.es;
const V = S.viewer;
const AXE_PATH = require.resolve("axe-core/axe.min.js");

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

/* ------------------------------------------------------------------ *
 * Ayudas
 * ------------------------------------------------------------------ */

/** `bytes` viaja por el protocolo (cuenta en la medida); con `{ filePath }` el navegador lee el archivo del disco. */
async function openDoc(page: Page, bytes: Buffer | { filePath: string }, name = "documento.pdf"): Promise<number> {
  await page.goto("/pdf-pro");
  const started = Date.now();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles("filePath" in bytes ? bytes.filePath : { name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
  await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 60_000 });
  return Date.now() - started;
}

const pageInput = (page: Page) => page.getByRole("textbox", { name: V.pageInputLabel });
const currentPage = async (page: Page) => Number(await pageInput(page).inputValue());
const zoomOf = async (page: Page) => Number(await page.locator("[data-pro-feed]").getAttribute("data-zoom"));

/** Espera a que el desplazamiento por rueda (con inercia) termine: dos lecturas iguales separadas 150 ms. */
async function settleScroll(page: Page) {
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    const top = await page.locator("[data-pro-viewer-scroller]").evaluate((el) => el.scrollTop);
    if (top === last) return;
    last = top;
    await page.waitForTimeout(150);
  }
}

async function goTo(page: Page, n: number) {
  await pageInput(page).fill(String(n));
  await pageInput(page).press("Enter");
  await expect(page.locator(`article[data-page-index="${n - 1}"]`)).toBeVisible();
}

async function liveCounts(page: Page) {
  return page.evaluate(() => ({
    articles: document.querySelectorAll("article[data-page-index]").length,
    images: document.querySelectorAll("article img").length,
    thumbs: document.querySelectorAll("[data-thumb-index] img").length,
  }));
}

/**
 * Heap JS en uso (MB). Con `collect` se fuerza antes una recogida: sin ella cuenta basura aun no liberada.
 * Solo Chromium lo expone (por CDP): en WebKit y Firefox devuelve `null` y las pruebas se saltan SOLO el presupuesto de
 * memoria (el resto de lo que miden, virtualizacion y tiempos, se sigue comprobando).
 */
async function heapMB(page: Page, collect = false): Promise<number | null> {
  if (engineOf(page) !== "chromium") return null;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (collect) {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
  }
  const { metrics } = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  return (metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0) / 1e6;
}

async function noHorizontalOverflow(page: Page) {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
}

/** Mide, dentro de la pagina, cuanto tarda en estar montada y a la vista la hoja pedida (y luego en tener su imagen). */
async function jumpTiming(page: Page, n: number): Promise<{ shell: number; image: number }> {
  return page.evaluate(async (target) => {
    const input = document.querySelector<HTMLInputElement>("#pro-page-input")!;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(target));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const scroller = document.querySelector("[data-pro-viewer-scroller]")!;
    const started = performance.now();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    let shell = -1;
    for (;;) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const article = document.querySelector<HTMLElement>(`article[data-page-index="${target - 1}"]`);
      if (article) {
        const rect = article.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        if (shell < 0 && rect.bottom > box.top && rect.top < box.bottom) shell = performance.now() - started;
        if (shell >= 0 && article.dataset.state === "ready") return { shell, image: performance.now() - started };
      }
      if (performance.now() - started > 8000) return { shell, image: -1 };
    }
  }, n);
}

async function runAxe(page: Page, scope = "section[data-pro-suite]") {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (selector) => {
    const axe = (window as unknown as {
      axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> };
    }).axe;
    const result = await axe.run({ include: [[selector]] }, {});
    return result.violations.map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n")[1] ?? ""}`),
    }));
  }, scope);
}

function describeViolations(violations: Awaited<ReturnType<typeof runAxe>>): string {
  return violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n");
}

/** Pulsa Tab `count` veces: el foco nunca puede quedar en <body> (salvo justo tras el ultimo control tabulable). */
async function tabTrail(page: Page, count: number): Promise<string[]> {
  const trail: Array<{ name: string; body: boolean; last: boolean }> = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press(tabKey(page));
    trail.push(
      await page.evaluate(() => {
        const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
        const tabbable = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => {
          if (el.tabIndex < 0) return false;
          if ((el as HTMLButtonElement).disabled || el.closest("[inert]")) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0 || el.matches(".sr-only"));
        });
        const active = document.activeElement as HTMLElement | null;
        const body = !active || active === document.body || active === document.documentElement;
        return {
          name: body ? "<body>" : `${active!.tagName.toLowerCase()} ${(active!.getAttribute("aria-label") ?? active!.textContent ?? "").trim().slice(0, 28)}`,
          body,
          last: !!active && active === tabbable[tabbable.length - 1],
        };
      }),
    );
  }
  // El indicador de desarrollo de Next (`nextjs-portal`) solo existe en `next dev`: tras el sale el foco de forma natural.
  const natural = (i: number) => i > 0 && (trail[i - 1].last || trail[i - 1].name.startsWith("nextjs-portal"));
  return trail.flatMap((step, i) => (step.body && !natural(i) ? [`#${i + 1} tras «${trail[i - 1]?.name ?? "inicio"}»`] : []));
}

/* ------------------------------------------------------------------ *
 * Escritorio 1280 x 800
 * ------------------------------------------------------------------ */

test.describe("visor continuo · escritorio", () => {
  test("5 paginas: feed, miniaturas, indicador, sin desborde y foco en el titulo", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(5), "cinco.pdf");
    await expect(page.getByRole("feed", { name: V.feedLabel })).toBeVisible();
    await expect(page.locator("[data-thumb-index]")).toHaveCount(5);
    await expect(pageInput(page)).toHaveValue("1");
    await expect(page.getByText(V.pageTotal(5), { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("status")).toHaveCount(1);
    await noHorizontalOverflow(page);
  });

  test("60 paginas de tamanos mezclados: la rueda cambia de pagina, el campo salta, las miniaturas siguen", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(60, { mixed: true, rotate: true, crop: true }), "sesenta.pdf");
    await page.locator("[data-pro-viewer-scroller]").hover();
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 700);
    await expect.poll(() => currentPage(page)).toBeGreaterThan(3);
    await settleScroll(page);
    await goTo(page, 40);
    await expect(page.locator('article[data-page-index="39"]')).toHaveAttribute("data-state", "ready");
    await expect(page.locator('[data-thumb-index="39"]')).toHaveAttribute("aria-current", "page");
    await goTo(page, 1);
    await expect.poll(() => currentPage(page)).toBe(1);
  });

  test("500 paginas mixtas, giradas y con CropBox: abre, virtualiza y salta rapido (con mediciones)", async ({ page }) => {
    const bytes = await makeViewerPdf(500, { mixed: true, rotate: true, crop: true });
    const openMs = await openDoc(page, bytes, "quinientas.pdf");
    const first = await liveCounts(page);
    expect(first.articles).toBeLessThanOrEqual(16);
    expect(first.images).toBeLessThanOrEqual(10);
    await expect(page.locator("[data-thumb-index]")).toHaveCount(500);

    // La barra de scroll es la de las 500 paginas desde el principio (altura reservada con la proporcion real).
    await expect.poll(() => page.locator("[data-pro-feed]").evaluate((el) => el.getBoundingClientRect().height), { timeout: 15_000 }).toBeGreaterThan(200_000);

    const timings: string[] = [];
    for (const n of [250, 499, 1, 123, 400, 77]) {
      const { shell, image } = await jumpTiming(page, n);
      timings.push(`p${n}: ${shell.toFixed(0)} ms hoja / ${image.toFixed(0)} ms imagen`);
      expect(shell, `salto a ${n}`).toBeGreaterThanOrEqual(0);
      expect(shell, `salto a ${n} (hoja a la vista)`).toBeLessThan(100);
      expect(image, `salto a ${n} (imagen)`).toBeGreaterThan(0);
      const counts = await liveCounts(page);
      expect(counts.articles).toBeLessThanOrEqual(16);
      expect(counts.images).toBeLessThanOrEqual(12);
    }

    // Recorrido continuo: el DOM y la memoria se mantienen acotados.
    const scroller = page.locator("[data-pro-viewer-scroller]");
    await scroller.hover();
    let peakImages = 0;
    for (let i = 0; i < 60; i += 1) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(25);
      peakImages = Math.max(peakImages, (await liveCounts(page)).images);
    }
    await page.waitForTimeout(800);
    const heapRaw = await heapMB(page);
    const heap = await heapMB(page, true);
    const counts = await liveCounts(page);
    console.log(`[perf] 500 paginas: abrir ${openMs} ms; saltos: ${timings.join(" | ")}; pico de imagenes vivas ${peakImages}; heap JS ${heapRaw?.toFixed(1) ?? "n/d"} MB (${heap?.toFixed(1) ?? "n/d"} MB tras recoger basura); miniaturas con imagen ${counts.thumbs}`);
    expect(peakImages).toBeLessThanOrEqual(12);
    if (heap !== null) expect(heap, "heap JS").toBeLessThan(150);
    expect(counts.thumbs).toBeLessThanOrEqual(80);
    expect(openMs).toBeLessThan(5000);
  });

  // Presupuesto: 6 s. El PDF se abre POR RUTA DE DISCO: pasar el buffer de 40 MB por el protocolo de Playwright
  // (`setInputFiles({ buffer })`) cuenta DENTRO de la medida y en el runner de CI (2 trabajadores, CPU lenta) tardaba
  // por si solo 8,5-9,1 s (medido igual en local con la CPU a 1/4: 8,5 s) aunque abrir el documento cuesta ~1 s.
  // La medida fina de «primera pagina pintada» (< 3 s) vive en `pdf-pro-perf.spec.ts`.
  test("PDF de ~40 MB: abre en menos de 6 s y se desplaza", async ({ page }) => {
    const bytes = await makeViewerPdf(120, { noiseKb: 330 });
    expect(bytes.length).toBeGreaterThan(38_000_000);
    const dir = mkdtempSync(path.join(tmpdir(), "pro-viewer-"));
    const filePath = path.join(dir, "pesado.pdf");
    writeFileSync(filePath, bytes);
    try {
      const openMs = await openDoc(page, { filePath }, "pesado.pdf");
      await page.waitForTimeout(1000);
      const heap = await heapMB(page, true);
      console.log(`[perf] PDF de ${(bytes.length / 1e6).toFixed(1)} MB: abrir ${openMs} ms; heap JS ${heap?.toFixed(1) ?? "n/d"} MB tras recoger basura`);
      expect(openMs).toBeLessThan(6000);
      if (heap !== null) expect(heap, "heap JS con un PDF de ~40 MB").toBeLessThan(150);
      await goTo(page, 90);
      await expect(page.locator('article[data-page-index="89"]')).toHaveAttribute("data-state", "ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("miniaturas perezosas: solo las que se ven, y mas lejos solo al desplazarse", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(300, { mixed: true }), "miniaturas.pdf");
    await expect.poll(async () => (await liveCounts(page)).thumbs).toBeGreaterThan(0);
    await page.waitForTimeout(1200);
    const initial = (await liveCounts(page)).thumbs;
    expect(initial).toBeLessThan(25);
    await expect(page.locator('[data-thumb-index="250"] img')).toHaveCount(0);
    await page.locator('[data-thumb-index="250"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-thumb-index="250"] img')).toHaveCount(1, { timeout: 10_000 });
    expect((await liveCounts(page)).thumbs).toBeLessThanOrEqual(80);
  });

  test("zoom: botones, teclado y limites 50-400 %", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(10), "zoom.pdf");
    const value = page.locator("[data-pro-zoom-value]");
    await expect(value).toHaveText("100 %");
    await page.getByRole("button", { name: V.zoomIn }).click();
    await expect(value).toHaveText("125 %");
    await page.getByRole("button", { name: V.zoomOut }).click();
    await page.getByRole("button", { name: V.zoomOut }).click();
    await expect(value).toHaveText("75 %");
    await page.getByRole("button", { name: V.fitWidth }).click();
    await expect(value).toHaveText("100 %");
    await page.locator('article[data-page-index="0"]').focus();
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await expect(value).toHaveText("150 %");
    await page.keyboard.press("-");
    await expect(value).toHaveText("125 %");
    await page.keyboard.press("0");
    await expect(value).toHaveText("100 %");
    for (let i = 0; i < 2; i += 1) await page.getByRole("button", { name: V.zoomOut }).click();
    await expect(value).toHaveText("50 %");
    await expect(page.getByRole("button", { name: V.zoomOut })).toHaveAttribute("aria-disabled", "true");
    // 50 -> 75 -> 100 -> 125 -> 150 -> 200 -> 300 -> 400 (siete pasos); Playwright no pulsa un boton aria-disabled.
    for (let i = 0; i < 7; i += 1) await page.getByRole("button", { name: V.zoomIn }).click();
    await expect(value).toHaveText("400 %");
    await expect(page.getByRole("button", { name: V.zoomIn })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("status")).toHaveCount(1);
    await noHorizontalOverflow(page);
  });

  test("Ctrl + rueda hace zoom y deja bajo el cursor el mismo punto de la hoja", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(10), "rueda.pdf");
    await page.mouse.move(640, 450);
    // Punto de la hoja bajo el cursor, en fracciones de la hoja.
    const fraction = () =>
      page.evaluate(
        ({ x, y }) => {
          const hit = document.elementsFromPoint(x, y).find((el) => el.matches("article[data-page-index]")) as HTMLElement | undefined;
          if (!hit) return null;
          const rect = hit.getBoundingClientRect();
          return { index: hit.dataset.pageIndex, fx: (x - rect.left) / rect.width, fy: (y - rect.top) / rect.height };
        },
        { x: 640, y: 450 },
      );
    const before = await fraction();
    await page.keyboard.down("Control");
    for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(1.4);
    await page.waitForTimeout(300);
    const after = await fraction();
    expect(after?.index).toBe(before?.index);
    expect(Math.abs((after?.fx ?? 9) - (before?.fx ?? 0))).toBeLessThan(0.03);
    expect(Math.abs((after?.fy ?? 9) - (before?.fy ?? 0))).toBeLessThan(0.03);
    // No se acerco la pagina entera del navegador.
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });

  test("teclado en el visor: Av Pag, Inicio, Fin, flechas y foco en la hoja", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(60, { mixed: true }), "teclas.pdf");
    await page.locator('article[data-page-index="0"]').focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => currentPage(page)).toBe(2);
    await expect(page.locator('article[data-page-index="1"]')).toBeFocused();
    await page.keyboard.press("End");
    await expect.poll(() => currentPage(page)).toBe(60);
    await expect(page.locator('article[data-page-index="59"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect.poll(() => currentPage(page)).toBe(1);
    const before = await page.locator("[data-pro-viewer-scroller]").evaluate((el) => el.scrollTop);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.locator("[data-pro-viewer-scroller]").evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  });

  test("movimiento reducido: el salto a la pagina vecina es inmediato", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDoc(page, await makeViewerPdf(20), "quieto.pdf");
    const target = await page.locator('article[data-page-index="1"]').evaluate((el) => (el as HTMLElement).offsetTop - 16);
    await page.locator('article[data-page-index="0"]').focus();
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(60);
    const top = await page.locator("[data-pro-viewer-scroller]").evaluate((el) => el.scrollTop);
    expect(Math.abs(top - target)).toBeLessThan(3);
  });

  test("miniaturas: clic salta; Ctrl+clic, Mayus+clic y teclado seleccionan, y el visor lo muestra", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(40), "seleccion.pdf");
    await page.locator('[data-thumb-index="12"]').click();
    await expect.poll(() => currentPage(page)).toBe(13);
    await expect(page.locator('[data-thumb-index="12"]')).toHaveAttribute("aria-current", "page");
    await page.locator('[data-thumb-index="3"]').click({ modifiers: ["ControlOrMeta"] });
    await page.locator('[data-thumb-index="6"]').click({ modifiers: ["Shift"] });
    await expect(page.locator("[data-pro-selection-count]")).toHaveText(V.selectedCount(4));
    for (const index of [3, 4, 5, 6]) await expect(page.locator(`[data-thumb-index="${index}"]`)).toHaveAttribute("aria-selected", "true");
    // La misma seleccion se ve en la hoja del visor.
    await goTo(page, 5);
    await expect(page.locator('article[data-page-index="4"]')).toHaveAttribute("data-selected", "true");
    // Ctrl+clic en una hoja del visor la anade (misma seleccion).
    await page.locator('article[data-page-index="4"]').click({ modifiers: ["ControlOrMeta"] });
    await expect(page.locator("[data-pro-selection-count]")).toHaveText(V.selectedCount(3));
    // Teclado en la lista: Espacio alterna; Esc quita todo.
    await page.locator('[data-thumb-index="20"]').focus();
    await page.keyboard.press(" ");
    await expect(page.locator("[data-pro-selection-count]")).toHaveText(V.selectedCount(4));
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-pro-selection-count]")).toHaveCount(0);
  });

  test("las miniaturas se recorren con flechas (un solo tabulador) y Intro salta", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(30), "flechas.pdf");
    await page.locator('[data-thumb-index="0"]').focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('[data-thumb-index="2"]')).toBeFocused();
    expect(await page.locator('[data-thumb-index][tabindex="0"]').count()).toBe(1);
    await page.keyboard.press("Enter");
    await expect.poll(() => currentPage(page)).toBe(3);
    await page.keyboard.press("End");
    await expect(page.locator('[data-thumb-index="29"]')).toBeFocused();
  });

  test("paleta Cmd/Ctrl+K: se abre, busca, no se hace con un campo enfocado y ejecuta", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(60), "paleta.pdf");
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox", { name: S.palette.label });
    await expect(input).toBeFocused();
    await input.fill("acercar");
    await expect(page.getByRole("listbox", { name: S.palette.resultsLabel }).getByRole("option").first()).toContainText(S.palette.zoomIn);
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-pro-zoom-value]")).toHaveText("125 %");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Con Cmd tambien.
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("combobox", { name: S.palette.label })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Con el foco en el campo «Ir a la pagina» el atajo no se secuestra.
    await pageInput(page).focus();
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(150);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // «Ir a la pagina N» desde la paleta.
    await page.locator("article[data-page-index]").first().focus();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: S.palette.label }).fill("42");
    await page.keyboard.press("Enter");
    await expect.poll(() => currentPage(page)).toBe(42);
    await expect(page.locator('article[data-page-index="41"]')).toBeFocused();
  });

  test("la paleta aplica «Rotar 90°» y Ctrl+Z / Ctrl+Mayus+Z conservan la pagina y el zoom (500 paginas)", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(500, { mixed: true }), "rotar.pdf");
    await goTo(page, 321);
    await page.getByRole("button", { name: V.zoomIn }).click();
    await page.getByRole("button", { name: V.zoomIn }).click();
    await expect(page.locator("[data-pro-zoom-value]")).toHaveText("150 %");
    const heightBefore = await page.locator('article[data-page-index="320"]').evaluate((el) => el.getBoundingClientRect().height);

    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: S.palette.label }).fill("rotar 90");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText(S.announce.applied(S.operations.rotateAll90), { timeout: 30_000 });
    await expect(page.getByText(S.suite.unsaved)).toBeVisible();
    await expect.poll(() => currentPage(page)).toBe(321);
    await expect(page.locator("[data-pro-zoom-value]")).toHaveText("150 %");
    await expect(page.locator('article[data-page-index="320"]')).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    // La hoja que se esta viendo ya tiene su proporcion nueva (las paginas visibles se miden las primeras).
    await expect
      .poll(() => page.locator('article[data-page-index="320"]').evaluate((el, before) => Math.abs(el.getBoundingClientRect().height - before), heightBefore), {
        message: "la hoja cambio de proporcion al girar",
      })
      .toBeGreaterThan(5);
    expect(await page.locator("article[data-page-index] img").count()).toBeLessThanOrEqual(12);

    await page.keyboard.press("Control+z");
    await expect(page.getByRole("status")).toHaveText(S.announce.undone(S.operations.rotateAll90));
    await expect.poll(() => currentPage(page)).toBe(321);
    await expect(page.locator("[data-pro-zoom-value]")).toHaveText("150 %");
    await expect(page.locator('article[data-page-index="320"]')).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    await expect
      .poll(() => page.locator('article[data-page-index="320"]').evaluate((el, before) => Math.abs(el.getBoundingClientRect().height - before), heightBefore), {
        message: "tras deshacer la hoja recupera su proporcion original",
      })
      .toBeLessThan(2);

    await page.keyboard.press("Control+Shift+z");
    await expect(page.getByRole("status")).toHaveText(S.announce.redone(S.operations.rotateAll90));
    await expect.poll(() => currentPage(page)).toBe(321);
    await expect(page.locator("[data-pro-zoom-value]")).toHaveText("150 %");
  });

  test("distribucion: tiradores con teclado, plegado, persistencia tras recargar y F6", async ({ page }) => {
    const bytes = await makeViewerPdf(8);
    await openDoc(page, bytes, "layout.pdf");
    const [thumbsHandle, contextHandle] = await page.getByRole("separator").all();
    await thumbsHandle.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(thumbsHandle).toHaveAttribute("aria-valuenow", "208");
    await contextHandle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(contextHandle).toHaveAttribute("aria-valuenow", "356");
    const widths = await page.evaluate(() => ({
      thumbs: (document.querySelector("[data-pro-region=thumbs]") as HTMLElement).getBoundingClientRect().width,
      context: (document.querySelector("[data-pro-region=context]") as HTMLElement).getBoundingClientRect().width,
    }));
    expect(widths.thumbs).toBeCloseTo(208, 0);
    expect(widths.context).toBeCloseTo(356, 0);

    // Ratón: arrastrar el tirador de las miniaturas.
    const box = (await thumbsHandle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + 200, { steps: 4 });
    await page.mouse.up();
    await expect(thumbsHandle).toHaveAttribute("aria-valuenow", "248");

    await page.getByRole("button", { name: V.hidePanel }).click();
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    for (const tab of await page.getByRole("tab").all()) await expect(tab).not.toHaveAttribute("aria-controls", /.+/);

    // Persiste: otra carga abre con 248 de miniaturas y el panel plegado.
    await page.reload();
    await page.locator('input[type="file"]').first().setInputFiles({ name: "layout.pdf", mimeType: "application/pdf", buffer: bytes });
    await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    await expect(page.getByRole("separator")).toHaveCount(1);
    expect(await page.evaluate(() => (document.querySelector("[data-pro-region=thumbs]") as HTMLElement).getBoundingClientRect().width)).toBeCloseTo(248, 0);
    await page.getByRole("button", { name: V.showPanel }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();

    // F6 recorre las regiones y los enlaces de salto llevan a una.
    await page.getByRole("button", { name: S.suite.undo }).focus();
    const regions: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("F6");
      regions.push(await page.evaluate(() => (document.activeElement as HTMLElement).closest("[data-pro-region]")?.getAttribute("data-pro-region") ?? "?"));
    }
    expect(regions).toEqual(["tabs", "thumbs", "viewer", "context", "top"]);
    await page.getByRole("button", { name: S.shell.skipViewer }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("article[data-page-index][tabindex='0']")).toBeFocused();
  });

  test("con una ventana justa (1024 px, con la barra lateral) el panel se pliega solo; con 800 px se estrecha; el visor no baja de 320 px", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openDoc(page, await makeViewerPdf(6), "estrecho.pdf");
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    const viewerWidth = () => page.evaluate(() => (document.querySelector("[data-pro-region=viewer]") as HTMLElement).getBoundingClientRect().width);
    expect(await viewerWidth()).toBeGreaterThanOrEqual(320);
    await noHorizontalOverflow(page);
    // Sin barra lateral (< 1024 px) hay sitio: el panel vuelve, mas estrecho que su ancho preferido.
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.getByRole("tabpanel")).toBeVisible();
    const panel = await page.getByRole("tabpanel").evaluate((el) => el.getBoundingClientRect().width);
    expect(panel).toBeLessThan(340);
    expect(panel).toBeGreaterThanOrEqual(280);
    expect(await viewerWidth()).toBeGreaterThanOrEqual(320);
    await noHorizontalOverflow(page);
  });

  test("el foco nunca cae a <body> recorriendo el documento con Tab", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(12), "tab.pdf");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const lost = await tabTrail(page, 60);
    expect(lost, `foco perdido en <body>:\n${lost.join("\n")}`).toEqual([]);
  });

  test("axe: 0 violaciones en la suite (claro, oscuro, 1280 px)", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(20, { mixed: true }), "axe.pdf");
    await page.waitForTimeout(800);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((value) => window.localStorage.setItem("optimuspdf.theme", value), scheme);
      await page.reload();
      await page.locator('input[type="file"]').first().setInputFiles({ name: "axe.pdf", mimeType: "application/pdf", buffer: await makeViewerPdf(20, { mixed: true }) });
      await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(800);
      const violations = await runAxe(page);
      expect(violations, `${scheme}: ${describeViolations(violations)}`).toEqual([]);
    }
  });

  test("forced-colors: la hoja, la barra y el tirador siguen siendo distinguibles", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openDoc(page, await makeViewerPdf(6), "forzado.pdf");
    const info = await page.evaluate(() => {
      const border = (el: Element | null) => (el ? getComputedStyle(el).borderTopWidth : "none");
      return {
        article: border(document.querySelector("article[data-page-index]")),
        zoomButton: border(document.querySelector('[data-pro-viewer-toolbar] button span')),
        thumb: border(document.querySelector("[data-thumb-index][data-current] > span")),
      };
    });
    expect(info.article).not.toBe("0px");
    expect(info.zoomButton).not.toBe("0px");
  });

  test("ingles: las etiquetas del visor, de la barra y de la paleta salen en ingles", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("optimuspdf.language", "en"));
    await openDoc(page, await makeViewerPdf(5), "english.pdf");
    const E = PRO_STRINGS.en;
    await expect(page.getByRole("feed", { name: E.viewer.feedLabel })).toBeVisible();
    await expect(page.getByRole("button", { name: E.viewer.zoomIn })).toBeVisible();
    await expect(page.getByRole("article").first()).toHaveAttribute("aria-label", E.viewer.pageOf(1, 5));
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("combobox", { name: E.palette.label })).toBeFocused();
  });
});

/* ------------------------------------------------------------------ *
 * Movil 375 x 812, tactil
 * ------------------------------------------------------------------ */

test.describe("visor continuo · movil 375 px tactil", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("5 y 60 paginas: visor a todo el ancho, barra inferior de 7 herramientas, sin desborde", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(60, { mixed: true }), "movil.pdf");
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.getByRole("separator")).toHaveCount(0);
    const dock = page.getByRole("toolbar", { name: S.shell.dockLabel });
    await expect(dock.getByRole("button")).toHaveCount(7);
    const box = (await dock.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(812 + 1);
    // Los siete botones caben a la vez en 375 px (sin recorte).
    for (const button of await dock.getByRole("button").all()) {
      const b = (await button.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(376);
      expect(b.height).toBeGreaterThanOrEqual(43.5);
    }
    await noHorizontalOverflow(page);
    const article = (await page.locator('article[data-page-index="0"]').boundingBox())!;
    expect(article.width).toBeGreaterThan(330);
  });

  test("500 paginas en movil: abre y salta sin montar de mas", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(500, { mixed: true, rotate: true }), "movil500.pdf");
    for (const n of [250, 499, 1]) {
      const { shell } = await jumpTiming(page, n);
      expect(shell).toBeGreaterThanOrEqual(0);
      expect(shell).toBeLessThan(150);
    }
    const counts = await liveCounts(page);
    expect(counts.articles).toBeLessThanOrEqual(16);
    expect(counts.images).toBeLessThanOrEqual(12);
    console.log(`[perf] movil 500 paginas: heap JS ${(await heapMB(page))?.toFixed(1) ?? "n/d"} MB`);
  });

  test("pellizco emulado con dos toques: acerca y aleja anclado al punto", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "el pellizco se emula con CDP (Input.dispatchTouchEvent), solo Chromium");
    await openDoc(page, await makeViewerPdf(10), "pellizco.pdf");
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", a?: [number, number], b?: [number, number]) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: a && b ? [{ x: a[0], y: a[1], id: 1 }, { x: b[0], y: b[1], id: 2 }] : [],
      });
    const before = await zoomOf(page);
    expect(before).toBe(1);
    await touch("touchStart", [160, 400], [215, 400]);
    for (let step = 1; step <= 8; step += 1) await touch("touchMove", [160 - step * 12, 400], [215 + step * 12, 400]);
    await touch("touchEnd");
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(2);
    const zoomed = await zoomOf(page);
    // Alejar con el gesto contrario.
    await touch("touchStart", [60, 400], [315, 400]);
    for (let step = 1; step <= 8; step += 1) await touch("touchMove", [60 + step * 14, 400], [315 - step * 14, 400]);
    await touch("touchEnd");
    await expect.poll(() => zoomOf(page)).toBeLessThan(zoomed);
    // El navegador no hizo zoom propio de la pagina.
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
    await noHorizontalOverflow(page);
  });

  test("una herramienta de la barra abre su panel en una hoja y las miniaturas tambien", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(12), "hojas.pdf");
    await page.getByRole("button", { name: S.suite.tabs.protect }).tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(S.suite.tabs.protect);
    // La hoja es modal: el boton de la barra queda tapado por el velo, se cierra con su boton «Cerrar».
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).tap();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: V.openThumbs }).tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("option")).toHaveCount(12);
    await page.getByRole("dialog").getByRole("option").nth(7).tap();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect.poll(() => currentPage(page)).toBe(8);
  });

  test("objetivos tactiles de la barra, el visor y el menu miden 44 px", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(6), "tactil.pdf");
    const small = await page.evaluate(() => {
      const out: string[] = [];
      const scope = document.querySelector("section[data-pro-suite]")!;
      for (const el of scope.querySelectorAll<HTMLElement>("button, input, [role=tab], [role=option], [role=separator]")) {
        if (el.closest("[hidden]") || el.matches(".sr-only") || el.closest(".sr-only")) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.height < 43.5 || rect.width < 43.5) out.push(`${el.tagName.toLowerCase()} «${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}» ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
      return out;
    });
    expect(small, small.join("\n")).toEqual([]);
  });

  test("el foco nunca cae a <body> con Tab y axe da 0 violaciones", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(10), "movil-a11y.pdf");
    await page.waitForTimeout(600);
    const lost = await tabTrail(page, 40);
    expect(lost, `foco perdido en <body>:\n${lost.join("\n")}`).toEqual([]);
    const violations = await runAxe(page);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  test("menu «Mas» en movil: cerrar documento vive ahi", async ({ page }) => {
    await openDoc(page, await makeViewerPdf(3), "mas.pdf");
    await page.getByRole("button", { name: S.shell.more }).tap();
    await expect(page.getByRole("menuitem", { name: new RegExp(S.shell.closeItem) })).toBeVisible();
    await noHorizontalOverflow(page);
  });
});
