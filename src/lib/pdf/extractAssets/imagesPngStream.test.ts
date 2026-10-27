import { describe, expect, it } from "vitest";
import { loadImage } from "@napi-rs/canvas";
import { encodePngStream, hasStreamingPng } from "./imagesPngStream";
import { ReducedSource, Slicer } from "./imagesPixels";
import { decodePng } from "./images.testUtils";

/** PNG por bandas de una fuente enorme (H11): los pixeles salen iguales y no se necesita la imagen entera en memoria. */

function source(width: number, height: number, alpha = false): ReducedSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      data[o] = (x * 3 + y) & 0xff;
      data[o + 1] = (x ^ (y * 5)) & 0xff;
      data[o + 2] = (x + y * 7) & 0xff;
      data[o + 3] = alpha ? (x * 2 + y) & 0xff : 255;
    }
  }
  return new ReducedSource(width, height, data);
}

describe("encodePngStream", () => {
  it("existe CompressionStream (Node 18+ y los navegadores actuales)", () => {
    expect(hasStreamingPng()).toBe(true);
  });
  it.each([
    [37, 29, false],
    [300, 600, false],
    [64, 64, true],
  ])("%i x %i (alfa %s): los pixeles salen exactos, en una sola banda y en varias", async (width, height, alpha) => {
    const src = source(width, height, alpha);
    const blob = await encodePngStream(src, new Slicer());
    expect(blob.type).toBe("image/png");
    const decoded = decodePng(new Uint8Array(await blob.arrayBuffer()));
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    const expected = src.rows(0, height);
    for (let i = 0; i < expected.length; i += 1) if (decoded.data[i] !== expected[i]) throw new Error(`pixel distinto en ${i}: ${decoded.data[i]} != ${expected[i]}`);
    const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
    expect([image.width, image.height]).toEqual([width, height]);
  });
  it("cancelar rechaza con AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(encodePngStream(source(50, 50), new Slicer(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
  });
});
