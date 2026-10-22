import { yieldToMain } from "@/lib/image/prepareBrowser";

/** Lado largo (px) de las miniaturas: se ven nitidas a 150-220 px CSS con pantalla de alta densidad. */
export const THUMBNAIL_SIDE = 360;

/**
 * Miniatura pequena (JPEG de ~15 KB) de una foto, decodificada YA reducida con `createImageBitmap`: el navegador no tiene
 * que decodificar la foto entera (12-48 Mpx = 50-200 MB) solo para pintar una vista previa de 72-220 px. `null` si el
 * navegador no puede (el que llama usa entonces el archivo original).
 */
export async function makeThumbnail(file: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    // Solo `resizeWidth` con la imagen YA girada: el navegador calcula el alto con su proporcion; se acota despues el lado largo.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: THUMBNAIL_SIDE, resizeQuality: "medium" });
    const scale = Math.min(1, THUMBNAIL_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  } catch {
    return null;
  }
}

/** Cola unica: las miniaturas se hacen de una en una (40 fotos de 12 Mpx decodificadas a la vez agotarian la memoria). */
let chain: Promise<unknown> = Promise.resolve();
const CACHE = new WeakMap<Blob, Promise<Blob | null>>();

/**
 * Miniatura de `file`, hecha una sola vez (se comparte entre la lista de archivos, el orden de fotos y la vista previa de
 * hojas) y en cola: de una en una y cediendo el hilo entre fotos para no bloquear la pantalla.
 */
export function getThumbnailBlob(file: Blob): Promise<Blob | null> {
  let promise = CACHE.get(file);
  if (!promise) {
    promise = new Promise<Blob | null>((resolve) => {
      chain = chain
        .then(() => makeThumbnail(file))
        .then(async (blob) => {
          await yieldToMain();
          resolve(blob);
        })
        .catch(() => resolve(null));
    });
    CACHE.set(file, promise);
  }
  return promise;
}
