import { buildScanPdf } from "@/lib/scan/buildPdf";
import { estimateScanSize, PROCESSED_MAX_SIDE } from "@/lib/scan/estimate";
import { buildNameSuggestion, dominantMode, fallbackName, sanitizeFileName, isoDate } from "@/lib/scan/naming";
import { isOcrReady, ocrModelAvailable, withRecognizer } from "@/lib/scan/ocr";
import { ocrOrientation } from "@/lib/scan/orientation";
import { areDuplicatesYielding, type PageSignature } from "@/lib/scan/similarity";
import { findSpine } from "@/lib/scan/spine";
import { yieldToMain } from "@/lib/image/prepareBrowser";
import { enqueueTask, ScanCancelled } from "@/lib/scan/renderBrowser";
import { readDisplaySize } from "@/lib/scan/renderIO";
import { inverseHomography, isDegenerateQuad, projectPoint, DEFAULT_QUAD, type QuadCorners } from "@/lib/scan/perspective";
import { toGray } from "@/lib/scan/pixels";
import { analyzeLiveFrame, sharedFrameTracker } from "@/lib/scan/liveFrame";
import type { RenderJob } from "@/lib/scan/renderCore";
import type { PageQualityReading, TaskResult } from "@/lib/scan/renderTasks";
import type { FrameVerdict, ScanEngineApi, ScanMode, ScanPage, ScanPageFlags, ScanSession } from "@/lib/scan/types";

/**
 * Motor REAL del Escaner (implementa `ScanEngineApi`). Todo el trabajo de pixeles va por la cola de `renderBrowser.ts`
 * (Web Worker con respaldo al hilo principal, una tarea a la vez, cancelable); aqui solo se orquesta. 100 % local.
 */

/** Lado al que se decodifica el original para detectar el documento (hilo principal). */
const DETECT_SIDE = 800;
/** Recorte de la pagina al crearla: suficiente para medir calidad y sacar la miniatura. */
const CREATE_CROP_SIDE = 640;
/** Miniatura. */
export const THUMB_SIDE = 360;
/** Una miniatura rapida (`maxSide`) no calcula el resultado completo. */
const THUMB_ONLY_MAX_SIDE = 480;
/** Cuantas paginas hacia atras se compara una pagina para marcar repetidas. */
const DUPLICATE_WINDOW = 12;
/** Trozo maximo de comparaciones seguidas en el hilo principal (ms) antes de ceder el hilo. */
export const DUPLICATE_SLICE_MS = 8;
const PAIR_CACHE_MAX = 4000;
const pairCache = new Map<string, boolean>();
function rememberPair(key: string, value: boolean): void {
  pairCache.set(key, value);
  if (pairCache.size > PAIR_CACHE_MAX) {
    const oldest = pairCache.keys().next().value;
    if (oldest !== undefined) pairCache.delete(oldest);
  }
}

/** Solo para pruebas: olvida los pares ya comparados. */
export function __clearPairCacheForTests(): void {
  pairCache.clear();
}

function newPageId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `p-${Date.now().toString(36)}-${random}`;
}

function cornersKey(corners: QuadCorners | null): string {
  if (!corners) return "full";
  const r = (n: number) => Math.round(n * 1000);
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft].map((p) => `${r(p.x)},${r(p.y)}`).join(";");
}

type Cached = { signature: PageSignature; quality: PageQualityReading };
/** Firmas y lecturas de calidad por pagina (clave: id + esquinas + giro). Acotada: se descarta lo mas antiguo. */
const analysisCache = new Map<string, Cached>();
const ANALYSIS_CACHE_MAX = 400;

function remember(key: string, value: Cached): void {
  analysisCache.delete(key);
  analysisCache.set(key, value);
  if (analysisCache.size > ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next().value;
    if (oldest !== undefined) analysisCache.delete(oldest);
  }
}

/** Solo para pruebas. */
export function __analysisCacheForTests(): Map<string, Cached> {
  return analysisCache;
}

const analysisKey = (page: ScanPage) => `${page.id}|${cornersKey(page.corners)}|${page.rotation}`;

function rendered(result: TaskResult): Extract<TaskResult, { kind: "render" }> {
  if (result.kind !== "render") throw new Error("unexpected task result");
  return result;
}

function pageMode(page: ScanPage): ScanMode {
  return page.mode ?? "document";
}

