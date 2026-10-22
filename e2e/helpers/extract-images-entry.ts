/**
 * Punto de entrada que Vite empaqueta (IIFE) para inyectar el motor de imagenes de «Extraer elementos» (U7.1) en una
 * pagina real de la app y probarlo en Chromium y WebKit: pdf.js con su worker y los decodificadores WASM de
 * `public/pdfjs-wasm/` (U7.0), el corpus sintetico (pdf-lib) y las metricas. Solo para las pruebas E2E; no forma parte
 * del producto.
 */
export { PDFDocument, PDFName } from "@cantoo/pdf-lib";
export { closePdfDocument, openPdfDocument } from "../../src/lib/pdf/core";
export { findImageAssets, renderImageAsset } from "../../src/lib/pdf/extractAssets/images";
export { buildImagesCorpus } from "../../src/lib/pdf/extractAssets/__fixtures__/images/corpus";
export { evaluateImages, summarize } from "../../src/lib/pdf/extractAssets/__fixtures__/images/metrics";
export { jbig2SampleBitmap, jpxExpectedPixel } from "../../src/lib/pdf/extractAssets/__fixtures__/images/codecs";
