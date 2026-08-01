import type { Language } from "@/lib/i18n";

/** Copy propio de PDF a JSON (ES/EN). */
export type PdfToJsonStrings = {
  howItWorksTitle: string;
  howItWorksBody: string;
  /** El limite honesto: extraccion semantica, no un volcado de bajo nivel. */
  limitsTitle: string;
  limitsBody: string;

  ocrLabel: string;
  ocrHint: string;

  largeFile: string;
  filenameSuffix: string;
};

const es: PdfToJsonStrings = {
  howItWorksTitle: "Qué hace esta herramienta",
  howItWorksBody:
    "Lee la capa de texto del PDF y reconstruye el documento completo como una representación estructurada semántica en JSON: títulos, párrafos, listas, tablas y bloques de código, en el orden en que aparecen. No es un pdf-to-csv (esa herramienta hermana solo extrae tablas): aquí se serializa el documento entero. Todo ocurre en tu navegador: el archivo no se sube a ningún servidor.",
  limitsTitle: "Lo que no puede hacer",
  limitsBody:
    "Esto es extracción semántica, no un volcado de bajo nivel de las operaciones de dibujo del PDF. Un PDF no guarda estructura, solo letras colocadas en una página: los documentos a dos columnas y las tablas con celdas combinadas, entre otros casos, no se recuperan bien. Preferimos decirlo antes que después: revisa el resultado.",

  ocrLabel: "Reconocer las páginas escaneadas (OCR)",
  ocrHint:
    "Cuando una página no tiene texto seleccionable se rasteriza y se reconoce con OCR antes de añadirla al JSON, como párrafos planos.",

  largeFile:
    "El archivo pasa de 100 MB. Analizar un documento así puede agotar la memoria de la pestaña.",
  filenameSuffix: "json",
};

const en: PdfToJsonStrings = {
  howItWorksTitle: "What this tool does",
  howItWorksBody:
    "Reads the PDF text layer and rebuilds the whole document as a structured, semantic JSON representation: headings, paragraphs, lists, tables and code blocks, in the order they appear. This is not pdf-to-csv (that sibling tool only extracts tables) — here the entire document is serialised. Everything runs in your browser: the file is never uploaded.",
  limitsTitle: "What it cannot do",
  limitsBody:
    "This is semantic extraction, not a low-level dump of the PDF's drawing operations. A PDF stores no structure, only letters placed on a page: two-column documents and tables with merged cells, among other cases, do not come out clean. We would rather say so up front: check the result.",

  ocrLabel: "Recognise scanned pages (OCR)",
  ocrHint:
    "When a page has no selectable text it is rasterised and recognised with OCR before it's added to the JSON, as plain paragraphs.",

  largeFile:
    "The file is over 100 MB. Analysing a document that size may exhaust the tab's memory.",
  filenameSuffix: "json",
};

export const PDF_TO_JSON_STRINGS: Record<Language, PdfToJsonStrings> = {
  es,
  en,
};
