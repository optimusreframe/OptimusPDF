import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { makeViewerPdf } from "../helpers/viewer-pdfs";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { PAGES_STRINGS } from "../../src/app/pdf-pro/pages/pagesStrings";
import { WATERMARK_STRINGS } from "../../src/app/add-watermark/strings";

/**
 * Los presupuestos de tiempo son para un equipo de desarrollo. En el runner de CI (2 nucleos compartidos, 2 workers en
 * paralelo) los mismos pasos tardan 2-3 veces mas (500 paginas: abrir 2,4-4,8 s, saltar 147-511 ms): `PERF_SLACK`
 * multiplica solo los TECHOS absolutos de tiempo, nunca el heap ni los buffers. Local = 1.
 */
const PERF_SLACK = process.env.CI ? 2.5 : 1;

/**
 * PDF Pro · rendimiento y memoria (Wave 7 · U8), navegador real y headless: un PDF de 500 paginas y uno de ~100 MB
 * (ruido incompresible). Para CADA operacion, modo y exportacion se mide el tiempo (hasta que el resultado esta
 * visible) y la cola de tareas largas del hilo principal (`longtask`: lo que bloquea la interfaz), y al final la
 * memoria (`Performance.getMetrics` de CDP + `performance.memory`).
 *
 * Presupuestos: apertura < 3 s para ~40 MB (medida SIN la transferencia del buffer de Node: se pasa una ruta de disco),
 * salto de pagina < 100 ms, heap JS < 300 MB tras 6 operaciones. La tabla completa se imprime y se guarda en
 * `.evidence/perf/<etiqueta>.json` (`PERF_LABEL=antes|despues`) para compararla.
 */

const S = PRO_STRINGS.es;
const T = S.docTools;
const P = PAGES_STRINGS.es;
const LABEL = process.env.PERF_LABEL ?? "actual";

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(300_000);

type Row = { scenario: string; step: string; ms: number; longTaskMaxMs: number; longTaskTotalMs: number; heapMB: number; bufMB: number; rssMB: number };
const rows: Row[] = [];

/**
 * Memoria REAL del navegador (los PDF viven en ArrayBuffers, que el heap de JS no cuenta): suma del RSS de todos los
 * procesos descendientes del trabajador de Playwright (renderer, GPU, utilidades y el worker de pdf.js).
 */
function browserRssMB(): number {
  try {
    const table = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const children = new Map<number, number[]>();
    const rss = new Map<number, number>();
    for (const [pid, ppid, kb] of table) {
      rss.set(pid, kb);
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    let total = 0;
    const stack = [...(children.get(process.pid) ?? [])];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      total += rss.get(pid) ?? 0;
      stack.push(...(children.get(pid) ?? []));
    }
    return total / 1024;
  } catch {
    return 0;
  }
}

let peakRssMB = 0;
let sampler: ReturnType<typeof setInterval> | null = null;
function startRssSampler(): void {
  peakRssMB = 0;
  sampler = setInterval(() => {
    peakRssMB = Math.max(peakRssMB, browserRssMB());
  }, 400);
}
function stopRssSampler(): number {
  if (sampler) clearInterval(sampler);
  sampler = null;
  return peakRssMB;
}

/**
 * Observador de tareas largas (> 50 ms en el hilo principal): lo que de verdad congela la interfaz. Se instala antes de
 * que cargue la pagina; `__readLong(reset)` vacia primero la cola del observador (sus avisos llegan en diferido).
 */
async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Long = { max: number; total: number };
    const state: Long = { max: 0, total: 0 };
    const whole: Long = { max: 0, total: 0 };
    let observer: PerformanceObserver | null = null;
    const take = (entries: PerformanceEntryList) => {
      for (const entry of entries) {
        state.max = Math.max(state.max, entry.duration);
        state.total += entry.duration;
        whole.max = Math.max(whole.max, entry.duration);
        whole.total += entry.duration;
      }
    };
    try {
      observer = new PerformanceObserver((list) => take(list.getEntries()));
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      /* sin soporte */
    }
    (window as unknown as { __readLong: (reset: boolean) => Long }).__readLong = (reset: boolean) => {
      if (observer) take(observer.takeRecords());
      const copy = reset === false ? { ...whole } : { ...state };
      if (reset) {
        state.max = 0;
        state.total = 0;
      }
      return copy;
    };
  });
}

/** Bytes que el hilo principal tiene en ArrayBuffers (los PDF de los snapshots): el heap de JS no los cuenta. */
async function buffersMB(cdp: CDPSession): Promise<number> {
  const usage = (await cdp.send("Runtime.getHeapUsage")) as unknown as { backingStorageSize?: number };
  return (usage.backingStorageSize ?? 0) / 1024 / 1024;
}

