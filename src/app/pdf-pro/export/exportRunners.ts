import { PdfError, withSuffix } from "@/lib/pdf/core";
import { resolvePageScope } from "@/app/pdf-pro/export/pageScope";
import type {
  ExportFormatId,
  ExportResult,
  ExportRunInput,
} from "@/app/pdf-pro/export/exportTypes";
import { STRINGS as PDF_TO_JPG_STRINGS } from "@/app/pdf-to-jpg/strings";
import { PDF_TO_TEXT_STRINGS } from "@/app/pdf-to-text/strings";
import { STRINGS as PDF_TO_WORD_STRINGS } from "@/app/pdf-to-word/strings";
import { PDF_TO_EXCEL_STRINGS } from "@/app/pdf-to-excel/strings";
import { PDF_TO_CSV_STRINGS } from "@/app/pdf-to-csv/strings";
import { PDF_TO_JSON_STRINGS } from "@/app/pdf-to-json/strings";
import { PDF_TO_MARKDOWN_STRINGS } from "@/app/pdf-to-markdown/strings";
import { STRINGS as PDF_TO_POWERPOINT_STRINGS } from "@/app/pdf-to-powerpoint/strings";

/**
 * Motores de exportacion de PDF Pro (Wave 7 · U8). Cada formato llama al MISMO motor, con las MISMAS opciones y
 * los MISMOS textos (sufijo del archivo, prefijo de las imagenes, aviso de OCR fallido) que su herramienta suelta:
 * por eso la salida es identica a la de `/pdf-to-*` sobre el mismo PDF (`exportEquivalence.test.ts` lo comprueba
 * con 8 formatos).
 *
 * CARGA DIFERIDA: los motores se importan con `import()` dentro de cada `case`. Importarlos arriba arrastraria
 * docx, exceljs, pptxgenjs y jszip al paquete inicial de `/pdf-pro`; asi solo se descargan al exportar a ese formato.
 */

function noop(): void {}

type Runner<K extends ExportFormatId> = (input: ExportRunInput<K>) => Promise<ExportResult>;

const RUNNERS: { [K in ExportFormatId]: Runner<K> } = {
  async images({ file, name, language, options, selectedPages, pageCount, signal, onProgress }) {
    const s = PDF_TO_JPG_STRINGS[language];
    const scope = resolvePageScope(options, pageCount ?? Number.MAX_SAFE_INTEGER, selectedPages);
    if (!scope.ok) throw new PdfError("invalidConfig");
    const { pdfToImages } = await import("@/lib/pdf/pdfToImages");
    const result = await pdfToImages(
      file,
      {
        format: options.format,
        quality: options.quality,
        scale: options.scale,
        pages: scope.pages,
        namePrefix: s.filePrefix,
      },
      onProgress,
      signal,
    );
    return {
      blob: result.blob,
      filename: withSuffix(name, s.filenameSuffix, result.kind === "zip" ? "zip" : result.kind),
    };
  },

  async text({ file, name, language, options, signal, onProgress }) {
    const s = PDF_TO_TEXT_STRINGS[language];
    const { pdfToText } = await import("@/lib/pdf/pdfToText");
    const blob = await pdfToText(file, options, onProgress ?? noop, signal, s.ocrFailureMarker);
    return { blob, filename: withSuffix(name, s.filenameSuffix, "txt") };
  },

  async word({ file, name, language, options, signal, onProgress }) {
    const s = PDF_TO_WORD_STRINGS[language];
    const { pdfToWord } = await import("@/lib/pdf/pdfToWord");
    const blob = await pdfToWord(file, options, onProgress ?? noop, signal, s.ocrFailureMarker);
    return { blob, filename: withSuffix(name, s.filenameSuffix, "docx") };
  },

  async excel({ file, name, language, options, signal, onProgress }) {
    const s = PDF_TO_EXCEL_STRINGS[language];
    const { pdfToExcel } = await import("@/lib/pdf/pdfToExcel");
    const blob = await pdfToExcel(file, options, onProgress ?? noop, signal);
    return { blob, filename: withSuffix(name, s.filenameSuffix, "xlsx") };
  },

  async csv({ file, name, language, options, signal, onProgress }) {
    const s = PDF_TO_CSV_STRINGS[language];
    const { pdfToCsv } = await import("@/lib/pdf/pdfToCsv");
    const blob = await pdfToCsv(file, options, onProgress ?? noop, signal);
    return { blob, filename: withSuffix(name, s.filenameSuffix, options.format) };
  },

  async markdown({ file, name, language, options, signal, onProgress }) {
    const s = PDF_TO_MARKDOWN_STRINGS[language];
    const { pdfToMarkdown } = await import("@/lib/pdf/pdfToMarkdown");
    const conversion = await pdfToMarkdown(file, options, onProgress ?? noop, signal, s.ocrFailureMarker);
    return { blob: conversion.blob, filename: withSuffix(name, s.filenameSuffix, "md") };
  },

  async json({ file, name, language, options, signal, onProgress }) {
    const s = PDF_TO_JSON_STRINGS[language];
    const { pdfToJson } = await import("@/lib/pdf/pdfToJson");
    const blob = await pdfToJson(file, options, onProgress ?? noop, signal);
    return { blob, filename: withSuffix(name, s.filenameSuffix, "json") };
  },

  async powerpoint({ file, name, language, options, signal, onProgress }) {
    const s = PDF_TO_POWERPOINT_STRINGS[language];
    const { pdfToPowerpoint } = await import("@/lib/pdf/pdfToPowerpoint");
    const blob = await pdfToPowerpoint(file, options, onProgress ?? noop, signal);
    return { blob, filename: withSuffix(name, s.filenameSuffix, "pptx") };
  },
};

/** Exporta el documento a un formato. Lanza `PdfError` (`cancelled` incluido) igual que los motores sueltos. */
export function runExportFormat<K extends ExportFormatId>(id: K, input: ExportRunInput<K>): Promise<ExportResult> {
  const runner = RUNNERS[id] as Runner<K>;
  return runner(input);
}
