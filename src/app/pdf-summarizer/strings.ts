import type { Language } from "@/lib/i18n";
import type {
  SummarizerModelKey,
  SummaryLength,
  WebGpuStatus,
} from "@/lib/pdf/summarize";

/**
 * Copy propio de Resumir PDF (ES/EN).
 *
 * Criterio de tono: el mismo del resto de la app. Antes de prometer
 * nada, decir lo que no hace. Aqui eso significa tres avisos que NO son
 * decoracion y no se pueden esconder:
 *   1. hace falta WebGPU y no hay alternativa en la nube,
 *   2. hay que descargar cientos de megabytes de modelo, con permiso,
 *   3. lo escribe una IA pequena y puede equivocarse.
 */
export type SummarizerStrings = {
  /* Comprobacion de capacidades */
  checkingTitle: string;
  checkingBody: string;
  unsupported: Record<Exclude<WebGpuStatus, "checking" | "ready">, string>;
  unsupportedTitle: string;
  unsupportedNoFallback: string;
  whatIsWebGpu: string;

  /* Como funciona */
  howItWorksTitle: string;
  howItWorksBody: string;
  privacyNotice: string;
  slowNotice: string;

  /* Consentimiento de descarga */
  consentTitle: string;
  consentBody: (size: string) => string;
  consentCached: string;
  consentCheckbox: string;
  consentButton: string;
  consentButtonCached: string;
  modelLabel: string;
  modelNames: Record<SummarizerModelKey, string>;
  modelHints: Record<SummarizerModelKey, string>;
  modelMeta: (size: string, vram: string) => string;

  /* Opciones */
  lengthLabel: string;
  lengthNames: Record<SummaryLength, string>;
  ocrLabel: string;
  ocrHint: string;
  outputLanguageLabel: string;
  outputLanguageNames: Record<Language, string>;

  /* Progreso */
  stageExtracting: string;
  stageOcr: string;
  stageLoadingModel: string;
  stageSummarizing: (step: number, total: number) => string;
  stageSynthesizing: string;
  processingHint: string;

  /* Resultado */
  aiWarningTitle: string;
  aiWarningBody: string;
  aiBadge: string;
  resultTitle: string;
  sectionsTitle: string;
  sectionsHint: string;
  modelUsed: (modelId: string) => string;
  truncatedNotice: (page: number, total: number) => string;
  ocrNotice: (pages: string) => string;
  emptyNotice: (count: number) => string;
  partialPageNotice: string;
  copy: string;
  copied: string;
  download: string;
  startOver: string;
  run: string;

  /* Errores propios (no existen como PdfErrorCode compartido) */
  noTextError: string;
  modelError: string;

  /* Documento descargable */
  fileTitle: string;
  fileAiWarning: string;
  fileOverviewTitle: string;
  fileSectionsTitle: string;
  fileModelLine: (modelId: string) => string;
  fileTruncatedLine: (page: number) => string;
  fileOcrLine: (pages: string) => string;
  filenameSuffix: string;
};

