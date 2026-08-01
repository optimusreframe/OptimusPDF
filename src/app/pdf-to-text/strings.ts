import type { Language } from "@/lib/i18n";

/** Copy propio de PDF a Texto (ES/EN). */
export type PdfToTextStrings = {
  howItWorksTitle: string;
  howItWorksBody: string;

  ocrLabel: string;
  ocrHint: string;
  pageSeparatorsLabel: string;
  pageSeparatorsHint: string;

  largeFile: string;
  filenameSuffix: string;
};

const es: PdfToTextStrings = {
  howItWorksTitle: "Qué hace esta herramienta",
  howItWorksBody:
    "Extrae todo el texto del PDF, página por página, como texto plano (.txt): sin títulos, listas ni tablas reconstruidas — solo el texto tal y como aparece en el documento. Todo ocurre en tu navegador: el archivo no se sube a ningún servidor.",

  ocrLabel: "Reconocer las páginas escaneadas (OCR)",
  ocrHint:
    "Cuando una página no tiene texto seleccionable se rasteriza y se reconoce con OCR antes de añadirla al .txt.",
  pageSeparatorsLabel: "Separar las páginas con un salto de página",
  pageSeparatorsHint:
    "Inserta un carácter de salto de página (form feed) entre el contenido de cada página, en vez de una línea en blanco.",

  largeFile:
    "El archivo pasa de 100 MB. Extraer el texto de un documento así puede agotar la memoria de la pestaña.",
  filenameSuffix: "texto",
};

const en: PdfToTextStrings = {
  howItWorksTitle: "What this tool does",
  howItWorksBody:
    "Extracts all the text from the PDF, page by page, as plain text (.txt): no headings, lists or tables rebuilt — just the text as it appears in the document. Everything runs in your browser: the file is never uploaded.",

  ocrLabel: "Recognise scanned pages (OCR)",
  ocrHint:
    "When a page has no selectable text it is rasterised and recognised with OCR before it's added to the .txt file.",
  pageSeparatorsLabel: "Separate pages with a page break",
  pageSeparatorsHint:
    "Inserts a page-break character (form feed) between the content of each page, instead of a blank line.",

  largeFile:
    "The file is over 100 MB. Extracting text from a document that size may exhaust the tab's memory.",
  filenameSuffix: "text",
};

export const PDF_TO_TEXT_STRINGS: Record<Language, PdfToTextStrings> = {
  es,
  en,
};
