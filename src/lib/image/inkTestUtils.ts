import { createCanvas, ImageData, loadImage } from "@napi-rs/canvas";
import { planRasterSize, type InkColor, type InkImage, type Rasterizer } from "./inkExtract";

/**
 * Utilidades SOLO para pruebas (Node, `@napi-rs/canvas`): firmas SINTETICAS con su mascara de cobertura verdadera, papeles
 * con sombra, ruido, JPEG con artefactos y el rasterizador de Node para `decodeImageFile`. Ningun dato real: la «firma» es
 * una curva con bucles generada por formula, y la verdad (la cobertura de cada pixel) sale del propio dibujo antialias.
 */

/** Tinta casi negra con un matiz azul, la de las pruebas por defecto. */
export const NEAR_BLACK_FOR_TESTS = { r: 10, g: 10, b: 40 };

export interface Coverage {
  width: number;
  height: number;
  /** Cobertura de tinta por pixel, 0..1 (el alfa del dibujo antialias). */
  cover: Float32Array;
}

export interface SignatureShape {
  width: number;
  height: number;
  /** Grosor del trazo en pixeles (puede ser 1). */
  lineWidth: number;
  /** Con `false` no se dibuja el subrayado. */
  underline?: boolean;
}

/** Firma sintetica: una curva con bucles y un subrayado, dibujada con antialias sobre transparente. */
export function drawSignature(shape: SignatureShape): Coverage {
  const { width, height, lineWidth } = shape;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.strokeStyle = "#000";
  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  const margin = Math.max(lineWidth * 2, Math.round(width * 0.06));
  const loops = 4;
  context.beginPath();
  const steps = 400;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = margin + t * (width - 2 * margin) + Math.sin(2 * Math.PI * loops * t) * height * 0.16;
    const y = height * 0.46 + Math.cos(2 * Math.PI * loops * t) * height * 0.26 * (1 - 0.35 * t);
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
  if (shape.underline !== false) {
    context.beginPath();
    context.moveTo(width * 0.18, height * 0.86);
    context.quadraticCurveTo(width * 0.55, height * 0.8, width * 0.92, height * 0.88);
    context.stroke();
  }
  const pixels = context.getImageData(0, 0, width, height).data;
  const cover = new Float32Array(width * height);
  for (let i = 0; i < cover.length; i += 1) cover[i] = pixels[i * 4 + 3] / 255;
  return { width, height, cover };
}

/** Papel: color (r, g, b) de cada pixel sin tinta. */
export type Paper = (x: number, y: number, width: number, height: number) => [number, number, number];

export const WHITE_PAPER: Paper = () => [255, 255, 255];
/** Degradado fuerte de izquierda (255) a derecha (150) y una banda de sombra diagonal al 72 %. */
export const SHADED_PAPER: Paper = (x, y, width, height) => {
  const gradient = 255 - 105 * (x / width);
  const diagonal = (x / width + y / height) / 2;
  const shadow = diagonal > 0.35 && diagonal < 0.55 ? 0.72 : 1;
  const v = gradient * shadow;
  return [v, v * 0.98, v * 0.93];
};
/** Papel crema con vineta suave (foto de movil): las esquinas quedan ~22 % mas oscuras. */
export const WARM_PAPER: Paper = (x, y, width, height) => {
  const dx = x / width - 0.5;
  const dy = y / height - 0.5;
  const vignette = 1 - 0.22 * (dx * dx + dy * dy) * 2;
  return [250 * vignette, 244 * vignette, 224 * vignette];
};

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Compone papel + tinta segun la cobertura, con ruido gaussiano opcional (semilla fija: reproducible). */
export function composePhoto(
  coverage: Coverage,
  options: { ink: InkColor; paper?: Paper; noise?: number; seed?: number; illuminateInk?: boolean },
): InkImage & { data: Uint8ClampedArray } {
  const { width, height, cover } = coverage;
  const paper = options.paper ?? WHITE_PAPER;
  const random = lcg(options.seed ?? 7);
  const sigma = options.noise ?? 0;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const [pr, pg, pb] = paper(x, y, width, height);
      const c = cover[i];
      let n = 0;
      if (sigma > 0) n = Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random()) * sigma;
      // `illuminateInk`: la sombra oscurece tambien la tinta (pixel = luz * reflectancia), como en una foto de verdad.
      const lr = options.illuminateInk ? pr / 255 : 1;
      const lg = options.illuminateInk ? pg / 255 : 1;
      const lb = options.illuminateInk ? pb / 255 : 1;
      data[i * 4] = options.illuminateInk ? lr * (255 * (1 - c) + options.ink.r * c) + n : pr * (1 - c) + options.ink.r * c + n;
      data[i * 4 + 1] = options.illuminateInk ? lg * (255 * (1 - c) + options.ink.g * c) + n : pg * (1 - c) + options.ink.g * c + n;
      data[i * 4 + 2] = options.illuminateInk ? lb * (255 * (1 - c) + options.ink.b * c) + n : pb * (1 - c) + options.ink.b * c + n;
      data[i * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Pasa la imagen por un JPEG de la calidad dada (artefactos de bloque y de color reales) y la devuelve decodificada. */
export async function throughJpeg(image: InkImage, quality: number): Promise<InkImage & { data: Uint8ClampedArray }> {
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const bytes = canvas.toBuffer("image/jpeg", quality);
  const decoded = await loadImage(bytes);
  const back = createCanvas(image.width, image.height);
  const backContext = back.getContext("2d");
  backContext.drawImage(decoded, 0, 0);
  const pixels = backContext.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(pixels.data) };
}

