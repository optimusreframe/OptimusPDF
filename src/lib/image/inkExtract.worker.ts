import { InkError, extractInk, type ExtractResult, type InkImage, type InkOptions } from "./inkCore";

/**
 * Web Worker de `extractInkAsync` (imagenes de mas de 4 MP). Recibe `{ id, image, options }` y responde con
 * `{ id, ok: true, result }` (el buffer del resultado viaja por transferencia, sin copia) o `{ id, ok: false, code,
 * message }`. No importa nada del DOM: solo el motor puro de `inkCore.ts`.
 */

export type InkWorkerRequest = { id: number; image: InkImage; options?: InkOptions };
export type InkWorkerResponse =
  | { id: number; ok: true; result: ExtractResult }
  | { id: number; ok: false; code: string; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<InkWorkerRequest>) => void) | null;
  postMessage(message: InkWorkerResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, image, options } = event.data;
  try {
    const result = extractInk(image, options);
    scope.postMessage({ id, ok: true, result }, [result.image.data.buffer as ArrayBuffer]);
  } catch (error) {
    const code = error instanceof InkError ? error.code : "decode-failed";
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id, ok: false, code, message });
  }
};
