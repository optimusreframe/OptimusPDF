/**
 * Sellos hechos con Form XObject (no con anotacion): un grupo de contenido de tamano pequeno o mediano, con un color saturado
 * (rojo o azul) y forma circular, ovalada o rectangular. Fiabilidad MEDIA (es una heuristica). Como el sello va cocido en la
 * pagina, sus pixeles se obtienen del render de su caja y se «desmezclan» del papel con el color dominante que dan los operadores:
 * lo que no es de ese color (texto negro debajo, otras figuras) queda transparente.
 */

import type { ExtractedAsset, NormRect } from "./types";
import { EXPORT_SCALE, type RasterImage } from "./annotationsTypes";
import type { PageEnv } from "./annotationsPage";
import { estimatePngBytes, fitScale, normalizeViewRect, renderRegion, shortHash, thumbBlob, trimTransparent, type ViewRect } from "./annotationsRaster";
import { hexToHsv, type FormCandidate } from "./watermarkOps";

export type StampLikeness = {
  shape: "circular" | "oval" | "rectangular";
  tone: "rojo" | "azul";
  color: string;
  confidence: number;
  reasons: string[];
};

/** Fraccion minima y maxima del area de la pagina que puede ocupar un sello. */
export const STAMP_MIN_AREA = 0.002;
export const STAMP_MAX_AREA = 0.2;

/** Residuo maximo (distancia al eje blanco-color) que se tolera: base fija mas una fraccion de la magnitud del pixel. */
export const RESIDUAL_BASE = 10;
export const RESIDUAL_RATIO = 0.12;

export function toneOf(hex: string): "rojo" | "azul" | null {
  const hsv = hexToHsv(hex);
  if (!hsv) return null;
  if ((hsv.h <= 18 || hsv.h >= 342) && hsv.s >= 0.55 && hsv.v >= 0.4) return "rojo";
  if (hsv.h >= 200 && hsv.h <= 255 && hsv.s >= 0.5 && hsv.v >= 0.3) return "azul";
  return null;
}

/** ¿Este Form XObject parece un sello? Devuelve la razon y la confianza, o `null`. */
export function stampLikeness(form: FormCandidate, viewWidth: number, viewHeight: number): StampLikeness | null {
  const { bbox } = form;
  if (!form.dominantColor || form.dominantShare < 0.6 || form.paints < 1) return null;
  const tone = toneOf(form.dominantColor);
  if (!tone) return null;
  const area = (bbox.width * bbox.height) / (viewWidth * viewHeight);
  if (!(area >= STAMP_MIN_AREA && area <= STAMP_MAX_AREA)) return null;
  if (bbox.width > viewWidth * 0.7 || bbox.height > viewHeight * 0.7) return null;
  if (bbox.width < 12 || bbox.height < 12) return null;
  const aspect = bbox.width / bbox.height;
  let shape: StampLikeness["shape"] | null = null;
  if (form.curves >= 4 && aspect >= 0.8 && aspect <= 1.25) shape = "circular";
  else if (form.curves >= 4 && aspect >= 0.45 && aspect <= 2.4) shape = "oval";
  // Un recuadro sin texto es casi siempre un marco o un llamado, no un sello: el rectangular exige palabras dentro.
  else if (form.lines >= 3 && form.curves < 4 && form.hasText && aspect >= 0.3 && aspect <= 4) shape = "rectangular";
  if (!shape) return null;
  const reasons = [
    `grupo de contenido (Form XObject) de ${Math.round(bbox.width)} × ${Math.round(bbox.height)} pt`,
    `color ${tone} saturado`,
    shape === "circular" ? "forma circular" : shape === "oval" ? "forma ovalada" : "forma rectangular",
  ];
  let confidence = 0.5;
  if (shape !== "rectangular") confidence += 0.1;
  if (form.hasText) {
    confidence += 0.1;
    reasons.push(`lleva texto${form.text ? ` («${form.text.slice(0, 40)}»)` : ""}`);
  }
  return { shape, tone, color: form.dominantColor, confidence: Math.min(0.7, Math.round(confidence * 100) / 100), reasons };
}

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Deja solo lo que es del color `hex` sobre el papel blanco: alfa por proyeccion sobre el eje blanco-color y descarte de lo que
 * se aleja de ese eje (texto negro, otras tintas). La entrada es RGBA con fondo transparente.
 */
