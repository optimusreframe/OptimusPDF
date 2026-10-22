import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import { TARGETS, evaluateRuns, type FixtureRun } from "../../src/lib/pdf/extractAssets/__fixtures__/annots/evaluate";
import type { AnnotFixture } from "../../src/lib/pdf/extractAssets/__fixtures__/annots/generate";

/**
 * Motor de anotaciones, sellos, /Sig, marcas de agua y capas de «Extraer elementos» (U7.2) en un NAVEGADOR REAL y headless:
 * el motor de produccion (`findAnnotationAssets` y `renderAnnotationAsset`: pdf.js con su worker y canvas de verdad), el corpus
 * sintetico (pdf-lib, generado DENTRO de la pagina) y las metricas contra su verdad. Mide lo que Vitest/Node no puede: el render
 * real de anotaciones con fondo transparente, `CompressionStream`, el tiempo, las tareas largas y que no sale NINGUNA peticion.
 *
 * PATRON (igual que `automap.spec.ts`; sin pagina de pruebas en el producto): `__fixtures__/annots/browserEntry.ts` se empaqueta
 * con Vite (IIFE, en memoria) y se inyecta en `/privacy` con su CSP real. Los PDF no salen de la pagina.
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad`.
 */

test.setTimeout(240_000);

/** El CI de GitHub es ~2,5 veces mas lento que un equipo local. */
const SLACK = process.env.CI ? 2.5 : 1;

let bundleCode = "";

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
    // `core.ts` lee `process.env.NEXT_PUBLIC_PDFJS_VERSION` (Next lo sustituye al compilar; aqui lo fijamos).
    define: { "process.env.NEXT_PUBLIC_PDFJS_VERSION": JSON.stringify("0"), "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: path.resolve(process.cwd(), "src/lib/pdf/extractAssets/__fixtures__/annots/browserEntry.ts"), name: "AnnotLab", formats: ["iife"], fileName: () => "annots.js" },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el motor de anotaciones");
  bundleCode = chunk.code;
});

/** Utilidades que viven en la pagina. */
const LAB = String.raw`
(() => {
  const L = window.AnnotLab;
  let corpusPromise = null;
  const corpus = () => (corpusPromise ??= L.buildAnnotCorpus());

  function heartbeat() {
    let last = performance.now(); let maxGap = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
    const longTasks = [];
    let observer = null;
    try { observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); }); observer.observe({ type: "longtask", buffered: false }); } catch { observer = null; }
    return { stop() { clearInterval(timer); if (observer) observer.disconnect(); return { maxGap, longTasks }; } };
  }

  async function decode(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let visible = 0; let r = 0; let g = 0; let b = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i + 3] > 60) { visible += 1; r += data[i]; g += data[i + 1]; b += data[i + 2]; } }
    let clear = 0; for (let i = 3; i < data.length; i += 4) if (data[i] === 0) clear += 1;
    return { width: bitmap.width, height: bitmap.height, corner: data[3], clearRatio: clear / (data.length / 4), visible, mean: visible ? [r / visible, g / visible, b / visible] : [0, 0, 0] };
  }

  async function summarize(asset) {
    let thumb = null;
    if (asset.thumb) { const d = await decode(asset.thumb); thumb = { size: asset.thumb.size, type: asset.thumb.type, width: d.width, height: d.height }; }
    return { ...asset, thumb };
  }

  async function runOne(fx, ctx) {
    const doc = await L.openPdfDocument(fx.bytes);
    try { return await L.findAnnotationAssets(doc, { bytes: fx.bytes, ...(ctx || {}) }); } finally { await L.closePdfDocument(doc); }
  }

  window.__lab = {
    corpusRuns: async () => {
      const runs = [];
      for (const fx of await corpus()) {
        const result = await runOne(fx);
        runs.push({
          name: fx.name, description: fx.description, truth: fx.truth,
          digitalSignaturePages: fx.digitalSignaturePages, translucentImagePages: fx.translucentImagePages,
          assets: await Promise.all(result.assets.map(summarize)), warnings: result.warnings,
          translucentPages: result.translucentImages ? result.translucentImages.map((c) => c.pageIndex) : undefined,
        });
      }
      return runs;
    },
    /** Regenera cada elemento del corpus en todos sus formatos con el PDF como Uint8Array (el motor abre y cierra su documento). */
    renders: async () => {
      const out = [];
      for (const fx of await corpus()) {
        const result = await runOne(fx);
        for (const asset of result.assets) {
          for (const format of asset.formats) {
            let blob;
            try { blob = await L.renderAnnotationAsset(fx.bytes, asset, format); } catch (e) { out.push({ fixture: fx.name, id: asset.id, source: asset.source, kind: asset.kind, format, error: e.code || e.message }); continue; }
            if (format === "png") out.push({ fixture: fx.name, id: asset.id, source: asset.source, kind: asset.kind, format, type: blob.type, ...(await decode(blob)), expectedWidth: asset.pixel ? asset.pixel.width : null });
            else out.push({ fixture: fx.name, id: asset.id, source: asset.source, kind: asset.kind, format, type: blob.type, text: (await blob.text()).slice(0, 300) });
          }
        }
      }
      return out;
    },
    busy: async (pages) => {
      const fx = await L.makeBusyDocument(pages);
      await runOne(fx); // calentamiento: worker de pdf.js y fuentes
      const beat = heartbeat();
      const t0 = performance.now();
      const result = await runOne(fx);
      const ms = performance.now() - t0;
      const beats = beat.stop();
      return { ms, ...beats, assets: result.assets.length, warnings: result.warnings.map((w) => w.code), truth: fx.truth, summary: result.assets.map((a) => ({ id: a.id, kind: a.kind, source: a.source, confidence: a.confidence, reasons: a.reasons, occurrences: a.occurrences, formats: a.formats, pixel: a.pixel, ref: a.ref })), warningsFull: result.warnings };
    },
    cancel: async () => {
      const fx = await L.makeBusyDocument(20);
      await runOne(fx); // calentamiento
      const controller = new AbortController();
      const t0 = performance.now();
      const promise = runOne(fx, { options: { signal: controller.signal, onProgress: (p) => { if (p.pageIndex === 2) controller.abort(); } } });
      try { await promise; return { error: "sin error", ms: performance.now() - t0 }; } catch (e) { return { error: e.code || e.name, ms: performance.now() - t0 }; }
    },
    renderCancel: async () => {
      const fx = (await corpus()).find((f) => f.name === "sig-widgets");
      const result = await runOne(fx);
      const controller = new AbortController();
      controller.abort();
      try { await L.renderAnnotationAsset(fx.bytes, result.assets[0], "png", { options: { signal: controller.signal } }); return "sin error"; } catch (e) { return e.code || e.name; }
    },
  };
})();
`;

