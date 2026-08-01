import type { Language } from "@/lib/i18n";

/** Textos propios de "PDF a PowerPoint". Copy original ES/EN. */
export type PdfToPowerpointStrings = {
  qualityLabel: string;
  qualityHint: string;
  scaleLabel: string;
  scale1x: string;
  scale2x: string;
  scale3x: string;
  scaleHint: string;
  /** Titulo del aviso de "no son diapositivas editables". */
  notEditableTitle: string;
  /** Cuerpo del aviso: debe quedar explicito, no minimizado. */
  notEditableBody: string;
  progress: string;
  /** Sufijo para el archivo final descargado, sobre el nombre original. */
  filenameSuffix: string;
};

export const STRINGS: Record<Language, PdfToPowerpointStrings> = {
  es: {
    qualityLabel: "Calidad de imagen",
    qualityHint: "Más calidad significa un archivo más pesado.",
    scaleLabel: "Resolución",
    scale1x: "1x",
    scale2x: "2x",
    scale3x: "3x",
    scaleHint: "1x equivale a 72 puntos por pulgada; 3x, a 216.",
    notEditableTitle: "Esto NO genera diapositivas editables",
    notEditableBody:
      "Cada página del PDF se convierte en una imagen y esa imagen ocupa una diapositiva completa. No vas a poder seleccionar ni editar el texto dentro de PowerPoint: si necesitas contenido editable, esta herramienta no es la indicada.",
    progress: "Convirtiendo páginas a diapositivas…",
    filenameSuffix: "presentacion",
  },
  en: {
    qualityLabel: "Image quality",
    qualityHint: "Higher quality means a heavier file.",
    scaleLabel: "Resolution",
    scale1x: "1x",
    scale2x: "2x",
    scale3x: "3x",
    scaleHint: "1x equals 72 dots per inch; 3x equals 216.",
    notEditableTitle: "This does NOT produce editable slides",
    notEditableBody:
      "Every PDF page becomes an image, and that image fills an entire slide. You won't be able to select or edit the text inside PowerPoint: if you need editable content, this tool is not the right one.",
    progress: "Converting pages to slides…",
    filenameSuffix: "presentation",
  },
};
