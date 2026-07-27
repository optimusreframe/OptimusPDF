import type { Language } from "@/lib/i18n";
import type { OcrLanguage } from "@/lib/pdf/ocr";

/** Copy propio de OCR de PDF (ES/EN). */
export type OcrStrings = {
  languageLabel: string;
  languageNames: Record<OcrLanguage, string>;
  languageHint: string;

  howItWorksTitle: string;
  howItWorksBody: string;
  downloadNotice: string;
  slowNotice: string;
  qualityNotice: string;

  largeFile: string;
  filenameSuffix: string;
};

const es: OcrStrings = {
  languageLabel: "Idioma del documento",
  languageNames: {
    spa: "Español",
    eng: "Inglés",
    fra: "Francés",
    por: "Portugués",
  },
  languageHint:
    "Elegir bien el idioma cambia mucho el resultado: el reconocedor usa el diccionario y los acentos de ese idioma.",

  howItWorksTitle: "Qué hace el OCR",
  howItWorksBody:
    "Cada página se convierte en imagen, se reconoce su texto y ese texto se coloca encima como una capa invisible, palabra por palabra y en su sitio. El documento se ve exactamente igual, pero ya puedes buscar y copiar.",
  downloadNotice:
    "La primera vez se descarga el motor de reconocimiento y el modelo del idioma desde una CDN pública (unos megabytes, luego quedan en caché). Es la única petición de red: tu documento no se envía a ninguna parte.",
  slowNotice:
    "El reconocimiento es lento: cuenta con varios segundos por página y no cierres la pestaña mientras avanza la barra.",
  qualityNotice:
    "Funciona con escaneos legibles y rectos. Con letra manuscrita, páginas torcidas o fotos con sombras el resultado es pobre, y preferimos decirlo antes que después.",

  largeFile:
    "El archivo pasa de 100 MB. Reconocer un documento así puede agotar la memoria de la pestaña.",
  filenameSuffix: "con-texto",
};

const en: OcrStrings = {
  languageLabel: "Document language",
  languageNames: {
    spa: "Spanish",
    eng: "English",
    fra: "French",
    por: "Portuguese",
  },
  languageHint:
    "Picking the right language changes the result a lot: the recogniser uses that language's dictionary and accents.",

  howItWorksTitle: "What OCR does here",
  howItWorksBody:
    "Every page is turned into an image, its text is recognised and that text is placed on top as an invisible layer, word by word and in position. The document looks exactly the same, but you can now search and copy.",
  downloadNotice:
    "The first run downloads the recognition engine and the language model from a public CDN (a few megabytes, cached afterwards). That is the only network request: your document is never sent anywhere.",
  slowNotice:
    "Recognition is slow: expect several seconds per page, and keep the tab open while the bar moves.",
  qualityNotice:
    "It works with readable, straight scans. Handwriting, skewed pages or photos with shadows give poor results, and we would rather say so up front.",

  largeFile:
    "The file is over 100 MB. Recognising a document that size may exhaust the tab's memory.",
  filenameSuffix: "with-text",
};

export const OCR_STRINGS: Record<Language, OcrStrings> = { es, en };
