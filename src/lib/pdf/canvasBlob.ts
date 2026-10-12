import { PdfError } from "@/lib/pdf/core";

/**
 * Envuelve `canvas.toBlob` en una promesa. Vive en un modulo PROPIO y ligero (sin jszip) para que `compress`, `redact`,
 * `repair` y compania no arrastren `imagesToPdf.ts` (y su jszip) al paquete inicial de PDF Pro; `imagesToPdf.ts` lo
 * reexporta con el mismo nombre.
 */
export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new PdfError("unknown", "canvas.toBlob returned null"));
      },
      type,
      quality,
    );
  });
}
