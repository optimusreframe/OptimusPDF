import type { Language } from "@/lib/i18n";

/** Copy propio de la herramienta de firma (ES/EN). */
export type SignStrings = {
  createTitle: string;
  createSignature: string;
  changeSignature: string;
  modeDraw: string;
  modeType: string;
  modeUpload: string;
  drawHint: string;
  clear: string;
  typeLabel: string;
  typePlaceholder: string;
  styleLabel: string;
  styleNames: [string, string, string, string];
  uploadPick: string;
  uploadHint: string;
  inkLabel: string;
  strokeLabel: string;
  save: string;
  emptyWarning: string;
  placeTitle: string;
  placeHint: string;
  noSignature: string;
  previousPage: string;
  nextPage: string;
  pageOf: (current: number, total: number) => string;
  loadingPreview: string;
  legalNote: string;
  filenameSuffix: string;
};

const es: SignStrings = {
  createTitle: "Tu firma",
  createSignature: "Crear firma",
  changeSignature: "Rehacer firma",
  modeDraw: "Dibujar",
  modeType: "Escribir",
  modeUpload: "Subir",
  drawHint: "Traza la firma con el dedo o el ratón dentro del recuadro.",
  clear: "Borrar trazo",
  typeLabel: "Nombre",
  typePlaceholder: "Escribe tu nombre",
  styleLabel: "Estilo de letra",
  styleNames: ["Manuscrita", "Caligráfica", "Clásica", "Sobria"],
  uploadPick: "Elegir imagen de la firma",
  uploadHint:
    "Un PNG con fondo transparente da el mejor resultado. También se admite JPG.",
  inkLabel: "Color de la tinta",
  strokeLabel: "Grosor del trazo",
  save: "Usar esta firma",
  emptyWarning: "Todavía no hay nada que guardar.",
  placeTitle: "Coloca la firma",
  placeHint:
    "Arrastra la firma hasta su sitio y usa el tirador de la esquina para cambiar su tamaño.",
  noSignature: "Crea tu firma para poder colocarla sobre el documento.",
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  pageOf: (current, total) => `Página ${current} de ${total}`,
  loadingPreview: "Preparando la vista previa",
  legalNote:
    "Es una firma visual: se dibuja sobre la página. No sustituye a una firma electrónica cualificada con certificado.",
  filenameSuffix: "firmado",
};

const en: SignStrings = {
  createTitle: "Your signature",
  createSignature: "Create signature",
  changeSignature: "Redo signature",
  modeDraw: "Draw",
  modeType: "Type",
  modeUpload: "Upload",
  drawHint: "Trace your signature with a finger or the mouse inside the box.",
  clear: "Clear stroke",
  typeLabel: "Name",
  typePlaceholder: "Type your name",
  styleLabel: "Lettering style",
  styleNames: ["Handwritten", "Calligraphic", "Classic", "Plain"],
  uploadPick: "Choose signature image",
  uploadHint:
    "A PNG with a transparent background gives the best result. JPG also works.",
  inkLabel: "Ink colour",
  strokeLabel: "Stroke weight",
  save: "Use this signature",
  emptyWarning: "There is nothing to save yet.",
  placeTitle: "Place the signature",
  placeHint:
    "Drag the signature where you want it and use the corner handle to resize.",
  noSignature: "Create your signature to place it on the document.",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageOf: (current, total) => `Page ${current} of ${total}`,
  loadingPreview: "Preparing the preview",
  legalNote:
    "This is a visual signature drawn onto the page. It does not replace a qualified electronic signature backed by a certificate.",
  filenameSuffix: "signed",
};

export const SIGN_STRINGS: Record<Language, SignStrings> = { es, en };
