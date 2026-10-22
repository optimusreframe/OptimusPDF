import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePngBytes, pngCrc32 } from "@/lib/image/inkPng";
import { decodePngThumb } from "./classifyPng";
import { blank, inkSignatureRaster, photoRaster } from "./__fixtures__/classify/rasters";

/** Lector de miniaturas PNG del clasificador: lo que escribe `encodePngBytes` (RGBA, 5 filtros) y los otros tipos de color de 8 bits. */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** PNG hecho a mano con el tipo de color pedido y filtros por fila (0..4 rotando). */
function manualPng(width: number, height: number, colorType: number, pixels: number[], options: { depth?: number; interlace?: number; palette?: number[]; trns?: number[]; filters?: boolean } = {}): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] as number;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const filter = options.filters ? y % 5 : 0;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const value = pixels[y * stride + i];
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      raw[y * (stride + 1) + 1 + i] = (value - predicted) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = options.depth ?? 8;
  header[9] = colorType;
  header[12] = options.interlace ?? 0;
  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", header)];
  if (options.palette) parts.push(chunk("PLTE", new Uint8Array(options.palette)));
  if (options.trns) parts.push(chunk("tRNS", new Uint8Array(options.trns)));
  parts.push(chunk("IDAT", new Uint8Array(zlib.deflateSync(raw))), chunk("IEND", new Uint8Array(0)));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const blob = (bytes: Uint8Array): Blob => new Blob([bytes as unknown as BlobPart], { type: "image/png" });

describe("decodePngThumb", () => {
  it("lee exactamente los pixeles que escribe encodePngBytes (RGBA con alfa y 5 filtros)", async () => {
    for (const raster of [inkSignatureRaster({ seed: 1 }), photoRaster({ seed: 2, width: 64, height: 48 }), blank(7, 5, [10, 20, 30, 40])]) {
      const decoded = await decodePngThumb(blob(await encodePngBytes(raster)));
      expect(decoded).not.toBeNull();
      expect(decoded?.width).toBe(raster.width);
      expect(decoded?.height).toBe(raster.height);
      expect(Array.from(decoded?.data ?? [])).toEqual(Array.from(raster.data));
    }
  });

  it("aplica los cinco filtros por fila (ninguno, izquierda, arriba, media y Paeth)", async () => {
    const width = 6;
    const height = 10;
    const pixels = Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + Math.floor(i / 7) * 11) % 256);
    const decoded = await decodePngThumb(blob(manualPng(width, height, 6, pixels, { filters: true })));
    expect(Array.from(decoded?.data ?? [])).toEqual(pixels);
  });

  it("lee RGB (alfa 255), gris, gris con alfa y paleta con tRNS", async () => {
    const rgb = await decodePngThumb(blob(manualPng(2, 1, 2, [1, 2, 3, 4, 5, 6])));
    expect(Array.from(rgb?.data ?? [])).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    const gray = await decodePngThumb(blob(manualPng(2, 1, 0, [9, 200])));
    expect(Array.from(gray?.data ?? [])).toEqual([9, 9, 9, 255, 200, 200, 200, 255]);
    const grayAlpha = await decodePngThumb(blob(manualPng(2, 1, 4, [9, 30, 200, 255])));
    expect(Array.from(grayAlpha?.data ?? [])).toEqual([9, 9, 9, 30, 200, 200, 200, 255]);
    const palette = await decodePngThumb(blob(manualPng(3, 1, 3, [0, 1, 2], { palette: [255, 0, 0, 0, 255, 0, 0, 0, 255], trns: [128] })));
    expect(Array.from(palette?.data ?? [])).toEqual([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255]);
  });

  it("devuelve null con lo que no sabe leer: no PNG, truncado, 16 bits, entrelazado, sin IDAT, paleta sin PLTE", async () => {
    expect(await decodePngThumb(blob(new Uint8Array([1, 2, 3])))).toBeNull();
    expect(await decodePngThumb(blob(new Uint8Array(64)))).toBeNull();
    const good = await encodePngBytes(blank(4, 4, [1, 2, 3, 255]));
    expect(await decodePngThumb(blob(good.subarray(0, good.length - 30)))).toBeNull();
    expect(await decodePngThumb(blob(manualPng(1, 1, 2, [1, 2, 3], { depth: 16 })))).toBeNull();
    expect(await decodePngThumb(blob(manualPng(1, 1, 2, [1, 2, 3], { interlace: 1 })))).toBeNull();
    expect(await decodePngThumb(blob(manualPng(1, 1, 3, [0])))).toBeNull();
    const noIdat = new Uint8Array([...SIGNATURE, ...chunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])), ...chunk("IEND", new Uint8Array(0))]);
    expect(await decodePngThumb(blob(noIdat))).toBeNull();
  });

  it("rechaza una imagen de mas de 4 millones de pixeles sin descomprimirla", async () => {
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, 3000);
    new DataView(header.buffer).setUint32(4, 3000);
    header[8] = 8;
    header[9] = 6;
    const big = new Uint8Array([...SIGNATURE, ...chunk("IHDR", header), ...chunk("IDAT", new Uint8Array([0x78, 0x9c, 3, 0, 0, 0, 0, 1])), ...chunk("IEND", new Uint8Array(0))]);
    expect(await decodePngThumb(blob(big))).toBeNull();
  });

  it("un filtro desconocido invalida la imagen", async () => {
    const raw = zlib.deflateSync(new Uint8Array([9, 1, 2, 3, 255]));
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, 1);
    new DataView(header.buffer).setUint32(4, 1);
    header[8] = 8;
    header[9] = 6;
    const bad = new Uint8Array([...SIGNATURE, ...chunk("IHDR", header), ...chunk("IDAT", new Uint8Array(raw)), ...chunk("IEND", new Uint8Array(0))]);
    expect(await decodePngThumb(blob(bad))).toBeNull();
  });
});
