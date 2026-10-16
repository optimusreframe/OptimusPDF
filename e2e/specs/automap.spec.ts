import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

/**
 * Automapeo (U2.8) en un NAVEGADOR REAL y headless: el motor de produccion (`autoMapFile`: pdf.js con su worker, el
 * mismo que usa la app), contratos sinteticos generados DENTRO de la pagina y metricas contra su verdad de terreno.
 * Mide lo que Vitest/Node no puede: el tiempo real de un documento de 9 paginas y que el hilo principal no se bloquea.
 *
 * PATRON (igual que `ink-extract.spec.ts`; sin pagina de pruebas en el producto): `e2e/helpers/automap-entry.ts` se
 * empaqueta con Vite (IIFE, en memoria) y se inyecta en `/privacy` con su CSP real. Los PDFs no salen de la pagina.
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad`.
 */

test.setTimeout(180_000);

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
      lib: { entry: path.resolve(process.cwd(), "e2e/helpers/automap-entry.ts"), name: "AutoMapLab", formats: ["iife"], fileName: () => "automap.js" },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el automapeo");
  bundleCode = chunk.code;
});

/** Utilidades que viven en la pagina. */
const LAB = String.raw`
(() => {
  const L = window.AutoMapLab;
  const corpus = L.syntheticCorpus();
  const find = (name) => corpus.find((e) => e.doc.name === name).doc;

  /** Un contrato de 9 paginas: el de iniciales repetidas (7) mas dos paginas de cuerpo. */
  function nine() {
    const doc = find("corner-repeat-2");
    return { ...doc, pages: [...doc.pages.slice(0, 6), doc.pages[1], doc.pages[2], doc.pages[6]] };
  }

  function heartbeat() {
    let last = performance.now(); let maxGap = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
    const longTasks = [];
    let observer = null;
    try { observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); }); observer.observe({ type: "longtask", buffered: false }); } catch { observer = null; }
    return { stop() { clearInterval(timer); if (observer) observer.disconnect(); return { maxGap, longTasks }; } };
  }

  async function run(doc, variant) {
    const rendered = await L.renderSynthetic(doc, variant);
    const file = new File([rendered.bytes], "contrato.pdf", { type: "application/pdf" });
    const beat = heartbeat();
    const t0 = performance.now();
    const result = await L.autoMapFile(file, { signers: doc.signers, locale: "es" });
    const ms = performance.now() - t0;
    const beats = beat.stop();
    const metrics = L.evaluateAutoMap(result.fields, { images: rendered.truth, texts: [] }, { tiers: ["high", "review"], signers: doc.signers });
    return { ms, ...beats, pages: doc.pages.length, high: result.confidenceSummary.high, review: result.confidenceSummary.review, maxPerPage: result.confidenceSummary.maxPerPage, warnings: result.warnings.map((w) => w.code), metrics };
  }

  window.__lab = {
    nineMeasured: () => run(nine()),
    variant: (name, id) => run(find(name), L.SCALE_VARIANTS.find((v) => v.id === id).options),
    decoys: async () => {
      const doc = find("decoys");
      const rendered = await L.renderSynthetic(doc);
      const result = await L.autoMapFile(new File([rendered.bytes], "d.pdf", { type: "application/pdf" }), { signers: 2 });
      return result.fields.filter((f) => f.tier === "high" && (f.type === "initials" || f.type === "signature")).length;
    },
    aborted: async () => {
      const rendered = await L.renderSynthetic(nine());
      const controller = new AbortController();
      const promise = L.autoMapFile(new File([rendered.bytes], "a.pdf", { type: "application/pdf" }), { signers: 2 }, controller.signal);
      controller.abort();
      try { await promise; return "sin error"; } catch (e) { return e.name; }
    },
    /** Pagina escaneada de verdad: una imagen PNG con una raya negra, renderizada por el motor por su rasterizador por defecto. */
    /** Un PDF dado (base64): tiempo, tareas largas y conteos. Los bytes llegan desde Node; no se guardan ni se envian a ningun lado. */
    realFile: async (base64, signers) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const beat = heartbeat();
      const t0 = performance.now();
      const result = await L.autoMapFile(new File([bytes], "c.pdf", { type: "application/pdf" }), { signers });
      const ms = performance.now() - t0;
      const beats = beat.stop();
      return { ms, ...beats, pages: result.pages.length, high: result.confidenceSummary.high, review: result.confidenceSummary.review, maxPerPage: result.confidenceSummary.maxPerPage };
    },
    scanned: async () => {
      const canvas = new OffscreenCanvas(612, 792);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 612, 792);
      ctx.fillStyle = "#000"; ctx.fillRect(61, 554, 306, 2);
      const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      const doc = await L.PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 612, height: 792 });
      const bytes = await doc.save();
      const result = await L.autoMapFile(new File([bytes], "scan.pdf", { type: "application/pdf" }), { signers: 2 });
      return { fields: result.fields.map((f) => ({ type: f.type, tier: f.tier, confidence: f.confidence, source: f.source, y: f.rect.y + f.rect.height })), scanned: result.pages[0].scanned === true, warnings: result.warnings.map((w) => w.code) };
    },
  };
})();
`;

async function openLab(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.log("[automap] pageerror:", error.message));
  page.on("console", (message) => (message.type() === "error" ? console.log("[automap] console.error:", message.text().slice(0, 300)) : undefined));
  await page.goto("/privacy");
  await page.addScriptTag({ content: bundleCode });
  await page.addScriptTag({ content: LAB });
}

