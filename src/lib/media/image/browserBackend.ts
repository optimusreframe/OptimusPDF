import { planDownscaleSteps } from "@/lib/image/prepareForPdf";
import { isIosWebKit } from "@/lib/image/platform";
import { encodeBmp } from "@/lib/media/image/bmp";
import { ImageConvertError, type ImageBackend, type RenderJob, type RenderResult } from "@/lib/media/image/convert";
import { BASELINE_SUPPORT, OUTPUT_FORMAT_INFO, type OutputFormat, type OutputSupport } from "@/lib/media/image/formats";
import { limitsFor, type ConvertLimits } from "@/lib/media/image/sizing";
import { PdfError } from "@/lib/pdf/core";

/**
 * Backend de navegador del convertidor de imagenes (lienzo `<canvas>`, hilo principal).
 *
 * Por que NO hay Web Worker (a diferencia de las miniaturas y de Imagenes a PDF): aqui las operaciones caras ya son asincronas y
 * salen del hilo principal por si solas (`createImageBitmap` decodifica fuera de el y `canvas.toBlob` codifica fuera de el en
 * Chromium, Firefox y Safari); el unico tramo sincrono grande es `getImageData` del BMP, que se acota por pixeles
 * (`BMP_MAX_PIXELS`). Entre archivos el motor cede el hilo, asi que el progreso se pinta y la cancelacion responde. Un worker
 * solo anadiria un segundo camino de codigo (y su respaldo) para una ganancia que no se midio.
 *
 * Decodificar: `createImageBitmap(file, { imageOrientation: "from-image" })` aplica la orientacion EXIF y toma el primer
 * fotograma de un GIF; si el navegador rechaza la opcion se prueba sin ella, y si no abre el archivo (HEIC fuera de Safari, un
 * AVIF viejo) se prueba con `<img>` + `decode()`. Reducir: `planDownscaleSteps` (pasos de mitad exacta) con `drawImage`,
 * liberando cada lienzo y cada bitmap en cuanto se usa.
 *
 * Salida: el lienzo trabaja en sRGB y no lleva EXIF, GPS ni perfil de color: los metadatos NO pasan a la salida.
 */

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Drawable = ImageBitmap | HTMLImageElement | Canvas2D;
type Surface = { canvas: Canvas2D; context: Context2D };

function createSurface(width: number, height: number): Surface | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { colorSpace: "srgb" });
      return context ? { canvas, context } : null;
    }
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext("2d", { colorSpace: "srgb" });
      return context ? { canvas, context } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** En WebKit un lienzo sin liberar sigue ocupando memoria hasta el recolector: se cierra el bitmap y se encoge el lienzo a 0. */
function release(item: Drawable | null): void {
  if (!item) return;
  try {
    if (typeof ImageBitmap !== "undefined" && item instanceof ImageBitmap) item.close();
    else if (
      (typeof HTMLCanvasElement !== "undefined" && item instanceof HTMLCanvasElement) ||
      (typeof OffscreenCanvas !== "undefined" && item instanceof OffscreenCanvas)
    ) {
      item.width = 0;
      item.height = 0;
    }
  } catch {
    // Ya liberado.
  }
}

/** Cancelar responde al instante aunque la decodificacion o la codificacion tarden. */
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new PdfError("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new PdfError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type Decoded = { source: ImageBitmap | HTMLImageElement; width: number; height: number };

async function decodeWithImageElement(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!(width > 0 && height > 0)) throw new Error("empty image");
    return { source: image, width, height };
  } finally {
    // El `<img>` ya decodificado se sigue pudiendo dibujar sin la URL.
    URL.revokeObjectURL(url);
  }
}

/** Abre el archivo con lo que el navegador tenga; rechaza `ImageConvertError("unreadable")` si ninguna via lo abre. */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    for (const attempt of [{ imageOrientation: "from-image" as const }, undefined]) {
      try {
        const bitmap = attempt ? await createImageBitmap(file, attempt) : await createImageBitmap(file);
        if (bitmap.width > 0 && bitmap.height > 0) return { source: bitmap, width: bitmap.width, height: bitmap.height };
        bitmap.close();
      } catch {
        // Siguiente via.
      }
    }
  }
  try {
    return await decodeWithImageElement(file);
  } catch {
    throw new ImageConvertError("unreadable");
  }
}

async function canvasToBlob(canvas: Canvas2D, mime: string, quality: number | undefined): Promise<Blob | null> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: mime, quality });
  return new Promise<Blob | null>((resolve) => {
    try {
      (canvas as HTMLCanvasElement).toBlob(resolve, mime, quality);
    } catch {
      resolve(null);
    }
  });
}

