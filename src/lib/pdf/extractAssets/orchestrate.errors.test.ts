import { beforeAll, describe, expect, it, vi } from "vitest";
import { PdfError } from "@/lib/pdf/core";
import { makeOptimusOneSigner } from "./__fixtures__/classify/generate";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";

/** Fallos INESPERADOS de un motor entero (no de una pagina): el de anotaciones no tira las imagenes; el de imagenes si es un error. */

vi.mock("./annotations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./annotations")>();
  return { ...actual, findAnnotationAssets: vi.fn(actual.findAnnotationAssets) };
});
vi.mock("./images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./images")>();
  return { ...actual, findImageAssets: vi.fn(actual.findImageAssets) };
});

import { findAnnotationAssets } from "./annotations";
import { findImageAssets } from "./images";
import { extractWith } from "./orchestrate";
import { makeAsset } from "./classify.testUtils";
import { makeVectorSignatures } from "./__fixtures__/classify/generate";
import type { ExtractedAsset } from "./types";

let bytes: Uint8Array;
beforeAll(async () => {
  bytes = (await makeOptimusOneSigner()).bytes;
});

describe("orquestador · fallo de un motor completo", () => {
  it("si el motor de anotaciones lanza algo inesperado, las imagenes ya halladas se conservan y se avisa", async () => {
    vi.mocked(findAnnotationAssets).mockRejectedValueOnce(new Error("explota el motor de anotaciones con un mensaje muy largo ".repeat(10)));
    const result = await extractWith(nodeExtractEnv, bytes);
    expect(result.assets.map((asset) => asset.kind).sort()).toEqual(["initials", "signature"]);
    const warning = result.warnings.find((w) => w.code === "decode-failed");
    expect(warning?.detail?.startsWith("anotaciones: explota")).toBe(true);
    expect((warning?.detail ?? "").length).toBeLessThan(130);
  });

  it("una cancelacion del motor de anotaciones NO se toma por fallo: rechaza con PdfError cancelled", async () => {
    vi.mocked(findAnnotationAssets).mockRejectedValueOnce(new PdfError("cancelled"));
    await expect(extractWith(nodeExtractEnv, bytes)).rejects.toMatchObject({ name: "PdfError", code: "cancelled" });
  });

  it("si el motor de imagenes lanza algo inesperado es un error (PdfError), no un resultado vacio", async () => {
    vi.mocked(findImageAssets).mockRejectedValueOnce(new Error("explota el motor de imagenes"));
    await expect(extractWith(nodeExtractEnv, bytes)).rejects.toMatchObject({ name: "PdfError" });
  });

  it("un AbortError del motor de imagenes rechaza como cancelacion", async () => {
    const abort = new Error("abort");
    abort.name = "AbortError";
    vi.mocked(findImageAssets).mockRejectedValueOnce(abort);
    await expect(extractWith(nodeExtractEnv, bytes)).rejects.toMatchObject({ name: "PdfError", code: "cancelled" });
  });

  it("los motores reciben el rango, los topes, la senal, los bytes y la tabla OPS; las anotaciones NO se piden al motor de imagenes", async () => {
    const controller = new AbortController();
    await extractWith(nodeExtractEnv, bytes, { pageRange: { from: 1, to: 2 }, maxPages: 7, maxAssets: 9, signal: controller.signal });
    const imageCtx = vi.mocked(findImageAssets).mock.calls.at(-1)![1]!;
    const annotCtx = vi.mocked(findAnnotationAssets).mock.calls.at(-1)![1]!;
    for (const ctx of [imageCtx, annotCtx]) {
      expect(ctx.options?.pageRange).toEqual({ from: 1, to: 2 });
      expect(ctx.options?.maxPages).toBe(7);
      expect(ctx.options?.maxAssets).toBe(9);
      expect(ctx.options?.signal).toBe(controller.signal);
      expect(ctx.bytes).toBeInstanceOf(Uint8Array);
      expect(ctx.bytes?.byteLength).toBe(bytes.byteLength);
      expect(ctx.ops).toBeDefined();
    }
    expect(imageCtx.includeAnnotations).toBe(false);
    expect((annotCtx as { assetsAlreadyFound?: number }).assetsAlreadyFound).toBeGreaterThanOrEqual(0);
    expect((annotCtx as { createSurface?: unknown }).createSurface).toBeTypeOf("function");
  });
});

