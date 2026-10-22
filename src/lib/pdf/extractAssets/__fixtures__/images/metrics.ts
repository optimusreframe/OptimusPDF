/**
 * Metricas del motor de imagenes contra la verdad del corpus (`corpus.ts`): recall, agrupacion de duplicados, IoU de las
 * cajas, avisos y paginas escaneadas. Sin dependencias de Node ni del DOM (se usa igual en Vitest y en el navegador).
 */

import type { TruthDoc, TruthRect } from "./corpus";

type AssetLike = {
  id: string;
  source: string;
  pixel: { width: number; height: number; hasAlpha: boolean } | null;
  formats: string[];
  occurrences: Array<{ pageIndex: number; rect: TruthRect }>;
};

export type ResultLike = {
  assets: AssetLike[];
  scannedPages?: number[];
  warnings?: Array<{ code: string }>;
};

export type DocMetrics = {
  name: string;
  truthImages: number;
  /** Imagenes esperadas para las que hay un elemento con las medidas, el tipo y TODAS las cajas con IoU >= umbral. */
  found: number;
  /** De ellas, las que ademas tienen EXACTAMENTE las mismas apariciones (sin faltar ni sobrar) y la transparencia correcta. */
  exact: number;
  /** Imagenes esperadas con mas de una aparicion y las que se agruparon bien. */
  duplicateGroups: number;
  duplicateGroupsOk: number;
  /** Elementos devueltos que no corresponden a ninguna imagen esperada. */
  extra: number;
  /** Menor IoU entre cajas emparejadas (1 si no hay ninguna). */
  minIou: number;
  /** Detalle de lo que no cuadro, legible. */
  problems: string[];
  scannedOk: boolean;
  warningsOk: boolean;
  jpegOriginalOk: boolean;
};

export const IOU_THRESHOLD = 0.9;

