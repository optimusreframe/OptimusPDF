import { createCanvas, ImageData, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { ExifOrientation } from "@/lib/pdf/jpegOrientation";
import type { DecodeRequest, PrepareBackend, Raster, TranscodeRunner } from "@/lib/image/prepareForPdf";
import { fitWithin, transcodeImage } from "@/lib/image/prepareForPdf";

/**
 * Utilidades SOLO para pruebas (Node, `@napi-rs/canvas`) de la preparacion de fotos: fotos SINTETICAS con textura y bordes
 * (ninguna foto real), JPEG con etiqueta EXIF, un backend de Node que implementa `PrepareBackend` (en el navegador lo hace
 * `prepareBackend.ts`) y las metricas PSNR / SSIM con las que se mide que la version ligera se ve igual que la original.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Foto sintetica                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SyntheticPhotoOptions = {
  width: number;
  height: number;
  seed?: number;
  /** Desviacion tipica del grano fino (niveles de 0 a 255) a la resolucion ORIGINAL: 3 = foto de movil con detalle; 9+ = muy ruidosa (estres). */
  grain?: number;
  /** Amplitud de la textura de media frecuencia (hojas, tejas, asfalto), niveles de 0 a 255 (40 por defecto). */
  texture?: number;
};

/** Ruido de valor suave (bilineal) sobre una rejilla de lado `cell` pixeles. */
function valueNoise(lattice: Float32Array, size: number, x: number, y: number, cell: number): number {
  const fx = x / cell;
  const fy = y / cell;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (ix: number, iy: number): number => lattice[((iy & (size - 1)) * size + (ix & (size - 1))) | 0];
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Foto sintetica reproducible: degradado de cielo a suelo, decenas de formas con bordes nitidos y suaves, textura de
 * media frecuencia y grano fino. Lo bastante parecida a una foto (energia a todas las escalas, bordes, zonas lisas) para
 * que el JPEG pese lo que pesa una foto y el PSNR/SSIM sean significativos.
 */
export function drawSyntheticPhoto(options: SyntheticPhotoOptions): Canvas {
  const { width, height } = options;
  const random = mulberry32(options.seed ?? 1);
  const grain = options.grain ?? 3;
  const textureAmplitude = options.texture ?? 40;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const short = Math.min(width, height);

  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, `rgb(${90 + random() * 40},${140 + random() * 40},${200 + random() * 40})`);
  sky.addColorStop(0.55, `rgb(${180 + random() * 40},${170 + random() * 40},${150 + random() * 40})`);
  sky.addColorStop(1, `rgb(${60 + random() * 40},${70 + random() * 40},${50 + random() * 40})`);
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  for (let index = 0; index < 70; index += 1) {
    const cx = random() * width;
    const cy = random() * height;
    const radius = short * (0.02 + random() * 0.18);
    const hue = Math.floor(random() * 255);
    context.globalAlpha = 0.45 + random() * 0.55;
    context.fillStyle = `rgb(${(hue * 7) % 256},${(hue * 13 + 60) % 256},${(hue * 29 + 30) % 256})`;
    context.beginPath();
    if (index % 3 === 0) {
      context.ellipse(cx, cy, radius, radius * (0.4 + random() * 0.8), random() * Math.PI, 0, Math.PI * 2);
    } else if (index % 3 === 1) {
      context.save();
      context.translate(cx, cy);
      context.rotate(random() * Math.PI);
      context.rect(-radius, -radius * 0.6, radius * 2, radius * 1.2);
      context.restore();
    } else {
      context.moveTo(cx, cy - radius);
      context.lineTo(cx + radius, cy + radius * 0.8);
      context.lineTo(cx - radius, cy + radius * 0.6);
      context.closePath();
    }
    context.fill();
  }
  context.globalAlpha = 1;

  // Textura de media frecuencia + grano: se suman por pixel (por bandas, para no duplicar toda la imagen en memoria).
  const size = 256;
  const lattice = new Float32Array(size * size);
  for (let index = 0; index < lattice.length; index += 1) lattice[index] = random() * 2 - 1;
  const lattice2 = new Float32Array(size * size);
  for (let index = 0; index < lattice2.length; index += 1) lattice2[index] = random() * 2 - 1;
  const coarse = Math.max(8, short / 90);
  const fine = Math.max(3, short / 500);
  const band = 256;
  for (let y0 = 0; y0 < height; y0 += band) {
    const rows = Math.min(band, height - y0);
    const image = context.getImageData(0, y0, width, rows);
    const data = image.data;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const wobble =
          textureAmplitude * (0.7 * valueNoise(lattice, size, x, y0 + y, coarse) + 0.5 * valueNoise(lattice2, size, x, y0 + y, fine));
        // Grano ~ gaussiano (suma de tres uniformes).
        const noise = grain * (random() + random() + random() - 1.5) * 1.15;
        const delta = wobble + noise;
        data[at] = Math.max(0, Math.min(255, data[at] + delta));
        data[at + 1] = Math.max(0, Math.min(255, data[at + 1] + delta * 0.9));
        data[at + 2] = Math.max(0, Math.min(255, data[at + 2] + delta * 1.1));
      }
    }
    context.putImageData(image, 0, y0);
  }
  return canvas;
}

/** JPEG (calidad 0..100) de una foto sintetica, con etiqueta EXIF de orientacion opcional (los pixeles quedan «de lado»). */
export function makeSyntheticJpeg(options: SyntheticPhotoOptions & { quality?: number; orientation?: ExifOrientation }): Buffer {
  const canvas = drawSyntheticPhoto(options);
  const jpeg = canvas.toBuffer("image/jpeg", options.quality ?? 92);
  return options.orientation && options.orientation !== 1 ? withExifOrientation(jpeg, options.orientation) : jpeg;
}

