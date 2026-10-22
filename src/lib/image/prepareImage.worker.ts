import { createBrowserBackend } from "@/lib/image/prepareBackend";
import { transcodeImage, type RasterScan, type TranscodePlan } from "@/lib/image/prepareForPdf";

/**
 * Web Worker de la preparacion de fotos (`prepareBrowser.ts`): decodifica, reduce y reencoda FUERA del hilo principal
 * con `createImageBitmap` + `OffscreenCanvas`, para que ni la decodificacion de una foto de 48 Mpx ni su codificacion JPEG
 * bloqueen la pantalla (en iPad/iPhone una tarea larga se nota como un tirón del progreso y de los toques).
 *
 * Recibe `{ id, source, plan }` (el `Blob` viaja por referencia, sin copiar) y responde con `{ id, ok: true, result }`
 * (los bytes viajan por transferencia) o `{ id, ok: true, result: null }` cuando este motor no pudo decodificar la
 * imagen (el hilo principal prueba entonces su propio respaldo) o `{ id, ok: false }` ante un fallo inesperado.
 */

export type PrepareWorkerRequest = { id: number; source: Blob; plan: TranscodePlan };
export type PrepareWorkerResult = {
  format: "jpeg" | "png";
  bytes: Uint8Array;
  width: number;
  height: number;
  scanned: RasterScan | null;
};
export type PrepareWorkerResponse =
  | { id: number; ok: true; result: PrepareWorkerResult | null }
  | { id: number; ok: false; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PrepareWorkerRequest>) => void) | null;
  postMessage(message: PrepareWorkerResponse, transfer?: Transferable[]): void;
};

const backend = createBrowserBackend();

scope.onmessage = (event) => {
  const { id, source, plan } = event.data;
  transcodeImage(source, plan, backend)
    .then((result) => {
      if (!result) {
        scope.postMessage({ id, ok: true, result: null });
        return;
      }
      scope.postMessage({ id, ok: true, result }, [result.bytes.buffer as ArrayBuffer]);
    })
    .catch((error: unknown) => {
      scope.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
    });
};
