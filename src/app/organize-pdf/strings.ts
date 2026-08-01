import type { Language } from "@/lib/i18n";

/**
 * Copy propio de Organizar PDF. Vive junto a la herramienta porque solo
 * la usa ella; el copy compartido sigue en `lib/locales`.
 */
export type OrganizeStrings = {
  boardTitle: string;
  intro: string;
  /**
   * `blanks` rompe el invariante implicito "kept <= total" que asumia el
   * copy original (kept = paginas del documento original que sobreviven)
   * en cuanto se inserta una pagina en blanco -- ver el caso real "4 de 3
   * paginas" encontrado en revision adversarial. Cuando `blanks > 0` el
   * texto debe dejar de enmarcarse como "N de M" y explicar el total real.
   */
  summary: (kept: number, total: number, blanks: number) => string;
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
  /** Etiqueta del boton que inserta una pagina en blanco tras esta. */
  insertBlank: string;
  /** Texto mostrado en la miniatura/etiqueta de una pagina en blanco. */
  blankPage: string;
  /** Aviso cuando el plan no tiene ninguna pagina del documento original. */
  allBlankWarning: string;
  /** Sufijo para el archivo final descargado, sobre el nombre original. */
  filenameSuffix: string;
};

const STRINGS: Record<Language, OrganizeStrings> = {
  es: {
    boardTitle: "Páginas del documento",
    intro:
      "Arrastra las miniaturas para cambiar el orden. Pasa el puntero por encima (o toca) para girar o quitar una página.",
    summary: (kept, total, blanks) =>
      blanks > 0
        ? `${kept} páginas en el documento final (${kept - blanks} de ${total} originales, ${blanks} en blanco)`
        : `${kept} de ${total} páginas en el documento final`,
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
    filenameSuffix: "organizado",
    insertBlank: "Insertar página en blanco después",
    blankPage: "En blanco",
    allBlankWarning:
      "El plan no tiene ninguna página del documento original: el resultado será un PDF solo con páginas en blanco.",
  },
  en: {
    boardTitle: "Document pages",
    intro:
      "Drag the thumbnails to change the order. Hover (or tap) a page to rotate or drop it.",
    summary: (kept, total, blanks) =>
      blanks > 0
        ? `${kept} pages in the final document (${kept - blanks} of ${total} original, ${blanks} blank)`
        : `${kept} of ${total} pages in the final document`,
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
    filenameSuffix: "organised",
    insertBlank: "Insert blank page after",
    blankPage: "Blank",
    allBlankWarning:
      "The plan has no pages from the original document: the result will be a PDF made only of blank pages.",
  },
};

export function getOrganizeStrings(language: Language): OrganizeStrings {
  return STRINGS[language];
}
