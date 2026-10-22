/**
 * Entorno de PRUEBAS en Node del orquestador: pdf.js «legacy» (sin worker de red) con las fuentes estandar y los decodificadores WASM
 * de `public/pdfjs-wasm/` (la misma ruta que usa la aplicacion), y canvas de `@napi-rs/canvas`. Solo para pruebas.
 */

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
};
