import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractGroundTruth, type GroundTruth } from "@/lib/pdf/testing/autoMapGroundTruth";
import { openForAnalysis } from "@/lib/pdf/testing/autoMapHarness";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";
import { iou } from "./classify";
import { analyzePixels } from "./classifyPixels";
import { decodePngThumb } from "./classifyPng";
import { extractWith, releaseRenderDocument, renderWith } from "./orchestrate";
import type { ExtractedAsset } from "./types";

/**
 * Medicion contra los CONTRATOS REALES del usuario (U7.3). Solo corre con `OPTIMUS_REAL_CONTRACTS_DIR=<carpeta>` (se salta en CI y
 * sin la variable). La carpeta tiene contratos en blanco y los firmados por OptimusPDF (`...-signed.pdf`, con una pagina extra de
 * certificado que se ignora). Comprueba: en los BLANCOS no sale ninguna firma ni iniciales; en los firmados salen las que coloco
 * OptimusPDF (verdad estructural de `autoMapGroundTruth`: las imagenes que el firmado tiene de mas frente al blanco), sin falsas, y
 * cada firma regenerada como PNG limpio es legible (tinta/area dentro de un rango y fondo transparente).
 *
 * PRIVACIDAD: solo se calculan posiciones, conteos, tiempos y memoria. Ningun texto ni imagen se escribe en ningun lado; el informe
 * opcional (`EXTRACT_REAL_REPORT`) contiene unicamente numeros y el nombre del archivo recortado a 8 caracteres.
 *
 *   OPTIMUS_REAL_CONTRACTS_DIR=/ruta npx vitest run src/lib/pdf/extractAssets/classify.real.test.ts
 */

const DIR = process.env.OPTIMUS_REAL_CONTRACTS_DIR;
const REPORT = process.env.EXTRACT_REAL_REPORT;
const suite = DIR && fs.existsSync(DIR) ? describe : describe.skip;

const pdfFiles = (dir: string): string[] => fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
const stem = (name: string): string => name.replace(/^[0-9a-f]{8}-/i, "").replace(/(\.pdf)+$/i, "");

function pairs(dir: string): Array<{ blank: string; signed: string }> {
  const files = pdfFiles(dir);
  const out: Array<{ blank: string; signed: string }> = [];
  for (const signed of files.filter((name) => /-signed\.pdf$/i.test(name))) {
    const base = stem(signed).replace(/-signed$/i, "");
    const bases = [base, base.replace(/_\d+$/, "")];
    const blank = files.find((candidate) => !/-signed\.pdf$/i.test(candidate) && bases.some((b) => b.endsWith(stem(candidate))));
    if (blank) out.push({ blank, signed });
  }
  return out;
}

const isSignatureOrInitials = (asset: ExtractedAsset): boolean => asset.kind === "signature" || asset.kind === "initials";

type Row = { doc: string; pages: number; assets: number; signatures: number; initials: number; truth?: number; matched?: number; falsePositives?: number; ms: number; rssMb: number };

