/**
 * Marcas de agua de TEXTO (deteccion (c) de docs/PLAN-FIRMA-AGIL.md §9.5): texto girado o grande y translucido (`setGState ca < 1`)
 * que se repite en >= 50 % de las paginas. La decision es pura (sobre los `TextRun` que saca `watermarkOps.ts`); la vista previa
 * se dibuja aparte, en SVG (sin canvas) y en PNG (con la superficie que se inyecte).
 */

import type { ExtractedAsset, NormRect } from "./types";
import { EXPORT_SCALE, WATERMARK_NAME_PATTERN, foldText, type Context2D, type RasterImage, type SurfaceFactory, type TextWatermarkRef } from "./annotationsTypes";
import { normalizeViewRect, shortHash, thumbBlob, trimTransparent } from "./annotationsRaster";
import type { TextRun } from "./watermarkOps";

/** Opacidad por debajo de la cual un texto cuenta como translucido. */
export const MAX_WATERMARK_ALPHA = 0.85;
/** Cuerpo (puntos efectivos) a partir del cual un texto translucido cuenta como «grande». */
export const BIG_TEXT_PT = 36;
/** Fraccion minima de paginas en que debe aparecer. */
export const MIN_PAGE_FRACTION = 0.5;

/** Un texto esta girado «en diagonal» si su angulo no esta cerca de un multiplo de 90 grados. */
export function isDiagonal(angleDeg: number): boolean {
  const a = Math.abs(angleDeg) % 90;
  return a >= 12 && a <= 78;
}

/** Palabras de marcas de agua frecuentes (BORRADOR, CONFIDENCIAL, COPIA…): permiten aceptar una sola pagina con menos confianza. */
const KEYWORDS = /(?<![a-z])(borrador|confidencial|confidential|draft|copia|copy|muestra|sample|anulado|void|no\s?valido|duplicado|original|prueba|preliminar|preliminary)(?![a-z])/;

export function hasWatermarkKeyword(text: string): boolean {
  const folded = foldText(text);
  return KEYWORDS.test(folded) || WATERMARK_NAME_PATTERN.test(folded);
}

