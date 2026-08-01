import {
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  extractDocumentBlocks,
} from "@/lib/pdf/pdfToMarkdown";

/**
 * Motor "PDF -> JSON".
 *
 * Hermana de `pdfToWord.ts`/`pdfToText.ts`: reutiliza `extractDocumentBlocks`
 * de `pdfToMarkdown.ts` (misma extraccion, mismo fallback de OCR, mismos
 * `PdfError` tipados) y no le hace falta ninguna capa PURA propia -- el
 * `DocumentBuildResult` que ya produce `extractDocumentBlocks`
 * (`{ blocks: DocBlock[], stats: MarkdownStats }`) es ya una representacion
 * estructurada limpia (heading/paragraph/list/table/codeBlock/pageBreak),
 * asi que aqui solo hace falta serializarla con `JSON.stringify`.
 *
 * LIMITE HONESTO (heredado de `pdfToMarkdown.ts`, ver ese archivo): esto es
 * extraccion SEMANTICA, no un volcado de bajo nivel de las operaciones de
 * dibujo del PDF. Un documento a dos columnas, una tabla con celdas
 * combinadas o el maquetado de un paper academico no se recuperan bien.
 */

export type PdfToJsonOptions = {
  /** Reconoce con OCR las paginas sin capa de texto. */
  ocrFallback: boolean;
};

export const DEFAULT_PDF_TO_JSON_OPTIONS: PdfToJsonOptions = {
  ocrFallback: true,
};

/**
 * Convierte un PDF en un `.json` con la estructura semantica del documento
 * completo (titulos/parrafos/listas/tablas/bloques de codigo/saltos de
 * pagina). Reutiliza `extractDocumentBlocks` (mismo manejo de errores
 * tipados que `pdfToMarkdown.ts`/`pdfToWord.ts`: `PdfError` via
 * `toPdfError` -- incluido `"empty"`, que `extractDocumentBlocks` ya lanza
 * por su cuenta cuando el documento no produce ningun bloque).
 */
export async function pdfToJson(
  file: File,
  options: PdfToJsonOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  try {
    throwIfAborted(signal);

    const result = await extractDocumentBlocks(
      file,
      { ...DEFAULT_PDF_TO_MARKDOWN_OPTIONS, ocrFallback: options.ocrFallback },
      (value) => onProgress?.(value * 0.95),
      signal,
    );

    const json = JSON.stringify(result, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
