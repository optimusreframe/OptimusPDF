import type { Language } from "@/lib/i18n";
import type { TranslateLanguage } from "@/lib/pdf/translate";

/** Copy propio del informe de traduccion (ES/EN). */
export type TranslateStrings = {
  languageNames: Record<TranslateLanguage, string>;
  sourceLabel: string;
  targetLabel: string;
  sourceHint: string;

  howItWorksTitle: string;
  howItWorksBody: string;
  /** El aviso que separa esta herramienta de "traducir un PDF". */
  notAPdfTitle: string;
  notAPdfBody: string;
  privacyNotice: string;
  slowNotice: string;
  aiNotice: string;

  ocrLabel: string;
  ocrHint: string;

  consentTitle: string;
  /** `{size}` -> MB, `{model}` -> repositorio del modelo. */
  consentBody: string;
  consentCheckbox: string;
  consentHint: string;
  consentPending: string;

  largeFile: string;
  filenameSuffix: string;
};

const es: TranslateStrings = {
  languageNames: { es: "Español", en: "Inglés", fr: "Francés" },
  sourceLabel: "Idioma del documento",
  targetLabel: "Traducir a",
  sourceHint:
    "Elige el idioma en el que está escrito el PDF. Cada dirección usa un modelo distinto, así que acertar aquí es lo que hace que la traducción tenga sentido.",

  howItWorksTitle: "Qué hace esta herramienta",
  howItWorksBody:
    "Extrae el texto del PDF, lo traduce con un modelo que se ejecuta dentro de tu navegador y te devuelve un informe bilingüe en Markdown: página por página, el texto original y debajo su traducción.",
  notAPdfTitle: "No es un PDF traducido",
  notAPdfBody:
    "El resultado es un informe de texto, no tu PDF con la maquetación original y las palabras cambiadas. No se conservan el diseño, las imágenes, las tablas ni el formato. Traducir un PDF conservando la maquetación de forma fiable necesita un servidor y no lo hacemos: preferimos darte algo honesto a fingir que funciona.",
  privacyNotice:
    "El texto de tu documento no sale del navegador: nunca se sube a ningún servidor. La traducción en sí solo genera una petición de red, la descarga del modelo desde Hugging Face, que ocurre después de que la autorices. Si activas el reconocimiento OCR para páginas escaneadas, esa función descarga aparte sus propios archivos de reconocimiento (también sin tu documento).",
  slowNotice:
    "Es lento: cuenta con bastantes segundos por página, más la primera descarga del modelo. No cierres la pestaña mientras avanza la barra.",
  aiNotice:
    "Traducción automática: puede equivocarse, omitir frases o invertir el sentido. No la uses como traducción jurada, legal o médica sin que la revise una persona.",

  ocrLabel: "Reconocer con OCR las páginas escaneadas",
  ocrHint:
    "Si una página no tiene texto seleccionable, se reconoce con OCR antes de traducirla. Añade tiempo y arrastra los errores del reconocimiento a la traducción.",

  consentTitle: "Hace falta descargar un modelo",
  consentBody:
    "Traducir en tu dispositivo requiere descargar el modelo {model}: unos {size} MB la primera vez para esta dirección. Queda en la caché del navegador, así que los siguientes usos no vuelven a descargarlo. Con datos móviles o una conexión lenta, piénsalo antes.",
  consentCheckbox: "Entiendo y autorizo la descarga del modelo",
  consentHint:
    "Es la petición de red de la traducción. Tu documento no viaja en ella (el reconocimiento OCR, si lo activas, descarga sus propios archivos aparte).",
  consentPending:
    "Autoriza la descarga del modelo para poder generar el informe.",

  largeFile:
    "El archivo pasa de 100 MB. Traducir un documento así puede agotar la memoria de la pestaña.",
  filenameSuffix: "informe-traduccion",
};

const en: TranslateStrings = {
  languageNames: { es: "Spanish", en: "English", fr: "French" },
  sourceLabel: "Document language",
  targetLabel: "Translate into",
  sourceHint:
    "Pick the language the PDF is written in. Each direction uses a different model, so getting this right is what makes the translation make sense.",

  howItWorksTitle: "What this tool does",
  howItWorksBody:
    "It extracts the text from the PDF, translates it with a model that runs inside your browser, and gives you back a bilingual Markdown report: page by page, the original text and its translation underneath.",
  notAPdfTitle: "This is not a translated PDF",
  notAPdfBody:
    "The output is a text report, not your PDF with the original layout and the words swapped. Layout, images, tables and formatting are not preserved. Translating a PDF while reliably keeping its layout needs a server, and we do not do that: we would rather give you something honest than pretend it works.",
  privacyNotice:
    "Your document's text never leaves the browser: it is never uploaded anywhere. Translation itself only makes one network request, downloading the model from Hugging Face, after you authorise it. If you enable OCR for scanned pages, that feature separately downloads its own recognition files (also without your document).",
  slowNotice:
    "It is slow: expect a good few seconds per page, plus the first model download. Keep the tab open while the bar moves.",
  aiNotice:
    "Machine translation: it can be wrong, drop sentences or reverse meaning. Do not use it as a sworn, legal or medical translation without human review.",

  ocrLabel: "Recognise scanned pages with OCR",
  ocrHint:
    "If a page has no selectable text, it is recognised with OCR before being translated. This adds time and carries recognition errors into the translation.",

  consentTitle: "A model needs to be downloaded",
  consentBody:
    "Translating on your device requires downloading the {model} model: about {size} MB the first time for this direction. It stays in the browser cache, so later runs do not download it again. On mobile data or a slow connection, think twice.",
  consentCheckbox: "I understand and authorise the model download",
  consentHint:
    "This is the translation's network request. Your document is not part of it (OCR, if you enable it, downloads its own files separately).",
  consentPending: "Authorise the model download to generate the report.",

  largeFile:
    "The file is over 100 MB. Translating a document that size may exhaust the tab's memory.",
  filenameSuffix: "translation-report",
};

export const TRANSLATE_STRINGS: Record<Language, TranslateStrings> = { es, en };
