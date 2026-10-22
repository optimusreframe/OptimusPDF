/**
 * Evaluacion del motor de anotaciones contra la VERDAD del corpus sintetico: empareja lo encontrado con lo esperado por clase
 * (Ink, sellos, /Sig, marcas de agua (a,b) y (c)) y calcula precision y recall. Funciones puras: las usan Vitest y la prueba E2E.
 */

import type { ExtractWarning, ExtractedAsset } from "../../types";
import type { AnnotClass, AnnotFixture, TruthItem } from "./generate";

export const ANNOT_CLASSES: readonly AnnotClass[] = ["ink", "stamp", "sig", "wm-ab", "wm-c"];

/** Clase de metrica de un elemento encontrado (`null` si no es de este motor). */
export function classOf(asset: ExtractedAsset): AnnotClass | null {
  switch (asset.source) {
    case "ink-annot":
      return "ink";
    case "sig-widget":
      return "sig";
    case "form":
      return asset.kind === "stamp" ? "stamp" : null;
    case "stamp-annot":
      return asset.kind === "watermark" ? "wm-ab" : "stamp";
    case "ocg":
      return "wm-ab";
    case "text":
      return asset.kind === "watermark" ? "wm-c" : null;
    default:
      return null;
  }
}

export type FixtureRun = {
  fixture: AnnotFixture;
  assets: ExtractedAsset[];
  warnings: ExtractWarning[];
  translucentPages?: number[];
};

export type ClassMetrics = { cls: AnnotClass; tp: number; fp: number; fn: number; precision: number; recall: number };

export type EvaluationResult = {
  perClass: Record<AnnotClass, ClassMetrics>;
  /** Detalle legible de cada falso positivo, falso negativo y atributo que no cumple. */
  problems: string[];
};