/** Codifica pixeles RGBA a PNG con el canvas de Node (para construir archivos de entrada). */
export function toPngFile(image: InkImage, name = "firma.png"): File {
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return new File([new Uint8Array(canvas.toBuffer("image/png"))], name, { type: "image/png" });
}

export function toJpegFile(image: InkImage, quality = 60, name = "firma.jpg"): File {
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return new File([new Uint8Array(canvas.toBuffer("image/jpeg", quality))], name, { type: "image/jpeg" });
}

/** Rasterizador de Node: lo mismo que hace `browserRasterizer`, con `loadImage` de `@napi-rs/canvas` (tambien lee SVG). */
export const nodeRasterizer: Rasterizer = async (file, request) => {
  const bytes = Buffer.from(await file.arrayBuffer());
  const image = await loadImage(bytes);
  const naturalWidth = request.width ?? image.width;
  const naturalHeight = request.height ?? image.height;
  const target = planRasterSize(naturalWidth, naturalHeight, request.format);
  const canvas = createCanvas(target.width, target.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, target.width, target.height);
  const pixels = context.getImageData(0, 0, target.width, target.height);
  return {
    image: { width: target.width, height: target.height, data: new Uint8ClampedArray(pixels.data) },
    originalWidth: naturalWidth,
    originalHeight: naturalHeight,
  };
};

/** Dilatacion cuadrada (distancia de Chebyshev <= `radius`) de una mascara booleana. */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = 0;
      for (let dx = -radius; dx <= radius && !hit; dx += 1) {
        const xx = x + dx;
        if (xx >= 0 && xx < width && mask[y * width + xx]) hit = 1;
      }
      horizontal[y * width + x] = hit;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = 0;
      for (let dy = -radius; dy <= radius && !hit; dy += 1) {
        const yy = y + dy;
        if (yy >= 0 && yy < height && horizontal[yy * width + x]) hit = 1;
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

export interface Metrics {
  /** Fraccion de pixeles de FONDO verdadero (sin cobertura y a >= 2 px de cualquier trazo) con alfa <= `backgroundAlpha`. */
  backgroundTransparent: number;
  /** Fraccion de pixeles de TINTA verdadera (cobertura >= 0,5) con alfa >= `inkAlpha`. */
  inkKept: number;
  backgroundPixels: number;
  inkPixels: number;
}

/**
 * Compara un resultado SIN recortar ni reducir (`crop: "none"`, escala 1: mismas dimensiones que la verdad) con la
 * cobertura verdadera.
 */
export function measure(
  result: InkImage,
  truth: Coverage,
  options: { backgroundAlpha?: number; inkAlpha?: number } = {},
): Metrics {
  if (result.width !== truth.width || result.height !== truth.height) throw new Error("measure: dimensiones distintas");
  const backgroundAlpha = options.backgroundAlpha ?? 0;
  const inkAlpha = options.inkAlpha ?? 128;
  const any = new Uint8Array(truth.cover.length);
  for (let i = 0; i < any.length; i += 1) any[i] = truth.cover[i] > 0 ? 1 : 0;
  const near = dilate(any, truth.width, truth.height, 2);
  let backgroundPixels = 0;
  let backgroundOk = 0;
  let inkPixels = 0;
  let inkOk = 0;
  for (let i = 0; i < truth.cover.length; i += 1) {
    const alpha = result.data[i * 4 + 3];
    if (!near[i]) {
      backgroundPixels += 1;
      if (alpha <= backgroundAlpha) backgroundOk += 1;
    } else if (truth.cover[i] >= 0.5) {
      inkPixels += 1;
      if (alpha >= inkAlpha) inkOk += 1;
    }
  }
  return {
    backgroundTransparent: backgroundPixels ? backgroundOk / backgroundPixels : 1,
    inkKept: inkPixels ? inkOk / inkPixels : 1,
    backgroundPixels,
    inkPixels,
  };
}
