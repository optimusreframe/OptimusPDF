/**
 * `renderAnnotationAsset`: regenera bajo demanda el PNG, SVG o TXT de un elemento que encontro `findAnnotationAssets`, para
 * descargarlo o guardarlo. Los pixeles no se guardan en el resultado de la deteccion: aqui se vuelven a producir, a ~288 ppp.
 */

import { PdfError, getPdfJs, openPdfDocument, closePdfDocument } from "@/lib/pdf/core";
import type { AssetFormat, ExtractedAsset, NormRect } from "./types";
import {
  ANNOTATION_MODE,
  EXPORT_SCALE,
  AnnotationRenderError,
  type AnnotationContext,
  type PdfDocument,
  type PdfJsAnnotation,
  type PdfOps,
  type RasterImage,
  type TextWatermarkRef,
} from "./annotationsTypes";
import { STEP_TIMEOUT_MS, defaultSurfaceFactory, fitScale, pngBlob, trimTransparent, withTimeout, type ViewRect } from "./annotationsRaster";
import { annotationViewRect, cleanSignatureRaster, makePageEnv, renderAnnotationLayer, cropLayer, type PageEnv } from "./annotationsPage";
import { buildInkSvg, inkShapeOf, renderInkRaster } from "./annotationsInk";
import { renderFormStamp } from "./annotationsFormStamp";
import { renderOcgLayer } from "./watermarkOcg";
import { buildTextWatermarkSvg, renderTextWatermarkPreview } from "./watermarkText";
import { scanPageOperators } from "./watermarkOps";
import { stampLikeness } from "./annotationsFormStamp";

export type RenderSource = Blob | Uint8Array | PdfDocument;

/**
 * ¿Este elemento lo regenera `renderAnnotationAsset`? Para que el orquestador reparta `renderAsset` entre motores: las referencias
 * `annotation`, `ocg` y `text` son de este motor; `vector` lo es solo si el origen es `form` (el sello de Form XObject), porque la
 * firma vectorial beta del clasificador usa la misma referencia con origen `vector`.
 */
export function ownsAnnotationAsset(asset: Pick<ExtractedAsset, "ref" | "source">): boolean {
  const engine = asset.ref.engine;
  return engine === "annotation" || engine === "ocg" || engine === "text" || (engine === "vector" && asset.source === "form");
}

function isDocumentProxy(source: RenderSource): source is PdfDocument {
  return typeof (source as PdfDocument).getPage === "function";
}

function cancelled(error: unknown, signal?: AbortSignal): boolean {
  return (
    !!signal?.aborted ||
    (error instanceof AnnotationRenderError && error.code === "cancelled") ||
    (error instanceof Error && error.name === "InkError" && (error as { code?: string }).code === "aborted")
  );
}

async function withDocument<T>(source: RenderSource, run: (doc: PdfDocument) => Promise<T>): Promise<T> {
  if (isDocumentProxy(source)) return run(source);
  const doc = await openPdfDocument(source);
  try {
    return await run(doc);
  } finally {
    await closePdfDocument(doc);
  }
}

async function findAnnotation(env: PageEnv, asset: ExtractedAsset): Promise<PdfJsAnnotation> {
  const ref = asset.ref;
  if (ref.engine !== "annotation") throw new AnnotationRenderError("not-found");
  const annotations = (await withTimeout(env.page.getAnnotations(), env.timeoutMs ?? STEP_TIMEOUT_MS, env.signal, "anotaciones")) as unknown as PdfJsAnnotation[];
  const byId = ref.annotationId ? annotations.find((annotation) => annotation?.id === ref.annotationId) : undefined;
  const found = byId ?? annotations[ref.annotationIndex];
  if (!found) throw new AnnotationRenderError("not-found", "La anotacion ya no esta en la pagina.");
  return found;
}

function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

/** Region de una anotacion para render aislado a la escala de exportacion. */
async function renderBox(env: PageEnv, rect: ViewRect): Promise<{ image: RasterImage; scale: number }> {
  const layer = await renderAnnotationLayer(env, [rect], EXPORT_SCALE);
  const crop = cropLayer(layer, rect);
  return { image: crop, scale: layer.scale };
}

function nearestForm(candidates: ReturnType<typeof scanPageOperators>["forms"], viewWidth: number, viewHeight: number, rect: NormRect) {
  let best: (typeof candidates)[number] | null = null;
  let bestScore = 0;
  for (const form of candidates) {
    const likeness = stampLikeness(form, viewWidth, viewHeight);
    if (!likeness) continue;
    const x0 = Math.max(form.bbox.x / viewWidth, rect.x);
    const y0 = Math.max(form.bbox.y / viewHeight, rect.y);
    const x1 = Math.min((form.bbox.x + form.bbox.width) / viewWidth, rect.x + rect.width);
    const y1 = Math.min((form.bbox.y + form.bbox.height) / viewHeight, rect.y + rect.height);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const union = (form.bbox.width * form.bbox.height) / (viewWidth * viewHeight) + rect.width * rect.height - inter;
    const score = union > 0 ? inter / union : 0;
    if (score > bestScore) {
      best = form;
      bestScore = score;
    }
  }
  return bestScore > 0.3 ? best : null;
}

