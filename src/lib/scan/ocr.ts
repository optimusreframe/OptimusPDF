import tesseractPackage from "tesseract.js/package.json";
import type { Rgba } from "@/lib/scan/pixels";

/**
 * OCR local del Escaner (tesseract.js, ya en el proyecto): carga perezosa, idioma espanol + ingles, un unico worker
 * compartido que se libera solo tras un rato sin uso. Se abstrae tras `OcrRecognizer` para poder sustituirlo en las
 * pruebas (sin red: el motor real descarga el modelo de idioma de la CDN de tesseract.js la primera vez, como el resto de
 * herramientas de OCR; ver `src/lib/pdf/ocr.ts`).
 */

export type OcrWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
export type OcrLine = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number }; words: OcrWord[] };
export type OcrResult = {
  text: string;
  lines: OcrLine[];
  /** Tamano de la imagen reconocida (px): las cajas estan en estas coordenadas. */
  width: number;
  height: number;
};

/**
 * `pageSegMode` (3 = automatico, 6 = bloque uniforme, 11 = texto disperso) y `dpi` (resolucion de la imagen, para que tesseract no la adivine)
 * son opcionales; sin ellos se usa el modo automatico y la resolucion estimada, como siempre. El worker es COMPARTIDO: cada lectura fija
 * los dos valores (los de quien pregunta o los de siempre), asi una lectura no hereda el modo de la anterior.
 */
export type OcrRecognizeOptions = { signal?: AbortSignal; onProgress?: (fraction: number) => void; pageSegMode?: number; dpi?: number };

export interface OcrRecognizer {
  recognize(image: Rgba, options?: OcrRecognizeOptions): Promise<OcrResult>;
  dispose(): Promise<void>;
}

export type OcrRecognizerFactory = (signal?: AbortSignal) => Promise<OcrRecognizer>;

/** Idiomas del OCR del Escaner. */
export const SCAN_OCR_LANGUAGES = "spa+eng";

/** Tiempo sin uso tras el cual se termina el worker (memoria). */
export const OCR_IDLE_MS = 45_000;

/** Por debajo de esta confianza de palabra, tesseract suele devolver ruido. */
export const MIN_WORD_CONFIDENCE = 30;

type TesseractWords = Array<{ text: string; confidence: number; bbox: OcrWord["bbox"] }>;
type TesseractBlocks = Array<{ paragraphs: Array<{ lines: Array<{ text: string; confidence: number; bbox: OcrWord["bbox"]; words: TesseractWords }> }> }> | null;

/** `Rgba` -> lienzo (DOM o fuera de pantalla) que tesseract.js sabe leer. */
function toCanvas(image: Rgba): HTMLCanvasElement | OffscreenCanvas {
  const data = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")!.putImageData(data, 0, 0);
    return canvas;
  }
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Disponibilidad del modelo (el OCR NO se usa por defecto: 100 % local)
 * ------------------------------------------------------------------ */

/** Cache de tesseract.js (idb-keyval): base, almacen y claves de los idiomas. */
const TESSERACT_CACHE_DB = "keyval-store";
const TESSERACT_CACHE_STORE = "keyval";
const TESSERACT_LANG_KEYS = SCAN_OCR_LANGUAGES.split("+").map((lang) => `./${lang}.traineddata`);

/**
 * ¿El modelo de OCR (espanol + ingles) ya esta EN ESTE DISPOSITIVO? Solo entonces el motor lo usa por su cuenta (nombre
 * inteligente, orientacion): descargarlo es una peticion a la red y exige una accion explicita (`prepareOcrModel`).
 * Mira que los datos de idioma esten en la cache de tesseract.js (IndexedDB; la fuente de verdad), SIN crear nunca esa base (abrir una inexistente la dejaria vacia y romperia la cache). Nunca lanza, nunca toca la red.
 */
export async function ocrModelAvailable(): Promise<boolean> {
  if (shared !== null) return true;
  try {
    if (typeof indexedDB === "undefined") return false;
    const listing = (indexedDB as { databases?: () => Promise<Array<{ name?: string }>> }).databases;
    // Sin `databases()` (navegadores antiguos) no se puede mirar sin riesgo de crear la base: se da por NO disponible.
    if (typeof listing !== "function") return false;
    const known = await listing.call(indexedDB);
    if (!known.some((db) => db.name === TESSERACT_CACHE_DB)) return false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(TESSERACT_CACHE_DB);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains(TESSERACT_CACHE_STORE)) return false;
      const present = await Promise.all(
        TESSERACT_LANG_KEYS.map(
          (key) =>
            new Promise<boolean>((resolve) => {
              const request = db.transaction(TESSERACT_CACHE_STORE, "readonly").objectStore(TESSERACT_CACHE_STORE).count(key);
              request.onsuccess = () => resolve(request.result > 0);
              request.onerror = () => resolve(false);
            }),
        ),
      );
      return present.every(Boolean);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export type PrepareOcrResult = { ok: true } | { ok: false; reason: "offline" | "network" | "engine" | "cancelled" };

/**
 * ACCION EXPLICITA: descarga y deja listo el modelo de OCR (peticiones a la CDN de tesseract.js la primera vez; despues queda en
 * el dispositivo). La interfaz lo llama solo cuando la persona lo acepta. Sin conexion no lo intenta. Un fallo sale como
 * resultado tipado (nunca como excepcion ni como error de pagina sin capturar).
 */
export async function prepareOcrModel(options: { signal?: AbortSignal } = {}): Promise<PrepareOcrResult> {
  if (await ocrModelAvailable()) return { ok: true };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, reason: "offline" };
  try {
    await withRecognizer(async () => undefined, options.signal);
    return { ok: true };
  } catch (error) {
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, reason: code === "ocrNetworkFailure" ? "network" : "engine" };
  }
}

