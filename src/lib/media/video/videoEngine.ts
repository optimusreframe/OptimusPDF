import { VideoError, type VideoErrorCode } from "@/lib/media/video/errors";
import type { ConversionPlan } from "@/lib/media/video/plan";
import type { VideoInfo } from "@/lib/media/video/types";
import type { WorkerRequest, WorkerResponse } from "@/lib/media/video/workerProtocol";

/**
 * Puerta de la pagina al motor: lanza la lectura y la conversion en un Web Worker y, si el navegador no deja crear uno (o el
 * script no carga), las ejecuta en el hilo principal con el mismo codigo. Cancelar termina el worker entero: libera de golpe
 * codificador, decodificador y memoria, y la siguiente operacion crea uno nuevo.
 */

export type ProgressListener = (progress: number, processedSeconds: number) => void;

export type VideoEngine = {
  probe(file: File): Promise<VideoInfo>;
  convert(
    file: File,
    plan: ConversionPlan,
    hooks: { onProgress: ProgressListener; signal: AbortSignal },
  ): Promise<{ blob: Blob; audioDropped: boolean }>;
  /** Libera el worker (al salir de la pagina). */
  dispose(): void;
};

export type EngineOptions = {
  /** Solo pruebas: sustituye la creacion del worker. */
  workerFactory?: () => Worker;
  /** Fuerza el camino del hilo principal. */
  inline?: boolean;
};

function newWorker(): Worker {
  return new Worker(new URL("./video.worker.ts", import.meta.url), { type: "module" });
}

export function createVideoEngine(options: EngineOptions = {}): VideoEngine {
  let worker: Worker | null = null;
  let broken = options.inline === true;
  let nextId = 1;
  const active = new Set<() => void>();

  const killWorker = () => {
    if (!worker) return;
    try {
      worker.terminate();
    } catch {
      // Ya terminado.
    }
    worker = null;
  };

  const ensureWorker = (): Worker | null => {
    if (broken) return null;
    if (worker) return worker;
    if (!options.workerFactory && typeof Worker === "undefined") {
      broken = true;
      return null;
    }
    try {
      worker = options.workerFactory ? options.workerFactory() : newWorker();
      return worker;
    } catch {
      broken = true;
      worker = null;
      return null;
    }
  };

  /**
   * Una peticion al worker. Resuelve con la respuesta final; rechaza con `VideoError`. Devuelve `null` si no hay worker o si
   * este fallo al CARGAR antes de contestar nada (entonces se sigue en el hilo principal).
   */
  function request<T extends WorkerResponse["type"]>(
    message: WorkerRequest,
    expect: T,
    options2: { signal?: AbortSignal; onProgress?: ProgressListener; transfer?: Transferable[] },
  ): Promise<Extract<WorkerResponse, { type: T }> | null> {
    const instance = ensureWorker();
    if (!instance) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let answered = false;
      const finish = (action: () => void) => {
        instance.removeEventListener("message", onMessage);
        instance.removeEventListener("error", onError);
        instance.removeEventListener("messageerror", onError);
        options2.signal?.removeEventListener("abort", onAbort);
        active.delete(onAbort);
        action();
      };
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (response.id !== (message as { id: number }).id) return;
        answered = true;
        if (response.type === "progress") {
          options2.onProgress?.(response.progress, response.seconds);
          return;
        }
        if (response.type === "failed") {
          finish(() => reject(new VideoError(response.code, response.message)));
          return;
        }
        if (response.type === expect) finish(() => resolve(response as Extract<WorkerResponse, { type: T }>));
      };
      const onError = () => {
        // Antes de contestar nada = el worker no cargo: se marca roto y se sigue sin el. Despues = fallo del propio trabajo.
        finish(() => {
          killWorker();
          if (!answered) {
            broken = true;
            resolve(null);
          } else reject(new VideoError("failed", "worker error"));
        });
      };
      const onAbort = () => {
        finish(() => {
          killWorker();
          reject(new VideoError("cancelled"));
        });
      };
      if (options2.signal?.aborted) {
        reject(new VideoError("cancelled"));
        return;
      }
      instance.addEventListener("message", onMessage);
      instance.addEventListener("error", onError);
      instance.addEventListener("messageerror", onError);
      options2.signal?.addEventListener("abort", onAbort, { once: true });
      active.add(onAbort);
      try {
        instance.postMessage(message, options2.transfer ?? []);
      } catch {
        finish(() => {
          killWorker();
          broken = true;
          resolve(null);
        });
      }
    });
  }

  return {
    async probe(file) {
      const id = nextId++;
      const answer = await request({ type: "probe", id, file }, "probed", {});
      if (answer) return answer.info;
      const core = await import("@/lib/media/video/convertCore");
      return core.probeVideo(file);
    },
    async convert(file, plan, hooks) {
      const id = nextId++;
      const answer = await request({ type: "convert", id, file, plan }, "converted", { signal: hooks.signal, onProgress: hooks.onProgress });
      if (answer) return { blob: new Blob([answer.buffer], { type: plan.mime }), audioDropped: answer.audioDropped };
      const core = await import("@/lib/media/video/convertCore");
      const outcome = await core.convertVideo(file, plan, { signal: hooks.signal, onProgress: hooks.onProgress });
      return { blob: new Blob([outcome.buffer], { type: plan.mime }), audioDropped: outcome.audioDropped };
    },
    dispose() {
      for (const abort of Array.from(active)) abort();
      killWorker();
    },
  };
}

export type { VideoErrorCode };
