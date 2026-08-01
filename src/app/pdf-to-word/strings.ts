import type { Language } from "@/lib/i18n";

/**
 * Copy propio de "PDF a Word". El diccionario global (`t.tools["pdf-to-word"]`)
 * ya cubre el nombre y la descripción corta que usa `ToolShell`; aquí solo
 * vive el texto adicional de esta página (el aviso honesto de fidelidad y
 * el sufijo del nombre de archivo descargado).
 */
export type PdfToWordStrings = {
  howItWorksTitle: string;
  howItWorksBody: string;
  limitsTitle: string;
  limitsBody: string;
  progress: string;
  filenameSuffix: string;
};

const es: PdfToWordStrings = {
  howItWorksTitle: "Cómo se convierte",
  howItWorksBody:
    "Se lee la capa de texto del PDF con su posición, tamaño y tipografía, y a partir de ahí se reconstruyen títulos, párrafos, listas, tablas y bloques de código como un documento DOCX editable. Todo ocurre en tu navegador: el documento no se sube a ningún servidor.",
  limitsTitle: "Lo que no puede hacer",
  limitsBody:
    "Esto es extracción semántica, no una conversión exacta: Word reflowea el contenido, así que el maquetado original (columnas, posición exacta de cada elemento) no se conserva pixel a pixel. Las páginas en blanco del PDF original no se preservan. Documentos a dos columnas, tablas con celdas combinadas o el maquetado de un paper académico no se recuperan bien — revisa el resultado antes de darlo por bueno.",
  progress: "Convirtiendo el documento",
  filenameSuffix: "word",
};

const en: PdfToWordStrings = {
  howItWorksTitle: "How the conversion works",
  howItWorksBody:
    "The PDF text layer is read with its position, size and typeface, and from that headings, paragraphs, lists, tables and code blocks are rebuilt as an editable DOCX document. Everything runs in your browser: the document is never uploaded.",
  limitsTitle: "What it cannot do",
  limitsBody:
    "This is semantic extraction, not an exact conversion: Word reflows the content, so the original layout (columns, the exact position of each element) is not preserved pixel for pixel. Blank pages in the original PDF are not preserved. Two-column documents, tables with merged cells, or academic paper layouts do not come out clean — check the result before trusting it.",
  progress: "Converting the document",
  filenameSuffix: "word",
};

export const STRINGS: Record<Language, PdfToWordStrings> = { es, en };