/** Mientras dura la creacion del worker de OCR, los `error` sin capturar del navegador (carga del script) no ensucian la pagina. */
function swallowWorkerErrors(): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const handler = (event: Event): void => {
    event.preventDefault();
  };
  window.addEventListener("error", handler);
  window.addEventListener("unhandledrejection", handler);
  return () => {
    // Un poco despues: el evento de un script fallido llega asincrono.
    setTimeout(() => {
      window.removeEventListener("error", handler);
      window.removeEventListener("unhandledrejection", handler);
    }, 1500);
  };
}

/** Error de OCR no disponible (sin red para el script/modelo): `code` lo clasifica como `PdfError` sin cargar el motor de PDF. */
export class OcrUnavailableError extends Error {
  readonly code = "ocrNetworkFailure";
  constructor(message = "El motor de OCR no se pudo descargar") {
    super(message);
    this.name = "OcrUnavailableError";
  }
}

/**
 * Antes de arrancar el worker se comprueba que su script de la CDN se puede obtener (peticion opaca, una sola vez; sirve la
 * cache del navegador si ya estaba). Si no, error CAPTURABLE aqui: un worker cuyo script no carga lanza un error DENTRO del
 * worker que ninguna pagina puede capturar (aparece como error de pagina). Solo se llega aqui con permiso o con el modelo ya
 * en el dispositivo.
 */
async function preflightWorkerScript(signal?: AbortSignal): Promise<void> {
  if (typeof fetch !== "function") return;
  const url = `https://cdn.jsdelivr.net/npm/tesseract.js@v${(tesseractPackage as { version: string }).version}/dist/worker.min.js`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await fetch(url, { mode: "no-cors", cache: "force-cache", signal: controller.signal });
  } catch {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw new OcrUnavailableError();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Reconocedor real con tesseract.js. Lanza `PdfError` clasificado (`ocrNetworkFailure`/`ocrEngineFailure`) si no arranca. */
export async function createTesseractRecognizer(signal?: AbortSignal): Promise<OcrRecognizer> {
  await preflightWorkerScript(signal);
  const { createOcrWorker } = await import("@/lib/pdf/ocrGuard");
  let progress: ((fraction: number) => void) | undefined;
  const worker = await createOcrWorker(
    SCAN_OCR_LANGUAGES,
    (message) => {
      if (message.status === "recognizing text") progress?.(message.progress);
    },
    signal,
  );
  // El worker llego a arrancar: el modelo ya esta en el dispositivo (la proxima vez no hace falta pedirlo).
  return {
    async recognize(image, options) {
      progress = options?.onProgress;
      const canvas = toCanvas(image);
      try {
        await worker.setParameters({ tessedit_pageseg_mode: String(options?.pageSegMode ?? 3) as never, user_defined_dpi: String(options?.dpi ?? 0) } as never);
        const result = await worker.recognize(canvas as HTMLCanvasElement, {}, { text: true, blocks: true });
        const lines: OcrLine[] = [];
        for (const block of (result.data.blocks as TesseractBlocks) ?? []) {
          for (const paragraph of block.paragraphs) {
            for (const line of paragraph.lines) {
              const words = line.words.filter((word) => word.confidence >= MIN_WORD_CONFIDENCE && word.text.trim().length > 0);
              if (words.length === 0) continue;
              lines.push({ text: words.map((w) => w.text).join(" "), confidence: line.confidence, bbox: line.bbox, words });
            }
          }
        }
        return { text: lines.map((l) => l.text).join("\n"), lines, width: image.width, height: image.height };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        progress = undefined;
      }
    },
    async dispose() {
      await worker.terminate().catch(() => {});
    },
  };
}

let factory: OcrRecognizerFactory = createTesseractRecognizer;
let shared: Promise<OcrRecognizer> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let busy = 0;

/** Sustituye el reconocedor (pruebas / integracion). `null` restaura tesseract.js. Descarta el worker compartido. */
export function setOcrRecognizerFactory(next: OcrRecognizerFactory | null): void {
  factory = next ?? createTesseractRecognizer;
  void disposeSharedRecognizer();
}

/** `true` si ya hay un reconocedor cargado (el OCR de la orientacion solo se usa si NO obliga a esperar una descarga). */
export function isOcrReady(): boolean {
  return shared !== null;
}

export async function disposeSharedRecognizer(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = shared;
  shared = null;
  if (current) await current.then((r) => r.dispose()).catch(() => {});
}

function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (busy === 0) void disposeSharedRecognizer();
    else scheduleIdle();
  }, OCR_IDLE_MS);
  // En Node (pruebas) un temporizador pendiente no debe retener el proceso.
  (idleTimer as { unref?: () => void }).unref?.();
}

/**
 * Ejecuta `task` con el reconocedor compartido (se crea la primera vez). Un unico worker: las tareas se encadenan.
 */
export async function withRecognizer<T>(task: (recognizer: OcrRecognizer) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (shared === null) {
    // Un fallo del worker (script de la CDN inalcanzable) es un `error` del navegador: se absorbe mientras se crea.
    const stop = swallowWorkerErrors();
    shared = factory(signal).then(
      (recognizer) => {
        stop();
        return recognizer;
      },
      (error: unknown) => {
        shared = null;
        stop();
        throw error;
      },
    );
  }
  busy += 1;
  try {
    const recognizer = await shared;
    return await task(recognizer);
  } finally {
    busy -= 1;
    scheduleIdle();
  }
}
