import { whenNoHeavyWork } from "@/lib/image/heavyWork";
import type { ImageProblem } from "@/lib/image/imageIntegrity";
import { yieldToMain } from "@/lib/image/prepareBrowser";
import { THUMBNAIL_SIDE, buildThumbnail, type ThumbnailOutcome } from "@/lib/image/thumbnailCore";
import type { ThumbnailWorkerRequest, ThumbnailWorkerResponse } from "@/lib/image/thumbnail.worker";

export { THUMBNAIL_SIDE };

/**
 * Miniaturas de las fotos: decodificadas YA reducidas con `createImageBitmap` (el navegador no tiene que decodificar 12-48
 * Mpx = 50-200 MB para pintar 72-220 px) y, ademas, la comprobacion de que cada foto es una imagen completa.
 *
 * El trabajo va a un Web Worker (`thumbnail.worker.ts`): en WebKit la decodificacion se hacia en el hilo principal y
 * congelaba la pantalla 90-390 ms por foto al elegir 40-117 fotos. Sin worker (o si falla), el mismo trabajo corre en el
 * hilo principal CEDIENDO el hilo entre pasos. El worker se cierra tras unos segundos sin trabajo (libera su memoria).
 */

export type ThumbnailInfo = {
  /** Miniatura JPEG; `null` si no se pudo (el que llama usa el archivo original). */
  blob: Blob | null;
  /** Por que la foto no se puede usar (vacia, no es imagen, incompleta, danada, HEIC que este navegador no abre). */
  problem: ImageProblem | null;
};

/** Segundos sin miniaturas pendientes tras los que el worker se cierra. */
const IDLE_MS = 4000;

type WorkerFactory = () => Worker;
let workerFactory: WorkerFactory | null = null;
let workersDisabled = false;

/** Solo para pruebas: sustituye la creacion del worker de miniaturas (`null` restaura la normal) o lo desactiva. */
export function setThumbnailWorkerFactory(factory: WorkerFactory | null, options: { disabled?: boolean } = {}): void {
  workerFactory = factory;
  workersDisabled = options.disabled === true;
  disposeWorker();
  broken = false;
}

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function disposeWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!worker) return;
  try {
    worker.terminate();
  } catch {
    // Ya terminado.
  }
  worker = null;
}

function workerSupported(): boolean {
  if (broken || workersDisabled) return false;
  if (workerFactory) return true;
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = workerFactory ? workerFactory() : new Worker(new URL("./thumbnail.worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    broken = true;
    worker = null;
    return null;
  }
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(disposeWorker, IDLE_MS);
}

/** Una foto en el worker. `null` si el worker no esta o fallo (se usa entonces el hilo principal). */
function viaWorker(file: Blob): Promise<ThumbnailOutcome | null> {
  const instance = workerSupported() ? ensureWorker() : null;
  if (!instance) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = nextId;
    nextId += 1;
    const cleanup = (): void => {
      instance.removeEventListener("message", onMessage);
      instance.removeEventListener("error", onError);
      scheduleIdleClose();
    };
    const onMessage = (event: MessageEvent<ThumbnailWorkerResponse>): void => {
      if (event.data.id !== id) return;
      cleanup();
      resolve(event.data.ok ? { blob: event.data.blob, problem: event.data.problem, heic: event.data.heic } : null);
    };
    const onError = (): void => {
      cleanup();
      broken = true;
      disposeWorker();
      resolve(null);
    };
    instance.addEventListener("message", onMessage);
    instance.addEventListener("error", onError);
    if (idleTimer) clearTimeout(idleTimer);
    try {
      instance.postMessage({ id, source: file, side: THUMBNAIL_SIDE } satisfies ThumbnailWorkerRequest);
    } catch {
      cleanup();
      broken = true;
      disposeWorker();
      resolve(null);
    }
  });
}

/**
 * Hace la miniatura y comprueba la foto: worker primero; si no hay miniatura (el worker no pudo decodificarla) se prueba en el
 * hilo principal antes de dar la foto por mala, porque HEIC, por ejemplo, a veces solo se abre alli.
 */
export async function makeThumbnailInfo(file: Blob): Promise<ThumbnailInfo> {
  if (typeof createImageBitmap !== "function") {
    // Sin decodificador (entornos de prueba): solo la comprobacion de estructura.
    const outcome = await buildThumbnail(file).catch(() => null);
    return { blob: null, problem: outcome?.problem ?? null };
  }
  let outcome = await viaWorker(file);
  if (outcome && (outcome.problem || outcome.blob)) return { blob: outcome.blob, problem: outcome.problem };
  await yieldToMain();
  outcome = await buildThumbnail(file, THUMBNAIL_SIDE, yieldToMain).catch(() => null);
  if (!outcome) return { blob: null, problem: null };
  // HEIC sin miniatura: el navegador no lo abre. Cualquier otro formato sin miniatura se deja pasar (puede que `<img>` si).
  return { blob: outcome.blob, problem: outcome.problem ?? (outcome.heic && !outcome.blob ? "heic" : null) };
}

/** Compatibilidad: solo la miniatura. */
export async function makeThumbnail(file: Blob): Promise<Blob | null> {
  return (await makeThumbnailInfo(file)).blob;
}

/** Cola unica: las miniaturas se hacen de una en una (40 fotos de 12 Mpx decodificadas a la vez agotarian la memoria). */
let chain: Promise<unknown> = Promise.resolve();
const CACHE = new WeakMap<Blob, Promise<ThumbnailInfo>>();

/**
 * Miniatura y estado de `file`, hechos una sola vez (se comparten entre la lista de archivos, el orden de fotos, la vista
 * previa de hojas y el aviso de fotos malas) y en cola: de una en una, cediendo el hilo entre fotos y esperando a que no se
 * esten preparando las fotos del PDF.
 */
export function getThumbnailInfo(file: Blob): Promise<ThumbnailInfo> {
  let promise = CACHE.get(file);
  if (!promise) {
    promise = new Promise<ThumbnailInfo>((resolve) => {
      chain = chain
        .then(() => whenNoHeavyWork())
        .then(() => makeThumbnailInfo(file))
        .then(async (info) => {
          await yieldToMain();
          resolve(info);
        })
        .catch(() => resolve({ blob: null, problem: null }));
    });
    CACHE.set(file, promise);
  }
  return promise;
}

/** Miniatura de `file` (ver `getThumbnailInfo`). */
export async function getThumbnailBlob(file: Blob): Promise<Blob | null> {
  return (await getThumbnailInfo(file)).blob;
}
