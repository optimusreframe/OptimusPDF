import { describe, expect, it } from "vitest";
import { findAnnotationAssets } from "./annotations";
import { makeBusyDocument } from "./__fixtures__/annots/generate";
import { evaluateRuns } from "./__fixtures__/annots/evaluate";
import { getLegacyOps, napiSurfaceFactory, withLegacyDocument } from "./__fixtures__/annots/nodeEnv";

/** El CI de GitHub es ~2,5 veces mas lento: los plazos absolutos llevan holgura. */
const SLACK = process.env.CI ? 2.5 : 1;

describe("rendimiento", () => {
  it("20 paginas con ~65 elementos se analizan por debajo de 6 s (Node, sin GPU) y no se pierde ninguno", async () => {
    const fixture = await makeBusyDocument(20);
    const ops = await getLegacyOps();
    const started = performance.now();
    const result = await withLegacyDocument(fixture.bytes, (doc) => findAnnotationAssets(doc, { ops, createSurface: napiSurfaceFactory, bytes: fixture.bytes }));
    const elapsed = performance.now() - started;
    console.info(`rendimiento: 20 paginas, ${result.assets.length} elementos en ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(6000 * SLACK);
    const evaluation = evaluateRuns([{ fixture, assets: result.assets, warnings: result.warnings }]);
    expect(evaluation.problems).toEqual([]);
    expect(result.assets).toHaveLength(20 + 20 + 4 + 1);
  });

  it("respeta el tope de elementos del contrato incluso con muchas anotaciones", async () => {
    const fixture = await makeBusyDocument(12);
    const ops = await getLegacyOps();
    const result = await withLegacyDocument(fixture.bytes, (doc) => findAnnotationAssets(doc, { ops, createSurface: napiSurfaceFactory, bytes: fixture.bytes, options: { maxAssets: 10 } }));
    expect(result.assets).toHaveLength(10);
    expect(result.warnings.some((w) => w.code === "too-many-assets")).toBe(true);
  });
});
