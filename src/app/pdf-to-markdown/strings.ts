import type { Language } from "@/lib/i18n";
import type { OcrLanguage } from "@/lib/pdf/ocr";

/** Copy propio de PDF a Markdown (ES/EN). */
export type PdfToMarkdownStrings = {
  howItWorksTitle: string;
  howItWorksBody: string;
  /** El limite honesto: extraccion semantica, no conversion exacta. */
  limitsTitle: string;
  limitsBody: string;

  headingsLabel: string;
  headingsHint: string;
  tablesLabel: string;
  tablesHint: string;
  stripRepeatedLabel: string;
  stripRepeatedHint: string;
  pageSeparatorsLabel: string;
  pageSeparatorsHint: string;
  ocrLabel: string;
  ocrHint: string;
  ocrLanguageLabel: string;
  ocrLanguageNames: Record<OcrLanguage, string>;
  ocrNotice: string;

  previewTitle: string;
  previewIntro: string;
  previewRun: string;
  previewRefresh: string;
  previewRunning: string;
  previewCancel: string;
  previewEmpty: string;
  previewStale: string;
  previewTruncated: (shown: number, total: number) => string;

  statPages: (value: number) => string;
  statOcrPages: (value: number) => string;
  statHeadings: (value: number) => string;
  statListItems: (value: number) => string;
  statTables: (value: number) => string;
  statCodeBlocks: (value: number) => string;
  statCharacters: (value: number) => string;

  largeFile: string;
  filenameSuffix: string;
};

const es: PdfToMarkdownStrings = {
  howItWorksTitle: "Qué hace esta herramienta",
  howItWorksBody:
    "Lee la capa de texto del PDF con su posición, tamaño y tipografía, y a partir de ahí reconstruye títulos, listas, bloques de código y tablas regulares en Markdown. Todo ocurre en tu navegador: el documento no se sube a ningún servidor.",
  limitsTitle: "Lo que no puede hacer",
  limitsBody:
    "Esto es extracción semántica, no una conversión exacta. Un PDF no guarda estructura, solo letras colocadas en una página: los documentos a dos columnas, las tablas con celdas combinadas, las notas al pie y el maquetado de un paper académico no se recuperan bien. Preferimos decirlo antes que después: revisa el resultado.",

  headingsLabel: "Detectar títulos",
  headingsHint:
    "Las líneas más grandes que el cuerpo del texto (o cortas y en negrita) se convierten en #, ## y ###.",
  tablesLabel: "Detectar tablas",
  tablesHint:
    "Solo reconstruye rejillas regulares: mismas columnas alineadas en tres filas o más. Es a propósito conservador, una tabla inventada estropea más de lo que arregla.",
  stripRepeatedLabel: "Quitar encabezados y pies repetidos",
  stripRepeatedHint:
    "Elimina la línea que se repite arriba o abajo en casi todas las páginas: numeración, titulillo, aviso legal.",
  pageSeparatorsLabel: "Separar las páginas con una regla",
  pageSeparatorsHint: "Inserta una línea --- entre el contenido de cada página.",
  ocrLabel: "Reconocer las páginas escaneadas (OCR)",
  ocrHint:
    "Cuando una página no tiene texto seleccionable se rasteriza y se reconoce. El texto reconocido sale como párrafos planos: el OCR no da títulos ni listas.",
  ocrLanguageLabel: "Idioma del escaneo",
  ocrLanguageNames: {
    spa: "Español",
    eng: "Inglés",
    fra: "Francés",
    por: "Portugués",
  },
  ocrNotice:
    "La primera vez que hace falta OCR se descarga el motor y el modelo del idioma desde una CDN pública (unos megabytes, luego quedan en caché). Es la única petición de red: tu documento no viaja a ninguna parte.",

  previewTitle: "Vista previa",
  previewIntro:
    "Genera el Markdown y míralo antes de descargarlo. Si algo no te cuadra, cambia las opciones y vuelve a generarlo.",
  previewRun: "Generar vista previa",
  previewRefresh: "Regenerar",
  previewRunning: "Analizando el documento",
  previewCancel: "Cancelar",
  previewEmpty: "No se extrajo nada de este documento.",
  previewStale:
    "Has cambiado las opciones: regenera la vista previa para verlas aplicadas.",
  previewTruncated: (shown, total) =>
    `Vista previa recortada a ${shown.toLocaleString("es-ES")} de ${total.toLocaleString("es-ES")} caracteres. La descarga incluye todo.`,

  statPages: (value) => `${value} ${value === 1 ? "página" : "páginas"}`,
  statOcrPages: (value) => `${value} con OCR`,
  statHeadings: (value) => `${value} ${value === 1 ? "título" : "títulos"}`,
  statListItems: (value) => `${value} de lista`,
  statTables: (value) => `${value} ${value === 1 ? "tabla" : "tablas"}`,
  statCodeBlocks: (value) => `${value} de código`,
  statCharacters: (value) => `${value.toLocaleString("es-ES")} caracteres`,

  largeFile:
    "El archivo pasa de 100 MB. Analizar un documento así puede agotar la memoria de la pestaña.",
  filenameSuffix: "markdown",
};

