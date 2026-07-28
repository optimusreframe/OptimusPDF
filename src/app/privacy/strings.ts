import type { Language } from "@/lib/i18n";

export type PrivacySection = {
  title: string;
  body: string[];
};

export type PrivacyStrings = {
  title: string;
  subtitle: string;
  effectiveDate: string;
  sections: PrivacySection[];
  contactTitle: string;
  contactBody: string;
};

/**
 * Copy propio de /privacy, en el mismo estilo directo del resto de la
 * app: nombrar exactamente que peticiones de red existen y a quien van,
 * en vez de la formula generica "usamos servicios de terceros".
 */
export const STRINGS: Record<Language, PrivacyStrings> = {
  es: {
    title: "Política de privacidad",
    subtitle:
      "OptimusPDF procesa tus documentos dentro de tu navegador. Esta página explica, sin rodeos, qué sale de tu equipo y qué no.",
    effectiveDate: "Vigente desde el 28 de julio de 2026.",
    sections: [
      {
        title: "Lo que nunca sale de tu navegador",
        body: [
          "Los PDF, imágenes, texto extraído, resultados y contraseñas que uses en cualquier herramienta de OptimusPDF se procesan localmente, dentro de la pestaña de tu navegador. No se suben a ningún servidor de OptimusPDF: no tenemos backend que reciba tus documentos, y no podríamos verlos aunque quisiéramos.",
        ],
      },
      {
        title: "Las únicas peticiones de red que existen",
        body: [
          "Un puñado de herramientas usan modelos de inteligencia artificial que se ejecutan en tu propio navegador (nada se envía a una nube de IA). Para poder ejecutarlos, la primera vez que los usas hace falta descargar sus archivos desde el sitio público donde los publica cada proyecto. Esa descarga es la única petición de red que generan estas herramientas, y tu documento nunca forma parte de ella.",
          "«Resumen con IA» (pdf-summarizer): descarga los pesos del modelo desde Hugging Face (huggingface.co y sus dominios de almacenamiento) y el motor de ejecución WebAssembly desde GitHub (repositorio mlc-ai/binary-mlc-llm-libs).",
          "«Informe de traducción» (translate-pdf): descarga el modelo de traducción correspondiente (familia OPUS-MT de Helsinki-NLP, publicada por Xenova) desde Hugging Face.",
          "Reconocimiento de texto / OCR (herramienta «OCR de PDF» y el respaldo opcional de OCR en «Informe de traducción»): descarga el motor de reconocimiento y los datos del idioma elegido desde jsDelivr, una CDN pública de paquetes de código abierto.",
          "Antes de cualquiera de estas descargas te pedimos autorización explícita, indicando el tamaño aproximado. Si no autorizas la descarga, no se produce ninguna petición de red y la herramienta no funciona.",
        ],
      },
      {
        title: "Qué reciben esos terceros",
        body: [
          "Al descargar esos archivos, Hugging Face, GitHub y jsDelivr reciben lo habitual en cualquier petición HTTP: tu dirección IP, la fecha y hora, el user agent de tu navegador y la URL exacta solicitada (el nombre del modelo o archivo). Ninguna de esas peticiones lleva tu documento, el texto que extrajimos de él, ni el resultado que generaste: técnicamente no pueden, porque esas descargas ocurren antes de que tu documento entre en juego, o en una petición completamente separada.",
          "Hugging Face, GitHub y jsDelivr son servicios de terceros que operan bajo sus propias políticas de privacidad, independientes de esta: puedes consultarlas en huggingface.co/privacy, la declaración de privacidad de GitHub y la política de privacidad de jsDelivr.",
        ],
      },
      {
        title: "Dónde quedan los modelos y cómo borrarlos",
        body: [
          "Los modelos descargados (que pueden pesar varios cientos de megabytes) se guardan en el almacenamiento local de tu navegador para esta página (Cache Storage o IndexedDB, según la herramienta), de modo que no haga falta volver a descargarlos cada vez que los uses.",
          "Para eliminarlos, borra los datos del sitio de OptimusPDF desde la configuración de tu navegador (en Chrome: Configuración → Privacidad y seguridad → Configuración de sitios → busca este sitio → Borrar datos). Esto no afecta a tus documentos, que nunca estuvieron en ningún servidor nuestro.",
        ],
      },
      {
        title: "Los resultados de IA pueden equivocarse",
        body: [
          "Los resúmenes, traducciones y el texto reconocido por OCR los genera un modelo automático que puede cometer errores, inventar datos o pasar por alto matices. No sustituyen una revisión humana del documento original, especialmente para decisiones legales, médicas, financieras o de cualquier otro tipo con consecuencias reales.",
        ],
      },
    ],
    contactTitle: "Cambios y contacto",
    contactBody:
      "Si cambiamos qué se descarga o de dónde, actualizaremos esta página y la fecha de vigencia de arriba. Para preguntas sobre esta política, contacta con el proyecto a través de la página del proyecto.",
  },
  en: {
    title: "Privacy policy",
    subtitle:
      "OptimusPDF processes your documents inside your browser. This page explains, plainly, what leaves your device and what does not.",
    effectiveDate: "Effective from 28 July 2026.",
    sections: [
      {
        title: "What never leaves your browser",
        body: [
          "The PDFs, images, extracted text, results and passwords you use in any OptimusPDF tool are processed locally, inside your browser tab. They are never uploaded to any OptimusPDF server: we do not have a backend that receives your documents, and we could not see them even if we wanted to.",
        ],
      },
      {
        title: "The only network requests that exist",
        body: [
          "A handful of tools use AI models that run inside your own browser (nothing is sent to an AI cloud). To run them, the first time you use them their files need to be downloaded from the public site where each project publishes them. That download is the only network request these tools make, and your document is never part of it.",
          "\"Summarise with AI\" (pdf-summarizer): downloads the model weights from Hugging Face (huggingface.co and its storage domains) and the WebAssembly runtime engine from GitHub (the mlc-ai/binary-mlc-llm-libs repository).",
          "\"Translation report\" (translate-pdf): downloads the relevant translation model (the Helsinki-NLP OPUS-MT family, published by Xenova) from Hugging Face.",
          "Text recognition / OCR (the \"OCR PDF\" tool, and the optional OCR fallback inside \"Translation report\"): downloads the recognition engine and the chosen language's data from jsDelivr, a public open-source package CDN.",
          "Before any of these downloads we ask for your explicit authorisation, showing the approximate size. If you do not authorise the download, no network request is made and the tool does not work.",
        ],
      },
      {
        title: "What those third parties receive",
        body: [
          "When downloading those files, Hugging Face, GitHub and jsDelivr receive what any HTTP request normally carries: your IP address, the date and time, your browser's user agent, and the exact URL requested (the model or file name). None of these requests carries your document, the text extracted from it, or the result you generated: technically they can't, because these downloads happen before your document comes into play, or in a fully separate request.",
          "Hugging Face, GitHub and jsDelivr are third-party services operating under their own privacy policies, independent of this one: see huggingface.co/privacy, GitHub's privacy statement and jsDelivr's privacy policy.",
        ],
      },
      {
        title: "Where models are stored and how to delete them",
        body: [
          "Downloaded models (which can be several hundred megabytes) are stored in your browser's local storage for this site (Cache Storage or IndexedDB, depending on the tool), so you do not need to download them again every time you use them.",
          "To delete them, clear this site's data from your browser settings (in Chrome: Settings → Privacy and security → Site settings → find this site → Clear data). This does not affect your documents, which were never on any server of ours.",
        ],
      },
      {
        title: "AI results can be wrong",
        body: [
          "Summaries, translations and OCR-recognised text are produced by an automated model that can make mistakes, invent details, or miss nuance. They do not replace a human review of the original document, especially for legal, medical, financial, or otherwise consequential decisions.",
        ],
      },
    ],
    contactTitle: "Changes and contact",
    contactBody:
      "If what gets downloaded, or from where, ever changes, we will update this page and the effective date above. For questions about this policy, reach the project through the project page.",
  },
};
