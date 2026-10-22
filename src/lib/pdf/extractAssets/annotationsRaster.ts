/**
 * Raster del motor de anotaciones: superficies, render de una REGION de pagina con pdf.js (con o sin anotaciones, con una
 * capa opcional encendida o apagada), diferencia entre dos renders, recortes, miniaturas y PNG. Las funciones de pixeles son
 * puras y no tocan el DOM; solo `defaultSurfaceFactory` y `renderRegion` necesitan canvas.
 */

import { resizeArea, trimToInk, encodeInkPng, fitDimensions, yieldToMain } from "@/lib/image/inkExtract";
import { EXTRACT_LIMITS } from "./types";
import {
  AnnotationRenderError,
  MAX_RENDER_PIXELS,
  MAX_RENDER_SIDE,
  type Context2D,
  type PdfPage,
  type RasterImage,
  type Surface,
  type SurfaceFactory,
} from "./annotationsTypes";

/** Rectangulo en unidades de VISTA a escala 1 (puntos, con la rotacion de la pagina aplicada, origen arriba a la izquierda). */
export type ViewRect = { x: number; y: number; width: number; height: number };

/** Fabrica de superficies para el navegador: canvas de documento si lo hay; `OffscreenCanvas` si no. */
export function defaultSurfaceFactory(): SurfaceFactory {
  return (width, height) => {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true }) as unknown as Context2D | null;
      if (!context) throw new AnnotationRenderError("no-pixels", "No hay contexto 2D.");
      return {
        width,
        height,
        context,
        release: () => {
          canvas.width = 0;
          canvas.height = 0;
        },
      } satisfies Surface;
    }
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true }) as unknown as Context2D | null;
      if (!context) throw new AnnotationRenderError("no-pixels", "No hay contexto 2D.");
      return {
        width,
        height,
        context,
        release: () => {
          canvas.width = 0;
          canvas.height = 0;
        },
      } satisfies Surface;
    }
    throw new AnnotationRenderError("no-pixels", "No hay canvas disponible: pasa `createSurface` en el contexto.");
  };
}

/** Escala que cabe en los topes de memoria para una region de `width x height` puntos, partiendo de `wanted`. */
export function fitScale(width: number, height: number, wanted: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const byPixels = Math.sqrt(MAX_RENDER_PIXELS / (w * h));
  const bySide = MAX_RENDER_SIDE / Math.max(w, h);
  return Math.max(0.05, Math.min(wanted, byPixels, bySide));
}

/** Plazo por defecto de un paso de pdf.js (abrir pagina, leer anotaciones o operadores, renderizar una region). */
export const STEP_TIMEOUT_MS = 30_000;

/**
 * Espera `promise` pero no mas de `ms` y corta en cuanto `signal` se aborta. pdf.js puede dejar una promesa SIN resolver con un
 * documento roto (p. ej. un dato de anotacion que no se puede clonar entre el worker y la pagina): sin este plazo la extraccion se
 * quedaria colgada y el boton «Cancelar» no tendria efecto. La promesa original sigue pendiente (no hay forma de cancelarla).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      finish();
      reject(new AnnotationRenderError("cancelled"));
    };
    if (signal?.aborted) {
      reject(new AnnotationRenderError("cancelled"));
      return;
    }
    timer = setTimeout(() => {
      finish();
      reject(new AnnotationRenderError("timeout", `${label}: tiempo agotado (${ms} ms)`));
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
  });
}

export type RenderRegionParams = {
  page: PdfPage;
  region: ViewRect;
  scale: number;
  /** 0 = sin anotaciones, 1 = con anotaciones (`AnnotationMode`). */
  annotationMode: 0 | 1;
  createSurface: SurfaceFactory;
  /** Fondo CSS. Por defecto transparente: asi los pixeles que no pinta la pagina quedan con alfa 0. */
  background?: string;
  /** Configuracion de contenido opcional de pdf.js (para encender o apagar una capa). */
  optionalContentConfig?: unknown;
  signal?: AbortSignal;
  /** Plazo del render de pdf.js (`STEP_TIMEOUT_MS` por defecto). */
  timeoutMs?: number;
};