const en: PdfToMarkdownStrings = {
  howItWorksTitle: "What this tool does",
  howItWorksBody:
    "It reads the PDF text layer with its position, size and typeface, and from that rebuilds headings, lists, code blocks and regular tables as Markdown. Everything runs in your browser: the document is never uploaded.",
  limitsTitle: "What it cannot do",
  limitsBody:
    "This is semantic extraction, not an exact conversion. A PDF stores no structure, only letters placed on a page: two-column documents, tables with merged cells, footnotes and academic paper layouts do not come out clean. We would rather say so up front: check the result.",

  headingsLabel: "Detect headings",
  headingsHint:
    "Lines larger than the body text (or short and bold) become #, ## and ###.",
  tablesLabel: "Detect tables",
  tablesHint:
    "Only regular grids are rebuilt: the same aligned columns across three rows or more. Deliberately conservative — an invented table breaks more than it fixes.",
  stripRepeatedLabel: "Remove repeated headers and footers",
  stripRepeatedHint:
    "Drops the line that repeats at the top or bottom of nearly every page: numbering, running head, legal notice.",
  pageSeparatorsLabel: "Separate pages with a rule",
  pageSeparatorsHint: "Inserts a --- line between the content of each page.",
  ocrLabel: "Recognise scanned pages (OCR)",
  ocrHint:
    "When a page has no selectable text it is rasterised and recognised. Recognised text comes out as plain paragraphs: OCR gives no headings or lists.",
  ocrLanguageLabel: "Scan language",
  ocrLanguageNames: {
    spa: "Spanish",
    eng: "English",
    fra: "French",
    por: "Portuguese",
  },
  ocrNotice:
    "The first time OCR is needed the engine and the language model are downloaded from a public CDN (a few megabytes, cached afterwards). That is the only network request: your document goes nowhere.",

  previewTitle: "Preview",
  previewIntro:
    "Generate the Markdown and read it before downloading. If something looks off, change the options and generate it again.",
  previewRun: "Generate preview",
  previewRefresh: "Regenerate",
  previewRunning: "Analysing the document",
  previewCancel: "Cancel",
  previewEmpty: "Nothing could be extracted from this document.",
  previewStale: "You changed the options: regenerate the preview to see them applied.",
  previewTruncated: (shown, total) =>
    `Preview trimmed to ${shown.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} characters. The download has everything.`,

  statPages: (value) => `${value} ${value === 1 ? "page" : "pages"}`,
  statOcrPages: (value) => `${value} via OCR`,
  statHeadings: (value) => `${value} ${value === 1 ? "heading" : "headings"}`,
  statListItems: (value) => `${value} list items`,
  statTables: (value) => `${value} ${value === 1 ? "table" : "tables"}`,
  statCodeBlocks: (value) => `${value} code blocks`,
  statCharacters: (value) => `${value.toLocaleString("en-GB")} characters`,

  largeFile:
    "The file is over 100 MB. Analysing a document that size may exhaust the tab's memory.",
  filenameSuffix: "markdown",
};

export const PDF_TO_MARKDOWN_STRINGS: Record<Language, PdfToMarkdownStrings> = {
  es,
  en,
};
