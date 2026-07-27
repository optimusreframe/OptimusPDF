import { PDFDocument, degrees, type PDFPage } from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  savePdfToBlob,
  toPdfError,
  type PageRef,
  type ProgressCallback,
} from "@/lib/pdf/core";

export type MergeOptions = {
  /**
   * Orden explicito de paginas (el que produce `PageThumbnailGrid`).
   * Si se omite, se copian todas las paginas de cada archivo en el
   * orden en que el usuario coloco los archivos.
   */
  pages?: PageRef[];
};

/**
 * Une varios PDF en uno solo con `copyPages`, respetando orden y
 * rotacion. Todo ocurre en la memoria del navegador.
 */
export async function mergePdfFiles(
  files: File[],
  options: MergeOptions = {},
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (files.length === 0) throw new PdfError("empty");
  if (files.length < 2) throw new PdfError("needTwo");

  try {
    const output = await PDFDocument.create();
    const sources: PDFDocument[] = [];

    for (let index = 0; index < files.length; index += 1) {
      sources.push(await loadPdf(files[index]));
      onProgress?.(((index + 1) / files.length) * 0.5);
    }

    const plan: PageRef[] =
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

    if (plan.length === 0) throw new PdfError("empty");

    // Una sola llamada a copyPages por documento origen: mucho mas
    // eficiente que copiar pagina a pagina.
    const indicesByFile = new Map<number, number[]>();
    for (const ref of plan) {
      const list = indicesByFile.get(ref.fileIndex) ?? [];
      list.push(ref.pageIndex);
      indicesByFile.set(ref.fileIndex, list);
    }

    const copiedByFile = new Map<number, PDFPage[]>();
    for (const [fileIndex, pageIndices] of indicesByFile) {
      const source = sources[fileIndex];
      if (!source) throw new PdfError("unknown");
      copiedByFile.set(fileIndex, await output.copyPages(source, pageIndices));
    }

    const cursors = new Map<number, number>();
    for (let index = 0; index < plan.length; index += 1) {
      const ref = plan[index];
      const bucket = copiedByFile.get(ref.fileIndex);
      if (!bucket) continue;
      const cursor = cursors.get(ref.fileIndex) ?? 0;
      const page = bucket[cursor];
      cursors.set(ref.fileIndex, cursor + 1);
      if (!page) continue;

      if (ref.rotation % 360 !== 0) {
        const current = page.getRotation().angle;
        page.setRotation(degrees((current + ref.rotation + 360) % 360));
      }
      output.addPage(page);
      onProgress?.(0.5 + ((index + 1) / plan.length) * 0.45);
    }

    const blob = await savePdfToBlob(output);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
