/**
 * Campos de firma `/Sig` (widget con `fieldType: "Sig"`). Se renderiza SOLO la caja del campo con la anotacion activa y sin la
 * pagina, se limpia con `inkExtract` (fondo fuera, recorte, PNG transparente) y se avisa «firmado digitalmente» si trae `/V`
 * (la validez criptografica NO se verifica: queda fuera del alcance). Los campos vacios, los invisibles y los cuya apariencia es
 * texto («Firmado digitalmente por…») se devuelven con confianza baja y la razon.
 */

import type { ExtractWarning, ExtractedAsset } from "./types";
import { EXPORT_SCALE, type PdfJsAnnotation, type RasterImage } from "./annotationsTypes";
import type { PdfLibAnnotation } from "./annotationsPdfLib";
import { annotationViewRect, cleanSignatureRaster, cropLayer, type AnnotationLayer, type PageEnv } from "./annotationsPage";
import { estimatePngBytes, normalizeViewRect, shortHash, thumbBlob, type ViewRect } from "./annotationsRaster";

export type SigInput = {
  env: PageEnv;
  annotation: PdfJsAnnotation;
  annotationIndex: number;
  /** Lo que pdf-lib ve de esta anotacion (puede faltar si no hay bytes). */
  lib?: PdfLibAnnotation;
  /** Capa de anotaciones de la pagina ya renderizada que cubre la caja (si la hay). */
  layer?: AnnotationLayer;
};

export type SigOutput = { asset: ExtractedAsset; warning?: ExtractWarning };

/** `true` si la apariencia parece solo texto (sin imagen ni trazos de verdad). */
export function appearanceLooksLikeText(lib: PdfLibAnnotation | undefined): boolean {
  const a = lib?.appearance;
  if (!a || !a.present) return false;
  return a.hasText && !a.hasImage && a.pathSegments <= 8;
}

export function isSigWidget(annotation: PdfJsAnnotation): boolean {
  return annotation.subtype === "Widget" && annotation.fieldType === "Sig";
}

function isSigned(annotation: PdfJsAnnotation, lib: PdfLibAnnotation | undefined): boolean {
  if (lib) return lib.hasValue;
  const value = annotation.fieldValue;
  return value !== null && value !== undefined && value !== "";
}

/** Caja util del campo: `null` si es invisible (0 x 0). */
export function sigViewRect(env: PageEnv, annotation: PdfJsAnnotation): ViewRect | null {
  return annotationViewRect(env, annotation);
}

export async function buildSigAsset(input: SigInput): Promise<SigOutput> {
  const { env, annotation, annotationIndex, lib, layer } = input;
  const signed = isSigned(annotation, lib);
  const rect = sigViewRect(env, annotation);
  const annotationId = annotation.id;
  const ref = { engine: "annotation" as const, pageIndex: env.pageIndex, annotationIndex, ...(annotationId ? { annotationId } : {}) };
  const fieldName = annotation.fieldName || lib?.fieldName || "";
  const reasons: string[] = ["campo de firma (/Sig)"];
  const warning: ExtractWarning | undefined = signed ? { code: "digital-signature", pageIndex: env.pageIndex, detail: fieldName || undefined } : undefined;
  if (signed) reasons.push("firmado digitalmente (no se verifica la validez criptográfica)");
  const idBase = `sig|${env.pageIndex}|${annotationId ?? annotationIndex}|${fieldName}`;
  const occurrenceRect = rect ? normalizeViewRect(rect, env.viewWidth, env.viewHeight) : { x: 0, y: 0, width: 0, height: 0 };

  const empty = (why: string, confidence: number): SigOutput => ({
    asset: {
      id: `sig-${shortHash(idBase)}`,
      kind: "signature",
      confidence,
      reasons: [...reasons, why],
      source: "sig-widget",
      occurrences: [{ pageIndex: env.pageIndex, rect: occurrenceRect }],
      pixel: null,
      formats: [],
      bytesEstimate: 0,
      thumb: null,
      ref,
    },
    warning,
  });

  const appearance = lib?.appearance;
  if (!rect) return empty(signed ? "firma digital invisible: no tiene caja visible" : "campo de firma vacío: sin caja visible", 0.1);
  if (lib && (!appearance?.present || appearance.empty)) {
    return empty(signed ? "firma digital sin apariencia visible" : "campo de firma vacío (sin firmar)", 0.1);
  }

  const source = layer ?? undefined;
  if (!source) return empty("no se pudo renderizar la caja del campo", 0.1);
  const cleaned = await cleanSignatureRaster(cropLayer(source, rect), env.signal);
  if (!cleaned) return empty(signed ? "firma digital sin trazo visible" : "campo de firma vacío (sin trazo visible)", 0.12);

  const textLike = appearanceLooksLikeText(lib);
  let confidence = 0.8;
  if (textLike) {
    confidence = 0.3;
    reasons.push("la apariencia parece texto («Firmado digitalmente por…»), no una firma manuscrita");
  } else if (!lib) {
    confidence = 0.6;
    reasons.push("no se pudo comprobar si la apariencia es texto o firma manuscrita");
  } else if (appearance?.hasImage) {
    reasons.push("la apariencia contiene una imagen");
  } else {
    reasons.push("la apariencia contiene trazos");
  }
  const thumb = await thumbBlob(cleaned.image);
  const factor = EXPORT_SCALE / source.scale;
  const pixelWidth = Math.max(1, Math.round(cleaned.image.width * factor));
  const pixelHeight = Math.max(1, Math.round(cleaned.image.height * factor));
  return {
    asset: {
      id: `sig-${shortHash(idBase)}`,
      kind: "signature",
      confidence,
      reasons,
      source: "sig-widget",
      occurrences: [{ pageIndex: env.pageIndex, rect: occurrenceRect }],
      pixel: { width: pixelWidth, height: pixelHeight, hasAlpha: true },
      formats: ["png"],
      bytesEstimate: estimatePngBytes(thumb.size, Math.min(256, cleaned.image.width) * Math.min(256, cleaned.image.height), pixelWidth * pixelHeight),
      thumb,
      ref,
    },
    warning,
  };
}

/** Raster limpio de una firma a la escala de exportacion (para `renderAnnotationAsset`). `null` si no hay tinta. */
export async function renderSigClean(image: RasterImage, signal?: AbortSignal): Promise<RasterImage | null> {
  const cleaned = await cleanSignatureRaster(image, signal);
  return cleaned?.image ?? null;
}
