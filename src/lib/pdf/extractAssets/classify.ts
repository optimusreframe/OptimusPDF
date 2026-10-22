/**
 * Clasificador heuristico de «Extraer elementos» (U7.3, docs/PLAN-FIRMA-AGIL.md §9.5). Recibe lo que devolvieron los motores (hoy todas
 * las imagenes salen como `image`) y los HECHOS de cada pagina (texto con posiciones, grupos de trazos vectoriales) y decide el tipo de
 * cada elemento: firmas e iniciales COMO IMAGEN, logos, fotos, sellos como imagen, marcas de agua translucidas y firmas dibujadas como
 * vectores (beta). Cada decision deja motivos legibles y una confianza calibrada (0,85 o mas = «probable»; menos = «posible»).
 *
 * Los elementos que ya trae clasificados otro motor (Ink, Stamp, /Sig, capas, texto) no se reclasifican: solo se les anade, si la hay,
 * la etiqueta de firma cercana. No hace red ni toca el DOM: los pixeles salen de la miniatura PNG (`classifyPng.ts`).
 */

import { analyzePixels } from "./classifyPixels";
import { decodePngThumb } from "./classifyPng";
import { judgeVector } from "./classifyVectors";
import {
  coversPage,
  judgeInkImage,
  judgeLogoImage,
  judgePhotoImage,
  judgeStampImage,
  judgeWatermarkImage,
  mergeReasons,
  type Decision,
  type Geometry,
} from "./classifyRules";
import { labelReason, labelsByPage, nearestLabel, type NearLabel } from "./classifyText";
import {
  HEADER_FOOTER_BAND,
  KIND_ORDER,
  type AcceptedVector,
  type ClassifyInput,
  type ClassifyOutput,
  type LabelFact,
  type PageFacts,
  type PageSize,
  type PixelFeatures,
} from "./classifyTypes";
import type { AssetOccurrence, ExtractedAsset, NormRect } from "./types";

const DEFAULT_PAGE: PageSize = { width: 612, height: 792 };
/** Tolerancia (fraccion de la pagina) para decir que dos apariciones estan en el mismo sitio. */
const SAME_PLACE = 0.04;
/** Cuanto se solapan dos cajas (IoU) para ser la misma pieza vista por dos motores. */
export const DUPLICATE_IOU = 0.6;

