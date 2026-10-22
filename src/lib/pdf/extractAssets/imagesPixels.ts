/**
 * Pixeles de las imagenes de pdf.js: lectura por BANDAS (nunca se copia la imagen entera para analizarla), miniatura de
 * 256 px, ¿tiene transparencia?, huella para deduplicar y PNG con alfa.
 *
 * pdf.js entrega la imagen decodificada de DOS maneras, segun el entorno:
 *  - `{ bitmap }` (`ImageBitmap`): en un navegador (el worker de pdf.js decodifica con `OffscreenCanvas`). Se lee con un
 *    canvas y `getImageData` por bandas.
 *  - `{ kind, data }`: en Node y en motores sin `OffscreenCanvas`. `kind` 1 = gris de 1 bit (bit 1 = blanco), 2 = RGB de
 *    24 bits, 3 = RGBA de 32 bits. Las mascaras de 1 bit (`paintImageMaskXObject`) traen los bits SIN `kind` (bit 0 = se
 *    pinta) o, en el navegador, un bitmap RGBA negro con el alfa de la mascara.
 * La SMask / Mask ya vienen COMPUESTAS en el alfa (RGBA) por pdf.js; aqui solo se lee.
 */

import { encodePngBytes } from "@/lib/image/inkPng";
import type { InkImage } from "@/lib/image/inkCore";

const BAND_PIXELS = 500_000;
/** Milisegundos de CPU seguidos antes de ceder el hilo. */
const SLICE_MS = 24;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Cede el hilo al navegador (deja pintar y atender toques). Con `setTimeout`, y NO con `scheduler.yield()`: la
 * continuacion de `scheduler.yield()` se ejecuta ANTES que los temporizadores ya en cola, asi que un trabajo largo en
 * trozos los dejaba esperar hasta el final (medido en Chromium: huecos de ~100 ms entre temporizadores con 12 MP; con
 * `setTimeout`, ~50 ms) sin ganar tiempo total.
 */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Reloj de cesion: `tick()` cede el hilo si lleva `SLICE_MS` ms seguidos trabajando y comprueba la cancelacion. */
export class Slicer {
  private since = now();
  constructor(private readonly signal?: AbortSignal) {}
  async tick(): Promise<void> {
    this.throwIfAborted();
    if (now() - this.since < SLICE_MS) return;
    await yieldToMain();
    this.throwIfAborted();
    this.since = now();
  }
  throwIfAborted(): void {
    if (this.signal?.aborted) throw abortError();
  }
}

export function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: string }).name === "AbortError";
}

/** Fuente de pixeles RGBA leida por bandas de filas. */
export interface PixelSource {
  readonly width: number;
  readonly height: number;
  /** `true` si se sabe de antemano que no hay transparencia (RGB, gris); `false` si hay que mirar el alfa. */
  readonly opaque: boolean;
  /** RGBA de las filas `[y0, y1)`. El buffer puede reutilizarse en la siguiente llamada: usarlo antes de pedir otra banda. */
  rows(y0: number, y1: number): Uint8ClampedArray;
  /** Libera lo que tenga (un `ImageBitmap`, un canvas). */
  close(): void;
}

type RawImageData = {
  width?: number;
  height?: number;
  kind?: number;
  data?: ArrayLike<number> | null;
  bitmap?: ImageBitmap | null;
};

const KIND_GRAY_1BPP = 1;
const KIND_RGB_24BPP = 2;
const KIND_RGBA_32BPP = 3;

