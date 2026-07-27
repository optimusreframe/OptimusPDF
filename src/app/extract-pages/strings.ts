import type { Language } from "@/lib/i18n";

/** Copy propio de Extraer páginas. */
export type ExtractPagesStrings = {
  boardTitle: string;
  intro: string;
  outputLabel: string;
  outputSingle: string;
  outputPerPage: string;
  outputSingleHint: string;
  outputPerPageHint: string;
  rangeLabel: string;
  rangePlaceholder: string;
  rangeHint: string;
  rangeInvalid: string;
  keepOne: string;
  selectLabel: string;
  unselectLabel: string;
  selectAll: string;
  invert: string;
  selected: (count: number, total: number) => string;
  zipNotice: (parts: number) => string;
  largeFile: string;
  outputName: string;
};

const STRINGS: Record<Language, ExtractPagesStrings> = {
  es: {
    boardTitle: "Elige qué te llevas",
    intro:
      "Toca las páginas que quieres extraer o escribe sus números. Las marcadas en azul son las que saldrán.",
    outputLabel: "Cómo se entrega",
    outputSingle: "Un PDF",
    outputPerPage: "Uno por página",
    outputSingleHint:
      "Todas las páginas elegidas se juntan en un único documento nuevo.",
    outputPerPageHint:
      "Cada página elegida se guarda en su propio PDF y todos llegan en un ZIP.",
    rangeLabel: "Páginas a extraer",
    rangePlaceholder: "1, 3-5",
    rangeHint: "Números sueltos o rangos separados por comas.",
    rangeInvalid: "Revisa el formato: solo números y rangos dentro del documento.",
    keepOne: "Elige al menos una página.",
    selectLabel: "Añadir a la extracción",
    unselectLabel: "Sacar de la extracción",
    selectAll: "Elegir todas",
    invert: "Invertir la selección",
    selected: (count, total) => `${count} de ${total} páginas elegidas`,
    zipNotice: (parts) => `Se generarán ${parts} PDF dentro de un ZIP.`,
    largeFile:
      "El documento supera los 100 MB: generar las miniaturas puede tardar.",
    outputName: "paginas-extraidas",
  },
  en: {
    boardTitle: "Choose what you take",
    intro:
      "Tap the pages you want to pull out, or type their numbers. The ones in blue are the ones you get.",
    outputLabel: "How it comes out",
    outputSingle: "One PDF",
    outputPerPage: "One per page",
    outputSingleHint: "Every chosen page goes into a single new document.",
    outputPerPageHint:
      "Each chosen page gets its own PDF and they all arrive in a ZIP.",
    rangeLabel: "Pages to extract",
    rangePlaceholder: "1, 3-5",
    rangeHint: "Single numbers or ranges, separated by commas.",
    rangeInvalid: "Check the format: only numbers and ranges inside the document.",
    keepOne: "Pick at least one page.",
    selectLabel: "Add to the extraction",
    unselectLabel: "Take out of the extraction",
    selectAll: "Pick them all",
    invert: "Invert the selection",
    selected: (count, total) => `${count} of ${total} pages chosen`,
    zipNotice: (parts) => `${parts} PDF files will arrive inside a ZIP.`,
    largeFile:
      "This document is over 100 MB: building the thumbnails may take a while.",
    outputName: "extracted-pages",
  },
};

export function getExtractPagesStrings(
  language: Language,
): ExtractPagesStrings {
  return STRINGS[language];
}
