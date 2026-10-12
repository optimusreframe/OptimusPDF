/**
 * Topes de un ZIP de varios PDF (100 archivos y 500 MB acumulados). Viven en un modulo PROPIO y ligero: `signBatch.ts`
 * los necesita y, importandolos de `pdfsToZip.ts`, arrastraria jszip al paquete inicial de la pagina. `pdfsToZip.ts`
 * los reexporta con el mismo nombre.
 */
export const MAX_ZIP_FILES = 100;
export const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
