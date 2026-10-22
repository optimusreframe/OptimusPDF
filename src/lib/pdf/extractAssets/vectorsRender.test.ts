import { beforeAll, describe, expect, it } from "vitest";
import { getLegacyOps, decodePng, napiSurfaceFactory, withLegacyDocument } from "./__fixtures__/annots/nodeEnv";
import { makeVectorSignatures } from "./__fixtures__/classify/generate";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";
import { buildVectorAsset, buildVectorSvg, drawVectorCandidate, renderVectorAsset } from "./vectorsRender";
import { extractWith } from "./orchestrate";
import { vectorCandidate } from "./classify.testUtils";
import type { VectorPath } from "./classifyTypes";
import type { ExtractedAsset } from "./types";

/** Dibujo de las firmas vectoriales: SVG, PNG a 4x solo con los trazos y regeneracion bajo demanda desde la pagina. */

const stroke = (commands: VectorPath["commands"], over: Partial<VectorPath> = {}): VectorPath => ({ commands, stroke: true, fill: false, color: "#142980", lineWidth: 1.6, ...over });
const wave: VectorPath["commands"] = [["M", 100, 100], ["C", 110, 80, 130, 80, 140, 100], ["C", 150, 120, 170, 120, 180, 100]];

function candidate(paths: VectorPath[]) {
  return vectorCandidate({ bbox: { x: 100, y: 84, width: 80, height: 32 }, rect: { x: 100 / 612, y: 84 / 792, width: 80 / 612, height: 32 / 792 }, paths, curves: 2, segments: 2 });
}

describe("buildVectorSvg", () => {
  it("un <path> por ruta con color, grosor y extremos redondos, en coordenadas relativas a la caja con margen", () => {
    const svg = buildVectorSvg(candidate([stroke(wave)]));
    expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    expect(svg).toContain('stroke="#142980"');
    expect(svg).toContain('stroke-width="1.6"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke-linecap="round"');
    // Caja de 80 x 32 mas un margen de 1,5 x el grosor (2,4 pt) a cada lado: 84,8 x 36,8; el primer punto (100, 100) cae en (2,4; 18,4).
    expect(svg).toContain('viewBox="0 0 84.8 36.8"');
    expect(svg).toContain('d="M2.4 18.4C12.4 -1.6');
  });
  it("una ruta rellena usa fill y no stroke; el cierre es Z", () => {
    const svg = buildVectorSvg(candidate([stroke([["M", 100, 100], ["L", 110, 90], ["L", 120, 100], ["Z"]], { stroke: false, fill: true, color: "#0a0a14", lineWidth: 0 })]));
    expect(svg).toContain('fill="#0a0a14" stroke="none"');
    expect(svg).toContain("Z");
    expect(svg).toContain("L12.4 8.4");
  });
  it("un grosor diminuto no baja de 0,3 pt", () => {
    expect(buildVectorSvg(candidate([stroke(wave, { lineWidth: 0.01 })]))).toContain('stroke-width="0.3"');
  });
  it("sin rutas: un <svg> vacio y valido", () => {
    expect(buildVectorSvg(candidate([]))).toMatch(/<svg [^>]*><\/svg>$/);
  });
});

describe("drawVectorCandidate", () => {
  it("dibuja a 4x con fondo transparente y recorta a lo pintado: solo hay tinta de la firma", () => {
    const image = drawVectorCandidate(candidate([stroke(wave)]), napiSurfaceFactory);
    expect(image).not.toBeNull();
    // Una onda de 80 x ~10 pt a 4x: unos 320 px de ancho (menos por el recorte).
    expect(image!.width).toBeGreaterThan(280);
    expect(image!.width).toBeLessThan(340);
    let ink = 0;
    let opaqueBackground = 0;
    for (let i = 0; i < image!.data.length; i += 4) {
      if (image!.data[i + 3] > 200) {
        ink += 1;
        expect(image!.data[i + 2]).toBeGreaterThan(image!.data[i]); // azul
      }
      if (image!.data[i + 3] === 255 && image!.data[i] > 240 && image!.data[i + 1] > 240) opaqueBackground += 1;
    }
    expect(ink).toBeGreaterThan(200);
    expect(opaqueBackground).toBe(0);
    expect(image!.data[3]).toBe(0); // la esquina esta vacia
  });
  it("una ruta rellena se rellena (no es solo contorno)", () => {
    const filled = stroke([["M", 100, 90], ["L", 140, 90], ["L", 140, 110], ["L", 100, 110], ["Z"]], { stroke: false, fill: true, color: "#101010", lineWidth: 0 });
    const image = drawVectorCandidate(candidate([filled]), napiSurfaceFactory)!;
    const center = ((image.height >> 1) * image.width + (image.width >> 1)) * 4;
    expect(image.data[center + 3]).toBe(255);
    expect(image.data[center]).toBeLessThan(40);
  });
  it("sin trazos devuelve null y cierra la superficie", () => {
    let released = 0;
    const factory: typeof napiSurfaceFactory = (w, h) => {
      const surface = napiSurfaceFactory(w, h);
      return { ...surface, release: () => void (released += 1) };
    };
    expect(drawVectorCandidate(candidate([]), factory)).toBeNull();
    expect(released).toBe(1);
  });
  it("el grosor dibujado nunca baja de 1,5 px (un trazo de 0,1 pt sigue viendose)", () => {
    const thin = drawVectorCandidate(candidate([stroke(wave, { lineWidth: 0.05 })]), napiSurfaceFactory)!;
    let ink = 0;
    for (let i = 3; i < thin.data.length; i += 4) if (thin.data[i] > 100) ink += 1;
    expect(ink).toBeGreaterThan(300);
  });
});

