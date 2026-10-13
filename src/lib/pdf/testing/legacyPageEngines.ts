import { PDFDocument, degrees, type PDFPage } from "@cantoo/pdf-lib";
import { PdfError, loadPdf, savePdfToBlob, toPdfError, type PageRef } from "@/lib/pdf/core";
import type { OrganizePage } from "@/lib/pdf/organize";
import type { RemovePagesPlan } from "@/lib/pdf/removePages";

/**
 * ORACULOS DE EQUIVALENCIA (Wave 8). Copia literal de los motores que usaban las herramientas
 * sueltas antes de migrarlas a `pageAssembly` (Unir, Organizar, Quitar paginas). Solo los usan las
 * pruebas, para comparar paginas, orden, tamanos, rotaciones y contenido con el motor nuevo, y para
 * dejar medido lo que perdian (metadatos, AcroForm, marcadores; texto de paginas quitadas aun en el
 * archivo). NO se importan desde la aplicacion.
 */

/** `mergePdfFiles` anterior: `copyPages` a un documento NUEVO. */
export async function legacyMergePdfFiles(files: File[], options: { pages?: PageRef[] } = {}): Promise<Blob> {
  if (files.length === 0) throw new PdfError("empty");
  if (files.length < 2) throw new PdfError("needTwo");
  try {
    const output = await PDFDocument.create();
    const sources: PDFDocument[] = [];
    for (const file of files) sources.push(await loadPdf(file));
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
    for (const ref of plan) {
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
    }
    return await savePdfToBlob(output);
  } catch (error) {
    throw toPdfError(error);
  }
}

function visualSize(page: PDFPage, extraRotation: number): [number, number] {
  const { width, height } = page.getSize();
  const angle = (((page.getRotation().angle + extraRotation) % 360) + 360) % 360;
  return angle === 90 || angle === 270 ? [height, width] : [width, height];
}

function blankSizeFor(plan: OrganizePage[], index: number, source: PDFDocument): [number, number] {
  for (let i = index - 1; i >= 0; i -= 1) {
    const entry = plan[i];
    if (entry.kind === "existing") return visualSize(source.getPage(entry.page - 1), entry.rotation);
  }
  for (let i = index + 1; i < plan.length; i += 1) {
    const entry = plan[i];
    if (entry.kind === "existing") return visualSize(source.getPage(entry.page - 1), entry.rotation);
  }
  return visualSize(source.getPage(0), 0);
}

/** `organizePdf` anterior: `copyPages` a un documento NUEVO. */
export async function legacyOrganizePdf(file: File, pages: OrganizePage[]): Promise<Blob> {
  try {
    const source = await loadPdf(file);
    const pageCount = source.getPageCount();
    if (pageCount < 1) throw new PdfError("corrupt");
    const plan: OrganizePage[] =
      pages.length === 0
        ? source.getPageIndices().map((index) => ({ kind: "existing" as const, page: index + 1, rotation: 0 }))
        : pages.filter((item) =>
            item.kind === "existing"
              ? Number.isInteger(item.page) && item.page >= 1 && item.page <= pageCount
              : item.kind === "blank",
          );
    if (plan.length === 0) throw new PdfError("empty");
    const existingEntries = plan.filter(
      (item): item is Extract<OrganizePage, { kind: "existing" }> => item.kind === "existing",
    );
    const output = await PDFDocument.create();
    const copied = await output.copyPages(
      source,
      existingEntries.map((item) => item.page - 1),
    );
    let cursor = 0;
    for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index];
      if (item.kind === "existing") {
        const page = copied[cursor];
        cursor += 1;
        if (item.rotation % 360 !== 0) {
          const current = page.getRotation().angle;
          page.setRotation(degrees((((current + item.rotation) % 360) + 360) % 360));
        }
        output.addPage(page);
      } else {
        output.addPage(blankSizeFor(plan, index, source));
      }
    }
    if (cursor !== copied.length) throw new PdfError("unknown");
    return await savePdfToBlob(output);
  } catch (error) {
    throw toPdfError(error);
  }
}

/** `removePdfPages` anterior: `removePage` sobre el documento cargado, sin soltar objetos. */
export async function legacyRemovePdfPages(file: File, plan: RemovePagesPlan): Promise<Blob> {
  try {
    const document = await loadPdf(file);
    const pageCount = document.getPageCount();
    if (pageCount < 1) throw new PdfError("corrupt");
    const targets = [...new Set(plan.remove)]
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
      .sort((a, b) => b - a);
    if (targets.length >= pageCount) throw new PdfError("empty");
    for (const target of targets) document.removePage(target - 1);
    return await savePdfToBlob(document);
  } catch (error) {
    throw toPdfError(error);
  }
}
