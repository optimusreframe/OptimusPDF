/**
 * Punto de entrada que Vite empaqueta (IIFE) para inyectar el automapeo en una pagina real de la app y probarlo en
 * Chromium y WebKit: el motor (`autoMapFile`, el de produccion, con pdf.js y su worker), el generador de contratos
 * sinteticos (pdf-lib) y las metricas. Solo para las pruebas E2E; no forma parte del producto.
 */
export { PDFDocument } from "@cantoo/pdf-lib";
export { autoMapFile } from "../../src/lib/pdf/autoMapFile";
export { evaluateAutoMap } from "../../src/lib/pdf/testing/autoMapEval";
export { SCALE_VARIANTS, renderSynthetic, syntheticCorpus } from "../../src/lib/pdf/testing/autoMapSynthetic";
