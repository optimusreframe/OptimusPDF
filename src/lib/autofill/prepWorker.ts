/**
 * Web Worker de la PREPARACION de imagenes del autorrelleno (`prepClient.ts`): endereza la hoja de una foto, quita sombras, corrige el giro y
 * escala, FUERA del hilo principal (una foto de 8 Mpx son varios cientos de ms de calculo por paso). Recibe `{ id, image, kind, attempt }`
 * (los pixeles viajan por transferencia) y responde `{ id, ok: true, image }` o `{ id, ok: false, code }`; `{ cancel: id }` aborta la tarea.
 * Todo es local: ninguna peticion de red.
 */

import { prepareImage, type PrepKind } from "@/lib/autofill/imagePrep";
import { preloadDocumentDetection } from "@/lib/scan/documentDetection";

export type PrepPixels = { data: ArrayBuffer; width: number; height: number };
export type PrepWorkerRequest = { id: number; image: PrepPixels; kind: PrepKind; attempt: number } | { cancel: number } | { warm: true };
export type PrepWorkerResponse = { id: number; ok: true; image: PrepPixels } | { id: number; ok: false; code: "cancelled" | "failed" };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PrepWorkerRequest>) => void) | null;
  postMessage(message: PrepWorkerResponse, transfer?: Transferable[]): void;
};

const running = new Map<number, AbortController>();
const yieldWorker = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

scope.onmessage = (event) => {
  const message = event.data;
  if ("warm" in message) {
    preloadDocumentDetection();
    return;
  }
  if ("cancel" in message) {
    running.get(message.cancel)?.abort();
    return;
  }
  const { id, image, kind, attempt } = message;
  const controller = new AbortController();
  running.set(id, controller);
  const rgba = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
  prepareImage(rgba, { kind, attempt, signal: controller.signal, yield: yieldWorker })
    .then(({ image: out }) => scope.postMessage({ id, ok: true, image: { data: out.data.buffer, width: out.width, height: out.height } }, [out.data.buffer]))
    .catch((error: unknown) => scope.postMessage({ id, ok: false, code: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed" }))
    .finally(() => running.delete(id));
};
