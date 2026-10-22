/** Ayudas de las pruebas del clasificador (solo pruebas): elementos, hechos de pagina y caracteristicas de pixeles fabricados a mano. */

import { encodePngBytes } from "@/lib/image/inkPng";
import type { Geometry } from "./classifyRules";
import type { LabelFact, PageFacts, PixelFeatures, TextLine, VectorCandidate } from "./classifyTypes";
import type { AssetOccurrence, ExtractedAsset, NormRect } from "./types";

/** Caracteristicas de una firma tipica: tinta fina azul sobre fondo transparente. */
export function inkFeatures(over: Partial<PixelFeatures> = {}): PixelFeatures {
  return {
    width: 256,
    height: 77,
    transparent: 0.88,
    hasAlpha: true,
    lightBackground: true,
    inkFraction: 0.1,
    inkLuma: 42,
    inkSaturation: 0.8,
    darkShare: 0.1,
    blueShare: 0.9,
    dominantHueShare: 1,
    dominantHue: 225,
    chromaticShare: 1,
    colorBins: 1,
    solidity: 0.35,
    ringShare: 0.3,
    centerShare: 0.25,
    frameShare: 0.25,
    fullSpanShare: 0,
    inkBox: { x: 0.02, y: 0.1, width: 0.95, height: 0.8 },
    meanAlpha: 0.9,
    ...over,
  };
}

/** Geometria de una firma tipica: 30 % de ancho, 7 % de alto, una sola pagina. */
export function signatureGeometry(over: Partial<Geometry> = {}): Geometry {
  return {
    aspect: 3.3,
    heightFrac: 0.07,
    areaFrac: 0.021,
    widthFrac: 0.3,
    widthPt: 183.6,
    heightPt: 55,
    repeatPages: 1,
    band: null,
    firstPageTop: false,
    pages: 1,
    ...over,
  };
}

export function label(kind: LabelFact["kind"], over: Partial<LabelFact> = {}): LabelFact {
  return { kind, strength: 1, text: kind === "signature" ? "Firma" : "Iniciales", box: { x: 72, y: 700, width: 60, height: 10 }, lineHeight: 12, ...over };
}

export function line(text: string, x: number, y: number, width = 80, height = 10): TextLine {
  return { text, x, y, width, height };
}

export function page(pageIndex: number, lines: TextLine[] = [], over: Partial<PageFacts> = {}): PageFacts {
  return { pageIndex, width: 612, height: 792, lines, chars: lines.reduce((sum, l) => sum + l.text.length, 0), ...over };
}

let counter = 0;
export function makeAsset(over: Partial<ExtractedAsset> & { rect?: NormRect; pages?: number[] } = {}): ExtractedAsset {
  const { rect, pages, ...rest } = over;
  counter += 1;
  const box = rect ?? { x: 0.1, y: 0.8, width: 0.3, height: 0.07 };
  const occurrences: AssetOccurrence[] = (pages ?? [0]).map((pageIndex) => ({ pageIndex, rect: box }));
  return {
    id: `img-${counter}`,
    kind: "image",
    confidence: 1,
    reasons: [],
    source: "xobject",
    occurrences,
    pixel: { width: 300, height: 90, hasAlpha: true },
    formats: ["png"],
    bytesEstimate: 1000,
    thumb: null,
    ref: { engine: "image", objectId: `xobject:1:0:${counter}R`, pageIndex: (pages ?? [0])[0] },
    ...rest,
  };
}

export async function pngBlobOf(raster: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): Promise<Blob> {
  return new Blob([(await encodePngBytes({ width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.data) })) as unknown as BlobPart], { type: "image/png" });
}

export function vectorCandidate(over: Partial<VectorCandidate> = {}): VectorCandidate {
  const bbox = over.bbox ?? { x: 150, y: 600, width: 140, height: 40 };
  return {
    pageIndex: 0,
    bbox,
    rect: { x: bbox.x / 612, y: bbox.y / 792, width: bbox.width / 612, height: bbox.height / 792 },
    curves: 40,
    segments: 40,
    strokes: 2,
    shapeShare: 0,
    xReversals: 6,
    yReversals: 8,
    axisAligned: 0,
    strokeWidth: 1.6,
    color: "#142980",
    paths: [],
    ...over,
  };
}
