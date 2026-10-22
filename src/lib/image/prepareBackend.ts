import {
  CALIBRATION_REFERENCE,
  CALIBRATION_SIZE,
  calibrationPixels,
  pickCalibratedQuality,
  referenceBytesFor,
} from "@/lib/image/jpegCalibration";
import {
  fitWithin,
  planDownscaleSteps,
  type DecodeRequest,
  type PrepareBackend,
  type Raster,
} from "@/lib/image/prepareForPdf";

/**
 * Backend de navegador de `prepareForPdf.ts`: decodifica YA reducido y codifica. Funciona igual en el hilo principal
 * (lienzo `<canvas>`) y dentro de un Web Worker (`OffscreenCanvas`), asi que `prepareImage.worker.ts` lo reutiliza.
 *
 * Decodificar: `createImageBitmap(blob, { imageOrientation: "from-image", resizeWidth, resizeQuality: "high" })` deja
 * que el navegador reduzca mientras decodifica (no hay que tener la foto entera de 48 Mpx en memoria a la vez en los
 * motores que lo hacen bien). Se pide SOLO `resizeWidth`: el alto lo calcula el navegador con la proporcion de la imagen
 * YA girada, asi que si el navegador ignorara la orientacion o la reduccion, el tamano devuelto no coincidiria con el
 * esperado y se detecta (se usa entonces el respaldo, nunca una foto deformada o girada).
 * Respaldo (solo hilo principal): `<img>` + lienzo reducido POR PASOS (`planDownscaleSteps`: cada paso, como mucho, a la
 * mitad y ningun lienzo pasa de los topes de iOS).
 *
 * (No se codifica el `ImageBitmap` directamente desde un lienzo `bitmaprenderer`: en Chromium el bitmap conserva los pixeles
 * SIN girar y la orientacion EXIF se aplica al dibujarlo, asi que esa via entregaba la foto sin girar.)
 *
 * Memoria: se libera todo en cuanto se usa (`bitmap.close()`, `canvas.width = 0`): en WebKit un lienzo sin liberar sigue
 * ocupando memoria hasta el recolector.
 */

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Drawable = ImageBitmap | HTMLImageElement | Canvas2D;

type Surface = { canvas: Canvas2D; context: Context2D; width: number; height: number };

function createSurface(width: number, height: number, willRead: boolean): Surface | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", willRead ? { willReadFrequently: true } : undefined);
      if (!context) return null;
      return { canvas, context, width: w, height: h };
    }
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext("2d", willRead ? { willReadFrequently: true } : undefined);
      if (!context) return null;
      return { canvas, context, width: w, height: h };
    }
  } catch {
    return null;
  }
  return null;
}

function releaseSurface(surface: Surface | null): void {
  if (!surface) return;
  try {
    surface.canvas.width = 0;
    surface.canvas.height = 0;
  } catch {
    // Ya liberado.
  }
}

async function canvasToBytes(canvas: Canvas2D, type: string, quality: number): Promise<Uint8Array> {
  let blob: Blob | null;
  if ("convertToBlob" in canvas) {
    blob = await canvas.convertToBlob({ type, quality });
  } else {
    blob = await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, type, quality));
  }
  if (!blob || blob.size === 0) throw new Error("canvas encode returned an empty blob");
  // El navegador debe haber entregado el formato pedido (un motor sin JPEG devolveria PNG): se comprueba.
  if (blob.type && blob.type !== type) throw new Error(`canvas encoded ${blob.type} instead of ${type}`);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Calidad JPEG con la que este navegador pesa lo mismo que Chromium (ver `jpegCalibration.ts`). Se calcula una vez por
 * calidad y por contexto (hilo principal o worker); si la calibracion falla se usa la calidad pedida.
 */
const calibrated = new Map<number, Promise<number>>();
function calibratedQuality(quality: number): Promise<number> {
  const key = Math.round(quality * 1000);
  let pending = calibrated.get(key);
  if (!pending) {
    pending = (async () => {
      const surface = createSurface(CALIBRATION_SIZE, CALIBRATION_SIZE, false);
      if (!surface) return quality;
      try {
        const pixels = calibrationPixels();
        // `ImageData` existe en el hilo principal y en workers.
        surface.context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, CALIBRATION_SIZE, CALIBRATION_SIZE), 0, 0);
        return await pickCalibratedQuality(quality, referenceBytesFor(quality, CALIBRATION_REFERENCE), async (q) => (await canvasToBytes(surface.canvas, "image/jpeg", q)).byteLength);
      } catch {
        return quality;
      } finally {
        releaseSurface(surface);
      }
    })();
    calibrated.set(key, pending);
  }
  return pending;
}

class CanvasRaster implements Raster {
  private surface: Surface | null;
  readonly width: number;
  readonly height: number;

  constructor(surface: Surface) {
    this.surface = surface;
    this.width = surface.width;
    this.height = surface.height;
  }

  rows(from: number, to: number): Uint8ClampedArray {
    if (!this.surface) throw new Error("raster released");
    return this.surface.context.getImageData(0, from, this.width, Math.max(1, to - from)).data;
  }