/**
 * Bytes del elemento en el formato pedido (por defecto, el primero de `asset.formats`). `source` puede ser el documento de pdf.js ya
 * abierto (no se cierra) o un `Blob`/`Uint8Array` (se abre y se cierra). Lanza `AnnotationRenderError` con codigo estable.
 */
export async function renderAnnotationAsset(
  source: RenderSource,
  asset: ExtractedAsset,
  format?: AssetFormat,
  ctx: Pick<AnnotationContext, "ops" | "createSurface" | "options"> = {},
): Promise<Blob> {
  const wanted: AssetFormat = format ?? asset.formats[0] ?? "png";
  if (!asset.formats.includes(wanted)) throw new AnnotationRenderError("unsupported-format", `El elemento no ofrece ${wanted}.`);
  const signal = ctx.options?.signal;
  const createSurface = ctx.createSurface ?? defaultSurfaceFactory();
  const ref = asset.ref;

  // Los elementos de texto no necesitan el documento.
  if (ref.engine === "text") {
    const textRef = ref as TextWatermarkRef;
    if (wanted === "txt") return new Blob([`${textRef.text}\n`], { type: "text/plain;charset=utf-8" });
    if (wanted === "svg") return svgBlob(buildTextWatermarkSvg(textRef));
    if (wanted === "png") return pngBlob(renderTextWatermarkPreview(textRef, createSurface, EXPORT_SCALE));
    throw new AnnotationRenderError("unsupported-format");
  }

  try {
    return await withDocument(source, async (doc) => {
      const pageIndex = ref.engine === "ocg" ? (asset.occurrences[0]?.pageIndex ?? 0) : ref.pageIndex;
      if (pageIndex < 0 || pageIndex >= doc.numPages) throw new AnnotationRenderError("not-found", "La pagina ya no existe.");
      const page = await withTimeout(doc.getPage(pageIndex + 1), STEP_TIMEOUT_MS, signal, "pagina");
      try {
        const env = makePageEnv(doc, page, pageIndex, createSurface, signal, STEP_TIMEOUT_MS);

        if (ref.engine === "ocg") {
          const region = { x: 0, y: 0, width: env.viewWidth, height: env.viewHeight };
          const scale = fitScale(region.width, region.height, EXPORT_SCALE);
          const layer = await renderOcgLayer({ doc, page, groupId: ref.groupId, region, scale, createSurface, signal });
          const trimmed = trimTransparent(layer, 2, 8);
          if (!trimmed) throw new AnnotationRenderError("no-pixels", "La capa no pinta nada en esa pagina.");
          return pngBlob(trimmed.image);
        }

        if (ref.engine === "vector") {
          const ops: PdfOps = ctx.ops ?? ((await getPdfJs()).OPS as unknown as PdfOps);
          const list = await withTimeout(page.getOperatorList({ annotationMode: ANNOTATION_MODE.DISABLE } as never), STEP_TIMEOUT_MS, signal, "operadores");
          const graphics = scanPageOperators(list.fnArray as unknown as ArrayLike<number>, list.argsArray as unknown as ArrayLike<unknown>, ops, env);
          const form = nearestForm(graphics.forms, env.viewWidth, env.viewHeight, ref.rect);
          if (!form || !form.dominantColor) throw new AnnotationRenderError("not-found", "No se encontro el sello en la pagina.");
          const rendered = await renderFormStamp(env, form.bbox, form.dominantColor, EXPORT_SCALE);
          if (!rendered) throw new AnnotationRenderError("no-pixels");
          return pngBlob(rendered.image);
        }

        if (ref.engine !== "annotation") throw new AnnotationRenderError("unsupported-format", "Este motor no regenera ese tipo de elemento.");
        const annotation = await findAnnotation(env, asset);

        if (asset.source === "ink-annot") {
          const shape = inkShapeOf(annotation, env.toView);
          if (!shape) throw new AnnotationRenderError("no-pixels", "La anotacion no tiene trazos.");
          if (wanted === "svg") return svgBlob(buildInkSvg(shape));
          if (wanted === "png") return pngBlob(renderInkRaster(shape, createSurface, EXPORT_SCALE));
          throw new AnnotationRenderError("unsupported-format");
        }

        const rect = annotationViewRect(env, annotation);
        if (!rect) throw new AnnotationRenderError("no-pixels", "La anotacion no tiene caja visible.");
        const { image } = await renderBox(env, rect);
        if (wanted !== "png") throw new AnnotationRenderError("unsupported-format");
        if (asset.source === "sig-widget") {
          const cleaned = await cleanSignatureRaster(image, signal);
          if (!cleaned) throw new AnnotationRenderError("no-pixels", "El campo de firma no tiene trazo visible.");
          return pngBlob(cleaned.image);
        }
        const trimmed = trimTransparent(image, 1, 8);
        if (!trimmed) throw new AnnotationRenderError("no-pixels", "La anotacion no pinta nada.");
        return pngBlob(trimmed.image);
      } finally {
        try {
          page.cleanup();
        } catch {
          // Documento ya destruido.
        }
      }
    });
  } catch (error) {
    if (cancelled(error, signal)) throw new PdfError("cancelled");
    throw error;
  }
}