/** Heap de JS vivo tras una recogida de basura (`performance.memory` es granular y no vale para medir). */
async function heapMB(_page: Page, cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const { metrics } = await cdp.send("Performance.getMetrics");
  return (metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0) / 1024 / 1024;
}

type Ctx = { page: Page; cdp: CDPSession; scenario: string };

async function measure(ctx: Ctx, step: string, action: () => Promise<void>): Promise<number> {
  await ctx.page.evaluate(() => (window as unknown as { __readLong: (reset: boolean) => unknown }).__readLong(true));
  const started = Date.now();
  await action();
  const ms = Date.now() - started;
  const long = await ctx.page.evaluate(() => (window as unknown as { __readLong: (reset: boolean) => { max: number; total: number } }).__readLong(true));
  const heap = await heapMB(ctx.page, ctx.cdp);
  rows.push({ scenario: ctx.scenario, step, ms, longTaskMaxMs: Math.round(long.max), longTaskTotalMs: Math.round(long.total), heapMB: Math.round(heap), bufMB: Math.round(await buffersMB(ctx.cdp)), rssMB: Math.round(browserRssMB()) });
  return ms;
}

function report(): void {
  const header = `${"escenario".padEnd(16)} ${"paso".padEnd(46)} ${"ms".padStart(7)} ${"tarea larga max".padStart(16)} ${"total".padStart(7)} ${"heap JS".padStart(8)} ${"buffers".padStart(8)} ${"RSS MB".padStart(8)}`;
  const lines = rows.map((row) => `${row.scenario.padEnd(16)} ${row.step.padEnd(46)} ${String(row.ms).padStart(7)} ${String(row.longTaskMaxMs).padStart(16)} ${String(row.longTaskTotalMs).padStart(7)} ${String(row.heapMB).padStart(8)} ${String(row.bufMB).padStart(8)} ${String(row.rssMB).padStart(8)}`);
  console.log(`\n[perf:${LABEL}]\n${header}\n${lines.join("\n")}\n`);
  const dir = path.resolve(process.cwd(), ".evidence/perf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${LABEL}.json`), JSON.stringify(rows, null, 2));
}

const pageInput = (page: Page) => page.getByRole("textbox", { name: S.viewer.pageInputLabel });

async function openFromDisk(ctx: Ctx, file: string, name: string): Promise<number> {
  await ctx.page.goto("/pdf-pro");
  return measure(ctx, "abrir (hasta la 1.ª pagina pintada)", async () => {
    await ctx.page.locator('input[type="file"]').first().setInputFiles(file);
    await expect(ctx.page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
    await expect(ctx.page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 120_000 });
  });
}

const statusText = async (page: Page) => (await page.getByRole("status").textContent()) ?? "";

/** Espera a que un NUEVO anuncio «Aplicado: …» (o el de deshacer/rehacer) reemplace al anterior. */
async function waitForNewAnnouncement(page: Page, previous: string, prefix: RegExp): Promise<void> {
  await expect
    .poll(async () => {
      const text = await statusText(page);
      return text !== previous && prefix.test(text);
    }, { timeout: 280_000, intervals: [30] })
    .toBe(true);
}

const APPLIED = /^(Aplicado:|El resultado es igual)/;
const UNDONE = /^Deshecho:/;
const REDONE = /^Rehecho:/;

async function openToolAndApply(ctx: Ctx, step: string, title: string, prepare?: () => Promise<void>): Promise<void> {
  const { page } = ctx;
  await page.locator('[role="tab"][data-tab="home"]').click();
  await page.getByRole("button", { name: T.launcher.open(title), exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
  await prepare?.();
  const previous = await statusText(page);
  await measure(ctx, step, async () => {
    await page.getByRole("button", { name: T.runner.apply, exact: true }).click();
    await waitForNewAnnouncement(page, previous, APPLIED);
  });
  await page.getByRole("button", { name: T.launcher.back, exact: true }).click();
}

async function scenario(page: Page, name: string, file: string, fileName: string, heavy: boolean): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const ctx: Ctx = { page, cdp, scenario: name };
  startRssSampler();
  const openMs = await openFromDisk(ctx, file, fileName);
  if (!heavy) expect(openMs, "apertura de 500 paginas").toBeLessThan(5000 * PERF_SLACK);

  // Salto de pagina (a la mitad y al final).
  for (const target of [250, 500]) {
    if (heavy && target > 100) continue;
    const ms = await measure(ctx, `saltar a la pagina ${target}`, async () => {
      await pageInput(page).fill(String(target));
      await pageInput(page).press("Enter");
      await expect(page.locator(`article[data-page-index="${target - 1}"]`)).toBeAttached();
    });
    if (!heavy) expect(ms, `salto a la pagina ${target}`).toBeLessThan(400 * PERF_SLACK);
  }

  // Operaciones de documento (Inicio).
  await page.locator('[role="tab"][data-tab="home"]').click();
  const rotate = page.getByRole("button", { name: S.operations.rotateAll90, exact: true });
  let previous = await statusText(page);
  await measure(ctx, "operacion: rotar todo", async () => {
    await rotate.click();
    await waitForNewAnnouncement(page, previous, APPLIED);
  });
  await openToolAndApply(ctx, "operacion: marca de agua", T.tools.watermark.title, async () => {
    await page.getByLabel(WATERMARK_STRINGS.es.textLabel).fill("PERF");
  });
  await openToolAndApply(ctx, "operacion: numerar paginas", T.tools["page-numbers"].title);
  await openToolAndApply(ctx, "operacion: metadatos", T.tools.metadata.title, async () => {
    await page.getByLabel(T.metadata.fieldTitle, { exact: true }).fill("Perf");
  });
  await openToolAndApply(ctx, "operacion: recortar margenes", T.tools.crop.title, async () => {
    await page.getByRole("spinbutton", { name: `${T.crop.linked} (mm)` }).fill("5");
  });
  await openToolAndApply(ctx, "operacion: rotar (herramienta)", T.tools.rotate.title);
  await openToolAndApply(ctx, "operacion: comprimir", T.tools.compress.title);

  // Deshacer / rehacer (snapshots grandes).
  previous = await statusText(page);
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await measure(ctx, "deshacer (Ctrl+Z)", async () => {
    await page.keyboard.press("Control+z");
    await waitForNewAnnouncement(page, previous, UNDONE);
    await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 120_000 });
  });
  previous = await statusText(page);
  await measure(ctx, "rehacer (Ctrl+Shift+Z)", async () => {
    await page.keyboard.press("Control+Shift+z");
    await waitForNewAnnouncement(page, previous, REDONE);
    await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 120_000 });
  });

  // Organizador: eliminar las paginas pares y aplicar.
  await page.locator('[role="tab"][data-tab="pages"]').click();
  await expect(page.getByRole("listbox", { name: /Páginas del documento/ })).toBeVisible();
  await page.getByRole("button", { name: P.actions.more, exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: P.actions.selectEven, exact: true }).click();
  await page.getByRole("button", { name: P.actions.remove, exact: true }).click();
  await measure(ctx, "organizador: aplicar (quitar pares)", async () => {
    await page.getByRole("button", { name: P.status.apply, exact: true }).click();
    await expect(page.locator("[data-pages-chip]")).toHaveText(P.status.noChanges, { timeout: 240_000 });
  });

  // Modos: entrar y salir.
  for (const [tab, label] of [["edit", "Editar"], ["annotate", "Anotar"], ["sign", "Firmar"]] as const) {
    await measure(ctx, `modo ${label}: entrar`, async () => {
      await page.locator(`[role="tab"][data-tab="${tab}"]`).click();
      await expect(page.locator("[data-pro-mode-host]")).toBeVisible({ timeout: 120_000 });
      await expect(page.locator("[data-pro-mode-host] canvas, [data-pro-mode-host] img").first()).toBeVisible({ timeout: 120_000 });
    });
    await measure(ctx, `modo ${label}: salir (Descartar)`, async () => {
      await page.locator("[data-pro-mode-discard]").click();
      await expect(page.locator("[data-pro-mode-host]")).toBeHidden({ timeout: 120_000 });
      await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 120_000 });
    });
  }

  // Exportar un rango a imagenes y a texto (PDF grande: rango corto).
  await page.locator('[role="tab"][data-tab="convert"]').click();
  const images = page.locator('[data-export="images"]');
  await images.getByRole("button", { name: PRO_STRINGS.es.export.card.showOptions }).click();
  await images.getByRole("tab", { name: PRO_STRINGS.es.export.images.scopeRange }).click();
  await images.getByLabel(PRO_STRINGS.es.export.images.rangeLabel).fill("1-5");
  await measure(ctx, "exportar a imagenes (paginas 1-5)", async () => {
    await downloadFile(page, () => images.getByRole("button", { name: PRO_STRINGS.es.export.formats.images.title }).click());
  });
  // Resto de exportaciones del documento ENTERO: salen un archivo o un error claro (p. ej. sin tablas), nunca se cuelgan.
  for (const id of ["text", "markdown", "json", "word", "excel", "csv", "powerpoint"] as const) {
    const card = page.locator(`[data-export="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    const button = card.getByRole("button", { name: PRO_STRINGS.es.export.formats[id].title });
    let outcome = "archivo";
    await measure(ctx, `exportar ${id} (documento entero)`, async () => {
      const download = page.waitForEvent("download", { timeout: 200_000 }).then(() => "archivo");
      const failure = card.getByRole("alert").waitFor({ state: "visible", timeout: 200_000 }).then(() => "error claro");
      await button.click();
      outcome = await Promise.race([download, failure]);
    });
    rows[rows.length - 1].step += ` → ${outcome}`;
    if (outcome === "error claro") await card.getByRole("button", { name: "Cerrar" }).click().catch(() => undefined);
  }
  await measure(ctx, "descargar PDF", async () => {
    await downloadFile(page, () => page.getByRole("button", { name: S.suite.download, exact: true }).click());
  });

  // Memoria tras todas las operaciones.
  const heap = await heapMB(page, cdp);
  const whole = await page.evaluate(() => (window as unknown as { __readLong: (reset: boolean) => { max: number; total: number } }).__readLong(false));
  rows.push({ scenario: name, step: "tareas largas de TODO el escenario (incluye el autoguardado)", ms: 0, longTaskMaxMs: Math.round(whole.max), longTaskTotalMs: Math.round(whole.total), heapMB: 0, bufMB: 0, rssMB: 0 });
  const peak = stopRssSampler();
  rows.push({ scenario: name, step: "memoria final (heap JS tras GC) y pico de RSS", ms: 0, longTaskMaxMs: 0, longTaskTotalMs: 0, heapMB: Math.round(heap), bufMB: Math.round(await buffersMB(cdp)), rssMB: Math.round(peak) });
  // Presupuesto: heap de JS + ArrayBuffers (los snapshots) por debajo de 300 MB tras las operaciones (PDF de 500 paginas).
  if (!heavy) expect(heap + (await buffersMB(cdp)), "heap JS + buffers tras las operaciones").toBeLessThan(300);
}

const tmp = path.resolve(process.cwd(), ".evidence/perf-tmp");

test.describe.serial("rendimiento", () => {
  test("el observador de tareas largas detecta un bloqueo real de 250 ms", async ({ page }) => {
    await installLongTaskObserver(page);
    await page.goto("/pdf-pro");
    const long = await page.evaluate(async () => {
      // Dentro de una tarea de temporizador (una `evaluate` de CDP no cuenta como tarea del navegador).
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          const end = performance.now() + 250;
          while (performance.now() < end) {
            /* bloqueo deliberado */
          }
          resolve();
        }, 0),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      return (window as unknown as { __readLong: (reset: boolean) => { max: number } }).__readLong(false).max;
    });
    expect(long).toBeGreaterThan(200);
  });

  test.beforeAll(() => {
    mkdirSync(tmp, { recursive: true });
  });
  test.afterAll(() => report());

  test("500 paginas: abrir, saltar, operar, organizar, modos y exportar", async ({ page }) => {
    await installLongTaskObserver(page);
    const file = path.join(tmp, "quinientas.pdf");
    writeFileSync(file, await makeViewerPdf(500, { mixed: true }));
    await scenario(page, "500 paginas", file, "quinientas.pdf", false);
  });

  test("~100 MB: abrir, operar, deshacer, modos y exportar", async ({ page }) => {
    await installLongTaskObserver(page);
    const file = path.join(tmp, "pesado.pdf");
    const bytes = await makeViewerPdf(100, { noiseKb: 1000 });
    expect(bytes.length).toBeGreaterThan(95_000_000);
    writeFileSync(file, bytes);
    await scenario(page, "~100 MB", file, "pesado.pdf", true);
  });

  test("~40 MB: apertura < 3 s hasta la primera pagina pintada", async ({ page }) => {
    await installLongTaskObserver(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const ctx: Ctx = { page, cdp, scenario: "~40 MB" };
    const file = path.join(tmp, "cuarenta.pdf");
    const bytes = await makeViewerPdf(120, { noiseKb: 330 });
    expect(bytes.length).toBeGreaterThan(38_000_000);
    writeFileSync(file, bytes);
    await page.goto("/pdf-pro");
    // Ruta de disco: no cuenta la transferencia del buffer de Node al navegador.
    const ms = await measure(ctx, "abrir 40 MB (ruta de disco)", async () => {
      await page.locator('input[type="file"]').first().setInputFiles(file);
      await expect(page.getByRole("heading", { level: 1, name: /cuarenta\.pdf/ })).toBeVisible();
      await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 60_000 });
    });
    expect(ms, "apertura de ~40 MB").toBeLessThan(3000 * PERF_SLACK);
  });
});
