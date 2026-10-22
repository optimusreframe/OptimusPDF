import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { buildImagesCorpus } from "./__fixtures__/images/corpus";
import { evaluateImages, summarize, type DocMetrics } from "./__fixtures__/images/metrics";
import { findImageAssets } from "./images";
import { openLegacy } from "./images.testUtils";

/**
 * INFORME DE METRICAS del motor de imagenes (objetivos de docs/PLAN-FIRMA-AGIL.md §9.5), reproducible:
 *
 *     npx vitest run --project engines src/lib/pdf/extractAssets/images.metrics.test.ts
 *
 * Imprime la tabla por documento y el resumen, y las comprueba contra los objetivos: recall 100 % de las imagenes
 * incrustadas, duplicados agrupados 100 %, cajas de aparicion con IoU >= 0,9, 20 paginas con 30 imagenes en < 2 s
 * (escritorio; `process.env.CI ? 2.5 : 1` de holgura) y memoria acotada. Con `EXTRACT_REPORT=<ruta.json>` guarda el
 * informe. Las medidas en navegador (iPad/WebKit, tareas largas, heap) las da `e2e/specs/extract-images.spec.ts`.
 */

const SLACK = process.env.CI ? 2.5 : 1;

describe("metricas del motor de imagenes sobre el corpus sintetico", () => {
  it("recall 100 %, duplicados agrupados 100 %, IoU >= 0,9 y avisos exactos (informe)", async () => {
    const corpus = await buildImagesCorpus();
    const rows: Array<DocMetrics & { ms: number }> = [];
    for (const entry of corpus) {
      const opened = await openLegacy(entry.bytes);
      try {
        const t0 = performance.now();
        const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes: entry.bytes });
        const ms = performance.now() - t0;
        rows.push({ ...evaluateImages(result, entry.truth), ms });
      } finally {
        await opened.close();
      }
    }
    const summary = summarize(rows);
    const table = rows.map((row) => `${row.name.padEnd(14)} ${String(row.found).padStart(3)}/${String(row.truthImages).padEnd(3)} exactas ${String(row.exact).padStart(3)}  extra ${row.extra}  IoU min ${row.minIou.toFixed(3)}  ${row.ms.toFixed(0).padStart(5)} ms`).join("\n");
    console.info(
      `\n[extract-images metricas]\n${table}\n` +
        `TOTAL ${summary.docs} documentos, ${summary.truthImages} imagenes: recall ${(summary.recall * 100).toFixed(1)} %, exactas ${(summary.exactRate * 100).toFixed(1)} %, ` +
        `duplicados agrupados ${(summary.duplicateGroupRate * 100).toFixed(1)} %, sobrantes ${summary.extraAssets}, IoU minimo ${summary.minIou.toFixed(3)}`,
    );
    if (process.env.EXTRACT_REPORT) fs.writeFileSync(path.resolve(process.env.EXTRACT_REPORT), `${JSON.stringify({ summary, rows }, null, 2)}\n`);

    expect(summary.failingDocs).toEqual([]);
    expect(summary.recall).toBe(1);
    expect(summary.duplicateGroupRate).toBe(1);
    expect(summary.extraAssets).toBe(0);
    expect(summary.minIou).toBeGreaterThanOrEqual(0.9);
    expect(summary.docs).toBe(21);
    expect(summary.truthImages).toBe(rows.reduce((sum, row) => sum + row.truthImages, 0));
  });

  async function scaleDoc(pages: number, images: number, width: number, height: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const context = doc.context;
    const pageObjects = Array.from({ length: pages }, () => doc.addPage([612, 792]));
    for (let i = 0; i < images; i += 1) {
      const data = new Uint8Array(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const o = (y * width + x) * 3;
          data[o] = ((x >> 4) * 5 + i * 31) & 255;
          data[o + 1] = ((y >> 4) * 7 + i * 17) & 255;
          data[o + 2] = (((x + y) >> 5) + i * 53) & 255;
        }
      }
      const ref = context.register(context.flateStream(data, { Type: "XObject", Subtype: "Image", Width: width, Height: height, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
      const page = pageObjects[i % pages];
      page.node.setXObject(context.obj(`Im${i}`) as never, ref);
      page.node.addContentStream(context.register(context.flateStream(new TextEncoder().encode(`q 120 0 0 120 ${40 + (i % 4) * 130} ${600 - Math.floor(i / pages) * 130} cm /Im${i} Do Q\n`))));
    }
    return doc.save({ useObjectStreams: false });
  }

  it("20 paginas con 30 imagenes: < 2 s (con holgura en CI)", async () => {
    const bytes = await scaleDoc(20, 30, 96, 96);
    const warm = await openLegacy(bytes);
    await findImageAssets(warm.doc, { ops: warm.ops, bytes });
    await warm.close();
    const opened = await openLegacy(bytes);
    try {
      const t0 = performance.now();
      const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes });
      const ms = performance.now() - t0;
      console.info(`[extract-images] 20 paginas / 30 imagenes en Node: ${ms.toFixed(0)} ms`);
      expect(result.assets).toHaveLength(30);
      expect(result.warnings).toEqual([]);
      expect(ms).toBeLessThan(2000 * SLACK);
    } finally {
      await opened.close();
    }
  });

  it("memoria acotada: 3 imagenes de 12 MP no suben el RSS por encima de 400 MB y no dejan pixeles en el resultado", async () => {
    const bytes = await scaleDoc(3, 3, 4000, 3000);
    const opened = await openLegacy(bytes);
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes });
      expect(result.assets).toHaveLength(3);
      expect(result.assets.every((asset) => asset.pixel?.width === 4000 && asset.pixel.height === 3000)).toBe(true);
    } finally {
      clearInterval(sampler);
      await opened.close();
    }
    const growthMb = (peak - baseline) / 1048576;
    console.info(`[extract-images] 3 x 12 MP en Node: RSS +${growthMb.toFixed(0)} MB (pdf.js incluido, en el mismo proceso)`);
    expect(growthMb).toBeLessThan(400);
  });
});
