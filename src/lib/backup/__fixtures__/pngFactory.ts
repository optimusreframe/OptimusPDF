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

export type TestImage = {
  png: Uint8Array;
  ratio: number;
  width: number;
  height: number;
};

export function makeImage(
  opts: { width?: number; height?: number; seed?: number; totalBytes?: number } = {},
): TestImage {
  const { width = 40, height = 20 } = opts;
  return { png: makePng(opts), ratio: height / width, width, height };
}
