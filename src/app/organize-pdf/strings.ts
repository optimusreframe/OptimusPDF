import type { Language } from "@/lib/i18n";

/**
 * Copy propio de Organizar PDF. Vive junto a la herramienta porque solo
 * la usa ella; el copy compartido sigue en `lib/locales`.
 */
export type OrganizeStrings = {
  boardTitle: string;
  intro: string;
  summary: (kept: number, total: number) => string;
  rotated: (count: number) => string;
  dragHint: string;
  rotate: string;
  removePage: string;
  moveBefore: string;
  moveAfter: string;
  restore: string;
  restoreHint: string;
  keepLast: string;
  largeFile: string;
  outputName: string;
};

const STRINGS: Record<Language, OrganizeStrings> = {
  es: {
    boardTitle: "Páginas del documento",
    intro:
      "Arrastra las miniaturas para cambiar el orden. Pasa el puntero por encima (o toca) para girar o quitar una página.",
    summary: (kept, total) =>
      `${kept} de ${total} páginas en el documento final`,
    rotated: (count) =>
      count === 1 ? "1 página girada" : `${count} páginas giradas`,
    dragHint: "Arrastra para reordenar",
    rotate: "Girar 90 grados",
    removePage: "Quitar esta página",
    moveBefore: "Mover antes",
    moveAfter: "Mover después",
    restore: "Deshacer cambios",
    restoreHint: "Vuelve al orden y la rotación originales.",
    keepLast: "Tiene que quedar al menos una página.",
    largeFile:
      "El documento supera los 100 MB: generar las miniaturas puede tardar.",
    outputName: "documento-organizado",
  },
  en: {
    boardTitle: "Document pages",
    intro:
      "Drag the thumbnails to change the order. Hover (or tap) a page to rotate or drop it.",
    summary: (kept, total) => `${kept} of ${total} pages in the final document`,
    rotated: (count) =>
      count === 1 ? "1 page rotated" : `${count} pages rotated`,
    dragHint: "Drag to reorder",
    rotate: "Rotate 90 degrees",
    removePage: "Drop this page",
    moveBefore: "Move earlier",
    moveAfter: "Move later",
    restore: "Undo changes",
    restoreHint: "Back to the original order and rotation.",
    keepLast: "At least one page has to stay.",
    largeFile:
      "This document is over 100 MB: building the thumbnails may take a while.",
    outputName: "organised-document",
  },
};

export function getOrganizeStrings(language: Language): OrganizeStrings {
  return STRINGS[language];
}
