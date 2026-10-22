/**
 * Anotaciones Ink (dibujo a mano con lapiz o Apple Pencil en los visores): `page.getAnnotations()` trae `inkLists` (los
 * trazos), `color`, `borderStyle.width` y `opacity`. De ahi salen un SVG con los trazos REALES (color y grosor) y un PNG con
 * fondo transparente dibujado con esos mismos trazos (sin depender de la apariencia `/AP`, que a veces falta).
 *
 * Todo en unidades de VISTA (la pagina ya girada), asi la firma sale derecha aunque la pagina tenga `/Rotate`.
 */

import type { ExtractedAsset } from "./types";
import { EXPORT_SCALE, type Context2D, type PdfJsAnnotation, type RasterImage, type SurfaceFactory } from "./annotationsTypes";
import { estimatePngBytes, fitScale, normalizeViewRect, shortHash, thumbBlob, type ViewRect } from "./annotationsRaster";

export type InkPoint = [number, number];

export type InkShape = {
  /** Trazos en unidades de vista a escala 1. */
  strokes: InkPoint[][];
  /** Color RGB 0..255. */
  color: [number, number, number];
  /** Grosor en puntos. */
  width: number;
  /** 0..1. */
  opacity: number;
  /** Caja de los trazos con medio grosor de margen. */
  bounds: ViewRect;
};

export const MIN_INK_STROKE_POINTS = 2;
export const MAX_INK_POINTS = 60_000;

/** Convierte `inkLists` (planos `[x, y, x, y…]` o listas de `{x, y}`) a trazos de puntos en vista. */
export function parseInkLists(lists: PdfJsAnnotation["inkLists"], toView: (x: number, y: number) => [number, number]): InkPoint[][] {
  const strokes: InkPoint[][] = [];
  if (!lists) return strokes;
  let budget = MAX_INK_POINTS;
  for (const list of lists) {
    const points: InkPoint[] = [];
    if (list && typeof (list as ArrayLike<unknown>).length === "number") {
      const items = list as ArrayLike<unknown>;
      if (items.length > 0 && typeof items[0] === "object" && items[0] !== null) {
        for (let i = 0; i < items.length && budget > 0; i += 1) {
          const point = items[i] as { x?: unknown; y?: unknown };
          if (typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)) {
            points.push(toView(point.x, point.y));
            budget -= 1;
          }
        }
      } else {
        const flat = items as ArrayLike<number>;
        for (let i = 0; i + 1 < flat.length && budget > 0; i += 2) {
          const x = flat[i];
          const y = flat[i + 1];
          if (Number.isFinite(x) && Number.isFinite(y)) {
            points.push(toView(x, y));
            budget -= 1;
          }
        }
      }
    }
    if (points.length >= MIN_INK_STROKE_POINTS) strokes.push(points);
  }
  return strokes;
}

/** Forma completa de una anotacion Ink; `null` si no tiene trazos utilizables. */
export function inkShapeOf(annotation: PdfJsAnnotation, toView: (x: number, y: number) => [number, number]): InkShape | null {
  const strokes = parseInkLists(annotation.inkLists, toView);
  if (strokes.length === 0) return null;
  const rgb = annotation.color && annotation.color.length >= 3 ? [annotation.color[0], annotation.color[1], annotation.color[2]] : [0, 0, 0];
  const color = rgb.map((v) => Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)))) as [number, number, number];
  const rawWidth = annotation.borderStyle?.width;
  const width = typeof rawWidth === "number" && Number.isFinite(rawWidth) && rawWidth > 0 ? Math.min(rawWidth, 80) : 1;
  const rawOpacity = annotation.opacity;
  const opacity = typeof rawOpacity === "number" && Number.isFinite(rawOpacity) ? Math.min(1, Math.max(0.05, rawOpacity)) : 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const [x, y] of stroke) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const half = width / 2;
  return {
    strokes,
    color,
    width,
    opacity,
    bounds: { x: minX - half, y: minY - half, width: Math.max(1, maxX - minX + width), height: Math.max(1, maxY - minY + width) },
  };
}

