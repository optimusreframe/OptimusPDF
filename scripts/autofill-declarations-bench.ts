/**
 * MEDICION del autorrelleno sobre el banco SINTETICO de «declaration pages» de seguros de hogar (no es una prueba: no forma parte
 * de `vitest`). Genera 28 plantillas x N instancias en tres formas (PDF con texto, PDF escaneado, foto), lee cada una con el
 * motor real (`createExtract`) y el OCR REAL (tesseract.js, mismo modelo que la aplicacion) y escribe tablas de precision y cobertura
 * por clave y por tipo de entrada.
 *
 * Ejecutar desde la raiz del repositorio (la primera vez descarga el modelo de OCR a `--ocr-cache`):
 *
 *   JITI_ALIAS='{"@":"'$PWD'/src"}' node node_modules/jiti/lib/jiti-cli.mjs scripts/autofill-declarations-bench.ts \
 *     --out .bench/out --cache .bench/cache --ocr-cache .bench/tessdata --instances 1 --types text,scan,photo --workers 4
 *
 * Opciones: `--only id1,id2` (plantillas), `--types`, `--instances N`, `--workers N` (reconocedores en paralelo), `--no-ocr`,
 * `--result-cache dir` (guarda cada lectura de OCR: repetir la medicion con la misma imagen no vuelve a reconocer), `--no-prep` (sin preparacion de imagen), `--label nombre` (prefijo de los archivos de salida). Los archivos generados (PDF, fotos) solo se guardan si das `--cache`.
 * Datos 100 % inventados; ningun valor sale de la maquina salvo la descarga del modelo.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createExtract } from "@/lib/autofill/engine";
import { buildBank, INPUT_KINDS, type DeclDoc, type InputKind } from "@/lib/autofill/testing/declBank";
import { keyTable, reportFor, totalsTable, type Row, type TypeReport } from "@/lib/autofill/testing/declMetrics";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";
import { createRealOcr, type RealOcr } from "@/lib/autofill/testing/realOcr";

type Args = { retry: boolean; held: boolean; resultCache?: string; prep: boolean; out: string; cache?: string; ocrCache: string; instances: number; types: InputKind[]; only?: string[]; workers: number; ocr: boolean; label: string };

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    out: get("out") ?? ".bench/out",
    cache: get("cache"),
    ocrCache: get("ocr-cache") ?? ".bench/tessdata",
    resultCache: get("result-cache"),
    instances: Number(get("instances") ?? 1),
    types: (get("types")?.split(",") ?? [...INPUT_KINDS]) as InputKind[],
    only: get("only")?.split(","),
    workers: Math.max(1, Number(get("workers") ?? 4)),
    ocr: !argv.includes("--no-ocr"),
    prep: !argv.includes("--no-prep"),
    held: argv.includes("--held"),
    retry: !argv.includes("--no-retry"),
    label: get("label") ?? "run",
  };
}

const KEYS = ["insuredName1", "insuredName2", "address", "mailingAddress", "phone", "email", "insurer", "policyNumber", "policyStart", "policyEnd", "mortgagee", "deductible", "windDeductible", "claimNumber", "claimType", "lossDate"];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const bank = await buildBank({ instances: args.instances, only: args.only, cacheDir: args.cache, held: args.held });
  console.log(`banco: ${bank.length} documentos x ${args.types.join("/")}`);

  const pool: RealOcr[] = [];
  const free: RealOcr[] = [];
  if (args.ocr && args.types.some((kind) => kind !== "text")) {
    for (let n = 0; n < args.workers; n += 1) {
      const worker = await createRealOcr(args.ocrCache, "spa+eng", args.resultCache);
      pool.push(worker);
      free.push(worker);
    }
  }

  type Job = { doc: DeclDoc; kind: InputKind };
  const jobs: Job[] = bank.flatMap((doc) => args.types.map((kind) => ({ doc, kind })));
  const rows: Row[] = [];
  let next = 0;
  const waiting: Array<(worker: RealOcr) => void> = [];
  const take = (): Promise<RealOcr> => {
    const worker = free.pop();
    return worker ? Promise.resolve(worker) : new Promise((resolve) => waiting.push(resolve));
  };
  const give = (worker: RealOcr): void => {
    const waiter = waiting.shift();
    if (waiter) waiter(worker);
    else free.push(worker);
  };

  const run = async (job: Job): Promise<void> => {
    const t0 = Date.now();
    const sources = await job.doc.sources(job.kind);
    const needsOcr = job.kind !== "text" && args.ocr;
    const worker = needsOcr ? await take() : null;
    try {
      const engine = createExtract(nodeDeps({ recognize: worker ? worker.recognize : undefined, rasterize: true, prepare: args.prep, retry: args.retry, snapshots: true }));
      const result = await engine(sources, { locale: job.doc.locale });
      rows.push({ doc: job.doc, kind: job.kind, result, ms: Date.now() - t0 });
    } catch (error) {
      rows.push({ doc: job.doc, kind: job.kind, result: { values: [], warnings: [], pagesRead: 0, usedOcr: false }, ms: Date.now() - t0, error: String(error) });
    } finally {
      if (worker) give(worker);
    }
    if (rows.length % 10 === 0) console.log(`  ${rows.length}/${jobs.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  };

  const lanes = Math.max(args.workers, 2);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        await run(job);
      }
    }),
  );
  const modes: Record<string, number> = {};
  for (const worker of pool) for (const [mode, n] of Object.entries(worker.modes)) modes[mode] = (modes[mode] ?? 0) + n;
  console.log(`lecturas de OCR por modo de segmentacion: ${JSON.stringify(modes)}`);
  await Promise.all(pool.map((worker) => worker.close()));

  const reports: TypeReport[] = args.types.map((kind) => reportFor(rows, kind));
  const text = [`# ${args.label}`, "", `Documentos: ${bank.length} (x ${args.types.join(", ")}) · ${((Date.now() - started) / 1000).toFixed(0)} s`, "", "## Totales", "", totalsTable(reports), "", "## Por clave", "", keyTable(reports, KEYS), ""].join("\n");
  console.log(`\n${text}`);

  mkdirSync(args.out, { recursive: true });
  writeFileSync(path.join(args.out, `${args.label}.md`), text);
  const detail = reports.map((r) => ({
    kind: r.kind,
    wrongHigh: r.report.wrongHigh,
    misses: r.report.misses,
    absentHigh: r.absentHigh,
    absentAny: r.absentAny,
    wrongReview: r.wrongReview,
    forbidden: r.report.forbiddenHits,
    noHigh: r.report.noHighViolations,
    errors: rows.filter((row) => row.kind === r.kind && row.error).map((row) => ({ doc: row.doc.id, error: row.error })),
  }));
  writeFileSync(path.join(args.out, `${args.label}.detail.json`), JSON.stringify(detail, null, 1));
  // Valores devueltos por documento (para comparar dos corridas); sin texto de las fuentes.
  const values = rows.map((row) => ({
    doc: row.doc.id,
    kind: row.kind,
    ms: row.ms,
    warnings: row.result.warnings.map((warning) => warning.code),
    values: row.result.values.map((v) => ({ key: v.key, value: v.value, tier: v.tier, confidence: v.confidence, origin: v.evidence.origin, page: v.evidence.pageIndex, ocrConf: v.evidence.ocrConfidence, verified: v.evidence.verified, reason: v.reason })),
  }));
  writeFileSync(path.join(args.out, `${args.label}.values.json`), JSON.stringify(values, null, 1));
  console.log(`\nescrito en ${args.out}/${args.label}.{md,detail.json,values.json}`);
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
