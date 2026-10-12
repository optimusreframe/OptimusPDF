import type { Language } from "@/lib/i18n";
import type { PdfToImageFormat, PdfToImageScale } from "@/lib/pdf/pdfToImages";
import type { PdfToCsvOptions } from "@/lib/pdf/pdfToCsv";
import type { PdfToExcelOptions } from "@/lib/pdf/pdfToExcel";
import type { PdfToJsonOptions } from "@/lib/pdf/pdfToJson";
import type { PdfToMarkdownOptions } from "@/lib/pdf/pdfToMarkdown";
import type { PdfToPowerpointOptions } from "@/lib/pdf/pdfToPowerpoint";
import type { PdfToTextOptions } from "@/lib/pdf/pdfToText";
import type { PdfToWordOptions } from "@/lib/pdf/pdfToWord";

/**
 * Tipos de la exportacion de PDF Pro (Wave 7 · U8). Solo TIPOS (`import type`): nada de aqui arrastra los motores
 * de conversion (docx, exceljs, pptxgenjs, jszip) al paquete inicial de `/pdf-pro`; los motores se cargan con
 * `import()` dinamico en `exportRunners.ts` justo cuando se exporta.
 */

export const EXPORT_FORMAT_IDS = [
  "images",
  "text",
  "word",
  "excel",
  "csv",
  "markdown",
  "json",
  "powerpoint",
] as const;
export type ExportFormatId = (typeof EXPORT_FORMAT_IDS)[number];

/** Que paginas se exportan a imagen: todas, un rango escrito, o las seleccionadas en el visor/organizador. */
export type PageScopeMode = "all" | "range" | "selected";

export type ImagesExportOptions = {
  format: PdfToImageFormat;
  /** Calidad JPEG 0.5..1 (PNG la ignora). */
  quality: number;
  /** 1 = 72 DPI, 2 = 144 DPI, 3 = 216 DPI. */
  scale: PdfToImageScale;
  scope: PageScopeMode;
  /** Texto del rango («1-3, 5»), solo con `scope: "range"`. */
  range: string;
};

export type ExportOptionsMap = {
  images: ImagesExportOptions;
  text: PdfToTextOptions;
  word: PdfToWordOptions;
  excel: PdfToExcelOptions;
  csv: PdfToCsvOptions;
  markdown: PdfToMarkdownOptions;
  json: PdfToJsonOptions;
  powerpoint: PdfToPowerpointOptions;
};

export type ExportResult = { blob: Blob; filename: string };

export type ExportRunInput<K extends ExportFormatId> = {
  /** El snapshot actual como `File` (con el nombre del documento). */
  file: File;
  /** Nombre del documento (sirve de base del nombre de salida). */
  name: string;
  language: Language;
  options: ExportOptionsMap[K];
  /** Paginas elegidas en el visor o el organizador (0-based, ordenadas). */
  selectedPages?: readonly number[];
  pageCount?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};
