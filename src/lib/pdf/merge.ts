import { PDFDocument } from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  scaleProgress,
  toPdfError,
  type PageRef,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { applyPageAssembly, type ExternalSource, type PageEntry } from "@/lib/pdf/pageAssembly";

export type MergeOptions = {
  /**
   * Orden explicito de paginas (el que produce `PageThumbnailGrid`).
   * Si se omite, se copian todas las paginas de cada archivo en el
   * orden en que el usuario coloco los archivos.
   */
  pages?: PageRef[];
};

/** Nombre del archivo sin su extension `.pdf` (titulo del marcador que agrupa sus marcadores). */
export function mergeOutlineTitle(file: File, index: number): string {
  const base = file.name.replace(/\.pdf$/i, "").trim();
  return base.length > 0 ? base : `Documento ${index + 1}`;
}

/**
 * Une varios PDF en uno solo, respetando orden y rotacion. Todo ocurre en la memoria del navegador.
 *
 * Wave 8: sobre el motor en sitio (`pageAssembly`). El PRIMER archivo es el documento base y los
 * demas entran como documentos externos, de modo que:
 *  - los metadatos (titulo, autor, asunto...) son los del primer archivo (decision documentada);
 *  - el formulario (AcroForm) se conserva: los campos de los demas archivos se registran y, si
 *    repiten un nombre ya usado, se renombran (`campo_2`); nunca se fusionan valores;
 *  - los marcadores de cada archivo se conservan bajo un marcador con el nombre del archivo
 *    (solo si ese archivo tenia marcadores que apuntan a paginas unidas);
 *  - las paginas no seleccionadas no quedan dentro del archivo (se sueltan los objetos huerfanos).
 */
export async function mergePdfFiles(
  files: File[],
  options: MergeOptions = {},
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (files.length === 0) throw new PdfError("empty");
  if (files.length < 2) throw new PdfError("needTwo");

  try {
    const sources: PDFDocument[] = [];
    for (let index = 0; index < files.length; index += 1) {
      sources.push(await loadPdf(files[index]));
      onProgress?.(((index + 1) / files.length) * 0.3);
    }

    const refs: PageRef[] =
      options.pages && options.pages.length > 0
        ? options.pages.filter((page) => page.selected)
        : sources.flatMap((source, fileIndex) =>
            source.getPageIndices().map((pageIndex) => ({
              id: `${fileIndex}:${pageIndex}`,
              fileIndex,
              pageIndex,
              rotation: 0,
              selected: true,
            })),
          );
    if (refs.length === 0) throw new PdfError("empty");

    const plan: PageEntry[] = refs.map((ref) => {
      if (!sources[ref.fileIndex]) throw new PdfError("unknown");
      return ref.fileIndex === 0
        ? { kind: "existing", sourceIndex: ref.pageIndex, rotation: ref.rotation }
        : { kind: "external", sourceId: String(ref.fileIndex), sourceIndex: ref.pageIndex, rotation: ref.rotation };
    });

    const externals: Record<string, ExternalSource> = {};
    const outlineGroups: Record<string, string> = {};
    for (let index = 1; index < sources.length; index += 1) {
      externals[String(index)] = sources[index];
      outlineGroups[String(index)] = mergeOutlineTitle(files[index], index);
    }

    const result = await applyPageAssembly(sources[0], plan, externals, {
      onProgress: (value) => onProgress?.(scaleProgress(value, 0.3, 1)),
      maxExternalDocuments: Math.max(1, files.length),
      outlineGroups,
      wrapOutlineTitle: mergeOutlineTitle(files[0], 0),
    });
    onProgress?.(1);
    return new Blob([result.bytes as unknown as BlobPart], { type: "application/pdf" });
  } catch (error) {
    throw toPdfError(error);
  }
}
