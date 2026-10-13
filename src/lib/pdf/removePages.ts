import {
  PdfError,
  loadPdf,
  scaleProgress,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { applyPageAssembly, type PageEntry } from "@/lib/pdf/pageAssembly";

/**
 * Motor de eliminacion de paginas. Modulo puro (sin React).
 *
 * Wave 8: sobre el motor en sitio (`pageAssembly`). Antes se usaba
 * `removePage` de pdf-lib, que conservaba metadatos y formulario pero
 * dejaba el contenido de las paginas quitadas DENTRO del archivo (texto
 * recuperable, mismo tamano) y no reparaba marcadores ni enlaces que
 * apuntaban a ellas. Ahora lo eliminado se suelta de verdad.
 */

export type RemovePagesPlan = {
  /** Numeros de pagina 1-based que se eliminan. */
  remove: number[];
};

/** Plan del motor con las paginas que se QUEDAN (0-based, en orden), o `null` si no quedaria ninguna. */
export function keptPagesPlan(remove: readonly number[], pageCount: number): PageEntry[] | null {
  const targets = new Set(
    remove.filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount),
  );
  if (targets.size >= pageCount) return null;
  const plan: PageEntry[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    if (!targets.has(index + 1)) plan.push({ kind: "existing", sourceIndex: index, rotation: 0 });
  }
  return plan;
}

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

    // Quitar todas las paginas dejaria un PDF sin contenido: la interfaz
    // lo impide, y aqui se cubre por si acaso.
    const kept = keptPagesPlan(plan.remove, pageCount);
    if (!kept) throw new PdfError("empty");

    const result = await applyPageAssembly(document, kept, {}, {
      onProgress: (value) => onProgress?.(scaleProgress(value, 0.25, 1)),
    });
    onProgress?.(1);
    return new Blob([result.bytes as unknown as BlobPart], { type: "application/pdf" });
  } catch (error) {
    throw toPdfError(error);
  }
}