const es: SummarizerStrings = {
  checkingTitle: "Comprobando tu navegador",
  checkingBody:
    "Miramos si tu equipo puede ejecutar el modelo aquí mismo. No se descarga nada todavía.",

  unsupportedTitle: "Tu navegador no puede ejecutar esta herramienta",
  unsupported: {
    noApi:
      "Este navegador no tiene WebGPU. Es la tecnología que permite ejecutar el modelo de lenguaje en tu propio equipo. Con Chrome o Edge actualizados en ordenador suele funcionar; en Safari y en Firefox todavía depende de la versión y de los ajustes.",
    noAdapter:
      "Tu navegador tiene WebGPU pero no encuentra ninguna tarjeta gráfica utilizable. Suele pasar en máquinas virtuales, con la aceleración por hardware desactivada o con controladores gráficos antiguos.",
    noF16:
      "Tu tarjeta gráfica no admite «shader-f16», que es lo que hace que el modelo quepa en memoria comprimido a 4 bits. Sin eso el modelo no arranca en este equipo.",
    error:
      "No hemos podido comprobar si tu equipo admite WebGPU. Recarga la página y, si sigue igual, prueba en otro navegador.",
  },
  unsupportedNoFallback:
    "No hay plan B: esta herramienta no envía tu documento a ningún servicio en la nube para resumirlo. Si no se puede hacer en tu equipo, no se hace. Preferimos decirlo antes que mandar tu PDF a otra parte sin avisarte.",
  whatIsWebGpu:
    "WebGPU es el acceso del navegador a la tarjeta gráfica. Sin él no hay forma de ejecutar un modelo de lenguaje a una velocidad razonable dentro de la pestaña.",

  howItWorksTitle: "Cómo funciona",
  howItWorksBody:
    "Se extrae el texto del PDF, se parte en trozos que quepan en la memoria del modelo, se resume cada trozo y al final se combinan todos en un único resumen. Cada resumen parcial lleva las páginas de las que sale.",
  privacyNotice:
    "El modelo se ejecuta dentro de tu navegador. El PDF y su texto no salen de tu equipo: nunca se suben a ningún servidor. Resumir en sí solo genera una petición de red, la descarga del modelo. Si activas el reconocimiento OCR para páginas escaneadas, esa función descarga aparte sus propios archivos de reconocimiento (también sin tu documento).",
  slowNotice:
    "Es lento: la descarga del modelo tarda varios minutos la primera vez y cada trozo del documento cuesta decenas de segundos. No cierres la pestaña mientras avanza.",

  consentTitle: "Hay que descargar el modelo",
  consentBody: (size) =>
    `Para resumir sin enviar nada a ningún servidor hay que descargar el modelo completo a tu navegador: unos ${size}. Se queda en la caché del navegador, así que solo se descarga la primera vez. Con datos móviles piénsalo dos veces.`,
  consentCached:
    "Este modelo ya está descargado en tu navegador: no hará falta volver a bajarlo.",
  consentCheckbox: "Entiendo que se descargará el modelo y que el resumen lo escribe una IA que puede equivocarse",
  consentButton: "Descargar el modelo y resumir",
  consentButtonCached: "Resumir con el modelo ya descargado",

  modelLabel: "Modelo",
  modelNames: {
    "llama-3.2-1b": "Ligero",
    "qwen2.5-1.5b": "Mejor calidad",
  },
  modelHints: {
    "llama-3.2-1b":
      "Llama 3.2 1B Instruct, comprimido a 4 bits. Es el más pequeño que resume de forma aceptable y el único viable en equipos justos de memoria.",
    "qwen2.5-1.5b":
      "Qwen2.5 1.5B Instruct, comprimido a 4 bits. Resume mejor y se inventa menos, a cambio de más descarga y casi el doble de memoria de vídeo.",
  },
  modelMeta: (size, vram) => `${size} de descarga · ~${vram} de memoria de vídeo`,

  lengthLabel: "Longitud del resumen",
  lengthNames: { short: "Breve", medium: "Normal" },
  ocrLabel: "Reconocer texto de páginas escaneadas (OCR)",
  ocrHint:
    "Si una página no tiene capa de texto se convierte en imagen y se reconoce con OCR. Añade bastante tiempo y el texto reconocido es menos fiable, así que el resumen de esas páginas también lo es.",
  outputLanguageLabel: "Idioma del resumen",
  outputLanguageNames: { es: "Español", en: "Inglés" },

  stageExtracting: "Extrayendo el texto del documento",
  stageOcr: "Reconociendo texto de páginas escaneadas",
  stageLoadingModel: "Descargando y cargando el modelo",
  stageSummarizing: (step, total) => `Resumiendo trozo ${step} de ${total}`,
  stageSynthesizing: "Combinando los resúmenes parciales",
  processingHint:
    "Todo ocurre en tu dispositivo. No cierres esta pestaña ni la dejes en segundo plano mucho rato.",

  aiWarningTitle: "Esto lo ha escrito una IA",
  aiWarningBody:
    "El resumen lo ha generado un modelo de lenguaje pequeño ejecutándose en tu navegador. Puede omitir cosas importantes, malinterpretar tablas y cifras, o afirmar cosas que el documento no dice. No lo uses como sustituto de leer el original cuando la decisión importe: contrasta siempre con las páginas citadas.",
  aiBadge: "Generado por IA",
  resultTitle: "Resumen general",
  sectionsTitle: "Resúmenes por tramo",
  sectionsHint:
    "Cada tramo indica de qué páginas sale. Úsalas para ir al original y comprobarlo.",
  modelUsed: (modelId) => `Modelo: ${modelId}`,
  truncatedNotice: (page, total) =>
    `El documento es largo: solo se ha resumido hasta la página ${page} de ${total}. El resto no está cubierto por este resumen.`,
  ocrNotice: (pages) =>
    `Texto obtenido por OCR en estas páginas: ${pages}. El reconocimiento comete errores y el resumen los hereda.`,
  emptyNotice: (count) =>
    `${count} página(s) no tenían texto legible y se han quedado fuera del resumen.`,
  partialPageNotice: "fragmento",
  copy: "Copiar resumen",
  copied: "Copiado",
  download: "Descargar como .txt",
  startOver: "Empezar de nuevo",
  run: "Resumir",

  noTextError:
    "No se ha podido extraer texto de este PDF. Si es un escaneo, activa el OCR y vuelve a intentarlo.",
  modelError:
    "El modelo no ha podido completar el resumen. Suele ser falta de memoria de vídeo: prueba con el modelo ligero, cierra otras pestañas y vuelve a intentarlo.",

  fileTitle: "Resumen del documento",
  fileAiWarning:
    "AVISO: este resumen lo ha generado una IA ejecutada en el navegador. Puede contener errores u omisiones. Contrasta con el documento original.",
  fileOverviewTitle: "RESUMEN GENERAL",
  fileSectionsTitle: "RESUMENES POR TRAMO",
  fileModelLine: (modelId) => `Modelo: ${modelId}`,
  fileTruncatedLine: (page) =>
    `Cobertura parcial: solo hasta la pagina ${page}.`,
  fileOcrLine: (pages) => `Paginas obtenidas por OCR: ${pages}.`,
  filenameSuffix: "resumen",
};

