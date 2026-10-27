import { beginHeavyWork } from "@/lib/image/heavyWork";
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

/**
 * Un worker que decodifica fotos grandes acumula memoria (lienzos y bitmaps liberados que WebKit no devuelve hasta que el
 * recolector decide): se cierra y se crea otro cuando ya decodifico tantos pixeles de origen (una foto de 48 Mpx, o ~3 de
 * 12 Mpx). Terminar un worker devuelve su memoria en el acto. Medido en WebKit/iPad con 39 fotos de 24-48 Mpx en «Equilibrada»:
 * el aumento del proceso de la pagina baja de ~470 MB a ~35 MB sin tocar el tiempo (+1 s de 12).
 */
export const WORKER_RECYCLE_PIXELS = 40_000_000;

/** Calibraciones del codificador JPEG ya hechas por algun worker de esta pagina (se reenvian a los workers nuevos). */
const knownCalibration = new Map<number, number>();

/**
 * Un worker que no avisa de que arranco en este tiempo se da por muerto y las fotos siguen en el hilo principal. Sin red, un
 * `new Worker(url)` cuyo script no esta en cache puede no disparar `error` a tiempo (o nunca): la preparacion no puede quedarse
 * colgada sin mensaje.
 */
export const WORKER_START_TIMEOUT_MS = 10_000;

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
  prepare(source: Blob, preset: ImagePresetId, signal?: AbortSignal, fitMaxSide?: number, bakeOrientation?: boolean, strict?: boolean): Promise<PreparedImage>;
  /** Termina el worker y libera todo. Seguro llamarla varias veces. */
  dispose(): void;
};

export function createPrepareSession(): PrepareSession {
  let worker: Worker | null = null;
  /** El worker actual ya envio algun mensaje (arranco bien). */
  let workerAlive = false;
  let broken = false;
  let nextId = 1;
  const backend = backendOverride ?? createBrowserBackend();
  /** Mientras la sesion prepara fotos, las miniaturas en cola esperan (nunca dos decodificaciones grandes a la vez). */
  let endHeavyWork: (() => void) | null = null;

  const disposeWorker = (): void => {
    if (!worker) return;
    try {
      worker.terminate();
    } catch {
      // Ya terminado.
    }
    worker = null;
    workerAlive = false;
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
      let startTimer: ReturnType<typeof setTimeout> | null = null;
      const clearStart = (): void => {
        if (startTimer) clearTimeout(startTimer);
        startTimer = null;
      };
      const cleanup = (): void => {
        clearStart();
        instance.removeEventListener("message", onMessage);
        instance.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onMessage = (event: MessageEvent<PrepareWorkerResponse>): void => {
        // Cualquier mensaje (el «listo» del arranque o la respuesta) prueba que el worker vive.
        workerAlive = true;
        clearStart();
        if (event.data.id !== id) return;
        cleanup();
        if (!event.data.ok) {
          resolve("failed");
          return;
        }
        for (const [key, value] of event.data.calibration ?? []) knownCalibration.set(key, value);
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
      if (!workerAlive) {
        startTimer = setTimeout(() => {
          cleanup();
          broken = true;
          disposeWorker();
          resolve("failed");
        }, WORKER_START_TIMEOUT_MS);
      }
      try {
        instance.postMessage({ id, source, plan, calibration: [...knownCalibration] } satisfies PrepareWorkerRequest);
      } catch {
        cleanup();
        broken = true;
        disposeWorker();
        resolve("failed");
      }
    });

  /** Pixeles de origen decodificados por el worker actual (ver `WORKER_RECYCLE_PIXELS`). */
  let workerPixels = 0;

  const run: TranscodeRunner = async (source, plan, signal) => {
    if (!broken && workerSupported()) {
      const viaW = await viaWorker(source, plan, signal);
      if (plan.hint) workerPixels += plan.hint.width * plan.hint.height;
      if (workerPixels >= WORKER_RECYCLE_PIXELS) {
        disposeWorker();
        workerPixels = 0;
      }
      if (viaW !== "failed" && viaW !== null) return viaW;
      // `null`: el worker no pudo decodificar esta imagen. Se prueba el respaldo del hilo principal.
    }
    await yieldToMain();
    const result = await transcodeImage(source, plan, backend, signal);
    await yieldToMain();
    return result;
  };

  return {
    prepare: (source, preset, signal, fitMaxSide, bakeOrientation, strict) => {
      endHeavyWork ??= beginHeavyWork();
      return prepareImage(source, preset, run, { signal, fitMaxSide, bakeOrientation, strict });
    },
    dispose: () => {
      disposeWorker();
      endHeavyWork?.();
      endHeavyWork = null;
    },
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

/**
 * Precarga el worker de preparacion: lo arranca, espera su aviso de «listo» (el script ya esta en la cache HTTP) y lo cierra.
 * Sirve para que «Nuevo PDF desde imagenes» y compania funcionen aunque la red se corte antes de usarlos. Nunca lanza; devuelve
 * `false` si no hay worker o no arranco a tiempo (entonces las fotos simplemente se preparan en el hilo principal).
 */
export function warmPrepareWorker(timeoutMs = WORKER_START_TIMEOUT_MS): Promise<boolean> {
  if (!workerSupported()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let instance: Worker;
    try {
      instance = createWorker();
    } catch {
      resolve(false);
      return;
    }
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      instance.removeEventListener("message", onMessage);
      instance.removeEventListener("error", onError);
      try {
        instance.terminate();
      } catch {
        // Ya terminado.
      }
      resolve(ok);
    };
    const onMessage = (event: MessageEvent<PrepareWorkerResponse>): void => {
      if ("ready" in event.data && event.data.ready) finish(true);
    };
    const onError = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    instance.addEventListener("message", onMessage);
    instance.addEventListener("error", onError);
  });
}
