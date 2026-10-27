import {
  CALIBRATION_KINDS,
  CALIBRATION_MEAN_TOLERANCE,
  calibrationPixels,
  calibrationSize,
  geometricMeanRatio,
  pickCalibratedQuality,
  type CalibrationKind,
} from "@/lib/image/jpegCalibration";
import {
  fitWithin,
  planDownscaleSteps,
  planNativeDecodeWidth,
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
 *
 * Reduccion SIN aliasing en todos los motores: el reductor nativo de WebKit (iPhone/iPad) NO filtra (submuestrea: un
 * patron de 2 px conserva 0,8-0,9 del contraste, Chromium ~0,06; una panoramica a 0,25x baja de 40 a 36 dB y los
 * morteros salen en dientes con halos al ampliar). Por eso `nativeResizeFilters()` lo comprueba UNA vez con una imagen
 * de prueba (deteccion de capacidad, no de navegador): si filtra (Chromium), la reduccion nativa va directa al objetivo;
 * si no (WebKit), se decodifica al doble del objetivo (`planNativeDecodeWidth`: la reduccion nativa queda por encima de
 * 0,5x, sin aliasing) y `drawImage` baja por PASOS DE MITAD exacta (promedio 2x2) hasta el objetivo, liberando cada
 * lienzo y cada bitmap al instante (el pico es el bitmap del doble del objetivo, 108 MB para 48 Mpx, no los 195 MB de
 * decodificarla entera).
 * Respaldo (solo hilo principal): `<img>` + lienzo reducido POR PASOS (`planDownscaleSteps`: cada paso reduce a la
 * mitad exacta y ningun lienzo pasa de los topes de iOS).
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

/**
 * Opciones del contexto 2D. `colorSpace: "srgb"` es el valor por defecto de los lienzos; se pide explicito porque es lo que
 * se quiere: un PDF trabaja en sRGB (DeviceRGB) y una foto Display P3 se convierte al dibujarla (los colores muy intensos se
 * recortan). Medido en Chromium y WebKit de Playwright EN MODO SIN PANTALLA (headless): los valores de una foto P3 pasan sin
 * conversion ni perfil, igual que con «Original» (sin regresion); la conversion real depende de la gestion de color del
 * navegador/pantalla y no se pudo observar ahi. El texto de ayuda lo dice con esa prudencia (`colorNote`).
 */
function contextOptions(willRead: boolean): CanvasRenderingContext2DSettings {
  return willRead ? { willReadFrequently: true, colorSpace: "srgb" } : { colorSpace: "srgb" };
}

function createSurface(width: number, height: number, willRead: boolean): Surface | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", contextOptions(willRead));
      if (!context) return null;
      return { canvas, context, width: w, height: h };
    }
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext("2d", contextOptions(willRead));
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
/** Calidades ya calibradas (clave en milesimas): se exportan al hilo principal para que un worker nuevo no repita la calibracion. */
const calibratedValues = new Map<number, number>();

/** Calibraciones ya hechas en este contexto, para pasarlas a otro (`[calidad x 1000, calidad calibrada]`). */
export function exportCalibration(): Array<[number, number]> {
  return [...calibratedValues];
}

/** Da por hechas calibraciones de otro contexto (el mismo navegador da el mismo resultado: es determinista). */
export function seedCalibration(entries: ReadonlyArray<readonly [number, number]> | undefined): void {
  for (const [key, value] of entries ?? []) {
    if (!calibrated.has(key) && Number.isFinite(value)) {
      calibrated.set(key, Promise.resolve(value));
      calibratedValues.set(key, value);
    }
  }
}

