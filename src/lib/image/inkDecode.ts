import { InkError, type InkImage } from "./inkCore";

/**
 * Lectura de la imagen que sube el usuario (U6.1). Las comprobaciones que no dependen del navegador (tamano del archivo,
 * formato por sus primeros bytes, dimensiones leidas de la CABECERA para rechazar bombas de descompresion antes de
 * decodificar nada) son puras y se prueban en Node. Lo unico que toca el navegador es `browserRasterizer`, que se puede
 * sustituir (`DecodeOptions.rasterizer`) para probar en Node con `@napi-rs/canvas`.
 *
 * Seguridad: el SVG se rasteriza con `<img src=blob:...>`, donde el navegador NO ejecuta scripts ni carga recursos
 * externos; nunca se inserta en el DOM como marcado.
 */

/** Peso maximo del archivo de entrada. */
export const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;
/** Por encima de esto (segun la cabecera) la imagen se rechaza sin decodificar. */
export const MAX_DECODE_PIXELS = 100_000_000;
/** Por encima de esto se decodifica YA reducida (una foto de 48 MP no hace falta a plena resolucion para una firma). */
export const MAX_WORK_PIXELS = 16_000_000;
/** Lado mayor al que se rasteriza un SVG (es vectorial: se pide nitido). */
export const VECTOR_LONG_SIDE = 2000;

export type InkFormat = "png" | "jpeg" | "webp" | "svg" | "heic";

export interface DecodedInkImage extends InkImage {
  data: Uint8ClampedArray;
  format: InkFormat;
  /** Dimensiones del archivo (de un SVG, las de su caja). */
  originalWidth: number;
  originalHeight: number;
  /** `true` si se decodifico a menos resolucion que la original (> `MAX_WORK_PIXELS`). */
  downscaled: boolean;
}

/** Lo que recibe un rasterizador: el archivo y lo que ya se sabe de el. */
export interface RasterRequest {
  format: InkFormat;
  /** Dimensiones leidas de la cabecera (`null` si no se pudieron: HEIC o un SVG sin caja). */
  width: number | null;
  height: number | null;
}

export interface RasterResult {
  image: InkImage & { data: Uint8ClampedArray };
  /** Dimensiones originales del archivo. */
  originalWidth: number;
  originalHeight: number;
}

export type Rasterizer = (file: Blob, request: RasterRequest) => Promise<RasterResult>;

export interface DecodeOptions {
  rasterizer?: Rasterizer;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Formato y cabecera                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif"]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Formato segun los PRIMEROS BYTES (no segun el nombre ni el `type` del archivo, que el usuario controla). */
export function sniffImageFormat(bytes: Uint8Array): InkFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(bytes, 8, 12))) return "heic";
  // SVG: texto con un elemento <svg> al principio (tras BOM, prologo XML, comentarios o DOCTYPE).
  const head = ascii(bytes, 0, Math.min(bytes.length, 4096));
  if (/^\s*(?:﻿|\xEF\xBB\xBF)?\s*(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return "svg";
  return null;
}

function readU16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const length = readU16(bytes, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: readU16(bytes, i + 5), width: readU16(bytes, i + 7) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const kind = ascii(bytes, 12, 16);
  if (kind === "VP8 " && bytes.length >= 30) {
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  return null;
}

/** HEIC: la mayor caja `ispe` (dimensiones de imagen) de las primeras bytes. */
function heicSize(bytes: Uint8Array): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  const limit = Math.min(bytes.length - 20, 512 * 1024);
  for (let i = 4; i < limit; i += 1) {
    if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
      const width = readU32(bytes, i + 8);
      const height = readU32(bytes, i + 12);
      if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { width, height };
    }
  }
  return best;
}

/** Numero con unidad opcional (`px`, `pt`...), `null` si falta o es un porcentaje. */
function svgLength(value: string | undefined): number | null {
  if (!value || value.includes("%")) return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function svgSize(bytes: Uint8Array): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(ascii(bytes, 0, Math.min(bytes.length, 16384)))?.[0];
  if (!tag) return null;
  const attribute = (name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  let width = svgLength(attribute("width"));
  let height = svgLength(attribute("height"));
  const box = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    if (width === null && height === null) {
      width = box[2];
      height = box[3];
    } else if (width === null && height !== null) {
      width = (height * box[2]) / box[3];
    } else if (height === null && width !== null) {
      height = (width * box[3]) / box[2];
    }
  }
  return width !== null && height !== null ? { width, height } : null;
}

/** Dimensiones segun la CABECERA del archivo, o `null` si no se pueden leer sin decodificar. */
export function readImageSize(bytes: Uint8Array, format: InkFormat): { width: number; height: number } | null {
  switch (format) {
    case "png":
      return bytes.length >= 24 ? { width: readU32(bytes, 16), height: readU32(bytes, 20) } : null;
    case "jpeg":
      return jpegSize(bytes);
    case "webp":
      return webpSize(bytes);
    case "heic":
      return heicSize(bytes);
    case "svg":
      return svgSize(bytes);
  }
}

/**
 * Tamano al que se rasteriza: un SVG, a `VECTOR_LONG_SIDE` por el lado mayor; el resto, a su tamano salvo que pase de
 * `MAX_WORK_PIXELS` (entonces se reduce conservando la proporcion).
 */
