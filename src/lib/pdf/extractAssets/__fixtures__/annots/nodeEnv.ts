/**
 * Entorno de PRUEBAS en Node para el motor de anotaciones: pdf.js «legacy», superficies de `@napi-rs/canvas` y utilidades para leer
 * el PNG que sale. Solo lo usan las pruebas (no la aplicacion).
 */

import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PdfDocument, PdfOps, Surface, SurfaceFactory, RasterImage } from "../../annotationsTypes";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
export function getLegacyPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export const STANDARD_FONTS_DIR = path.join(process.cwd(), "public", "standard_fonts") + "/";

export async function getLegacyOps(): Promise<PdfOps> {
  return (await getLegacyPdfjs()).OPS as unknown as PdfOps;
}

/** Superficie de `@napi-rs/canvas` con la forma que espera el motor. */
export const napiSurfaceFactory: SurfaceFactory = (width, height): Surface => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  return { width, height, context: context as unknown as Surface["context"], release: () => undefined };
};

/** Abre un PDF con pdf.js legacy (en Node, sin worker de red). */
export async function openLegacyDocument(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await getLegacyPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_DIR, verbosity: 0 });
  return (await task.promise) as unknown as PdfDocument;
}

export async function withLegacyDocument<T>(bytes: Uint8Array, run: (doc: PdfDocument) => Promise<T>): Promise<T> {
  const doc = await openLegacyDocument(bytes);
  try {
    return await run(doc);
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** Decodifica un PNG (Blob) a pixeles RGBA. */
export async function decodePng(blob: Blob): Promise<RasterImage> {
  const buffer = Buffer.from(await blob.arrayBuffer());
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(data) };
}

/** `true` si los primeros bytes son los de un PNG. */
export async function isPng(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
}