function hex(color: [number, number, number]): string {
  return `#${color.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const fmt = (value: number): string => String(Math.round(value * 100) / 100);

/** `d` de un trazo: segmentos que pasan por los puntos medios (suaviza el garabato sin cambiar su forma). */
function pathData(stroke: InkPoint[], dx: number, dy: number): string {
  const p = stroke.map(([x, y]) => [x - dx, y - dy] as InkPoint);
  if (p.length === 1) return `M${fmt(p[0][0])} ${fmt(p[0][1])}l0.01 0`;
  let d = `M${fmt(p[0][0])} ${fmt(p[0][1])}`;
  if (p.length === 2) return `${d}L${fmt(p[1][0])} ${fmt(p[1][1])}`;
  for (let i = 1; i < p.length - 1; i += 1) {
    const mx = (p[i][0] + p[i + 1][0]) / 2;
    const my = (p[i][1] + p[i + 1][1]) / 2;
    d += `Q${fmt(p[i][0])} ${fmt(p[i][1])} ${fmt(mx)} ${fmt(my)}`;
  }
  const last = p[p.length - 1];
  return `${d}L${fmt(last[0])} ${fmt(last[1])}`;
}

/** SVG con los trazos reales (color, grosor, opacidad), en puntos de vista. */
export function buildInkSvg(shape: InkShape): string {
  const { bounds } = shape;
  const width = Math.ceil(bounds.width * 100) / 100;
  const height = Math.ceil(bounds.height * 100) / 100;
  const paths = shape.strokes
    .map((stroke) => `<path d="${pathData(stroke, bounds.x, bounds.y)}"/>`)
    .join("");
  const opacity = shape.opacity < 1 ? ` stroke-opacity="${fmt(shape.opacity)}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">` +
    `<g fill="none" stroke="${hex(shape.color)}" stroke-width="${fmt(shape.width)}" stroke-linecap="round" stroke-linejoin="round"${opacity}>${paths}</g></svg>`
  );
}

/** PNG (RGBA, fondo transparente) de los trazos a `scale` px por punto. */
export function renderInkRaster(shape: InkShape, createSurface: SurfaceFactory, scale: number): RasterImage {
  const s = fitScale(shape.bounds.width, shape.bounds.height, scale);
  const width = Math.max(1, Math.ceil(shape.bounds.width * s));
  const height = Math.max(1, Math.ceil(shape.bounds.height * s));
  const surface = createSurface(width, height);
  try {
    const ctx = surface.context as unknown as CanvasRenderingContext2D & Context2D;
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = `rgba(${shape.color[0]},${shape.color[1]},${shape.color[2]},${shape.opacity})`;
    ctx.lineWidth = Math.max(1, shape.width * s);
    for (const stroke of shape.strokes) {
      const p = stroke.map(([x, y]) => [(x - shape.bounds.x) * s, (y - shape.bounds.y) * s] as InkPoint);
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      if (p.length === 2) {
        ctx.lineTo(p[1][0], p[1][1]);
      } else {
        for (let i = 1; i < p.length - 1; i += 1) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
        ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      }
      ctx.stroke();
    }
    const raw = surface.context.getImageData(0, 0, width, height);
    return { width, height, data: raw.data };
  } finally {
    surface.release();
  }
}

export type InkClassification = { kind: "signature" | "drawing"; confidence: number; reasons: string[] };

/**
 * Firma o dibujo: pocos trazos, proporcion apaisada y un tamano de firma (no media pagina) => firma probable. El resto (un circulo
 * alrededor de un texto, una flecha, un garabato grande) es un dibujo. Ambos con fiabilidad alta de que SON una anotacion Ink.
 */
export function classifyInk(shape: InkShape, viewWidth: number, viewHeight: number): InkClassification {
  const { bounds } = shape;
  const aspect = bounds.width / Math.max(1, bounds.height);
  const points = shape.strokes.reduce((sum, stroke) => sum + stroke.length, 0);
  const reasons: string[] = ["anotación de dibujo a mano (Ink)", `${shape.strokes.length} ${shape.strokes.length === 1 ? "trazo" : "trazos"}`];
  const signatureLike =
    shape.strokes.length <= 12 &&
    points >= 8 &&
    aspect >= 1.2 &&
    aspect <= 10 &&
    bounds.width <= viewWidth * 0.7 &&
    bounds.height <= viewHeight * 0.25;
  if (signatureLike) {
    reasons.push("proporción y tamaño de firma");
    return { kind: "signature", confidence: 0.85, reasons };
  }
  reasons.push("no tiene proporción de firma: se trata como dibujo");
  return { kind: "drawing", confidence: 0.8, reasons };
}

/** Elemento del contrato para una anotacion Ink ya interpretada. */
export async function buildInkAsset(args: {
  shape: InkShape;
  pageIndex: number;
  annotationIndex: number;
  annotationId?: string;
  viewWidth: number;
  viewHeight: number;
  createSurface: SurfaceFactory;
}): Promise<ExtractedAsset> {
  const { shape, pageIndex, annotationIndex, annotationId, viewWidth, viewHeight, createSurface } = args;
  const classification = classifyInk(shape, viewWidth, viewHeight);
  const thumbScale = Math.min(EXPORT_SCALE, 256 / Math.max(shape.bounds.width, shape.bounds.height));
  const preview = renderInkRaster(shape, createSurface, Math.max(0.2, thumbScale));
  const thumb = await thumbBlob(preview);
  const fullWidth = Math.ceil(shape.bounds.width * EXPORT_SCALE);
  const fullHeight = Math.ceil(shape.bounds.height * EXPORT_SCALE);
  const idSource = `ink|${pageIndex}|${shape.strokes.map((stroke) => stroke.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(";")).join("/")}|${shape.color.join(",")}`;
  return {
    id: `ink-${shortHash(idSource)}`,
    kind: classification.kind,
    confidence: classification.confidence,
    reasons: [...classification.reasons, `color ${hex(shape.color).toUpperCase()}`, `grosor ${fmt(shape.width)} pt`],
    source: "ink-annot",
    occurrences: [{ pageIndex, rect: normalizeViewRect(shape.bounds, viewWidth, viewHeight) }],
    pixel: { width: fullWidth, height: fullHeight, hasAlpha: true },
    formats: ["png", "svg"],
    bytesEstimate: estimatePngBytes(thumb.size, preview.width * preview.height, fullWidth * fullHeight),
    thumb,
    ref: { engine: "annotation", pageIndex, annotationIndex, ...(annotationId ? { annotationId } : {}) },
  };
}
