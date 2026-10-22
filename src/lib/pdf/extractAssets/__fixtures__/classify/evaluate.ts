/**
 * Evaluacion del clasificador contra la VERDAD del corpus sintetico (U7.3): empareja lo encontrado con lo esperado por clase
 * (firma e iniciales como imagen, logos, firma vectorial, sellos, fotos), calcula precision y recall, el recall de las imagenes
 * incrustadas tras la fusion y la tasa de falsas firmas en los senuelos. Funciones puras: las usan Vitest y la prueba E2E.
 */

import type { ExtractWarning, ExtractedAsset, NormRect } from "../../types";
import type { ClassifyClass, ClassifyFixture, TruthItem } from "./generate";

export const CLASSES: readonly ClassifyClass[] = ["signature", "initials", "logo", "vector", "stamp", "photo"];

/** Objetivos del plan (§9.5) y de la unidad: firmas como imagen 0,85 / 0,80; iniciales 0,80; logos 0,90; vectoriales (beta) recall 0,60. */
export const TARGETS: Record<ClassifyClass, { precision: number; recall: number }> = {
  signature: { precision: 0.85, recall: 0.8 },
  initials: { precision: 0.8, recall: 0.8 },
  logo: { precision: 0.9, recall: 0.9 },
  vector: { precision: 0, recall: 0.6 },
  stamp: { precision: 0.7, recall: 0.7 },
  photo: { precision: 0.7, recall: 0.7 },
};
export const MAX_DECOY_FALSE_SIGNATURE_RATE = 0.1;
export const EMBEDDED_RECALL_TARGET = 1;

/** Clase de metrica de un elemento hallado (`null` si no cuenta en ninguna). */
export function classOf(asset: ExtractedAsset): ClassifyClass | null {
  if (asset.source === "vector") return asset.kind === "signature" || asset.kind === "initials" ? "vector" : null;
  if (asset.source !== "xobject" && asset.source !== "inline" && asset.source !== "mask") return null;
  switch (asset.kind) {
    case "signature":
      return "signature";
    case "initials":
      return "initials";
    case "logo":
      return "logo";
    case "stamp":
      return "stamp";
    case "photo":
      return "photo";
    default:
      return null;
  }
}

export type FixtureRun = { fixture: ClassifyFixture; assets: ExtractedAsset[]; warnings: ExtractWarning[]; scannedPages: number[] };

export type ClassMetrics = { cls: ClassifyClass; tp: number; fp: number; fn: number; precision: number; recall: number };

export type Evaluation = {
  perClass: Record<ClassifyClass, ClassMetrics>;
  embedded: { total: number; found: number; recall: number };
  decoys: { total: number; falseSignatures: number; rate: number };
  scanned: { expected: number; found: number };
  problems: string[];
};

