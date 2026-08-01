import type { Language } from "@/lib/i18n";

/**
 * Textos propios de "Excel a PDF". El diccionario global solo cubre lo
 * compartido por todas las herramientas.
 */
export type ExcelToPdfStrings = {
  pageSizeLabel: string;
  pageSizeA4: string;
  pageSizeLetter: string;
  orientationLabel: string;
  orientationPortrait: string;
  orientationLandscape: string;
  sheetLabel: string;
  sheetAll: string;
  sheetFirst: string;
  howItWorksTitle: string;
  howItWorksBody: string;
  progress: string;
  filenameSuffix: string;
};

const es: ExcelToPdfStrings = {
  pageSizeLabel: "Tamaño de página",
  pageSizeA4: "A4",
  pageSizeLetter: "Carta",
  orientationLabel: "Orientación",
  orientationPortrait: "Vertical",
  orientationLandscape: "Horizontal",
  sheetLabel: "Hojas a convertir",
  sheetAll: "Todas",
  sheetFirst: "Solo la primera",
  howItWorksTitle: "Cómo se convierte",
  howItWorksBody:
    "Cada hoja de tu archivo se convierte en su propia tabla dentro del PDF, con texto real y buscable. Las funciones más complejas (fórmulas, de las que solo se conserva el resultado calculado, gráficos, imágenes y el formato de colores de las celdas) no se conservan: solo los datos.",
  progress: "Convirtiendo la hoja de cálculo",
  filenameSuffix: "excel-a-pdf",
};

const en: ExcelToPdfStrings = {
  pageSizeLabel: "Page size",
  pageSizeA4: "A4",
  pageSizeLetter: "Letter",
  orientationLabel: "Orientation",
  orientationPortrait: "Portrait",
  orientationLandscape: "Landscape",
  sheetLabel: "Sheets to convert",
  sheetAll: "All",
  sheetFirst: "First only",
  howItWorksTitle: "How the conversion works",
  howItWorksBody:
    "Each sheet in your file becomes its own table inside the PDF, with real, searchable text. More complex features (formulas, which keep only their computed result, charts, images, and cell color formatting) are not preserved — only the data.",
  progress: "Converting the spreadsheet",
  filenameSuffix: "excel-to-pdf",
};

export const STRINGS: Record<Language, ExcelToPdfStrings> = { es, en };
