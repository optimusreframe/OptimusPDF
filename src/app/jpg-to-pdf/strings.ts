import type { Language } from "@/lib/i18n";

/**
 * Textos propios de "Imagen a PDF". Copy original ES/EN: el diccionario
 * global solo cubre lo compartido por todas las herramientas.
 */
export type JpgToPdfStrings = {
  orientationLabel: string;
  orientationPortrait: string;
  orientationLandscape: string;
  orientationAuto: string;
  pageSizeLabel: string;
  pageSizeA4: string;
  pageSizeLetter: string;
  pageSizeFit: string;
  marginLabel: string;
  marginNone: string;
  marginSmall: string;
  marginLarge: string;
  mergeLabel: string;
  mergeHintOn: string;
  mergeHintOff: string;
  fitNote: string;
  previewTitle: string;
  previewHint: string;
  imageAlt: string;
};

export const STRINGS: Record<Language, JpgToPdfStrings> = {
  es: {
    orientationLabel: "Orientación",
    orientationPortrait: "Vertical",
    orientationLandscape: "Horizontal",
    orientationAuto: "Automática",
    pageSizeLabel: "Tamaño de página",
    pageSizeA4: "A4",
    pageSizeLetter: "Carta",
    pageSizeFit: "Ajustar",
    marginLabel: "Margen",
    marginNone: "Sin margen",
    marginSmall: "Pequeño",
    marginLarge: "Grande",
    mergeLabel: "Unir todas en un PDF",
    mergeHintOn: "Cada imagen será una página del mismo documento.",
    mergeHintOff: "Se generará un PDF por imagen dentro de un ZIP.",
    fitNote: "Con «Ajustar», la página toma el tamaño exacto de cada imagen.",
    previewTitle: "Orden de las imágenes",
    previewHint:
      "Arrastra las miniaturas o usa las flechas para fijar el orden en que deben aparecer.",
    imageAlt: "Imagen",
  },
  en: {
    orientationLabel: "Orientation",
    orientationPortrait: "Portrait",
    orientationLandscape: "Landscape",
    orientationAuto: "Automatic",
    pageSizeLabel: "Page size",
    pageSizeA4: "A4",
    pageSizeLetter: "Letter",
    pageSizeFit: "Fit",
    marginLabel: "Margin",
    marginNone: "No margin",
    marginSmall: "Small",
    marginLarge: "Large",
    mergeLabel: "Merge everything into one PDF",
    mergeHintOn: "Every image becomes a page of the same document.",
    mergeHintOff: "One PDF per image, delivered inside a ZIP.",
    fitNote: "With “Fit”, each page takes the exact size of its image.",
    previewTitle: "Image order",
    previewHint:
      "Drag the thumbnails or use the arrows to set the order they should appear in.",
    imageAlt: "Image",
  },
};
