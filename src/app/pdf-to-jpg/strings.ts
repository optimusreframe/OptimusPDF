import type { Language } from "@/lib/i18n";

/** Textos propios de "PDF a JPG". Copy original ES/EN. */
export type PdfToJpgStrings = {
  qualityLabel: string;
  qualityHint: string;
  scaleLabel: string;
  scale1x: string;
  scale2x: string;
  scale3x: string;
  scaleHint: string;
  pagesLabel: string;
  pagesAll: string;
  pagesCustom: string;
  pagesHint: string;
  noPagesSelected: string;
  outputHint: string;
  /** Prefijo de los archivos dentro del ZIP. */
  filePrefix: string;
};

export const STRINGS: Record<Language, PdfToJpgStrings> = {
  es: {
    qualityLabel: "Calidad JPG",
    qualityHint: "Más calidad significa archivos más pesados.",
    scaleLabel: "Resolución",
    scale1x: "1x",
    scale2x: "2x",
    scale3x: "3x",
    scaleHint: "1x equivale a 72 puntos por pulgada; 3x, a 216.",
    pagesLabel: "Páginas",
    pagesAll: "Todas",
    pagesCustom: "Elegir",
    pagesHint: "Pulsa las miniaturas para incluir o descartar páginas.",
    noPagesSelected: "No queda ninguna página marcada.",
    outputHint:
      "Una sola página se descarga como JPG; varias, agrupadas en un ZIP.",
    filePrefix: "pagina",
  },
  en: {
    qualityLabel: "JPG quality",
    qualityHint: "Higher quality means heavier files.",
    scaleLabel: "Resolution",
    scale1x: "1x",
    scale2x: "2x",
    scale3x: "3x",
    scaleHint: "1x equals 72 dots per inch; 3x equals 216.",
    pagesLabel: "Pages",
    pagesAll: "All",
    pagesCustom: "Pick",
    pagesHint: "Tap the thumbnails to include or drop pages.",
    noPagesSelected: "No page is selected right now.",
    outputHint: "A single page downloads as a JPG; several arrive in a ZIP.",
    filePrefix: "page",
  },
};