/** Renderiza SOLO `region` de la pagina a `scale` px por punto. Cancela el render de pdf.js si `signal` se aborta. */
export async function renderRegion(params: RenderRegionParams): Promise<RasterImage> {
  const { page, region, scale, annotationMode, createSurface, signal } = params;
  const width = Math.max(1, Math.ceil(region.width * scale));
  const height = Math.max(1, Math.ceil(region.height * scale));
  if (width * height > MAX_RENDER_PIXELS * 1.05 || Math.max(width, height) > MAX_RENDER_SIDE + 1) {
    throw new AnnotationRenderError("too-large", `Region de ${width}x${height} px fuera de los topes.`);
  }
  if (signal?.aborted) throw new AnnotationRenderError("cancelled");
  const viewport = page.getViewport({ scale, offsetX: -region.x * scale, offsetY: -region.y * scale });
  const surface = createSurface(width, height);
  let task: { promise: Promise<unknown>; cancel?: () => void } | null = null;
  const onAbort = (): void => task?.cancel?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const parameters: Record<string, unknown> = {
      canvasContext: surface.context,
      canvas: surface.context.canvas,
      viewport,
      intent: "display",
      annotationMode,
      background: params.background ?? "rgba(0,0,0,0)",
    };
    if (params.optionalContentConfig) parameters.optionalContentConfigPromise = Promise.resolve(params.optionalContentConfig);
    task = page.render(parameters as never) as unknown as { promise: Promise<unknown>; cancel?: () => void };
    try {
      await withTimeout(task.promise, params.timeoutMs ?? STEP_TIMEOUT_MS, signal, "render");
    } catch (error) {
      if (error instanceof AnnotationRenderError && error.code === "timeout") task.cancel?.();
      if (signal?.aborted) throw new AnnotationRenderError("cancelled");
      throw error;
    }
    const raw = surface.context.getImageData(0, 0, width, height);
    return { width, height, data: raw.data };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    surface.release();
  }
}

/**
 * Lo que `over` anade a `base` (mismo tamano, ambos con fondo transparente): pixeles nuevos con su color y alfa. Donde la pagina
 * no pintaba nada (alfa 0) el resultado es `over` tal cual; donde pintaba, solo cuentan los pixeles que cambian de verdad.
 */
export function diffLayers(base: RasterImage, over: RasterImage, tolerance = 3): RasterImage {
  if (base.width !== over.width || base.height !== over.height) throw new AnnotationRenderError("no-pixels", "Capas de distinto tamano.");
  const out = new Uint8ClampedArray(over.data.length);
  const a = base.data;
  const b = over.data;
  for (let i = 0; i < b.length; i += 4) {
    const baseAlpha = a[i + 3];
    const overAlpha = b[i + 3];
    if (overAlpha === 0) continue;
    if (baseAlpha === 0) {
      out[i] = b[i];
      out[i + 1] = b[i + 1];
      out[i + 2] = b[i + 2];
      out[i + 3] = overAlpha;
      continue;
    }
    const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(baseAlpha - overAlpha));
    if (delta <= tolerance) continue;
    out[i] = b[i];
    out[i + 1] = b[i + 1];
    out[i + 2] = b[i + 2];
    out[i + 3] = overAlpha;
  }
  return { width: over.width, height: over.height, data: out };
}

/** Copia una region (en pixeles) de la imagen; lo que cae fuera queda transparente. */
export function cropImage(image: RasterImage, x: number, y: number, width: number, height: number): RasterImage {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const out = new Uint8ClampedArray(w * h * 4);
  const x0 = Math.max(0, Math.round(x));
  const x1 = Math.min(image.width, Math.round(x) + w);
  for (let row = 0; row < h; row += 1) {
    const sy = Math.round(y) + row;
    if (sy < 0 || sy >= image.height || x1 <= x0) continue;
    const from = (sy * image.width + x0) * 4;
    out.set(image.data.subarray(from, from + (x1 - x0) * 4), (row * w + (x0 - Math.round(x))) * 4);
  }
  return { width: w, height: h, data: out };
}

/** Caja (pixeles) de lo que tiene alfa >= `minAlpha`; `null` si no hay nada. */
export function alphaBounds(image: RasterImage, minAlpha = 8): { x: number; y: number; width: number; height: number } | null {
  const trimmed = trimToInk(image, 0, minAlpha);
  return trimmed ? trimmed.rect : null;
}

