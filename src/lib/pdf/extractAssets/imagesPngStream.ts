/**
 * PNG RGBA de una fuente ENORME (decenas de megapixeles) codificado en STREAMING: cada banda de filas se filtra (filtro «Sub», barato)
 * y entra por trozos en `CompressionStream("deflate")`; la salida comprimida se va guardando como chunks `IDAT` y el PNG se ensambla como
 * un `Blob` de partes (sin concatenar). Memoria = una banda + el PNG comprimido: una foto de 40 MP no necesita sus 160 MB de RGBA, ni la
 * copia filtrada, ni las cinco pruebas de filtro por fila del codificador de firmas (`encodePngBytes`, pensado para imagenes pequenas).
 */

import { pngCrc32 } from "@/lib/image/inkPng";
import type { PixelSource, Slicer } from "./imagesPixels";

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Pixeles por banda (unos 2 MB de RGBA). */
const BAND_PIXELS = 500_000;

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function hasStreamingPng(): boolean {
  return typeof CompressionStream === "function" && typeof Blob === "function";
}

/** PNG (`Blob`) de toda la fuente, por bandas. Rechaza con `AbortError` si se cancela (`slicer`). */
export async function encodePngStream(source: PixelSource, slicer: Slicer): Promise<Blob> {
  const { width, height } = source;
  const stride = width * 4;
  const bandRows = Math.max(1, Math.floor(BAND_PIXELS / width));
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const idat: Uint8Array[] = [];
  const collect = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      idat.push(pngChunk("IDAT", value as Uint8Array));
    }
  })();
  collect.catch(() => undefined);
  try {
    for (let y0 = 0; y0 < height; y0 += bandRows) {
      await slicer.tick();
      const y1 = Math.min(height, y0 + bandRows);
      const rows = source.rows(y0, y1);
      const filtered = new Uint8Array((y1 - y0) * (stride + 1) + 0) as Uint8Array<ArrayBuffer>;
      let o = 0;
      for (let r = 0; r < y1 - y0; r += 1) {
        const row = r * stride;
        filtered[o++] = 1; // «Sub»: cada byte menos el del pixel de la izquierda
        for (let i = 0; i < stride; i += 1) filtered[o++] = (rows[row + i] - (i >= 4 ? rows[row + i - 4] : 0)) & 0xff;
      }
      await writer.write(filtered);
    }
    await writer.close();
    await collect;
  } catch (error) {
    writer.abort().catch(() => undefined);
    reader.cancel().catch(() => undefined);
    throw error;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  return new Blob([SIGNATURE, pngChunk("IHDR", header), ...idat, pngChunk("IEND", new Uint8Array(0))] as unknown as BlobPart[], { type: "image/png" });
}
