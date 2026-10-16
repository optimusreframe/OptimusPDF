import { deflateSync } from "node:zlib";
import { crc32 } from "@/app/sign-pdf/signVault";

/**
 * PNG sinteticos para las pruebas del respaldo y del cifrado (jsdom/Node no
 * decodifican imagenes y los validadores solo leen cabecera, CRC del IHDR,
 * dimensiones y el IEND final). Determinista: mismos argumentos, mismos bytes.
 * No lo importa codigo de produccion.
 */

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

export function makePng(
  opts: { width?: number; height?: number; seed?: number; totalBytes?: number } = {},
): Uint8Array {
  const { width = 40, height = 20, seed = 0, totalBytes } = opts;
  const ihdr = new Uint8Array(25);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 13);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4);
  view.setUint32(8, width);
  view.setUint32(12, height);
  ihdr.set([8, 6, 0, 0, 0], 16);
  view.setUint32(21, crc32(ihdr.subarray(4, 21)));
  const base = PNG_HEAD.length + ihdr.length + PNG_END.length;
  const pad = Math.max(1, (totalBytes ?? base + 8) - base);
  const out = new Uint8Array(base + pad);
  out.set(PNG_HEAD, 0);
  out.set(ihdr, PNG_HEAD.length);
  // Relleno que depende de `seed` Y de la posicion: dos semillas distintas
  // dan bytes distintos aunque el PNG sea diminuto.
  for (let i = PNG_HEAD.length + ihdr.length; i < out.length - PNG_END.length; i += 1) {
    out[i] = (seed * 31 + i * 7 + 1) & 0xff;
  }
  out.set(PNG_END, out.length - PNG_END.length);
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * PNG REAL (RGBA 8 bit, zlib de verdad, CRC de cada chunk): lo que pasa la guarda estricta de la importacion
 * (`pngImportGuard`, D5) y se decodifica en cualquier motor. Determinista y distinto para cada `seed`.
 */
export function makeRealPng(opts: { width?: number; height?: number; seed?: number } = {}): Uint8Array {
  const { width = 40, height = 20, seed = 0 } = opts;
  const stride = 1 + width * 4;
  const raw = new Uint8Array(stride * height);
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % stride === 0 ? 0 : (seed * 31 + i * 7 + 1) & 0xff;
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  head.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array(PNG_HEAD),
    chunk("IHDR", head),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Inserta un chunk (con su CRC correcto) justo despues del IHDR de un PNG real. */
export function pngWithChunk(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const at = PNG_HEAD.length + 25; // firma + IHDR completo
  const extra = chunk(type, data);
  const out = new Uint8Array(png.length + extra.length);
  out.set(png.subarray(0, at), 0);
  out.set(extra, at);
  out.set(png.subarray(at), at + extra.length);
  return out;
}

/** Estropea los datos del IDAT y RECALCULA el CRC del chunk: la estructura sigue bien, lo que no se descomprime. */
export function pngWithCorruptIdat(png: Uint8Array): Uint8Array {
  const out = new Uint8Array(png);
  const view = new DataView(out.buffer);
  let pos = PNG_HEAD.length;
  while (pos + 12 <= out.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(out[pos + 4], out[pos + 5], out[pos + 6], out[pos + 7]);
    if (type === "IDAT") {
      for (let i = pos + 8 + 4; i < pos + 8 + length - 8; i += 3) out[i] ^= 0xa5;
      view.setUint32(pos + 8 + length, crc32(out.subarray(pos + 4, pos + 8 + length)));
      return out;
    }
    pos += 12 + length;
  }
  throw new Error("sin IDAT");
}

/** PNG con IHDR de 4096x4096 (64 MB descomprimido) y un IDAT diminuto: la bomba de pixeles. */
export function pngPixelBomb(): Uint8Array {
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  view.setUint32(0, 4096);
  view.setUint32(4, 4096);
  head.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array(PNG_HEAD),
    chunk("IHDR", head),
    chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(1)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type TestImage = {
  png: Uint8Array;
  ratio: number;
  width: number;
  height: number;
};

export function makeImage(
  opts: { width?: number; height?: number; seed?: number; totalBytes?: number; real?: boolean } = {},
): TestImage {
  const { width = 40, height = 20 } = opts;
  return { png: opts.real ? makeRealPng(opts) : makePng(opts), ratio: height / width, width, height };
}