suite("extractor contra contratos reales (local, opcional)", () => {
  const rows: Row[] = [];

  it("los contratos en blanco no dan ninguna firma ni iniciales", async () => {
    const dir = DIR as string;
    const signedNames = new Set(pairs(dir).map((pair) => pair.signed));
    const blanks = pdfFiles(dir).filter((name) => !signedNames.has(name) && !/-signed\.pdf$/i.test(name));
    expect(blanks.length).toBeGreaterThan(0);
    for (const name of blanks) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, name)));
      const before = process.memoryUsage().rss;
      const started = performance.now();
      const result = await extractWith(nodeExtractEnv, bytes);
      const ms = Math.round(performance.now() - started);
      const signatures = result.assets.filter((asset) => asset.kind === "signature").length;
      const initials = result.assets.filter((asset) => asset.kind === "initials").length;
      rows.push({ doc: name.slice(0, 8), pages: result.pageCount, assets: result.assets.length, signatures, initials, ms, rssMb: Math.round((process.memoryUsage().rss - before) / 1e6) });
      expect(signatures + initials, `${name.slice(0, 8)}: firmas o iniciales en un contrato en blanco`).toBe(0);
    }
  }, 300_000);

  it("los firmados por OptimusPDF: salen todas las firmas e iniciales colocadas, ninguna de mas, y cada firma extraida es legible", async () => {
    const dir = DIR as string;
    const list = pairs(dir);
    expect(list.length).toBeGreaterThan(0);
    let truthTotal = 0;
    let matchedTotal = 0;
    let detectedTotal = 0;
    let falseTotal = 0;
    for (const { blank, signed } of list) {
      const blankBytes = new Uint8Array(fs.readFileSync(path.join(dir, blank)));
      const signedBytes = new Uint8Array(fs.readFileSync(path.join(dir, signed)));
      const a = await openForAnalysis(blankBytes);
      const b = await openForAnalysis(signedBytes);
      let truth: GroundTruth;
      try {
        truth = await extractGroundTruth(a.pdf, b.pdf, a.ops);
      } finally {
        await a.close();
        await b.close();
      }
      const before = process.memoryUsage().rss;
      const started = performance.now();
      const result = await extractWith(nodeExtractEnv, signedBytes);
      const ms = Math.round(performance.now() - started);
      // La pagina extra al final (certificado antiguo) no cuenta.
      const ours = result.assets.filter(isSignatureOrInitials).map((asset) => ({ ...asset, occurrences: asset.occurrences.filter((o) => o.pageIndex < truth.pages) })).filter((asset) => asset.occurrences.length > 0);
      let matched = 0;
      for (const item of truth.images) {
        if (ours.some((asset) => asset.occurrences.some((o) => o.pageIndex === item.pageIndex && iou(o.rect, item.rect) > 0.5))) matched += 1;
      }
      let falsePositives = 0;
      for (const asset of ours) {
        if (!asset.occurrences.some((o) => truth.images.some((item) => item.pageIndex === o.pageIndex && iou(o.rect, item.rect) > 0.5))) falsePositives += 1;
      }
      truthTotal += truth.images.length;
      matchedTotal += matched;
      detectedTotal += ours.length;
      falseTotal += falsePositives;
      rows.push({
        doc: signed.slice(0, 8),
        pages: result.pageCount,
        assets: result.assets.length,
        signatures: result.assets.filter((asset) => asset.kind === "signature").length,
        initials: result.assets.filter((asset) => asset.kind === "initials").length,
        truth: truth.images.length,
        matched,
        falsePositives,
        ms,
        rssMb: Math.round((process.memoryUsage().rss - before) / 1e6),
      });
      expect(matched, `${signed.slice(0, 8)}: colocadas por OptimusPDF sin encontrar`).toBe(truth.images.length);
      expect(falsePositives, `${signed.slice(0, 8)}: firmas o iniciales de mas`).toBe(0);

      // Cada firma regenerada: PNG limpio, legible (tinta/area) y con fondo transparente.
      for (const asset of ours) {
        const blob = await renderWith(nodeExtractEnv, signedBytes, asset, "png");
        const raster = await decodePngThumb(blob);
        expect(raster, "PNG legible").not.toBeNull();
        const features = analyzePixels(raster!);
        expect(features.inkFraction, "tinta/area").toBeGreaterThan(0.02);
        expect(features.inkFraction, "tinta/area").toBeLessThan(0.6);
        expect(features.transparent, "fondo transparente").toBeGreaterThan(0.3);
        expect(features.lightBackground).toBe(true);
      }
    }
    await releaseRenderDocument();
    if (REPORT) fs.writeFileSync(REPORT, `${JSON.stringify({ rows, aggregate: { truthTotal, matchedTotal, detectedTotal, falseTotal } }, null, 1)}\n`);
    expect(matchedTotal / truthTotal).toBeGreaterThanOrEqual(0.9);
    expect(detectedTotal === 0 ? 1 : (detectedTotal - falseTotal) / detectedTotal).toBeGreaterThanOrEqual(0.9);
  }, 300_000);
});
