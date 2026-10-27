import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

/**
 * Extraer elementos · motor de IMAGENES INCRUSTADAS (U7.1) y decodificadores WASM de pdf.js (U7.0) en un NAVEGADOR REAL
 * y headless: el motor de produccion (`findImageAssets` / `renderImageAsset`, con pdf.js, su worker y `/pdfjs-wasm/`),
 * el corpus sintetico generado DENTRO de la pagina y las metricas contra su verdad.
 *
 * Mide lo que Vitest/Node no puede: que en un navegador pdf.js entrega `ImageBitmap` (no pixeles), que JPX y JBIG2 se
 * decodifican con los WASM servidos (sin ninguna peticion externa), el tiempo real de 20 paginas con 30 imagenes, las
 * tareas largas del hilo principal y el pico de memoria.
 *
 * PATRON (igual que `automap.spec.ts`; sin pagina de pruebas en el producto): `e2e/helpers/extract-images-entry.ts` se
 * empaqueta con Vite (IIFE, en memoria) y se inyecta en `/privacy` con su CSP real.
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad`.
 */

test.setTimeout(240_000);

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
      lib: { entry: path.resolve(process.cwd(), "e2e/helpers/extract-images-entry.ts"), name: "ExtractImagesLab", formats: ["iife"], fileName: () => "extract-images.js" },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el motor de imagenes");
  bundleCode = chunk.code;
});

