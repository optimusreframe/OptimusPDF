import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExtract } from "@/lib/autofill/engine";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";

/**
 * Medicion contra los CONTRATOS REALES del usuario (opcional, SOLO LOCAL): `AUTOFILL_REAL_DOCS_DIR=<carpeta con PDF e imagenes>`.
 * Se salta sin la variable (CI). PRIVACIDAD: no se imprime ni se guarda ningun valor, nombre de archivo ni texto; el informe
 * opcional (`AUTOFILL_REPORT_FILE`) lleva SOLO cifras agregadas (claves `high` y `review` por documento, tiempos, memoria).
 *
 *   AUTOFILL_REAL_DOCS_DIR=/ruta AUTOFILL_REPORT_FILE=/ruta/informe.json npx vitest run src/lib/autofill/autofill.real.test.ts
 */
const DIR = process.env.AUTOFILL_REAL_DOCS_DIR;
const REPORT = process.env.AUTOFILL_REPORT_FILE;

describe.skipIf(!DIR || !fs.existsSync(DIR))("autorrelleno sobre documentos reales (local)", () => {
  it("mide claves por documento, tiempo y memoria sin mostrar ningun valor", async () => {
    const dir = DIR as string;
    const files = fs.readdirSync(dir).filter((name) => /\.pdf$/i.test(name)).sort();
    const extract = createExtract(nodeDeps({ rasterize: false }));
    const rows: Array<{ doc: number; signed: boolean; pages: number; high: number; review: number; keysHigh: string[]; ms: number; usedOcr: boolean; warnings: string[] }> = [];
    let peakRss = 0;
    for (const [index, name] of files.entries()) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, name)));
      const started = performance.now();
      const result = await extract([{ kind: "pdf", file: new File([bytes as BlobPart], "doc.pdf"), origin: "file" }], { locale: "en" });
      const ms = performance.now() - started;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const high = result.values.filter((value) => value.tier === "high");
      rows.push({
        doc: index + 1,
        signed: /-signed\.pdf$/i.test(name),
        pages: result.pagesRead,
        high: high.length,
        review: result.values.length - high.length,
        keysHigh: [...new Set(high.map((value) => value.key))],
        ms: Math.round(ms),
        usedOcr: result.usedOcr,
        warnings: result.warnings.map((warning) => warning.code),
      });
      // Nunca un valor en las razones ni en los avisos.
      for (const value of result.values) expect(value.evidence.snippet.length).toBeLessThanOrEqual(120);
    }
    const summary = {
      documents: rows.length,
      signed: rows.filter((row) => row.signed).length,
      highPerDoc: rows.map((row) => row.high),
      reviewPerDoc: rows.map((row) => row.review),
      keysHighPerDoc: rows.map((row) => row.keysHigh),
      msPerDoc: rows.map((row) => row.ms),
      totalMs: rows.reduce((sum, row) => sum + row.ms, 0),
      peakRssMb: Math.round(peakRss / 1048576),
      rows,
    };
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(summary, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("fotos sin datos (un techo): se decodifican, el OCR no halla texto y no se propone nada", async () => {
    const dir = DIR as string;
    const images = fs.readdirSync(dir).filter((name) => /\.(jpe?g|png)$/i.test(name)).sort();
    if (images.length === 0) return;
    let calls = 0;
    const extract = createExtract(nodeDeps({ recognize: async (image) => { calls += 1; return { text: "", lines: [], width: image.width, height: image.height }; } }));
    const started = performance.now();
    let proposed = 0;
    let decoded = 0;
    for (const name of images) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, name)));
      const result = await extract([{ kind: "image", file: new File([bytes as BlobPart], "foto.jpg"), origin: "camera" }], { locale: "en" });
      proposed += result.values.length;
      if (!result.warnings.some((warning) => warning.code === "unreadable-source")) decoded += 1;
    }
    const ms = Math.round(performance.now() - started);
    if (REPORT) fs.writeFileSync(`${REPORT}.images.json`, JSON.stringify({ images: images.length, decoded, ocrCalls: calls, proposed, totalMs: ms, peakRssMb: Math.round(process.memoryUsage().rss / 1048576) }));
    expect(proposed).toBe(0);
    expect(decoded).toBe(images.length);
  }, 120_000);
});
