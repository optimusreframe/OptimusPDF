/*
 * Puerta de entrada para la interfaz: abre un PDF (File/Blob) con pdf.js, lo mapea y lo cierra. Solo navegador (usa el
 * worker de pdf.js y un canvas para las paginas escaneadas). La logica esta en `autoMap.ts`, que se prueba en Node.
 */

import type { PDFPageProxy } from "pdfjs-dist";
import { closePdfDocument, getPdfJs, openPdfDocument, renderPageToCanvas } from "@/lib/pdf/core";
import { autoMapDocument } from "@/lib/pdf/autoMap";
import type { AutoMapOptions, AutoMapResult, OpsTable, RasterPage, Rasterizer } from "@/lib/pdf/autoMapTypes";

/** Ancho al que se renderiza una pagina escaneada para buscar rayas (px). */
export const RASTER_WIDTH_PX = 1000;

/** Renderiza la pagina a ~1000 px de ancho y devuelve sus pixeles (null sin contexto 2D). */
export const canvasRasterizer: Rasterizer = async (page: PDFPageProxy): Promise<RasterPage | null> => {
  const canvas = await renderPageToCanvas(page, { maxWidth: RASTER_WIDTH_PX, intent: "print" });
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data: image.data, width: canvas.width, height: canvas.height };
};

export type AutoMapFileOptions = Omit<AutoMapOptions, "ops" | "rasterizer"> & {
  /** `false` desactiva el analisis raster de paginas escaneadas (por defecto activo). */
  raster?: boolean;
};

/** Mapea un archivo PDF desconocido. Cancelable con `signal`; el documento se cierra siempre. */
export async function autoMapFile(file: Blob, options: AutoMapFileOptions, signal?: AbortSignal): Promise<AutoMapResult> {
  const pdf = await openPdfDocument(file);
  try {
    const ops = (await getPdfJs()).OPS as unknown as OpsTable;
    return await autoMapDocument(pdf, { ...options, ops, rasterizer: options.raster === false ? undefined : canvasRasterizer }, signal);
  } finally {
    await closePdfDocument(pdf);
  }
}