class RawSource implements PixelSource {
  readonly opaque: boolean;
  private band: Uint8ClampedArray | null = null;
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly kind: number,
    private readonly data: ArrayLike<number>,
  ) {
    this.opaque = kind !== KIND_RGBA_32BPP;
  }
  private buffer(rows: number): Uint8ClampedArray {
    const size = rows * this.width * 4;
    if (!this.band || this.band.length < size) this.band = new Uint8ClampedArray(size);
    return this.band;
  }
  rows(y0: number, y1: number): Uint8ClampedArray {
    const { width, data, kind } = this;
    const rows = y1 - y0;
    if (kind === KIND_RGBA_32BPP) {
      const start = y0 * width * 4;
      const end = y1 * width * 4;
      if (data.length >= end && "subarray" in data) {
        return (data as Uint8ClampedArray).subarray(start, end) as Uint8ClampedArray;
      }
      // Datos incompletos: lo que falta queda transparente.
      const out = this.buffer(rows).fill(0, 0, rows * width * 4);
      for (let i = 0; i < rows * width * 4 && start + i < data.length; i += 1) out[i] = data[start + i];
      return out.subarray(0, rows * width * 4);
    }
    const out = this.buffer(rows);
    if (kind === KIND_RGB_24BPP) {
      let src = y0 * width * 3;
      let dst = 0;
      for (let i = 0; i < rows * width; i += 1) {
        out[dst] = data[src];
        out[dst + 1] = data[src + 1];
        out[dst + 2] = data[src + 2];
        out[dst + 3] = 255;
        src += 3;
        dst += 4;
      }
      return out.subarray(0, rows * width * 4);
    }
    // Gris de 1 bit: filas alineadas a byte; bit 1 = blanco.
    const stride = (width + 7) >> 3;
    let dst = 0;
    for (let y = y0; y < y1; y += 1) {
      const base = y * stride;
      for (let x = 0; x < width; x += 1) {
        const byte = data[base + (x >> 3)] ?? 0xff;
        const value = byte & (128 >> (x & 7)) ? 255 : 0;
        out[dst] = value;
        out[dst + 1] = value;
        out[dst + 2] = value;
        out[dst + 3] = 255;
        dst += 4;
      }
    }
    return out.subarray(0, rows * width * 4);
  }
  close(): void {
    this.band = null;
  }
}

/** Mascara de 1 bit empaquetada (bit 0 = se pinta) coloreada con `fill`. */
class PackedMaskSource implements PixelSource {
  readonly opaque = false;
  private band: Uint8ClampedArray | null = null;
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly data: ArrayLike<number>,
    private readonly fill: [number, number, number],
  ) {}
  rows(y0: number, y1: number): Uint8ClampedArray {
    const { width, data, fill } = this;
    const size = (y1 - y0) * width * 4;
    if (!this.band || this.band.length < size) this.band = new Uint8ClampedArray(size);
    const out = this.band;
    const stride = (width + 7) >> 3;
    let dst = 0;
    for (let y = y0; y < y1; y += 1) {
      const base = y * stride;
      for (let x = 0; x < width; x += 1) {
        const byte = data[base + (x >> 3)] ?? 0xff;
        out[dst] = fill[0];
        out[dst + 1] = fill[1];
        out[dst + 2] = fill[2];
        out[dst + 3] = byte & (128 >> (x & 7)) ? 0 : 255;
        dst += 4;
      }
    }
    return out.subarray(0, size);
  }
  close(): void {
    this.band = null;
  }
}

type Canvas2D = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
};

/**
 * Pixeles maximos de un canvas: Safari en iPhone/iPad limita un canvas a 16 777 216 px y por encima NO falla, dibuja en
 * blanco. Una imagen mas grande se codifica a mano (JS, por bandas) y no con un canvas entero.
 */
export const MAX_CANVAS_PIXELS = 16_000_000;

function createCanvas(width: number, height: number): Canvas2D {
  if (width * height > MAX_CANVAS_PIXELS) throw new Error("canvas-unavailable");
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("canvas-unavailable");
    return { canvas, ctx };
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("canvas-unavailable");
    return { canvas, ctx };
  }
  throw new Error("canvas-unavailable");
}

/**
 * `ImageBitmap` de pdf.js leido con un canvas, BANDA a BANDA: cada banda se dibuja en un canvas del tamano de la banda
 * (no se copia la imagen entera a un canvas: ahorra su memoria y evita una tarea larga al dibujar 12 MP de golpe). Si es
 * una mascara, el color se sustituye por `fill` y el alfa se conserva.
 */