async function openLab(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.log("[annots] pageerror:", error.message));
  page.on("console", (message) => (message.type() === "error" ? console.log("[annots] console.error:", message.text().slice(0, 300)) : undefined));
  await page.goto("/privacy");
  await page.addScriptTag({ content: bundleCode });
  await page.addScriptTag({ content: LAB });
}

type RunJson = {
  name: string;
  description: string;
  truth: AnnotFixture["truth"];
  digitalSignaturePages?: number[];
  translucentImagePages?: number[];
  assets: Array<Omit<FixtureRun["assets"][number], "thumb"> & { thumb: { size: number; type: string; width: number; height: number } | null }>;
  warnings: FixtureRun["warnings"];
  translucentPages?: number[];
};

test.describe("anotaciones, sellos, /Sig y marcas de agua en navegador real (headless)", () => {
  test("las metricas del corpus sintetico cumplen los objetivos del plan en el motor real", async ({ page, browserName }) => {
    await openLab(page);
    const runs = (await page.evaluate("window.__lab.corpusRuns()")) as RunJson[];
    expect(runs.length).toBeGreaterThanOrEqual(18);
    const evaluation = evaluateRuns(
      runs.map((run) => ({
        fixture: { name: run.name, description: run.description, bytes: new Uint8Array(), truth: run.truth, digitalSignaturePages: run.digitalSignaturePages, translucentImagePages: run.translucentImagePages },
        assets: run.assets as unknown as FixtureRun["assets"],
        warnings: run.warnings,
        translucentPages: run.translucentPages,
      })),
    );
    console.log(`[annots] ${browserName}: ` + Object.values(evaluation.perClass).map((m) => `${m.cls} P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)}`).join(" | "));
    expect(evaluation.problems, evaluation.problems.join("\n")).toEqual([]);
    for (const [cls, target] of Object.entries(TARGETS)) {
      const metrics = evaluation.perClass[cls as keyof typeof TARGETS];
      expect(metrics.precision, `precision ${cls}`).toBeGreaterThanOrEqual(target.precision);
      expect(metrics.recall, `recall ${cls}`).toBeGreaterThanOrEqual(target.recall);
    }
    // Miniaturas: PNG de hasta 256 px.
    for (const run of runs) {
      for (const asset of run.assets) {
        if (!asset.thumb) continue;
        expect(asset.thumb.type, `${run.name}/${asset.id}`).toBe("image/png");
        expect(Math.max(asset.thumb.width, asset.thumb.height), `${run.name}/${asset.id}`).toBeLessThanOrEqual(256);
      }
    }
  });

  test("regenerar PNG, SVG y TXT bajo demanda: PNG transparente con tinta, SVG con trazos y TXT exacto", async ({ page }) => {
    await openLab(page);
    const renders = (await page.evaluate("window.__lab.renders()")) as Array<{
      fixture: string; id: string; source: string; kind: string; format: string; type: string; error?: string;
      width?: number; height?: number; corner?: number; clearRatio?: number; visible?: number; mean?: number[]; expectedWidth?: number | null; text?: string;
    }>;
    expect(renders.length).toBeGreaterThan(30);
    expect(renders.filter((r) => r.error)).toEqual([]);
    for (const render of renders) {
      const label = `${render.fixture}/${render.source}/${render.format}`;
      if (render.format === "png") {
        expect(render.type, label).toBe("image/png");
        expect(render.clearRatio, `${label}: fondo transparente`).toBeGreaterThan(0.4);
        expect(render.visible, `${label}: con tinta`).toBeGreaterThan(100);
        // El PNG se regenera a la escala de exportacion: mide lo que prometio `pixel` (con la tolerancia del redondeo de pdf.js).
        if (render.expectedWidth && render.source !== "text") expect(Math.abs((render.width ?? 0) - render.expectedWidth), label).toBeLessThanOrEqual(Math.max(24, render.expectedWidth * 0.1));
      } else if (render.format === "svg") {
        expect(render.type, label).toContain("image/svg+xml");
        expect(render.text, label).toMatch(/^<svg /);
      } else if (render.format === "txt") {
        expect(render.type, label).toContain("text/plain");
        expect(render.text?.length, label).toBeGreaterThan(2);
      }
    }
    const ink = renders.find((r) => r.fixture === "ink-multi" && r.format === "svg");
    expect(ink?.text).toContain('stroke="#0d1ab2"');
    const text = renders.find((r) => r.fixture === "text-watermark-6" && r.format === "txt");
    expect(text?.text).toBe("USO INTERNO\n");
  });

  test("20 paginas con anotaciones: rapido, sin tareas largas > 100 ms y sin perder elementos", async ({ page, browserName }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.busy(20)")) as { ms: number; maxGap: number; longTasks: number[]; assets: number; warnings: string[]; truth: AnnotFixture["truth"]; summary: unknown[]; warningsFull: unknown[] };
    console.log(`[annots] ${browserName}: 20 paginas, ${out.assets} elementos en ${out.ms.toFixed(0)} ms; mayor tarea larga ${out.longTasks.length ? Math.max(...out.longTasks).toFixed(0) : 0} ms; mayor hueco entre latidos ${out.maxGap.toFixed(0)} ms`);
    expect(out.assets).toBe(45);
    expect(out.ms).toBeLessThan(4000 * SLACK);
    for (const duration of out.longTasks) expect(duration).toBeLessThan(100 * SLACK);
    expect(out.maxGap).toBeLessThan(150 * SLACK);
    const evaluation = evaluateRuns([
      {
        fixture: { name: "busy-20", description: "", bytes: new Uint8Array(), truth: out.truth },
        assets: out.summary as unknown as FixtureRun["assets"],
        warnings: out.warningsFull as FixtureRun["warnings"],
      },
    ]);
    expect(evaluation.problems).toEqual([]);
  });

  test("no sale ninguna peticion de red ajena a la propia aplicacion", async ({ page, baseURL }) => {
    await openLab(page);
    const requests: Array<{ url: string; method: string }> = [];
    page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
    await page.evaluate("window.__lab.corpusRuns().then(() => window.__lab.renders())");
    const origin = new URL(baseURL ?? "http://localhost").origin;
    const foreign = requests.filter((request) => !request.url.startsWith(origin) && !request.url.startsWith("blob:") && !request.url.startsWith("data:"));
    expect(foreign).toEqual([]);
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  test("se puede cancelar a mitad de camino y al regenerar", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.cancel()")) as { error: string; ms: number };
    expect(out.error).toBe("cancelled");
    expect(out.ms).toBeLessThan(3000 * SLACK);
    expect(await page.evaluate("window.__lab.renderCancel()")).toBe("cancelled");
  });
});
