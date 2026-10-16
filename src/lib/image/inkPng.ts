import { InkError, MAX_OUTPUT_DIMENSION, fitDimensions, resizeAreaSteps, runSteps, type InkImage } from "./inkCore";

/**
 * Codificador PNG propio (RGBA de 8 bits) para las firmas «de tinta». Se escribe a mano, y no con `canvas.toBlob`, por tres
 * razones: (1) es DETERMINISTA (mismos pixeles = mismos bytes, sin metadatos ni cabeceras de otro motor), (2) corre igual
 * en el hilo principal, en un worker y en Node, y (3) permite la escalera de tamano de `encodeInkPng` (cuantizar y reducir
 * hasta caber en el tope del baul) sin recodificar a ciegas. Solo la compresion zlib la pone el navegador
 * (`CompressionStream("deflate")`); sin ella se cae a un canvas.
 */

/** Tope de un PNG del baul: lo mismo que `MAX_VAULT_IMAGE_BYTES` de `signVault.ts` (una prueba comprueba la igualdad). */
export const MAX_PNG_BYTES = 600 * 1024;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;
function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 de PNG/zip. */
export function pngCrc32(bytes: Uint8Array): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Cede al navegador si ya se uso ~40 ms de CPU seguidos. */
async function maybeYield(state: { since: number }): Promise<void> {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (now - state.since < 40) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  state.since = typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Filtros PNG por fila: se elige, fila a fila, el de menor suma de valores absolutos (heuristica del estandar). */
async function filterRows(image: InkImage, state: { since: number }): Promise<Uint8Array> {
  const { width, height, data } = image;
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) await maybeYield(state);
    const row = y * stride;
    const prior = row - stride;
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter += 1) {
      const candidate = candidates[filter];
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const raw = data[row + i];
        const left = i >= 4 ? data[row + i - 4] : 0;
        const up = y > 0 ? data[prior + i] : 0;
        const upLeft = y > 0 && i >= 4 ? data[prior + i - 4] : 0;
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
        const value = (raw - predicted) & 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
      }
    }
    out[y * (stride + 1)] = bestFilter;
    out.set(candidates[bestFilter], y * (stride + 1) + 1);
  }
  return out;
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `true` si el entorno trae `CompressionStream` (todos los navegadores actuales y Node 18+). */
export function hasCompressionStream(): boolean {
  return typeof CompressionStream !== "undefined" && typeof Blob !== "undefined" && typeof Response !== "undefined";
}

/** PNG RGBA de 8 bits, sin metadatos. Lanza `encode-failed` si el entorno no puede comprimir. */
export async function encodePngBytes(image: InkImage): Promise<Uint8Array> {
  if (!hasCompressionStream()) throw new InkError("encode-failed", "Este navegador no puede comprimir PNG.");
  const state = { since: typeof performance !== "undefined" ? performance.now() : Date.now() };
  const filtered = await filterRows(image, state);
  await maybeYield(state);
  const idat = await zlibDeflate(filtered);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header[8] = 8; // profundidad
  header[9] = 6; // RGBA
  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", header), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Respaldo sin `CompressionStream`: el PNG del propio canvas (no determinista entre navegadores, sin escalera de calidad). */
async function canvasPngBytes(image: InkImage): Promise<Uint8Array> {
  const pixels = new Uint8ClampedArray(image.width * image.height * 4);
  pixels.set(image.data.subarray(0, pixels.length));
  const imageData = new ImageData(pixels, image.width, image.height);
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext("2d")?.putImageData(imageData, 0, 0);
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(imageData, 0, 0);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  }
  if (!blob) throw new InkError("encode-failed");
  return new Uint8Array(await blob.arrayBuffer());
}

export type InkQuantization = "lossless" | "rgb5" | "rgb3" | "flat";

/** Resultado de `encodeInkPng`: los bytes y lo que hubo que hacer para que cupieran. */
export interface EncodedInkPng {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** 1 si no se redujo; menos si hubo que reducir para respetar `maxDimension` o `maxBytes`. */
  scale: number;
  quantization: InkQuantization;
}

