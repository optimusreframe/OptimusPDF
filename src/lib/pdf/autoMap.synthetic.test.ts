import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { autoMapBytes } from "@/lib/pdf/testing/autoMapHarness";
import { evaluateAutoMap, type Metrics } from "@/lib/pdf/testing/autoMapEval";
import { SCALE_VARIANTS, renderSynthetic, syntheticCorpus, type SyntheticDoc } from "@/lib/pdf/testing/autoMapSynthetic";
import type { AutoMapResult } from "@/lib/pdf/autoMapTypes";

/**
 * Corpus SINTETICO del automapeo (CI): cada contrato se genera con pdf-lib con su verdad de terreno, se mapea y se
 * miden recall, precision del nivel `high`, orden de los firmantes y numero de campos por pagina. Los senuelos
 * (subrayados decorativos, tablas, papel pautado, prosa con «sign»/«initial») no deben dar ningun `high`.
 */

const corpus = syntheticCorpus();

async function run(doc: SyntheticDoc, options: Parameters<typeof renderSynthetic>[1] = {}) {
  const rendered = await renderSynthetic(doc, options);
  const result = await autoMapBytes(rendered.bytes, { signers: doc.signers, locale: "es", includeIgnored: true });
  const metrics = evaluateAutoMap(result.fields, { images: rendered.truth, texts: [] }, { tiers: ["high", "review"], signers: doc.signers });
  return { result, metrics, rendered };
}

function structuralHigh(result: AutoMapResult, pageIndexes?: readonly number[]) {
  return result.fields.filter((f) => f.tier === "high" && (f.type === "initials" || f.type === "signature") && (!pageIndexes || pageIndexes.includes(f.pageIndex)));
}

const REPORT = process.env.AUTOMAP_SYNTH_REPORT;

describe("automapeo: corpus sintetico (letter, un contrato por caso)", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (const { doc, note } of corpus) {
    it(`${doc.name}: ${note}`, async () => {
      const { result, metrics } = await run(doc);
      rows.push({ doc: doc.name, m: metrics, high: result.confidenceSummary.high, review: result.confidenceSummary.review });
      if (doc.decoyPages) {
        expect(structuralHigh(result, doc.decoyPages), `senuelos con high en ${doc.name}`).toHaveLength(0);
      }
      // Ningun contrato supera los topes.
      expect(metrics.perPage.max).toBeLessThanOrEqual(12);
      const total = metrics.initials.total + metrics.signature.total + metrics.either.total;
      if (total > 0) {
        expect(metrics.initials.recall, `recall iniciales ${doc.name}`).toBeGreaterThanOrEqual(0.9);
        expect(metrics.signature.recall, `recall firmas ${doc.name}`).toBeGreaterThanOrEqual(0.9);
        expect(metrics.highPrecision.precision, `precision high ${doc.name}`).toBeGreaterThanOrEqual(0.9);
        if (doc.signers === 2) expect(metrics.initialsOrder.ok).toBe(metrics.initialsOrder.checked);
      }
    });
  }
  it("informe", () => {
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(rows, null, 1));
  });
});

describe("automapeo: invarianza a tamano de papel, escala, letra y giro de pagina", () => {
  const base = corpus.filter((entry) => ["corner-repeat-2", "labelled-initials-2", "es-single", "insured-coinsured", "short-initials-line"].includes(entry.doc.name));
  for (const { doc } of base) {
    for (const variant of SCALE_VARIANTS) {
      it(`${doc.name} @ ${variant.id}`, async () => {
        const { metrics, result } = await run(doc, variant.options);
        expect(metrics.initials.recall).toBeGreaterThanOrEqual(0.9);
        expect(metrics.signature.recall).toBeGreaterThanOrEqual(0.9);
        expect(metrics.highPrecision.precision).toBeGreaterThanOrEqual(0.9);
        if (doc.signers === 2) expect(metrics.initialsOrder.ok).toBe(metrics.initialsOrder.checked);
        expect(metrics.perPage.max).toBeLessThanOrEqual(12);
        expect(result.warnings.filter((w) => w.code === "page-skipped")).toHaveLength(0);
      });
    }
  }
});

export type { Metrics };