/** Codifica y comprueba que el navegador entrego el formato pedido (uno que no lo sabe devuelve PNG sin avisar). */
async function encode(surface: Surface, format: OutputFormat, quality: number, flatten: string | null): Promise<Blob> {
  const info = OUTPUT_FORMAT_INFO[format];
  if (format === "bmp") {
    const { width, height } = surface.canvas;
    const pixels = surface.context.getImageData(0, 0, width, height);
    const bytes = encodeBmp(pixels.data, width, height, flatten ?? "#ffffff");
    return new Blob([bytes as BlobPart], { type: info.mime });
  }
  const blob = await canvasToBlob(surface.canvas, info.mime, info.lossy ? quality : undefined);
  if (!blob || blob.size === 0) throw new ImageConvertError("encodeFailed");
  if (blob.type && blob.type !== info.mime) throw new ImageConvertError("encodeFailed");
  return blob;
}

export function createBrowserBackend(limits: ConvertLimits = limitsFor(isIosWebKit())): ImageBackend {
  const render = async (file: Blob, job: RenderJob, signal?: AbortSignal): Promise<RenderResult> => {
    let decoded: Decoded | null = null;
    /** Lienzo del paso anterior (el ultimo, al terminar el bucle, es el que se codifica). */
    let previous: Surface | null = null;
    try {
      decoded = await raceAbort(decode(file), signal);
      const size = job.planSize({ width: decoded.width, height: decoded.height });
      const steps = planDownscaleSteps(decoded.width, decoded.height, size.width, size.height, limits.maxCanvasSide, limits.maxCanvasPixels);
      for (let index = 0; index < steps.length; index += 1) {
        if (signal?.aborted) throw new PdfError("cancelled");
        const step = steps[index];
        const surface = createSurface(step.width, step.height);
        if (!surface) throw new ImageConvertError("encodeFailed");
        surface.context.imageSmoothingEnabled = true;
        surface.context.imageSmoothingQuality = "high";
        // Solo el ultimo paso aplana la transparencia (los intermedios la conservan para no ensuciar los bordes).
        if (index === steps.length - 1 && job.flatten) {
          surface.context.fillStyle = job.flatten;
          surface.context.fillRect(0, 0, step.width, step.height);
        }
        surface.context.drawImage(previous ? previous.canvas : decoded.source, 0, 0, step.width, step.height);
        // Lo que ya se dibujo se libera al instante: el pico es el original + un lienzo, no toda la cadena.
        release(previous ? previous.canvas : decoded.source);
        previous = surface;
      }
      if (!previous) throw new ImageConvertError("encodeFailed");
      const blob = await raceAbort(encode(previous, job.format, job.quality, job.flatten), signal);
      return { blob, sourceWidth: decoded.width, sourceHeight: decoded.height, width: size.width, height: size.height, capped: size.capped };
    } finally {
      if (previous) release(previous.canvas);
      if (decoded) release(decoded.source);
    }
  };
  return { render };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Que formatos sabe crear ESTE navegador                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

let supportPromise: Promise<OutputSupport> | null = null;

async function canEncode(format: OutputFormat): Promise<boolean> {
  if (format === "bmp") return true;
  const surface = createSurface(2, 2);
  if (!surface) return false;
  try {
    surface.context.fillStyle = "#336699";
    surface.context.fillRect(0, 0, 2, 2);
    const info = OUTPUT_FORMAT_INFO[format];
    const blob = await canvasToBlob(surface.canvas, info.mime, info.lossy ? 0.8 : undefined);
    return !!blob && blob.size > 0 && blob.type === info.mime;
  } catch {
    return false;
  } finally {
    release(surface.canvas);
  }
}

/**
 * Prueba UNA vez por pagina (la respuesta no cambia) que formatos codifica `canvas.toBlob` de este navegador. Es deteccion de
 * capacidad, no de navegador: Chromium crea WebP pero no AVIF, Safari al reves segun la version, y el dia que cambien la prueba
 * lo sabe sin tocar el codigo.
 */
export function probeOutputSupport(): Promise<OutputSupport> {
  supportPromise ??= (async () => {
    const [jpeg, png, webp, avif] = await Promise.all([canEncode("jpeg"), canEncode("png"), canEncode("webp"), canEncode("avif")]);
    return { ...BASELINE_SUPPORT, jpeg, png, webp, avif };
  })().catch(() => BASELINE_SUPPORT);
  return supportPromise;
}

/** Solo para pruebas: olvida la respuesta guardada. */
export function resetOutputSupportCache(): void {
  supportPromise = null;
}

/** Cede el hilo al navegador (y deja pintar el progreso / atender toques) entre dos imagenes. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
