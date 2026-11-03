/**
 * Preparacion de imagenes del autorrelleno desde el hilo principal: la hace un Web Worker (`prepWorker.ts`) y, si el navegador no lo ofrece o
 * falla, la misma funcion en el hilo principal cediendo el hilo entre bandas (nunca queda una pantalla congelada). UNA tarea a la vez; cancelar
 * (`AbortSignal`) aborta la tarea en curso. Los pixeles de entrada NO se tocan (el reintento los vuelve a usar): al worker va una copia.
 */

import type { PrepKind } from "@/lib/autofill/imagePrep";
import type { PrepWorkerRequest, PrepWorkerResponse } from "@/lib/autofill/prepWorker";
import type { Rgba } from "@/lib/scan/pixels";

let worker: Worker | null = null;
/** Hasta cuando no se vuelve a probar el worker tras un fallo (el hilo principal lo sustituye). */
let brokenUntil = 0;
const WORKER_RETRY_MS = 15_000;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Un worker sin tareas durante este tiempo se termina (memoria). */
const WORKER_IDLE_MS = 120_000;

export function disposePrepWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  try {
    worker?.terminate();
  } catch {
    // Ya terminado.
  }
  worker = null;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(disposePrepWorker, WORKER_IDLE_MS);
}

function workerSupported(): boolean {
  return typeof Worker !== "undefined" && Date.now() >= brokenUntil;
}

type ViaWorker = { ok: true; image: Rgba } | { ok: false; code: "cancelled" | "failed" };

function viaWorker(image: Rgba, kind: PrepKind, attempt: number, signal?: AbortSignal): Promise<ViaWorker> {
  return new Promise((resolve) => {
    let instance: Worker;
    try {
      worker ??= new Worker(new URL("./prepWorker.ts", import.meta.url), { type: "module" });
      instance = worker;
    } catch {
      brokenUntil = Date.now() + WORKER_RETRY_MS;
      disposePrepWorker();
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
    const onMessage = (event: MessageEvent<PrepWorkerResponse>): void => {
      if (event.data.id !== id) return;
      cleanup();
      resolve(event.data.ok ? { ok: true, image: { data: new Uint8ClampedArray(event.data.image.data), width: event.data.image.width, height: event.data.image.height } } : { ok: false, code: event.data.code });
    };
    const onError = (): void => {
      cleanup();
      brokenUntil = Date.now() + WORKER_RETRY_MS;
      disposePrepWorker();
      resolve({ ok: false, code: "failed" });
    };
    const onAbort = (): void => {
      try {
        instance.postMessage({ cancel: id } satisfies PrepWorkerRequest);
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
      // Una COPIA de los pixeles viaja al worker (la imagen original se conserva para el reintento).
      const copy = image.data.buffer.slice(0) as ArrayBuffer;
      instance.postMessage({ id, image: { data: copy, width: image.width, height: image.height }, kind, attempt } satisfies PrepWorkerRequest, [copy]);
    } catch {
      cleanup();
      brokenUntil = Date.now() + WORKER_RETRY_MS;
      disposePrepWorker();
      resolve({ ok: false, code: "failed" });
    }
  });
}

/** Prepara `image` para el OCR (ver `imagePrep.ts`). Lanza `AbortError` si se cancela. */
export async function prepareOffThread(image: Rgba, options: { kind: PrepKind; attempt: number; signal?: AbortSignal }): Promise<Rgba> {
  if (workerSupported()) {
    const outcome = await viaWorker(image, options.kind, options.attempt, options.signal);
    if (outcome.ok) return outcome.image;
    if (outcome.code === "cancelled") throw new DOMException("Aborted", "AbortError");
  }
  // Sin worker (o fallo del worker): en el hilo principal, cediendo el hilo entre bandas.
  const { prepareImage } = await import("@/lib/autofill/imagePrep");
  const yieldNow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return (await prepareImage(image, { kind: options.kind, attempt: options.attempt, signal: options.signal, yield: yieldNow })).image;
}