export function iou(a: NormRect, b: NormRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Geometria de un elemento a partir de sus apariciones (la mas grande manda para el tamano). */
export function geometryOf(occurrences: ReadonlyArray<AssetOccurrence>, sizeOf: (pageIndex: number) => PageSize, firstPageIndex: number): Geometry | null {
  if (occurrences.length === 0) return null;
  let main = occurrences[0];
  for (const occurrence of occurrences) if (occurrence.rect.width * occurrence.rect.height > main.rect.width * main.rect.height) main = occurrence;
  const size = sizeOf(main.pageIndex);
  const width = main.rect.width * size.width;
  const height = main.rect.height * size.height;
  const places = new Map<string, { pages: Set<number>; top: number; bottom: number; count: number }>();
  for (const occurrence of occurrences) {
    const cx = occurrence.rect.x + occurrence.rect.width / 2;
    const cy = occurrence.rect.y + occurrence.rect.height / 2;
    const key = `${Math.round(cx / SAME_PLACE)}|${Math.round(cy / SAME_PLACE)}`;
    const entry = places.get(key) ?? { pages: new Set<number>(), top: 0, bottom: 0, count: 0 };
    entry.pages.add(occurrence.pageIndex);
    if (cy < HEADER_FOOTER_BAND) entry.top += 1;
    if (cy > 1 - HEADER_FOOTER_BAND) entry.bottom += 1;
    entry.count += 1;
    places.set(key, entry);
  }
  let best = { pages: new Set<number>(), top: 0, bottom: 0, count: 0 };
  for (const entry of places.values()) if (entry.pages.size > best.pages.size) best = entry;
  let band: Geometry["band"] = null;
  if (best.pages.size >= 2) {
    if (best.top >= best.count / 2) band = "top";
    else if (best.bottom >= best.count / 2) band = "bottom";
  }
  const pages = new Set(occurrences.map((occurrence) => occurrence.pageIndex));
  const firstPageTop = occurrences.some((occurrence) => occurrence.pageIndex === firstPageIndex && occurrence.rect.y + occurrence.rect.height / 2 < HEADER_FOOTER_BAND);
  return {
    aspect: height > 0 ? width / height : 0,
    heightFrac: main.rect.height,
    areaFrac: main.rect.width * main.rect.height,
    widthFrac: main.rect.width,
    widthPt: width,
    heightPt: height,
    repeatPages: best.pages.size,
    band,
    firstPageTop,
    pages: pages.size,
  };
}

type Context = {
  sizeOf: (pageIndex: number) => PageSize;
  labels: Map<number, LabelFact[]>;
  firstPageIndex: number;
  analyzedPages: number;
  scanned: Set<number>;
};

function nearLabelFor(asset: ExtractedAsset, ctx: Context, kind: LabelFact["kind"]): NearLabel | null {
  let best: NearLabel | null = null;
  for (const occurrence of asset.occurrences.slice(0, 40)) {
    const size = ctx.sizeOf(occurrence.pageIndex);
    const box = { x: occurrence.rect.x * size.width, y: occurrence.rect.y * size.height, width: occurrence.rect.width * size.width, height: occurrence.rect.height * size.height };
    const found = nearestLabel(box, ctx.labels.get(occurrence.pageIndex) ?? [], size.width, kind);
    if (found && (!best || found.distance < best.distance)) best = found;
  }
  return best;
}

function apply(asset: ExtractedAsset, decision: Decision): ExtractedAsset {
  return { ...asset, kind: decision.kind, confidence: decision.confidence, reasons: mergeReasons(decision.reasons, asset.reasons) };
}

/** Imagen del motor (todas llegan como `image`): decide su tipo. */
export function classifyImageAsset(asset: ExtractedAsset, features: PixelFeatures | null, ctx: Context, geometry: Geometry): ExtractedAsset {
  const scannedPage = asset.occurrences.some((occurrence) => ctx.scanned.has(occurrence.pageIndex));
  if (coversPage(geometry.areaFrac)) {
    return scannedPage ? { ...asset, reasons: mergeReasons(["página completa: escaneo del documento"], asset.reasons) } : asset;
  }
  const input = {
    features,
    geometry,
    signatureLabel: nearLabelFor(asset, ctx, "signature"),
    initialsLabel: nearLabelFor(asset, ctx, "initials"),
    analyzedPages: ctx.analyzedPages,
    scannedPage,
  };
  const decision =
    judgeWatermarkImage(input) ?? judgeStampImage(input) ?? judgeInkImage(input) ?? judgeLogoImage(input) ?? judgePhotoImage(input);
  return decision ? apply(asset, decision) : asset;
}

/** Un elemento que otro motor ya clasifico: solo gana el motivo de la etiqueta cercana. */
function enrichClassified(asset: ExtractedAsset, ctx: Context): ExtractedAsset {
  if (asset.formats.length === 0) return asset;
  if (asset.kind !== "signature" && asset.kind !== "initials") return asset;
  const near = nearLabelFor(asset, ctx, asset.kind);
  if (!near) return asset;
  const reason = labelReason(near.label);
  if (asset.reasons.includes(reason)) return asset;
  const boosted = Math.min(0.97, Math.round((1 - (1 - asset.confidence) * (1 - 0.3 * near.label.strength)) * 100) / 100);
  return { ...asset, confidence: boosted, reasons: [...asset.reasons, reason] };
}

function sizesOf(pages: ReadonlyArray<PageFacts>): (pageIndex: number) => PageSize {
  const map = new Map<number, PageSize>();
  for (const page of pages) map.set(page.pageIndex, { width: page.width, height: page.height });
  return (pageIndex) => map.get(pageIndex) ?? DEFAULT_PAGE;
}

/** Orden de resultado: firmas e iniciales (por confianza), sellos, logos, marcas de agua y el resto; en cada grupo, por confianza y posicion. */
export function sortAssets(assets: ExtractedAsset[]): ExtractedAsset[] {
  const first = (asset: ExtractedAsset): AssetOccurrence | undefined => asset.occurrences[0];
  return [...assets].sort((a, b) => {
    const ka = KIND_ORDER[a.kind] ?? 9;
    const kb = KIND_ORDER[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const fa = first(a);
    const fb = first(b);
    if (fa && fb) {
      if (fa.pageIndex !== fb.pageIndex) return fa.pageIndex - fb.pageIndex;
      if (fa.rect.y !== fb.rect.y) return fa.rect.y - fb.rect.y;
      if (fa.rect.x !== fb.rect.x) return fa.rect.x - fb.rect.x;
    } else if (fa) return -1;
    else if (fb) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Deduplica entre motores: dos elementos que son la misma pieza (misma pagina y cajas con IoU >= 0,6) se quedan en uno, el mas
 * especifico (firma > sello > logo > marca de agua > foto > imagen) y, a igualdad, el de mayor confianza. Las apariciones se unen.
 */
export function dedupeAssets(assets: ReadonlyArray<ExtractedAsset>): ExtractedAsset[] {
  const kept: ExtractedAsset[] = [];
  for (const asset of assets) {
    const first = asset.occurrences[0];
    let merged = false;
    if (first) {
      for (let k = 0; k < kept.length; k += 1) {
        const other = kept[k];
        const match = other.occurrences.find((candidate) => candidate.pageIndex === first.pageIndex && iou(candidate.rect, first.rect) >= DUPLICATE_IOU);
        if (!match || other.id === asset.id) continue;
        // El que tiene mas apariciones o mayor especificidad gana: el otro solo aporta su pagina si aun no estaba.
        const rankA = KIND_ORDER[asset.kind] ?? 9;
        const rankB = KIND_ORDER[other.kind] ?? 9;
        const winner = rankA < rankB || (rankA === rankB && asset.confidence > other.confidence) ? asset : other;
        const loser = winner === asset ? other : asset;
        const extra = loser.occurrences.filter((candidate) => !winner.occurrences.some((o) => o.pageIndex === candidate.pageIndex && iou(o.rect, candidate.rect) >= DUPLICATE_IOU));
        kept[k] = { ...winner, occurrences: [...winner.occurrences, ...extra] };
        merged = true;
        break;
      }
    }
    if (!merged) kept.push(asset);
  }
  return kept;
}

/** Clasifica y decide lo vectorial. Rechaza con `AbortError` si se cancela. */
export async function classifyAssets(input: ClassifyInput): Promise<ClassifyOutput> {
  const decode = input.decodeThumb ?? decodePngThumb;
  const sizeOf = sizesOf(input.pages);
  const pageIndexes = input.pages.map((page) => page.pageIndex);
  const ctx: Context = {
    sizeOf,
    labels: labelsByPage(input.pages),
    firstPageIndex: pageIndexes.length > 0 ? Math.min(...pageIndexes) : 0,
    analyzedPages: Math.max(1, input.analyzedPages),
    scanned: new Set(input.scannedPages ?? []),
  };

  const out: ExtractedAsset[] = [];
  for (const asset of input.assets) {
    if (input.signal?.aborted) {
      const error = new Error("Clasificacion cancelada");
      error.name = "AbortError";
      throw error;
    }
    if (asset.kind !== "image") {
      out.push(enrichClassified(asset, ctx));
      continue;
    }
    let features: PixelFeatures | null = null;
    if (asset.thumb) {
      const raster = await decode(asset.thumb).catch(() => null);
      if (raster) features = analyzePixels(raster);
    }
    const geometry = geometryOf(asset.occurrences, sizeOf, ctx.firstPageIndex);
    if (!geometry) {
      out.push(asset);
      continue;
    }
    // (d) imagen translucida repetida que detecto el motor de anotaciones: gana por posicion.
    const candidates = (input.translucentImages ?? []).filter((candidate) => asset.occurrences.some((occurrence) => occurrence.pageIndex === candidate.pageIndex && iou(occurrence.rect, candidate.rect) >= 0.6));
    if (candidates.length > 0) {
      const pages = new Set(candidates.map((candidate) => candidate.pageIndex)).size;
      const alpha = candidates[0].alpha;
      out.push(
        apply(asset, {
          kind: "watermark",
          confidence: 0.8,
          reasons: [`imagen translúcida repetida (opacidad del ${Math.round(alpha * 100)} %)`, `en el mismo sitio de ${pages} páginas`],
        }),
      );
      continue;
    }
    out.push(classifyImageAsset(asset, features, ctx, geometry));
  }

  const vectorSignatures: AcceptedVector[] = [];
  const pageMap = new Map(input.pages.map((page) => [page.pageIndex, page]));
  for (const vectors of input.vectors ?? []) {
    const labels = ctx.labels.get(vectors.pageIndex) ?? [];
    for (const candidate of vectors.candidates) {
      const accepted = judgeVector(candidate, pageMap.get(vectors.pageIndex), vectors, labels);
      if (accepted) vectorSignatures.push(accepted);
    }
  }
  return { assets: out, vectorSignatures };
}
