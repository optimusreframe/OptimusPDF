import { preloadDocumentDetection } from "@/lib/scan/documentDetection";
import { runTask, type TaskRequest, type TaskResult } from "@/lib/scan/renderTasks";

/**
 * Web Worker del procesado del Escaner (`renderBrowser.ts`): decodifica, recorta, filtra y codifica FUERA del hilo
 * principal (`createImageBitmap` + `OffscreenCanvas`). Recibe `{ id, request }` y responde `{ id, ok: true, result }` (los
 * pixeles viajan por transferencia) o `{ id, ok: false, code }`; `{ cancel: id }` aborta la tarea en curso (se comprueba
 * entre bandas); `{ warm: true }` precarga el detector.
 */

export type WorkerRequest = { id: number; request: TaskRequest } | { cancel: number } | { warm: true };
export type WorkerResponse = { id: number; ok: true; result: TaskResult } | { id: number; ok: false; code: "cancelled" | "undecodable" | "failed"; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const running = new Map<number, AbortController>();

function transferables(result: TaskResult): Transferable[] {
  const list: Transferable[] = [];
  if (result.kind === "decode" || result.kind === "sample") list.push(result.image.data.buffer);
  if (result.kind === "render" && result.pixels) list.push(result.pixels.data.buffer);
  return list;
}

const yieldWorker = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

scope.onmessage = (event) => {
  const message = event.data;
  if ("warm" in message) {
    // Descarga y evalua el detector (scanic) YA, con conexion: la primera hoja ya no lo espera ni, sin red, lo pierde.
    preloadDocumentDetection();
    return;
  }
  if ("cancel" in message) {
    running.get(message.cancel)?.abort();
    return;
  }
  const { id, request } = message;
  const controller = new AbortController();
  running.set(id, controller);
  runTask(request, { signal: controller.signal, yield: yieldWorker })
    .then((result) => scope.postMessage({ id, ok: true, result }, transferables(result)))
    .catch((error: unknown) => {
      const name = error instanceof Error ? error.name : "";
      const code = name === "AbortError" ? "cancelled" : name === "ScanDecodeError" ? "undecodable" : "failed";
      scope.postMessage({ id, ok: false, code, message: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => running.delete(id));
};
