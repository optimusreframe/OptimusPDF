import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import { makeExifJpeg } from "../helpers/exif-jpeg";
import { MAX_VAULT_IMAGE_BYTES, isValidVaultImage, pngIhdrCrcValid, readPngSize } from "../../src/app/sign-pdf/signVault";

/**
 * Motor de «tinta» (U6.1) en un NAVEGADOR REAL y headless: lo que Vitest/Node no puede probar (decodificacion del navegador
 * de PNG/JPG/WEBP/SVG, `OffscreenCanvas`, Web Worker de verdad, `CompressionStream`, tareas largas del hilo principal).
 *
 * PATRON (sin pagina de pruebas en el producto): `src/lib/image/inkExtract.ts` y su worker se empaquetan al vuelo con Vite
 * (IIFE, en memoria) y se inyectan en una pagina CUALQUIERA de la app (`/privacy`, con su CSP real: `script-src` con
 * `'unsafe-inline'` y `worker-src blob:`). El worker se crea desde un Blob con el codigo empaquetado del worker; asi se
 * ejercita el protocolo y el modulo reales sin depender de que U6.2 monte la interfaz. Todo el trabajo ocurre DENTRO de la
 * pagina (imagenes sinteticas pintadas en un canvas); a Node solo vuelven numeros y los bytes del PNG para validarlos con
 * `isValidVaultImage` / `pngIhdrCrcValid`. SIEMPRE headless.
 */

test.setTimeout(120_000);

let mainBundle = "";
let workerBundle = "";

async function bundle(entry: string, name: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: path.resolve(process.cwd(), entry), name, formats: ["iife"], fileName: () => `${name}.js` },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error(`no se pudo empaquetar ${entry}`);
  return chunk.code;
}

test.beforeAll(async () => {
  mainBundle = await bundle("src/lib/image/inkExtract.ts", "InkExtract");
  workerBundle = await bundle("src/lib/image/inkExtract.worker.ts", "InkWorker");
});