  async encode(format: "jpeg" | "png", quality: number, flatten: boolean): Promise<Uint8Array> {
    const surface = this.surface;
    if (!surface) throw new Error("raster released");
    if (flatten) {
      // Fondo blanco DETRAS de lo ya pintado: asi la transparencia trivial no sale negra en el JPEG.
      surface.context.globalCompositeOperation = "destination-over";
      surface.context.fillStyle = "#ffffff";
      surface.context.fillRect(0, 0, this.width, this.height);
      surface.context.globalCompositeOperation = "source-over";
    }
    if (format === "png") return canvasToBytes(surface.canvas, "image/png", quality);
    return canvasToBytes(surface.canvas, "image/jpeg", await calibratedQuality(quality));
  }

  release(): void {
    releaseSurface(this.surface);
    this.surface = null;
  }
}

function closeDrawable(drawable: Drawable): void {
  if (typeof ImageBitmap !== "undefined" && drawable instanceof ImageBitmap) {
    drawable.close();
    return;
  }
  if (typeof HTMLImageElement !== "undefined" && drawable instanceof HTMLImageElement) {
    const url = drawable.src;
    drawable.removeAttribute("src");
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    return;
  }
  const canvas = drawable as Canvas2D;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Nada que liberar.
  }
}

/**
 * Pinta `drawable` (de `sourceWidth` x `sourceHeight`) en un lienzo de `target`, por pasos si hace falta. Consume y libera
 * `drawable`. `null` si no se pudo crear un lienzo.
 */
function renderScaled(
  drawable: Drawable,
  sourceWidth: number,
  sourceHeight: number,
  target: { width: number; height: number },
  willRead: boolean,
): Surface | null {
  const steps = planDownscaleSteps(sourceWidth, sourceHeight, target.width, target.height);
  let current: Drawable = drawable;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;
  let result: Surface | null = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const last = index === steps.length - 1;
    const surface = createSurface(step.width, step.height, willRead && last);
    if (!surface) {
      closeDrawable(current);
      return null;
    }
    surface.context.imageSmoothingEnabled = true;
    surface.context.imageSmoothingQuality = "high";
    surface.context.drawImage(current as CanvasImageSource, 0, 0, currentWidth, currentHeight, 0, 0, step.width, step.height);
    closeDrawable(current);
    current = surface.canvas;
    currentWidth = step.width;
    currentHeight = step.height;
    result = surface;
  }
  return result;
}

/** Decodifica con `createImageBitmap` ya reducido y girado. `null` si el navegador no lo hace bien. */
async function decodeNative(
  source: Blob,
  expected: { width: number; height: number } | null,
  resize: { width: number } | null,
): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    const options: ImageBitmapOptions = { imageOrientation: "from-image" };
    if (resize) {
      options.resizeWidth = resize.width;
      options.resizeQuality = "high";
    }
    bitmap = await createImageBitmap(source, options);
  } catch {
    return null;
  }
  if (expected && (Math.abs(bitmap.width - expected.width) > 1 || Math.abs(bitmap.height - expected.height) > 1)) {
    // El navegador no reduce o no gira como se le pidio: no nos fiamos de la imagen.
    bitmap.close();
    return null;
  }
  return bitmap;
}

/** Respaldo: `<img>` (el navegador aplica la orientacion EXIF al decodificar). Solo en el hilo principal. */
async function decodeViaImage(source: Blob, signal?: AbortSignal): Promise<{ image: HTMLImageElement; width: number; height: number } | null> {
  if (typeof document === "undefined" || typeof Image === "undefined" || typeof createImageBitmap !== "function") return null;
  const url = URL.createObjectURL(source);
  const image = new Image();
  image.decoding = "async";
  try {
    image.src = url;
    if (typeof image.decode === "function") await image.decode();
    else
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("image decode failed"));
      });
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  if (signal?.aborted || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    closeDrawable(image);
    return null;
  }
  return { image, width: image.naturalWidth, height: image.naturalHeight };
}

export function createBrowserBackend(): PrepareBackend {
  return {
    async decode(source: Blob, request: DecodeRequest, signal?: AbortSignal): Promise<Raster | null> {
      const hint = request.hint;
      const expected = hint ? fitWithin(hint.width, hint.height, request.maxSide, request.maxPixels) : null;

      // 1. Nativo: el navegador decodifica, gira y reduce.
      const bitmap = await decodeNative(
        source,
        expected,
        expected && expected.scale < 1 ? { width: expected.width } : null,
      );
      if (bitmap) {
        const target = fitWithin(bitmap.width, bitmap.height, request.maxSide, request.maxPixels);
        const surface = renderScaled(bitmap, bitmap.width, bitmap.height, target, request.willRead);
        return surface ? new CanvasRaster(surface) : null;
      }

      // 2. Respaldo: <img> y reduccion por pasos (solo hilo principal; en un worker se devuelve `null`).
      const decoded = await decodeViaImage(source, signal);
      if (!decoded) return null;
      // Una orientacion EXIF que cambia ancho por alto y que este navegador no aplico daria una foto girada: no se usa.
      if (hint && request.orientation >= 5 && decoded.width === hint.height && decoded.height === hint.width && hint.width !== hint.height) {
        closeDrawable(decoded.image);
        return null;
      }
      const target = fitWithin(decoded.width, decoded.height, request.maxSide, request.maxPixels);
      const surface = renderScaled(decoded.image, decoded.width, decoded.height, target, request.willRead);
      return surface ? new CanvasRaster(surface) : null;
    },
  };
}
