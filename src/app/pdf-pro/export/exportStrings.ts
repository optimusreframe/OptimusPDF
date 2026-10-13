import type { Language } from "@/lib/i18n";
import type { ExportFormatId } from "@/app/pdf-pro/export/exportTypes";

/**
 * Textos de la exportacion de PDF Pro (Wave 7 · U8), es/en. Las etiquetas de las OPCIONES de cada formato salen de
 * las herramientas sueltas (`/pdf-to-*`), para que digan lo mismo en las dos partes; aqui solo van lo propio de la
 * pestaña «Convertir»: tarjetas, estado, imagenes (PNG, rango, seleccion) y avisos de red.
 */
export type ExportStrings = {
  formats: Record<ExportFormatId, { title: string; body: string }>;
  card: {
    showOptions: string;
    hideOptions: string;
    running: string;
    cancel: string;
    cancelled: string;
    /** Wave 8 (backlog a): la tarjeta se desmonto (otra pestaña, documento cerrado) con una exportacion en curso. */
    cancelledOnLeave: string;
    done: (filename: string) => string;
    localOnly: string;
    requiresNetwork: string;
    mayNeedNetwork: string;
    ocrNetwork: string;
    ocrOffline: string;
    largeDocument: string;
    inProgressOther: string;
  };
  images: {
    formatLabel: string;
    jpg: string;
    png: string;
    pngHint: string;
    dpi: { 1: string; 2: string; 3: string };
    scopeLabel: string;
    scopeAll: string;
    scopeRange: string;
    scopeSelected: string;
    rangeLabel: string;
    rangePlaceholder: string;
    rangeHint: (total: number) => string;
    rangeEmpty: string;
    rangeInvalid: (total: number) => string;
    selectedHint: (count: number) => string;
    selectionEmpty: string;
    summary: (count: number, zip: boolean) => string;
  };
  csv: { formatLabel: string; csv: string; json: string };
};

const es: ExportStrings = {
  formats: {
    images: { title: "Imágenes (JPG o PNG)", body: "Una imagen por página; si son varias, se agrupan en un ZIP." },
    text: { title: "Texto (.txt)", body: "Todo el texto del documento, página por página, como texto plano." },
    word: { title: "Word (.docx)", body: "Títulos, párrafos, listas y tablas en un documento que puedes editar." },
    excel: { title: "Excel (.xlsx)", body: "Las tablas que detecta el documento, una hoja por tabla." },
    csv: { title: "CSV (tablas)", body: "Las tablas del documento en un archivo CSV o JSON." },
    markdown: { title: "Markdown (.md)", body: "Texto con títulos, listas y tablas en Markdown." },
    json: { title: "JSON (.json)", body: "La estructura del documento (títulos, párrafos, listas y tablas) en JSON." },
    powerpoint: { title: "PowerPoint (.pptx)", body: "Una diapositiva por página, como imagen (no son diapositivas editables)." },
  },
  card: {
    showOptions: "Opciones",
    hideOptions: "Ocultar opciones",
    running: "Exportando…",
    cancel: "Cancelar",
    cancelled: "Exportación cancelada.",
    cancelledOnLeave: "La exportación se canceló al salir de Convertir: vuelve y pulsa Exportar de nuevo.",
    done: (filename) => `Exportado: ${filename}`,
    localOnly: "Solo en tu dispositivo",
    requiresNetwork: "Requiere conexión",
    mayNeedNetwork: "Puede requerir conexión",
    ocrNetwork:
      "Las páginas sin texto se reconocen con OCR. La primera vez se descarga el modelo del idioma, así que necesita conexión.",
    ocrOffline:
      "Estás sin conexión: las páginas escaneadas no se podrán reconocer. Desactiva el OCR o vuelve a conectarte.",
    largeDocument: "Este documento es grande: exportarlo puede tardar y usar mucha memoria.",
    inProgressOther: "Hay otra exportación en curso.",
  },
  images: {
    formatLabel: "Formato",
    jpg: "JPG",
    png: "PNG",
    pngHint: "PNG no pierde calidad, pero pesa más.",
    dpi: { 1: "72 DPI (1x)", 2: "144 DPI (2x)", 3: "216 DPI (3x)" },
    scopeLabel: "Páginas",
    scopeAll: "Todas",
    scopeRange: "Rango",
    scopeSelected: "Seleccionadas",
    rangeLabel: "Rango de páginas",
    rangePlaceholder: "1-3, 5",
    rangeHint: (total) => `Escribe páginas o rangos entre 1 y ${total}, separados por comas.`,
    rangeEmpty: "Escribe un rango de páginas.",
    rangeInvalid: (total) => `El rango no es válido: usa números entre 1 y ${total}, como 1-3, 5.`,
    selectedHint: (count) =>
      count === 1 ? "1 página seleccionada en el visor o en las miniaturas." : `${count} páginas seleccionadas en el visor o en las miniaturas.`,
    selectionEmpty: "No hay páginas seleccionadas. Selecciónalas en el visor o en las miniaturas.",
    summary: (count, zip) =>
      zip ? `${count} imágenes en un ZIP.` : count === 1 ? "Una imagen." : `${count} imágenes.`,
  },
  csv: { formatLabel: "Formato", csv: "CSV", json: "JSON" },
};

