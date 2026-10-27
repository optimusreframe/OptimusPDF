/**
 * MOTOR FALSO del Escaner (solo pruebas): implementa `ScanEngineApi` de forma DETERMINISTA y sin dependencias del motor real,
 * para probar la interfaz (`src/app/scan-to-pdf/*`) contra el CONTRATO (`src/lib/scan/types.ts`).
 *
 * El resultado de cada pagina sale de "etiquetas" que lleva el NOMBRE del archivo importado (un `File`) o, para fotogramas de
 * camara (sin nombre), de `controls.tokens` (se consumen de una en una):
 *   blank | blurry | glare | dark | nodoc          -> avisos de calidad de la pagina
 *   dup                                             -> `analyzeSession` la marca repetida de la pagina anterior
 *   sideways | upsidedown                           -> `detectOrientation` devuelve 90 / 180
 *   title-Contrato_de_servicio                      -> `suggestName` lo devuelve como titulo reconocido (OCR simulado)
 *   fail                                            -> `createPage` rechaza
 *   slow                                            -> `createPage` tarda `controls.slowMs` (por defecto 700 ms)
 * Ademas mide pixeles reales (sin canvas, p. ej. en jsdom, solo usa las etiquetas): una foto sin contraste es "en blanco".
 *
 * `controls` es mutable y las pruebas lo cambian en caliente (`globalThis.__scanFake.controls`): veredicto del fotograma en vivo,
 * retardos, numero de llamadas, errores. Nada aqui hace red.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import type { QuadCorners } from "@/lib/scan/perspective";
import type {
  FrameVerdict,
  ScanEngineApi,
  ScanFilterMode,
  ScanMode,
  ScanPage,
  ScanPageFlags,
  ScanPageSource,
  ScanRotation,
  ScanSession,
  ScanSettings,
  ScanSizeEstimate,
} from "@/lib/scan/types";

export type FakeControls = {
  /** Etiquetas para las proximas paginas SIN nombre (camara); se consumen una por pagina. */
  tokens: string[][];
  /** Etiquetas para TODAS las paginas sin nombre (si `tokens` esta vacio). */
  defaultTokens: string[];
  /** Retardo extra (ms) de `createPage` / `renderPage` / `buildPdf` por pagina. */
  createDelayMs: number;
  renderDelayMs: number;
  buildDelayMs: number;
  slowMs: number;
  /** Veredicto del fotograma en vivo; `null` = secuencia por defecto (busca -> acerca -> firme -> ok estable). */
  verdict: Partial<FrameVerdict> | null;
  /** Ms de `ok` estable antes de `shouldAutoCapture` con el veredicto por defecto. */
  autoAfterMs: number;
  /** Contadores de llamadas. */
  calls: Record<string, number>;
  /** Registro del orden en que se pidieron los `createPage` (nombre del archivo o `frame`). */
  createLog: string[];
  /** Pico de `createPage`/`renderPage` simultaneos (la cola de la interfaz debe ser serie: 1). */
  peakConcurrent: number;
  /** `buildPdf` rechaza con este mensaje. */
  buildError: string | null;
  /** Solo `splitSpread`: sin lomo detectable. */
  noSplit: boolean;
  /** El modelo de texto buscable ya esta en este dispositivo (`ocrModelAvailable`). */
  ocrAvailable: boolean;
  /** Resultado de `prepareOcrModel`: `ok` deja el modelo en el dispositivo; el resto es el motivo del fallo. */
  ocrPrepare: "ok" | "offline" | "network" | "engine";
};

export function newControls(): FakeControls {
  return {
    tokens: [],
    defaultTokens: [],
    createDelayMs: 0,
    renderDelayMs: 0,
    buildDelayMs: 0,
    slowMs: 700,
    verdict: null,
    autoAfterMs: 700,
    calls: {},
    createLog: [],
    peakConcurrent: 0,
    buildError: null,
    noSplit: false,
    ocrAvailable: false,
    ocrPrepare: "ok",
  };
}

