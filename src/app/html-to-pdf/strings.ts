import type { Language } from "@/lib/i18n";

/**
 * Textos propios de "HTML a PDF". El diccionario global solo cubre lo
 * compartido por todas las herramientas.
 */
export type HtmlToPdfStrings = {
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
  fidelityWarning: string;
  securityTitle: string;
  securityBody: string;
  optionsNote: string;
  progress: string;
  filenameSuffix: string;
};

const es: HtmlToPdfStrings = {
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
    "Tu archivo se abre en un marco aislado dentro del navegador, se fotografía tal y como se ve y esa imagen se reparte en páginas del PDF.",
  fidelityWarning:
    "Es una instantánea visual, no un documento estructurado: el texto del PDF no se podrá seleccionar ni buscar, y los diseños CSS complejos, las tipografías externas y todo lo que dependa de JavaScript pueden no reproducirse igual que en un navegador. Las imágenes y hojas de estilo alojadas en otros servidores puede que no carguen y simplemente no aparecerán.",
  securityTitle: "Tu HTML no se ejecuta",
  securityBody:
    "El archivo se limpia antes de abrirlo y se muestra en un marco sin permisos de JavaScript: ni los scripts ni los manejadores que traiga llegan a ejecutarse. Nada sale de tu dispositivo.",
  optionsNote:
    "El ancho de la página marca el ancho con el que se maqueta el HTML: con márgenes grandes el contenido se compone más estrecho.",
  progress: "Convirtiendo el HTML",
  filenameSuffix: "html-a-pdf",
};

const en: HtmlToPdfStrings = {
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
    "Your file is opened in an isolated frame inside the browser, photographed exactly as it looks, and that image is split across the PDF pages.",
  fidelityWarning:
    "This is a visual snapshot, not a structured document: the PDF text will not be selectable or searchable, and complex CSS layouts, external fonts and anything that depends on JavaScript may not render exactly as in a browser. Images and stylesheets hosted on other servers may fail to load and simply will not appear.",
  securityTitle: "Your HTML never runs",
  securityBody:
    "The file is cleaned before it is opened and shown in a frame with no JavaScript permissions: neither its scripts nor its inline handlers ever execute. Nothing leaves your device.",
  optionsNote:
    "The page width sets the width the HTML is laid out with: larger margins compose the content in a narrower column.",
  progress: "Converting the HTML",
  filenameSuffix: "html-to-pdf",
};

export const STRINGS: Record<Language, HtmlToPdfStrings> = { es, en };