const LAB = String.raw`
(() => {
  const L = window.ExtractImagesLab;
  let corpusPromise = null;
  const corpus = () => (corpusPromise ??= L.buildImagesCorpus());
  const entryOf = async (name) => (await corpus()).find((e) => e.name === name);

  function heartbeat() {
    let last = performance.now(); let maxGap = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
    const longTasks = [];
    let observer = null;
    try { observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); }); observer.observe({ type: "longtask", buffered: false }); } catch { observer = null; }
    return { stop() { clearInterval(timer); if (observer) observer.disconnect(); return { maxGap, longTasks }; } };
  }

  async function pixelsOf(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, data };
  }

  async function sha(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Sintetico a escala: N paginas con M imagenes distintas en total (todo DeviceRGB sin comprimir en memoria). */
  async function scaleDoc(pages, images, side, sideY) {
    const h = sideY || side;
    const doc = await L.PDFDocument.create();
    const ctx = doc.context;
    const pageObjs = [];
    for (let p = 0; p < pages; p += 1) pageObjs.push(doc.addPage([612, 792]));
    for (let i = 0; i < images; i += 1) {
      const data = new Uint8Array(side * h * 3);
      for (let y = 0; y < h; y += 1) for (let x = 0; x < side; x += 1) { const o = (y * side + x) * 3; data[o] = ((x >> 4) * 5 + i * 31) & 255; data[o + 1] = ((y >> 4) * 7 + i * 17) & 255; data[o + 2] = ((x + y) >> 5) + i * 53 & 255; }
      const ref = ctx.register(ctx.flateStream(data, { Type: "XObject", Subtype: "Image", Width: side, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
      const page = pageObjs[i % pages];
      page.node.setXObject(L.PDFName.of("Im" + i), ref);
      const content = "q 120 0 0 120 " + (40 + (i % 4) * 130) + " " + (600 - Math.floor(i / pages) * 130) + " cm /Im" + i + " Do Q\n";
      page.node.addContentStream(ctx.register(ctx.flateStream(new TextEncoder().encode(content))));
    }
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  }

  window.__lab = {
    names: async () => (await corpus()).map((e) => e.name),
    makeScale: async (pages, images, side, sideY) => { window.__bytes = await scaleDoc(pages, images, side, sideY); return window.__bytes.length; },
    /** Corpus entero (menos lo que se pida omitir) por el motor de produccion: metricas contra la verdad. */
    runCorpus: async (skip) => {
      const out = [];
      for (const entry of await corpus()) {
        if (skip.includes(entry.name)) continue;
        const doc = await L.openPdfDocument(entry.bytes);
        try {
          const result = await L.findImageAssets(doc, { bytes: entry.bytes });
          out.push({ name: entry.name, metrics: L.evaluateImages(result, entry.truth), assets: result.assets.length, warnings: result.warnings.map((w) => w.code), thumbs: result.assets.every((a) => !a.thumb || (a.thumb.type === "image/png" && a.thumb.size > 0)) });
        } finally { await L.closePdfDocument(doc); }
      }
      return out;
    },
    /** Pixeles regenerados bajo demanda contra la verdad exacta (con tolerancia solo bajo alfa parcial: el canvas es premultiplicado). */
    exactPixels: async (name) => {
      const entry = await entryOf(name);
      const doc = await L.openPdfDocument(entry.bytes);
      const report = [];
      try {
        const result = await L.findImageAssets(doc, { bytes: entry.bytes });
        for (const px of entry.pixels) {
          const truth = entry.truth.images.find((i) => i.id === px.imageId);
          const asset = result.assets.find((a) => a.pixel && a.pixel.width === truth.width && a.pixel.height === truth.height && a.occurrences[0].pageIndex === truth.occurrences[0].pageIndex && Math.abs(a.occurrences[0].rect.x - truth.occurrences[0].rect.x) < 0.01 && Math.abs(a.occurrences[0].rect.y - truth.occurrences[0].rect.y) < 0.01);
          if (!asset) { report.push({ id: px.imageId, error: "sin elemento" }); continue; }
          const blob = await L.renderImageAsset(doc, asset, "png");
          const got = await pixelsOf(blob);
          let exact = 0, tolerated = 0, bad = 0, worstColor = 0, worstAlpha = 0;
          for (let y = 0; y < got.height; y += 1) for (let x = 0; x < got.width; x += 1) {
            const e = px.at(x, y); const i = (y * got.width + x) * 4;
            const dA = Math.abs(got.data[i + 3] - e[3]);
            const dC = Math.max(Math.abs(got.data[i] - e[0]), Math.abs(got.data[i + 1] - e[1]), Math.abs(got.data[i + 2] - e[2]));
            worstAlpha = Math.max(worstAlpha, dA);
            if (e[3] === 255 && got.data[i + 3] === 255) { if (dC === 0) exact += 1; else { bad += 1; worstColor = Math.max(worstColor, dC); } }
            else if (e[3] === 0) { if (got.data[i + 3] <= 1) tolerated += 1; else bad += 1; }
            else { if (dA <= 1 && (e[3] < 128 || dC <= 6)) tolerated += 1; else { bad += 1; worstColor = Math.max(worstColor, dC); } if (e[3] >= 128) worstColor = Math.max(worstColor, dC); }
          }
          report.push({ id: px.imageId, size: [got.width, got.height], exact, tolerated, bad, worstColor, worstAlpha, mime: blob.type });
        }
      } finally { await L.closePdfDocument(doc); }
      return report;
    },
    /** El JPEG original sale con los mismos bytes que se incrustaron. */
    jpegOriginal: async () => {
      const entry = await entryOf("jpeg");
      const doc = await L.openPdfDocument(entry.bytes);
      try {
        const result = await L.findImageAssets(doc, { bytes: entry.bytes });
        const out = [];
        for (const [id, expected] of Object.entries(entry.jpegBytes)) {
          const truth = entry.truth.images.find((i) => i.id === id);
          const asset = result.assets.find((a) => a.pixel.width === truth.width && a.pixel.height === truth.height);
          const blob = await L.renderImageAsset(doc, asset, "jpg-original", { bytes: entry.bytes });
          const got = new Uint8Array(await blob.arrayBuffer());
          out.push({ id, type: blob.type, same: (await sha(got)) === (await sha(expected)), size: got.length, formats: asset.formats });
        }
        const cmyk = result.assets.find((a) => a.pixel.width === 32);
        return { out, cmykFormats: cmyk.formats };
      } finally { await L.closePdfDocument(doc); }
    },
    /** jpg recomprimido de un PNG opaco 96 x 64: cabecera, medidas y color medio contra la verdad. */
    recompressed: async () => {
      const entry = await entryOf("png-opaque");
      const doc = await L.openPdfDocument(entry.bytes);
      try {
        const asset = (await L.findImageAssets(doc, { bytes: entry.bytes })).assets[0];
        const blob = await L.renderImageAsset(doc, asset, "jpg");
        const got = await pixelsOf(blob);
        const head = [...new Uint8Array(await blob.slice(0, 3).arrayBuffer())];
        const mean = [0, 0, 0], expected = [0, 0, 0];
        const px = entry.pixels[0];
        for (let y = 0; y < got.height; y += 1) for (let x = 0; x < got.width; x += 1) { const i = (y * got.width + x) * 4; const e = px.at(x, y); for (let c = 0; c < 3; c += 1) { mean[c] += got.data[i + c]; expected[c] += e[c]; } }
        const n = got.width * got.height;
        return { type: blob.type, size: [got.width, got.height], meanOpaque: mean.map((v) => v / n), expectedOpaque: expected.map((v) => v / n), cornerAlpha: got.data[3], head };
      } finally { await L.closePdfDocument(doc); }
    },
    /** Solo con un archivo/bytes (sin abrir antes): renderImageAsset abre y cierra por su cuenta. */
    renderFromBytes: async () => {
      const entry = await entryOf("png-alpha");
      const doc = await L.openPdfDocument(entry.bytes);
      let asset;
      try { asset = (await L.findImageAssets(doc, { bytes: entry.bytes })).assets[0]; } finally { await L.closePdfDocument(doc); }
      const png = await L.renderImageAsset(new File([entry.bytes], "x.pdf", { type: "application/pdf" }), asset, "png");
      const jpg = await L.renderImageAsset(new Uint8Array(entry.bytes), asset, "png");
      return { sizePng: png.size, sameSize: png.size === jpg.size, type: png.type };
    },
    /** Limite de megapixeles muy bajo: el PNG se omite con aviso y el JPEG solo ofrece el original. */
    tooLarge: async () => {
      const out = {};
      for (const name of ["png-opaque", "jpeg"]) {
        const entry = await entryOf(name);
        const doc = await L.openPdfDocument(entry.bytes);
        try {
          const result = await L.findImageAssets(doc, { bytes: entry.bytes, maxMegapixels: 0.003 });
          out[name] = { assets: result.assets.map((a) => ({ px: [a.pixel.width, a.pixel.height], formats: a.formats, thumb: !!a.thumb, reasons: a.reasons })), warnings: result.warnings.map((w) => w.code) };
        } finally { await L.closePdfDocument(doc); }
      }
      return out;
    },
    cancel: async () => {
      const entry = await entryOf("mosaic-200");
      const doc = await L.openPdfDocument(entry.bytes);
      try {
        const controller = new AbortController();
        const promise = L.findImageAssets(doc, { options: { signal: controller.signal } });
        controller.abort();
        try { await promise; return "sin error"; } catch (error) { return error.name; }
      } finally { await L.closePdfDocument(doc); }
    },
    /** 20 paginas con 30 imagenes: tiempo, tareas largas y pico de memoria del hilo principal. */
    scale: async (pages, images, side, sideY) => {
      const bytes = await scaleDoc(pages, images, side, sideY);
      const warm = await L.openPdfDocument(bytes); await L.findImageAssets(warm, { bytes }); await L.closePdfDocument(warm);
      const doc = await L.openPdfDocument(bytes);
      let peak = 0;
      const sampler = setInterval(() => { const m = performance.memory; if (m) peak = Math.max(peak, m.usedJSHeapSize); }, 20);
      const beat = heartbeat();
      const t0 = performance.now();
      try {
        const result = await L.findImageAssets(doc, { bytes });
        const ms = performance.now() - t0;
        const beats = beat.stop();
        clearInterval(sampler);
        return { ms, ...beats, pages: doc.numPages, assets: result.assets.length, warnings: result.warnings.map((w) => w.code), peakHeapMb: peak / 1048576, bytes: bytes.length };
      } finally { clearInterval(sampler); await L.closePdfDocument(doc); }
    },
  };
})();
`;