const PRESET_FACTOR: Record<string, number> = { original: 1, high: 0.6, balanced: 0.35, compact: 0.18 };

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/* ------------------------------------------------------------------ *
 * Pixeles (solo con canvas; en jsdom todo se degrada a "sin pixeles")
 * ------------------------------------------------------------------ */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): AnyCanvas | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    // jsdom sin el paquete `canvas` devuelve `null` en getContext: se trata como "sin canvas".
    return canvas.getContext && canvas.getContext("2d") ? canvas : null;
  }
  return null;
}

function context2d(canvas: AnyCanvas): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  return canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
}

async function canvasBlob(canvas: AnyCanvas, type = "image/jpeg", quality = 0.85): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob"))), type, quality);
  });
}

async function decode(blob: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

function luminanceStats(data: Uint8ClampedArray): { mean: number; std: number } {
  let sum = 0;
  let sum2 = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += y;
    sum2 += y * y;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
}

/** Aplica filtro y ajustes in situ (aproximaciones simples: es un doble de prueba, no el motor). */
function filterPixels(data: Uint8ClampedArray, filter: ScanFilterMode, brightness: number, contrast: number): void {
  const kind = filter === "auto" ? "enhance" : filter;
  const gain = 1 + contrast * 0.6;
  const shift = brightness * 60;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (kind === "grayscale" || kind === "bw" || kind === "enhance") {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = y;
    }
    if (kind === "bw") r = g = b = r > 150 ? 255 : 0;
    if (kind === "enhance") {
      const v = Math.min(255, Math.max(0, (r - 128) * 1.3 + 140));
      r = g = b = v;
    }
    data[i] = Math.min(255, Math.max(0, (r - 128) * gain + 128 + shift));
    data[i + 1] = Math.min(255, Math.max(0, (g - 128) * gain + 128 + shift));
    data[i + 2] = Math.min(255, Math.max(0, (b - 128) * gain + 128 + shift));
  }
}

function boundsOf(corners: QuadCorners | null): { x0: number; y0: number; x1: number; y1: number } {
  if (!corners) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomLeft.x, corners.bottomRight.x];
  const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomLeft.y, corners.bottomRight.y];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/* ------------------------------------------------------------------ *
 * Etiquetas de escenario
 * ------------------------------------------------------------------ */

function nameOf(blob: Blob): string {
  return typeof (blob as File).name === "string" ? (blob as File).name : "";
}

function tokensOfName(name: string): string[] {
  const lower = name.toLowerCase();
  const found: string[] = [];
  for (const token of ["blank", "blurry", "glare", "dark", "nodoc", "dup", "sideways", "upsidedown", "fail", "slow"]) {
    if (new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(lower)) found.push(token);
  }
  return found;
}

function titleOfName(name: string): string | null {
  const match = /title-([A-Za-z0-9_]+)/.exec(name);
  return match ? match[1].replace(/_/g, " ") : null;
}

function insetQuad(margin: number): QuadCorners {
  return {
    topLeft: { x: margin, y: margin },
    topRight: { x: 1 - margin, y: margin },
    bottomLeft: { x: margin, y: 1 - margin },
    bottomRight: { x: 1 - margin, y: 1 - margin },
  };
}

/** Huella barata de los bytes (tamano + extremos): dos copias del mismo archivo coinciden. */
async function fingerprint(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 48).arrayBuffer());
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 48)).arrayBuffer());
  return `${blob.size}:${Array.from(head).join(",")}:${Array.from(tail).join(",")}`;
}

/* ------------------------------------------------------------------ *
 * Motor
 * ------------------------------------------------------------------ */

export type FakeEngine = ScanEngineApi & {
  controls: FakeControls;
  /** Opcional del contrato (aditivo): parte la pagina de un libro abierto en dos (izquierda, derecha). */
  splitSpread: (source: ScanPage, options?: { signal?: AbortSignal }) => Promise<[ScanPage, ScanPage]>;
};

