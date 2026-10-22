/**
 * Dibujo de las firmas vectoriales (beta) de «Extraer elementos» (U7.3): el SVG de las rutas del grupo, el PNG transparente a 4x
 * (SOLO los trazos de la firma: sin el texto ni la raya de la pagina que pasan por debajo) y el elemento del contrato con su miniatura.
 * `renderVectorAsset` vuelve a leer la pagina y a agrupar para regenerarlos bajo demanda (la referencia es pagina + caja).
 */

import { closePdfDocument, getPdfJs, openPdfDocument } from "@/lib/pdf/core";
import { shortHash, fitScale, pngBlob, thumbBlob, trimTransparent, estimatePngBytes, defaultSurfaceFactory, withTimeout, STEP_TIMEOUT_MS } from "./annotationsRaster";
import { EXPORT_SCALE, AnnotationRenderError, type Context2D, type PdfDocument, type RasterImage, type SurfaceFactory } from "./annotationsTypes";
import { iou } from "./classify";
import type { AcceptedVector, VectorCandidate, VectorPath } from "./classifyTypes";
import { scanVectors, type VectorOps } from "./vectors";
import type { AssetFormat, ExtractedAsset, NormRect } from "./types";

type Pen = Context2D & {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void;
  quadraticCurveTo(a: number, b: number, c: number, d: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  lineWidth: number;
  strokeStyle: string;
  fillStyle: string;
  lineCap: string;
  lineJoin: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

function pathData(path: VectorPath, dx: number, dy: number): string {
  let d = "";
  for (const command of path.commands) {
    const [op, ...n] = command;
    if (op === "Z") d += "Z";
    else d += `${op}${n.map((value, i) => round2(value - (i % 2 === 0 ? dx : dy))).join(" ")}`;
  }
  return d;
}

/** Margen (puntos) alrededor de la caja para que no se corte el grosor del trazo. */
function padOf(candidate: VectorCandidate): number {
  return Math.max(2, candidate.strokeWidth * 1.5);
}

/** SVG de las rutas del grupo (unidades = puntos de la pagina). */
export function buildVectorSvg(candidate: VectorCandidate): string {
  const pad = padOf(candidate);
  const x = candidate.bbox.x - pad;
  const y = candidate.bbox.y - pad;
  const width = round2(candidate.bbox.width + 2 * pad);
  const height = round2(candidate.bbox.height + 2 * pad);
  const body = candidate.paths
    .map((path) => {
      const d = pathData(path, x, y);
      const attrs = path.stroke
        ? `fill="none" stroke="${path.color}" stroke-width="${round2(Math.max(0.3, path.lineWidth))}" stroke-linecap="round" stroke-linejoin="round"`
        : `fill="${path.color}" stroke="none"`;
      return `<path d="${d}" ${attrs}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${body}</svg>`;
}

/** Dibuja el grupo a `scale` px por punto con fondo transparente y recorta a lo pintado. `null` si no pinta nada. */
export function drawVectorCandidate(candidate: VectorCandidate, createSurface: SurfaceFactory, wantedScale = EXPORT_SCALE): RasterImage | null {
  const pad = padOf(candidate);
  const widthPt = candidate.bbox.width + 2 * pad;
  const heightPt = candidate.bbox.height + 2 * pad;
  const scale = fitScale(widthPt, heightPt, wantedScale);
  const width = Math.max(1, Math.ceil(widthPt * scale));
  const height = Math.max(1, Math.ceil(heightPt * scale));
  const surface = createSurface(width, height);
  try {
    const ctx = surface.context as Pen;
    const ox = candidate.bbox.x - pad;
    const oy = candidate.bbox.y - pad;
    for (const path of candidate.paths) {
      ctx.beginPath();
      for (const command of path.commands) {
        const [op, ...n] = command;
        const px = (i: number): number => (n[i] - ox) * scale;
        const py = (i: number): number => (n[i] - oy) * scale;
        if (op === "M") ctx.moveTo(px(0), py(1));
        else if (op === "L") ctx.lineTo(px(0), py(1));
        else if (op === "C") ctx.bezierCurveTo(px(0), py(1), px(2), py(3), px(4), py(5));
        else if (op === "Q") ctx.quadraticCurveTo(px(0), py(1), px(2), py(3));
        else ctx.closePath();
      }
      if (path.stroke) {
        ctx.lineWidth = Math.max(1.5, path.lineWidth * scale);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = path.color;
        ctx.stroke();
      } else {
        ctx.fillStyle = path.color;
        ctx.fill();
      }
    }
    const raw = surface.context.getImageData(0, 0, width, height);
    const trimmed = trimTransparent({ width, height, data: raw.data }, 2, 8);
    return trimmed ? trimmed.image : null;
  } finally {
    surface.release();
  }
}

/** El elemento del contrato para una firma vectorial aceptada (miniatura de 256 px, formatos `png` y `svg`). */
export async function buildVectorAsset(accepted: AcceptedVector, createSurface: SurfaceFactory): Promise<ExtractedAsset | null> {
  const { candidate } = accepted;
  const image = drawVectorCandidate(candidate, createSurface);
  if (!image) return null;
  const thumb = await thumbBlob(image);
  const rect = candidate.rect;
  return {
    id: `vec-${shortHash(`${candidate.pageIndex}|${rect.x.toFixed(3)}|${rect.y.toFixed(3)}|${rect.width.toFixed(3)}|${rect.height.toFixed(3)}|${candidate.curves}`)}`,
    kind: accepted.kind,
    confidence: accepted.confidence,
    reasons: accepted.reasons,
    source: "vector",
    occurrences: [{ pageIndex: candidate.pageIndex, rect }],
    pixel: { width: image.width, height: image.height, hasAlpha: true },
    formats: ["png", "svg"],
    bytesEstimate: estimatePngBytes(thumb.size, Math.min(image.width, 256) * Math.min(image.height, 256), image.width * image.height),
    thumb,
    ref: { engine: "vector", pageIndex: candidate.pageIndex, rect },
  };
}

export type VectorRenderContext = { ops?: VectorOps; createSurface?: SurfaceFactory; signal?: AbortSignal };

function isDocument(source: unknown): source is PdfDocument {
  return !!source && typeof source === "object" && typeof (source as PdfDocument).getPage === "function";
}

/** Regenera el PNG o el SVG de una firma vectorial: vuelve a leer la pagina y elige el grupo que mas coincide con la caja guardada. */
export async function renderVectorAsset(source: PdfDocument | Blob | Uint8Array, asset: ExtractedAsset, format: AssetFormat = "png", ctx: VectorRenderContext = {}): Promise<Blob> {
  if (asset.ref.engine !== "vector" || asset.source !== "vector") throw new AnnotationRenderError("not-found", "No es una firma vectorial.");
  if (!asset.formats.includes(format)) throw new AnnotationRenderError("unsupported-format", `El elemento no ofrece ${format}.`);
  const ref = asset.ref;
  const owned = !isDocument(source);
  const doc = isDocument(source) ? source : await openPdfDocument(source);
  try {
    if (ref.pageIndex < 0 || ref.pageIndex >= doc.numPages) throw new AnnotationRenderError("not-found", "La pagina ya no existe.");
    const page = await withTimeout(doc.getPage(ref.pageIndex + 1), STEP_TIMEOUT_MS, ctx.signal, "pagina");
    try {
      const ops = ctx.ops ?? ((await getPdfJs()).OPS as unknown as VectorOps);
      const list = await withTimeout(page.getOperatorList({ annotationMode: 0 } as never), STEP_TIMEOUT_MS, ctx.signal, "operadores");
      const viewport = page.getViewport({ scale: 1 });
      const scan = scanVectors(list.fnArray as unknown as ArrayLike<number>, list.argsArray as unknown as ArrayLike<unknown>, ops, { toView: (x, y) => viewport.convertToViewportPoint(x, y) as [number, number] }, ref.pageIndex, viewport.width, viewport.height);
      let best: VectorCandidate | null = null;
      let bestScore = 0;
      for (const candidate of scan.candidates) {
        const score = iou(candidate.rect as NormRect, ref.rect);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (!best || bestScore < 0.5) throw new AnnotationRenderError("not-found", "No se encontro la firma en la pagina.");
      if (format === "svg") return new Blob([buildVectorSvg(best)], { type: "image/svg+xml;charset=utf-8" });
      const image = drawVectorCandidate(best, ctx.createSurface ?? defaultSurfaceFactory());
      if (!image) throw new AnnotationRenderError("no-pixels");
      return pngBlob(image);
    } finally {
      try {
        page.cleanup();
      } catch {
        // documento ya destruido
      }
    }
  } finally {
    if (owned) await closePdfDocument(doc);
  }
}
