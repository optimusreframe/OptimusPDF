import {
  PdfError,
  loadPdf,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de eliminacion de paginas. Modulo puro (sin React).
 *
 * Se opera sobre el documento cargado en lugar de copiar las paginas a
 * uno nuevo: asi se conservan metadatos, marcadores y formularios del
 * original, y la salida es identica salvo por las paginas retiradas.
 */

export type RemovePagesPlan = {
  /** Numeros de pagina 1-based que se eliminan. */
  remove: number[];
};

export async function removePdfPages(
  file: File,
  plan: RemovePagesPlan,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    const document = await loadPdf(file);
    onProgress?.(0.25);

    const pageCount = document.getPageCount();
    if (pageCount < 1) throw new PdfError("corrupt");

    const targets = [...new Set(plan.remove)]
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
      .sort((a, b) => b - a);

    // Quitar todas las paginas dejaria un PDF sin contenido: la interfaz
    // lo impide, y aqui se cubre por si acaso.
    if (targets.length >= pageCount) throw new PdfError("empty");

    // De mayor a menor: cada borrado desplaza los indices posteriores.
    for (let index = 0; index < targets.length; index += 1) {
      document.removePage(targets[index] - 1);
      onProgress?.(0.25 + ((index + 1) / targets.length) * 0.6);
    }

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