class BitmapSource implements PixelSource {
  readonly opaque = false;
  private bandCanvas: Canvas2D | null = null;
  private full: Canvas2D | null = null;
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly bitmap: ImageBitmap,
    private readonly fill: [number, number, number] | null,
  ) {}
  rows(y0: number, y1: number): Uint8ClampedArray {
    const rows = y1 - y0;
    if (!this.bandCanvas) this.bandCanvas = createCanvas(this.width, rows);
    else if (this.bandCanvas.canvas.height < rows) this.bandCanvas.canvas.height = rows;
    const { ctx } = this.bandCanvas;
    ctx.clearRect(0, 0, this.width, rows);
    ctx.drawImage(this.bitmap, 0, y0, this.width, rows, 0, 0, this.width, rows);
    const data = ctx.getImageData(0, 0, this.width, rows).data;
    if (this.fill) {
      const [r, g, b] = this.fill;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
    }
    return data;
  }
  /** Para PNG nativo: un canvas con la imagen entera ya dibujada (sin pasar por JS). Las mascaras recoloreadas no lo usan. */
  nativeCanvas(): Canvas2D | null {
    if (this.fill || this.width * this.height > MAX_CANVAS_PIXELS) return null;
    if (!this.full) {
      this.full = createCanvas(this.width, this.height);
      this.full.ctx.drawImage(this.bitmap, 0, 0);
    }
    return this.full;
  }
  /** Libera SOLO los canvas propios: el `ImageBitmap` es de pdf.js (lo libera `page.cleanup()`; cerrarlo aqui rompe un `render` posterior). */
  close(): void {
    for (const entry of [this.bandCanvas, this.full]) {
      if (!entry) continue;
      entry.canvas.width = 1;
      entry.canvas.height = 1;
    }
    this.bandCanvas = null;
    this.full = null;
  }
}

/** Recorte de otra fuente (una casilla del atlas de un grupo de imagenes en linea). */
class CropSource implements PixelSource {
  readonly opaque: boolean;
  private band: Uint8ClampedArray | null = null;
  constructor(
    private readonly parent: PixelSource,
    private readonly rect: { x: number; y: number; w: number; h: number },
  ) {
    this.opaque = parent.opaque;
  }
  get width(): number {
    return this.rect.w;
  }
  get height(): number {
    return this.rect.h;
  }
  rows(y0: number, y1: number): Uint8ClampedArray {
    const { x, y, w } = this.rect;
    const rows = y1 - y0;
    const size = rows * w * 4;
    if (!this.band || this.band.length < size) this.band = new Uint8ClampedArray(size);
    const source = this.parent.rows(y + y0, y + y1);
    const parentWidth = this.parent.width;
    for (let r = 0; r < rows; r += 1) {
      const from = (r * parentWidth + x) * 4;
      this.band.set(source.subarray(from, from + w * 4), r * w * 4);
    }
    return this.band.subarray(0, size);
  }
  /** No cierra la fuente madre: la comparten todas las casillas del atlas y la cierra quien la creo. */
  close(): void {
    this.band = null;
  }
}

/** Recorte de una fuente (una casilla de un atlas). `null` si la casilla se sale de la imagen. */
export function cropSource(parent: PixelSource, rect: { x: number; y: number; w: number; h: number }): PixelSource | null {
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > parent.width || y + h > parent.height) return null;
  return new CropSource(parent, rect);
}

export type SourceKind = "image" | "mask";

/**
 * Fuente de pixeles de lo que pdf.js entrego para un objeto. `null` si no hay pixeles legibles (decodificacion fallida,
 * formato desconocido).
 */
export function pixelSourceFor(
  imgData: unknown,
  options: { kind: SourceKind; fill?: [number, number, number] },
): PixelSource | null {
  if (!imgData || typeof imgData !== "object") return null;
  const raw = imgData as RawImageData;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!(width > 0) || !(height > 0)) return null;
  const fill = options.fill ?? [0, 0, 0];
  let source: PixelSource | null = null;
  if (raw.bitmap) {
    source = new BitmapSource(width, height, raw.bitmap, options.kind === "mask" ? fill : null);
  } else if (raw.data && typeof raw.data.length === "number") {
    if (options.kind === "mask" && raw.kind === undefined) source = new PackedMaskSource(width, height, raw.data, fill);
    else if (raw.kind === KIND_GRAY_1BPP || raw.kind === KIND_RGB_24BPP || raw.kind === KIND_RGBA_32BPP) {
      source = new RawSource(width, height, raw.kind, raw.data);
    }
  }
  return source;
}

/* ------------------------------------------------------------------ *
 * Analisis: miniatura, transparencia y huella en UNA pasada
 * ------------------------------------------------------------------ */

export type ImageAnalysis = {
  width: number;
  height: number;
  hasAlpha: boolean;
  /** Miniatura RGBA (como mucho `thumbPx` de lado mayor). */
  thumb: InkImage;
  /** Huella (16 hex) de las medidas y de la miniatura: dos imagenes iguales dan la misma. */
  hash: string;
  /** Fraccion (0..1) de colores distintos de la miniatura: ~0 = grafico plano, ~1 = fotografia. */
  complexity: number;
};

