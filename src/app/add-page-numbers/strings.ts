import type { Language } from "@/lib/i18n";

/** Copy propio de la herramienta de numeración de páginas (ES/EN). */
export type PageNumbersStrings = {
  modeLabel: string;
  modeSingle: string;
  modeFacing: string;
  modeHint: string;
  positionLabel: string;
  positionHint: string;
  marginLabel: string;
  marginSmall: string;
  marginRecommended: string;
  marginLarge: string;
  firstNumberLabel: string;
  pagesLabel: string;
  pagesFrom: string;
  pagesTo: string;
  pagesHint: string;
  formatLabel: string;
  formatOnlyNumber: string;
  formatPageN: string;
  formatPageNofP: string;
  formatCustom: string;
  customLabel: string;
  customHint: string;
  previewLabel: string;
  fontLabel: string;
  fontHelvetica: string;
  fontTimes: string;
  fontCourier: string;
  sizeLabel: string;
  colorLabel: string;
  anchorLabels: Record<string, string>;
  /** Plantillas: {n} numero, {p} total. */
  templatePageN: string;
  templatePageNofP: string;
  filenameSuffix: string;
};

const es: PageNumbersStrings = {
  modeLabel: "Modo de página",
  modeSingle: "Página única",
  modeFacing: "Páginas enfrentadas",
  modeHint:
    "En páginas enfrentadas el número salta al lado opuesto en las pares, como en un libro impreso.",
  positionLabel: "Posición",
  positionHint: "Dónde se coloca el número dentro de cada página.",
  marginLabel: "Margen",
  marginSmall: "Pequeño",
  marginRecommended: "Recomendado",
  marginLarge: "Grande",
  firstNumberLabel: "Primer número",
  pagesLabel: "Páginas que numerar",
  pagesFrom: "Desde",
  pagesTo: "Hasta",
  pagesHint: "Deja «Hasta» en 0 para numerar hasta la última página.",
  formatLabel: "Formato del texto",
  formatOnlyNumber: "Solo el número",
  formatPageN: "Página {n}",
  formatPageNofP: "Página {n} de {p}",
  formatCustom: "Personalizado",
  customLabel: "Plantilla",
  customHint: "Usa {n} para el número de página y {p} para el total.",
  previewLabel: "Se verá así",
  fontLabel: "Tipografía",
  fontHelvetica: "Sans",
  fontTimes: "Serif",
  fontCourier: "Mono",
  sizeLabel: "Tamaño",
  colorLabel: "Color de la tinta",
  anchorLabels: {
    "top-left": "Arriba a la izquierda",
    "top-center": "Arriba en el centro",
    "top-right": "Arriba a la derecha",
    "middle-left": "En medio a la izquierda",
    "middle-center": "En el centro",
    "middle-right": "En medio a la derecha",
    "bottom-left": "Abajo a la izquierda",
    "bottom-center": "Abajo en el centro",
    "bottom-right": "Abajo a la derecha",
  },
  templatePageN: "Página {n}",
  templatePageNofP: "Página {n} de {p}",
  filenameSuffix: "numerado",
};

const en: PageNumbersStrings = {
  modeLabel: "Page mode",
  modeSingle: "Single page",
  modeFacing: "Facing pages",
  modeHint:
    "With facing pages the number flips to the opposite side on even pages, like a printed book.",
  positionLabel: "Position",
  positionHint: "Where the number sits inside every page.",
  marginLabel: "Margin",
  marginSmall: "Small",
  marginRecommended: "Recommended",
  marginLarge: "Large",
  firstNumberLabel: "First number",
  pagesLabel: "Pages to number",
  pagesFrom: "From",
  pagesTo: "To",
  pagesHint: "Leave “To” at 0 to number up to the last page.",
  formatLabel: "Text format",
  formatOnlyNumber: "Number only",
  formatPageN: "Page {n}",
  formatPageNofP: "Page {n} of {p}",
  formatCustom: "Custom",
  customLabel: "Template",
  customHint: "Use {n} for the page number and {p} for the total.",
  previewLabel: "It will read",
  fontLabel: "Typeface",
  fontHelvetica: "Sans",
  fontTimes: "Serif",
  fontCourier: "Mono",
  sizeLabel: "Size",
  colorLabel: "Ink colour",
  anchorLabels: {
    "top-left": "Top left",
    "top-center": "Top centre",
    "top-right": "Top right",
    "middle-left": "Middle left",
    "middle-center": "Centre",
    "middle-right": "Middle right",
    "bottom-left": "Bottom left",
    "bottom-center": "Bottom centre",
    "bottom-right": "Bottom right",
  },
  templatePageN: "Page {n}",
  templatePageNofP: "Page {n} of {p}",
  filenameSuffix: "numbered",
};

export const PAGE_NUMBERS_STRINGS: Record<Language, PageNumbersStrings> = {
  es,
  en,
};
