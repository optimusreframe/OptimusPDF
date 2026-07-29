import type { Language } from "@/lib/i18n";

/** Copy propio de Eliminar páginas. */
export type RemovePagesStrings = {
  boardTitle: string;
  intro: string;
  rangeLabel: string;
  rangePlaceholder: string;
  rangeHint: string;
  rangeInvalid: string;
  keepLast: string;
  markLabel: string;
  unmarkLabel: string;
  clear: string;
  markedNone: string;
  marked: (count: number) => string;
  kept: (kept: number, total: number) => string;
  largeFile: string;
  outputName: string;
  /** Sufijo para el archivo final descargado, sobre el nombre original. */
  filenameSuffix: string;
};

const STRINGS: Record<Language, RemovePagesStrings> = {
  es: {
    boardTitle: "Marca lo que sobra",
    intro:
      "Toca las páginas que quieres quitar: se marcan en rojo. También puedes escribir los números a mano.",
    rangeLabel: "Páginas a eliminar",
    rangePlaceholder: "1, 3-5",
    rangeHint: "Números sueltos o rangos separados por comas.",
    rangeInvalid: "Revisa el formato: solo números y rangos dentro del documento.",
    keepLast: "No puedes eliminar todas las páginas: al menos una tiene que quedarse.",
    markLabel: "Marcar para eliminar",
    unmarkLabel: "Conservar esta página",
    clear: "Quitar todas las marcas",
    markedNone: "Ninguna página marcada: el documento saldría igual que entró.",
    marked: (count) =>
      count === 1 ? "1 página marcada" : `${count} páginas marcadas`,
    kept: (kept, total) => `Quedan ${kept} de ${total} páginas`,
    largeFile:
      "El documento supera los 100 MB: generar las miniaturas puede tardar.",
    outputName: "documento-sin-paginas",
    filenameSuffix: "sin-paginas",
  },
  en: {
    boardTitle: "Mark what has to go",
    intro:
      "Tap the pages you want to drop: they turn red. You can also type the numbers by hand.",
    rangeLabel: "Pages to delete",
    rangePlaceholder: "1, 3-5",
    rangeHint: "Single numbers or ranges, separated by commas.",
    rangeInvalid: "Check the format: only numbers and ranges inside the document.",
    keepLast: "You cannot delete every page: at least one has to stay.",
    markLabel: "Mark for deletion",
    unmarkLabel: "Keep this page",
    clear: "Clear every mark",
    markedNone: "No page marked: the document would come out exactly as it went in.",
    marked: (count) =>
      count === 1 ? "1 page marked" : `${count} pages marked`,
    kept: (kept, total) => `${kept} of ${total} pages stay`,
    largeFile:
      "This document is over 100 MB: building the thumbnails may take a while.",
    outputName: "trimmed-document",
    filenameSuffix: "pages-removed",
  },
};

export function getRemovePagesStrings(language: Language): RemovePagesStrings {
  return STRINGS[language];
}