export function thumbSize(width: number, height: number, thumbPx: number): { width: number; height: number } {
  const scale = Math.min(1, thumbPx / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Cada cuantos pixeles se muestrea la imagen a tamano completo para la huella (ademas de la miniatura). */
const SAMPLE_STRIDE = 13;

/**
 * FNV-1a de 32 bits con dos semillas -> 16 hex, de las medidas, la miniatura y una MUESTRA de pixeles a tamano completo
 * (`sample`): dos imagenes que solo se diferencian en detalles mas finos que una celda de la miniatura no se confunden.
 */
function fingerprint(bytes: Uint8Array, width: number, height: number, sample: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0xdeadbeef;
  const mix = (value: number): void => {
    h1 = Math.imul(h1 ^ value, 0x01000193);
    h2 = Math.imul(h2 ^ value, 0x85ebca6b);
    h2 ^= h2 >>> 13;
  };
  mix(width & 0xffff);
  mix(width >>> 16);
  mix(height & 0xffff);
  mix(height >>> 16);
  mix(sample);
  for (let i = 0; i < bytes.length; i += 1) mix(bytes[i]);
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Recorre la fuente por bandas acumulando la miniatura (promedio por celda, ponderado por el alfa), si hay alfa y la
 * huella. Cede el hilo entre bandas y comprueba la cancelacion.
 */
export async function analyzeSource(source: PixelSource, thumbPx: number, slicer: Slicer): Promise<ImageAnalysis> {
  const { width, height } = source;
  const target = thumbSize(width, height, thumbPx);
  const cells = target.width * target.height;
  const sums = new Float64Array(cells * 4);
  const counts = new Uint32Array(cells);
  const columns = new Uint16Array(width);
  for (let x = 0; x < width; x += 1) columns[x] = Math.min(target.width - 1, Math.floor((x * target.width) / width));
  const bandRows = Math.max(1, Math.floor(BAND_PIXELS / width));
  let hasAlpha = false;
  let sample = 0x2545f491;
  let counter = 0;

  for (let y0 = 0; y0 < height; y0 += bandRows) {
    await slicer.tick();
    const y1 = Math.min(height, y0 + bandRows);
    const data = source.rows(y0, y1);
    let index = 0;
    for (let y = y0; y < y1; y += 1) {
      const row = Math.min(target.height - 1, Math.floor((y * target.height) / height)) * target.width;
      for (let x = 0; x < width; x += 1) {
        const cell = row + columns[x];
        const a = data[index + 3];
        if (a !== 255) hasAlpha = true;
        const k = cell * 4;
        sums[k] += data[index] * a;
        sums[k + 1] += data[index + 1] * a;
        sums[k + 2] += data[index + 2] * a;
        sums[k + 3] += a;
        counts[cell] += 1;
        counter += 1;
        if (counter === SAMPLE_STRIDE) {
          counter = 0;
          sample = Math.imul(sample ^ (data[index] | (data[index + 1] << 8) | (data[index + 2] << 16) | (a << 24)), 0x01000193);
        }
        index += 4;
      }
    }
  }

  const thumbData = new Uint8ClampedArray(cells * 4);
  const distinct = new Set<number>();
  for (let cell = 0; cell < cells; cell += 1) {
    const k = cell * 4;
    const alphaSum = sums[k + 3];
    if (alphaSum > 0) {
      thumbData[k] = Math.round(sums[k] / alphaSum);
      thumbData[k + 1] = Math.round(sums[k + 1] / alphaSum);
      thumbData[k + 2] = Math.round(sums[k + 2] / alphaSum);
    }
    thumbData[k + 3] = counts[cell] > 0 ? Math.round(alphaSum / counts[cell]) : 0;
    distinct.add(((thumbData[k] >> 4) << 12) | ((thumbData[k + 1] >> 4) << 8) | ((thumbData[k + 2] >> 4) << 4) | (thumbData[k + 3] >> 4));
  }
  const thumb: InkImage = { width: target.width, height: target.height, data: thumbData };
  return {
    width,
    height,
    hasAlpha,
    thumb,
    hash: fingerprint(new Uint8Array(thumbData.buffer, thumbData.byteOffset, thumbData.byteLength), width, height, sample),
    complexity: Math.min(1, distinct.size / Math.max(1, Math.min(cells, 4096))),
  };
}

/** Estimacion (no exacta) del tamano de un PNG de esas medidas: depende de lo «foto» que sea la imagen. */
export function estimatePngBytes(width: number, height: number, hasAlpha: boolean, complexity: number): number {
  const raw = width * height * (hasAlpha ? 4 : 3);
  const ratio = 0.08 + 0.72 * Math.min(1, Math.max(0, complexity));
  return Math.max(70, Math.round(raw * ratio) + 70);
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

export function pngBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: "image/png" });
}

/** Por encima de esto el PNG se codifica con el canvas del navegador (nativo y rapido) en vez de a mano. */
const NATIVE_PNG_PIXELS = 8_000_000;

async function canvasToPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/png" });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png-failed"))), "image/png");
  });
}

