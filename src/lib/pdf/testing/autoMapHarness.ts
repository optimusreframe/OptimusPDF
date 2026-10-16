/*
 * Utilidades de PRUEBA del automapeo (solo Node/Vitest, build «legacy» de pdf.js; sin alias para poder usarse tambien
 * desde Playwright): abrir un PDF, obtener la tabla `OPS` y correr `autoMapDocument` en un paso.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AutoMapOptions, AutoMapResult, OpsTable } from "@/lib/pdf/autoMapTypes";
import { autoMapDocument } from "@/lib/pdf/autoMap";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
export function legacyPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export type OpenedPdf = { pdf: PDFDocumentProxy; ops: OpsTable; close: () => Promise<void> };

/** Abre bytes de PDF con pdf.js (copia los bytes: pdf.js transfiere el buffer). */
export async function openForAnalysis(bytes: Uint8Array): Promise<OpenedPdf> {
  const pdfjs = await legacyPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = (await task.promise) as unknown as PDFDocumentProxy;
  return {
    pdf,
    ops: pdfjs.OPS as unknown as OpsTable,
    close: async () => {
      await task.destroy();
    },
  };
}

export async function autoMapBytes(
  bytes: Uint8Array,
  options: Omit<AutoMapOptions, "ops"> & { ops?: OpsTable },
): Promise<AutoMapResult> {
  const opened = await openForAnalysis(bytes);
  try {
    return await autoMapDocument(opened.pdf, { ...options, ops: options.ops ?? opened.ops });
  } finally {
    await opened.close();
  }
}