const en: SummarizerStrings = {
  checkingTitle: "Checking your browser",
  checkingBody:
    "We are checking whether your machine can run the model right here. Nothing is downloaded yet.",

  unsupportedTitle: "Your browser cannot run this tool",
  unsupported: {
    noApi:
      "This browser has no WebGPU. That is the technology that lets the language model run on your own machine. Up-to-date Chrome or Edge on a desktop usually works; on Safari and Firefox it still depends on the version and the settings.",
    noAdapter:
      "Your browser has WebGPU but cannot find a usable graphics card. This normally happens on virtual machines, with hardware acceleration switched off, or with old graphics drivers.",
    noF16:
      "Your graphics card does not support «shader-f16», which is what makes the 4-bit compressed model fit in memory. Without it the model will not start on this machine.",
    error:
      "We could not check whether your machine supports WebGPU. Reload the page and, if it persists, try another browser.",
  },
  unsupportedNoFallback:
    "There is no plan B: this tool does not send your document to any cloud service to summarise it. If it cannot run on your machine, it does not run. We would rather say so than ship your PDF somewhere else without telling you.",
  whatIsWebGpu:
    "WebGPU is the browser's access to the graphics card. Without it there is no way to run a language model at a reasonable speed inside the tab.",

  howItWorksTitle: "How it works",
  howItWorksBody:
    "The text is extracted from the PDF, split into chunks that fit the model's memory, each chunk is summarised, and finally all of them are combined into a single summary. Every partial summary carries the pages it came from.",
  privacyNotice:
    "The model runs inside your browser. The PDF and its text never leave your machine: they are never uploaded anywhere. Summarizing itself only makes one network request, the model download. If you enable OCR for scanned pages, that feature separately downloads its own recognition files (also without your document).",
  slowNotice:
    "It is slow: the model download takes several minutes the first time and each chunk costs tens of seconds. Keep the tab open while it runs.",

  consentTitle: "The model has to be downloaded",
  consentBody: (size) =>
    `To summarise without sending anything to a server, the whole model has to be downloaded into your browser: about ${size}. It stays in the browser cache, so it is only downloaded the first time. On mobile data, think twice.`,
  consentCached:
    "This model is already downloaded in your browser: no new download is needed.",
  consentCheckbox:
    "I understand the model will be downloaded and that the summary is written by an AI that can be wrong",
  consentButton: "Download the model and summarise",
  consentButtonCached: "Summarise with the downloaded model",

  modelLabel: "Model",
  modelNames: {
    "llama-3.2-1b": "Light",
    "qwen2.5-1.5b": "Better quality",
  },
  modelHints: {
    "llama-3.2-1b":
      "Llama 3.2 1B Instruct, compressed to 4 bits. The smallest one that summarises acceptably, and the only viable option on tight-memory machines.",
    "qwen2.5-1.5b":
      "Qwen2.5 1.5B Instruct, compressed to 4 bits. Summarises better and invents less, in exchange for a bigger download and nearly twice the video memory.",
  },
  modelMeta: (size, vram) => `${size} download · ~${vram} of video memory`,

  lengthLabel: "Summary length",
  lengthNames: { short: "Brief", medium: "Normal" },
  ocrLabel: "Recognise text on scanned pages (OCR)",
  ocrHint:
    "If a page has no text layer it is turned into an image and read with OCR. It adds a lot of time and the recognised text is less reliable, so the summary of those pages is less reliable too.",
  outputLanguageLabel: "Summary language",
  outputLanguageNames: { es: "Spanish", en: "English" },

  stageExtracting: "Extracting the document text",
  stageOcr: "Recognising text on scanned pages",
  stageLoadingModel: "Downloading and loading the model",
  stageSummarizing: (step, total) => `Summarising chunk ${step} of ${total}`,
  stageSynthesizing: "Combining the partial summaries",
  processingHint:
    "Everything happens on your device. Keep this tab open and in the foreground.",

  aiWarningTitle: "This was written by an AI",
  aiWarningBody:
    "The summary was generated by a small language model running in your browser. It can miss important things, misread tables and figures, or state things the document does not say. Do not use it instead of reading the original when the decision matters: always check against the cited pages.",
  aiBadge: "AI generated",
  resultTitle: "Overall summary",
  sectionsTitle: "Summaries by section",
  sectionsHint:
    "Each section shows the pages it came from. Use them to go back to the original and check.",
  modelUsed: (modelId) => `Model: ${modelId}`,
  truncatedNotice: (page, total) =>
    `The document is long: only up to page ${page} of ${total} was summarised. The rest is not covered by this summary.`,
  ocrNotice: (pages) =>
    `Text obtained through OCR on these pages: ${pages}. Recognition makes mistakes and the summary inherits them.`,
  emptyNotice: (count) =>
    `${count} page(s) had no readable text and were left out of the summary.`,
  partialPageNotice: "excerpt",
  copy: "Copy summary",
  copied: "Copied",
  download: "Download as .txt",
  startOver: "Start over",
  run: "Summarise",

  noTextError:
    "No text could be extracted from this PDF. If it is a scan, turn OCR on and try again.",
  modelError:
    "The model could not finish the summary. It is usually a lack of video memory: try the light model, close other tabs and try again.",

  fileTitle: "Document summary",
  fileAiWarning:
    "WARNING: this summary was generated by an AI running in the browser. It may contain errors or omissions. Check it against the original document.",
  fileOverviewTitle: "OVERALL SUMMARY",
  fileSectionsTitle: "SUMMARIES BY SECTION",
  fileModelLine: (modelId) => `Model: ${modelId}`,
  fileTruncatedLine: (page) => `Partial coverage: only up to page ${page}.`,
  fileOcrLine: (pages) => `Pages obtained through OCR: ${pages}.`,
  filenameSuffix: "summary",
};

export const SUMMARIZER_STRINGS: Record<Language, SummarizerStrings> = {
  es,
  en,
};
