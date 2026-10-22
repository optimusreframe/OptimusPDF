/**
 * Punto de entrada que Vite empaqueta (IIFE) para inyectar el motor de anotaciones en una pagina REAL de la app y probarlo en
 * Chromium y WebKit (iPad): el motor de produccion (`findAnnotationAssets` / `renderAnnotationAsset`, con pdf.js y su worker), el
 * generador del corpus sintetico (pdf-lib) y nada mas. Solo para las pruebas E2E; no forma parte del producto.
 */
export { buildAnnotCorpus, makeBusyDocument } from "./generate";
export { findAnnotationAssets } from "../../annotations";
export { renderAnnotationAsset } from "../../annotationsRender";
export { openPdfDocument, closePdfDocument } from "@/lib/pdf/core";