type Run = {
  ms: number;
  maxGap: number;
  longTasks: number[];
  pages: number;
  high: number;
  review: number;
  maxPerPage: number;
  warnings: string[];
  metrics: {
    initials: { total: number; recall: number };
    signature: { total: number; recall: number };
    highPrecision: { proposals: number; precision: number };
    initialsOrder: { checked: number; ok: number };
    perPage: { max: number };
  };
};

test.describe("automapeo en navegador real (headless)", () => {
  test("un contrato de 9 paginas: <= 2 s, sin tareas largas > 100 ms y con la calidad medida", async ({ page, browserName }) => {
    await openLab(page);
    // Primera corrida: arranca el worker de pdf.js y calienta; la medida es la segunda.
    await page.evaluate("window.__lab.nineMeasured()");
    const out = (await page.evaluate("window.__lab.nineMeasured()")) as Run;
    console.log(
      `[automap] ${browserName}: ${out.pages} paginas en ${out.ms.toFixed(0)} ms; mayor tarea larga ${out.longTasks.length ? Math.max(...out.longTasks).toFixed(0) : 0} ms; mayor hueco entre latidos ${out.maxGap.toFixed(0)} ms; ` +
        `high ${out.high}, review ${out.review}, max/pagina ${out.maxPerPage}; recall iniciales ${out.metrics.initials.recall.toFixed(2)}, firmas ${out.metrics.signature.recall.toFixed(2)}, precision high ${out.metrics.highPrecision.precision.toFixed(2)}`,
    );
    expect(out.pages).toBe(9);
    expect(out.ms).toBeLessThan(2000);
    for (const duration of out.longTasks) expect(duration).toBeLessThan(100);
    expect(out.maxGap).toBeLessThan(150);
    expect(out.metrics.initials.recall).toBeGreaterThanOrEqual(0.9);
    expect(out.metrics.signature.recall).toBeGreaterThanOrEqual(0.9);
    expect(out.metrics.highPrecision.precision).toBeGreaterThanOrEqual(0.9);
    expect(out.metrics.initialsOrder.ok).toBe(out.metrics.initialsOrder.checked);
    expect(out.maxPerPage).toBeLessThanOrEqual(12);
    expect(out.warnings).not.toContain("page-skipped");
  });

  test("otros tamanos de papel y paginas giradas dan el mismo resultado en el navegador", async ({ page }) => {
    await openLab(page);
    for (const variant of ["a4", "small-459x594", "rot90", "rot270"]) {
      const out = (await page.evaluate(`window.__lab.variant("labelled-initials-2", ${JSON.stringify(variant)})`)) as Run;
      expect(out.metrics.initials.recall, variant).toBeGreaterThanOrEqual(0.9);
      expect(out.metrics.signature.recall, variant).toBeGreaterThanOrEqual(0.9);
      expect(out.metrics.highPrecision.precision, variant).toBeGreaterThanOrEqual(0.9);
      expect(out.metrics.initialsOrder.ok, variant).toBe(out.metrics.initialsOrder.checked);
    }
  });

  test("los senuelos (subrayados decorativos, tablas, prosa) no dan iniciales ni firmas de nivel high", async ({ page }) => {
    await openLab(page);
    expect(await page.evaluate("window.__lab.decoys()")).toBe(0);
  });

  test("se puede cancelar", async ({ page }) => {
    await openLab(page);
    expect(await page.evaluate("window.__lab.aborted()")).toBe("AbortError");
  });

  test("pagina escaneada: renderiza por el rasterizador por defecto y propone solo la raya larga, con confianza baja", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.scanned()")) as { fields: Array<{ type: string; tier: string; confidence: number; source: string; y: number }>; scanned: boolean; warnings: string[] };
    expect(out.scanned).toBe(true);
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]).toMatchObject({ type: "signature", tier: "review", source: "geometry" });
    expect(out.fields[0].confidence).toBeLessThan(0.5);
    expect(out.fields[0].y).toBeCloseTo(0.7, 1);
  });

  // Opcional y local: contratos reales de una carpeta (`OPTIMUS_REAL_CONTRACTS_DIR`); solo mide tiempo y conteos.
  const realDir = process.env.OPTIMUS_REAL_CONTRACTS_DIR;
  test("contratos reales (opcional): cada uno, <= 2 s y sin tareas largas > 100 ms", async ({ page, browserName }) => {
    test.skip(!realDir || !fs.existsSync(realDir), "sin OPTIMUS_REAL_CONTRACTS_DIR");
    await openLab(page);
    const files = fs.readdirSync(realDir as string).filter((name) => /\.pdf$/i.test(name) && !/-signed\.pdf$/i.test(name)).sort();
    for (const name of files) {
      const base64 = fs.readFileSync(path.join(realDir as string, name)).toString("base64");
      await page.evaluate(`window.__lab.realFile(${JSON.stringify(base64)}, 2)`); // calentamiento (worker y fuentes)
      const out = (await page.evaluate(`window.__lab.realFile(${JSON.stringify(base64)}, 2)`)) as { ms: number; longTasks: number[]; maxGap: number; pages: number; high: number; review: number; maxPerPage: number };
      console.log(`[automap] real ${name.slice(0, 8)} ${browserName}: ${out.pages} pag en ${out.ms.toFixed(0)} ms; tarea larga max ${out.longTasks.length ? Math.max(...out.longTasks).toFixed(0) : 0} ms; hueco max ${out.maxGap.toFixed(0)} ms; high ${out.high} review ${out.review} max/pag ${out.maxPerPage}`);
      expect(out.ms).toBeLessThan(2000);
      for (const duration of out.longTasks) expect(duration).toBeLessThan(100);
      expect(out.maxPerPage).toBeLessThanOrEqual(12);
    }
  });
});
