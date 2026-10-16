import type { InkImage } from "@/lib/image/inkCore";

/**
 * Puente entre la hoja de subida y el motor `inkExtract` (U6.1): carga perezosa (el motor y su worker solo se bajan
 * cuando alguien sube una imagen) y ayudas para MOSTRAR (copia reducida cooperativa, pintar en un canvas).
 * Nada de aqui toca el baul ni guarda la imagen original.
 */

export type InkEngine = typeof import("@/lib/image/inkExtract");

let engine: Promise<InkEngine> | null = null;

/** Carga (una vez) el motor de tinta. */
export function loadInkEngine(): Promise<InkEngine> {
  if (!engine) {
    engine = import("@/lib/image/inkExtract").catch((error: unknown) => {
      engine = null;
      throw error;
    });
  }
  return engine;
}

/** Lado mayor (px) de las copias que solo se muestran en pantalla (el calculo y el guardado usan la imagen entera). */
export const VIEW_MAX_SIDE = 1100;

/**
 * Copia reducida de una imagen para pintarla, hecha por trozos cediendo el hilo (una foto de 12 MP no congela la
 * pantalla). Si ya cabe, devuelve la misma imagen. Cancelable con `signal`.
 */
export async function viewCopy(
  image: InkImage,
  maxSide: number = VIEW_MAX_SIDE,
  signal?: AbortSignal,
): Promise<InkImage> {
  if (Math.max(image.width, image.height) <= maxSide) return image;
  const core = await import("@/lib/image/inkCore");
  const fit = core.fitDimensions(image.width, image.height, maxSide);
  const { yieldToMain } = await loadInkEngine();
  const steps = core.resizeAreaSteps(image, fit.width, fit.height);
  let sliceStart = performance.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() - sliceStart >= 24) {
      await yieldToMain();
      sliceStart = performance.now();
    }
  }
}

/** Pinta una imagen RGBA en un canvas (a su tamano). Sin contexto 2D (p. ej. jsdom) no hace nada y devuelve `false`. */
export function paintImage(canvas: HTMLCanvasElement | null, image: InkImage): boolean {
  if (!canvas) return false;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    context = null;
  }
  if (!context) return false;
  canvas.width = image.width;
  canvas.height = image.height;
  const data = new Uint8ClampedArray(image.data.length);
  data.set(image.data);
  context.putImageData(new ImageData(data, image.width, image.height), 0, 0);
  return true;
}

/** Primeros bytes de un archivo (para reconocer su formato sin decodificarlo). */
export async function sniffFile(file: Blob): Promise<string | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const engineModule = await loadInkEngine();
    return engineModule.sniffImageFormat(head);
  } catch {
    return null;
  }
}
