import type { Language } from "@/lib/i18n";

/**
 * Textos propios de "Word a PDF". El diccionario global solo cubre lo
 * compartido por todas las herramientas.
 */
export type WordToPdfStrings = {
  pageSizeLabel: string;
  pageSizeA4: string;
  pageSizeLetter: string;
  orientationLabel: string;
  orientationPortrait: string;
  orientationLandscape: string;
  marginLabel: string;
  marginNone: string;
  marginSmall: string;
  marginLarge: string;
  howItWorksTitle: string;
  howItWorksBody: string;
  progress: string;
  filenameSuffix: string;
};

const es: WordToPdfStrings = {
  pageSizeLabel: "Tamaño de página",
  pageSizeA4: "A4",
  pageSizeLetter: "Carta",
  orientationLabel: "Orientación",
  orientationPortrait: "Vertical",
  orientationLandscape: "Horizontal",
  marginLabel: "Margen",
  marginNone: "Sin margen",
  marginSmall: "Pequeño",
  marginLarge: "Grande",
  howItWorksTitle: "Cómo se convierte",
  howItWorksBody:
    "Tu documento se convierte primero a HTML y luego se dibuja como PDF con texto nativo: el resultado se puede seleccionar y buscar, y las imágenes y la mayoría del formato se conservan. Los diseños complejos (secciones a varias columnas, encabezados y pies de página, o elementos incrustados como gráficos) pueden no reproducirse exactamente igual.",
  progress: "Convirtiendo el documento",
  filenameSuffix: "word-a-pdf",
};

const en: WordToPdfStrings = {
  pageSizeLabel: "Page size",
  pageSizeA4: "A4",
  pageSizeLetter: "Letter",
  orientationLabel: "Orientation",
  orientationPortrait: "Portrait",
  orientationLandscape: "Landscape",
  marginLabel: "Margin",
  marginNone: "No margin",
  marginSmall: "Small",
  marginLarge: "Large",
  howItWorksTitle: "How the conversion works",
  howItWorksBody:
    "Your document is first converted to HTML and then drawn as a PDF with native text: the result can be selected and searched, and images and most formatting are preserved. Complex layouts (multi-column sections, headers and footers, or embedded objects like charts) may not carry over exactly.",
  progress: "Converting the document",
  filenameSuffix: "word-to-pdf",
};

export const STRINGS: Record<Language, WordToPdfStrings> = { es, en };
