/**
 * Evaluacion del corpus INDEPENDIENTE (el del verificador, 116 PDF sinteticos y 90 expectativas). Lo escribio otra persona con
 * otros generadores (tipografias manuscritas del sistema, fotos con ruido y sombra, senuelos, `/Rotate`...), asi que los umbrales
 * NO se afinaron con el: mide si lo ajustado al corpus propio generaliza. Reglas de medida (las del verificador):
 * - una expectativa acierta si el elemento mas solapado (IoU >= 0,3 en la pagina esperada) es de la clase esperada;
 * - un elemento firma/iniciales/logo/sello/marca de agua que no corresponde a ninguna expectativa, o que se emparejo con otra clase,
 *   es un falso positivo de la clase que obtuvo;
 * - «senuelo ofrecido como firma» = cualquier firma o iniciales en un PDF de senuelos (en la interfaz sale «Firma probable»:
 *   el clasificador nunca pasa de 0,89), contado por elemento senuelo.
 */

import fs from "node:fs";
import path from "node:path";
import { nodeExtractEnv } from "../classify/nodeEnv";
import { extractWith } from "../../orchestrate";
import type { ExtractedAsset, NormRect } from "../../types";

export type VerifClass = "signature" | "initials" | "logo" | "stamp" | "watermark";
export const VERIF_CLASSES: readonly VerifClass[] = ["signature", "initials", "logo", "stamp", "watermark"];

export type VerifExpectation = { cls: string; page: number; rect?: NormRect; pages?: number[]; tag: string; cond: string };
export type VerifCase = { name: string; group: string; decoys: number; note?: string; expected: VerifExpectation[] };

export type VerifRow = { name: string; group: string; cond: string; expCls: string; gotKind: string; confidence: number | null; ok: boolean; reasons: string[] };
export type VerifFalsePositive = { name: string; group: string; kind: string; confidence: number; reasons: string[]; mismatch: boolean };
export type VerifMetrics = { tp: number; fn: number; fp: number; precision: number; recall: number };
export type VerifReport = {
  cases: number;
  expectations: number;
  rows: VerifRow[];
  falsePositives: VerifFalsePositive[];
  perClass: Record<VerifClass, VerifMetrics>;
  decoys: { elements: number; offered: number; rate: number; offeredNames: string[] };
  ambiguous: Array<{ name: string; kind: string; confidence: number }>;
};

/** Grupos de PDF de senuelos (los de `ambiguous` se informan aparte: ni son firma ni dejan de serlo con claridad). */
export const DECOY_GROUPS = new Set(["decoy", "vector-decoy", "annot-decoy"]);

const DIR = path.join(__dirname);

export function loadVerifTruth(): VerifCase[] {
  return JSON.parse(fs.readFileSync(path.join(DIR, "truth.json"), "utf8")) as VerifCase[];
}

export function loadVerifPdf(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(DIR, "pdfs", `${name}.pdf`)));
}

function iou(a: NormRect, b: NormRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
}

const counted = (kind: string): kind is VerifClass => (VERIF_CLASSES as readonly string[]).includes(kind);

export function metricsOf(tp: number, fn: number, fp: number): VerifMetrics {
  return { tp, fn, fp, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1) };
}