const en: ExportStrings = {
  formats: {
    images: { title: "Images (JPG or PNG)", body: "One image per page; several are grouped in a ZIP." },
    text: { title: "Text (.txt)", body: "All the text of the document, page by page, as plain text." },
    word: { title: "Word (.docx)", body: "Headings, paragraphs, lists and tables in a document you can edit." },
    excel: { title: "Excel (.xlsx)", body: "The tables found in the document, one sheet per table." },
    csv: { title: "CSV (tables)", body: "The tables of the document in a CSV or JSON file." },
    markdown: { title: "Markdown (.md)", body: "Text with headings, lists and tables in Markdown." },
    json: { title: "JSON (.json)", body: "The structure of the document (headings, paragraphs, lists and tables) as JSON." },
    powerpoint: { title: "PowerPoint (.pptx)", body: "One slide per page, as an image (not editable slides)." },
  },
  card: {
    showOptions: "Options",
    hideOptions: "Hide options",
    running: "Exporting…",
    cancel: "Cancel",
    cancelled: "Export cancelled.",
    cancelledOnLeave: "The export was cancelled when you left Convert: come back and press Export again.",
    done: (filename) => `Exported: ${filename}`,
    localOnly: "On your device only",
    requiresNetwork: "Requires a connection",
    mayNeedNetwork: "May require a connection",
    ocrNetwork:
      "Pages without text are recognised with OCR. The first time, the language model is downloaded, so it needs a connection.",
    ocrOffline:
      "You are offline: scanned pages can't be recognised. Turn OCR off or reconnect.",
    largeDocument: "This document is large: exporting it can take a while and use a lot of memory.",
    inProgressOther: "Another export is in progress.",
  },
  images: {
    formatLabel: "Format",
    jpg: "JPG",
    png: "PNG",
    pngHint: "PNG keeps full quality but is heavier.",
    dpi: { 1: "72 DPI (1x)", 2: "144 DPI (2x)", 3: "216 DPI (3x)" },
    scopeLabel: "Pages",
    scopeAll: "All",
    scopeRange: "Range",
    scopeSelected: "Selected",
    rangeLabel: "Page range",
    rangePlaceholder: "1-3, 5",
    rangeHint: (total) => `Type pages or ranges between 1 and ${total}, separated by commas.`,
    rangeEmpty: "Type a page range.",
    rangeInvalid: (total) => `The range isn't valid: use numbers between 1 and ${total}, like 1-3, 5.`,
    selectedHint: (count) =>
      count === 1 ? "1 page selected in the viewer or the thumbnails." : `${count} pages selected in the viewer or the thumbnails.`,
    selectionEmpty: "No pages are selected. Select them in the viewer or the thumbnails.",
    summary: (count, zip) =>
      zip ? `${count} images in a ZIP.` : count === 1 ? "One image." : `${count} images.`,
  },
  csv: { formatLabel: "Format", csv: "CSV", json: "JSON" },
};

export const EXPORT_STRINGS: Record<Language, ExportStrings> = { es, en };

export function getExportStrings(language: Language): ExportStrings {
  return EXPORT_STRINGS[language] ?? es;
}