describe("buildVectorAsset y renderVectorAsset", () => {
  let ops: Awaited<ReturnType<typeof getLegacyOps>>;
  let vectorAssets: ExtractedAsset[] = [];
  let bytes: Uint8Array;
  beforeAll(async () => {
    ops = await getLegacyOps();
    bytes = (await makeVectorSignatures()).bytes;
    vectorAssets = (await extractWith(nodeExtractEnv, bytes)).assets.filter((asset) => asset.source === "vector");
  });

  it("el elemento del contrato: kind, formatos png y svg, miniatura PNG, pixel con alfa, referencia por pagina y caja", async () => {
    expect(vectorAssets.length).toBeGreaterThanOrEqual(3);
    for (const asset of vectorAssets) {
      expect(["signature", "initials"]).toContain(asset.kind);
      expect(asset.formats).toEqual(["png", "svg"]);
      expect(asset.source).toBe("vector");
      expect(asset.ref.engine).toBe("vector");
      expect(asset.pixel?.hasAlpha).toBe(true);
      expect(asset.pixel?.width).toBeGreaterThan(40);
      expect(asset.confidence).toBeLessThanOrEqual(0.7);
      expect(asset.reasons[0]).toContain("beta");
      expect(asset.thumb?.type).toBe("image/png");
      expect(Math.max(...(await Promise.all([asset.thumb!.arrayBuffer()]).then(([b]) => [b.byteLength])))).toBeGreaterThan(100);
      expect(asset.bytesEstimate).toBeGreaterThan(0);
      expect(asset.occurrences).toHaveLength(1);
    }
    expect(new Set(vectorAssets.map((a) => a.id)).size).toBe(vectorAssets.length);
    expect(vectorAssets[0].id).toMatch(/^vec-[0-9a-f]{8}$/);
  });

  it("buildVectorAsset devuelve null si el grupo no pinta nada", async () => {
    const accepted = { candidate: candidate([]), kind: "signature" as const, confidence: 0.6, reasons: ["x"] };
    expect(await buildVectorAsset(accepted, napiSurfaceFactory)).toBeNull();
  });

  it("regenera PNG (transparente, con tinta) y SVG desde la pagina y coincide con lo que se vio", async () => {
    await withLegacyDocument(bytes, async (doc) => {
      for (const asset of vectorAssets) {
        const png = await renderVectorAsset(doc, asset, "png", { ops, createSurface: napiSurfaceFactory });
        expect(png.type).toBe("image/png");
        const raster = await decodePng(png);
        let ink = 0;
        for (let i = 3; i < raster.data.length; i += 4) if (raster.data[i] > 128) ink += 1;
        expect(ink / (raster.width * raster.height)).toBeGreaterThan(0.02);
        expect(ink / (raster.width * raster.height)).toBeLessThan(0.6);
        expect(raster.data[3]).toBe(0);
        expect(raster.width).toBe(asset.pixel?.width);
        const svg = await (await renderVectorAsset(doc, asset, "svg", { ops })).text();
        expect(svg).toContain("<svg");
        expect(svg).toContain("<path");
      }
    });
  });

  it("errores claros: formato no ofrecido, pagina inexistente, caja que ya no esta, tipo de elemento ajeno", async () => {
    const asset = vectorAssets[0];
    await withLegacyDocument(bytes, async (doc) => {
      // Una caja que solo solapa un poco con la firma (IoU < 0,5) ya no es ella.
      const ref = asset.ref as { engine: "vector"; pageIndex: number; rect: { x: number; y: number; width: number; height: number } };
      const shifted = { ...ref.rect, x: ref.rect.x + ref.rect.width * 0.6 };
      await expect(renderVectorAsset(doc, { ...asset, ref: { ...ref, rect: shifted } }, "png", { ops })).rejects.toMatchObject({ code: "not-found" });
      const nearly = { ...ref.rect, x: ref.rect.x + ref.rect.width * 0.1 };
      expect((await renderVectorAsset(doc, { ...asset, ref: { ...ref, rect: nearly } }, "png", { ops, createSurface: napiSurfaceFactory })).type).toBe("image/png");
      await expect(renderVectorAsset(doc, asset, "txt", { ops })).rejects.toMatchObject({ code: "unsupported-format" });
      await expect(renderVectorAsset(doc, { ...asset, ref: { engine: "vector", pageIndex: 99, rect: { x: 0, y: 0, width: 1, height: 1 } } }, "png", { ops })).rejects.toMatchObject({ code: "not-found" });
      await expect(renderVectorAsset(doc, { ...asset, ref: { engine: "vector", pageIndex: asset.ref.engine === "vector" ? asset.ref.pageIndex : 0, rect: { x: 0.9, y: 0.01, width: 0.05, height: 0.02 } } }, "png", { ops })).rejects.toMatchObject({ code: "not-found" });
      await expect(renderVectorAsset(doc, { ...asset, source: "form" }, "png", { ops })).rejects.toMatchObject({ code: "not-found" });
      await expect(renderVectorAsset(doc, { ...asset, ref: { engine: "text", text: "x" } }, "png", { ops })).rejects.toMatchObject({ code: "not-found" });
    });
  });
});