export async function evaluateVerifCorpus(): Promise<VerifReport> {
  const truth = loadVerifTruth();
  const rows: VerifRow[] = [];
  const falsePositives: VerifFalsePositive[] = [];
  const decoyOffered: string[] = [];
  const ambiguous: VerifReport["ambiguous"] = [];
  let decoyElements = 0;
  for (const item of truth) {
    const result = await extractWith(nodeExtractEnv, loadVerifPdf(item.name));
    const used = new Set<string>();
    for (const expectation of item.expected) {
      if (expectation.cls === "image" && item.group === "scan") {
        rows.push({ name: item.name, group: item.group, cond: expectation.cond, expCls: "image", gotKind: result.scannedPages.includes(0) ? "scanned-ok" : "scanned-missed", confidence: null, ok: result.scannedPages.includes(0), reasons: [] });
        continue;
      }
      let match: ExtractedAsset | undefined;
      if (expectation.cls === "watermark" && !expectation.rect) match = result.assets.find((asset) => asset.kind === "watermark" && !used.has(asset.id));
      else if (expectation.rect) {
        let best = 0;
        for (const asset of result.assets) {
          if (used.has(asset.id)) continue;
          for (const occurrence of asset.occurrences) {
            if (occurrence.pageIndex !== expectation.page) continue;
            const value = iou(occurrence.rect, expectation.rect);
            if (value > best && value >= 0.3) {
              best = value;
              match = asset;
            }
          }
        }
      }
      if (match) used.add(match.id);
      const got = match ? match.kind : "MISSING";
      rows.push({ name: item.name, group: item.group, cond: expectation.cond, expCls: expectation.cls, gotKind: got, confidence: match?.confidence ?? null, ok: got === expectation.cls, reasons: match?.reasons ?? [] });
      if (expectation.pages && match && expectation.cls === "initials") {
        const pages = new Set(match.occurrences.map((occurrence) => occurrence.pageIndex));
        for (const page of expectation.pages) if (!pages.has(page)) rows.push({ name: item.name, group: item.group, cond: `${expectation.cond} (occurrence page ${page})`, expCls: expectation.cls, gotKind: "MISSING-OCC", confidence: null, ok: false, reasons: [] });
      }
      if (match && got !== expectation.cls && counted(got)) falsePositives.push({ name: item.name, group: item.group, kind: got, confidence: match.confidence, reasons: match.reasons, mismatch: true });
    }
    for (const asset of result.assets) {
      if (!counted(asset.kind) || used.has(asset.id)) continue;
      falsePositives.push({ name: item.name, group: item.group, kind: asset.kind, confidence: asset.confidence, reasons: asset.reasons, mismatch: false });
    }
    if (DECOY_GROUPS.has(item.group)) {
      decoyElements += item.decoys;
      for (const asset of result.assets) {
        if (asset.kind !== "signature" && asset.kind !== "initials") continue;
        // un campo /Sig vacio sin descarga es la unica «firma» aceptable en un senuelo: se muestra como campo vacio, no como firma probable
        if (asset.source === "sig-widget" && asset.formats.length === 0) continue;
        decoyOffered.push(item.name);
      }
    }
    if (item.group === "ambiguous") for (const asset of result.assets) if (asset.kind === "signature" || asset.kind === "initials") ambiguous.push({ name: item.name, kind: asset.kind, confidence: asset.confidence });
  }
  const perClass = {} as Record<VerifClass, VerifMetrics>;
  for (const cls of VERIF_CLASSES) {
    perClass[cls] = metricsOf(
      rows.filter((row) => row.expCls === cls && row.ok).length,
      rows.filter((row) => row.expCls === cls && !row.ok).length,
      falsePositives.filter((entry) => entry.kind === cls).length,
    );
  }
  return {
    cases: truth.length,
    expectations: truth.reduce((sum, item) => sum + item.expected.length, 0),
    rows,
    falsePositives,
    perClass,
    decoys: { elements: decoyElements, offered: decoyOffered.length, rate: decoyElements > 0 ? decoyOffered.length / decoyElements : 0, offeredNames: decoyOffered },
    ambiguous,
  };
}

export function formatVerifReport(report: VerifReport): string {
  const lines = VERIF_CLASSES.map((cls) => {
    const m = report.perClass[cls];
    return `${cls.padEnd(10)} TP=${m.tp} FN=${m.fn} FP=${m.fp}  precision=${m.precision.toFixed(2)} recall=${m.recall.toFixed(2)}`;
  });
  lines.push(`senuelos ofrecidos como firma/iniciales: ${report.decoys.offered} de ${report.decoys.elements} elementos (${(report.decoys.rate * 100).toFixed(1)} %)${report.decoys.offeredNames.length ? ` [${report.decoys.offeredNames.join(", ")}]` : ""}`);
  return lines.join("\n");
}
