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
  rasterWarning: string;

  originalLabel: string;
  largeFile: string;

  summaryTitle: string;
  beforeLabel: string;
  afterLabel: string;
  reductionLabel: string;
  gainHint: string;
  noGainHint: string;

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
    "Sin servidor no hay forma mágica de encoger un PDF: cada página se vuelve a dibujar en tu navegador a la resolución que elijas y se guarda como imagen JPEG dentro de un documento nuevo.",
  rasterWarning:
    "Esto convierte el PDF en imágenes: el texto deja de poder seleccionarse, buscarse o leerse con lectores de pantalla, y se pierden enlaces, formularios y marcadores. Si necesitas conservar el texto, no uses esta herramienta.",

  originalLabel: "Peso actual",
  largeFile:
    "El archivo pasa de 100 MB. Rasterizar tantas páginas puede agotar la memoria de la pestaña.",

  summaryTitle: "Última compresión",
  beforeLabel: "Antes",
  afterLabel: "Después",
  reductionLabel: "Reducción",
  gainHint:
    "Los tamaños son reales, medidos sobre el archivo generado en tu dispositivo.",
  noGainHint:
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
    "With no server there is no magic way to shrink a PDF: every page is redrawn in your browser at the resolution you pick and stored as a JPEG image inside a brand new document.",
  rasterWarning:
    "This turns the PDF into images: text can no longer be selected, searched or read by screen readers, and links, forms and bookmarks are lost. If you need to keep the text, do not use this tool.",

  originalLabel: "Current weight",
  largeFile:
    "The file is over 100 MB. Rasterising that many pages may exhaust the tab's memory.",

  summaryTitle: "Last compression",
  beforeLabel: "Before",
  afterLabel: "After",
  reductionLabel: "Reduction",
  gainHint:
    "These are real sizes, measured on the file generated on your device.",
  noGainHint:
    "This document did not get smaller: that is common with text-only PDFs, where the image version takes more space. Only download it if you want the flattening; otherwise keep the original.",

  filenameSuffix: "compressed",
};

export const COMPRESS_STRINGS: Record<Language, CompressStrings> = { es, en };
