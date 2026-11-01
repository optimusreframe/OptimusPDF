/**
 * Metricas del corpus: precision de los valores `high` y recall por clave, senuelos que se cuelan y claves que no debian salir
 * como `high`. Compara cadenas EXACTAS (el motor normaliza telefono, fecha, mayusculas y direccion; la verdad ya viene normalizada).
 */

import type { ExtractResult } from "@/lib/autofill/types";
import type { CorpusDoc, Truth } from "@/lib/autofill/testing/corpus";

export type KeyStats = {
  expectedHigh: number;
  foundHigh: number;
  foundAny: number;
  highTotal: number;
  highCorrect: number;
  highWrong: number;
  reviewTotal: number;
};

export type Miss = { doc: string; key: string; expected: string[]; got: string[] };

export type Report = {
  perKey: Record<string, KeyStats>;
  perLayout: Record<string, { expectedHigh: number; foundHigh: number }>;
  precisionHigh: number;
  recallHigh: number;
  recallAny: number;
  forbiddenHits: Array<{ doc: string; value: string }>;
  noHighViolations: Array<{ doc: string; key: string }>;
  wrongHigh: Miss[];
  misses: Miss[];
  documents: number;
};

const asList = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

export function evaluate(rows: ReadonlyArray<{ doc: CorpusDoc; result: ExtractResult }>): Report {
  const perKey: Record<string, KeyStats> = {};
  const perLayout: Report["perLayout"] = {};
  const stats = (key: string): KeyStats => (perKey[key] ??= { expectedHigh: 0, foundHigh: 0, foundAny: 0, highTotal: 0, highCorrect: 0, highWrong: 0, reviewTotal: 0 });
  const forbiddenHits: Report["forbiddenHits"] = [];
  const noHighViolations: Report["noHighViolations"] = [];
  const wrongHigh: Miss[] = [];
  const misses: Miss[] = [];

  for (const { doc, result } of rows) {
    const truth: Truth = doc.truth;
    const layout = (perLayout[doc.layout] ??= { expectedHigh: 0, foundHigh: 0 });
    const high = result.values.filter((value) => value.tier === "high");
    for (const value of result.values) {
      if (truth.forbidden?.some((bad) => value.value.includes(bad) || bad.includes(value.value))) forbiddenHits.push({ doc: doc.id, value: value.value });
    }
    for (const key of truth.noHigh ?? []) if (high.some((value) => value.key === key)) noHighViolations.push({ doc: doc.id, key });

    for (const value of high) {
      const s = stats(value.key);
      s.highTotal += 1;
      const acceptable = [...asList(truth.high?.[value.key]), ...asList(truth.review?.[value.key])];
      if (acceptable.includes(value.value)) s.highCorrect += 1;
      else {
        s.highWrong += 1;
        wrongHigh.push({ doc: doc.id, key: value.key, expected: acceptable, got: [value.value] });
      }
    }
    for (const value of result.values) if (value.tier === "review") stats(value.key).reviewTotal += 1;

    for (const [key, raw] of Object.entries(truth.high ?? {})) {
      const expected = asList(raw);
      const s = stats(key);
      s.expectedHigh += 1;
      layout.expectedHigh += 1;
      const gotHigh = high.filter((value) => value.key === key).map((value) => value.value);
      const gotAny = result.values.filter((value) => value.key === key).map((value) => value.value);
      if (gotHigh.some((value) => expected.includes(value))) {
        s.foundHigh += 1;
        layout.foundHigh += 1;
      } else misses.push({ doc: doc.id, key, expected, got: gotAny });
      if (gotAny.some((value) => expected.includes(value))) s.foundAny += 1;
    }
  }

  const sum = (pick: (s: KeyStats) => number): number => Object.values(perKey).reduce((total, s) => total + pick(s), 0);
  return {
    perKey,
    perLayout,
    precisionHigh: sum((s) => s.highTotal) === 0 ? 1 : sum((s) => s.highCorrect) / sum((s) => s.highTotal),
    recallHigh: sum((s) => s.expectedHigh) === 0 ? 1 : sum((s) => s.foundHigh) / sum((s) => s.expectedHigh),
    recallAny: sum((s) => s.expectedHigh) === 0 ? 1 : sum((s) => s.foundAny) / sum((s) => s.expectedHigh),
    forbiddenHits,
    noHighViolations,
    wrongHigh,
    misses,
    documents: rows.length,
  };
}
