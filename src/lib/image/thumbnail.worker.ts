import type { ImageProblem } from "@/lib/image/imageIntegrity";
import { buildThumbnail } from "@/lib/image/thumbnailCore";

/**
 * Web Worker de las miniaturas de fotos (`thumbnail.ts`): lee la foto, comprueba su estructura y la decodifica YA reducida
 * con `createImageBitmap` + `OffscreenCanvas` FUERA del hilo principal (en WebKit esa decodificacion bloqueaba la pantalla
 * 90-390 ms por foto). Recibe `{ id, source, side }` (el `Blob` viaja por referencia) y responde `{ id, ok: true, ... }`.
 */

export type ThumbnailWorkerRequest = { id: number; source: Blob; side: number };
export type ThumbnailWorkerResponse =
  | { id: number; ok: true; blob: Blob | null; problem: ImageProblem | null; heic: boolean }
  | { id: number; ok: false };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ThumbnailWorkerRequest>) => void) | null;
  postMessage(message: ThumbnailWorkerResponse): void;
};

scope.onmessage = (event) => {
  const { id, source, side } = event.data;
  buildThumbnail(source, side)
    .then((outcome) => scope.postMessage({ id, ok: true, ...outcome }))
    .catch(() => scope.postMessage({ id, ok: false }));
};
