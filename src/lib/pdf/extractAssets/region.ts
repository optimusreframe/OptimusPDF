import type { InkImage } from "@/lib/image/inkCore";
import { InkError } from "@/lib/image/inkCore";
import type { ExtractAssetsApi, NormRect } from "@/lib/pdf/extractAssets/types";

/**
 * Recorte manual de una region de pagina (F7 · U7.4): la herramienta «Recortar region» de «Extraer elementos». Es
 * utilizable SIN el resto del motor de extraccion (`index.ts` lo deja como implementacion por defecto de `cropRegion`).
 *
 * Camino: pdf.js renderiza SOLO la zona (el lienzo mide lo que mide la region, no la pagina) a 300-600 ppp, `inkExtract`
 * (`src/lib/image/*`: luminancia, iluminacion, umbral de Otsu, motas, recorte a la tinta; en worker por encima de 4 MP)
 * quita el fondo y `encodeInkPng` deja un PNG con transparencia dentro de los topes del baul de firmas (4096 px / 600 KB).
 * Con `cleanBackground: false` se devuelve la region tal cual (opaca) en un PNG mas holgado.
 *
 * Todo corre en el navegador del usuario: ni el PDF ni la region salen del dispositivo.
 */

export const REGION_MIN_DPI = 300;
export const REGION_MAX_DPI = 600;
export const REGION_DEFAULT_DPI = 400;
/** Tope de pixeles del lienzo de la region (Safari limita el area de un canvas a ~16,7 M). */
export const REGION_MAX_PIXELS = 16_000_000;
/** Lado minimo (fraccion de la pagina) de una region valida. */
export const REGION_MIN_SIDE = 0.002;
/** PNG sin limpiar (opaco): holgura mayor que la del baul, que no se usa en este camino. */
const RAW_PNG_MAX_BYTES = 8 * 1024 * 1024;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Region dentro de la pagina (0..1) y con lado minimo. Un valor no numerico se rechaza. */
export function clampRegion(rect: NormRect): NormRect {
  const values = [rect?.x, rect?.y, rect?.width, rect?.height];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new RangeError("Region no valida");
  }
  const width = clamp(rect.width, REGION_MIN_SIDE, 1);
  const height = clamp(rect.height, REGION_MIN_SIDE, 1);
  const x = clamp(rect.x, 0, 1 - width);
  const y = clamp(rect.y, 0, 1 - height);
  return { x, y, width, height };
}

/** ppp pedidos -> ppp validos (300-600). Un valor ausente o no numerico usa el de por defecto. */
export function clampDpi(dpi: number | undefined): number {
  if (typeof dpi !== "number" || !Number.isFinite(dpi)) return REGION_DEFAULT_DPI;
  return clamp(Math.round(dpi), REGION_MIN_DPI, REGION_MAX_DPI);
}

export type RegionPlan = {
  /** Escala de pdf.js (ppp / 72) realmente usada. */
  scale: number;
  /** ppp efectivos (menores que los pedidos si la region es tan grande que no cabria en un lienzo). */
  dpi: number;
  /** Esquina de la region en pixeles de la pagina a esa escala (enteros). */
  left: number;
  top: number;
  /** Tamano del lienzo en pixeles. */
  width: number;
  height: number;
  /** `true` si hubo que bajar de los ppp pedidos por el tope de pixeles. */
  reduced: boolean;
};

/**
 * Cuanto renderizar: pagina en puntos + region normalizada + ppp. Mantiene el lienzo por debajo de `REGION_MAX_PIXELS`
 * bajando la escala (nunca por encima de la pedida). Devuelve enteros: el lienzo y el desplazamiento coinciden al pixel.
 */
export function planRegion(pageWidthPt: number, pageHeightPt: number, rect: NormRect, dpi?: number): RegionPlan {
  if (!(pageWidthPt > 0) || !(pageHeightPt > 0)) throw new RangeError("Pagina sin tamano");
  const region = clampRegion(rect);
  const requested = clampDpi(dpi);
  let scale = requested / 72;
  const area = (s: number): number => region.width * pageWidthPt * s * (region.height * pageHeightPt * s);
  let reduced = false;
  if (area(scale) > REGION_MAX_PIXELS) {
    scale *= Math.sqrt(REGION_MAX_PIXELS / area(scale));
    reduced = true;
  }
  const left = Math.round(region.x * pageWidthPt * scale);
  const top = Math.round(region.y * pageHeightPt * scale);
  const right = Math.round((region.x + region.width) * pageWidthPt * scale);
  const bottom = Math.round((region.y + region.height) * pageHeightPt * scale);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  return { scale, dpi: Math.round(scale * 72), left, top, width, height, reduced };
}