function pagesOf(asset: ExtractedAsset): number[] {
  return [...new Set(asset.occurrences.map((o) => o.pageIndex))].sort((a, b) => a - b);
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function matches(item: TruthItem, asset: ExtractedAsset): boolean {
  if (classOf(asset) !== item.cls || asset.source !== item.source) return false;
  if (item.kind && asset.kind !== item.kind) return false;
  const pages = pagesOf(asset);
  if (item.pages.length === 1 ? pages[0] !== item.pages[0] : !sameSet(pages, [...item.pages].sort((a, b) => a - b))) return false;
  if (item.text !== undefined) {
    const ref = asset.ref as { engine: string; text?: string };
    if (ref.engine !== "text" || ref.text?.toLowerCase() !== item.text.toLowerCase()) return false;
  }
  if (item.layerName !== undefined && !asset.reasons.some((reason) => reason.includes(`«${item.layerName}»`))) return false;
  return true;
}

/** Comprueba los atributos esperados de un elemento ya emparejado; devuelve los incumplimientos. */
export function attributeProblems(item: TruthItem, asset: ExtractedAsset, warnings: ExtractWarning[]): string[] {
  const out: string[] = [];
  const label = `${item.tag}`;
  if (item.minConfidence !== undefined && asset.confidence < item.minConfidence) out.push(`${label}: confianza ${asset.confidence} < ${item.minConfidence}`);
  if (item.maxConfidence !== undefined && asset.confidence > item.maxConfidence) out.push(`${label}: confianza ${asset.confidence} > ${item.maxConfidence}`);
  if (item.reasonIncludes && !asset.reasons.some((reason) => reason.toLowerCase().includes(item.reasonIncludes as string))) {
    out.push(`${label}: ningun motivo contiene «${item.reasonIncludes}» (${asset.reasons.join(" | ")})`);
  }
  if (item.downloadable !== undefined && item.downloadable !== (asset.formats.length > 0)) out.push(`${label}: descargable=${asset.formats.length > 0}, se esperaba ${item.downloadable}`);
  if (item.digitalSignature) {
    const signed = warnings.some((w) => w.code === "digital-signature" && item.pages.includes(w.pageIndex ?? -1));
    if (!signed) out.push(`${label}: falta el aviso digital-signature en la pagina ${item.pages[0]}`);
  }
  return out;
}

export function evaluateRuns(runs: FixtureRun[]): EvaluationResult {
  const counts = Object.fromEntries(ANNOT_CLASSES.map((cls) => [cls, { tp: 0, fp: 0, fn: 0 }])) as Record<AnnotClass, { tp: number; fp: number; fn: number }>;
  const problems: string[] = [];
  for (const run of runs) {
    const used = new Set<number>();
    for (const item of run.fixture.truth) {
      const index = run.assets.findIndex((asset, i) => !used.has(i) && matches(item, asset));
      if (index < 0) {
        counts[item.cls].fn += 1;
        problems.push(`[${run.fixture.name}] FALTA ${item.tag} (${item.source} p${item.pages.join(",")})`);
        continue;
      }
      used.add(index);
      counts[item.cls].tp += 1;
      for (const issue of attributeProblems(item, run.assets[index], run.warnings)) problems.push(`[${run.fixture.name}] ${issue}`);
    }
    run.assets.forEach((asset, i) => {
      if (used.has(i)) return;
      const cls = classOf(asset);
      if (!cls) return;
      counts[cls].fp += 1;
      problems.push(`[${run.fixture.name}] SOBRA ${asset.kind}/${asset.source} p${pagesOf(asset).join(",")} (${asset.reasons[0]})`);
    });
    const expected = [...(run.fixture.digitalSignaturePages ?? [])].sort((a, b) => a - b);
    const got = run.warnings.filter((w) => w.code === "digital-signature").map((w) => w.pageIndex ?? -1).sort((a, b) => a - b);
    if (!sameSet(expected, got)) problems.push(`[${run.fixture.name}] avisos digital-signature en paginas [${got}], se esperaban [${expected}]`);
    if (run.fixture.translucentImagePages) {
      const seen = [...(run.translucentPages ?? [])].sort((a, b) => a - b);
      if (!sameSet(seen, run.fixture.translucentImagePages)) problems.push(`[${run.fixture.name}] candidatas de imagen translucida en paginas [${seen}], se esperaban [${run.fixture.translucentImagePages}]`);
    } else if ((run.translucentPages ?? []).length > 0) {
      problems.push(`[${run.fixture.name}] candidatas de imagen translucida inesperadas en [${run.translucentPages}]`);
    }
  }
  const perClass = Object.fromEntries(
    ANNOT_CLASSES.map((cls) => {
      const { tp, fp, fn } = counts[cls];
      return [cls, { cls, tp, fp, fn, precision: tp + fp === 0 ? 1 : tp / (tp + fp), recall: tp + fn === 0 ? 1 : tp / (tp + fn) }];
    }),
  ) as Record<AnnotClass, ClassMetrics>;
  return { perClass, problems };
}

/** Umbrales del plan (§9.5) para cada clase. */
export const TARGETS: Record<AnnotClass, { precision: number; recall: number }> = {
  ink: { precision: 0.95, recall: 0.95 },
  stamp: { precision: 0.95, recall: 0.95 },
  sig: { precision: 0.95, recall: 1 },
  "wm-ab": { precision: 0.9, recall: 0.9 },
  "wm-c": { precision: 0.75, recall: 0.75 },
};

export function formatReport(result: EvaluationResult): string {
  const rows = ANNOT_CLASSES.map((cls) => {
    const m = result.perClass[cls];
    const t = TARGETS[cls];
    return `${cls.padEnd(6)} tp=${m.tp} fp=${m.fp} fn=${m.fn}  precision=${m.precision.toFixed(3)} (>= ${t.precision})  recall=${m.recall.toFixed(3)} (>= ${t.recall})`;
  });
  return rows.join("\n");
}
