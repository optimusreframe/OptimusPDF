import type { Language } from "@/lib/i18n";

/** Copy propio de la herramienta de comparación (ES/EN). */
export type CompareStrings = {
  slotA: string;
  slotB: string;
  slotHintA: string;
  slotHintB: string;
  replace: string;
  run: string;
  processing: string;
  startOver: string;
  summaryTitle: string;
  changedPages: (count: number) => string;
  noChanges: string;
  addedWords: (count: number) => string;
  removedWords: (count: number) => string;
  pagesCompared: (total: number) => string;
  documentSizes: (a: number, b: number) => string;
  showAll: string;
  showOnlyChanged: string;
  pageLabel: (page: number) => string;
  missingInA: string;
  missingInB: string;
  emptyPage: string;
  coarseNotice: string;
  noTextLayer: string;
  legendEqual: string;
  legendAdded: string;
  legendRemoved: string;
  needBoth: string;
};

const es: CompareStrings = {
  slotA: "Documento A",
  slotB: "Documento B",
  slotHintA: "La versión de partida.",
  slotHintB: "La versión que quieres contrastar.",
  replace: "Cambiar archivo",
  run: "Comparar",
  processing: "Comparando documentos",
  startOver: "Empezar de nuevo",
  summaryTitle: "Resumen",
  changedPages: (count) =>
    count === 1 ? "1 página con diferencias" : `${count} páginas con diferencias`,
  noChanges: "No hay diferencias de texto entre los dos documentos.",
  addedWords: (count) =>
    count === 1 ? "1 palabra añadida" : `${count} palabras añadidas`,
  removedWords: (count) =>
    count === 1 ? "1 palabra eliminada" : `${count} palabras eliminadas`,
  pagesCompared: (total) => `${total} páginas comparadas`,
  documentSizes: (a, b) => `A: ${a} páginas · B: ${b} páginas`,
  showAll: "Ver todas las páginas",
  showOnlyChanged: "Ver solo las que cambian",
  pageLabel: (page) => `Página ${page}`,
  missingInA: "Esta página no existe en el documento A.",
  missingInB: "Esta página no existe en el documento B.",
  emptyPage: "Sin texto extraíble en esta página.",
  coarseNotice:
    "Esta página es demasiado extensa para el contraste palabra a palabra: se marca el bloque completo.",
  noTextLayer:
    "Ninguno de los dos documentos tiene texto extraíble. Si son escaneos, pásalos antes por OCR de PDF.",
  legendEqual: "Igual",
  legendAdded: "Añadido",
  legendRemoved: "Eliminado",
  needBoth: "Añade los dos documentos para poder compararlos.",
};

const en: CompareStrings = {
  slotA: "Document A",
  slotB: "Document B",
  slotHintA: "The starting version.",
  slotHintB: "The version you want to check against it.",
  replace: "Change file",
  run: "Compare",
  processing: "Comparing documents",
  startOver: "Start over",
  summaryTitle: "Summary",
  changedPages: (count) =>
    count === 1 ? "1 page with differences" : `${count} pages with differences`,
  noChanges: "There are no text differences between the two documents.",
  addedWords: (count) => (count === 1 ? "1 word added" : `${count} words added`),
  removedWords: (count) =>
    count === 1 ? "1 word removed" : `${count} words removed`,
  pagesCompared: (total) => `${total} pages compared`,
  documentSizes: (a, b) => `A: ${a} pages · B: ${b} pages`,
  showAll: "Show every page",
  showOnlyChanged: "Show only what changed",
  pageLabel: (page) => `Page ${page}`,
  missingInA: "This page does not exist in document A.",
  missingInB: "This page does not exist in document B.",
  emptyPage: "No extractable text on this page.",
  coarseNotice:
    "This page is too long for a word-by-word contrast, so the whole block is marked.",
  noTextLayer:
    "Neither document has extractable text. If they are scans, run OCR on them first.",
  legendEqual: "Unchanged",
  legendAdded: "Added",
  legendRemoved: "Removed",
  needBoth: "Add both documents to compare them.",
};

export const COMPARE_STRINGS: Record<Language, CompareStrings> = { es, en };
