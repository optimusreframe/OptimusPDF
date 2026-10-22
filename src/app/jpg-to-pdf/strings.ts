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
  perPageLabel: string;
  /** Descripcion bajo el selector: `{n}` fotos por hoja y `{rows}` filas. */
  perPageOne: string;
  perPageTwo: string;
  perPageMany: string;
  perPageFit: string;
  perPageZip: string;
  sheetsTitle: string;
  /** «Hoja {n}: fotos {from} a {to}, {cols} × {rows}». */
  sheetCaption: string;
  sheetCaptionOne: string;
  columnOne: string;
  columnMany: string;
  rowOne: string;
  rowMany: string;
  sheetsTotalOne: string;
  /** `{n}` hojas en total. */
  sheetsTotalMany: string;
  /** `{shown}` primeras hojas de `{n}`. */
  sheetsShown: string;
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
    perPageLabel: "Fotos por página",
    perPageOne: "Una foto en cada página.",
    perPageTwo: "Una foto arriba y otra abajo, cada una a todo el ancho de la hoja.",
    perPageMany: "{n} fotos por hoja: 2 columnas × {rows} filas, todas visibles dentro de la hoja. Con «Automática», la hoja va en vertical.",
    perPageFit: "Con varias fotos por hoja, «Ajustar» usa tamaño A4.",
    perPageZip: "Con un PDF por imagen, cada foto va en su propia página.",
    sheetsTitle: "Vista previa de las hojas",
    sheetCaption: "Hoja {n}: fotos {from} a {to}, {cols} × {rows}",
    sheetCaptionOne: "Hoja {n}: foto {from}, {cols} × {rows}",
    columnOne: "1 columna",
    columnMany: "{n} columnas",
    rowOne: "1 fila",
    rowMany: "{n} filas",
    sheetsTotalOne: "1 hoja en total",
    sheetsTotalMany: "{n} hojas en total",
    sheetsShown: "Se muestran las primeras {shown}.",
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
    perPageLabel: "Photos per page",
    perPageOne: "One photo on each page.",
    perPageTwo: "One photo on top and one below, each as wide as the sheet.",
    perPageMany: "{n} photos per sheet: 2 columns × {rows} rows, all visible inside the sheet. With “Automatic”, the sheet is portrait.",
    perPageFit: "With several photos per sheet, “Fit” uses A4 size.",
    perPageZip: "With one PDF per image, each photo goes on its own page.",
    sheetsTitle: "Sheet preview",
    sheetCaption: "Sheet {n}: photos {from} to {to}, {cols} × {rows}",
    sheetCaptionOne: "Sheet {n}: photo {from}, {cols} × {rows}",
    columnOne: "1 column",
    columnMany: "{n} columns",
    rowOne: "1 row",
    rowMany: "{n} rows",
    sheetsTotalOne: "1 sheet in total",
    sheetsTotalMany: "{n} sheets in total",
    sheetsShown: "Showing the first {shown}.",
  },
};