/** Una ejecucion de texto «parece marca de agua»: translucida, con 2+ letras y (diagonal o grande). */
export function isWatermarkLikeRun(run: TextRun): boolean {
  if (run.alpha >= MAX_WATERMARK_ALPHA) return false;
  if (run.text.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return false;
  return isDiagonal(run.angleDeg) || run.fontSizePt >= BIG_TEXT_PT;
}

export type TextPageFindings = {
  pageIndex: number;
  viewWidth: number;
  viewHeight: number;
  runs: TextRun[];
};

export type TextWatermarkCandidate = {
  text: string;
  pages: number[];
  /** Primera caja de cada pagina (normalizada). */
  occurrences: Array<{ pageIndex: number; rect: NormRect }>;
  /** Una ejecucion representativa (la de la primera pagina). */
  angleDeg: number;
  fontSizePt: number;
  opacity: number;
  pageSize: { width: number; height: number };
  confidence: number;
  reasons: string[];
};

function keyOf(text: string): string {
  return foldText(text).replace(/\s+/g, " ").trim();
}

/**
 * Agrupa por texto normalizado y decide cuales son marcas de agua: deben aparecer en >= 50 % de las `pagesConsidered` paginas
 * (y en 2 o mas) o, con una sola pagina en el documento, llevar una palabra tipica de marca de agua.
 * `excludeOcIds`: grupos de contenido opcional que ya entrega la deteccion (a): sus textos no se repiten aqui.
 */
export function aggregateTextWatermarks(pages: TextPageFindings[], pagesConsidered: number, excludeOcIds: ReadonlySet<string> = new Set()): TextWatermarkCandidate[] {
  type Entry = { text: string; pages: Map<number, { rect: NormRect; run: TextRun }>; first: TextRun; size: { width: number; height: number } };
  const entries = new Map<string, Entry>();
  for (const page of pages) {
    for (const run of page.runs) {
      if (!isWatermarkLikeRun(run)) continue;
      if (run.ocIds.some((id) => excludeOcIds.has(id))) continue;
      const key = keyOf(run.text);
      if (!key) continue;
      let entry = entries.get(key);
      if (!entry) {
        entry = { text: run.text, pages: new Map(), first: run, size: { width: page.viewWidth, height: page.viewHeight } };
        entries.set(key, entry);
      }
      if (!entry.pages.has(page.pageIndex)) {
        entry.pages.set(page.pageIndex, { rect: normalizeViewRect(run.bbox, page.viewWidth, page.viewHeight), run });
      }
    }
  }
  const out: TextWatermarkCandidate[] = [];
  for (const entry of entries.values()) {
    const count = entry.pages.size;
    const fraction = pagesConsidered > 0 ? count / pagesConsidered : 0;
    const keyword = hasWatermarkKeyword(entry.text);
    const repeated = count >= 2 && fraction >= MIN_PAGE_FRACTION;
    const single = pagesConsidered === 1 && count === 1 && keyword;
    if (!repeated && !single) continue;
    const run = entry.first;
    const reasons: string[] = [];
    reasons.push(`texto translúcido (opacidad ${Math.round(run.alpha * 100)} %)`);
    if (isDiagonal(run.angleDeg)) reasons.push(`girado ${Math.round(Math.abs(run.angleDeg))}°`);
    if (run.fontSizePt >= BIG_TEXT_PT) reasons.push(`texto grande (${Math.round(run.fontSizePt)} pt)`);
    if (repeated) reasons.push(`repetido en ${count} de ${pagesConsidered} páginas`);
    else reasons.push("única página del documento");
    if (keyword) reasons.push("palabra típica de marca de agua");
    let confidence = repeated ? 0.55 : 0.5;
    if (repeated && fraction >= 0.9) confidence += 0.1;
    if (keyword) confidence += 0.1;
    if (isDiagonal(run.angleDeg)) confidence += 0.1;
    if (run.alpha <= 0.4) confidence += 0.05;
    out.push({
      text: entry.text,
      pages: [...entry.pages.keys()].sort((a, b) => a - b),
      occurrences: [...entry.pages.entries()].sort((a, b) => a[0] - b[0]).map(([pageIndex, value]) => ({ pageIndex, rect: value.rect })),
      angleDeg: run.angleDeg,
      fontSizePt: run.fontSizePt,
      opacity: run.alpha,
      pageSize: entry.size,
      confidence: Math.min(0.95, Math.round(confidence * 100) / 100),
      reasons,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.text.localeCompare(b.text));
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Vista previa                                                                                                    */
/* -------------------------------------------------------------------------------------------------------------- */

const PREVIEW_COLOR = "#6b7280";

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char);
}

/** Ancho aproximado de un texto (Helvetica ~ 0,56 em por letra) y alto de linea. */
function approxTextBox(text: string, size: number): { width: number; height: number } {
  return { width: Math.max(size, text.length * size * 0.56), height: size * 1.25 };
}

/** SVG de la marca de agua: el texto con su cuerpo, giro y opacidad. Sin fuentes incrustadas (`sans-serif`). */
export function buildTextWatermarkSvg(ref: TextWatermarkRef): string {
  const size = Math.max(6, ref.fontSizePt ?? 48);
  const angle = ref.angleDeg ?? 0;
  const box = approxTextBox(ref.text, size);
  const rad = (angle * Math.PI) / 180;
  const w = Math.abs(box.width * Math.cos(rad)) + Math.abs(box.height * Math.sin(rad));
  const h = Math.abs(box.width * Math.sin(rad)) + Math.abs(box.height * Math.cos(rad));
  const pad = size * 0.15;
  const width = Math.ceil(w + 2 * pad);
  const height = Math.ceil(h + 2 * pad);
  const opacity = Math.min(1, Math.max(0.05, ref.opacity ?? 0.3));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="${round1(size)}" ` +
    `fill="${PREVIEW_COLOR}" fill-opacity="${round1(opacity * 100) / 100}" transform="rotate(${round1(-angle)} ${width / 2} ${height / 2})">${escapeXml(ref.text)}</text></svg>`
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Vista previa PNG (fondo transparente) del texto a `scale` px por punto, recortada al texto. */
export function renderTextWatermarkPreview(ref: TextWatermarkRef, createSurface: SurfaceFactory, scale: number): RasterImage {
  const size = Math.max(6, ref.fontSizePt ?? 48) * scale;
  const angle = ((ref.angleDeg ?? 0) * Math.PI) / 180;
  const box = approxTextBox(ref.text, size);
  const w = Math.abs(box.width * Math.cos(angle)) + Math.abs(box.height * Math.sin(angle));
  const h = Math.abs(box.width * Math.sin(angle)) + Math.abs(box.height * Math.cos(angle));
  const width = Math.max(8, Math.min(4096, Math.ceil(w + size * 0.3)));
  const height = Math.max(8, Math.min(4096, Math.ceil(h + size * 0.3)));
  const surface = createSurface(width, height);
  try {
    const ctx = surface.context as unknown as CanvasRenderingContext2D & Context2D;
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-angle);
    ctx.fillStyle = PREVIEW_COLOR;
    ctx.globalAlpha = Math.min(1, Math.max(0.6, ref.opacity ?? 0.6));
    ctx.font = `${Math.round(size)}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ref.text, 0, 0);
    const raw = surface.context.getImageData(0, 0, width, height);
    const image: RasterImage = { width, height, data: raw.data };
    return trimTransparent(image, Math.ceil(size * 0.05), 4)?.image ?? image;
  } finally {
    surface.release();
  }
}

/** Elemento del contrato a partir de un candidato. La miniatura es una vista previa dibujada, no pixeles de la pagina. */
export async function buildTextWatermarkAsset(candidate: TextWatermarkCandidate, createSurface: SurfaceFactory): Promise<ExtractedAsset> {
  const ref: TextWatermarkRef = {
    engine: "text",
    text: candidate.text,
    angleDeg: candidate.angleDeg,
    fontSizePt: candidate.fontSizePt,
    opacity: candidate.opacity,
    pageSize: candidate.pageSize,
  };
  let thumb: Blob | null = null;
  let width = 0;
  let height = 0;
  try {
    const preview = renderTextWatermarkPreview(ref, createSurface, 1);
    thumb = await thumbBlob(preview);
    width = preview.width;
    height = preview.height;
  } catch {
    thumb = null;
  }
  return {
    id: `wm-text-${shortHash(`${candidate.text}|${candidate.pages.join(",")}`)}`,
    kind: "watermark",
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    source: "text",
    occurrences: candidate.occurrences,
    pixel: thumb ? { width: width * EXPORT_SCALE, height: height * EXPORT_SCALE, hasAlpha: true } : null,
    formats: ["txt", "png", "svg"],
    bytesEstimate: new TextEncoder().encode(candidate.text).length,
    thumb,
    ref,
  };
}
