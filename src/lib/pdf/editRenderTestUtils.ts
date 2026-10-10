import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { analyzeDocPageText } from "@/lib/pdf/textBlocks";
import type { TextBlock } from "@/lib/pdf/editTypes";

/**
 * Utilidades SOLO para pruebas (Node): renderizar un PDF a pixeles con pdf.js
 * "legacy" + `@napi-rs/canvas` y extraer bloques de texto reales con
 * `analyzeDocPageText`. Los tests de regresion de exportacion miden pixeles
 * del archivo de salida, no el estado interno del motor.
 */

export const STANDARD_FONTS_DIR = path.join(process.cwd(), "public", "standard_fonts") + "/";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
export function getPdfjsLegacy(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export type Raster = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Datos de pagina para `geometryFromPdfJsPage`. */
  page: { view: number[]; rotate: number };
  /** Escala con la que se renderizo (px por punto). */
  scale: number;
  /** Punto de usuario -> pixel. */
  toPx: (x: number, y: number) => { px: number; py: number };
};

export async function renderPages(bytes: Uint8Array, scale = 3): Promise<Raster[]> {
  const pdfjs = await getPdfjsLegacy();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONTS_DIR,
    verbosity: 0,
  });
  const pdf = await task.promise;
  try {
    const out: Raster[] = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      await page.render({ canvasContext: context, viewport } as never).promise;
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      out.push({
        width: canvas.width,
        height: canvas.height,
        data: image.data,
        page: { view: [...page.view], rotate: page.rotate },
        scale,
        toPx: (x, y) => {
          const [px, py] = viewport.convertToViewportPoint(x, y);
          return { px, py };
        },
      });
    }
    return out;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Contexto minimo con `getImageData` sobre un `Raster` (para `sampleCanvasBackground`). */
export function contextOf(image: Raster) {
  return {
    getImageData(x: number, y: number, w: number, h: number) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy += 1) {
        for (let xx = 0; xx < w; xx += 1) {
          const s = ((y + yy) * image.width + (x + xx)) * 4;
          const d = (yy * w + xx) * 4;
          data[d] = image.data[s];
          data[d + 1] = image.data[s + 1];
          data[d + 2] = image.data[s + 2];
          data[d + 3] = image.data[s + 3];
        }
      }
      return { data, width: w, height: h };
    },
  };
}

/** Pixeles de la region (px) que cumplen `predicate(r, g, b)`. */
export function countPixels(
  image: Raster,
  predicate: (r: number, g: number, b: number) => boolean,
  region?: { x0: number; y0: number; x1: number; y1: number },
): number {
  const r = region ?? { x0: 0, y0: 0, x1: image.width, y1: image.height };
  let total = 0;
  for (let y = Math.max(0, Math.floor(r.y0)); y < Math.min(image.height, Math.ceil(r.y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(r.x0)); x < Math.min(image.width, Math.ceil(r.x1)); x += 1) {
      const o = (y * image.width + x) * 4;
      if (predicate(image.data[o], image.data[o + 1], image.data[o + 2])) total += 1;
    }
  }
  return total;
}

export const isDarkPixel = (r: number, g: number, b: number) => r < 128 && g < 128 && b < 128;

/** Region (px) de una caja de usuario. */
export function regionOfBox(
  image: Raster,
  box: { x: number; y: number; width: number; height: number },
) {
  const a = image.toPx(box.x, box.y);
  const b = image.toPx(box.x + box.width, box.y + box.height);
  return {
    x0: Math.min(a.px, b.px),
    x1: Math.max(a.px, b.px),
    y0: Math.min(a.py, b.py),
    y1: Math.max(a.py, b.py),
  };
}

/** Bloques de la primera pagina de `bytes`, extraidos con el motor de produccion. */
export async function extractBlocks(bytes: Uint8Array, pageIndex = 0): Promise<TextBlock[]> {
  const pdfjs = await getPdfjsLegacy();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONTS_DIR,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const analysis = await analyzeDocPageText(doc as never, pageIndex, {
      OPS: pdfjs.OPS as never,
    });
    return analysis.blocks;
  } finally {
    await task.destroy();
  }
}