function calibratedQuality(quality: number): Promise<number> {
  const key = Math.round(quality * 1000);
  let pending = calibrated.get(key);
  if (!pending) {
    pending = (async () => {
      const surfaces = new Map<CalibrationKind, Surface>();
      try {
        for (const kind of CALIBRATION_KINDS) {
          const size = calibrationSize(kind);
          const surface = createSurface(size, size, false);
          if (!surface) return quality;
          surfaces.set(kind, surface);
          // `ImageData` existe en el hilo principal y en workers.
          surface.context.putImageData(new ImageData(calibrationPixels(kind) as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
        }
        // Se iguala la media geometrica de los pesos de las tres imagenes de prueba con la de Chromium: el cociente WebKit/Chromium
        // depende del contenido (1,8-2,6 segun la imagen), una sola imagen dejaba +8-60 % en las fotos reales.
        return await pickCalibratedQuality(
          quality,
          1,
          async (q) => {
            const measured = {} as Record<CalibrationKind, number>;
            for (const kind of CALIBRATION_KINDS) measured[kind] = (await canvasToBytes((surfaces.get(kind) as Surface).canvas, "image/jpeg", q)).byteLength;
            return geometricMeanRatio(quality, measured);
          },
          CALIBRATION_MEAN_TOLERANCE,
        );
      } catch {
        return quality;
      } finally {
        for (const surface of surfaces.values()) releaseSurface(surface);
      }
    })();
    calibrated.set(key, pending);
    void pending.then((value) => calibratedValues.set(key, value));
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

/**
 * ¿El reductor de `createImageBitmap({ resizeQuality: "high" })` de este motor FILTRA (promedia) al reducir mucho?
 * Se prueba con un JPEG de columnas alternas de 1 px (periodo 2 px) reducido a 0,375x: un reductor con filtro lo deja casi
 * liso (Chromium: contraste ~0,05); uno que submuestrea conserva el patron (WebKit: ~0,66). Se calcula una vez por contexto
 * (hilo principal o worker). Si la prueba falla por lo que sea, se supone que NO filtra: el camino por pasos es siempre
 * correcto (solo gasta mas memoria).
 */
export const FILTER_PROBE_MAX_CONTRAST = 0.3;
let filterProbe: Promise<boolean> | null = null;
export function nativeResizeFilters(): Promise<boolean> {
  filterProbe ??= (async () => {
    // Ancho de la prueba: el reductor nativo de WebKit solo submuestrea por encima de ~3000 px de ancho (medido: 2048 -> 768
    // filtra bien, 3000 -> 1125 ya no), y solo con JPEG de verdad, asi que la prueba es un JPEG de 3072 x 16 (49 Kpx).
    const width = 3072;
    const height = 16;
    const target = 1152;
    const surface = createSurface(width, height, true);
    if (!surface) return false;
    let small: ImageBitmap | null = null;
    let readback: Surface | null = null;
    try {
      const image = surface.context.createImageData(width, height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 4;
          const value = x % 2 === 0 ? 0 : 255;
          image.data[at] = value;
          image.data[at + 1] = value;
          image.data[at + 2] = value;
          image.data[at + 3] = 255;
        }
      }
      surface.context.putImageData(image, 0, 0);
      const jpeg = await canvasToBytes(surface.canvas, "image/jpeg", 1);
      small = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }), {
        resizeWidth: target,
        resizeQuality: "high",
      });
      readback = createSurface(small.width, small.height, true);
      if (!readback) return false;
      readback.context.drawImage(small, 0, 0);
      const data = readback.context.getImageData(0, 0, small.width, small.height).data;
      let low = 255;
      let high = 0;
      // Se ignoran los bordes (el reductor mezcla con el exterior): solo el centro del patron.
      for (let x = 3; x < small.width - 3; x += 1) {
        const value = data[(Math.floor(small.height / 2) * small.width + x) * 4];
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
      return (high - low) / 255 < FILTER_PROBE_MAX_CONTRAST;
    } catch {
      return false;
    } finally {
      small?.close();
      releaseSurface(surface);
      releaseSurface(readback);
    }
  })();
  return filterProbe;
}

/** Solo para pruebas: olvida el resultado de la comprobacion del reductor. */
export function resetNativeResizeProbe(): void {
  filterProbe = null;
}

/** Decodifica con `createImageBitmap` ya girado (y reducido a `resize.width` si se pide). `null` si el navegador no lo hace bien. */
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

      // 1. Nativo: el navegador decodifica, gira y reduce (hasta el objetivo si su reductor filtra; si no, hasta el doble
      //    del objetivo y `renderScaled` baja por pasos de mitad).
      let resizeWidth: number | null = null;
      if (hint && expected && expected.scale < 1) {
        resizeWidth = (await nativeResizeFilters()) ? expected.width : planNativeDecodeWidth(hint.width, expected.width);
      }
      const bitmapExpected =
        hint === null
          ? null
          : resizeWidth !== null
            ? { width: resizeWidth, height: Math.max(1, Math.round((hint.height * resizeWidth) / hint.width)) }
            : { width: hint.width, height: hint.height };
      const bitmap = await decodeNative(source, bitmapExpected, resizeWidth !== null ? { width: resizeWidth } : null);
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