export interface EncodeOptions {
  /** Por defecto `MAX_PNG_BYTES` (600 KB). */
  maxBytes?: number;
  /** Por defecto 4096. */
  maxDimension?: number;
}

/** Escalones de reduccion cuando ni cuantizando cabe. */
const SCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2, 0.12] as const;
const QUANTIZATIONS: readonly InkQuantization[] = ["lossless", "rgb5", "rgb3", "flat"];
/** Reduccion minima util: por debajo de este lado una firma ya no se lee. */
const MIN_SIDE = 8;

/** Reduce la precision del color (el alfa NO se toca: es lo que da el antialias) o lo aplana a un solo color. */
function quantize(image: InkImage, mode: InkQuantization): InkImage {
  if (mode === "lossless") return image;
  const count = image.width * image.height;
  const out = new Uint8ClampedArray(count * 4);
  const data = image.data;
  if (mode === "flat") {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < count; i += 1) {
      const a = data[i * 4 + 3];
      r += data[i * 4] * a;
      g += data[i * 4 + 1] * a;
      b += data[i * 4 + 2] * a;
      weight += a;
    }
    const mean = weight > 0 ? [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)] : [0, 0, 0];
    for (let i = 0; i < count; i += 1) {
      const a = data[i * 4 + 3];
      if (a === 0) continue;
      out[i * 4] = mean[0];
      out[i * 4 + 1] = mean[1];
      out[i * 4 + 2] = mean[2];
      out[i * 4 + 3] = a;
    }
    return { width: image.width, height: image.height, data: out };
  }
  const mask = mode === "rgb5" ? 0xf8 : 0xe0;
  for (let i = 0; i < count; i += 1) {
    const a = data[i * 4 + 3];
    if (a === 0) continue;
    out[i * 4] = data[i * 4] & mask;
    out[i * 4 + 1] = data[i * 4 + 1] & mask;
    out[i * 4 + 2] = data[i * 4 + 2] & mask;
    out[i * 4 + 3] = a;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Codifica a PNG respetando los topes del baul. Escalera, de menos a mas perdida (cada paso solo si el anterior no cupo):
 * 1. sin perdida; 2-4. color cuantizado a 5 bits, a 3 bits y plano (el alfa, que es el antialias, nunca se toca);
 * 5. si aun asi no cabe, reduccion del tamano por areas (0,85 x, 0,7 x, ...) repitiendo los pasos con menos colores.
 * Lanza `InkError("encode-failed")` si ni a la minima escala cabe (solo con topes absurdamente bajos).
 */
export async function encodeInkPng(image: InkImage, options: EncodeOptions = {}): Promise<EncodedInkPng> {
  const maxBytes = options.maxBytes ?? MAX_PNG_BYTES;
  const maxDimension = options.maxDimension ?? MAX_OUTPUT_DIMENSION;
  if (!hasCompressionStream()) {
    const fit = fitDimensions(image.width, image.height, maxDimension);
    const source = fit.scale < 1 ? runSteps(resizeAreaSteps(image, fit.width, fit.height)) : image;
    const bytes = await canvasPngBytes(source);
    if (bytes.length > maxBytes) throw new InkError("encode-failed");
    return { bytes, width: source.width, height: source.height, scale: fit.scale, quantization: "lossless" };
  }
  for (const step of SCALE_STEPS) {
    const target = fitDimensions(Math.max(1, Math.round(image.width * step)), Math.max(1, Math.round(image.height * step)), maxDimension);
    const width = Math.max(1, target.width);
    const height = Math.max(1, target.height);
    if (step < 1 && Math.min(width, height) < MIN_SIDE) break;
    const same = width === image.width && height === image.height;
    const scaled = same ? image : runSteps(resizeAreaSteps(image, width, height));
    for (const mode of QUANTIZATIONS) {
      const bytes = await encodePngBytes(quantize(scaled, mode));
      if (bytes.length <= maxBytes) {
        return { bytes, width, height, scale: width / image.width, quantization: mode };
      }
    }
  }
  throw new InkError("encode-failed");
}