function iou(a: NormRect, b: NormRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** ¿Este elemento esta donde dice la verdad (pagina y caja de la primera aparicion)? */
export function isAt(asset: ExtractedAsset, page: number, rect: NormRect, minIou = 0.4): boolean {
  return asset.occurrences.some((occurrence) => occurrence.pageIndex === page && iou(occurrence.rect, rect) >= minIou);
}

function kindMatches(item: TruthItem, asset: ExtractedAsset): boolean {
  return classOf(asset) === item.cls && asset.kind === item.kind;
}

/** Compara los atributos esperados (confianza, motivos, paginas) de un elemento ya emparejado. */
export function attributeProblems(item: TruthItem, asset: ExtractedAsset, fixtureName: string): string[] {
  const out: string[] = [];
  const label = `${fixtureName}: ${item.tag}`;
  if (item.minConfidence !== undefined && asset.confidence < item.minConfidence) out.push(`${label}: confianza ${asset.confidence} < ${item.minConfidence}`);
  if (item.maxConfidence !== undefined && asset.confidence > item.maxConfidence) out.push(`${label}: confianza ${asset.confidence} > ${item.maxConfidence}`);
  if (item.reasonIncludes && !asset.reasons.some((reason) => reason.toLowerCase().includes(item.reasonIncludes as string))) {
    out.push(`${label}: ningun motivo contiene «${item.reasonIncludes}» (${asset.reasons.join(" | ")})`);
  }
  const pages = [...new Set(asset.occurrences.map((occurrence) => occurrence.pageIndex))].sort((a, b) => a - b);
  const wanted = [...item.pages].sort((a, b) => a - b);
  if (wanted.some((page) => !pages.includes(page))) out.push(`${label}: paginas ${pages.join(",")} no incluyen ${wanted.join(",")}`);
  return out;
}

export function evaluateRuns(runs: ReadonlyArray<FixtureRun>): Evaluation {
  const tp: Record<string, number> = {};
  const fp: Record<string, number> = {};
  const fn: Record<string, number> = {};
  for (const cls of CLASSES) tp[cls] = fp[cls] = fn[cls] = 0;
  const problems: string[] = [];
  let embeddedTotal = 0;
  let embeddedFound = 0;
  let decoyTotal = 0;
  let decoyFalse = 0;
  let scannedExpected = 0;
  let scannedFound = 0;

  for (const run of runs) {
    const { fixture, assets } = run;
    const used = new Set<ExtractedAsset>();
    for (const item of fixture.truth) {
      const candidate = assets.find((asset) => !used.has(asset) && kindMatches(item, asset) && isAt(asset, item.pages[0], item.rect));
      if (candidate) {
        used.add(candidate);
        tp[item.cls] += 1;
        problems.push(...attributeProblems(item, candidate, fixture.name));
      } else {
        fn[item.cls] += 1;
        const other = assets.find((asset) => isAt(asset, item.pages[0], item.rect));
        problems.push(`${fixture.name}: falta «${item.tag}» (${item.cls}); ${other ? `salio como ${other.kind} ${other.confidence}` : "no salio nada"}`);
      }
    }
    for (const asset of assets) {
      const cls = classOf(asset);
      if (!cls || used.has(asset)) continue;
      // Un elemento de una clase que NO esta en la verdad es un falso positivo (la verdad es exhaustiva por clase).
      fp[cls] += 1;
      problems.push(`${fixture.name}: sobra ${asset.kind} (${cls}) ${asset.confidence} en la pagina ${asset.occurrences[0]?.pageIndex}`);
    }
    for (const embedded of fixture.embedded) {
      embeddedTotal += 1;
      if (assets.some((asset) => isAt(asset, embedded.page, embedded.rect, 0.5))) embeddedFound += 1;
      else problems.push(`${fixture.name}: imagen incrustada perdida (pagina ${embedded.page})`);
    }
    if (fixture.decoy) {
      decoyTotal += 1;
      if (assets.some((asset) => asset.kind === "signature" || asset.kind === "initials")) decoyFalse += 1;
    }
    if (fixture.scannedPages) {
      scannedExpected += fixture.scannedPages.length;
      scannedFound += fixture.scannedPages.filter((page) => run.scannedPages.includes(page)).length;
    }
  }

  const perClass = Object.fromEntries(
    CLASSES.map((cls) => [
      cls,
      {
        cls,
        tp: tp[cls],
        fp: fp[cls],
        fn: fn[cls],
        precision: tp[cls] + fp[cls] > 0 ? tp[cls] / (tp[cls] + fp[cls]) : 1,
        recall: tp[cls] + fn[cls] > 0 ? tp[cls] / (tp[cls] + fn[cls]) : 1,
      },
    ]),
  ) as Record<ClassifyClass, ClassMetrics>;
  return {
    perClass,
    embedded: { total: embeddedTotal, found: embeddedFound, recall: embeddedTotal > 0 ? embeddedFound / embeddedTotal : 1 },
    decoys: { total: decoyTotal, falseSignatures: decoyFalse, rate: decoyTotal > 0 ? decoyFalse / decoyTotal : 0 },
    scanned: { expected: scannedExpected, found: scannedFound },
    problems,
  };
}

export function formatReport(result: Evaluation): string {
  const pct = (value: number): string => value.toFixed(2).replace(".", ",");
  const lines = CLASSES.map((cls) => {
    const m = result.perClass[cls];
    return `${cls.padEnd(10)} TP ${String(m.tp).padStart(2)}  FP ${String(m.fp).padStart(2)}  FN ${String(m.fn).padStart(2)}  precision ${pct(m.precision)} (objetivo ${pct(TARGETS[cls].precision)})  recall ${pct(m.recall)} (objetivo ${pct(TARGETS[cls].recall)})`;
  });
  lines.push(`imagenes incrustadas: ${result.embedded.found}/${result.embedded.total} (recall ${pct(result.embedded.recall)})`);
  lines.push(`senuelos: ${result.decoys.falseSignatures} con falsa firma de ${result.decoys.total} (tasa ${pct(result.decoys.rate)}, maximo ${pct(MAX_DECOY_FALSE_SIGNATURE_RATE)})`);
  lines.push(`paginas escaneadas: ${result.scanned.found}/${result.scanned.expected}`);
  return lines.join("\n");
}