/** Pinta la region y entrega sus pixeles RGBA (a `dpi` o, si no cabe, menos). */
export type RegionRenderer = (
  file: File | Uint8Array,
  pageIndex: number,
  rect: NormRect,
  dpi: number,
  signal?: AbortSignal,
) => Promise<{ image: InkImage; dpi: number }>;

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InkError("aborted");
}

/** Renderizador real: pdf.js (cargado bajo demanda) sobre un lienzo del tamano de la region. */
export const renderRegionWithPdfJs: RegionRenderer = async (file, pageIndex, rect, dpi, signal) => {
  const { openPdfDocument, closePdfDocument, PdfError } = await import("@/lib/pdf/core");
  aborted(signal);
  const document_ = await openPdfDocument(file);
  try {
    aborted(signal);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document_.numPages) {
      throw new PdfError("unknown", "Pagina fuera de rango");
    }
    const page = await document_.getPage(pageIndex + 1);
    try {
      const base = page.getViewport({ scale: 1 });
      const plan = planRegion(base.width, base.height, rect, dpi);
      const viewport = page.getViewport({ scale: plan.scale, offsetX: -plan.left, offsetY: -plan.top });
      const canvas = document.createElement("canvas");
      canvas.width = plan.width;
      canvas.height = plan.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new PdfError("unknown", "Canvas 2D context unavailable");
      // «print»: avanza con microtareas y termina aunque la pestana no pinte (es un rasterizado fuera de pantalla).
      const task = page.render({ canvas, viewport, intent: "print" });
      const onAbort = (): void => task.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await task.promise;
      } catch (error) {
        if (signal?.aborted) throw new InkError("aborted");
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      aborted(signal);
      const pixels = context.getImageData(0, 0, plan.width, plan.height);
      canvas.width = 0;
      canvas.height = 0;
      return { image: { width: plan.width, height: plan.height, data: pixels.data }, dpi: plan.dpi };
    } finally {
      page.cleanup();
    }
  } finally {
    await closePdfDocument(document_);
  }
};

type CropOptions = NonNullable<Parameters<ExtractAssetsApi["cropRegion"]>[3]>;

/** Recorte con un renderizador dado (las pruebas inyectan uno sintetico; la aplicacion usa pdf.js). */
export async function cropRegionWith(
  render: RegionRenderer,
  file: File | Uint8Array,
  pageIndex: number,
  rect: NormRect,
  options: CropOptions = {},
): ReturnType<ExtractAssetsApi["cropRegion"]> {
  const { signal } = options;
  const region = clampRegion(rect);
  const dpi = clampDpi(options.dpi);
  aborted(signal);
  const ink = await import("@/lib/image/inkExtract");
  const { image } = await render(file, pageIndex, region, dpi, signal);
  aborted(signal);
  if (options.cleanBackground === false) {
    const encoded = await ink.encodeInkPng(image, { maxBytes: RAW_PNG_MAX_BYTES });
    return { png: new Blob([encoded.bytes as unknown as BlobPart], { type: "image/png" }), width: encoded.width, height: encoded.height };
  }
  // La region YA es lo que se quiere analizar: umbral y fondo salen de ella sola; despues se recorta a la tinta.
  const result = await ink.extractInkAsync(image, { crop: "auto", margin: "auto" }, { signal });
  aborted(signal);
  const encoded = await ink.encodeInkPng(result.image);
  return { png: new Blob([encoded.bytes as unknown as BlobPart], { type: "image/png" }), width: encoded.width, height: encoded.height };
}

/** `cropRegion` del contrato `ExtractAssetsApi`: renderiza con pdf.js, limpia con `inkExtract` y devuelve el PNG. */
export const cropRegion: ExtractAssetsApi["cropRegion"] = (file, pageIndex, rect, options) =>
  cropRegionWith(renderRegionWithPdfJs, file, pageIndex, rect, options);