/** Doble de `ocrModelAvailable` / `prepareOcrModel` del motor (se instala en `globalThis.__optimusScanOcr`). */
export function createFakeOcr(controls: FakeControls): NonNullable<typeof globalThis.__optimusScanOcr> {
  return {
    ocrModelAvailable: async () => controls.ocrAvailable,
    prepareOcrModel: async () => {
      controls.calls.prepareOcrModel = (controls.calls.prepareOcrModel ?? 0) + 1;
      if (controls.ocrPrepare === "ok") {
        controls.ocrAvailable = true;
        return { ok: true };
      }
      return { ok: false, reason: controls.ocrPrepare };
    },
  };
}

export function createFakeEngine(controls: FakeControls = newControls()): FakeEngine {
  let counter = 0;
  let concurrent = 0;
  const call = (name: string) => {
    controls.calls[name] = (controls.calls[name] ?? 0) + 1;
  };
  const enter = () => {
    concurrent += 1;
    controls.peakConcurrent = Math.max(controls.peakConcurrent, concurrent);
  };
  const leave = () => {
    concurrent -= 1;
  };
  const nextId = () => {
    counter += 1;
    return `fake-${Date.now().toString(36)}-${counter}`;
  };

  const frameState = { okSince: null as number | null };

  async function renderInto(page: ScanPage, maxSide: number): Promise<{ processed: Blob; thumb: Blob }> {
    const bitmap = await decode(page.original);
    if (!bitmap) return { processed: page.original, thumb: page.original };
    const box = boundsOf(page.corners);
    const sx = box.x0 * bitmap.width;
    const sy = box.y0 * bitmap.height;
    const sw = Math.max(1, (box.x1 - box.x0) * bitmap.width);
    const sh = Math.max(1, (box.y1 - box.y0) * bitmap.height);
    const turned = page.rotation === 90 || page.rotation === 270;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = makeCanvas(turned ? h : w, turned ? w : h);
    if (!canvas) {
      bitmap.close?.();
      return { processed: page.original, thumb: page.original };
    }
    const ctx = context2d(canvas);
    if (!ctx) {
      bitmap.close?.();
      return { processed: page.original, thumb: page.original };
    }
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((page.rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    ctx.restore();
    bitmap.close?.();
    if (page.filter !== "original" || page.adjust.brightness !== 0 || page.adjust.contrast !== 0) {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (page.filter !== "original" && page.filter !== "color") filterPixels(image.data, page.filter, page.adjust.brightness, page.adjust.contrast);
      else filterPixels(image.data, "color", page.adjust.brightness, page.adjust.contrast);
      ctx.putImageData(image, 0, 0);
    }
    const processed = await canvasBlob(canvas, "image/jpeg", 0.85);
    const tscale = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
    const thumbCanvas = makeCanvas(canvas.width * tscale, canvas.height * tscale);
    const tctx = thumbCanvas ? context2d(thumbCanvas) : null;
    if (!thumbCanvas || !tctx) return { processed, thumb: processed };
    tctx.drawImage(canvas as CanvasImageSource, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return { processed, thumb: await canvasBlob(thumbCanvas, "image/jpeg", 0.7) };
  }

  const engine: FakeEngine = {
    controls,

    analyzeFrame(frame, previous, now = performance.now()): FrameVerdict {
      call("analyzeFrame");
      const base: FrameVerdict = {
        quad: insetQuad(0.1),
        confidence: 0.9,
        stable: false,
        stableMs: 0,
        blurry: false,
        glare: false,
        dark: false,
        coverage: 0.7,
        hint: "unknown",
        shouldAutoCapture: false,
      };
      if (controls.verdict) {
        const forced = { ...base, ...controls.verdict } as FrameVerdict;
        return forced;
      }
      void frame;
      void previous;
      // Secuencia por defecto: ok desde el primer fotograma; estable tras `autoAfterMs` de ok continuado.
      frameState.okSince ??= now;
      const stableMs = Math.max(0, now - frameState.okSince);
      const stable = stableMs > 250;
      return { ...base, hint: stable ? "ok" : "hold_steady", stable, stableMs, shouldAutoCapture: stableMs >= controls.autoAfterMs };
    },

    async createPage(source, info): Promise<ScanPage> {
      call("createPage");
      const label = nameOf(source) || "frame";
      controls.createLog.push(label);
      enter();
      try {
        const tokens = nameOf(source) ? tokensOfName(nameOf(source)) : (controls.tokens.shift() ?? controls.defaultTokens);
        if (tokens.includes("fail")) throw new Error("fake-create-failed");
        await wait(controls.createDelayMs + (tokens.includes("slow") ? controls.slowMs : 0), info.signal);
        const bitmap = await decode(source);
        const width = bitmap?.width ?? 800;
        const height = bitmap?.height ?? 1000;
        const flags: ScanPageFlags = {};
        if (tokens.includes("blank")) flags.blank = true;
        if (tokens.includes("blurry")) flags.blurry = true;
        if (tokens.includes("glare")) flags.glare = true;
        if (tokens.includes("dark")) flags.dark = true;
        if (tokens.includes("nodoc")) flags.noDocument = true;
        if (bitmap && !flags.blank) {
          const probe = makeCanvas(32, 32);
          const ctx = probe ? context2d(probe) : null;
          if (probe && ctx) {
            ctx.drawImage(bitmap, 0, 0, 32, 32);
            const stats = luminanceStats(ctx.getImageData(0, 0, 32, 32).data);
            if (stats.std < 3) flags.blank = true;
          }
        }
        bitmap?.close?.();
        const noQuad = info.mode === "photo" || flags.noDocument;
        const page: ScanPage = {
          id: nextId(),
          createdAt: new Date().toISOString(),
          source: info.source,
          original: source,
          originalWidth: width,
          originalHeight: height,
          corners: noQuad ? null : insetQuad(0.04),
          rotation: 0,
          filter: info.mode === "photo" ? "original" : info.settings.defaultFilter,
          adjust: { brightness: 0, contrast: 0 },
          processed: null,
          thumb: null,
          flags,
        };
        const rendered = await renderInto(page, 1600);
        return { ...page, ...rendered };
      } finally {
        leave();
      }
    },

    async renderPage(page, options): Promise<ScanPage> {
      call("renderPage");
      enter();
      try {
        await wait(controls.renderDelayMs, options?.signal);
        // Como el motor real: con `maxSide <= 480` solo se recalcula la miniatura y el resultado completo queda por recalcular.
        if (options?.maxSide !== undefined && options.maxSide <= 480) {
          controls.calls.renderQuick = (controls.calls.renderQuick ?? 0) + 1;
          const quick = await renderInto(page, options.maxSide);
          return { ...page, processed: null, thumb: quick.thumb };
        }
        controls.calls.renderFull = (controls.calls.renderFull ?? 0) + 1;
        const rendered = await renderInto(page, options?.maxSide ?? 1600);
        return { ...page, ...rendered };
      } finally {
        leave();
      }
    },

    async analyzeSession(pages): Promise<Record<string, ScanPageFlags>> {
      call("analyzeSession");
      const out: Record<string, ScanPageFlags> = {};
      const seen = new Map<string, string>();
      let previousId: string | null = null;
      for (const page of pages) {
        const flags: ScanPageFlags = { ...page.flags };
        delete flags.duplicateOf;
        const name = nameOf(page.original);
        const print = await fingerprint(page.original);
        const first = seen.get(print);
        if (first && first !== page.id) flags.duplicateOf = first;
        else if (tokensOfName(name).includes("dup") && previousId) flags.duplicateOf = previousId;
        if (!seen.has(print)) seen.set(print, page.id);
        out[page.id] = flags;
        previousId = page.id;
      }
      return out;
    },

    async detectOrientation(page): Promise<ScanRotation | null> {
      call("detectOrientation");
      const tokens = tokensOfName(nameOf(page.original));
      if (tokens.includes("sideways")) return 90;
      if (tokens.includes("upsidedown")) return 180;
      return 0;
    },

    async suggestName(pages, _locale, signal): Promise<ScanSession["nameSuggested"]> {
      call("suggestName");
      await wait(0, signal);
      const date = new Date().toISOString().slice(0, 10);
      for (const page of pages) {
        const title = titleOfName(nameOf(page.original));
        if (title) return { title, date, source: "ocr" };
      }
      return { title: null, date, source: "date" };
    },

    estimateSize(pages: ScanPage[], options): ScanSizeEstimate {
      call("estimateSize");
      const factor = PRESET_FACTOR[options.preset] ?? 0.35;
      let bytes = 0;
      for (const page of pages) bytes += (page.processed?.size ?? page.original.size) * factor + 2048;
      if (options.searchable) bytes *= 1.05;
      return { bytes: Math.round(bytes), low: Math.round(bytes * 0.8), high: Math.round(bytes * 1.25) };
    },

    async buildPdf(session, options): Promise<Blob> {
      call("buildPdf");
      if (controls.buildError) throw new Error(controls.buildError);
      const pdf = await PDFDocument.create();
      const total = session.pages.length;
      let done = 0;
      for (const page of session.pages) {
        await wait(controls.buildDelayMs, options.signal);
        // Un resultado completo por calcular (`processed: null`) se calcula al crear el PDF, como en el motor real.
        const blob = page.processed ?? (await renderInto(page, 1600)).processed;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const image = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        const sheet = options.pageSize === "letter" ? [612, 792] : options.pageSize === "a4" ? [595.28, 841.89] : [image.width, image.height];
        const margin = options.pageSize === "fit" ? 0 : { none: 0, small: 18, large: 48 }[options.margin];
        const pdfPage = pdf.addPage([sheet[0], sheet[1]]);
        const scale = Math.min((sheet[0] - 2 * margin) / image.width, (sheet[1] - 2 * margin) / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        pdfPage.drawImage(image, { x: (sheet[0] - w) / 2, y: (sheet[1] - h) / 2, width: w, height: h });
        done += 1;
        options.onProgress?.(done, total);
      }
      if (options.signal?.aborted) throw abortError();
      if (session.settings.searchable) {
        // Como el motor real: con el modelo en el dispositivo hay texto; sin el, el PDF sale NORMAL y se avisa (nunca es un error).
        if (!controls.ocrAvailable && options.allowModelDownload && controls.ocrPrepare === "ok") controls.ocrAvailable = true;
        if (controls.ocrAvailable) call("ocrUsed");
        else options.onWarning?.({ code: "searchable-unavailable", reason: options.allowModelDownload && controls.ocrPrepare !== "ok" ? controls.ocrPrepare : "model-missing", pagesWithText: 0, total });
      }
      const saved = await pdf.save();
      return new Blob([saved as BlobPart], { type: "application/pdf" });
    },

    /** Contrato aditivo del motor real: `splitSpread(page)` -> dos paginas (izquierda, derecha) que comparten el original. */
    async splitSpread(source): Promise<[ScanPage, ScanPage]> {
      call("splitSpread");
      if (controls.noSplit) throw new Error("fake-no-split");
      const side = async (x0: number, x1: number): Promise<ScanPage> => {
        const half: ScanPage = {
          ...source,
          id: nextId(),
          corners: { topLeft: { x: x0, y: 0.04 }, topRight: { x: x1, y: 0.04 }, bottomLeft: { x: x0, y: 0.96 }, bottomRight: { x: x1, y: 0.96 } },
        };
        return { ...half, ...(await renderInto(half, 1600)) };
      };
      return [await side(0.02, 0.5), await side(0.5, 0.98)];
    },
  };

  return engine;
}

/** Atajo para pruebas: pagina minima valida (sin pixeles), util para sembrar sesiones. */
export function makeBarePage(id: string, overrides: Partial<ScanPage> = {}, size = 1000): ScanPage {
  const blob = new Blob([new Uint8Array(size)], { type: "image/jpeg" });
  return {
    id,
    createdAt: new Date(0).toISOString(),
    source: "library" as ScanPageSource,
    original: blob,
    originalWidth: 800,
    originalHeight: 1000,
    corners: null,
    rotation: 0,
    filter: "auto",
    adjust: { brightness: 0, contrast: 0 },
    processed: blob,
    thumb: blob,
    flags: {},
    ...overrides,
  };
}

export type { ScanMode, ScanSettings };
