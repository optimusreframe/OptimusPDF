import type { Language } from "@/lib/i18n";

/**
 * Textos propios de "PDF a Excel". El diccionario global solo cubre lo
 * compartido por todas las herramientas.
 */
export type PdfToExcelStrings = {
  howItWorksTitle: string;
  howItWorksBody: string;
  /** El limite honesto: solo tablas con rejilla regular, texto sin formulas ni estilos, sin OCR. */
  limitsTitle: string;
  limitsBody: string;
  stripRepeatedLabel: string;
  stripRepeatedHint: string;
  progress: string;
  filenameSuffix: string;
};

const es: PdfToExcelStrings = {
  howItWorksTitle: "Cómo se convierte",
  howItWorksBody:
    "Busca tablas con rejillas regulares en la capa de texto del PDF (la misma detección que usa PDF a Markdown) y crea un libro XLSX con una hoja por cada tabla encontrada, en el orden en que aparecen en el documento.",
  limitsTitle: "Lo que no hace",
  limitsBody:
    "Se extrae solo el texto de cada celda: no se reconstruyen fórmulas, gráficos ni el formato visual (colores, bordes, anchos de columna) de la tabla original. Si el PDF son páginas escaneadas (imágenes sin capa de texto), esta herramienta no encuentra ninguna tabla — a propósito no hace OCR aquí, porque el reconocimiento de texto nunca reconstruye una rejilla de tabla.",
  stripRepeatedLabel: "Quitar encabezados y pies repetidos",
  stripRepeatedHint:
    "Elimina, antes de buscar tablas, la línea que se repite arriba o abajo en casi todas las páginas: numeración, titulillo, aviso legal.",
  progress: "Buscando tablas en el PDF",
  filenameSuffix: "pdf-a-excel",
};

const en: PdfToExcelStrings = {
  howItWorksTitle: "How the conversion works",
  howItWorksBody:
    "It looks for tables with regular grids in the PDF's text layer (the same detection PDF to Markdown uses) and builds an XLSX workbook with one sheet per table found, in the order they appear in the document.",
  limitsTitle: "What it does not do",
  limitsBody:
    "Only the text of each cell is extracted: formulas, charts, and the original table's visual formatting (colours, borders, column widths) are not rebuilt. If the PDF is scanned pages (images with no text layer), this tool finds no tables at all — it deliberately does not run OCR here, since OCR text recognition never reconstructs a table grid.",
  stripRepeatedLabel: "Remove repeated headers and footers",
  stripRepeatedHint:
    "Removes, before searching for tables, the line that repeats at the top or bottom of nearly every page: numbering, running head, legal notice.",
  progress: "Looking for tables in the PDF",
  filenameSuffix: "pdf-to-excel",
};

export const PDF_TO_EXCEL_STRINGS: Record<Language, PdfToExcelStrings> = {
  es,
  en,
};