describe("orquestador · lo que sale de combinar motores", () => {
  const original = (name: "image" | "annot") => (name === "image" ? vi.mocked(findImageAssets) : vi.mocked(findAnnotationAssets));
  const fake = (count: number, over: Partial<ExtractedAsset> = {}): ExtractedAsset[] =>
    Array.from({ length: count }, (_, i) => makeAsset({ id: `x-${i}`, pages: [0], rect: { x: 0.01 + i * 0.1, y: 0.1, width: 0.05, height: 0.05 }, ...over }));

  it("el tope de elementos se aplica a la UNION de los motores y avisa una vez", async () => {
    vi.mocked(findImageAssets).mockResolvedValueOnce({ assets: fake(3, { id: "a" }), scannedPages: [], warnings: [] });
    vi.mocked(findAnnotationAssets).mockResolvedValueOnce({ assets: fake(3, { id: "b", kind: "stamp", source: "form" }).map((asset, i) => ({ ...asset, id: `b-${i}`, occurrences: [{ pageIndex: 0, rect: { x: 0.01 + i * 0.1, y: 0.5, width: 0.05, height: 0.05 } }] })), warnings: [] });
    const result = await extractWith(nodeExtractEnv, bytes, { maxAssets: 4 });
    expect(result.assets).toHaveLength(4);
    expect(result.warnings.filter((w) => w.code === "too-many-assets")).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("los ids repetidos entre motores se desambiguan (-2) y nunca se pierde un elemento", async () => {
    const one = fake(1, { id: "mismo" });
    const two = [makeAsset({ id: "mismo", kind: "stamp", source: "form", pages: [0], rect: { x: 0.5, y: 0.5, width: 0.05, height: 0.05 } })];
    vi.mocked(findImageAssets).mockResolvedValueOnce({ assets: one, scannedPages: [], warnings: [] });
    vi.mocked(findAnnotationAssets).mockResolvedValueOnce({ assets: two, warnings: [] });
    const result = await extractWith(nodeExtractEnv, bytes);
    expect(result.assets.map((asset) => asset.id).sort()).toEqual(["mismo", "mismo-2"]);
  });

  it("si el motor de anotaciones recibe lo hallado por el de imagenes (assetsAlreadyFound) para respetar el tope global", async () => {
    vi.mocked(findImageAssets).mockResolvedValueOnce({ assets: fake(5), scannedPages: [], warnings: [] });
    await extractWith(nodeExtractEnv, bytes);
    expect((vi.mocked(findAnnotationAssets).mock.calls.at(-1)![1] as { assetsAlreadyFound?: number }).assetsAlreadyFound).toBe(5);
  });

  it("el progreso nunca retrocede aunque un motor informe en desorden", async () => {
    const actual = await vi.importActual<typeof import("./images")>("./images");
    vi.mocked(findImageAssets).mockImplementationOnce(async (doc, ctx) => {
      ctx?.options?.onProgress?.({ pageIndex: 2, pageCount: 3, assetsSoFar: 2 });
      ctx?.options?.onProgress?.({ pageIndex: 0, pageCount: 3, assetsSoFar: 1 });
      return actual.findImageAssets(doc, ctx);
    });
    const seen: Array<{ pageIndex: number; assetsSoFar: number }> = [];
    await extractWith(nodeExtractEnv, bytes, { onProgress: (progress) => seen.push(progress) });
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i].pageIndex).toBeGreaterThanOrEqual(seen[i - 1].pageIndex);
      expect(seen[i].assetsSoFar).toBeGreaterThanOrEqual(seen[i - 1].assetsSoFar);
    }
  });

  it("cancelar durante el motor de imagenes corta ANTES de lanzar el de anotaciones", async () => {
    const actual = await vi.importActual<typeof import("./images")>("./images");
    const controller = new AbortController();
    vi.mocked(findImageAssets).mockImplementationOnce(async (doc, ctx) => {
      const result = await actual.findImageAssets(doc, ctx);
      controller.abort();
      return result;
    });
    const calls = vi.mocked(findAnnotationAssets).mock.calls.length;
    await expect(extractWith(nodeExtractEnv, bytes, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(vi.mocked(findAnnotationAssets).mock.calls.length).toBe(calls);
  });

  it("una firma vectorial que cae DENTRO de un sello ya hallado no se ofrece; fuera de el si", async () => {
    const vectorBytes = (await makeVectorSignatures()).bytes;
    const plain = await extractWith(nodeExtractEnv, vectorBytes);
    const vector = plain.assets.find((asset) => asset.source === "vector" && asset.occurrences[0].pageIndex === 0)!;
    expect(vector).toBeDefined();
    const rect = vector.occurrences[0].rect;
    const stamp = makeAsset({ id: "sello", kind: "stamp", source: "form", pages: [0], rect: { x: rect.x - 0.05, y: rect.y - 0.05, width: rect.width + 0.1, height: rect.height + 0.1 } });
    const real = await vi.importActual<typeof import("./annotations")>("./annotations");
    vi.mocked(findAnnotationAssets).mockImplementationOnce(async (doc, ctx) => {
      const result = await real.findAnnotationAssets(doc, ctx);
      return { ...result, assets: [...result.assets, stamp] };
    });
    const covered = await extractWith(nodeExtractEnv, vectorBytes);
    expect(covered.assets.some((asset) => asset.source === "vector" && asset.occurrences[0].pageIndex === 0)).toBe(false);
    expect(covered.assets.some((asset) => asset.id === "sello")).toBe(true);
    expect(covered.assets.filter((asset) => asset.source === "vector").length).toBe(plain.assets.filter((asset) => asset.source === "vector").length - 1);
    // Un sello en otro lado no la oculta.
    const far = makeAsset({ id: "lejos", kind: "stamp", source: "form", pages: [0], rect: { x: 0.8, y: 0.05, width: 0.1, height: 0.1 } });
    vi.mocked(findAnnotationAssets).mockImplementationOnce(async (doc, ctx) => {
      const result = await real.findAnnotationAssets(doc, ctx);
      return { ...result, assets: [...result.assets, far] };
    });
    expect((await extractWith(nodeExtractEnv, vectorBytes)).assets.filter((asset) => asset.source === "vector")).toHaveLength(plain.assets.filter((asset) => asset.source === "vector").length);
    expect(original).toBeTypeOf("function");
  });
});
