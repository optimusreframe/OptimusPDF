import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de organizacion de paginas: orden, rotacion y eliminacion en una
 * sola pasada. Modulo puro (sin React).
 *
 * El plan es la lista final de paginas en el orden deseado; lo que no
 * aparece en la lista queda fuera del documento resultante. Duplicar una
 * pagina en la lista la duplica en la salida.
 *
 * Un plan vacio se interpreta como "documento intacto": es la salida
 * conservadora si la interfaz aun no ha terminado de construir el plan.
 */

export type OrganizePage = {
  /** Numero de pagina 1-based en el documento original. */
  page: number;
  /** Grados que se suman a la rotacion original (0, 90, 180 o 270). */
  rotation: number;
};

export async function organizePdf(
  file: File,
  pages: OrganizePage[],
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    const source = await loadPdf(file);
    onProgress?.(0.2);

    const pageCount = source.getPageCount();
    if (pageCount < 1) throw new PdfError("corrupt");

    const filtered = pages.filter(
      (item) =>
        Number.isInteger(item.page) &&
        item.page >= 1 &&
        item.page <= pageCount,
    );
    const plan: OrganizePage[] =
      pages.length === 0
        ? source
            .getPageIndices()
            .map((index) => ({ page: index + 1, rotation: 0 }))
        : filtered;
    if (plan.length === 0) throw new PdfError("empty");

    const output = await PDFDocument.create();
    // Una sola llamada a copyPages: copiar pagina a pagina multiplica el
    // coste en documentos con recursos compartidos.
    const copied = await output.copyPages(
      source,
      plan.map((item) => item.page - 1),
    );

    for (let index = 0; index < copied.length; index += 1) {
      const page = copied[index];
      const rotation = plan[index].rotation;
      if (rotation % 360 !== 0) {
        const current = page.getRotation().angle;
        page.setRotation(degrees(((current + rotation) % 360 + 360) % 360));
      }
      output.addPage(page);
      onProgress?.(0.2 + ((index + 1) / copied.length) * 0.7);
    }

    const blob = await savePdfToBlob(output);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
