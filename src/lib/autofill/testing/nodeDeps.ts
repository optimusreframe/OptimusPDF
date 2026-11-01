/**
 * Dependencias del motor para las PRUEBAS (Node): pdf.js en su build «legacy», decodificacion de imagenes y rasterizado con
 * `@napi-rs/canvas`, y un OCR simulado. Nada de esto entra en el paquete de la aplicacion (solo lo importan pruebas).
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EngineDeps, RecognizeOptions } from "@/lib/autofill/engine";
import { wrapPdfJs, type PdfSession } from "@/lib/autofill/pdfSession";
import type { CoverageOps } from "@/lib/pdf/pageTextKind";
import type { OcrResult } from "@/lib/scan/ocr";
import type { Rgba } from "@/lib/scan/pixels";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
export function legacyPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export const STANDARD_FONTS_DIR = `${process.cwd()}/public/standard_fonts/`;

/** Abre bytes de PDF con pdf.js «legacy»; `rasterize` dibuja la pagina con `@napi-rs/canvas` (OCR de paginas escaneadas). */
export async function openNodePdf(bytes: Uint8Array, rasterize = true): Promise<PdfSession> {
  const pdfjs = await legacyPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: STANDARD_FONTS_DIR });
  const pdf = (await task.promise) as unknown as PDFDocumentProxy;
  return wrapPdfJs(pdf, {
    ops: pdfjs.OPS as unknown as CoverageOps,
    rasterize: rasterize
      ? async (page) => {
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
          await page.render({ canvasContext: context, viewport } as never).promise;
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          return { data: new Uint8ClampedArray(image.data), width: canvas.width, height: canvas.height };
        }
      : undefined,
    close: async () => {
      await task.destroy();
    },
  });
}

/** PNG/JPEG -> pixeles RGBA. */
export async function decodeWithCanvas(bytes: Uint8Array): Promise<Rgba> {
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height);
  return { data: new Uint8ClampedArray(data.data), width: image.width, height: image.height };
}

export type NodeDepsOptions = {
  /** OCR simulado; sin el, el modelo cuenta como no disponible. */
  recognize?: (image: Rgba, options: RecognizeOptions) => Promise<OcrResult>;
  rasterize?: boolean;
  ocrTimeoutMs?: number;
  /** Cuenta de reconocimientos hechos (para comprobar que el OCR solo se usa cuando hace falta). */
  onRecognize?: () => void;
  onReset?: () => void;
};

export function nodeDeps(options: NodeDepsOptions = {}): EngineDeps {
  return {
    openPdf: async (file) => openNodePdf(new Uint8Array(await file.arrayBuffer()), options.rasterize ?? true),
    decodeImage: async (file) => decodeWithCanvas(new Uint8Array(await file.arrayBuffer())),
    ocrAvailable: async () => options.recognize !== undefined,
    recognize: async (image, o) => {
      options.onRecognize?.();
      if (!options.recognize) throw new Error("sin OCR");
      return options.recognize(image, o);
    },
    resetOcr: async () => {
      options.onReset?.();
    },
    ocrTimeoutMs: options.ocrTimeoutMs,
  };
}
