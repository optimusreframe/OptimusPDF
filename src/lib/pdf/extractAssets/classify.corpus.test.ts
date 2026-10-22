import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { buildClassifyCorpus, type ClassifyFixture } from "./__fixtures__/classify/generate";
import { CLASSES, EMBEDDED_RECALL_TARGET, MAX_DECOY_FALSE_SIGNATURE_RATE, TARGETS, evaluateRuns, formatReport, type FixtureRun } from "./__fixtures__/classify/evaluate";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";
import { extractWith } from "./orchestrate";

/**
 * Informe de metricas REPRODUCIBLE del clasificador sobre el corpus sintetico (U7.3): firmas como imagen precision >= 0,85 y recall
 * >= 0,80; iniciales >= 0,80; logos >= 0,90; vectoriales (beta) recall >= 0,60; imagenes incrustadas recall 100 % tras la fusion; sin
 * falsas «firma» en senuelos > 10 %. `CLASSIFY_METRICS_OUT=ruta.json` guarda el informe. El corpus es PROPIO (los umbrales se afinaron
 * con el y con sus senuelos): mide regresiones y limites de diseno, no precision independiente.
 */

const TRUTH_FILE = path.join(__dirname, "__fixtures__", "classify", "truth.json");
let corpus: ClassifyFixture[] = [];
let runs: FixtureRun[] = [];

beforeAll(async () => {
  corpus = await buildClassifyCorpus();
  runs = [];
  for (const fixture of corpus) {
    const result = await extractWith(nodeExtractEnv, fixture.bytes);
    runs.push({ fixture, assets: result.assets, warnings: result.warnings, scannedPages: result.scannedPages });
  }
}, 120_000);

