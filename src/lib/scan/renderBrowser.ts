import { clearTaskCache, runTask, type TaskRequest, type TaskResult } from "@/lib/scan/renderTasks";
import { yieldToMain } from "@/lib/image/prepareBrowser";
import type { WorkerRequest, WorkerResponse } from "@/lib/scan/renderWorker";

/**
 * Cola de procesado del Escaner en el navegador: UNA tarea de pixeles a la vez (la memoria no admite varias fotos de 12 Mpx
 * decodificadas), en un Web Worker con `OffscreenCanvas` cuando existe, y con respaldo al hilo principal (cediendo el hilo
 * entre bandas) si el worker no arranca, muere o el navegador no lo soporta. Cancelar (`AbortSignal`) aborta la tarea en
 * curso (entre bandas) y las que esperan en la cola ni empiezan. Todo es local: ninguna peticion de red.
 */

type WorkerFactory = () => Worker;
let workerFactory: WorkerFactory | null = null;
let workersDisabled = false;

/** Solo para pruebas: sustituye la creacion del worker (`null` restaura la normal) o lo desactiva. */
export function setScanWorkerFactory(factory: WorkerFactory | null, options: { disabled?: boolean } = {}): void {
  workerFactory = factory;
  workersDisabled = options.disabled === true;
  disposeScanWorker();
}

function createWorker(): Worker {
  if (workerFactory) return workerFactory();
  return new Worker(new URL("./renderWorker.ts", import.meta.url), { type: "module" });
}

export function workerSupported(): boolean {
  if (workersDisabled) return false;
  if (workerFactory) return true;
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Un worker sin tareas durante este tiempo se termina (memoria). */
const WORKER_IDLE_MS = 30_000;

export function disposeScanWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // Ya terminado.
    }
  }
  worker = null;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(disposeScanWorker, WORKER_IDLE_MS);
}

export class ScanCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "AbortError";
  }
}

type ViaWorker = { ok: true; result: TaskResult } | { ok: false; code: "cancelled" | "undecodable" | "failed" };

function viaWorker(request: TaskRequest, signal?: AbortSignal): Promise<ViaWorker> {
  return new Promise((resolve) => {
    let instance: Worker;
    try {
      worker ??= createWorker();
      instance = worker;
    } catch {
      broken = true;
      disposeScanWorker();
      resolve({ ok: false, code: "failed" });
      return;
    }
    const id = nextId;
    nextId += 1;
    const cleanup = (): void => {
      instance.removeEventListener("message", onMessage);
      instance.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      touchIdle();
    };
    const onMessage = (event: MessageEvent<WorkerResponse>): void => {
      if (event.data.id !== id) return;
      cleanup();
      resolve(event.data.ok ? { ok: true, result: event.data.result } : { ok: false, code: event.data.code });
    };
    const onError = (): void => {
      cleanup();
      broken = true;
      disposeScanWorker();
      resolve({ ok: false, code: "failed" });
    };
    const onAbort = (): void => {
      try {
        instance.postMessage({ cancel: id } satisfies WorkerRequest);
      } catch {
        // El worker ya no esta.
      }
    };
    if (signal?.aborted) {
      cleanup();
      resolve({ ok: false, code: "cancelled" });
      return;
    }
    instance.addEventListener("message", onMessage);
    instance.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      instance.postMessage({ id, request } satisfies WorkerRequest);
    } catch {
      cleanup();
      broken = true;
      disposeScanWorker();
      resolve({ ok: false, code: "failed" });
    }
  });
}

let tail: Promise<unknown> = Promise.resolve();
let mainThreadRuns = 0;
let workerRuns = 0;

/** Contadores para las pruebas: cuantas tareas fueron al worker y cuantas al hilo principal. */
export function renderStats(): { worker: number; main: number } {
  return { worker: workerRuns, main: mainThreadRuns };
}

async function execute(request: TaskRequest, signal?: AbortSignal): Promise<TaskResult> {
  if (signal?.aborted) throw new ScanCancelled();
  if (!broken && workerSupported()) {
    const outcome = await viaWorker(request, signal);
    if (outcome.ok) {
      workerRuns += 1;
      return outcome.result;
    }
    if (outcome.code === "cancelled") throw new ScanCancelled();
    // `undecodable`/`failed` en el worker: se prueba el respaldo del hilo principal (decodifica por <img>).
  }
  if (signal?.aborted) throw new ScanCancelled();
  await yieldToMain();
  try {
    mainThreadRuns += 1;
    return await runTask(request, { signal, yield: yieldToMain });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new ScanCancelled();
    throw error;
  } finally {
    // La cache de tareas del hilo principal no debe retener una foto grande entre paginas.
    if (request.kind !== "decode") clearTaskCache();
  }
}

/** Encola una tarea de pixeles (de una en una). */
export function enqueueTask(request: TaskRequest, signal?: AbortSignal): Promise<TaskResult> {
  const run = tail.then(
    () => execute(request, signal),
    () => execute(request, signal),
  );
  tail = run.catch(() => undefined);
  return run;
}
