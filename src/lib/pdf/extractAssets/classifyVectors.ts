/**
 * Decide si un grupo de trazos vectoriales (`vectors.ts`) es una FIRMA (o unas iniciales) dibujada a mano (U7.3, BETA). Se pide, ademas
 * de los rasgos de la escritura (muchas curvas, bucles, tinta oscura o azul, sin texto dentro), una SENAL EXTERNA: una etiqueta de
 * firma cerca («Signature», «Firma»...) o una raya de firma justo debajo. Sin ella un garabato decorativo, un logotipo vectorial o un
 * grafico no se ofrece. La confianza nunca pasa de `VECTOR_MAX_CONFIDENCE` (0,7): es «posible», jamas «probable».
 */

import { rgbToHsv } from "./classifyPixels";
import { labelReason, nearestLabel } from "./classifyText";
import {
  INITIALS_ASPECT,
  INITIALS_MAX_AREA,
  SIGNATURE_ASPECT,
  VECTOR_MAX_CONFIDENCE,
  type AcceptedVector,
  type LabelFact,
  type PageFacts,
  type PageVectors,
  type VectorCandidate,
} from "./classifyTypes";
import { sitsOnLine } from "./vectors";

/** Tamano (puntos) y forma de una firma vectorial. */
export const VECTOR_SIZE = { minWidth: 20, minHeight: 6, maxWidthFrac: 0.6, maxHeightFrac: 0.15 } as const;
/** Una firma tiene al menos esto de curvas, o de segmentos si es una poli-linea de tinta digital (muchos tramos cortos). */
export const VECTOR_MIN_CURVES = 8;
export const VECTOR_MIN_SHORT_SEGMENTS = 40;
/** Fraccion maxima de segmentos rectos horizontales o verticales. */
export const VECTOR_MAX_AXIS = 0.35;
/** Fraccion maxima de trazos que son marcadores cerrados (graficos de puntos). */
export const VECTOR_MAX_SHAPE_SHARE = 0.5;
/** Fraccion maxima de la caja cubierta por texto impreso. */
export const VECTOR_MAX_TEXT_OVERLAP = 0.2;
/** Cambios de sentido horizontal (bucles) para decir «escritura». */
export const VECTOR_MIN_X_REVERSALS = 2;
/** Luminancia maxima de la tinta. */
export const VECTOR_MAX_INK_LUMA = 150;

function luma(hex: string): number {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return 0;
  return 0.2126 * parseInt(match[1], 16) + 0.7152 * parseInt(match[2], 16) + 0.0722 * parseInt(match[3], 16);
}

function isBlueInk(hex: string): boolean {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return false;
  const hsv = rgbToHsv(parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16));
  return hsv.h >= 195 && hsv.h <= 265 && hsv.s >= 0.25;
}

function textOverlap(candidate: VectorCandidate, page: PageFacts | undefined): number {
  if (!page) return 0;
  const box = candidate.bbox;
  const area = box.width * box.height;
  if (area <= 0) return 0;
  let covered = 0;
  for (const line of page.lines) {
    const w = Math.min(box.x + box.width, line.x + line.width) - Math.max(box.x, line.x);
    const h = Math.min(box.y + box.height, line.y + line.height) - Math.max(box.y, line.y);
    if (w > 0 && h > 0) covered += w * h;
  }
  return Math.min(1, covered / area);
}

const noisyOr = (weights: ReadonlyArray<number>): number => 1 - weights.reduce((product, weight) => product * (1 - weight), 1);

/** `null` si el grupo no parece una firma. */
export function judgeVector(candidate: VectorCandidate, page: PageFacts | undefined, vectors: PageVectors | undefined, labels: ReadonlyArray<LabelFact>): AcceptedVector | null {
  const pageWidth = page?.width ?? 612;
  const pageHeight = page?.height ?? 792;
  const { bbox } = candidate;
  if (bbox.width < VECTOR_SIZE.minWidth || bbox.height < VECTOR_SIZE.minHeight) return null;
  if (bbox.width > pageWidth * VECTOR_SIZE.maxWidthFrac || bbox.height > pageHeight * VECTOR_SIZE.maxHeightFrac) return null;
  const complex = candidate.curves >= VECTOR_MIN_CURVES || candidate.segments >= VECTOR_MIN_SHORT_SEGMENTS;
  if (!complex) return null;
  if (candidate.axisAligned > VECTOR_MAX_AXIS) return null;
  if (candidate.shapeShare >= VECTOR_MAX_SHAPE_SHARE) return null;
  if (candidate.xReversals < VECTOR_MIN_X_REVERSALS) return null;
  const tint = luma(candidate.color);
  if (tint > VECTOR_MAX_INK_LUMA && !isBlueInk(candidate.color)) return null;
  const overlap = textOverlap(candidate, page);
  if (overlap > VECTOR_MAX_TEXT_OVERLAP) return null;

  const aspect = bbox.width / bbox.height;
  const area = candidate.rect.width * candidate.rect.height;
  const near = nearestLabel(bbox, labels, pageWidth);
  const onLine = vectors ? sitsOnLine(bbox, vectors.lines) : false;
  if (!near && !onLine) return null;

  let kind: AcceptedVector["kind"];
  if (near?.label.kind === "initials") kind = "initials";
  else if (near?.label.kind === "signature") kind = "signature";
  else kind = aspect >= SIGNATURE_ASPECT.min ? "signature" : "initials";
  if (kind === "signature" && (aspect < SIGNATURE_ASPECT.min || aspect > SIGNATURE_ASPECT.max)) {
    // Una firma muy cuadrada con etiqueta de firma: se ofrece igualmente, con menos confianza.
    if (aspect < INITIALS_ASPECT.min || aspect > SIGNATURE_ASPECT.max * 1.5) return null;
  }
  if (kind === "initials" && (aspect < INITIALS_ASPECT.min || aspect > INITIALS_ASPECT.max * 2 || area > INITIALS_MAX_AREA * 2)) return null;

  const weights: number[] = [0.3];
  const reasons = ["firma dibujada con trazos vectoriales (beta)", `${candidate.curves} curvas y ${candidate.xReversals} bucles`];
  if (aspect >= SIGNATURE_ASPECT.min && aspect <= SIGNATURE_ASPECT.max) weights.push(0.15);
  if (candidate.xReversals >= 4) weights.push(0.1);
  weights.push(0.1);
  reasons.push(isBlueInk(candidate.color) ? "tinta azul" : "tinta oscura");
  if (near) {
    weights.push(0.55 * near.label.strength);
    reasons.push(labelReason(near.label));
  }
  if (onLine) {
    weights.push(near ? 0.2 : 0.25);
    reasons.push("sobre una raya de firma");
  }
  const confidence = Math.min(VECTOR_MAX_CONFIDENCE, Math.round(noisyOr(weights) * 100) / 100);
  return { candidate, kind, confidence, reasons };
}