/** PNG RGBA (con alfa) de TODA la fuente. */
export async function encodeSourceAsPng(source: PixelSource, slicer: Slicer): Promise<Blob> {
  const { width, height } = source;
  const big = width * height > NATIVE_PNG_PIXELS && width * height <= MAX_CANVAS_PIXELS;
  let canvasAvailable = false;
  try {
    canvasAvailable = typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";
  } catch {
    canvasAvailable = false;
  }
  if (source instanceof BitmapSource && canvasAvailable) {
    const native = source.nativeCanvas();
    if (native) return canvasToPng(native.canvas);
  }
  if (big && canvasAvailable) {
    const { canvas, ctx } = createCanvas(width, height);
    const bandRows = Math.max(1, Math.floor(BAND_PIXELS / width));
    for (let y0 = 0; y0 < height; y0 += bandRows) {
      await slicer.tick();
      const y1 = Math.min(height, y0 + bandRows);
      const rows = source.rows(y0, y1);
      const copy = new Uint8ClampedArray(rows.length);
      copy.set(rows);
      ctx.putImageData(new ImageData(copy, width, y1 - y0), 0, y0);
    }
    return canvasToPng(canvas);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const bandRows = Math.max(1, Math.floor(BAND_PIXELS / width));
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    await slicer.tick();
    const y1 = Math.min(height, y0 + bandRows);
    data.set(source.rows(y0, y1), y0 * width * 4);
  }
  return pngBlob(await encodePngBytes({ width, height, data }));
}

/** RGBA completo (para pruebas y para JPEG): aplana el alfa sobre blanco si `flatten`. */
export async function readAllPixels(source: PixelSource, slicer: Slicer, flatten = false): Promise<Uint8ClampedArray> {
  const { width, height } = source;
  const data = new Uint8ClampedArray(width * height * 4);
  const bandRows = Math.max(1, Math.floor(BAND_PIXELS / width));
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    await slicer.tick();
    const y1 = Math.min(height, y0 + bandRows);
    data.set(source.rows(y0, y1), y0 * width * 4);
  }
  if (flatten) {
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 255) continue;
      data[i] = Math.round((data[i] * a + 255 * (255 - a)) / 255);
      data[i + 1] = Math.round((data[i + 1] * a + 255 * (255 - a)) / 255);
      data[i + 2] = Math.round((data[i + 2] * a + 255 * (255 - a)) / 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

/** JPEG recomprimido (`jpg`): el alfa se aplana sobre blanco. Solo en un navegador (necesita un canvas). */
export async function encodeSourceAsJpeg(source: PixelSource, slicer: Slicer, quality = 0.92): Promise<Blob> {
  const { width, height } = source;
  const { canvas, ctx } = createCanvas(width, height);
  const bandRows = Math.max(1, Math.floor(BAND_PIXELS / width));
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    await slicer.tick();
    const y1 = Math.min(height, y0 + bandRows);
    const rows = source.rows(y0, y1);
    const copy = new Uint8ClampedArray(rows.length);
    copy.set(rows);
    for (let i = 0; i < copy.length; i += 4) {
      const a = copy[i + 3];
      if (a === 255) continue;
      copy[i] = Math.round((copy[i] * a + 255 * (255 - a)) / 255);
      copy[i + 1] = Math.round((copy[i + 1] * a + 255 * (255 - a)) / 255);
      copy[i + 2] = Math.round((copy[i + 2] * a + 255 * (255 - a)) / 255);
      copy[i + 3] = 255;
    }
    ctx.putImageData(new ImageData(copy, width, y1 - y0), 0, y0);
  }
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("jpeg-failed"))), "image/jpeg", quality);
  });
}