describe("corpus sintetico del clasificador", () => {
  it("la verdad en JSON coincide con la que genera el codigo (UPDATE_CLASSIFY_TRUTH=1 la regenera)", () => {
    const current = corpus.map(({ name, description, truth, embedded, decoy, decoyElements, scannedPages }) => ({ name, description, truth, embedded, decoy, decoyElements, scannedPages }));
    const text = `${JSON.stringify(current, (_key, value) => (typeof value === "number" ? Math.round(value * 1e9) / 1e9 : value), 2)}\n`;
    if (process.env.UPDATE_CLASSIFY_TRUTH === "1") fs.writeFileSync(TRUTH_FILE, text);
    expect(fs.readFileSync(TRUTH_FILE, "utf8")).toBe(text);
  });

  it("el generador es reproducible byte a byte (salvo los PDF firmados por signPdfMulti, que sellan la hora)", async () => {
    const again = await buildClassifyCorpus();
    const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    const stamped = new Set(["optimus-1signer", "optimus-2signers", "optimus-no-labels", "optimus-thick-initials"]);
    for (const fixture of corpus) {
      if (stamped.has(fixture.name)) continue;
      expect(hash(again.find((item) => item.name === fixture.name)!.bytes), fixture.name).toBe(hash(fixture.bytes));
    }
  });

  it("cada PDF es valido, con descripcion, y los firmados por signPdfMulti traen su productor y palabra clave", async () => {
    expect(corpus.length).toBeGreaterThanOrEqual(15);
    expect(new Set(corpus.map((fixture) => fixture.name)).size).toBe(corpus.length);
    for (const fixture of corpus) {
      const doc = await PDFDocument.load(fixture.bytes, { updateMetadata: false });
      expect(doc.getPageCount(), fixture.name).toBeGreaterThanOrEqual(1);
      expect(fixture.description.length, fixture.name).toBeGreaterThan(20);
    }
    for (const name of ["optimus-1signer", "optimus-2signers", "optimus-thick-initials"]) {
      const doc = await PDFDocument.load(corpus.find((fixture) => fixture.name === name)!.bytes, { updateMetadata: false });
      expect(doc.getProducer()).toBe("OptimusPDF");
      expect(doc.getKeywords()).toContain("optimuspdf-signed");
    }
  });

  it("trae lo que pide la unidad: 1 y 2 firmantes con iniciales por pagina, firmas pegadas, logo repetido, foto, sello, vector, escaneo y senuelos", () => {
    const names = corpus.map((fixture) => fixture.name);
    for (const wanted of ["optimus-1signer", "optimus-2signers", "pasted-scans", "docusign-like", "logo-header-footer", "photo", "stamp-images", "vector-signatures", "scanned-page", "vector-decoys", "image-decoys", "icon-decoys", "empty-form"]) {
      expect(names, wanted).toContain(wanted);
    }
    const twoSigners = corpus.find((fixture) => fixture.name === "optimus-2signers")!;
    expect(twoSigners.truth.filter((item) => item.cls === "signature")).toHaveLength(2);
    expect(twoSigners.truth.filter((item) => item.cls === "initials")).toHaveLength(2);
    expect(twoSigners.truth.filter((item) => item.cls === "initials").every((item) => item.pages.length === 3)).toBe(true);
    const decoyElements = corpus.reduce((sum, fixture) => sum + (fixture.decoyElements ?? 0), 0);
    expect(decoyElements).toBeGreaterThanOrEqual(20);
  });

  it("metricas por clase y globales cumplen los objetivos", () => {
    const result = evaluateRuns(runs);
    const report = formatReport(result);
    if (process.env.CLASSIFY_METRICS_OUT) {
      fs.writeFileSync(process.env.CLASSIFY_METRICS_OUT, `${JSON.stringify({ perClass: result.perClass, embedded: result.embedded, decoys: result.decoys, scanned: result.scanned, problems: result.problems, fixtures: corpus.map((c) => c.name) }, null, 2)}\n`);
    }
    console.info(`\nMetricas del clasificador (corpus de ${corpus.length} PDF)\n${report}\n`);
    expect(result.problems, result.problems.join("\n")).toEqual([]);
    for (const cls of CLASSES) {
      expect(result.perClass[cls].precision, `precision ${cls}`).toBeGreaterThanOrEqual(TARGETS[cls].precision);
      expect(result.perClass[cls].recall, `recall ${cls}`).toBeGreaterThanOrEqual(TARGETS[cls].recall);
    }
    expect(result.embedded.recall).toBeGreaterThanOrEqual(EMBEDDED_RECALL_TARGET);
    expect(result.embedded.total).toBeGreaterThanOrEqual(45);
    expect(result.decoys.falseSignatures / result.decoys.total).toBeLessThanOrEqual(MAX_DECOY_FALSE_SIGNATURE_RATE);
    expect(result.scanned.found).toBe(result.scanned.expected);
  });

  it("sin ninguna firma ni iniciales falsas en los senuelos (tasa por elemento senuelo)", () => {
    const decoyRuns = runs.filter((run) => run.fixture.decoy);
    const elements = decoyRuns.reduce((sum, run) => sum + (run.fixture.decoyElements ?? 1), 0);
    const falseOnes = decoyRuns.reduce((sum, run) => sum + run.assets.filter((asset) => asset.kind === "signature" || asset.kind === "initials").length, 0);
    expect(falseOnes / elements).toBeLessThanOrEqual(MAX_DECOY_FALSE_SIGNATURE_RATE);
    expect(falseOnes).toBe(0);
  });

  it("las firmas de OptimusPDF con etiqueta salen «probables» (0,85-0,89) con el motivo de la etiqueta; sin etiqueta, «posibles»", () => {
    const one = runs.find((run) => run.fixture.name === "optimus-1signer")!;
    for (const asset of one.assets) {
      expect(asset.confidence).toBeGreaterThanOrEqual(0.85);
      expect(asset.confidence).toBeLessThan(0.9);
      expect(asset.reasons.some((reason) => reason.startsWith("cerca de «"))).toBe(true);
    }
    const none = runs.find((run) => run.fixture.name === "optimus-no-labels")!;
    expect(none.assets).toHaveLength(1);
    expect(none.assets[0].confidence).toBeLessThan(0.85);
  });

  it("las iniciales repetidas en 3 paginas son UN solo elemento con 3 apariciones", () => {
    const one = runs.find((run) => run.fixture.name === "optimus-1signer")!;
    const initials = one.assets.filter((asset) => asset.kind === "initials");
    expect(initials).toHaveLength(1);
    expect(initials[0].occurrences.map((o) => o.pageIndex)).toEqual([0, 1, 2]);
  });

  it("firmas vectoriales: beta en los motivos, confianza <= 0,7 y descargables en png y svg", () => {
    const vectors = runs.find((run) => run.fixture.name === "vector-signatures")!.assets.filter((asset) => asset.source === "vector");
    expect(vectors).toHaveLength(4);
    for (const asset of vectors) {
      expect(asset.reasons[0]).toContain("(beta)");
      expect(asset.confidence).toBeLessThanOrEqual(0.7);
      expect(asset.formats).toEqual(["png", "svg"]);
    }
  });

  it("limites conocidos que NO se miden como fallo: la firma de la pagina escaneada no se separa sola", () => {
    const scanned = runs.find((run) => run.fixture.name === "scanned-page")!;
    expect(scanned.assets.some((asset) => asset.kind === "signature")).toBe(false);
    expect(scanned.scannedPages).toEqual([0]);
  });
});
