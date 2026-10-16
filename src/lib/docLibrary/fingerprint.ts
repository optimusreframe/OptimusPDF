import { sha256Hex } from "../crypto/sha256";
import {
  computeFingerprintWith,
  type ComputeOptions,
  type FingerprintEnv,
  type PdfjsLike,
  type RenderSurface,
} from "./fingerprintEngine";
import {
  PDFJS_FONTS_PATH,
  PDFJS_WORKER_PATH,
  type FingerprintWorkerRequest,
  type FingerprintWorkerResponse,
} from "./fingerprintProtocol";
import { FingerprintError, LIBRARY_LIMITS, type Fingerprint } from "./types";

/**
 * Huella robusta de un PDF (U2.1). Punto de entrada único:
 *
 *   `computeFingerprint(file | bytes, { signal?, onProgress?, worker?, maxPages? })` → `Fingerprint`
 *   `compareFingerprints(doc, template)` / `findBestMatch(fp, candidates)` (en `match.ts`, reexportados aquí)
 *
 * Dónde corre: por defecto en un Web Worker (`fingerprint.worker.ts`) — todo el cálculo fuera del hilo principal — y,
 * si el navegador no lo deja arrancar o falla, en el hilo principal CEDIENDO el control tras cada página (el trabajo
 * por página son milisegundos; pdf.js ya parsea en su propio worker). Mismos números por ambos caminos.
 * Cancelable con `AbortSignal` (el worker se termina). Sin red: lo único que se descarga es el worker de pdf.js, que
 * ya sirve la app.
 */

export * from "./match";
export * from "./types";
export {
  DHASH_GRID,
  MINHASH_SIZE,
  dhashFromGray,
  estimateJaccard,
  hammingDistance,
  hasUsefulText,
  minhashOf,
  normalizeText,
  wordShingles,
} from "./fingerprintCore";
export type { ComputeOptions, FingerprintEnv, PdfjsLike, RenderSurface } from "./fingerprintEngine";

export type FingerprintRunOptions = ComputeOptions & {
  /**
   * `"auto"` (por defecto): worker si el navegador lo permite, con respaldo al hilo principal.
   * `"never"`: siempre en el hilo principal (por trozos). `"always"`: worker o error `unavailable`.
   */
  worker?: "auto" | "never" | "always";
};

/* ------------------------------------------------------------------ *
 * Ganchos para pruebas
 * ------------------------------------------------------------------ */

type WorkerFactory = () => Worker;
let workerFactory: WorkerFactory | null = null;
/** Solo para pruebas: sustituye la creación del worker (`null` restaura la normal). */
export function setFingerprintWorkerFactory(factory: WorkerFactory | null): void {
  workerFactory = factory;
}

let pdfjsLoader: (() => Promise<PdfjsLike>) | null = null;
/** Permite a la app dar su propia carga de pdf.js (p. ej. `getPdfJs` de `core.ts`) o a las pruebas la versión «legacy». */
export function setFingerprintPdfjsLoader(loader: (() => Promise<PdfjsLike>) | null): void {
  pdfjsLoader = loader;
}

/* ------------------------------------------------------------------ *
 * Entorno del hilo principal
 * ------------------------------------------------------------------ */

function absoluteUrl(path: string): string {
  const base = typeof location !== "undefined" ? location.href : "http://localhost/";
  return new URL(path, base).href;
}

function pdfjsWorkerUrl(): string {
  let version = "0";
  try {
    version = process.env.NEXT_PUBLIC_PDFJS_VERSION ?? "0";
  } catch {
    // Sin `process` (empaquetado de pruebas): la versión solo sirve para invalidar la caché.
  }
  return absoluteUrl(`${PDFJS_WORKER_PATH}?v=${version}`);
}

async function defaultLoadPdfjs(): Promise<PdfjsLike> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl();
  return pdfjs as unknown as PdfjsLike;
}

function createDomSurface(width: number, height: number): RenderSurface {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new FingerprintError("unavailable");
  return { context } as RenderSurface;
}

/** Cede el hilo al navegador. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mainThreadEnv(): FingerprintEnv {
  return {
    getPdfjs: pdfjsLoader ?? defaultLoadPdfjs,
    createCanvas: createDomSurface,
    sha256: sha256Hex,
    documentParams: { standardFontDataUrl: absoluteUrl(PDFJS_FONTS_PATH) },
    yieldToMain,
  };
}

/* ------------------------------------------------------------------ *
 * Worker
 * ------------------------------------------------------------------ */

/** El worker no pudo arrancar o murió: se cae al hilo principal (a diferencia de un `FingerprintError` de verdad). */
class WorkerUnavailable extends Error {}

function createWorker(): Worker {
  if (workerFactory) return workerFactory();
  return new Worker(new URL("./fingerprint.worker.ts", import.meta.url), { type: "module" });
}

function runInWorker(bytes: Uint8Array, options: FingerprintRunOptions): Promise<Fingerprint> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createWorker();
    } catch {
      reject(new WorkerUnavailable());
      return;
    }
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      action();
    };
    const onAbort = () => finish(() => reject(new FingerprintError("aborted")));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<FingerprintWorkerResponse>) => {
      const message = event.data;
      if (!message || message.id !== 1) return;
      if (message.type === "progress") options.onProgress?.(message.done, message.total);
      else if (message.type === "result") finish(() => resolve(message.fingerprint));
      else if (message.code === "unavailable") finish(() => reject(new WorkerUnavailable()));
      else finish(() => reject(new FingerprintError(message.code)));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      finish(() => reject(new WorkerUnavailable()));
    };
    worker.onmessageerror = () => finish(() => reject(new WorkerUnavailable()));
    try {
      const copy = bytes.slice();
      const request: FingerprintWorkerRequest = {
        type: "compute",
        id: 1,
        bytes: copy,
        maxPages: options.maxPages ?? LIBRARY_LIMITS.maxFingerprintPages,
        pdfjsWorkerSrc: pdfjsWorkerUrl(),
        standardFontDataUrl: absoluteUrl(PDFJS_FONTS_PATH),
      };
      worker.postMessage(request, [copy.buffer]);
    } catch {
      finish(() => reject(new WorkerUnavailable()));
    }
  });
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function toBytes(source: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}

/**
 * Calcula la huella de un PDF (bytes o `File`). Errores: `FingerprintError` (`empty`, `corrupt`, `encrypted`,
 * `aborted`, `unavailable`). Más de `maxPages` páginas (por defecto 200) → huella parcial (`partial`): solo `exact` y
 * `pageCount`.
 */
export async function computeFingerprint(
  source: Uint8Array | ArrayBuffer | Blob,
  options: FingerprintRunOptions = {},
): Promise<Fingerprint> {
  if (options.signal?.aborted) throw new FingerprintError("aborted");
  const bytes = await toBytes(source);
  if (bytes.length === 0) throw new FingerprintError("empty");
  const mode = options.worker ?? "auto";
  if (mode !== "never" && typeof Worker !== "undefined") {
    try {
      return await runInWorker(bytes, options);
    } catch (error) {
      if (!(error instanceof WorkerUnavailable)) throw error;
      if (mode === "always") throw new FingerprintError("unavailable");
    }
  } else if (mode === "always") {
    throw new FingerprintError("unavailable");
  }
  return computeFingerprintWith(bytes, mainThreadEnv(), options);
}
