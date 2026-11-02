import type { OutputFormat } from "@/lib/media/image/formats";

/**
 * Tamanos y limites del convertidor de imagenes. Todo puro: la decision de «cuanto mide la salida» y «se atreve el
 * dispositivo con esta imagen» se toma aqui, sin lienzo, para poder probarla en Node y para que el aviso salga ANTES de
 * decodificar (una PNG de 20000 x 20000 px pesa poco y reventaria la memoria al abrirla).
 */

export type ConvertLimits = {
  /** Peso maximo de un archivo de entrada. Por encima no se intenta abrir. */
  maxFileBytes: number;
  /** Pixeles maximos de una imagen de entrada (ancho x alto). */
  maxInputPixels: number;
  /** Pixeles maximos del lienzo donde se dibuja la salida. */
  maxCanvasPixels: number;
  /** Lado maximo de ese lienzo. */
  maxCanvasSide: number;
  /** Peso total de las salidas de una tanda: el ZIP se arma en memoria. */
  maxBatchOutputBytes: number;
};

const MB = 1024 * 1024;

export const DESKTOP_LIMITS: ConvertLimits = {
  maxFileBytes: 64 * MB,
  maxInputPixels: 100_000_000,
  maxCanvasPixels: 64_000_000,
  maxCanvasSide: 16_384,
  maxBatchOutputBytes: 800 * MB,
};

/**
 * Safari de iPhone/iPad: un lienzo de mas de ~16,7 Mpx puede salir EN BLANCO sin error (mismos topes que `prepareForPdf.ts`) y la
 * pagina se cierra por memoria mucho antes que en un ordenador.
 */
export const IOS_LIMITS: ConvertLimits = {
  maxFileBytes: 32 * MB,
  maxInputPixels: 48_000_000,
  maxCanvasPixels: 16_000_000,
  maxCanvasSide: 4096,
  maxBatchOutputBytes: 300 * MB,
};

export function limitsFor(ios: boolean): ConvertLimits {
  return ios ? IOS_LIMITS : DESKTOP_LIMITS;
}

/** Un BMP de 24 bits pesa 3 bytes por pixel y se arma con una copia de los pixeles: se acota antes que los demas. */
export const BMP_MAX_PIXELS = 24_000_000;

export function canvasPixelsFor(format: OutputFormat, limits: ConvertLimits): number {
  return format === "bmp" ? Math.min(limits.maxCanvasPixels, BMP_MAX_PIXELS) : limits.maxCanvasPixels;
}

/** Como cambia el tamano. Nunca amplia: el mayor valor posible es el tamano original. */
export type ResizeSpec =
  | { mode: "original" }
  | { mode: "maxWidth"; maxWidth: number }
  | { mode: "percent"; percent: number };

export const MIN_MAX_WIDTH = 16;
export const MAX_MAX_WIDTH = 32_000;

export type OutputSize = {
  width: number;
  height: number;
  /** El tamano de salida es distinto del de entrada. */
  resized: boolean;
  /** La salida se redujo MAS de lo pedido para caber en el lienzo de este dispositivo. */
  capped: boolean;
};

/** Escala pedida (0 < s <= 1) por la persona; un valor no valido deja la imagen como esta. */
function requestedScale(width: number, resize: ResizeSpec): number {
  if (resize.mode === "maxWidth") {
    const wanted = Math.floor(resize.maxWidth);
    if (!Number.isFinite(wanted) || wanted < 1) return 1;
    return Math.min(1, wanted / width);
  }
  if (resize.mode === "percent") {
    if (!Number.isFinite(resize.percent) || resize.percent <= 0) return 1;
    return Math.min(1, resize.percent / 100);
  }
  return 1;
}

/**
 * Tamano de salida para una imagen YA orientada de `width` x `height`, con la proporcion conservada y sin ampliar. `maxPixels`
 * y `maxSide` son los topes del lienzo; si hay que bajar mas de lo pedido, `capped` lo dice (se avisa en el resultado).
 */
export function computeOutputSize(
  width: number,
  height: number,
  resize: ResizeSpec,
  caps: { maxPixels: number; maxSide: number },
): OutputSize {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const wanted = requestedScale(w, resize);
  let scale = wanted;
  scale = Math.min(scale, caps.maxSide / Math.max(w, h));
  scale = Math.min(scale, Math.sqrt(caps.maxPixels / (w * h)));
  const capped = scale < wanted - 1e-9;
  if (!(scale < 1)) return { width: w, height: h, resized: false, capped: false };
  // Reducir por el tope del lienzo redondea hacia abajo: redondear al mas cercano podia pasarse un par de pixeles del tope.
  const round = capped ? Math.floor : Math.round;
  const outW = Math.min(caps.maxSide, Math.max(1, round(w * scale)));
  const outH = Math.min(caps.maxSide, Math.max(1, round(h * scale)));
  return { width: outW, height: outH, resized: outW !== w || outH !== h, capped };
}

/** Megapixeles con un decimal, para los avisos («48,2 Mpx»). */
export function megapixels(width: number, height: number): number {
  return Math.round((width * height) / 100_000) / 10;
}
