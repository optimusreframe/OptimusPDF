/**
 * Entorno de UNA pagina para los constructores de elementos (Ink, Stamp, /Sig, Watermark, sellos de Form XObject): geometria en
 * unidades de vista y la «capa de anotaciones» (lo que las anotaciones anaden a la pagina, con fondo transparente) que se renderiza
 * UNA vez por pagina y de la que se recorta cada anotacion.
 */

import { extractInkAsync, InkError, type InkImage } from "@/lib/image/inkExtract";
import {
  ANALYSIS_SCALE,
  type PdfDocument,
  type PdfJsAnnotation,
  type PdfPage,
  type RasterImage,
  type SurfaceFactory,
} from "./annotationsTypes";
import { cropImage, fitScale, renderAnnotationDiff, type ViewRect } from "./annotationsRaster";

export type PageEnv = {
  doc: PdfDocument;
  page: PdfPage;
  pageIndex: number;
  /** Tamano de la vista a escala 1 (puntos, con `/Rotate` aplicado). */
  viewWidth: number;
  viewHeight: number;
  toView(x: number, y: number): [number, number];
  createSurface: SurfaceFactory;
  signal?: AbortSignal;
  /** Plazo de cada render de pdf.js (ver `withTimeout`). */
  timeoutMs?: number;
};

export function makePageEnv(doc: PdfDocument, page: PdfPage, pageIndex: number, createSurface: SurfaceFactory, signal?: AbortSignal, timeoutMs?: number): PageEnv {
  const viewport = page.getViewport({ scale: 1 });
  return {
    doc,
    page,
    pageIndex,
    viewWidth: viewport.width,
    viewHeight: viewport.height,
    toView: (x, y) => {
      const [vx, vy] = viewport.convertToViewportPoint(x, y);
      return [vx, vy];
    },
    createSurface,
    signal,
    timeoutMs,
  };
}

/** Rectangulo `/Rect` de una anotacion (espacio de usuario) a unidades de vista, recortado a la pagina. `null` si es degenerado. */
export function annotationViewRect(env: PageEnv, annotation: Pick<PdfJsAnnotation, "rect">): ViewRect | null {
  const r = annotation.rect;
  if (!r || r.length < 4 || ![r[0], r[1], r[2], r[3]].every((n) => Number.isFinite(n))) return null;
  const [ax, ay] = env.toView(r[0], r[1]);
  const [bx, by] = env.toView(r[2], r[3]);
  const x0 = Math.max(0, Math.min(ax, bx));
  const y0 = Math.max(0, Math.min(ay, by));
  const x1 = Math.min(env.viewWidth, Math.max(ax, bx));
  const y1 = Math.min(env.viewHeight, Math.max(ay, by));
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export type AnnotationLayer = { image: RasterImage; region: ViewRect; scale: number };

/** Region que cubre todas las cajas, con un margen de 2 pt, dentro de la pagina. */
export function unionRegion(env: PageEnv, rects: readonly ViewRect[], margin = 2): ViewRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  x0 = Math.max(0, Math.floor(x0 - margin));
  y0 = Math.max(0, Math.floor(y0 - margin));
  x1 = Math.min(env.viewWidth, Math.ceil(x1 + margin));
  y1 = Math.min(env.viewHeight, Math.ceil(y1 + margin));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** Renderiza (una vez) lo que las anotaciones anaden en la region que cubren `rects`. */
export async function renderAnnotationLayer(env: PageEnv, rects: readonly ViewRect[], wantedScale = ANALYSIS_SCALE): Promise<AnnotationLayer> {
  const region = unionRegion(env, rects);
  const scale = fitScale(region.width, region.height, wantedScale);
  const image = await renderAnnotationDiff({ page: env.page, region, scale, createSurface: env.createSurface, signal: env.signal, timeoutMs: env.timeoutMs });
  return { image, region, scale };
}

/** Recorta de la capa la caja `rect` (unidades de vista). */
export function cropLayer(layer: AnnotationLayer, rect: ViewRect): RasterImage {
  return cropImage(layer.image, (rect.x - layer.region.x) * layer.scale, (rect.y - layer.region.y) * layer.scale, rect.width * layer.scale, rect.height * layer.scale);
}

/**
 * Limpia una captura de apariencia de firma con el motor de tinta de F6 (`inkExtract`): quita el fondo, conserva el color de la
 * tinta y recorta a la firma, dejando un PNG con transparencia. `null` si no hay tinta (campo vacio o apariencia sin trazo).
 */
export async function cleanSignatureRaster(image: RasterImage, signal?: AbortSignal): Promise<{ image: RasterImage; inkPixels: number } | null> {
  try {
    const result = await extractInkAsync(image as InkImage, { ink: "original", crop: "auto", evenLighting: false, cleanSpecks: "auto", margin: Math.max(2, Math.round(Math.max(image.width, image.height) * 0.02)) }, { worker: "never", signal });
    return { image: { width: result.image.width, height: result.image.height, data: result.image.data }, inkPixels: result.inkPixels };
  } catch (error) {
    if (error instanceof InkError && (error.code === "no-ink" || error.code === "too-dark")) return null;
    throw error;
  }
}
