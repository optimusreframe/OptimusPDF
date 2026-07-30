import type { Language } from "@/lib/i18n";

/** Copy propio de Comprimir PDF (ES/EN). Nada de esto se copia de nadie. */
export type CompressStrings = {
  levelLabel: string;
  extremeName: string;
  extremeHint: string;
  recommendedName: string;
  recommendedHint: string;
  lowName: string;
  lowHint: string;

  howItWorksTitle: string;
  howItWorksBody: string;

  flattenModeLabel: string;
  flattenModeHint: string;
  rasterWarning: string;

  originalLabel: string;
  largeFile: string;

  summaryTitle: string;
  beforeLabel: string;
  afterLabel: string;
  reductionLabel: string;
  gainHint: string;
  /**
   * Modo "recompress" (por defecto) sin ganancia real: ninguna imagen
   * califico, o ninguna mejoraba al recomprimirla. Se devuelve el
   * original sin tocar.
   */
  noGainHint: string;
  /** Sin ganancia en modo "flatten" (aplanado explicito), el antiguo noGainHint. */
  flattenNoGainHint: string;

  filenameSuffix: string;
};

const es: CompressStrings = {
  levelLabel: "Nivel de compresión",
  extremeName: "Compresión extrema",
  extremeHint: "El archivo más ligero posible. La calidad de imagen baja de forma visible.",
  recommendedName: "Compresión recomendada",
  recommendedHint: "El equilibrio que funciona en la mayoría de documentos.",
  lowName: "Baja compresión",
  lowHint: "Se nota poco en pantalla; el ahorro de peso también es menor.",

  howItWorksTitle: "Cómo comprime OptimusPDF",
  howItWorksBody:
    "Tu PDF se abre en tu navegador y se recomprimen en el sitio solo las fotos JPEG que tenga dentro: el texto, los vectores, los enlaces, los formularios y los marcadores se quedan exactamente igual. Si una imagen concreta no mejora al recomprimirla, se deja tal cual. Y si el documento entero no llega a pesar menos, se descarga el original sin cambios: nunca vas a recibir un archivo más pesado que el que subiste.",

  flattenModeLabel: "Aplanar documento escaneado",
  flattenModeHint:
    "Actívalo solo si el PDF es en realidad fotos de páginas escaneadas (no texto real): cada página se vuelve a dibujar como una única imagen JPEG a la resolución que elijas. Esto SÍ hace que el texto deje de poder seleccionarse, buscarse o leerse con lectores de pantalla, y que se pierdan enlaces, formularios y marcadores. Para un PDF con texto de verdad, deja esto desactivado.",
  rasterWarning:
    "Con \"Aplanar documento escaneado\" activado, el PDF se convierte en imágenes: el texto deja de poder seleccionarse, buscarse o leerse con lectores de pantalla, y se pierden enlaces, formularios y marcadores.",

  originalLabel: "Peso actual",
  largeFile:
    "El archivo pasa de 100 MB. Con el aplanado activado, rasterizar tantas páginas puede agotar la memoria de la pestaña.",

  summaryTitle: "Última compresión",
  beforeLabel: "Antes",
  afterLabel: "Después",
  reductionLabel: "Reducción",
  gainHint:
    "Los tamaños son reales, medidos sobre el archivo generado en tu dispositivo.",
  noGainHint:
    "Este documento ya estaba optimizado: no había ninguna imagen que recomprimir, o ninguna habría pesado menos al hacerlo. Te devolvemos exactamente tu archivo original, sin ningún cambio.",
  flattenNoGainHint:
    "En este documento el resultado no pesa menos: suele pasar con PDF de texto puro, donde la versión en imágenes ocupa más. Descárgalo solo si te interesa el aplanado; si no, quédate con el original.",

  filenameSuffix: "comprimido",
};

const en: CompressStrings = {
  levelLabel: "Compression level",
  extremeName: "Extreme compression",
  extremeHint: "The lightest possible file. Image quality drops visibly.",
  recommendedName: "Recommended compression",
  recommendedHint: "The balance that works for most documents.",
  lowName: "Light compression",
  lowHint: "Barely noticeable on screen; the weight saving is smaller too.",

  howItWorksTitle: "How OptimusPDF compresses",
  howItWorksBody:
    "Your PDF opens in your browser and only the JPEG photos it already contains get recompressed in place: text, vector graphics, links, forms and bookmarks stay exactly as they were. If recompressing a specific image would not actually help, that image is left untouched. And if the whole document does not end up smaller, you get the original back unchanged: you will never receive a heavier file than the one you uploaded.",

  flattenModeLabel: "Flatten scanned document",
  flattenModeHint:
    "Only turn this on if the PDF is really photos of scanned pages (not real text): every page is redrawn as a single JPEG image at the resolution you pick. This DOES make text unselectable, unsearchable and unreadable by screen readers, and drops links, forms and bookmarks. For a PDF with real text, leave this off.",
  rasterWarning:
    "With \"Flatten scanned document\" on, the PDF turns into images: text can no longer be selected, searched or read by screen readers, and links, forms and bookmarks are lost.",

  originalLabel: "Current weight",
  largeFile:
    "The file is over 100 MB. With flattening on, rasterising that many pages may exhaust the tab's memory.",

  summaryTitle: "Last compression",
  beforeLabel: "Before",
  afterLabel: "After",
  reductionLabel: "Reduction",
  gainHint:
    "These are real sizes, measured on the file generated on your device.",
  noGainHint:
    "This document was already optimised: there was no image worth recompressing, or none of them would have gotten smaller. You get back exactly your original file, unchanged.",
  flattenNoGainHint:
    "This document did not get smaller: that is common with text-only PDFs, where the image version takes more space. Only download it if you want the flattening; otherwise keep the original.",

  filenameSuffix: "compressed",
};

export const COMPRESS_STRINGS: Record<Language, CompressStrings> = { es, en };