/** Utilidades que viven en la pagina: imagenes sinteticas (misma receta que `inkTestUtils.ts`) y metricas contra la verdad. */
const LAB = String.raw`
(() => {
  const covers = {};
  let workersCreated = 0;
  let workerMessages = 0;
  const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

  function drawCover(width, height, lineWidth) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.strokeStyle = "#000"; ctx.lineWidth = lineWidth; ctx.lineCap = "round"; ctx.lineJoin = "round";
    const margin = Math.max(lineWidth * 2, Math.round(width * 0.06));
    ctx.beginPath();
    for (let i = 0; i <= 400; i += 1) {
      const t = i / 400;
      const x = margin + t * (width - 2 * margin) + Math.sin(2 * Math.PI * 4 * t) * height * 0.16;
      const y = height * 0.46 + Math.cos(2 * Math.PI * 4 * t) * height * 0.26 * (1 - 0.35 * t);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(width * 0.18, height * 0.86); ctx.quadraticCurveTo(width * 0.55, height * 0.8, width * 0.92, height * 0.88); ctx.stroke();
    const px = ctx.getImageData(0, 0, width, height).data;
    const cover = new Float32Array(width * height);
    for (let i = 0; i < cover.length; i += 1) cover[i] = px[i * 4 + 3] / 255;
    return cover;
  }

  function paperAt(kind, x, y, width, height) {
    if (kind === "shaded") {
      const gradient = 255 - 105 * (x / width);
      const diagonal = (x / width + y / height) / 2;
      const shadow = diagonal > 0.38 && diagonal < 0.5 ? 0.82 : 1;
      const v = gradient * shadow; return [v, v * 0.98, v * 0.93];
    }
    if (kind === "warm") {
      const dx = x / width - 0.5, dy = y / height - 0.5, vignette = 1 - 0.22 * (dx * dx + dy * dy) * 2;
      return [250 * vignette, 244 * vignette, 224 * vignette];
    }
    return [255, 255, 255];
  }

  async function makeImage(opts) {
    const { id, width, height, lineWidth, paper = "white", noise = 0, ink = [10, 10, 40], type = "image/png", quality = 0.8 } = opts;
    const cover = drawCover(width, height, lineWidth);
    covers[id] = { cover, width, height };
    const random = lcg(7);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = y * width + x, c = cover[i], p = paperAt(paper, x, y, width, height);
      const n = noise > 0 ? Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random()) * noise : 0;
      for (let k = 0; k < 3; k += 1) data[i * 4 + k] = p[k] * (1 - c) + ink[k] * c + n;
      data[i * 4 + 3] = 255;
    }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type, quality });
    return new File([blob], "firma." + blob.type.split("/")[1], { type: blob.type });
  }

  function measure(id, image) {
    const { cover, width, height } = covers[id];
    if (image.width !== width || image.height !== height) throw new Error("dimensiones distintas");
    const near = new Uint8Array(cover.length);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (cover[y * width + x] > 0) for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < width && yy < height) near[yy * width + xx] = 1;
      }
    }
    let bg = 0, bgOk = 0, ink = 0, inkOk = 0;
    for (let i = 0; i < cover.length; i += 1) {
      const a = image.data[i * 4 + 3];
      if (!near[i]) { bg += 1; if (a === 0) bgOk += 1; } else if (cover[i] >= 0.5) { ink += 1; if (a >= 128) inkOk += 1; }
    }
    return { backgroundTransparent: bgOk / bg, inkKept: inkOk / ink, inkPixels: ink };
  }

  function toBase64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
  const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false; return true; };

  window.__lab = {
    useWorkerCode(code) {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      InkExtract.setInkWorkerFactory(() => {
        workersCreated += 1;
        const worker = new Worker(url);
        worker.addEventListener("message", () => { workerMessages += 1; });
        return worker;
      });
    },
    workerStats() { return { workersCreated, workerMessages }; },

    /** Un archivo de cada formato -> decodificar con el navegador, limpiar y medir contra la verdad. */
    async formats() {
      const out = {};
      const cases = [
        ["png", { type: "image/png", paper: "white", noise: 0 }],
        ["jpeg", { type: "image/jpeg", quality: 0.5, paper: "shaded", noise: 3 }],
        ["webp", { type: "image/webp", quality: 0.7, paper: "warm", noise: 3 }],
      ];
      for (const [name, extra] of cases) {
        const id = "f-" + name;
        const file = await makeImage({ id, width: 900, height: 320, lineWidth: 4, ...extra });
        const decoded = await InkExtract.decodeImageFile(file);
        const result = await InkExtract.extractInkAsync(decoded, { crop: "none", ink: "black" });
        const m = measure(id, result.image);
        const full = await InkExtract.extractInkAsync(decoded, { ink: "blue" });
        const blob = await InkExtract.encodePng(full);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        out[name] = { produced: file.type, format: decoded.format, width: decoded.width, height: decoded.height, ...m, png: toBase64(bytes), outW: full.image.width, outH: full.image.height };
      }
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="150" viewBox="0 0 400 150"><path d="M20 100 C 80 20, 140 20, 200 90 S 320 130, 380 40" stroke="#000" stroke-width="5" fill="none" stroke-linecap="round"/></svg>';
      const decoded = await InkExtract.decodeImageFile(new File([svg], "firma.svg", { type: "image/svg+xml" }));
      const result = await InkExtract.extractInkAsync(decoded, { ink: "black" });
      const blob = await InkExtract.encodePng(result);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let corner = 0; for (let i = 0; i < 4; i += 1) corner += result.image.data[i];
      out.svg = { format: decoded.format, width: decoded.width, height: decoded.height, originalWidth: decoded.originalWidth, inkPixels: result.inkPixels, cornerAlpha: result.image.data[3], png: toBase64(bytes), outW: result.image.width, outH: result.image.height };
      return out;
    },

    /** Imagen de > 4 MP: por defecto va al worker; el resultado ha de ser identico byte a byte al del hilo principal. */
    async workerVsMain() {
      const file = await makeImage({ id: "big", width: 2600, height: 1700, lineWidth: 9, paper: "warm", noise: 3, type: "image/jpeg", quality: 0.7 });
      const decoded = await InkExtract.decodeImageFile(file);
      const before = window.__lab.workerStats();
      let t0 = performance.now();
      const viaWorker = await InkExtract.extractInkAsync(decoded, { ink: "black" });
      const workerMs = performance.now() - t0;
      const after = window.__lab.workerStats();
      t0 = performance.now();
      const viaMain = await InkExtract.extractInkAsync(decoded, { ink: "black" }, { worker: "never" });
      const mainMs = performance.now() - t0;
      const small = await makeImage({ id: "small", width: 600, height: 220, lineWidth: 4 });
      const smallDecoded = await InkExtract.decodeImageFile(small);
      await InkExtract.extractInkAsync(smallDecoded);
      const afterSmall = window.__lab.workerStats();
      return {
        megapixels: (decoded.width * decoded.height) / 1e6,
        workersCreated: after.workersCreated - before.workersCreated,
        workerMessages: after.workerMessages - before.workerMessages,
        smallUsedWorker: afterSmall.workersCreated - after.workersCreated,
        identical: sameBytes(viaWorker.image.data, viaMain.image.data) && viaWorker.image.width === viaMain.image.width,
        workerMs, mainMs, inkPixels: viaWorker.inkPixels,
      };
    },

    /** Tareas largas del hilo principal mientras se limpia una imagen de ~4 MP SIN worker. */
    async longTasks() {
      const file = await makeImage({ id: "lt", width: 2400, height: 1650, lineWidth: 9, paper: "shaded", noise: 3, type: "image/jpeg", quality: 0.7 });
      const decoded = await InkExtract.decodeImageFile(file);
      const durations = [];
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) durations.push(entry.duration); });
      observer.observe({ type: "longtask", buffered: false });
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 5);
      const t0 = performance.now();
      const result = await InkExtract.extractInkAsync(decoded, { ink: "black" }, { worker: "never" });
      const ms = performance.now() - t0;
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(timer); observer.disconnect();
      return { megapixels: (decoded.width * decoded.height) / 1e6, ms, longTasks: durations, ticks, inkPixels: result.inkPixels };
    },

    /** Errores tipados con el decodificador real. */
    async errors() {
      const code = async (promise) => { try { await promise; return "sin error"; } catch (e) { return e.code + ": " + e.message; } };
      const out = {};
      const white = await makeImage({ id: "white", width: 300, height: 120, lineWidth: 0.01, ink: [255, 255, 255] });
      out.blank = await code(InkExtract.extractInkAsync(await InkExtract.decodeImageFile(white)));
      const bytes = new Uint8Array(await (await makeImage({ id: "c", width: 80, height: 40, lineWidth: 3 })).arrayBuffer());
      out.corrupt = await code(InkExtract.decodeImageFile(new File([bytes.slice(0, 40), new Uint8Array(100)], "x.png", { type: "image/png" })));
      out.html = await code(InkExtract.decodeImageFile(new File(["<html><script>alert(1)</script></html>"], "x.png", { type: "image/png" })));
      out.huge = await code(InkExtract.decodeImageFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "x.png", { type: "image/png" })));
      out.empty = await code(InkExtract.decodeImageFile(new File([], "x.png", { type: "image/png" })));
      const bomb = new Uint8Array(33);
      bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      const view = new DataView(bomb.buffer); view.setUint32(16, 30000); view.setUint32(20, 30000);
      out.bomb = await code(InkExtract.decodeImageFile(new File([bomb], "bomba.png", { type: "image/png" })));
      const heic = new Uint8Array(64); heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
      out.heic = await code(InkExtract.decodeImageFile(new File([heic], "foto.heic", { type: "image/heic" })));
      return out;
    },

    /** Un SVG con scripts: rasterizado con <img>, no ejecuta nada. */
    async svgWithScript() {
      window.__pwned = 0;
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" onload="window.__pwned=1"><script>window.__pwned=2</script><image href="https://example.invalid/x.png" width="10" height="10"/><path d="M10 40 L190 40" stroke="#000" stroke-width="6"/></svg>';
      const decoded = await InkExtract.decodeImageFile(new File([svg], "mala.svg", { type: "image/svg+xml" }));
      const result = await InkExtract.extractInkAsync(decoded);
      return { pwned: window.__pwned, inkPixels: result.inkPixels };
    },

    /** Sin CompressionStream el PNG sale del canvas del navegador. */
    async withoutCompressionStream() {
      const file = await makeImage({ id: "nc", width: 700, height: 250, lineWidth: 4, paper: "warm", noise: 2 });
      const result = await InkExtract.extractInkAsync(await InkExtract.decodeImageFile(file));
      const saved = window.CompressionStream;
      delete window.CompressionStream;
      try {
        const blob = await InkExtract.encodePng(result);
        return { had: typeof saved, now: typeof window.CompressionStream, png: toBase64(new Uint8Array(await blob.arrayBuffer())) };
      } finally { window.CompressionStream = saved; }
    },
  };
})();
`;

