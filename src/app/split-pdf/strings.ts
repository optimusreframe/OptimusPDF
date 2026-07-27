import type { Language } from "@/lib/i18n";

/** Copy propio de Dividir PDF. */
export type SplitStrings = {
  boardTitle: string;
  modeLabel: string;
  modeCustom: string;
  modeFixed: string;
  modeExtract: string;

  customHint: string;
  rangeTitle: (position: number) => string;
  from: string;
  to: string;
  addRange: string;
  removeRange: string;
  mergeLabel: string;
  mergeHint: string;
  rangesInvalid: string;

  fixedLabel: string;
  fixedHint: string;

  extractScopeLabel: string;
  extractAll: string;
  extractSelection: string;
  extractAllHint: string;
  extractSelectionHint: string;
  rangeLabel: string;
  rangePlaceholder: string;
  rangeHint: string;
  rangeInvalid: string;
  pickOne: string;
  selectLabel: string;
  unselectLabel: string;

  resultOne: string;
  resultMany: (parts: number) => string;
  resultNone: string;
  partBadge: (part: number) => string;
  outsideHint: string;
  largeFile: string;
  outputName: string;
};

const STRINGS: Record<Language, SplitStrings> = {
  es: {
    boardTitle: "Cómo queda el reparto",
    modeLabel: "Modo",
    modeCustom: "Rangos",
    modeFixed: "Cada N",
    modeExtract: "Extraer",

    customHint:
      "Define los tramos que quieres separar. Puedes añadir tantos como necesites.",
    rangeTitle: (position) => `Tramo ${position}`,
    from: "Desde",
    to: "Hasta",
    addRange: "Añadir otro tramo",
    removeRange: "Quitar este tramo",
    mergeLabel: "Juntar todos los tramos en un solo PDF",
    mergeHint:
      "Si lo dejas apagado, cada tramo sale como documento propio dentro de un ZIP.",
    rangesInvalid:
      "Ningún tramo es válido: revisa que el final no sea menor que el principio.",

    fixedLabel: "Páginas por documento",
    fixedHint: "El documento se corta en bloques consecutivos de este tamaño.",

    extractScopeLabel: "Qué se extrae",
    extractAll: "Todas",
    extractSelection: "Selección",
    extractAllHint:
      "Cada página se guarda en su propio PDF y todos llegan en un ZIP.",
    extractSelectionHint:
      "Las páginas elegidas se juntan en un único documento nuevo.",
    rangeLabel: "Páginas",
    rangePlaceholder: "1, 3-5",
    rangeHint: "Números sueltos o rangos separados por comas.",
    rangeInvalid: "Revisa el formato: solo números y rangos dentro del documento.",
    pickOne: "Elige al menos una página.",
    selectLabel: "Añadir a la extracción",
    unselectLabel: "Sacar de la extracción",

    resultOne: "Saldrá un único PDF.",
    resultMany: (parts) => `Saldrán ${parts} documentos dentro de un ZIP.`,
    resultNone: "Con estas opciones no saldría ningún documento.",
    partBadge: (part) => `P${part}`,
    outsideHint: "Las páginas apagadas se quedan fuera del reparto.",
    largeFile:
      "El documento supera los 100 MB: generar las miniaturas puede tardar.",
    outputName: "documento-dividido",
  },
  en: {
    boardTitle: "How the split lands",
    modeLabel: "Mode",
    modeCustom: "Ranges",
    modeFixed: "Every N",
    modeExtract: "Extract",

    customHint:
      "Define the stretches you want to separate. Add as many as you need.",
    rangeTitle: (position) => `Stretch ${position}`,
    from: "From",
    to: "To",
    addRange: "Add another stretch",
    removeRange: "Drop this stretch",
    mergeLabel: "Put every stretch into a single PDF",
    mergeHint:
      "Leave it off and each stretch comes out as its own document inside a ZIP.",
    rangesInvalid:
      "No stretch is valid: check that the end is not before the start.",

    fixedLabel: "Pages per document",
    fixedHint: "The document is cut into consecutive blocks of this size.",

    extractScopeLabel: "What gets extracted",
    extractAll: "Every page",
    extractSelection: "A selection",
    extractAllHint: "Each page gets its own PDF and they all arrive in a ZIP.",
    extractSelectionHint: "The chosen pages go into a single new document.",
    rangeLabel: "Pages",
    rangePlaceholder: "1, 3-5",
    rangeHint: "Single numbers or ranges, separated by commas.",
    rangeInvalid: "Check the format: only numbers and ranges inside the document.",
    pickOne: "Pick at least one page.",
    selectLabel: "Add to the extraction",
    unselectLabel: "Take out of the extraction",

    resultOne: "You get a single PDF.",
    resultMany: (parts) => `You get ${parts} documents inside a ZIP.`,
    resultNone: "These options would produce no document at all.",
    partBadge: (part) => `P${part}`,
    outsideHint: "Dimmed pages stay out of the split.",
    largeFile:
      "This document is over 100 MB: building the thumbnails may take a while.",
    outputName: "split-document",
  },
};

export function getSplitStrings(language: Language): SplitStrings {
  return STRINGS[language];
}
