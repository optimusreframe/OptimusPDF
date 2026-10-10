import type { Language } from "@/lib/i18n";

/** Copy propio de Rotar PDF. */
export type RotateStrings = {
  boardTitle: string;
  scopeLabel: string;
  scopeAll: string;
  scopePage: string;
  angleLabel: string;
  angle90: string;
  angle180: string;
  angle270: string;
  allHint: string;
  pageHint: string;
  rotatePage: string;
  rotateAll: string;
  reset: string;
  tapHint: string;
  touched: (count: number) => string;
  untouched: string;
  /** Motivo junto a «Procesar» desactivado: ninguna pagina girada. */
  needTurn: string;
  largeFile: string;
  outputName: string;
  /** Sufijo para el archivo final descargado, sobre el nombre original. */
  filenameSuffix: string;
};

const STRINGS: Record<Language, RotateStrings> = {
  es: {
    boardTitle: "Vista previa del giro",
    scopeLabel: "Qué se gira",
    scopeAll: "Todo",
    scopePage: "Por página",
    angleLabel: "Ángulo",
    angle90: "90°",
    angle180: "180°",
    angle270: "270°",
    allHint: "El giro se aplica a todas las páginas del documento.",
    pageHint:
      "Toca una miniatura (o su botón de giro) para girarla 90 grados más.",
    rotatePage: "Girar esta página 90 grados",
    rotateAll: "Girar todas 90°",
    reset: "Dejar todo como estaba",
    tapHint: "Toca una página para girarla",
    touched: (count) =>
      count === 1 ? "1 página girada" : `${count} páginas giradas`,
    untouched: "Ninguna página girada todavía.",
    needTurn: "Gira al menos una página para poder procesar.",
    largeFile:
      "El documento supera los 100 MB: generar las miniaturas puede tardar.",
    outputName: "documento-girado",
    filenameSuffix: "rotado",
  },
  en: {
    boardTitle: "Rotation preview",
    scopeLabel: "What gets rotated",
    scopeAll: "Everything",
    scopePage: "Per page",
    angleLabel: "Angle",
    angle90: "90°",
    angle180: "180°",
    angle270: "270°",
    allHint: "The rotation is applied to every page in the document.",
    pageHint: "Tap a thumbnail (or its rotate button) to turn it 90 degrees.",
    rotatePage: "Rotate this page 90 degrees",
    rotateAll: "Rotate all 90°",
    reset: "Leave everything as it was",
    tapHint: "Tap a page to rotate it",
    touched: (count) =>
      count === 1 ? "1 page rotated" : `${count} pages rotated`,
    untouched: "No page rotated yet.",
    needTurn: "Rotate at least one page to be able to process.",
    largeFile:
      "This document is over 100 MB: building the thumbnails may take a while.",
    outputName: "rotated-document",
    filenameSuffix: "rotated",
  },
};

export function getRotateStrings(language: Language): RotateStrings {
  return STRINGS[language];
}
