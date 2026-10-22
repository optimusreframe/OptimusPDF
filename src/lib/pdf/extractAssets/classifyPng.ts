/**
 * Lector minimo de PNG para las miniaturas de los motores (siempre PNG de 8 bits que escribe `encodePngBytes` / `encodeInkPng`).
 * Sirve para que el clasificador mire PIXELES sin depender de un canvas (corre igual en el navegador, en un worker y en Node): solo
 * usa `DecompressionStream`, que traen los navegadores actuales y Node 18+. Acepta tipos de color 0, 2, 3, 4 y 6 de 8 bits, sin
 * entrelazado; cualquier otra cosa devuelve `null` (el clasificador sigue sin pixeles, solo con geometria y texto).
 */

import type { RasterRGBA } from "./classifyTypes";

/** Pixeles maximos que se leen (una miniatura mide como mucho 256 x 256). */
const MAX_PIXELS = 4_000_000;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Deshace los filtros por fila de PNG (modifica `raw` y devuelve los pixeles sin el byte de filtro). */
function unfilter(raw: Uint8Array, stride: number, height: number, bpp: number): Uint8Array | null {
  if (raw.length < (stride + 1) * height) return null;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prior = dst - stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = y > 0 ? out[prior + i] : 0;
      const upLeft = y > 0 && i >= bpp ? out[prior + i - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else if (filter !== 0) return null;
      out[dst + i] = (raw[src + i] + predicted) & 0xff;
    }
  }
  return out;
}

/** Decodifica un PNG (`Blob`) a RGBA. `null` si no es un PNG de los que se saben leer. */
export async function decodePngThumb(blob: Blob): Promise<RasterRGBA | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 33 || SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = -1;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let transparency: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const start = offset + 8;
      if (start + length > bytes.length) return null;
      if (type === "IHDR") {
        width = view.getUint32(start);
        height = view.getUint32(start + 4);
        depth = bytes[start + 8];
        colorType = bytes[start + 9];
        interlace = bytes[start + 12];
      } else if (type === "PLTE") palette = bytes.subarray(start, start + length);
      else if (type === "tRNS") transparency = bytes.subarray(start, start + length);
      else if (type === "IDAT") idat.push(bytes.subarray(start, start + length));
      else if (type === "IEND") break;
      offset = start + length + 4;
    }
    const channels = CHANNELS[colorType];
    if (!channels || depth !== 8 || interlace !== 0 || width < 1 || height < 1 || width * height > MAX_PIXELS || idat.length === 0) return null;
    if (colorType === 3 && !palette) return null;
    const total = idat.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of idat) {
      joined.set(part, at);
      at += part.length;
    }
    const raw = await inflate(joined);
    const pixels = unfilter(raw, width * channels, height, channels);
    if (!pixels) return null;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      const p = i * channels;
      const o = i * 4;
      if (colorType === 6) {
        data[o] = pixels[p];
        data[o + 1] = pixels[p + 1];
        data[o + 2] = pixels[p + 2];
        data[o + 3] = pixels[p + 3];
      } else if (colorType === 2) {
        data[o] = pixels[p];
        data[o + 1] = pixels[p + 1];
        data[o + 2] = pixels[p + 2];
        data[o + 3] = 255;
      } else if (colorType === 0) {
        data[o] = data[o + 1] = data[o + 2] = pixels[p];
        data[o + 3] = 255;
      } else if (colorType === 4) {
        data[o] = data[o + 1] = data[o + 2] = pixels[p];
        data[o + 3] = pixels[p + 1];
      } else {
        const index = pixels[p];
        data[o] = palette?.[index * 3] ?? 0;
        data[o + 1] = palette?.[index * 3 + 1] ?? 0;
        data[o + 2] = palette?.[index * 3 + 2] ?? 0;
        data[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
    return { width, height, data };
  } catch {
    return null;
  }
}