async function openLab(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.log("[extract-images] pageerror:", error.message));
  page.on("console", (message) => (message.type() === "error" ? console.log("[extract-images] console.error:", message.text().slice(0, 300)) : undefined));
  await page.goto("/privacy");
  await page.addScriptTag({ content: bundleCode });
  await page.addScriptTag({ content: LAB });
}

/** Hosts a los que la pagina pidio algo (todo debe ser el propio servidor). */
function trackRequests(page: Page): { external: string[]; wasm: Map<string, number>; all: string[] } {
  const external: string[] = [];
  const wasm = new Map<string, number>();
  const all: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      all.push(url.pathname);
      if (url.hostname !== "localhost") external.push(request.url());
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/pdfjs-wasm/")) wasm.set(url.pathname, response.status());
  });
  return { external, wasm, all };
}

const SKIP_IN_BROWSER = ["bomb"];

test.describe("motor de imagenes incrustadas en navegador real (headless)", () => {
  test("el corpus entero sale con recall 100 %, duplicados bien agrupados y cajas con IoU >= 0,9", async ({ page, browserName }) => {
    const requests = trackRequests(page);
    await openLab(page);
    const runs = (await page.evaluate(`window.__lab.runCorpus(${JSON.stringify(SKIP_IN_BROWSER)})`)) as Array<{
      name: string;
      assets: number;
      thumbs: boolean;
      metrics: { name: string; truthImages: number; found: number; exact: number; duplicateGroups: number; duplicateGroupsOk: number; extra: number; minIou: number; problems: string[] };
    }>;
    const truthImages = runs.reduce((sum, run) => sum + run.metrics.truthImages, 0);
    const found = runs.reduce((sum, run) => sum + run.metrics.found, 0);
    const exact = runs.reduce((sum, run) => sum + run.metrics.exact, 0);
    const groups = runs.reduce((sum, run) => sum + run.metrics.duplicateGroups, 0);
    const groupsOk = runs.reduce((sum, run) => sum + run.metrics.duplicateGroupsOk, 0);
    const minIou = Math.min(...runs.map((run) => run.metrics.minIou));
    console.log(`[extract-images] ${browserName}: ${runs.length} documentos, ${truthImages} imagenes esperadas: recall ${found}/${truthImages}, exactas ${exact}, duplicados ${groupsOk}/${groups}, IoU minimo ${minIou.toFixed(3)}`);
    for (const run of runs) expect(run.metrics.problems, run.name).toEqual([]);
    expect(found).toBe(truthImages);
    expect(exact).toBe(truthImages);
    expect(groupsOk).toBe(groups);
    expect(minIou).toBeGreaterThanOrEqual(0.9);
    for (const run of runs) expect(run.thumbs, `${run.name}: miniaturas PNG`).toBe(true);
    // Nada salio del propio servidor: sin red externa.
    expect(requests.external).toEqual([]);
  });

  test("JPX y JBIG2 se decodifican con los decodificadores servidos: cargan de /pdfjs-wasm/ y sin ninguna peticion externa", async ({ page, browserName }) => {
    const requests = trackRequests(page);
    await openLab(page);
    const runs = (await page.evaluate(`Promise.all(["jpx", "jbig2"].map((name) => window.__lab.exactPixels(name)))`)) as Array<Array<{ id: string; exact: number; bad: number; size: number[] }>>;
    const [jpx, jbig2] = runs;
    expect(jpx[0]).toMatchObject({ id: "jpx", size: [32, 20], bad: 0, exact: 32 * 20 });
    expect(jbig2[0]).toMatchObject({ id: "jbig2", size: [16, 12], bad: 0, exact: 16 * 12 });
    expect(requests.wasm.get("/pdfjs-wasm/openjpeg.wasm")).toBe(200);
    expect(requests.wasm.get("/pdfjs-wasm/jbig2.wasm")).toBe(200);
    const fallbacks = requests.all.filter((url) => url.includes("nowasm_fallback"));
    if (browserName === "chromium") {
      // Chromium instancia los dos WASM: ninguna peticion al respaldo en JavaScript.
      expect(fallbacks).toEqual([]);
    } else {
      // El WebKit de Playwright NO puede compilar `openjpeg.wasm` («relaxed simd instructions not supported»): pdf.js cae
      // al respaldo en JavaScript, que tambien se sirve de /pdfjs-wasm/ (por eso se copia). La imagen sale igual de exacta.
      for (const url of fallbacks) expect(requests.wasm.get(url), url).toBe(200);
    }
    expect(requests.external).toEqual([]);
  });

  test("los pixeles regenerados bajo demanda son exactos (opacas) o casi (bajo alfa parcial: el canvas es premultiplicado)", async ({ page }) => {
    await openLab(page);
    for (const name of ["png-opaque", "png-alpha", "logo-repeat", "logo-copies", "inline", "inline-group", "mask-1bit", "form-nested", "smask", "scanned", "repeat-12", "jpx", "jbig2"]) {
      const reports = (await page.evaluate(`window.__lab.exactPixels(${JSON.stringify(name)})`)) as Array<{ id: string; bad?: number; error?: string; exact: number; tolerated: number; mime: string }>;
      expect(reports.length, name).toBeGreaterThan(0);
      for (const report of reports) {
        expect(report.error, `${name}/${report.id}`).toBeUndefined();
        expect(report.bad, `${name}/${report.id}`).toBe(0);
        expect(report.mime).toBe("image/png");
      }
    }
  });

  test("el JPEG original sale byte a byte (sin recomprimir) y el CMYK no lo ofrece", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.jpegOriginal()")) as { out: Array<{ id: string; type: string; same: boolean; formats: string[] }>; cmykFormats: string[] };
    expect(out.out).toHaveLength(2);
    for (const item of out.out) {
      expect(item.same, item.id).toBe(true);
      expect(item.type).toBe("image/jpeg");
      expect(item.formats).toEqual(["png", "jpg-original"]);
    }
    // CMYK: sin original (se veria invertido fuera del PDF), pero si JPEG recomprimido.
    expect(out.cmykFormats).toEqual(["png", "jpg"]);
  });

  test("JPEG recomprimido (`jpg`): un JPEG valido de las mismas medidas, con la transparencia aplanada sobre blanco", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.recompressed()")) as { type: string; size: number[]; meanOpaque: number[]; expectedOpaque: number[]; cornerAlpha: number; head: number[] };
    expect(out.type).toBe("image/jpeg");
    expect(out.head).toEqual([0xff, 0xd8, 0xff]);
    expect(out.size).toEqual([96, 64]);
    for (let i = 0; i < 3; i += 1) expect(Math.abs(out.meanOpaque[i] - out.expectedOpaque[i])).toBeLessThan(6);
    expect(out.cornerAlpha).toBe(255);
  });

  test("renderImageAsset abre y cierra por su cuenta cuando recibe un File o unos bytes", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.renderFromBytes()")) as { sizePng: number; sameSize: boolean; type: string };
    expect(out.type).toBe("image/png");
    expect(out.sizePng).toBeGreaterThan(100);
    expect(out.sameSize).toBe(true);
  });

  test("imagen mas grande que el limite: el PNG se omite con aviso y el JPEG solo ofrece su original", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.tooLarge()")) as Record<string, { assets: Array<{ px: number[]; formats: string[]; thumb: boolean; reasons: string[] }>; warnings: string[] }>;
    expect(out["png-opaque"].assets).toEqual([]);
    expect(out["png-opaque"].warnings).toEqual(["image-too-large"]);
    const jpeg = out.jpeg;
    expect(jpeg.warnings).toContain("image-too-large");
    expect(jpeg.assets.filter((a) => a.formats.length === 1 && a.formats[0] === "jpg-original" && !a.thumb)).toHaveLength(1);
    expect(jpeg.assets.find((a) => a.px[0] === 64)!.reasons).toContain("demasiado grande para convertirla: solo el original");
  });

  test("se puede cancelar", async ({ page }) => {
    await openLab(page);
    expect(await page.evaluate("window.__lab.cancel()")).toBe("AbortError");
  });

  // @perf: misma carga y mismo presupuesto absoluto que la de `extract-core.spec.ts`; en CI corre solo, con un worker (ver `PW_PERF`).
  test("20 paginas con 30 imagenes de 800 x 600: dentro del presupuesto, sin tareas largas y con memoria acotada", { tag: "@perf" }, async ({ page, browserName }, testInfo) => {
    await openLab(page);
    const ipad = testInfo.project.name === "webkit-ipad";
    const slack = process.env.CI ? 2.5 : 1;
    const out = (await page.evaluate("window.__lab.scale(20, 30, 800, 600)")) as { ms: number; maxGap: number; longTasks: number[]; pages: number; assets: number; warnings: string[]; peakHeapMb: number; bytes: number };
    console.log(
      `[extract-images] ${testInfo.project.name}/${browserName}: ${out.pages} paginas, ${out.assets} imagenes en ${out.ms.toFixed(0)} ms (PDF ${(out.bytes / 1048576).toFixed(1)} MB); tarea larga max ${out.longTasks.length ? Math.max(...out.longTasks).toFixed(0) : 0} ms; hueco max ${out.maxGap.toFixed(0)} ms; pico de heap JS ${out.peakHeapMb.toFixed(0)} MB`,
    );
    expect(out.pages).toBe(20);
    expect(out.assets).toBe(30);
    expect(out.warnings).toEqual([]);
    expect(out.ms).toBeLessThan((ipad ? 4000 : 2000) * slack);
    // 100 ms en una maquina libre; el runner del CI es ~2,5 veces mas lento.
    for (const duration of out.longTasks) expect(duration).toBeLessThan(100 * slack);
    expect(out.maxGap).toBeLessThan(150 * slack);
    if (out.peakHeapMb > 0) expect(out.peakHeapMb).toBeLessThan(400);
  });

  test("tres imagenes de 12 megapixeles: se leen por bandas, sin tareas largas y con el heap de JS acotado", async ({ page, browserName }, testInfo) => {
    await openLab(page);
    const slack = process.env.CI ? 2.5 : 1;
    const out = (await page.evaluate("window.__lab.scale(3, 3, 4000, 3000)")) as { ms: number; maxGap: number; longTasks: number[]; pages: number; assets: number; warnings: string[]; peakHeapMb: number; bytes: number };
    console.log(
      `[extract-images] ${testInfo.project.name}/${browserName}: ${out.assets} imagenes de 12 MP en ${out.ms.toFixed(0)} ms (PDF ${(out.bytes / 1048576).toFixed(1)} MB); tarea larga max ${out.longTasks.length ? Math.max(...out.longTasks).toFixed(0) : 0} ms; hueco max ${out.maxGap.toFixed(0)} ms; pico de heap JS ${out.peakHeapMb.toFixed(0)} MB`,
    );
    expect(out.assets).toBe(3);
    expect(out.warnings).toEqual([]);
    // 100 ms en una maquina libre; el runner del CI es ~2,5 veces mas lento.
    for (const duration of out.longTasks) expect(duration).toBeLessThan(100 * slack);
    expect(out.maxGap).toBeLessThan(150 * slack);
    // Los pixeles completos no se acumulan en el heap de JS (viven en el ImageBitmap de pdf.js, fuera de el).
    if (out.peakHeapMb > 0) expect(out.peakHeapMb).toBeLessThan(400);
  });
});
