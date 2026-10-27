/**
 * Version REDUCIDA de una imagen sin comprimir con `/FlateDecode` (RGB o gris de 8 bits, con o sin predictor PNG), leida en STREAMING: el
 * flujo se descomprime por trozos (`DecompressionStream`), cada fila se desfiltra y se promedia directamente en la rejilla de salida
 * (<= 1024 px). Nunca se tiene la imagen entera: una foto de 40 MP (120 MB sin comprimir) cuesta unos KB de memoria, frente a los ~280 MB
 * que pide pdf.js para decodificarla. Es lo que usa el analisis de las imagenes grandes (`imagesPrep.ts`); los pixeles completos siguen
 * saliendo de pdf.js, de uno en uno y solo al descargar o guardar.
 */

import { pngCrc32 } from "@/lib/image/inkPng";
import { isAbortError, type ReducedImage, type Slicer } from "./imagesPixels";

export type FlateSpec = {
  /** Flujo comprimido tal cual esta en el PDF (zlib). */
  bytes: Uint8Array;
  /** Componentes por pixel (1 = gris, 3 = RGB), de 8 bits. */
  comps: 1 | 3;
  /** `true` = cada fila lleva un byte de filtro PNG delante (`/Predictor` 10-15). */
  png: boolean;
};

export function hasDecompressionStream(): boolean {
  return typeof DecompressionStream === "function";
}

/** Desfiltra una fila PNG en el sitio (`prev` = la fila anterior ya desfiltrada, ceros en la primera). */
export function unfilterRow(type: number, cur: Uint8Array, prev: Uint8Array, bpp: number): boolean {
  const n = cur.length;
  switch (type) {
    case 0:
      return true;
    case 1:
      for (let i = bpp; i < n; i += 1) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
      return true;
    case 2:
      for (let i = 0; i < n; i += 1) cur[i] = (cur[i] + prev[i]) & 0xff;
      return true;
    case 3:
      for (let i = 0; i < n; i += 1) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 0xff;
      return true;
    case 4:
      for (let i = 0; i < n; i += 1) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      return true;
    default:
      return false;
  }
}

/**
 * Reduce la imagen a `maxSide` px de lado mayor promediando cada celda. `null` si no se puede (sin `DecompressionStream`, flujo
 * truncado o con un filtro desconocido). Rechaza con `AbortError` si se cancela (`slicer`).
 */
