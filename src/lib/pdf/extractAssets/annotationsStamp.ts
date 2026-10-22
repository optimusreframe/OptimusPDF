/**
 * Sellos (anotaciones `Stamp`) y marcas de agua en anotacion (`/Subtype /Watermark`, leida tambien con pdf-lib).
 * El sello se aisla renderizando su caja CON y SIN anotaciones: la diferencia son los pixeles del sello (PNG con alfa, fondo transparente).
 */

import type { ExtractedAsset, AssetKind, AssetSource } from "./types";
import { EXPORT_SCALE, type PdfJsAnnotation, type RasterImage } from "./annotationsTypes";
import type { PdfLibAnnotation } from "./annotationsPdfLib";
import { annotationViewRect, cropLayer, type AnnotationLayer, type PageEnv } from "./annotationsPage";
import { countVisible, estimatePngBytes, normalizeViewRect, shortHash, thumbBlob, trimTransparent } from "./annotationsRaster";

export type BoxAnnotationInput = {
  env: PageEnv;
  annotation: PdfJsAnnotation;
  annotationIndex: number;
  lib?: PdfLibAnnotation;
  layer: AnnotationLayer;
};

const SIGNATURE_HINT = /(firma|signature|signed|sign\s*here)/i;

/** Recorte transparente de lo que pinta la anotacion; `null` si no pinta nada. */
export function annotationPixels(layer: AnnotationLayer, env: PageEnv, annotation: PdfJsAnnotation): { image: RasterImage; visible: number } | null {
  const rect = annotationViewRect(env, annotation);
  if (!rect) return null;
  const crop = cropLayer(layer, rect);
  const trimmed = trimTransparent(crop, 1, 8);
  if (!trimmed) return null;
  return { image: trimmed.image, visible: countVisible(trimmed.image, 8) };
}

async function buildBoxAsset(
  input: BoxAnnotationInput,
  options: { kind: AssetKind; source: AssetSource; idPrefix: string; confidence: number; reasons: string[] },
): Promise<ExtractedAsset | null> {
  const { env, annotation, annotationIndex, layer } = input;
  const rect = annotationViewRect(env, annotation);
  const pixels = annotationPixels(layer, env, annotation);
  if (!rect || !pixels) return null;
  const thumb = await thumbBlob(pixels.image);
  const factor = EXPORT_SCALE / layer.scale;
  const width = Math.max(1, Math.round(pixels.image.width * factor));
  const height = Math.max(1, Math.round(pixels.image.height * factor));
  const annotationId = annotation.id;
  return {
    id: `${options.idPrefix}-${shortHash(`${options.idPrefix}|${env.pageIndex}|${annotationId ?? annotationIndex}|${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`)}`,
    kind: options.kind,
    confidence: options.confidence,
    reasons: options.reasons,
    source: options.source,
    occurrences: [{ pageIndex: env.pageIndex, rect: normalizeViewRect(rect, env.viewWidth, env.viewHeight) }],
    pixel: { width, height, hasAlpha: true },
    formats: ["png"],
    bytesEstimate: estimatePngBytes(thumb.size, Math.min(256, pixels.image.width) * Math.min(256, pixels.image.height), width * height),
    thumb,
    ref: { engine: "annotation", pageIndex: env.pageIndex, annotationIndex, ...(annotationId ? { annotationId } : {}) },
  };
}

/** Anotacion `Stamp` -> sello (o firma, si su nombre o texto lo dice). Alta confianza: es una anotacion de verdad. */
export async function buildStampAsset(input: BoxAnnotationInput): Promise<ExtractedAsset | null> {
  const hint = `${input.lib?.stampName ?? ""} ${input.lib?.contents ?? ""}`;
  const signature = SIGNATURE_HINT.test(hint);
  const reasons = ["anotación de sello (Stamp)"];
  if (input.lib?.stampName) reasons.push(`nombre del sello: «${input.lib.stampName}»`);
  if (signature) reasons.push("el nombre o el texto del sello habla de una firma");
  return buildBoxAsset(input, { kind: signature ? "signature" : "stamp", source: "stamp-annot", idPrefix: "stamp", confidence: signature ? 0.7 : 0.9, reasons });
}

/** Anotacion `/Watermark` con apariencia -> marca de agua. */
export async function buildWatermarkAnnotationAsset(input: BoxAnnotationInput): Promise<ExtractedAsset | null> {
  const reasons = ["anotación de marca de agua (/Subtype /Watermark)"];
  if (input.lib?.appearance.hasText) reasons.push("su apariencia incluye texto");
  return buildBoxAsset(input, { kind: "watermark", source: "stamp-annot", idPrefix: "wm-annot", confidence: 0.9, reasons });
}