/** Recorta a lo visible (alfa >= `minAlpha`) dejando `margin` px. `null` si esta vacia. */
export function trimTransparent(image: RasterImage, margin = 0, minAlpha = 8): { image: RasterImage; rect: { x: number; y: number; width: number; height: number } } | null {
  const trimmed = trimToInk(image, margin, minAlpha);
  return trimmed ? { image: trimmed.image, rect: trimmed.rect } : null;
}

/** Numero de pixeles con alfa >= `minAlpha`. */
export function countVisible(image: RasterImage, minAlpha = 8): number {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] >= minAlpha) count += 1;
  return count;
}

/** Reduce para que el lado mayor sea `maxSide` (no amplia). */
export function fitInto(image: RasterImage, maxSide: number): RasterImage {
  const fit = fitDimensions(image.width, image.height, maxSide);
  if (fit.scale >= 1) return image;
  return resizeArea(image, fit.width, fit.height);
}

/** Tope de bytes y de lado de un PNG de exportacion: no hay limite del baul (600 KB) porque no va a ningun baul. */
const EXPORT_PNG_MAX_BYTES = 256 * 1024 * 1024;
const EXPORT_PNG_MAX_SIDE = 8192;

/**
 * PNG sin perdida (RGBA) como `Blob`. Usa el codificador de `inkExtract` (que cae al PNG del canvas si el navegador no trae
 * `CompressionStream`, Safari < 16.4) con topes holgados: aqui no hay limite de 600 KB.
 */
export async function pngBlob(image: RasterImage): Promise<Blob> {
  const encoded = await encodeInkPng(image, { maxBytes: EXPORT_PNG_MAX_BYTES, maxDimension: EXPORT_PNG_MAX_SIDE });
  return new Blob([encoded.bytes as unknown as BlobPart], { type: "image/png" });
}

/** Miniatura de hasta `EXTRACT_LIMITS.thumbPx` px (PNG con alfa); no amplia. */
export async function thumbBlob(image: RasterImage): Promise<Blob> {
  return pngBlob(fitInto(image, EXTRACT_LIMITS.thumbPx));
}

/** Tamano aproximado del PNG a partir del de la miniatura, escalado por area (la miniatura ya es PNG real). */
export function estimatePngBytes(thumbBytes: number, thumbPixels: number, fullPixels: number): number {
  if (thumbPixels <= 0) return Math.max(0, Math.round(thumbBytes));
  const ratio = Math.max(1, fullPixels / thumbPixels);
  return Math.max(thumbBytes, Math.round(thumbBytes * Math.pow(ratio, 0.85)));
}

/** Hash FNV-1a de 32 bits como 8 cifras hexadecimales (identificadores estables y cortos). */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Redondea a 3 decimales (valores estables para identificadores y comparaciones). */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Rectangulo en unidades de vista -> normalizado 0..1 (recortado a la pagina). */
export function normalizeViewRect(rect: ViewRect, viewWidth: number, viewHeight: number): { x: number; y: number; width: number; height: number } {
  const x0 = Math.min(1, Math.max(0, rect.x / viewWidth));
  const y0 = Math.min(1, Math.max(0, rect.y / viewHeight));
  const x1 = Math.min(1, Math.max(0, (rect.x + rect.width) / viewWidth));
  const y1 = Math.min(1, Math.max(0, (rect.y + rect.height) / viewHeight));
  return { x: round3(x0), y: round3(y0), width: round3(Math.max(0, x1 - x0)), height: round3(Math.max(0, y1 - y0)) };
}

/** Solo lo que anaden las anotaciones: la region sin anotaciones frente a la region con ellas (ambas con fondo transparente). */
export async function renderAnnotationDiff(params: Omit<RenderRegionParams, "annotationMode">): Promise<RasterImage> {
  const base = await renderRegion({ ...params, annotationMode: 0 });
  const over = await renderRegion({ ...params, annotationMode: 1 });
  await yieldToMain(); // la resta recorre todos los pixeles: se cede el hilo antes para no encadenar tareas largas
  return diffLayers(base, over);
}