export function planRasterSize(width: number, height: number, format: InkFormat): { width: number; height: number; downscaled: boolean } {
  let scale = format === "svg" ? VECTOR_LONG_SIDE / Math.max(width, height) : 1;
  const pixels = width * height * scale * scale;
  if (pixels > MAX_WORK_PIXELS) scale *= Math.sqrt(MAX_WORK_PIXELS / pixels);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    downscaled: format !== "svg" && scale < 1,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Rasterizador del navegador                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

const IMAGE_LOAD_TIMEOUT_MS = 15_000;

function loadImageElement(blob: Blob, width: number | null, height: number | null): Promise<{ image: HTMLImageElement; release: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const release = () => URL.revokeObjectURL(url);
    const timer = setTimeout(() => {
      release();
      reject(new InkError("decode-failed"));
    }, IMAGE_LOAD_TIMEOUT_MS);
    image.onload = () => {
      clearTimeout(timer);
      resolve({ image, release });
    };
    image.onerror = () => {
      clearTimeout(timer);
      release();
      reject(new InkError("decode-failed"));
    };
    if (width && height) {
      image.width = width;
      image.height = height;
    }
    image.src = url;
  });
}

function createRasterCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Decodifica con las APIs del navegador (`createImageBitmap`, y `<img>` de respaldo y para SVG). */
export const browserRasterizer: Rasterizer = async (file, request) => {
  let source: CanvasImageSource;
  let naturalWidth: number;
  let naturalHeight: number;
  let release = () => {};
  if (request.format === "svg") {
    const known = request.width !== null && request.height !== null;
    const size = known ? planRasterSize(request.width as number, request.height as number, "svg") : null;
    const loaded = await loadImageElement(file, size?.width ?? null, size?.height ?? null);
    release = loaded.release;
    source = loaded.image;
    // Sin caja en el SVG, el navegador da su tamano natural (300 x 150 si no declara nada).
    naturalWidth = known ? (request.width as number) : loaded.image.naturalWidth || 300;
    naturalHeight = known ? (request.height as number) : loaded.image.naturalHeight || 150;
  } else {
    try {
      if (typeof createImageBitmap !== "function") throw new Error("sin createImageBitmap");
      const bitmap = await createImageBitmap(file);
      source = bitmap;
      naturalWidth = bitmap.width;
      naturalHeight = bitmap.height;
      release = () => bitmap.close();
    } catch {
      let loaded: Awaited<ReturnType<typeof loadImageElement>>;
      try {
        loaded = await loadImageElement(file, null, null);
      } catch {
        throw new InkError(request.format === "heic" ? "unsupported-format" : "decode-failed",
          request.format === "heic"
            ? "Este navegador no puede abrir imágenes HEIC. Prueba con JPG o PNG (o con Safari)."
            : undefined);
      }
      release = loaded.release;
      source = loaded.image;
      naturalWidth = loaded.image.naturalWidth;
      naturalHeight = loaded.image.naturalHeight;
    }
  }
  try {
    if (naturalWidth * naturalHeight > MAX_DECODE_PIXELS) throw new InkError("too-many-pixels");
    const target = planRasterSize(naturalWidth, naturalHeight, request.format);
    const canvas = createRasterCanvas(target.width, target.height);
    const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new InkError("decode-failed");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, target.width, target.height);
    const pixels = context.getImageData(0, 0, target.width, target.height);
    return {
      image: { width: target.width, height: target.height, data: pixels.data },
      originalWidth: naturalWidth,
      originalHeight: naturalHeight,
    };
  } catch (error) {
    if (error instanceof InkError) throw error;
    throw new InkError("decode-failed");
  } finally {
    release();
  }
};

/* ------------------------------------------------------------------------------------------------------------ */
/* API                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Lee el archivo de imagen a pixeles RGBA listos para `extractInk`. Rechaza (con `InkError` y codigo estable) archivos
 * vacios o de mas de 10 MB, formatos que no son PNG/JPG/WEBP/SVG/HEIC, imagenes con mas de 100 MP segun su cabecera
 * (SIN decodificarlas) y archivos que el navegador no abre. HEIC solo funciona donde el navegador lo decodifica (Safari).
 */
export async function decodeImageFile(file: Blob, options: DecodeOptions = {}): Promise<DecodedInkImage> {
  if (!file || file.size === 0) throw new InkError("empty-file");
  if (file.size > MAX_INPUT_FILE_BYTES) throw new InkError("file-too-large");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new InkError("decode-failed");
  }
  const format = sniffImageFormat(bytes);
  if (!format) throw new InkError("unsupported-format");
  const size = readImageSize(bytes, format);
  if (size && (size.width < 1 || size.height < 1)) throw new InkError("decode-failed");
  if (size && size.width * size.height > MAX_DECODE_PIXELS && format !== "svg") throw new InkError("too-many-pixels");
  const rasterizer = options.rasterizer ?? browserRasterizer;
  const raster = await rasterizer(file, { format, width: size?.width ?? null, height: size?.height ?? null });
  const { image } = raster;
  if (!(image.width >= 1 && image.height >= 1) || image.data.length < image.width * image.height * 4) throw new InkError("decode-failed");
  return {
    width: image.width,
    height: image.height,
    data: image.data,
    format,
    originalWidth: raster.originalWidth,
    originalHeight: raster.originalHeight,
    downscaled: format !== "svg" && image.width * image.height < raster.originalWidth * raster.originalHeight,
  };
}
