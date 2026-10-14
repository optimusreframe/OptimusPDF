import { degrees } from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  pdfBytesToBlob,
  savePdfToBytes,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de rotacion. Modulo puro (sin React).
 *
 * La rotacion es aditiva sobre la que ya declara el documento: una
 * pagina guardada a 90 grados a la que se aplican otros 90 termina a
 * 180, que es lo que ve la persona usuaria en la miniatura.
 */

export type RotatePlan = {
  /** Grados aplicados a toda pagina sin entrada propia en `byPage`. */
  base?: number;
  /** Grados por numero de pagina 1-based. */
  byPage?: Record<number, number>;
};

/** Normaliza cualquier entero de grados al rango 0/90/180/270. */
export function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const quarter = Math.round(value / 90) * 90;
  return ((quarter % 360) + 360) % 360;
}

export async function rotatePdf(
  file: File,
  plan: RotatePlan,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return pdfBytesToBlob(await rotatePdfToBytes(file, plan, onProgress));
}

/**
 * Igual que `rotatePdf`, pero devuelve los BYTES del PDF resultante (`Uint8Array`) sin pasar por un `Blob`: para quien sigue
 * trabajando con bytes (PDF Pro). Mismos bytes que el `Blob` de `rotatePdf`.
 */
export async function rotatePdfToBytes(
  file: File,
  plan: RotatePlan,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    const document = await loadPdf(file);
    onProgress?.(0.25);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    const base = normalizeRotation(plan.base ?? 0);
    const byPage = plan.byPage ?? {};

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const extra = normalizeRotation(byPage[index + 1] ?? base);
      if (extra !== 0) {
        const current = page.getRotation().angle;
        page.setRotation(degrees(normalizeRotation(current + extra)));
      }
      onProgress?.(0.25 + ((index + 1) / pages.length) * 0.6);
    }

    const bytes = await savePdfToBytes(document);
    onProgress?.(1);
    return bytes;
  } catch (error) {
    throw toPdfError(error);
  }
}