async function openLab(page: Page): Promise<void> {
  await page.goto("/privacy");
  await page.addScriptTag({ content: mainBundle });
  await page.addScriptTag({ content: LAB });
  await page.evaluate(`window.__lab.useWorkerCode(${JSON.stringify(workerBundle)})`);
}

function pngBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function expectVaultReady(base64: string): { width: number; height: number } {
  const png = pngBytes(base64);
  const size = readPngSize(png);
  expect(size).not.toBeNull();
  expect(pngIhdrCrcValid(png)).toBe(true);
  expect(png.length).toBeLessThanOrEqual(MAX_VAULT_IMAGE_BYTES);
  expect(isValidVaultImage({ png, ratio: size!.width / size!.height, width: size!.width, height: size!.height })).toBe(true);
  return size!;
}

test.describe("inkExtract en navegador real (headless)", () => {
  test("PNG, JPG y WEBP del navegador y un SVG: >= 98 % de fondo transparente, >= 95 % de tinta, PNG valido para el baul", async ({ page, browserName }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.formats()")) as Record<
      string,
      { produced: string; format: string; width: number; height: number; backgroundTransparent: number; inkKept: number; inkPixels: number; png: string; outW: number; outH: number; cornerAlpha: number; originalWidth: number }
    >;
    for (const name of ["png", "jpeg", "webp"] as const) {
      const entry = out[name];
      console.log(`[ink-extract] ${name}: fondo transparente ${(entry.backgroundTransparent * 100).toFixed(2)} %, tinta conservada ${(entry.inkKept * 100).toFixed(2)} %`);
      // El navegador de la prueba decide que formatos sabe CODIFICAR (WebKit no codifica WEBP y entrega PNG): se lee lo que salio.
      expect(entry.format).toBe(entry.produced.replace("image/", ""));
      if (browserName === "chromium") expect(entry.produced).toBe(`image/${name}`);
      expect([entry.width, entry.height]).toEqual([900, 320]);
      expect(entry.backgroundTransparent).toBeGreaterThanOrEqual(0.98);
      expect(entry.inkKept).toBeGreaterThanOrEqual(0.95);
      expect(entry.inkPixels).toBeGreaterThan(500);
      const size = expectVaultReady(entry.png);
      expect([size.width, size.height]).toEqual([entry.outW, entry.outH]);
      expect(size.width).toBeLessThan(900); // recortado al contenido
    }
    const svg = out.svg;
    expect([svg.format, svg.width, svg.height, svg.originalWidth]).toEqual(["svg", 2000, 750, 400]);
    expect(svg.inkPixels).toBeGreaterThan(2000);
    expect(svg.cornerAlpha).toBe(0);
    expectVaultReady(svg.png);
  });

  test("mas de 4 MP: va a un Web Worker de verdad y da los mismos bytes que el hilo principal; una imagen pequena no usa worker", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.workerVsMain()")) as {
      megapixels: number; workersCreated: number; workerMessages: number; smallUsedWorker: number; identical: boolean; workerMs: number; mainMs: number; inkPixels: number;
    };
    console.log(`[ink-extract] ${out.megapixels.toFixed(2)} MP: worker ${out.workerMs.toFixed(0)} ms, hilo principal por trozos ${out.mainMs.toFixed(0)} ms`);
    expect(out.megapixels).toBeGreaterThan(4);
    expect(out.workersCreated).toBe(1);
    expect(out.workerMessages).toBe(1);
    expect(out.smallUsedWorker).toBe(0);
    expect(out.identical).toBe(true);
    expect(out.inkPixels).toBeGreaterThan(5000);
  });

  test("hilo principal por trozos: ninguna tarea larga de 100 ms y la pagina sigue viva mientras limpia ~4 MP", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.longTasks()")) as { megapixels: number; ms: number; longTasks: number[]; ticks: number; inkPixels: number };
    console.log(`[ink-extract] ${out.megapixels.toFixed(2)} MP en hilo principal: ${out.ms.toFixed(0)} ms (${(out.ms / out.megapixels).toFixed(0)} ms/MP), tareas largas (>50 ms): ${JSON.stringify(out.longTasks.map(Math.round))}, latidos de 5 ms: ${out.ticks}`);
    expect(out.inkPixels).toBeGreaterThan(5000);
    // El runner compartido de CI es varias veces mas lento que un portatil: el tope absoluto lleva holgura solo alli
    // (la limpieza sigue troceada; un hilo bloqueado de verdad daria cientos de ms y 0 latidos).
    const slack = process.env.CI ? 2.5 : 1;
    for (const duration of out.longTasks) expect(duration).toBeLessThan(100 * slack);
    expect(out.ticks).toBeGreaterThan(process.env.CI ? 1 : 5);
  });

  test("errores con el decodificador real: mensaje claro y codigo estable", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.errors()")) as Record<string, string>;
    expect(out.blank).toMatch(/^no-ink: No se encontró tinta/);
    expect(out.corrupt).toMatch(/^decode-failed/);
    expect(out.html).toMatch(/^unsupported-format/);
    expect(out.huge).toMatch(/^file-too-large/);
    expect(out.empty).toMatch(/^empty-file/);
    expect(out.bomb).toMatch(/^too-many-pixels/);
    // Chromium no abre HEIC: error claro, no una pagina colgada.
    expect(out.heic).toMatch(/^(unsupported-format|decode-failed)/);
  });

  test("un SVG con script, evento onload e imagen externa NO ejecuta nada ni sale a la red", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("example.invalid")) requests.push(request.url());
    });
    await openLab(page);
    const out = (await page.evaluate("window.__lab.svgWithScript()")) as { pwned: number; inkPixels: number };
    expect(out.pwned).toBe(0);
    expect(out.inkPixels).toBeGreaterThan(500);
    expect(requests).toEqual([]);
  });

  test("una foto de movil con orientacion EXIF 6 se lee ya de pie (el navegador aplica la orientacion)", async ({ page }) => {
    await openLab(page);
    const base64 = makeExifJpeg({ width: 300, height: 100, orientation: 6 }).toString("base64");
    const out = (await page.evaluate(
      `(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0)); const d = await InkExtract.decodeImageFile(new File([bytes], "foto.jpg", { type: "image/jpeg" })); return { w: d.width, h: d.height, downscaled: d.downscaled }; })()`,
    )) as { w: number; h: number; downscaled: boolean };
    expect([out.w, out.h]).toEqual([100, 300]);
    expect(out.downscaled).toBe(false);
  });

  test("sin CompressionStream, el PNG sale del canvas y sigue siendo valido para el baul", async ({ page }) => {
    await openLab(page);
    const out = (await page.evaluate("window.__lab.withoutCompressionStream()")) as { had: string; now: string; png: string };
    expect(out.had).toBe("function");
    expect(out.now).toBe("undefined");
    expectVaultReady(out.png);
  });

  test("todo en el navegador: durante la limpieza no hay peticiones de red de imagenes", async ({ page }) => {
    const external: string[] = [];
    await openLab(page);
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("blob:") && !url.startsWith("data:") && !url.startsWith(`http://localhost`)) external.push(url);
    });
    const posted: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") posted.push(`${request.method()} ${request.url()}`);
    });
    await page.evaluate("window.__lab.formats()");
    expect(external).toEqual([]);
    expect(posted).toEqual([]);
  });
});
