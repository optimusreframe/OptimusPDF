import type { Language } from "@/lib/i18n";

/** Copy propio de la herramienta de recorte (ES/EN). */
export type CropStrings = {
  selectionTitle: string;
  selectionHint: string;
  reset: string;
  previousPage: string;
  nextPage: string;
  pageOf: (current: number, total: number) => string;
  scopeLabel: string;
  scopeAll: string;
  scopeCurrent: string;
  scopeHint: string;
  sizeLabel: string;
  loadingPreview: string;
  filenameSuffix: string;
};

const es: CropStrings = {
  selectionTitle: "Área que se conserva",
  selectionHint:
    "Arrastra dentro del rectángulo para moverlo y usa los tiradores de las esquinas para ajustarlo. Lo que quede fuera dejará de mostrarse.",
  reset: "Restablecer selección",
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  pageOf: (current, total) => `Página ${current} de ${total}`,
  scopeLabel: "Aplicar el recorte a",
  scopeAll: "Todas las páginas",
  scopeCurrent: "Solo la página visible",
  scopeHint:
    "El recorte es proporcional: si las páginas tienen tamaños distintos, cada una se recorta en la misma proporción.",
  sizeLabel: "Selección",
  loadingPreview: "Preparando la vista previa",
  filenameSuffix: "recortado",
};

const en: CropStrings = {
  selectionTitle: "Area to keep",
  selectionHint:
    "Drag inside the rectangle to move it and use the corner handles to resize. Anything outside stops being shown.",
  reset: "Reset selection",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageOf: (current, total) => `Page ${current} of ${total}`,
  scopeLabel: "Apply the crop to",
  scopeAll: "Every page",
  scopeCurrent: "Only the visible page",
  scopeHint:
    "The crop is proportional: if pages have different sizes, each one is cropped by the same ratio.",
  sizeLabel: "Selection",
  loadingPreview: "Preparing the preview",
  filenameSuffix: "cropped",
};

export const CROP_STRINGS: Record<Language, CropStrings> = { es, en };
