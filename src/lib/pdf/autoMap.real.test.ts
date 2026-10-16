import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autoMapBytes, openForAnalysis } from "@/lib/pdf/testing/autoMapHarness";
import { extractGroundTruth, type GroundTruth } from "@/lib/pdf/testing/autoMapGroundTruth";
import { evaluateAutoMap, type Metrics } from "@/lib/pdf/testing/autoMapEval";
import type { AutoMapResult } from "@/lib/pdf/autoMapTypes";

/**
 * Evaluacion contra los CONTRATOS REALES del usuario. Solo corre con `OPTIMUS_REAL_CONTRACTS_DIR=<carpeta>` (se salta
 * en CI y sin la variable). La carpeta tiene contratos en blanco y ejemplos firmados; los pares (blanco, firmado) se
 * reconocen por el nombre del blanco contenido en el del firmado. Los firmados llevan una pagina extra al final.
 *
 * PRIVACIDAD: solo se calculan posiciones y conteos. Nada de texto ni imagenes se escribe en ningun lado; el informe
 * opcional (`AUTOMAP_REPORT_FILE`) contiene unicamente numeros y los nombres de archivo recortados a 8 caracteres.
 *
 *   OPTIMUS_REAL_CONTRACTS_DIR=/ruta npx vitest run src/lib/pdf/autoMap.real.test.ts
 */
const DIR = process.env.OPTIMUS_REAL_CONTRACTS_DIR;
const REPORT = process.env.AUTOMAP_REPORT_FILE;
const run = DIR && fs.existsSync(DIR) ? describe : describe.skip;

function pdfFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
}

/** Nombre base de un contrato: sin el prefijo hexadecimal `xxxxxxxx-` ni la extension. */
function stem(name: string): string {
  return name.replace(/^[0-9a-f]{8}-/i, "").replace(/(\.pdf)+$/i, "");
}

function pairs(dir: string): Array<{ blank: string; signed: string }> {
  const files = pdfFiles(dir);
  const signed = files.filter((name) => /-signed\.pdf$/i.test(name));
  const out: Array<{ blank: string; signed: string }> = [];
  for (const file of signed) {
    const base = stem(file).replace(/-signed$/i, "");
    // El firmado puede llevar un sufijo numerico propio (`..._8`): se prueba con y sin el.
    const bases = [base, base.replace(/_\d+$/, "")];
    const blank = files.find((candidate) => !/-signed\.pdf$/i.test(candidate) && bases.some((b) => b.endsWith(stem(candidate))));
    if (blank) out.push({ blank, signed: file });
  }
  return out;
}

/** Maximo de imagenes pequenas (iniciales) que el firmado tiene en una misma pagina. */
function maxInitialsPerPage(truth: GroundTruth): number {
  const perPage = new Map<number, number>();
  for (const image of truth.images) {
    if (image.kind !== "initials") continue;
    perPage.set(image.pageIndex, (perPage.get(image.pageIndex) ?? 0) + 1);
  }
  return Math.max(0, ...perPage.values());
}

type Row = {
  doc: string;
  pages: number;
  signers: 1 | 2;
  metrics?: Metrics;
  counts: Record<string, number>;
  perPage: number[];
  /** Paginas (1-based) con una linea de iniciales propuesta y lineas de firma propuestas por pagina. */
  initialsPages: number[];
  signatureLines: number[];
  ms: number;
  warnings: string[];
};

run("automapeo contra contratos reales (local, opcional)", () => {
  const rows: Row[] = [];

  it("recorre todos los contratos y mide los que tienen ejemplo firmado", async () => {
    const dir = DIR as string;
    const withTruth = new Map<string, GroundTruth>();
    for (const { blank, signed } of pairs(dir)) {
      const a = await openForAnalysis(new Uint8Array(fs.readFileSync(path.join(dir, blank))));
      const b = await openForAnalysis(new Uint8Array(fs.readFileSync(path.join(dir, signed))));
      try {
        withTruth.set(blank, await extractGroundTruth(a.pdf, b.pdf, a.ops));
      } finally {
        await a.close();
        await b.close();
      }
    }
    const blanks = pdfFiles(dir).filter((name) => !/-signed\.pdf$/i.test(name));
    for (const name of blanks) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, name)));
      const truth = withTruth.get(name);
      // Con ejemplo firmado, los firmantes se deducen de el: dos imagenes de iniciales en una pagina = dos firmantes.
      const signers: 1 | 2 = truth && maxInitialsPerPage(truth) < 2 ? 1 : 2;
      const started = performance.now();
      const result: AutoMapResult = await autoMapBytes(bytes, { signers, locale: "es", includeIgnored: true });
      const ms = performance.now() - started;
      const counts: Record<string, number> = {
        high: result.confidenceSummary.high,
        review: result.confidenceSummary.review,
        ignore: result.confidenceSummary.ignore,
        initials: result.confidenceSummary.byType.initials,
        signature: result.confidenceSummary.byType.signature,
        date: result.confidenceSummary.byType.date,
        text: result.confidenceSummary.byType.text,
      };
      const perPage = result.pages.map((p) => result.fields.filter((f) => f.pageIndex === p.pageIndex && f.tier !== "ignore").length);
      rows.push({
        doc: name.slice(0, 8),
        pages: result.pages.length,
        signers,
        metrics: truth ? evaluateAutoMap(result.fields, truth, { tiers: ["high", "review"], signers }) : undefined,
        counts,
        perPage,
        initialsPages: result.pages.filter((p) => p.hasInitialsLine).map((p) => p.pageIndex + 1),
        signatureLines: result.pages.map((p) => p.signatureLines),
        ms: Math.round(ms),
        warnings: result.warnings.map((w) => w.code),
      });
      expect(Math.max(...perPage)).toBeLessThanOrEqual(12);
    }
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
    // Objetivos de la unidad sobre los ejemplos firmados: recall de iniciales >= 90 %, de firmas >= 80 %, precision `high` >= 90 %.
    const measured = rows.filter((row) => row.metrics);
    if (measured.length > 0) {
      const sum = (pick: (m: Metrics) => number) => measured.reduce((total, row) => total + pick(row.metrics as Metrics), 0);
      expect(sum((m) => m.initials.matched) / sum((m) => m.initials.total)).toBeGreaterThanOrEqual(0.9);
      expect(sum((m) => m.signature.matched) / sum((m) => m.signature.total)).toBeGreaterThanOrEqual(0.8);
      expect(sum((m) => m.highPrecision.correct) / sum((m) => m.highPrecision.proposals)).toBeGreaterThanOrEqual(0.9);
    }
  }, 300_000);
});
