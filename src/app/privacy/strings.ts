import type { Language } from "@/lib/i18n";

export type PrivacySection = {
  /** Id estable para anclar contenido extra (enlaces) a una seccion concreta. */
  key?: "thirdParties";
  title: string;
  body: string[];
};

export type PrivacyLink = {
  label: string;
  href: string;
};

export type PrivacyStrings = {
  title: string;
  subtitle: string;
  effectiveDate: string;
  sections: PrivacySection[];
  /** Enlaces reales a las politicas de los terceros nombrados arriba. */
  thirdPartyLinks: PrivacyLink[];
  contactTitle: string;
  contactBody: string;
  contactLinkLabel: string;
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
        title: "Peticiones externas realizadas por las herramientas",
        body: [
          "Como con cualquier sitio web, el proveedor de alojamiento donde vive esta página recibe las peticiones técnicas normales de tu navegador (IP, hora, user agent, URL solicitada) y puede conservar registros de acceso; no procesa tus documentos porque estos nunca los tocan, ya que todo ocurre dentro de tu navegador. Aparte de eso, un puñado de herramientas usan modelos de inteligencia artificial que se ejecutan en tu propio navegador (nada se envía a una nube de IA). Para poder ejecutarlos, la primera vez que los usas hace falta descargar sus archivos desde el sitio público donde los publica cada proyecto. Tu documento nunca forma parte de esas descargas.",
          "«Resumen con IA» (pdf-summarizer): descarga los pesos del modelo desde Hugging Face (huggingface.co y sus dominios de almacenamiento) y el motor de ejecución WebAssembly desde GitHub (repositorio mlc-ai/binary-mlc-llm-libs).",
          "«Informe de traducción» (translate-pdf): descarga el modelo de traducción correspondiente (familia OPUS-MT de Helsinki-NLP, publicada por Xenova) desde Hugging Face.",
          "Reconocimiento de texto / OCR (herramienta «OCR de PDF» y el respaldo opcional de OCR en «Informe de traducción» y en «Resumen con IA»): descarga el motor de reconocimiento y los datos del idioma elegido desde jsDelivr, una CDN pública de paquetes de código abierto.",
          "Antes de ejecutar estas herramientas te avisamos de que hace falta descargar algo. Para los modelos más pesados (resumen y traducción, cientos de MB) pedimos además tu autorización explícita marcando una casilla, mostrando el tamaño aproximado antes de descargar nada; sin marcarla, no se produce ninguna petición y la herramienta no funciona. El motor de OCR, más ligero, se descarga en cuanto pulsas «Procesar», sin una casilla de confirmación aparte.",
        ],
      },
      {
        key: "thirdParties",
        title: "Qué reciben esos terceros",
        body: [
          "Al descargar esos archivos, Hugging Face, GitHub y jsDelivr reciben lo habitual en cualquier petición HTTP: tu dirección IP, la fecha y hora, el user agent de tu navegador y la URL exacta solicitada (el nombre del modelo o archivo). Ninguna de esas peticiones lleva tu documento, el texto que extrajimos de él, ni el resultado que generaste: técnicamente no pueden, porque esas descargas ocurren antes de que tu documento entre en juego, o en una petición completamente separada.",
          "Hugging Face, GitHub y jsDelivr son servicios de terceros que operan bajo sus propias políticas de privacidad, independientes de esta:",
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
        title: "Qué más guarda tu navegador para esta página",
        body: [
          "Además de los modelos, guardamos en el almacenamiento local de tu navegador (localStorage, nunca en un servidor): el historial de «Recientes» (nombre del archivo que procesaste, qué herramienta usaste y la fecha, nunca el contenido del archivo) y tus preferencias de idioma y tema. El nombre de un archivo puede ser información sensible por sí mismo (por ejemplo, «Contrato-Divorcio-Juan.pdf»), así que ten esto en cuenta si compartes el dispositivo.",
          "Puedes borrar el historial reciente desde la página «Recientes», o borrar todo (historial y preferencias incluidos) borrando los datos del sitio desde la configuración de tu navegador.",
        ],
      },
      {
        title: "Los resultados de IA pueden equivocarse",
        body: [
          "Los resúmenes, traducciones y el texto reconocido por OCR los genera un modelo automático que puede cometer errores, inventar datos o pasar por alto matices. No sustituyen una revisión humana del documento original, especialmente para decisiones legales, médicas, financieras o de cualquier otro tipo con consecuencias reales.",
        ],
      },
    ],
    thirdPartyLinks: [
      { label: "Política de privacidad de Hugging Face", href: "https://huggingface.co/privacy" },
      { label: "Declaración de privacidad de GitHub", href: "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" },
      { label: "Política de privacidad de jsDelivr", href: "https://www.jsdelivr.com/terms/privacy-policy" },
    ],
    contactTitle: "Cambios y contacto",
    contactBody:
      "Si cambiamos qué se descarga o de dónde, actualizaremos esta página y la fecha de vigencia de arriba. Para preguntas sobre esta política, contacta con el proyecto a través de la",
    contactLinkLabel: "página del proyecto",
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
        title: "External requests made by the tools",
        body: [
          "As with any website, the hosting provider this page lives on receives your browser's normal technical requests (IP, time, user agent, requested URL) and may keep access logs; it never processes your documents, because they never reach it — everything happens inside your browser. Beyond that, a handful of tools use AI models that run inside your own browser (nothing is sent to an AI cloud). To run them, the first time you use them their files need to be downloaded from the public site where each project publishes them. Your document is never part of those downloads.",
          "\"Summarise with AI\" (pdf-summarizer): downloads the model weights from Hugging Face (huggingface.co and its storage domains) and the WebAssembly runtime engine from GitHub (the mlc-ai/binary-mlc-llm-libs repository).",
          "\"Translation report\" (translate-pdf): downloads the relevant translation model (the Helsinki-NLP OPUS-MT family, published by Xenova) from Hugging Face.",
          "Text recognition / OCR (the \"OCR PDF\" tool, and the optional OCR fallback inside \"Translation report\" and \"Summarise with AI\"): downloads the recognition engine and the chosen language's data from jsDelivr, a public open-source package CDN.",
          "Before running these tools we tell you something needs to be downloaded. For the heavier models (summarising and translation, hundreds of MB) we also ask for your explicit authorisation via a checkbox, showing the approximate size before anything downloads; without checking it, no request is made and the tool does not work. The lighter OCR engine downloads as soon as you press \"Process\", without a separate confirmation checkbox.",
        ],
      },
      {
        key: "thirdParties",
        title: "What those third parties receive",
        body: [
          "When downloading those files, Hugging Face, GitHub and jsDelivr receive what any HTTP request normally carries: your IP address, the date and time, your browser's user agent, and the exact URL requested (the model or file name). None of these requests carries your document, the text extracted from it, or the result you generated: technically they can't, because these downloads happen before your document comes into play, or in a fully separate request.",
          "Hugging Face, GitHub and jsDelivr are third-party services operating under their own privacy policies, independent of this one:",
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
        title: "What else your browser stores for this page",
        body: [
          "Besides models, we store in your browser's local storage (localStorage, never on a server): your \"Recent\" history (the name of the file you processed, which tool you used, and the date — never the file's content) and your language and theme preferences. A file name can be sensitive information on its own (for example, \"Divorce-Contract-John.pdf\"), so keep that in mind if you share the device.",
          "You can clear the recent history from the \"Recent\" page, or clear everything (history and preferences included) by clearing this site's data from your browser settings.",
        ],
      },
      {
        title: "AI results can be wrong",
        body: [
          "Summaries, translations and OCR-recognised text are produced by an automated model that can make mistakes, invent details, or miss nuance. They do not replace a human review of the original document, especially for legal, medical, financial, or otherwise consequential decisions.",
        ],
      },
    ],
    thirdPartyLinks: [
      { label: "Hugging Face's privacy policy", href: "https://huggingface.co/privacy" },
      { label: "GitHub's privacy statement", href: "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" },
      { label: "jsDelivr's privacy policy", href: "https://www.jsdelivr.com/terms/privacy-policy" },
    ],
    contactTitle: "Changes and contact",
    contactBody:
      "If what gets downloaded, or from where, ever changes, we will update this page and the effective date above. For questions about this policy, reach the project through the",
    contactLinkLabel: "project page",
  },
};