/** Inserta un APP1/Exif minimo con la orientacion justo despues de SOI. */
export function withExifOrientation(jpeg: Buffer, orientation: ExifOrientation): Buffer {
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, length >> 8, length & 255, ...body]), jpeg.subarray(2)]);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Metricas                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

/** PSNR (dB) sobre los canales R, G y B (el alfa no cuenta). Infinito si son identicas. */
export function psnr(a: Pixels, b: Pixels): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("PSNR: tamanos distintos");
  let sum = 0;
  const count = a.width * a.height;
  for (let index = 0; index < count; index += 1) {
    const at = index * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const d = a.data[at + channel] - b.data[at + channel];
      sum += d * d;
    }
  }
  const mse = sum / (count * 3);
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

/**
 * SSIM medio sobre la luminancia, por ventanas de 8x8 con paso 4 (la variante habitual de bloques; C1 = (0,01·255)²,
 * C2 = (0,03·255)²). 1 = identicas.
 */
export function ssim(a: Pixels, b: Pixels): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("SSIM: tamanos distintos");
  const { width, height } = a;
  const lumaA = new Float32Array(width * height);
  const lumaB = new Float32Array(width * height);
  for (let index = 0; index < lumaA.length; index += 1) {
    const at = index * 4;
    lumaA[index] = 0.299 * a.data[at] + 0.587 * a.data[at + 1] + 0.114 * a.data[at + 2];
    lumaB[index] = 0.299 * b.data[at] + 0.587 * b.data[at + 1] + 0.114 * b.data[at + 2];
  }
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const win = 8;
  const step = 4;
  let total = 0;
  let blocks = 0;
  for (let y = 0; y + win <= height; y += step) {
    for (let x = 0; x + win <= width; x += step) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let dy = 0; dy < win; dy += 1) {
        const row = (y + dy) * width + x;
        for (let dx = 0; dx < win; dx += 1) {
          const va = lumaA[row + dx];
          const vb = lumaB[row + dx];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const n = win * win;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      blocks += 1;
    }
  }
  return blocks === 0 ? 1 : total / blocks;
}

export async function decodeToPixels(bytes: Uint8Array | Buffer): Promise<Pixels> {
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data: data.data };
}

/** La imagen `source` (ya derecha) reducida a `width` x `height` con el mismo reductor que usa el backend de pruebas. */
export function reducePixels(source: Pixels, width: number, height: number): Pixels {
  const input = createCanvas(source.width, source.height);
  input.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(source.data), source.width, source.height), 0, 0);
  const output = createCanvas(width, height);
  const context = output.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(input, 0, 0, source.width, source.height, 0, 0, width, height);
  return { width, height, data: context.getImageData(0, 0, width, height).data };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Backend de Node                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

export type NodeBackendStats = {
  decodes: number;
  /** Rasters creados y aun sin liberar: debe volver a 0. */
  live: number;
  maxLive: number;
  /** Mayor lienzo creado (lado y area). */
  maxSide: number;
  maxPixels: number;
  encodes: number;
};

/** Backend de `prepareForPdf.ts` sobre `@napi-rs/canvas` (en el navegador lo hace `prepareBackend.ts`). */
export function createNodeBackend(stats?: NodeBackendStats): PrepareBackend {
  const track = stats ?? { decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 };
  return {
    async decode(source: Blob, request: DecodeRequest): Promise<Raster | null> {
      const bytes = Buffer.from(await source.arrayBuffer());
      let image;
      try {
        image = await loadImage(bytes);
      } catch {
        return null;
      }
      // Skia ya aplica la orientacion EXIF al decodificar (como el navegador con `imageOrientation: "from-image"`).
      const displayWidth = image.width;
      const displayHeight = image.height;
      const target = fitWithin(displayWidth, displayHeight, request.maxSide, request.maxPixels);
      const canvas = createCanvas(target.width, target.height);
      const context: SKRSContext2D = canvas.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, displayWidth, displayHeight, 0, 0, target.width, target.height);
      track.decodes += 1;
      track.live += 1;
      track.maxLive = Math.max(track.maxLive, track.live);
      track.maxSide = Math.max(track.maxSide, target.width, target.height);
      track.maxPixels = Math.max(track.maxPixels, target.width * target.height);
      let released = false;
      return {
        width: target.width,
        height: target.height,
        rows: (from, to) => context.getImageData(0, from, target.width, to - from).data,
        async encode(format, quality, flatten) {
          track.encodes += 1;
          if (flatten) {
            context.globalCompositeOperation = "destination-over";
            context.fillStyle = "#fff";
            context.fillRect(0, 0, target.width, target.height);
            context.globalCompositeOperation = "source-over";
          }
          return new Uint8Array(format === "jpeg" ? canvas.toBuffer("image/jpeg", Math.round(quality * 100)) : canvas.toBuffer("image/png"));
        },
        release() {
          if (released) return;
          released = true;
          track.live -= 1;
        },
      };
    },
  };
}

/** `TranscodeRunner` de Node para `prepareImage` (sin worker). */
export function createNodeRunner(stats?: NodeBackendStats): TranscodeRunner {
  const backend = createNodeBackend(stats);
  return (source, plan, signal) => transcodeImage(source, plan, backend, signal);
}
