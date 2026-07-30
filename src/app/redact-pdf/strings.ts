import type { Language } from "@/lib/i18n";

/** Copy propio de Censurar PDF (ES/EN). */
export type RedactStrings = {
  canvasTitle: string;
  drawHintRect: string;
  drawHintBrush: string;
  drawHintEraser: string;
  loadingPreview: string;
  previousPage: string;
  nextPage: string;
  pageOf: (current: number, total: number) => string;
  thumbsTitle: string;
  goToPage: (page: number) => string;

  toolLabel: string;
  toolRect: string;
  toolBrush: string;
  toolEraser: string;

  effectLabel: string;
  effectBlack: string;
  effectBlur: string;
  effectPixelate: string;
  effectPaint: string;
  paintColorLabel: string;
  brushSizeLabel: string;

  undo: string;
  redo: string;

  boxesOnPage: (count: number) => string;
  totalBoxes: (count: number) => string;
  removeBox: string;
  clearPage: string;
  clearAll: string;
  noBoxes: string;

  howItWorksTitle: string;
  howItWorksBody: string;
  rasterWarning: string;

  largeFile: string;
  filenameSuffix: string;
};

const es: RedactStrings = {
  canvasTitle: "Zonas que se destruyen",
  drawHintRect:
    "Arrastra sobre la página para dibujar un rectángulo. Puedes añadir todos los que quieras y en cualquier página.",
  drawHintBrush:
    "Dibuja a mano alzada sobre la página, como con un rotulador. El trazo sigue el dedo o el cursor.",
  drawHintEraser:
    "Toca o arrastra sobre una zona ya dibujada para borrarla por completo.",
  loadingPreview: "Preparando la vista previa",
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  pageOf: (current, total) => `Página ${current} de ${total}`,
  thumbsTitle: "Páginas",
  goToPage: (page) => `Ir a la página ${page}`,

  toolLabel: "Herramienta",
  toolRect: "Rectángulo",
  toolBrush: "Pincel",
  toolEraser: "Borrador",

  effectLabel: "Efecto",
  effectBlack: "Negro",
  effectBlur: "Difuminado",
  effectPixelate: "Pixelado",
  effectPaint: "Color",
  paintColorLabel: "Color de pintura",
  brushSizeLabel: "Grosor del pincel",

  undo: "Deshacer",
  redo: "Rehacer",

  boxesOnPage: (count) =>
    count === 1 ? "1 zona en esta página" : `${count} zonas en esta página`,
  totalBoxes: (count) =>
    count === 1 ? "1 zona en el documento" : `${count} zonas en el documento`,
  removeBox: "Quitar esta zona",
  clearPage: "Vaciar esta página",
  clearAll: "Vaciar todo",
  noBoxes: "Dibuja al menos una zona antes de procesar.",

  howItWorksTitle: "Censura de verdad, no un parche encima",
  howItWorksBody:
    "Un rectángulo negro dibujado sobre el texto no borra nada: el contenido sigue dentro del archivo y se recupera copiando y pegando. Aquí la página se rehace: se convierte en imagen con cada zona ya tratada con su efecto (negro, difuminado, pixelado o color), así que lo que había debajo desaparece del documento.",
  rasterWarning:
    "Por eso las páginas con zonas censuradas pasan a ser imagen y su texto deja de poder seleccionarse. Las páginas que no toques se copian intactas.",

  largeFile:
    "El archivo pasa de 100 MB. Rehacer páginas de un documento así puede agotar la memoria de la pestaña.",
  filenameSuffix: "censurado",
};

const en: RedactStrings = {
  canvasTitle: "Areas to destroy",
  drawHintRect:
    "Drag across the page to draw a rectangle. Add as many as you need, on any page.",
  drawHintBrush:
    "Draw freehand over the page, like with a marker. The stroke follows your finger or cursor.",
  drawHintEraser: "Tap or drag over an existing area to remove it entirely.",
  loadingPreview: "Preparing the preview",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageOf: (current, total) => `Page ${current} of ${total}`,
  thumbsTitle: "Pages",
  goToPage: (page) => `Go to page ${page}`,

  toolLabel: "Tool",
  toolRect: "Rectangle",
  toolBrush: "Brush",
  toolEraser: "Eraser",

  effectLabel: "Effect",
  effectBlack: "Black",
  effectBlur: "Blur",
  effectPixelate: "Pixelate",
  effectPaint: "Paint",
  paintColorLabel: "Paint color",
  brushSizeLabel: "Brush size",

  undo: "Undo",
  redo: "Redo",

  boxesOnPage: (count) =>
    count === 1 ? "1 area on this page" : `${count} areas on this page`,
  totalBoxes: (count) =>
    count === 1 ? "1 area in the document" : `${count} areas in the document`,
  removeBox: "Remove this area",
  clearPage: "Clear this page",
  clearAll: "Clear everything",
  noBoxes: "Draw at least one area before processing.",

  howItWorksTitle: "Real redaction, not a patch on top",
  howItWorksBody:
    "A black rectangle drawn over the text erases nothing: the content stays inside the file and comes back with copy and paste. Here the page is rebuilt: it becomes an image with every area already treated by its effect (black, blur, pixelate, or paint), so whatever was underneath disappears from the document.",
  rasterWarning:
    "That is why redacted pages turn into images and their text stops being selectable. Pages you do not touch are copied untouched.",

  largeFile:
    "The file is over 100 MB. Rebuilding pages of a document that size may exhaust the tab's memory.",
  filenameSuffix: "redacted",
};

export const REDACT_STRINGS: Record<Language, RedactStrings> = { es, en };
