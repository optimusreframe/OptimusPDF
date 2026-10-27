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

export interface OcrRecognizer {
  recognize(image: Rgba, options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<OcrResult>;
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

/** Reconocedor real con tesseract.js. Lanza `PdfError` clasificado (`ocrNetworkFailure`/`ocrEngineFailure`) si no arranca. */
export async function createTesseractRecognizer(signal?: AbortSignal): Promise<OcrRecognizer> {
  const { createOcrWorker } = await import("@/lib/pdf/ocrGuard");
  let progress: ((fraction: number) => void) | undefined;
  const worker = await createOcrWorker(
    SCAN_OCR_LANGUAGES,
    (message) => {
      if (message.status === "recognizing text") progress?.(message.progress);
    },
    signal,
  );
  return {
    async recognize(image, options) {
      progress = options?.onProgress;
      const canvas = toCanvas(image);
      try {
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
  shared ??= factory(signal).catch((error: unknown) => {
    shared = null;
    throw error;
  });
  busy += 1;
  try {
    const recognizer = await shared;
    return await task(recognizer);
  } finally {
    busy -= 1;
    scheduleIdle();
  }
}
