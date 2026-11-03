/**
 * REGRESION sobre los corpus SINTETICOS ya existentes (principal + realista + sinonimos): lee cada documento con el motor, calcula las
 * mismas metricas que `autofill.corpus.test.ts` y guarda lo que devolvio cada documento (clave, valor, nivel) para COMPARAR dos corridas
 * (antes y despues de un cambio del motor). No es una prueba: no forma parte de `vitest`. Datos 100 % inventados.
 *
 *   JITI_ALIAS='{"@":"'$PWD'/src"}' node node_modules/jiti/lib/jiti-cli.mjs scripts/autofill-corpus-regression.ts --out .bench/out --label before
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createExtract } from "@/lib/autofill/engine";
import { buildCorpus, type CorpusDoc } from "@/lib/autofill/testing/corpus";
import { buildHeldOutCorpus } from "@/lib/autofill/testing/heldout";
import { evaluate } from "@/lib/autofill/testing/metrics";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";
import { buildRealisticCorpusWithTruth } from "@/lib/autofill/testing/realistic";
import type { ExtractResult } from "@/lib/autofill/types";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  const out = get("out") ?? ".bench/out";
  const label = get("label") ?? "corpus";
  const sets: Array<[string, CorpusDoc[]]> = [
    ["principal+realista", [...buildCorpus(), ...(await buildRealisticCorpusWithTruth())]],
    ["sinonimos", buildHeldOutCorpus()],
  ];
  const extract = createExtract(nodeDeps());
  const lines: string[] = [`# ${label}`, ""];
  const perDoc: Record<string, Array<[string, string, string]>> = {};
  for (const [name, docs] of sets) {
    const rows: Array<{ doc: CorpusDoc; result: ExtractResult }> = [];
    for (const doc of docs) {
      const result = await extract([await doc.source()], { locale: doc.locale });
      rows.push({ doc, result });
      perDoc[doc.id] = result.values.map((v) => [v.key, v.value, v.tier]);
    }
    const report = evaluate(rows);
    lines.push(`## ${name}: ${docs.length} documentos`, "", `precision high ${report.precisionHigh.toFixed(4)} · recall high ${report.recallHigh.toFixed(4)} · recall cualquier nivel ${report.recallAny.toFixed(4)} · señuelos ${report.forbiddenHits.length} · noHigh ${report.noHighViolations.length}`, "");
    lines.push("| clave | high correctos/total | recall high | recall cualquier nivel |", "|---|---|---|---|");
    for (const [key, s] of Object.entries(report.perKey)) lines.push(`| ${key} | ${s.highCorrect}/${s.highTotal} | ${s.foundHigh}/${s.expectedHigh} | ${s.foundAny}/${s.expectedHigh} |`);
    lines.push("", `high equivocados: ${report.wrongHigh.length}`, ...report.wrongHigh.slice(0, 40).map((w) => `- ${w.doc} ${w.key}: esperado ${JSON.stringify(w.expected)} · devolvio ${JSON.stringify(w.got)}`), "");
    lines.push(`recall high perdido: ${report.misses.length}`, ...report.misses.slice(0, 40).map((w) => `- ${w.doc} ${w.key}: esperado ${JSON.stringify(w.expected)} · devolvio ${JSON.stringify(w.got)}`), "");
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `${label}.md`), lines.join("\n"));
  writeFileSync(path.join(out, `${label}.docs.json`), JSON.stringify(perDoc, null, 1));
  console.log(lines.join("\n"));
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
