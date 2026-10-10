/**
 * Metricas de nitidez para comparar lo que PINTA la aplicacion con lo que
 * renderiza pdf.js de forma nativa (W6-A): SSIM por bloques sobre luminancia,
 * diferencia media absoluta y energia de gradiente. Todo en Node con
 * `@napi-rs/canvas` (sin dependencias nuevas).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsModule = any;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function getPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
        path.resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
      ).href;
      return pdfjsLib;
    })();
  }
  return pdfjsPromise;
}

export type Gray = { data: Float32Array; width: number; height: number };

function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let index = 0; index < data.length; index += 1) {
    const o = index * 4;
    // Sobre blanco: el alfa mezcla con 255.
    const a = rgba[o + 3] / 255;
    const r = rgba[o] * a + 255 * (1 - a);
    const g = rgba[o + 1] * a + 255 * (1 - a);
    const b = rgba[o + 2] * a + 255 * (1 - a);
    data[index] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { data, width, height };
}

/** Renderiza la pagina con pdf.js nativo para que mida `targetWidthPx` de ancho y la devuelve en grises. */
export async function renderReferenceGray(
  bytes: Uint8Array | Buffer,
  pageNumber: number,
  targetWidthPx: number,
): Promise<Gray> {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: targetWidthPx / base.width });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return toGray(image.data, canvas.width, canvas.height);
  } finally {
    await task.destroy();
  }
}

/** Decodifica un PNG (captura de Playwright) a grises. */
export async function decodePngGray(png: Buffer): Promise<Gray> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height);
  return toGray(data.data, image.width, image.height);
}

/** Recorta un margen (px) de cada lado. */
export function crop(gray: Gray, x: number, y: number, width: number, height: number): Gray {
  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const from = (y + row) * gray.width + x;
    out.set(gray.data.subarray(from, from + width), row * width);
  }
  return { data: out, width, height };
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** SSIM medio sobre bloques de 8x8 (sin solapar): 1 = identicas. */
export function ssim(a: Gray, b: Gray, block = 8): number {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  let total = 0;
  let count = 0;
  for (let by = 0; by + block <= height; by += block) {
    for (let bx = 0; bx + block <= width; bx += block) {
      let sumA = 0;
      let sumB = 0;
      for (let y = 0; y < block; y += 1) {
        for (let x = 0; x < block; x += 1) {
          sumA += a.data[(by + y) * a.width + bx + x];
          sumB += b.data[(by + y) * b.width + bx + x];
        }
      }
      const n = block * block;
      const meanA = sumA / n;
      const meanB = sumB / n;
      let varA = 0;
      let varB = 0;
      let cov = 0;
      for (let y = 0; y < block; y += 1) {
        for (let x = 0; x < block; x += 1) {
          const da = a.data[(by + y) * a.width + bx + x] - meanA;
          const db = b.data[(by + y) * b.width + bx + x] - meanB;
          varA += da * da;
          varB += db * db;
          cov += da * db;
        }
      }
      varA /= n - 1;
      varB /= n - 1;
      cov /= n - 1;
      total +=
        ((2 * meanA * meanB + C1) * (2 * cov + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

export function meanAbsDiff(a: Gray, b: Gray): number {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  let sum = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      sum += Math.abs(a.data[y * a.width + x] - b.data[y * b.width + x]);
    }
  }
  return sum / Math.max(1, width * height);
}

/** Energia media del gradiente: lo nitido tiene mas que lo borroso. */
export function gradientEnergy(gray: Gray): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < gray.height - 1; y += 1) {
    for (let x = 0; x < gray.width - 1; x += 1) {
      const dx = gray.data[y * gray.width + x + 1] - gray.data[y * gray.width + x];
      const dy = gray.data[(y + 1) * gray.width + x] - gray.data[y * gray.width + x];
      sum += Math.sqrt(dx * dx + dy * dy);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

export type Comparison = {
  ssim: number;
  meanAbsDiff: number;
  /** Energia de gradiente de la captura / la de la referencia (1 = igual de nitida). */
  sharpnessRatio: number;
  shift: { x: number; y: number };
};

/**
 * Compara una captura con la referencia buscando el desplazamiento entero (|d| <= `maxShift`)
 * que mejor las alinea (una captura con coordenadas fraccionarias no cae en el mismo pixel).
 * Se recorta `margin` px de cada lado (esquinas redondeadas, sombras).
 */
export function compareImages(
  shot: Gray,
  reference: Gray,
  options: { margin?: number; maxShift?: number } = {},
): Comparison {
  const margin = options.margin ?? 14;
  const maxShift = options.maxShift ?? 3;
  let best: Comparison | null = null;
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      const width = Math.min(shot.width, reference.width) - 2 * margin - 2 * maxShift;
      const height = Math.min(shot.height, reference.height) - 2 * margin - 2 * maxShift;
      if (width < 16 || height < 16) continue;
      const a = crop(shot, margin + maxShift + dx, margin + maxShift + dy, width, height);
      const b = crop(reference, margin + maxShift, margin + maxShift, width, height);
      const value = ssim(a, b);
      if (!best || value > best.ssim) {
        best = {
          ssim: value,
          meanAbsDiff: meanAbsDiff(a, b),
          sharpnessRatio: gradientEnergy(a) / Math.max(1e-6, gradientEnergy(b)),
          shift: { x: dx, y: dy },
        };
      }
    }
  }
  if (!best) throw new Error("Las imagenes son demasiado pequenas para comparar.");
  return best;
}
