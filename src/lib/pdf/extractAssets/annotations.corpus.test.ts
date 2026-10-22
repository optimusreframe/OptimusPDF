import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAnnotCorpus, type AnnotFixture } from "./__fixtures__/annots/generate";
import { ANNOT_CLASSES, TARGETS, evaluateRuns, formatReport, type FixtureRun } from "./__fixtures__/annots/evaluate";
import { getLegacyOps, napiSurfaceFactory, withLegacyDocument } from "./__fixtures__/annots/nodeEnv";
import { findAnnotationAssets } from "./annotations";

/**
 * Informe de metricas REPRODUCIBLE del motor de anotaciones sobre el corpus sintetico (U7.2): Ink y Stamp precision/recall >= 0,95;
 * marcas de agua (a,b) >= 0,90 y (c) >= 0,75; /Sig detectado al 100 %. `ANNOT_METRICS_OUT=ruta.json` guarda el informe en disco.
 */

const TRUTH_FILE = path.join(__dirname, "__fixtures__", "annots", "truth.json");
let corpus: AnnotFixture[] = [];
let runs: FixtureRun[] = [];

beforeAll(async () => {
  corpus = await buildAnnotCorpus();
  const ops = await getLegacyOps();
  runs = [];
  for (const fixture of corpus) {
    const result = await withLegacyDocument(fixture.bytes, (doc) => findAnnotationAssets(doc, { ops, createSurface: napiSurfaceFactory, bytes: fixture.bytes }));
    runs.push({ fixture, assets: result.assets, warnings: result.warnings ?? [], translucentPages: result.translucentImages?.map((c) => c.pageIndex) });
  }
});

describe("corpus sintetico de anotaciones", () => {
  it("la verdad en JSON coincide con la que genera el codigo (UPDATE_ANNOT_TRUTH=1 la regenera)", () => {
    const current = corpus.map(({ name, description, truth, digitalSignaturePages, translucentImagePages }) => ({ name, description, truth, digitalSignaturePages, translucentImagePages }));
    const text = `${JSON.stringify(current, null, 2)}\n`;
    if (process.env.UPDATE_ANNOT_TRUTH === "1") fs.writeFileSync(TRUTH_FILE, text);
    expect(fs.readFileSync(TRUTH_FILE, "utf8")).toBe(text);
  });

  it("el generador es reproducible byte a byte (salvo el PDF firmado, que sella la hora)", async () => {
    const again = await buildAnnotCorpus();
    const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    for (const fixture of corpus) {
      if (fixture.name === "signed-by-optimus") continue;
      const twin = again.find((item) => item.name === fixture.name);
      expect(hash(twin?.bytes ?? new Uint8Array()), fixture.name).toBe(hash(fixture.bytes));
    }
  });

  it("cada PDF del corpus es un PDF valido que pdf.js abre", async () => {
    for (const fixture of corpus) {
      const pages = await withLegacyDocument(fixture.bytes, async (doc) => doc.numPages);
      expect(pages, fixture.name).toBeGreaterThanOrEqual(1);
    }
  });

  it("metricas por clase cumplen los objetivos del plan", () => {
    const result = evaluateRuns(runs);
    const report = formatReport(result);
    if (process.env.ANNOT_METRICS_OUT) {
      fs.writeFileSync(process.env.ANNOT_METRICS_OUT, `${JSON.stringify({ perClass: result.perClass, problems: result.problems, fixtures: corpus.map((c) => c.name) }, null, 2)}\n`);
    }
    // El informe se imprime siempre: es la evidencia reproducible.
    console.info(`\nMetricas del motor de anotaciones (corpus de ${corpus.length} PDF)\n${report}\n`);
    expect(result.problems, result.problems.join("\n")).toEqual([]);
    for (const cls of ANNOT_CLASSES) {
      expect(result.perClass[cls].precision, `precision ${cls}`).toBeGreaterThanOrEqual(TARGETS[cls].precision);
      expect(result.perClass[cls].recall, `recall ${cls}`).toBeGreaterThanOrEqual(TARGETS[cls].recall);
    }
  });

  it("detecta el 100 % de los campos /Sig del corpus, tambien los vacios y los firmados", () => {
    const sig = runs.flatMap((run) => run.assets.filter((asset) => asset.source === "sig-widget"));
    const expected = corpus.flatMap((fixture) => fixture.truth.filter((item) => item.cls === "sig"));
    expect(sig).toHaveLength(expected.length);
    expect(evaluateRuns(runs).perClass.sig.recall).toBe(1);
  });

  it("los PDF firmados por signPdfMulti (firmas como imagen) no producen elementos de este motor", () => {
    const run = runs.find((item) => item.fixture.name === "signed-by-optimus");
    expect(run?.assets).toEqual([]);
    expect(run?.warnings).toEqual([]);
  });

  it("los senuelos (enlace, resaltado, nota, texto libre, campo de texto, Ink oculta) no dan nada", () => {
    expect(runs.find((item) => item.fixture.name === "decoys")?.assets).toEqual([]);
  });

  it("el texto diagonal translucido de una sola pagina no cuenta, ni el titulo grande opaco", () => {
    expect(runs.find((item) => item.fixture.name === "text-watermark-1of6")?.assets).toEqual([]);
  });

  it("la imagen translucida repetida solo se marca como candidata (d); no se duplica como elemento", () => {
    const run = runs.find((item) => item.fixture.name === "translucent-image-6");
    expect(run?.assets).toEqual([]);
    expect(run?.translucentPages).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
