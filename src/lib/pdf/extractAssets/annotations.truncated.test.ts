import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { findAnnotationAssets } from "./annotations";
import { getLegacyOps, napiSurfaceFactory, withLegacyDocument } from "./__fixtures__/annots/nodeEnv";
import { EXTRACT_LIMITS } from "./types";

/** H10: mas de 300 anotaciones en una pagina se recortaban sin aviso (10 000 anotaciones daban 200 elementos y ningun aviso). */

async function pdfWithAnnotations(counts: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const count of counts) {
    const page = doc.addPage([612, 792]);
    const refs = [];
    for (let i = 0; i < count; i += 1) {
      refs.push(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Stamp", Rect: [10 + (i % 50) * 10, 10 + Math.floor(i / 50) * 10, 18 + (i % 50) * 10, 18 + Math.floor(i / 50) * 10], F: 4 })));
    }
    page.node.set(PDFName.of("Annots"), doc.context.obj(refs) as PDFArray);
  }
  return doc.save({ useObjectStreams: false });
}

async function warningsOf(bytes: Uint8Array) {
  return withLegacyDocument(bytes, async (doc) => (await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes })).warnings);
}

describe("too-many-annotations", () => {
  it("el tope por pagina esta en el contrato (300)", () => {
    expect(EXTRACT_LIMITS.maxAnnotationsPerPage).toBe(300);
  });
  it("301 anotaciones: aviso con la pagina y cuantas trae; 300 o menos: sin aviso", async () => {
    expect((await warningsOf(await pdfWithAnnotations([301]))).filter((w) => w.code === "too-many-annotations")).toEqual([{ code: "too-many-annotations", pageIndex: 0, detail: "301" }]);
    expect((await warningsOf(await pdfWithAnnotations([300]))).filter((w) => w.code === "too-many-annotations")).toEqual([]);
    expect((await warningsOf(await pdfWithAnnotations([5]))).filter((w) => w.code === "too-many-annotations")).toEqual([]);
  });
  it("cada pagina que se pasa avisa por separado, con su numero", async () => {
    const warnings = (await warningsOf(await pdfWithAnnotations([10, 350, 12, 420]))).filter((w) => w.code === "too-many-annotations");
    expect(warnings).toEqual([
      { code: "too-many-annotations", pageIndex: 1, detail: "350" },
      { code: "too-many-annotations", pageIndex: 3, detail: "420" },
    ]);
  });
});
