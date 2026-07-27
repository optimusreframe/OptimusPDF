import type { Language } from "@/lib/i18n";

/**
 * Copy propio de la herramienta de marca de agua. Original ES/EN: no se
 * reutiliza texto de ningun producto de terceros.
 */
export type WatermarkStrings = {
  kindLabel: string;
  kindText: string;
  kindImage: string;
  textLabel: string;
  textPlaceholder: string;
  textRequired: string;
  imageRequired: string;
  fontLabel: string;
  fontHelvetica: string;
  fontTimes: string;
  fontCourier: string;
  sizeLabel: string;
  styleLabel: string;
  bold: string;
  italic: string;
  colorLabel: string;
  imageLabel: string;
  imagePick: string;
  imageReplace: string;
  imageHint: string;
  imageSizeLabel: string;
  positionLabel: string;
  positionHint: string;
  tileLabel: string;
  tileHint: string;
  opacityLabel: string;
  opacityFull: string;
  rotationLabel: string;
  pagesLabel: string;
  pagesFrom: string;
  pagesTo: string;
  pagesHint: string;
  layerLabel: string;
  layerOver: string;
  layerUnder: string;
  layerHint: string;
  anchorLabels: Record<string, string>;
  filenameSuffix: string;
};

const es: WatermarkStrings = {
  kindLabel: "Tipo de marca",
  kindText: "Texto",
  kindImage: "Imagen",
  textLabel: "Texto de la marca",
  textPlaceholder: "CONFIDENCIAL",
  textRequired: "Escribe el texto que quieres estampar.",
  imageRequired: "Elige la imagen que se usará como marca.",
  fontLabel: "Tipografía",
  fontHelvetica: "Sans",
  fontTimes: "Serif",
  fontCourier: "Mono",
  sizeLabel: "Tamaño",
  styleLabel: "Estilo",
  bold: "Negrita",
  italic: "Cursiva",
  colorLabel: "Color de la tinta",
  imageLabel: "Imagen de la marca",
  imagePick: "Elegir imagen",
  imageReplace: "Cambiar imagen",
  imageHint: "Formatos admitidos: PNG y JPG.",
  imageSizeLabel: "Ancho sobre la página",
  positionLabel: "Posición",
  positionHint: "Elige dónde se ancla la marca en cada página.",
  tileLabel: "Mosaico",
  tileHint: "Repite la marca por toda la página e ignora la posición.",
  opacityLabel: "Transparencia",
  opacityFull: "Sin transparencia",
  rotationLabel: "Rotación",
  pagesLabel: "Páginas",
  pagesFrom: "Desde",
  pagesTo: "Hasta",
  pagesHint: "Deja «Hasta» en 0 para llegar al final del documento.",
  layerLabel: "Capa",
  layerOver: "Sobre el contenido",
  layerUnder: "Debajo del contenido",
  layerHint:
    "Debajo deja el texto del documento legible; sobre el contenido garantiza que la marca se vea siempre.",
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
  filenameSuffix: "con-marca",
};

const en: WatermarkStrings = {
  kindLabel: "Mark type",
  kindText: "Text",
  kindImage: "Image",
  textLabel: "Watermark text",
  textPlaceholder: "CONFIDENTIAL",
  textRequired: "Type the text you want stamped on the pages.",
  imageRequired: "Choose the image to use as the mark.",
  fontLabel: "Typeface",
  fontHelvetica: "Sans",
  fontTimes: "Serif",
  fontCourier: "Mono",
  sizeLabel: "Size",
  styleLabel: "Style",
  bold: "Bold",
  italic: "Italic",
  colorLabel: "Ink colour",
  imageLabel: "Watermark image",
  imagePick: "Choose image",
  imageReplace: "Change image",
  imageHint: "Supported formats: PNG and JPG.",
  imageSizeLabel: "Width across the page",
  positionLabel: "Position",
  positionHint: "Pick where the mark is anchored on every page.",
  tileLabel: "Tiled",
  tileHint: "Repeats the mark across the whole page and ignores position.",
  opacityLabel: "Transparency",
  opacityFull: "No transparency",
  rotationLabel: "Rotation",
  pagesLabel: "Pages",
  pagesFrom: "From",
  pagesTo: "To",
  pagesHint: "Leave “To” at 0 to run to the end of the document.",
  layerLabel: "Layer",
  layerOver: "Above the content",
  layerUnder: "Below the content",
  layerHint:
    "Below keeps the document text readable; above makes sure the mark is always visible.",
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
  filenameSuffix: "watermarked",
};

export const WATERMARK_STRINGS: Record<Language, WatermarkStrings> = { es, en };