export async function reduceFlateImage(spec: FlateSpec, size: { width: number; height: number }, maxSide: number, slicer: Slicer): Promise<ReducedImage | null> {
  if (!hasDecompressionStream()) return null;
  const { width, height } = size;
  const { comps, png } = spec;
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const ow = Math.max(1, Math.round(width * scale));
  const oh = Math.max(1, Math.round(height * scale));
  const rowBytes = width * comps;
  const stride = rowBytes + (png ? 1 : 0);

  const colMap = new Uint32Array(width);
  const colCount = new Uint32Array(ow);
  for (let x = 0; x < width; x += 1) {
    const ox = Math.min(ow - 1, Math.floor((x * ow) / width));
    colMap[x] = ox;
    colCount[ox] += 1;
  }
  const out = new Uint8ClampedArray(ow * oh * 4);
  const sums = new Uint32Array(ow * 3);
  let currentOy = 0;
  let rowsInCell = 0;
  let rowsDone = 0;
  const prev = new Uint8Array(rowBytes);

  const flush = (): void => {
    if (rowsInCell === 0) return;
    for (let ox = 0; ox < ow; ox += 1) {
      const divisor = colCount[ox] * rowsInCell;
      const o = (currentOy * ow + ox) * 4;
      out[o] = Math.round(sums[ox * 3] / divisor);
      out[o + 1] = Math.round(sums[ox * 3 + 1] / divisor);
      out[o + 2] = Math.round(sums[ox * 3 + 2] / divisor);
      out[o + 3] = 255;
    }
    sums.fill(0);
    rowsInCell = 0;
  };

  /** Una fila completa (con su byte de filtro si lo lleva): desfiltra y la suma a su celda. `false` = filtro invalido. */
  const addRow = (raw: Uint8Array): boolean => {
    let cur = raw;
    if (png) {
      cur = raw.subarray(1, stride);
      if (!unfilterRow(raw[0], cur, prev, comps)) return false;
      prev.set(cur);
    }
    const oy = Math.min(oh - 1, Math.floor((rowsDone * oh) / height));
    if (oy !== currentOy) {
      flush();
      currentOy = oy;
    }
    if (comps === 3) {
      for (let x = 0; x < width; x += 1) {
        const k = colMap[x] * 3;
        const s = x * 3;
        sums[k] += cur[s];
        sums[k + 1] += cur[s + 1];
        sums[k + 2] += cur[s + 2];
      }
    } else {
      for (let x = 0; x < width; x += 1) {
        const k = colMap[x] * 3;
        const v = cur[x];
        sums[k] += v;
        sums[k + 1] += v;
        sums[k + 2] += v;
      }
    }
    rowsInCell += 1;
    rowsDone += 1;
    return true;
  };

  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // El flujo comprimido entra por trozos con contrapresion: la salida se lee a la vez y nunca se acumula.
  const feed = (async () => {
    const CHUNK = 64 * 1024;
    for (let offset = 0; offset < spec.bytes.length; offset += CHUNK) await writer.write(spec.bytes.subarray(offset, Math.min(spec.bytes.length, offset + CHUNK)) as unknown as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  feed.catch(() => undefined);

  const carry = new Uint8Array(stride);
  let carried = 0;
  let ok = true;
  try {
    while (rowsDone < height) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      let pos = 0;
      if (carried > 0) {
        const take = Math.min(stride - carried, chunk.length);
        carry.set(chunk.subarray(0, take), carried);
        carried += take;
        pos = take;
        if (carried === stride) {
          if (!addRow(carry)) {
            ok = false;
            break;
          }
          carried = 0;
        }
      }
      while (ok && rowsDone < height && pos + stride <= chunk.length) {
        if (!addRow(chunk.subarray(pos, pos + stride))) ok = false;
        pos += stride;
        // Un trozo descomprimido trae muchas filas (de una foto de 8000 px, cientos): se cede el hilo entre filas, no solo entre trozos.
        if ((rowsDone & 15) === 0) await slicer.tick();
      }
      if (!ok) break;
      if (rowsDone < height && pos < chunk.length) {
        carry.set(chunk.subarray(pos), 0);
        carried = chunk.length - pos;
      }
      await slicer.tick();
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Flujo truncado o danado (el descompresor rechaza): la imagen se ofrece sin miniatura.
    ok = false;
  } finally {
    // Se corta lo que quede: una bomba de descompresion no se lee mas alla de la ultima fila.
    reader.cancel().catch(() => undefined);
    writer.abort().catch(() => undefined);
  }
  if (!ok || rowsDone < height) return null;
  flush();
  return { width: ow, height: oh, data: out };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* PNG a tamano completo, sin decodificar con pdf.js                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}

function pngHeader(width: number, height: number, comps: 1 | 3): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = comps === 3 ? 2 : 0; // RGB / gris, sin alfa
  return header;
}

/** Cuantos bytes descomprime el flujo (o `null` si esta danado), sin guardarlos. */
async function inflatedLength(bytes: Uint8Array, expected: number, slicer: Slicer): Promise<number | null> {
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const feed = (async () => {
    const CHUNK = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) await writer.write(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK)) as unknown as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  feed.catch(() => undefined);
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += (value as Uint8Array).length;
      if (total > expected) return null;
      await slicer.tick();
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => undefined);
    writer.abort().catch(() => undefined);
  }
  return total;
}