export function boxIou(a: TruthRect, b: TruthRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Empareja cada aparicion esperada con la mejor aparicion (de la misma pagina) del elemento; devuelve IoUs por aparicion esperada. */
function matchOccurrences(asset: AssetLike, truthOccurrences: TruthDoc["images"][number]["occurrences"]): number[] {
  const used = new Set<number>();
  return truthOccurrences.map((expected) => {
    let best = 0;
    let bestIndex = -1;
    asset.occurrences.forEach((candidate, index) => {
      if (used.has(index) || candidate.pageIndex !== expected.pageIndex) return;
      const value = boxIou(candidate.rect, expected.rect);
      if (value > best) {
        best = value;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) used.add(bestIndex);
    return best;
  });
}

export function evaluateImages(result: ResultLike, truth: TruthDoc): DocMetrics {
  const problems: string[] = [];
  const usedAssets = new Set<number>();
  let found = 0;
  let exact = 0;
  let duplicateGroups = 0;
  let duplicateGroupsOk = 0;
  let minIou = 1;

  for (const expected of truth.images) {
    const multi = expected.occurrences.length > 1;
    if (multi) duplicateGroups += 1;
    let bestAsset = -1;
    let bestScore = -1;
    let bestIous: number[] = [];
    result.assets.forEach((asset, index) => {
      if (usedAssets.has(index)) return;
      if (asset.pixel && (asset.pixel.width !== expected.width || asset.pixel.height !== expected.height)) return;
      if (expected.source && asset.source !== expected.source) return;
      const ious = matchOccurrences(asset, expected.occurrences);
      const score = ious.filter((value) => value >= IOU_THRESHOLD).length;
      if (score > bestScore || (score === bestScore && score > 0 && ious.reduce((a, b) => a + b, 0) > bestIous.reduce((a, b) => a + b, 0))) {
        bestScore = score;
        bestAsset = index;
        bestIous = ious;
      }
    });
    if (bestAsset < 0 || bestScore <= 0) {
      problems.push(`no se encontro «${expected.id}» (${expected.width}x${expected.height})`);
      continue;
    }
    usedAssets.add(bestAsset);
    const asset = result.assets[bestAsset];
    for (const value of bestIous) minIou = Math.min(minIou, value);
    const allMatched = bestScore === expected.occurrences.length;
    if (allMatched) found += 1;
    else problems.push(`«${expected.id}»: solo ${bestScore} de ${expected.occurrences.length} apariciones con IoU >= ${IOU_THRESHOLD} (${bestIous.map((v) => v.toFixed(2)).join(", ")})`);
    const sameCount = asset.occurrences.length === expected.occurrences.length;
    const alphaOk = asset.pixel ? asset.pixel.hasAlpha === expected.hasAlpha : true;
    if (allMatched && sameCount && alphaOk) {
      exact += 1;
      if (multi) duplicateGroupsOk += 1;
    } else {
      if (!sameCount) problems.push(`«${expected.id}»: ${asset.occurrences.length} apariciones en vez de ${expected.occurrences.length}`);
      if (!alphaOk) problems.push(`«${expected.id}»: hasAlpha ${asset.pixel?.hasAlpha} en vez de ${expected.hasAlpha}`);
    }
  }

  const extra = result.assets.length - usedAssets.size;
  if (extra > 0) problems.push(`${extra} elemento(s) que no corresponden a ninguna imagen esperada`);

  const scanned = [...(result.scannedPages ?? [])].sort((a, b) => a - b);
  const scannedOk = JSON.stringify(scanned) === JSON.stringify([...truth.scannedPages].sort((a, b) => a - b));
  if (!scannedOk) problems.push(`paginas escaneadas ${JSON.stringify(scanned)} en vez de ${JSON.stringify(truth.scannedPages)}`);

  const got = [...new Set((result.warnings ?? []).map((warning) => warning.code))].sort();
  const want = [...new Set(truth.warnings)].sort();
  const warningsOk = JSON.stringify(got) === JSON.stringify(want);
  if (!warningsOk) problems.push(`avisos ${JSON.stringify(got)} en vez de ${JSON.stringify(want)}`);

  let jpegOriginalOk = true;
  for (const expected of truth.images) {
    const asset = result.assets.find((candidate) => matchOccurrences(candidate, expected.occurrences).some((value) => value >= IOU_THRESHOLD) && (!candidate.pixel || (candidate.pixel.width === expected.width && candidate.pixel.height === expected.height)));
    if (!asset) continue;
    const has = asset.formats.includes("jpg-original");
    if (has !== expected.jpegOriginal) {
      jpegOriginalOk = false;
      problems.push(`«${expected.id}»: jpg-original ${has ? "ofrecido" : "no ofrecido"} y se esperaba ${expected.jpegOriginal ? "ofrecido" : "no ofrecido"}`);
    }
  }

  return { name: truth.name, truthImages: truth.images.length, found, exact, duplicateGroups, duplicateGroupsOk, extra, minIou, problems, scannedOk, warningsOk, jpegOriginalOk };
}

export type CorpusSummary = {
  docs: number;
  truthImages: number;
  recall: number;
  exactRate: number;
  duplicateGroupRate: number;
  extraAssets: number;
  minIou: number;
  failingDocs: string[];
};

export function summarize(all: DocMetrics[]): CorpusSummary {
  const truthImages = all.reduce((sum, m) => sum + m.truthImages, 0);
  const found = all.reduce((sum, m) => sum + m.found, 0);
  const exact = all.reduce((sum, m) => sum + m.exact, 0);
  const groups = all.reduce((sum, m) => sum + m.duplicateGroups, 0);
  const groupsOk = all.reduce((sum, m) => sum + m.duplicateGroupsOk, 0);
  return {
    docs: all.length,
    truthImages,
    recall: truthImages === 0 ? 1 : found / truthImages,
    exactRate: truthImages === 0 ? 1 : exact / truthImages,
    duplicateGroupRate: groups === 0 ? 1 : groupsOk / groups,
    extraAssets: all.reduce((sum, m) => sum + m.extra, 0),
    minIou: all.reduce((min, m) => Math.min(min, m.minIou), 1),
    failingDocs: all.filter((m) => m.problems.length > 0).map((m) => m.name),
  };
}
