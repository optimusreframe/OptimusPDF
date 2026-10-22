/**
 * Ayudas de PRUEBA del motor de imagenes (solo Node/Vitest): abrir un PDF con la build «legacy» de pdf.js con los
 * decodificadores WASM de `public/pdfjs-wasm/` (la misma ruta que usa la aplicacion), y decodificar un PNG a RGBA para
 * comparar pixeles (nunca bytes: la compresion zlib cambia entre maquinas).
 */

import path from "node:path";
import zlib from "node:zlib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ImageOpNumbers } from "./imagesOps";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
export function legacyPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export const WASM_DIR = path.join(process.cwd(), "public", "pdfjs-wasm") + path.sep;

export type OpenedDoc = { doc: PDFDocumentProxy; ops: ImageOpNumbers; close: () => Promise<void> };

/** Abre bytes de PDF (los copia: pdf.js transfiere el buffer). `wasmUrl: null` simula una aplicacion SIN la configuracion de U7.0. */
export async function openLegacy(bytes: Uint8Array, options: { wasmUrl?: string | null } = {}): Promise<OpenedDoc> {
  const pdfjs = await legacyPdfjs();
  const wasmUrl = options.wasmUrl === undefined ? WASM_DIR : options.wasmUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, ...(wasmUrl ? { wasmUrl } : {}) });
  const doc = (await task.promise) as unknown as PDFDocumentProxy;
  return { doc, ops: pdfjs.OPS as unknown as ImageOpNumbers, close: async () => void (await task.destroy()) };
}

export type Rgba = { width: number; height: number; data: Uint8Array };

/** Decodifica un PNG de 8 bits RGBA (el que produce el motor) o RGB/gris/gris+alfa. */
export function decodePng(bytes: Uint8Array): Rgba {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, i) => bytes[i] === value)) throw new Error("no es un PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = new DataView(body.buffer, body.byteOffset, 13).getUint32(0);
      height = new DataView(body.buffer, body.byteOffset, 13).getUint32(4);
      if (body[8] !== 8) throw new Error("solo PNG de 8 bits");
      colorType = body[9];
    } else if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`tipo de color PNG no soportado: ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = prev[i];
      const upLeft = i >= channels ? prev[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[i] = (src[i] + predictor) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (channels === 4) out.set(line.subarray(x * 4, x * 4 + 4), o);
      else if (channels === 3) out.set([line[x * 3], line[x * 3 + 1], line[x * 3 + 2], 255], o);
      else if (channels === 2) out.set([line[x * 2], line[x * 2], line[x * 2], line[x * 2 + 1]], o);
      else out.set([line[x], line[x], line[x], 255], o);
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