/**
 * PNG de una imagen RGB / gris de 8 bits con `/FlateDecode` SIN decodificarla con pdf.js (no pasa de unos MB de memoria, frente a los
 * ~800 MB de una foto de 40 MP). Con predictor PNG el flujo del PDF YA es el contenido de un PNG (filas con su byte de filtro, en zlib):
 * se envuelve tal cual (tras comprobar que descomprime a las filas esperadas). Sin predictor se descomprime en streaming y se vuelve a
 * comprimir con el filtro «Sub». `null` si no se puede (sin `DecompressionStream`/`CompressionStream`, flujo danado).
 */
export async function flateImageToPng(spec: FlateSpec, size: { width: number; height: number }, slicer: Slicer): Promise<Blob | null> {
  if (!hasDecompressionStream() || typeof CompressionStream !== "function") return null;
  const { width, height } = size;
  const rowBytes = width * spec.comps;
  const stride = rowBytes + 1;
  const parts: Uint8Array[] = [PNG_SIGNATURE, pngChunk("IHDR", pngHeader(width, height, spec.comps))];
  if (spec.png) {
    if ((await inflatedLength(spec.bytes, stride * height, slicer)) !== stride * height) return null;
    const CHUNK = 1024 * 1024;
    for (let offset = 0; offset < spec.bytes.length; offset += CHUNK) parts.push(pngChunk("IDAT", spec.bytes.subarray(offset, Math.min(spec.bytes.length, offset + CHUNK))));
  } else {
    const inflate = new DecompressionStream("deflate");
    const deflate = new CompressionStream("deflate");
    const inWriter = inflate.writable.getWriter();
    const inReader = inflate.readable.getReader();
    const outWriter = deflate.writable.getWriter();
    const outReader = deflate.readable.getReader();
    const collect = (async () => {
      for (;;) {
        const { value, done } = await outReader.read();
        if (done) break;
        parts.push(pngChunk("IDAT", value as Uint8Array));
      }
    })();
    collect.catch(() => undefined);
    const feed = (async () => {
      const CHUNK = 64 * 1024;
      for (let offset = 0; offset < spec.bytes.length; offset += CHUNK) await inWriter.write(spec.bytes.subarray(offset, Math.min(spec.bytes.length, offset + CHUNK)) as unknown as Uint8Array<ArrayBuffer>);
      await inWriter.close();
    })();
    feed.catch(() => undefined);
    const carry = new Uint8Array(rowBytes);
    let carried = 0;
    let rows = 0;
    const comps = spec.comps;
    const emit = async (raw: Uint8Array): Promise<void> => {
      const out = new Uint8Array(stride) as Uint8Array<ArrayBuffer>;
      out[0] = 1;
      for (let i = 0; i < rowBytes; i += 1) out[1 + i] = (raw[i] - (i >= comps ? raw[i - comps] : 0)) & 0xff;
      rows += 1;
      await outWriter.write(out);
    };
    try {
      while (rows < height) {
        const { value, done } = await inReader.read();
        if (done) break;
        const chunk = value as Uint8Array;
        let pos = 0;
        if (carried > 0) {
          const take = Math.min(rowBytes - carried, chunk.length);
          carry.set(chunk.subarray(0, take), carried);
          carried += take;
          pos = take;
          if (carried === rowBytes) {
            await emit(carry);
            carried = 0;
          }
        }
        while (rows < height && pos + rowBytes <= chunk.length) {
          await emit(chunk.subarray(pos, pos + rowBytes));
          pos += rowBytes;
          if ((rows & 15) === 0) await slicer.tick();
        }
        if (rows < height && pos < chunk.length) {
          carry.set(chunk.subarray(pos), 0);
          carried = chunk.length - pos;
        }
        await slicer.tick();
      }
      if (rows < height) return null;
      await outWriter.close();
      await collect;
    } catch (error) {
      outWriter.abort().catch(() => undefined);
      outReader.cancel().catch(() => undefined);
      if (isAbortError(error)) throw error;
      return null;
    } finally {
      inReader.cancel().catch(() => undefined);
      inWriter.abort().catch(() => undefined);
    }
  }
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return new Blob(parts as unknown as BlobPart[], { type: "image/png" });
}
