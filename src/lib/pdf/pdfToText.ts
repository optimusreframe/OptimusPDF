import {
  PdfError,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  buildLines,
  extractMarkdownPages,
  type MarkdownPage,
} from "@/lib/pdf/pdfToMarkdown";

/**
 * Motor "PDF -> Texto plano".
 *
 * A diferencia de `pdfToMarkdown.ts`, aqui NO se pasa por ninguna de sus
 * heuristicas de titulo/lista/tabla/codigo: esas heuristicas producen
 * artefactos de Markdown (`#`, `-`, `|`) que no pertenecen a un .txt
 * honesto. Lo unico que se reutiliza de `pdfToMarkdown.ts` es la capa de
 * EXTRACCION (`extractMarkdownPages`, con su mismo fallback de OCR) y la
 * capa PURA de agrupado de fragmentos en lineas (`buildLines`): de ahi en
 * adelante, cada linea de una pagina de texto se concatena tal cual, sin
 * reconstruir estructura ninguna.
 *
 * Mismo patron de capas que `pdfToMarkdown.ts`/`pdfToWord.ts`:
 *  - PURA: `buildPlainText` mapea `MarkdownPage[]` (ya extraidas) a texto
 *    plano. No toca pdf.js ni el navegador.
 *  - NAVEGADOR: `pdfToText`, que ademas llama a `extractMarkdownPages`.
 */

export type PdfToTextOptions = {
  /** Reconoce con OCR las paginas sin capa de texto. */
  ocrFallback: boolean;
  /** Inserta un separador (form feed) entre el contenido de cada pagina. */
  pageSeparators: boolean;
};

export const DEFAULT_PDF_TO_TEXT_OPTIONS: PdfToTextOptions = {
  ocrFallback: true,
  pageSeparators: false,
};

/**
 * Separador visible entre paginas cuando `pageSeparators` esta activo: el
 * caracter de form feed (`\f`, U+000C) es el marcador de salto de pagina
 * tradicional en texto plano -- lo reconocen editores, `less`/`more` e
 * impresoras -- y no depende de ningun idioma, a diferencia de una linea
 * "--- pagina N ---" que si tendria que traducirse.
 */
const PAGE_SEPARATOR = "\f";

/**
 * Texto de UNA pagina ya extraida, sin pasar por ninguna heuristica de
 * Markdown:
 *  - `"text"`: las lineas reconstruidas por `buildLines` (agrupado por
 *    proximidad de linea base), unidas con salto de linea simple.
 *  - `"ocr"` / `"ocrFailed"`: el texto reconocido por OCR (o el aviso de
 *    fallo) tal cual — ya es texto plano, no necesita `buildLines`.
 *  - `"empty"`: cadena vacia.
 */
function pageText(page: MarkdownPage): string {
  switch (page.source) {
    case "text":
      return buildLines(page)
        .map((line) => line.text)
        .join("\n");
    case "ocr":
    case "ocrFailed":
      return page.ocrText ?? "";
    case "empty":
      return "";
    default: {
      const exhaustive: never = page.source;
      return exhaustive;
    }
  }
}

/**
 * Capa PURA: `MarkdownPage[]` ya extraidas -> texto plano del documento
 * completo. Se exporta por separado para poder probarla con fixtures de
 * `MarkdownPage[]` construidas a mano, sin pasar por pdf.js.
 *
 * Las paginas se unen con `"\n\n"` si `pageSeparators` es `false`, o con
 * `PAGE_SEPARATOR` (form feed) entre cada una si es `true`. Una pagina sin
 * texto (`"empty"`, u OCR que no reconocio nada) simplemente aporta una
 * cadena vacia: no rompe el join, solo no suma texto en su lugar.
 */
export function buildPlainText(
  pages: MarkdownPage[],
  options: PdfToTextOptions,
): string {
  const texts = pages.map(pageText);
  const separator = options.pageSeparators ? PAGE_SEPARATOR : "\n\n";
  return texts.join(separator);
}

/**
 * Convierte un PDF en texto plano (.txt), pagina por pagina. Reutiliza
 * `extractMarkdownPages` (mismo fallback de OCR que `pdfToMarkdown.ts`) y
 * el mismo manejo de errores tipados (`PdfError` via `toPdfError`).
 */
export async function pdfToText(
  file: File,
  options: PdfToTextOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  /** Aviso de una pagina cuyo OCR fallo, ya traducido al idioma de la interfaz. */
  ocrFailureMarker?: string,
): Promise<Blob> {
  try {
    throwIfAborted(signal);

    const pages = await extractMarkdownPages(
      file,
      { ...DEFAULT_PDF_TO_MARKDOWN_OPTIONS, ocrFallback: options.ocrFallback },
      (value) => onProgress?.(value * 0.95),
      signal,
      ocrFailureMarker,
    );
    throwIfAborted(signal);

    const text = buildPlainText(pages, options);
    if (text.trim().length === 0) throw new PdfError("empty");

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
