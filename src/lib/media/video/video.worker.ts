import { convertVideo, probeVideo } from "@/lib/media/video/convertCore";
import { classifyVideoError } from "@/lib/media/video/errors";
import type { WorkerRequest, WorkerResponse } from "@/lib/media/video/workerProtocol";

/**
 * Web Worker del convertidor de video: lee la cabecera y convierte FUERA del hilo principal (la pagina sigue respondiendo y el
 * boton «Cancelar» es inmediato). Una operacion por vez; cancelar desde la pagina termina el worker entero, asi que aqui `cancel`
 * solo aborta la conversion en curso por si la pagina prefiere no terminarlo.
 */

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const controllers = new Map<number, AbortController>();

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    controllers.get(request.id)?.abort();
    return;
  }
  const { id } = request;
  if (request.type === "probe") {
    probeVideo(request.file).then(
      (info) => scope.postMessage({ type: "probed", id, info }),
      (error) => {
        const failure = classifyVideoError(error);
        scope.postMessage({ type: "failed", id, code: failure.code, message: failure.message });
      },
    );
    return;
  }
  const controller = new AbortController();
  controllers.set(id, controller);
  convertVideo(request.file, request.plan, {
    signal: controller.signal,
    onProgress: (progress, seconds) => scope.postMessage({ type: "progress", id, progress, seconds }),
  }).then(
    (outcome) => scope.postMessage({ type: "converted", id, buffer: outcome.buffer, audioDropped: outcome.audioDropped }, [outcome.buffer]),
    (error) => {
      const failure = classifyVideoError(error);
      scope.postMessage({ type: "failed", id, code: failure.code, message: failure.message });
    },
  ).finally(() => controllers.delete(id));
};
