/**
 * Entorno de PRUEBAS en Node del orquestador: pdf.js «legacy» (sin worker de red) con las fuentes estandar y los decodificadores WASM
 * de `public/pdfjs-wasm/` (la misma ruta que usa la aplicacion), y canvas de `@napi-rs/canvas`. Solo para pruebas.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { WASM_DIR } from "../../images.testUtils";
import type { ExtractEnv } from "../../orchestrate";
import { STANDARD_FONTS_DIR, getLegacyOps, getLegacyPdfjs, napiSurfaceFactory } from "../annots/nodeEnv";

export const nodeExtractEnv: ExtractEnv = {
  openDocument: async (bytes) => {
    const pdfjs = await getLegacyPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_DIR, wasmUrl: WASM_DIR, verbosity: 0 });
    return (await task.promise) as unknown as PDFDocumentProxy;
  },
  closeDocument: async (doc) => {
    await doc.loadingTask.destroy();
  },
  ops: () => getLegacyOps(),
  createSurface: () => napiSurfaceFactory,
  // Node no tiene `createImageBitmap`: el JPEG se decodifica con @napi-rs/canvas y se reduce al dibujarlo.
  reduceJpeg: async (jpeg, source, maxSide) => {
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const image = await loadImage(Buffer.from(jpeg));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, width, height);
    return { width, height, data: new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data) };
  },
};
