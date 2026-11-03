/**
 * Metricas del banco de declaraciones: precision y cobertura POR CLAVE y POR TIPO DE ENTRADA (texto / escaneo / foto), usando
 * `evaluate` de `metrics.ts` (mismas definiciones que el corpus principal) y anadiendo lo propio de una hoja de declaraciones:
 *   - claves AUSENTES (la hoja no tiene ese dato: cualquier valor que salga es un error, en el nivel que sea);
 *   - valores `review` equivocados (ruido que la persona tendria que descartar);
 *   - la direccion se compara sin comas ni mayusculas (el motor conserva la puntuacion de origen).
 */

import { evaluate, type KeyStats, type Report } from "@/lib/autofill/testing/metrics";
import type { CorpusDoc } from "@/lib/autofill/testing/corpus";
import type { ExtractResult, ExtractedValue } from "@/lib/autofill/types";
import type { DeclDoc, InputKind } from "@/lib/autofill/testing/declBank";

export type Row = { doc: DeclDoc; kind: InputKind; result: ExtractResult; ms: number; error?: string };

const looseKeys = new Set(["address", "mailingAddress"]);
const loose = (value: string): string => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** El motor conserva la puntuacion de la direccion tal como estaba impresa: se compara sin ella. */
function canonical(value: ExtractedValue): ExtractedValue {
  return looseKeys.has(value.key) ? { ...value, value: loose(value.value) } : value;
}

function canonicalTruth(doc: DeclDoc): CorpusDoc["truth"] {
  const fold = (map: Partial<Record<string, string | string[]>> | undefined): Partial<Record<string, string | string[]>> | undefined => {
    if (!map) return map;
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(map)) {
      if (value === undefined) continue;
      out[key] = looseKeys.has(key) ? (Array.isArray(value) ? value.map(loose) : loose(value)) : value;
    }
    return out;
  };
  return { high: fold(doc.truth.high), review: fold(doc.truth.review), forbidden: doc.truth.forbidden, noHigh: doc.truth.noHigh };
}

export type TypeReport = {
  kind: InputKind;
  docs: number;
  report: Report;
  /** Valores de una clave que la hoja NO tiene, por nivel. */
  absentHigh: Array<{ doc: string; key: string; value: string }>;
  absentAny: Array<{ doc: string; key: string; value: string }>;
  /** Valores `review` que no son lo esperado (ni estan permitidos). */
  wrongReview: Array<{ doc: string; key: string; value: string }>;
  errors: number;
  msMedian: number;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

export function reportFor(rows: readonly Row[], kind: InputKind): TypeReport {
  const mine = rows.filter((row) => row.kind === kind);
  const prepared = mine.map((row) => ({
    doc: { id: row.doc.id, locale: row.doc.locale, layout: kind, source: async () => ({ kind: "text", text: "", origin: "paste" }) as never, truth: canonicalTruth(row.doc) } satisfies CorpusDoc,
    result: { ...row.result, values: row.result.values.map(canonical) },
  }));
  const report = evaluate(prepared);
  const absentHigh: TypeReport["absentHigh"] = [];
  const absentAny: TypeReport["absentAny"] = [];
  const wrongReview: TypeReport["wrongReview"] = [];
  for (const row of mine) {
    const truth = canonicalTruth(row.doc);
    const absent = new Set(row.doc.truth.absent);
    for (const value of row.result.values.map(canonical)) {
      if (absent.has(value.key)) {
        absentAny.push({ doc: row.doc.id, key: value.key, value: value.value });
        if (value.tier === "high") absentHigh.push({ doc: row.doc.id, key: value.key, value: value.value });
      } else if (value.tier === "review") {
        const acceptable = [truth.high?.[value.key], truth.review?.[value.key]].flatMap((entry) => (entry === undefined ? [] : Array.isArray(entry) ? entry : [entry]));
        if (!acceptable.includes(value.value)) wrongReview.push({ doc: row.doc.id, key: value.key, value: value.value });
      }
    }
  }
  return { kind, docs: mine.length, report, absentHigh, absentAny, wrongReview, errors: mine.filter((row) => row.error).length, msMedian: median(mine.map((row) => row.ms)) };
}

/* ------------------------------------------------------------------ *
 * Tablas
 * ------------------------------------------------------------------ */

const pct = (a: number, b: number): string => (b === 0 ? "  -  " : `${((100 * a) / b).toFixed(1).padStart(5)}`);

/** Precision de `high` y recall por clave. `high wrong` incluye valores en claves ausentes (la hoja no tiene ese dato). */
export function keyTable(reports: readonly TypeReport[], keys: readonly string[]): string {
  const header = `| clave | ${reports.map((r) => `${r.kind}: P(high) · R(high) · R(any)`).join(" | ")} |`;
  const sep = `|---|${reports.map(() => "---").join("|")}|`;
  const lines = [header, sep];
  for (const key of keys) {
    const cells = reports.map((r) => {
      const s: KeyStats | undefined = r.report.perKey[key];
      const wrong = s?.highWrong ?? 0;
      const total = s?.highTotal ?? 0;
      const correct = s?.highCorrect ?? 0;
      return `${pct(correct, total)}% (${correct}/${total}) · ${pct(s?.foundHigh ?? 0, s?.expectedHigh ?? 0)}% (${s?.foundHigh ?? 0}/${s?.expectedHigh ?? 0}) · ${pct(s?.foundAny ?? 0, s?.expectedHigh ?? 0)}%${wrong > 0 ? ` ⚠${wrong}` : ""}`;
    });
    lines.push(`| ${key} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

export function totalsTable(reports: readonly TypeReport[]): string {
  const lines = ["| entrada | docs | precision high | recall high | recall cualquier nivel | high equivocados | high en clave ausente | cualquier nivel en clave ausente | señuelos | review equivocados | mediana ms |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of reports) {
    const keys = Object.values(r.report.perKey);
    const highTotal = keys.reduce((n, s) => n + s.highTotal, 0);
    const highCorrect = keys.reduce((n, s) => n + s.highCorrect, 0);
    const expected = keys.reduce((n, s) => n + s.expectedHigh, 0);
    const found = keys.reduce((n, s) => n + s.foundHigh, 0);
    const any = keys.reduce((n, s) => n + s.foundAny, 0);
    lines.push(
      `| ${r.kind} | ${r.docs} | ${pct(highCorrect, highTotal)}% (${highCorrect}/${highTotal}) | ${pct(found, expected)}% (${found}/${expected}) | ${pct(any, expected)}% (${any}/${expected}) | ${highTotal - highCorrect} | ${r.absentHigh.length} | ${r.absentAny.length} | ${r.report.forbiddenHits.length} | ${r.wrongReview.length} | ${r.msMedian.toFixed(0)} |`,
    );
  }
  return lines.join("\n");
}