export function unmixStampColor(image: RasterImage, hex: string): RasterImage {
  const [cr, cg, cb] = parseHex(hex);
  const dr = 255 - cr;
  const dg = 255 - cg;
  const db = 255 - cb;
  const denom = dr * dr + dg * dg + db * db;
  const out = new Uint8ClampedArray(image.data.length);
  if (denom < 3000) return { width: image.width, height: image.height, data: out };
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    const t = a / 255;
    const vr = 255 - (src[i] * t + 255 * (1 - t));
    const vg = 255 - (src[i + 1] * t + 255 * (1 - t));
    const vb = 255 - (src[i + 2] * t + 255 * (1 - t));
    const alpha = Math.min(1, Math.max(0, (vr * dr + vg * dg + vb * db) / denom));
    if (alpha < 0.04) continue;
    const er = vr - alpha * dr;
    const eg = vg - alpha * dg;
    const eb = vb - alpha * db;
    // Lo que no es de ese color (gris translucido, negro, otras tintas) deja un residuo grande frente a su propia magnitud.
    if (Math.hypot(er, eg, eb) > RESIDUAL_BASE + RESIDUAL_RATIO * Math.hypot(vr, vg, vb)) continue;
    out[i] = cr;
    out[i + 1] = cg;
    out[i + 2] = cb;
    out[i + 3] = Math.round(alpha * 255);
  }
  return { width: image.width, height: image.height, data: out };
}

/** Render de la caja de un sello de Form XObject a `scale` px/pt y desmezcla; `null` si no queda nada. */
export async function renderFormStamp(env: PageEnv, bbox: ViewRect, color: string, wantedScale: number): Promise<{ image: RasterImage; scale: number } | null> {
  const pad = 2;
  const region: ViewRect = {
    x: Math.max(0, bbox.x - pad),
    y: Math.max(0, bbox.y - pad),
    width: Math.min(env.viewWidth, bbox.x + bbox.width + pad) - Math.max(0, bbox.x - pad),
    height: Math.min(env.viewHeight, bbox.y + bbox.height + pad) - Math.max(0, bbox.y - pad),
  };
  const scale = fitScale(region.width, region.height, wantedScale);
  const raw = await renderRegion({ page: env.page, region, scale, annotationMode: 0, createSurface: env.createSurface, signal: env.signal, timeoutMs: env.timeoutMs });
  const trimmed = trimTransparent(unmixStampColor(raw, color), 1, 12);
  return trimmed ? { image: trimmed.image, scale } : null;
}

export type FormStampOccurrence = { env: PageEnv; form: FormCandidate; likeness: StampLikeness };

/** Agrupa los sellos iguales (misma huella, color y tamano) de varias paginas: un elemento con todas sus ocurrencias. */
export function groupFormStamps(found: FormStampOccurrence[]): FormStampOccurrence[][] {
  const groups = new Map<string, FormStampOccurrence[]>();
  for (const item of found) {
    const key = `${item.form.fingerprint}|${item.likeness.color}|${Math.round(item.form.bbox.width / 2)}x${Math.round(item.form.bbox.height / 2)}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.values()];
}

export async function buildFormStampAsset(group: FormStampOccurrence[]): Promise<ExtractedAsset | null> {
  const first = group[0];
  const rendered = await renderFormStamp(first.env, first.form.bbox, first.likeness.color, 3);
  if (!rendered) return null;
  const pages = new Set(group.map((item) => item.env.pageIndex));
  const reasons = [...first.likeness.reasons];
  let confidence = first.likeness.confidence;
  if (pages.size > 1) {
    reasons.push(`repetido en ${pages.size} páginas`);
    confidence = Math.min(0.7, Math.round((confidence + 0.05) * 100) / 100);
  }
  const thumb = await thumbBlob(rendered.image);
  const factor = EXPORT_SCALE / rendered.scale;
  const width = Math.max(1, Math.round(rendered.image.width * factor));
  const height = Math.max(1, Math.round(rendered.image.height * factor));
  const occurrences: Array<{ pageIndex: number; rect: NormRect }> = [];
  const seen = new Set<string>();
  for (const item of group) {
    const rect = normalizeViewRect(item.form.bbox, item.env.viewWidth, item.env.viewHeight);
    const key = `${item.env.pageIndex}|${rect.x}|${rect.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    occurrences.push({ pageIndex: item.env.pageIndex, rect });
  }
  occurrences.sort((a, b) => a.pageIndex - b.pageIndex);
  const lead = occurrences[0];
  return {
    id: `stamp-form-${shortHash(`${first.form.fingerprint}|${first.likeness.color}|${lead.pageIndex}|${lead.rect.x}|${lead.rect.y}`)}`,
    kind: "stamp",
    confidence,
    reasons,
    source: "form",
    occurrences,
    pixel: { width, height, hasAlpha: true },
    formats: ["png"],
    bytesEstimate: estimatePngBytes(thumb.size, Math.min(256, rendered.image.width) * Math.min(256, rendered.image.height), width * height),
    thumb,
    ref: { engine: "vector", pageIndex: lead.pageIndex, rect: lead.rect },
  };
}
