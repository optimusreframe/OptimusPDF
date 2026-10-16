import {
  InkError,
  extractInkSteps,
  validateInkImage,
  type ExtractResult,
  type InkErrorCode,
  type InkImage,
  type InkOptions,
} from "./inkCore";
import { decodeImageFile, type DecodeOptions } from "./inkDecode";
import { encodeInkPng, type EncodeOptions } from "./inkPng";
import type { InkWorkerRequest, InkWorkerResponse } from "./inkExtract.worker";

/**
 * Motor de «tinta» de OptimusPDF (U6.1): limpia el fondo de una imagen de firma/iniciales y la deja lista para el baul
 * de firmas y para estamparse en un PDF sin recuadro blanco. Es la puerta de entrada unica; el detalle vive en:
 *
 * - `inkCore.ts`    algoritmos puros (luminancia, fondo, Otsu, alfa, motas, recorte, reduccion). Sin DOM.
 * - `inkDecode.ts`  `decodeImageFile`: PNG / JPG / WEBP / SVG (/ HEIC donde el navegador lo abra) -> pixeles, con topes.
 * - `inkPng.ts`     `encodeInkPng` / `encodePng`: PNG determinista que respeta los topes del baul (4096 px, 600 KB).
 * - `inkExtract.worker.ts` el mismo motor en un Web Worker (imagenes de mas de 4 MP).
 *
 * Uso tipico:
 * ```ts
 * const decoded = await decodeImageFile(file);                    // InkError si no se puede leer
 * const result = await extractInkAsync(decoded, { ink: "black" }); // InkError("no-ink") si no hay firma
 * const png = await encodePng(result);                            // Blob image/png <= 600 KB
 * ```
 * Todo corre en el navegador del usuario: sin red, sin subir la imagen a ningun sitio.
 */

export * from "./inkCore";
export * from "./inkDecode";
export * from "./inkPng";

/** Por encima de este numero de pixeles `extractInkAsync` usa un Web Worker (si existe). */
export const WORKER_MIN_PIXELS = 4_000_000;

export interface InkRunOptions {
  /** Cancela el trabajo (rechaza con `InkError("aborted")`; el worker se termina). */
  signal?: AbortSignal;
  /**
   * `"auto"` (por defecto): worker solo si la imagen pasa de `WORKER_MIN_PIXELS` y el navegador lo permite.
   * `"never"`: siempre en el hilo principal, por trozos. `"always"`: worker siempre que sea posible.
   */
  worker?: "auto" | "never" | "always";
  /** Milisegundos de CPU seguidos antes de ceder al navegador en el hilo principal (por defecto 30). */
  budgetMs?: number;
}

/** Cede el hilo al navegador (y deja pintar / atender toques). */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InkError("aborted");
}

type WorkerFactory = () => Worker;
let workerFactory: WorkerFactory | null = null;

/** Solo para pruebas: sustituye la creacion del worker (`null` restaura la normal). */
export function setInkWorkerFactory(factory: WorkerFactory | null): void {
  workerFactory = factory;
}

function createWorker(): Worker {
  if (workerFactory) return workerFactory();
  return new Worker(new URL("./inkExtract.worker.ts", import.meta.url), { type: "module" });
}

/** El worker no pudo arrancar o murio: se cae al hilo principal (a diferencia de un `InkError` de verdad). */
class WorkerUnavailable extends Error {}

function runInWorker(image: InkImage, options: InkOptions | undefined, signal: AbortSignal | undefined): Promise<ExtractResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createWorker();
    } catch {
      reject(new WorkerUnavailable());
      return;
    }
    const finish = (settle: () => void): void => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      settle();
    };
    const onAbort = (): void => finish(() => reject(new InkError("aborted")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<InkWorkerResponse>) => {
      const message = event.data;
      if (message.ok) finish(() => resolve(message.result));
      else finish(() => reject(new InkError(message.code as InkErrorCode, message.message)));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      finish(() => reject(new WorkerUnavailable()));
    };
    worker.onmessageerror = () => finish(() => reject(new WorkerUnavailable()));
    try {
      // Se COPIA el buffer (clonado estructurado): quien llama puede seguir usando `image` (p. ej. al mover el deslizador).
      const request: InkWorkerRequest = { id: 1, image: { width: image.width, height: image.height, data: image.data }, options };
      worker.postMessage(request);
    } catch {
      finish(() => reject(new WorkerUnavailable()));
    }
  });
}

/**
 * Igual que `extractInk` pero sin bloquear la interfaz: por encima de 4 MP corre en un Web Worker (con respaldo al hilo
 * principal si no puede arrancar) y por debajo, en el hilo principal CEDIENDO el control cada `budgetMs`, de modo que
 * ninguna tarea larga pase de ~50 ms. El resultado es identico byte a byte en ambos caminos.
 */
export async function extractInkAsync(image: InkImage, options?: InkOptions, run: InkRunOptions = {}): Promise<ExtractResult> {
  validateInkImage(image);
  aborted(run.signal);
  const mode = run.worker ?? "auto";
  const wantsWorker =
    mode === "always" || (mode === "auto" && image.width * image.height > WORKER_MIN_PIXELS);
  if (wantsWorker && typeof Worker !== "undefined") {
    try {
      return await runInWorker(image, options, run.signal);
    } catch (error) {
      if (!(error instanceof WorkerUnavailable)) throw error;
    }
  }
  const budget = Math.max(1, run.budgetMs ?? 30);
  const steps = extractInkSteps(image, options);
  let sliceStart = now();
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    if (now() - sliceStart >= budget) {
      await yieldToMain();
      aborted(run.signal);
      sliceStart = now();
    }
  }
}

/** Atajo: leer el archivo y extraer su tinta. */
export async function extractInkFromFile(
  file: Blob,
  options?: InkOptions,
  run?: InkRunOptions,
  decode?: DecodeOptions,
): Promise<ExtractResult> {
  const decoded = await decodeImageFile(file, decode);
  return extractInkAsync(decoded, options, run);
}

/** PNG (`Blob`) del resultado, dentro de los topes del baul (4096 px y 600 KB; ver `encodeInkPng` para la escalera). */
export async function encodePng(result: ExtractResult | InkImage, options?: EncodeOptions): Promise<Blob> {
  const image = "image" in result ? result.image : result;
  const encoded = await encodeInkPng(image, options);
  return new Blob([encoded.bytes as unknown as BlobPart], { type: "image/png" });
}
