import { createBrowserBackend } from "@/lib/image/prepareBackend";
import {
  ImagePrepareError,
  type PrepareBackend,
  prepareImage,
  transcodeImage,
  type ImagePresetId,
  type PreparedImage,
  type TranscodePlan,
  type TranscodeResult,
  type TranscodeRunner,
} from "@/lib/image/prepareForPdf";
import type { PrepareWorkerRequest, PrepareWorkerResponse } from "@/lib/image/prepareImage.worker";

/**
 * Preparacion de fotos en el navegador: `createPrepareSession()` junta el motor puro (`prepareForPdf.ts`), el backend de
 * lienzo (`prepareBackend.ts`) y un Web Worker.
 *
 * Una sesion procesa las fotos de UNA en UNA (la memoria no admite 40 fotos de 48 Mpx decodificadas a la vez):
 *   1. Worker + `OffscreenCanvas` si el navegador los tiene (Chromium, Firefox y Safari 16.4+): el hilo principal queda
 *      libre. Si el worker no arranca, muere o no puede decodificar una imagen, se sigue con el paso 2 para esa foto.
 *   2. Hilo principal con `<canvas>` (y respaldo `<img>` por pasos), cediendo el hilo al navegador antes y despues de cada
 *      foto para que el progreso se pinte y los toques se atiendan.
 * Cancelar (`AbortSignal`) termina el worker en el acto. Todo es local: ninguna peticion de red.
 */

/** Cede el hilo al navegador (y deja pintar / atender toques). */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type WorkerFactory = () => Worker;
let workerFactory: WorkerFactory | null = null;
let workersDisabled = false;
let backendOverride: PrepareBackend | null = null;

/** Solo para pruebas: usa este backend (y ningun worker) en vez del de lienzo del navegador. `null` restaura el normal. */
export function setPrepareBackendOverride(backend: PrepareBackend | null): void {
  backendOverride = backend;
}

/** Solo para pruebas: sustituye la creacion del worker (`null` restaura la normal) o lo desactiva. */
export function setPrepareWorkerFactory(factory: WorkerFactory | null, options: { disabled?: boolean } = {}): void {
  workerFactory = factory;
  workersDisabled = options.disabled === true;
}

function createWorker(): Worker {
  if (workerFactory) return workerFactory();
  return new Worker(new URL("./prepareImage.worker.ts", import.meta.url), { type: "module" });
}

function workerSupported(): boolean {
  if (workersDisabled || backendOverride) return false;
  if (workerFactory) return true;
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

export type PrepareSession = {
  /** Prepara una foto para el PDF (ver `prepareImage`). Rechaza con `ImagePrepareError` si se cancela o no se puede leer. */
  prepare(source: Blob, preset: ImagePresetId, signal?: AbortSignal, fitMaxSide?: number, bakeOrientation?: boolean): Promise<PreparedImage>;
  /** Termina el worker y libera todo. Seguro llamarla varias veces. */
  dispose(): void;
};

export function createPrepareSession(): PrepareSession {
  let worker: Worker | null = null;
  let broken = false;
  let nextId = 1;
  const backend = backendOverride ?? createBrowserBackend();

  const disposeWorker = (): void => {
    if (!worker) return;
    try {
      worker.terminate();
    } catch {
      // Ya terminado.
    }
    worker = null;
  };

  const viaWorker = (source: Blob, plan: TranscodePlan, signal?: AbortSignal): Promise<TranscodeResult | null | "failed"> =>
    new Promise((resolve, reject) => {
      let instance: Worker;
      try {
        if (!worker) worker = createWorker();
        instance = worker;
      } catch {
        broken = true;
        disposeWorker();
        resolve("failed");
        return;
      }
      const id = nextId;
      nextId += 1;
      const cleanup = (): void => {
        instance.removeEventListener("message", onMessage);
        instance.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onMessage = (event: MessageEvent<PrepareWorkerResponse>): void => {
        if (event.data.id !== id) return;
        cleanup();
        if (!event.data.ok) {
          resolve("failed");
          return;
        }
        resolve(event.data.result);
      };
      const onError = (): void => {
        cleanup();
        broken = true;
        disposeWorker();
        resolve("failed");
      };
      const onAbort = (): void => {
        cleanup();
        disposeWorker();
        reject(new ImagePrepareError("cancelled"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      instance.addEventListener("message", onMessage);
      instance.addEventListener("error", onError);
      signal?.addEventListener("abort", onAbort);
      try {
        instance.postMessage({ id, source, plan } satisfies PrepareWorkerRequest);
      } catch {
        cleanup();
        broken = true;
        disposeWorker();
        resolve("failed");
      }
    });

  const run: TranscodeRunner = async (source, plan, signal) => {
    if (!broken && workerSupported()) {
      const viaW = await viaWorker(source, plan, signal);
      if (viaW !== "failed" && viaW !== null) return viaW;
      // `null`: el worker no pudo decodificar esta imagen. Se prueba el respaldo del hilo principal.
    }
    await yieldToMain();
    const result = await transcodeImage(source, plan, backend, signal);
    await yieldToMain();
    return result;
  };

  return {
    prepare: (source, preset, signal, fitMaxSide, bakeOrientation) =>
      prepareImage(source, preset, run, { signal, fitMaxSide, bakeOrientation }),
    dispose: disposeWorker,
  };
}

/** Prepara UNA foto (una sesion de usar y tirar): para quien solo mete una imagen (insertar en Editar, marca de agua). */
export async function prepareImageForPdf(
  source: Blob,
  preset: ImagePresetId,
  options: { signal?: AbortSignal; fitMaxSide?: number; bakeOrientation?: boolean } = {},
): Promise<PreparedImage> {
  const session = createPrepareSession();
  try {
    return await session.prepare(source, preset, options.signal, options.fitMaxSide, options.bakeOrientation);
  } finally {
    session.dispose();
  }
}
