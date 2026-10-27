import { checkImageBytes, type ImageProblem } from "@/lib/image/imageIntegrity";
import { ESTIMATE_HEAD_BYTES, readImageHeader } from "@/lib/image/prepareForPdf";

/**
 * Nucleo de la miniatura de una foto, compartido por el Web Worker (`thumbnail.worker.ts`, donde corre casi siempre) y por
 * el respaldo del hilo principal (`thumbnail.ts`): lee los bytes, comprueba que la foto es una imagen COMPLETA
 * (`checkImageBytes`) y, si lo es, la decodifica YA reducida con `createImageBitmap` y la codifica como JPEG pequeno.
 *
 * Por que un worker: en WebKit (iPhone/iPad) `createImageBitmap` decodifica la foto en el hilo que la pide; con fotos de
 * 12-48 Mpx eran paradas de 90-390 ms por foto en el hilo principal (la pantalla se congelaba al elegir 40-117 fotos).
 */

/** Lado largo (px) de las miniaturas: se ven nitidas a 150-220 px CSS con pantalla de alta densidad. */
export const THUMBNAIL_SIDE = 360;
const THUMBNAIL_QUALITY = 0.78;

export type ThumbnailOutcome = {
  /** Miniatura JPEG, o `null` si no se pudo (estructura mala o el navegador no la decodifica). */
  blob: Blob | null;
  /** Problema de ESTRUCTURA (vacia, no es imagen, incompleta, danada); `null` si el archivo esta bien. */
  problem: ImageProblem | null;
  /** El archivo es HEIC/HEIF (si no hay miniatura, es que este navegador no lo abre). */
  heic: boolean;
};

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): Canvas2D | null {
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  } catch {
    return null;
  }
  return null;
}

async function encodeJpeg(canvas: Canvas2D): Promise<Blob | null> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality: THUMBNAIL_QUALITY });
  return new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, "image/jpeg", THUMBNAIL_QUALITY));
}

/**
 * Miniatura JPEG de `file`. `display` son las dimensiones VISTAS (con la orientacion aplicada) si se conocen: con ellas el
 * navegador decodifica directamente a la miniatura, sin un segundo reescalado para las fotos verticales.
 */
export async function renderThumbnail(file: Blob, display: { width: number; height: number } | null, side = THUMBNAIL_SIDE): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  let canvas: Canvas2D | null = null;
  try {
    const wide = !display || display.width >= display.height;
    const resizeWidth = wide || !display ? side : Math.max(1, Math.round((side * display.width) / display.height));
    // Solo `resizeWidth` con la imagen YA girada: el navegador calcula el alto con su proporcion; se acota despues el lado largo.
    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: display && display.width <= resizeWidth ? undefined : resizeWidth,
      resizeQuality: "medium",
    });
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    canvas = createCanvas(width, height);
    const context = canvas?.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
    if (!canvas || !context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    bitmap = null;
    const blob = await encodeJpeg(canvas);
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/**
 * Lee `source`, comprueba su estructura y le hace la miniatura. `pause` (opcional) cede el hilo entre pasos: solo lo usa el
 * respaldo del hilo principal. Nunca lanza.
 */
export async function buildThumbnail(source: Blob, side = THUMBNAIL_SIDE, pause?: () => Promise<void>): Promise<ThumbnailOutcome> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await source.arrayBuffer());
  } catch {
    // Sin poder leer el archivo no se le puede reprochar nada: se intenta decodificar directamente.
    return { blob: await renderThumbnail(source, null, side), problem: null, heic: false };
  }
  await pause?.();
  const verdict = checkImageBytes(bytes);
  if (!verdict.ok) return { blob: null, problem: verdict.problem, heic: false };
  await pause?.();
  const header = readImageHeader(bytes.subarray(0, Math.min(bytes.length, ESTIMATE_HEAD_BYTES)));
  const display = header.displayWidth && header.displayHeight ? { width: header.displayWidth, height: header.displayHeight } : null;
  const blob = await renderThumbnail(source, display, side);
  return { blob, problem: null, heic: header.kind === "heic" };
}
