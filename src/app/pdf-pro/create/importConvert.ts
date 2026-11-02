import { PdfError, type ProgressCallback } from "@/lib/pdf/core";
import { applyPageAssembly, identityPlan, readPageInfo, type PageEntry } from "@/lib/pdf/pageAssembly";
import { insertExternalPages } from "@/lib/pdf/pageAssemblyPlan";
import type { ExcelToPdfOptions } from "@/lib/pdf/excelToPdf";
import type { HtmlToPdfOptions } from "@/lib/pdf/htmlToPdf";
import type { WordToPdfOptions } from "@/lib/pdf/wordToPdf";
import type { ProOperation, ProOperationContext, ProOperationResult } from "@/app/pdf-pro/proTypes";

/**
 * «Insertar desde Word, Excel o HTML» (Wave 7 · U8): convierte el archivo con el MISMO motor que su herramienta
 * suelta (carga diferida: pdfmake, html2canvas y exceljs no entran en el paquete inicial) y mete las paginas en el
 * documento de trabajo con `applyPageAssembly` (edicion en sitio: conserva metadatos, formularios y marcadores).
 * Es UNA operacion del historial: se deshace con Ctrl+Z.
 */

export type ImportKind = "word" | "excel" | "html";

const EXTENSIONS: Record<ImportKind, RegExp> = {
  word: /\.docx$/i,
  excel: /\.xlsx$/i,
  html: /\.html?$/i,
};

/** Tipo de archivo importable por su nombre o tipo MIME, o `null` si no es ninguno. */
export function detectImportKind(file: Pick<File, "name" | "type">): ImportKind | null {
  for (const kind of ["word", "excel", "html"] as const) {
    if (EXTENSIONS[kind].test(file.name)) return kind;
  }
  if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "word";
  if (file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "excel";
  if (file.type === "text/html") return "html";
  return null;
}

export type ImportOptions = {
  word: WordToPdfOptions;
  excel: ExcelToPdfOptions;
  html: HtmlToPdfOptions;
};

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  word: { pageSize: "a4", orientation: "portrait", margin: "small" },
  excel: { pageSize: "a4", orientation: "landscape", sheet: "all" },
  html: { pageSize: "letter", orientation: "portrait", margin: "small" },
};

/** Convierte un archivo de Office o HTML a PDF con el motor de su herramienta suelta. */
export async function convertToPdf(
  kind: ImportKind,
  file: File,
  options: ImportOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // Un archivo de 0 bytes se explica como tal (el motor de HTML lo llama `empty`: «añade al menos un archivo»).
  if (file.size === 0) throw new PdfError("emptyFile");
  let blob: Blob;
  if (kind === "word") {
    const { wordToPdf } = await import("@/lib/pdf/wordToPdf");
    blob = await wordToPdf(file, options.word, onProgress, signal);
  } else if (kind === "excel") {
    const { excelToPdf } = await import("@/lib/pdf/excelToPdf");
    blob = await excelToPdf(file, options.excel, onProgress, signal);
  } else {
    const { htmlToPdf } = await import("@/lib/pdf/htmlToPdf");
    blob = await htmlToPdf(file, options.html, onProgress, signal);
  }
  return new Uint8Array(await blob.arrayBuffer());
}

export type InsertPosition = { at: "start" } | { at: "after"; pageIndex: number } | { at: "end" };

export type InsertConvertedOptions = {
  file: File;
  kind: ImportKind;
  options: ImportOptions;
  position: InsertPosition;
  /** Paginas del documento de trabajo (evita leerlo otra vez solo para contarlas). */
  pageCount: number;
};

/** Hueco del plan (0..n) donde caen las paginas nuevas. */
export function insertionIndex(position: InsertPosition, pageCount: number): number {
  if (position.at === "start") return 0;
  if (position.at === "end") return pageCount;
  return Math.min(pageCount, Math.max(0, position.pageIndex + 1));
}

/** Plan del documento con las paginas de `external` metidas en `index` (puro, para probarlo sin navegador). */
export function planWithInsertedPages(pageCount: number, externalPages: number, index: number): PageEntry[] {
  if (externalPages < 1) throw new PdfError("corrupt");
  const base = identityPlan(pageCount);
  return insertExternalPages(
    base,
    index,
    "converted",
    Array.from({ length: externalPages }, (_, i) => i),
  );
}

export const insertConvertedOperation: ProOperation<InsertConvertedOptions> = {
  id: "insert-converted",
  labelKey: "insertConverted",
  kind: "pages",
  async run(bytes, options, ctx: ProOperationContext): Promise<ProOperationResult> {
    const converted = await convertToPdf(
      options.kind,
      options.file,
      options.options,
      (value) => ctx.onProgress(value * 0.7),
      ctx.signal,
    );
    if (converted.byteLength === 0) throw new PdfError("corrupt");
    const infos = await readPageInfo(converted);
    if (infos.length === 0) throw new PdfError("corrupt");
    const plan = planWithInsertedPages(
      options.pageCount,
      infos.length,
      insertionIndex(options.position, options.pageCount),
    );
    const result = await applyPageAssembly(bytes, plan, { converted }, {
      signal: ctx.signal,
      onProgress: (value) => ctx.onProgress(0.7 + value * 0.3),
    });
    return { bytes: result.bytes, pageCount: result.pageCount, report: { added: infos.length } };
  },
};