/** Marcas de calidad que tienen sentido segun el modo (una foto de dano no es «borrosa» ni «en blanco» por su textura). */
function qualityFlags(mode: ScanMode, q: PageQualityReading | null): Pick<ScanPageFlags, "blank" | "sparse" | "blurry" | "glare" | "dark"> {
  if (!q) return {};
  const flags: Pick<ScanPageFlags, "blank" | "sparse" | "blurry" | "glare" | "dark"> = {};
  if (mode === "photo") {
    if (q.dark) flags.dark = true;
    return flags;
  }
  if (q.blank && (mode === "document" || mode === "book")) flags.blank = true;
  if (q.sparse && (mode === "document" || mode === "book")) flags.sparse = true;
  if (q.blurry) flags.blurry = true;
  if (q.glare) flags.glare = true;
  if (q.dark) flags.dark = true;
  return flags;
}

function jobOf(page: ScanPage, maxSide: number): RenderJob {
  return { corners: page.corners, rotation: page.rotation, filter: page.filter, adjust: page.adjust, mode: pageMode(page), maxSide };
}

export const realEngine: ScanEngineApi = {
  analyzeFrame(frame, previous, now, options): FrameVerdict {
    return analyzeLiveFrame(frame, sharedFrameTracker, previous, now ?? (typeof performance !== "undefined" ? performance.now() : Date.now()), options);
  },

  async createPage(source, info) {
    const { signal } = info;
    const mode = info.mode;
    const id = newPageId();
    // 1. Original: se conserva TAL CUAL; solo un JPEG con orientacion EXIF distinta de 1 se endereza (y se recodifica).
    let original = source;
    const header = await readDisplaySize(source);
    if (header && header.orientation > 1) {
      const baked = await enqueueTask({ kind: "ingest", source, quality: 0.95 }, signal);
      if (baked.kind === "ingest") original = baked.blob;
    }
    // 2. Documento: scanic sobre una copia reducida (el modo `photo` no recorta nunca).
    let corners: QuadCorners | null = null;
    let token: string | undefined;
    if (mode !== "photo") {
      token = `${id}:detect`;
      // Decodifica reducido, detecta el documento y ajusta los lados DENTRO del worker (sin pixeles de vuelta al hilo principal).
      const detected = await enqueueTask({ kind: "detect", source: original, maxSide: DETECT_SIDE, mode, token }, signal);
      corners = detected.kind === "detect" ? detected.corners : null;
    }
    if (signal?.aborted) throw new ScanCancelled();
    // 3. Miniatura + calidad + firma, de la hoja ya recortada.
    const page: ScanPage = {
      id,
      createdAt: new Date().toISOString(),
      source: info.source,
      original,
      originalWidth: header?.width ?? 0,
      originalHeight: header?.height ?? 0,
      corners,
      rotation: 0,
      filter: info.settings.defaultFilter,
      adjust: { brightness: 0, contrast: 0 },
      processed: null,
      thumb: null,
      flags: {},
      mode,
    };
    const result = rendered(
      await enqueueTask(
        { kind: "render", source: original, job: jobOf(page, CREATE_CROP_SIDE), decodeMax: 1280, token, thumbSide: THUMB_SIDE, encodeProcessed: false, measure: true, signature: true, sampleBytes: true },
        signal,
      ),
    );
    page.thumb = result.thumb;
    page.resolvedFilter = result.resolved;
    if (result.jpegSample) page.jpegSample = result.jpegSample;
    if (!header) {
      page.originalWidth = result.sourceSize.width;
      page.originalHeight = result.sourceSize.height;
    }
    page.flags = { ...qualityFlags(mode, result.quality), ...(mode !== "photo" && !corners ? { noDocument: true } : {}) };
    if (result.signature && result.quality) remember(analysisKey(page), { signature: result.signature, quality: result.quality });
    return page;
  },

  async renderPage(page, options = {}) {
    const { signal } = options;
    const maxSide = options.maxSide ?? PROCESSED_MAX_SIDE;
    const full = maxSide > THUMB_ONLY_MAX_SIDE;
    const result = rendered(
      await enqueueTask(
        {
          kind: "render",
          source: page.original,
          job: jobOf(page, full ? maxSide : Math.max(CREATE_CROP_SIDE, maxSide)),
          decodeMax: full ? 4096 : 1280,
          thumbSide: THUMB_SIDE,
          encodeProcessed: full,
          measure: true,
          signature: true,
          passthroughCandidate: full,
          sampleBytes: !full,
        },
        signal,
      ),
    );
    const mode = pageMode(page);
    const flags: ScanPageFlags = { ...page.flags };
    delete flags.blank;
    delete flags.sparse;
    delete flags.blurry;
    delete flags.glare;
    delete flags.dark;
    Object.assign(flags, qualityFlags(mode, result.quality));
    // Con esquinas puestas a mano (o confirmadas) ya no «falta el documento».
    if (page.corners) delete flags.noDocument;
    if (result.signature && result.quality) remember(analysisKey(page), { signature: result.signature, quality: result.quality });
    // Sin recorte, giro, filtro ni ajuste el resultado ES el original: sus bytes no se recodifican (el PDF «Original» lo conserva).
    const processed = full ? (result.passthrough ? page.original : result.processed) : null;
    return {
      ...page,
      processed,
      ...(full && result.processedSize ? { processedSize: result.processedSize } : { processedSize: undefined }),
      thumb: result.thumb ?? page.thumb,
      flags,
      resolvedFilter: result.resolved,
      ...(result.jpegSample ? { jpegSample: result.jpegSample } : {}),
    };
  },

  async analyzeSession(pages) {
    const flagsById: Record<string, ScanPageFlags> = {};
    const signatures: Array<{ page: ScanPage; cached: Cached | null }> = [];
    for (const page of pages) {
      const key = analysisKey(page);
      let cached = analysisCache.get(key) ?? null;
      if (!cached) {
        try {
          const result = rendered(
            await enqueueTask({
              kind: "render",
              source: page.original,
              job: { ...jobOf(page, 480), filter: "original", adjust: { brightness: 0, contrast: 0 } },
              decodeMax: 1280,
              thumbSide: null,
              encodeProcessed: false,
              measure: true,
              signature: true,
            }),
          );
          if (result.signature && result.quality) {
            cached = { signature: result.signature, quality: result.quality };
            remember(key, cached);
          }
        } catch {
          cached = null;
        }
      }
      signatures.push({ page, cached });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // Comparar paginas es trabajo del hilo principal (cada comparacion de dos hojas parecidas pesa varios ms): se reparte en trozos de
    // ~DUPLICATE_SLICE_MS cediendo el hilo entre ellos, para no congelar la pantalla con decenas de fotos (36 fotos de 12 MP
    // sumaban una tarea de ~3 s), y cada par se recuerda: volver a analizar no repite las comparaciones.
    let sliceStart = performance.now();
    const slice = async (): Promise<void> => {
      if (performance.now() - sliceStart < DUPLICATE_SLICE_MS) return;
      await yieldToMain();
      sliceStart = performance.now();
    };
    for (let index = 0; index < signatures.length; index += 1) {
      const { page, cached } = signatures[index];
      const mode = pageMode(page);
      const flags: ScanPageFlags = {};
      if (page.flags.noDocument) flags.noDocument = true;
      if (cached) Object.assign(flags, qualityFlags(mode, cached.quality));
      if (cached && mode !== "photo" && !flags.blank) {
        for (let back = 1; back <= DUPLICATE_WINDOW && index - back >= 0; back += 1) {
          const other = signatures[index - back];
          if (!other.cached || pageMode(other.page) !== mode) continue;
          const pairKey = `${analysisKey(page)}>${analysisKey(other.page)}`;
          let duplicate = pairCache.get(pairKey);
          if (duplicate === undefined) {
            duplicate = await areDuplicatesYielding(cached.signature, other.cached.signature, slice);
            rememberPair(pairKey, duplicate);
          }
          if (duplicate) {
            flags.duplicateOf = other.page.id;
            break;
          }
        }
      }
      flagsById[page.id] = flags;
    }
    return flagsById;
  },

  async detectOrientation(page, signal) {
    const result = await enqueueTask({ kind: "orientation", source: page.original, corners: page.corners, mode: pageMode(page) }, signal);
    if (result.kind !== "orientation") return null;
    if (result.reading) return result.reading.rotation;
    // Sin evidencia por proyeccion: si el OCR YA esta cargado se le pregunta (no se espera una descarga por esto).
    if (!isOcrReady()) return null;
    try {
      const sample = await enqueueTask({ kind: "sample", source: page.original, corners: page.corners, rotation: 0, mode: pageMode(page), maxSide: 800 }, signal);
      if (sample.kind !== "sample") return null;
      const reading = await withRecognizer((recognizer) => ocrOrientation(sample.image, (image) => recognizer.recognize(image, { signal })), signal);
      return reading ? reading.rotation : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  },

  async suggestName(pages, locale, signal) {
    const now = new Date();
    const mode = dominantMode(pages.map((page) => page.mode));
    const fallback = () => {
      const name = sanitizeFileName(fallbackName(now, locale, mode));
      return { title: null, date: isoDate(now), source: "date" as const, name };
    };
    const first = pages.find((page) => !page.flags.blank) ?? pages[0];
    // 100 % local por defecto: el OCR solo se usa si el modelo YA esta en el dispositivo (o ya esta cargado). Si no, nombre por
    // tipo y fecha, sin ninguna peticion ni error.
    if (!first || (!isOcrReady() && !(await ocrModelAvailable()))) return fallback();
    try {
      const sample = await enqueueTask({ kind: "sample", source: first.original, corners: first.corners, rotation: first.rotation, mode: pageMode(first), maxSide: 1100, topFraction: 0.55 }, signal);
      if (sample.kind !== "sample") return fallback();
      const ocr = await withRecognizer((recognizer) => recognizer.recognize(sample.image, { signal }), signal);
      return buildNameSuggestion(ocr, locale, now, mode);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      // El OCR no arranco (por ejemplo sin conexion y sin los scripts en cache): nombre por tipo y fecha, nunca un error.
      return fallback();
    }
  },

  estimateSize(pages, options) {
    return estimateScanSize(pages, options);
  },

  async buildPdf(session: ScanSession, options) {
    return buildScanPdf(session, options, {
      async processedBlob(page, signal) {
        if (page.processed) return page.processed;
        const result = await realEngine.renderPage(page, { signal });
        if (!result.processed) throw new Error("render produced no output");
        return result.processed;
      },
      async ocrGate(allowDownload) {
        if (isOcrReady() || (await ocrModelAvailable())) return { ok: true };
        if (!allowDownload) return { ok: false, reason: "model-missing" };
        if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, reason: "offline" };
        return { ok: true };
      },
      async recognize(processed, signal) {
        const decoded = await enqueueTask({ kind: "decode", source: processed, maxSide: 2200, token: "ocr" }, signal);
        if (decoded.kind !== "decode") throw new Error("unexpected task result");
        return withRecognizer((recognizer) => recognizer.recognize(decoded.image, { signal }), signal);
      },
    });
  },

  async splitSpread(page, options = {}) {
    const { signal } = options;
    const quad = page.corners && !isDegenerateQuad(page.corners) ? page.corners : DEFAULT_QUAD;
    // Hoja del libro enderezada (sin giro ni filtro) para buscar el lomo.
    const crop = await enqueueTask({ kind: "sample", source: page.original, corners: page.corners, rotation: 0, mode: "book", maxSide: 900 }, signal);
    if (crop.kind !== "sample") throw new Error("unexpected task result");
    const spine = findSpine(toGray(crop.image));
    const full = { width: Math.max(1, page.originalWidth), height: Math.max(1, page.originalHeight) };
    const outW = crop.image.width;
    const outH = crop.image.height;
    const homography = inverseHomography(quad, full.width, full.height, outW, outH);
    const point = (x: number, y: number) => {
      if (!homography) return { x: 0.5, y: y / outH };
      const p = projectPoint(homography, x, y);
      return { x: p.x / full.width, y: p.y / full.height };
    };
    const top = homography ? point(spine.position * outW, 0) : { x: (quad.topLeft.x + quad.topRight.x) / 2, y: (quad.topLeft.y + quad.topRight.y) / 2 };
    const bottom = homography ? point(spine.position * outW, outH) : { x: (quad.bottomLeft.x + quad.bottomRight.x) / 2, y: (quad.bottomLeft.y + quad.bottomRight.y) / 2 };
    const left: QuadCorners = { topLeft: quad.topLeft, topRight: top, bottomRight: bottom, bottomLeft: quad.bottomLeft };
    const right: QuadCorners = { topLeft: top, topRight: quad.topRight, bottomRight: quad.bottomRight, bottomLeft: bottom };
    const make = async (corners: QuadCorners): Promise<ScanPage> => {
      const base: ScanPage = { ...page, id: newPageId(), corners, processed: null, thumb: null, mode: "book", flags: {} };
      return realEngine.renderPage(base, { signal, maxSide: THUMB_SIDE });
    };
    const first = await make(left);
    const second = await make(right);
    return [first, second];
  },
};
