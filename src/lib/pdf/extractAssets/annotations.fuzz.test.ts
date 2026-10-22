import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { randomDocument } from "./__fixtures__/annots/fuzz";
import { runOn } from "./__fixtures__/annots/testKit";
import { EXTRACT_LIMITS, type ExtractedAsset } from "./types";

/**
 * Pruebas de robustez con anotaciones GENERADAS AL AZAR (semilla fija: reproducibles) y deliberadamente rotas: tipos equivocados,
 * numeros enormes o negativos, listas cortas, cajas invertidas, referencias a si mismas. El motor no debe lanzar, no debe colgarse y
 * todo lo que devuelva debe cumplir el contrato.
 */

function checkContract(asset: ExtractedAsset, label: string): void {
  expect(asset.confidence, label).toBeGreaterThanOrEqual(0);
  expect(asset.confidence, label).toBeLessThanOrEqual(1);
  expect(asset.occurrences.length, label).toBeGreaterThan(0);
  for (const o of asset.occurrences) {
    for (const v of [o.rect.x, o.rect.y, o.rect.width, o.rect.height]) expect(Number.isFinite(v), label).toBe(true);
    expect(o.rect.x + o.rect.width, label).toBeLessThanOrEqual(1.001);
  }
  if (asset.pixel) expect(asset.pixel.width * asset.pixel.height, label).toBeLessThan(EXTRACT_LIMITS.maxImageMegapixels * 1_000_000);
}

describe("anotaciones rotas al azar", () => {
  it("40 documentos con basura en todas las claves: el motor no lanza, no se cuelga y cumple el contrato", async () => {
    let assets = 0;
    let timedOut = 0;
    // Con datos rotos, pdf.js (en Node, su «worker» de pega) puede dejar una promesa SIN resolver y soltar un DataCloneError que nadie
    // recoge: es un defecto de pdf.js, no del motor. Aqui se recoge para que no tumbe la prueba; lo que se exige es que el MOTOR no se
    // cuelgue (plazo por paso) ni lance.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let seed = 1; seed <= 40; seed += 1) {
        const bytes = await randomDocument(seed);
        let result;
        try {
          result = await runOn({ bytes }, { stepTimeoutMs: 700 });
        } catch (error) {
          throw new Error(`semilla ${seed}: ${(error as Error).stack}`);
        }
        timedOut += result.warnings.filter((w) => w.detail?.includes("tiempo agotado")).length;
        assets += result.assets.length;
        expect(result.assets.length, `semilla ${seed}`).toBeLessThanOrEqual(EXTRACT_LIMITS.maxAssets);
        for (const asset of result.assets) checkContract(asset, `semilla ${seed}`);
        for (const warning of result.warnings) expect(["decode-failed", "digital-signature", "too-many-assets", "too-many-pages"]).toContain(warning.code);
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // El generador produce Ink validas de vez en cuando: el motor no es tan estricto que descarte todo.
    expect(assets).toBeGreaterThan(5);
    expect(unhandled.every((reason) => (reason as Error)?.name === "DataCloneError")).toBe(true);
    console.info(`fuzz: 40 documentos, ${assets} elementos, ${timedOut} pasos con plazo agotado, ${unhandled.length} DataCloneError de pdf.js recogidos`);
  });

  it("una Ink con muchisimos puntos y coordenadas gigantes se acota sin agotar memoria", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const points = Array.from({ length: 200_000 }, (_, i) => (i % 2 === 0 ? i % 600 : 700 - (i % 400)));
    const huge = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 612, 792], InkList: [points], C: [0, 0, 0], BS: { W: 1e6 } } as never));
    const far = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 1e9, 1e9], InkList: [[0, 0, 1e9, 1e9, 5e8, 1e8]], C: [0, 0, 0] } as never));
    page.node.set(PDFName.of("Annots"), doc.context.obj([huge, far] as never));
    const started = performance.now();
    const result = await runOn({ bytes: await doc.save() });
    expect(performance.now() - started).toBeLessThan(15_000 * (process.env.CI ? 2.5 : 1));
    for (const asset of result.assets) checkContract(asset, "ink enorme");
  });
});
