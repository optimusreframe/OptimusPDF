import {
  PdfError,
  loadPdf,
  scaleProgress,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { applyPageAssembly, type PageEntry, type PageToolResult } from "@/lib/pdf/pageAssembly";

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

/**
 * Quita las paginas y devuelve el PDF con lo que no se pudo conservar en `warnings`: marcadores, enlaces
 * y destinos de las paginas quitadas, firmas que dejan de ser validas, estructura de accesibilidad que
 * no se pudo podar... Las etiquetas de pagina y el arbol de estructura de las paginas que quedan SI se
 * conservan.
 */
export async function removePdfPagesWithReport(
  file: File,
  plan: RemovePagesPlan,
  onProgress?: ProgressCallback,
): Promise<PageToolResult> {
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
    return {
      blob: new Blob([result.bytes as unknown as BlobPart], { type: "application/pdf" }),
      warnings: result.warnings,
      pageCount: result.pageCount,
    };
  } catch (error) {
    throw toPdfError(error);
  }
}

/** Igual que `removePdfPagesWithReport`, solo con el PDF. */
export async function removePdfPages(
  file: File,
  plan: RemovePagesPlan,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return (await removePdfPagesWithReport(file, plan, onProgress)).blob;
}
