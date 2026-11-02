import type { Language } from "@/lib/i18n";
import type { SnapshotClientErrorCode } from "@/lib/htmlSnapshot/client";
import type { SnapshotNoteCode } from "@/lib/htmlSnapshot/types";

/**
 * Textos propios de "HTML a PDF". El diccionario global solo cubre lo
 * compartido por todas las herramientas.
 */
export type UrlErrorCopy = { title: string; message: string };

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
  howItWorksBodyUrl: string;
  fidelityWarning: string;
  fidelityWarningUrl: string;
  securityTitle: string;
  securityBody: string;
  securityBodyUrl: string;
  optionsNote: string;
  progress: string;
  filenameSuffix: string;

  /* Origen: «Dirección web» / «Archivo HTML» */
  modeLabel: string;
  modeUrl: string;
  modeFile: string;

  /* Dirección web */
  urlHeading: string;
  /** Aviso de transparencia: se ve SIEMPRE antes de consultar. */
  urlNoticeTitle: string;
  urlNotice: string;
  urlFieldLabel: string;
  urlPlaceholder: string;
  urlHint: string;
  urlReady: string;
  urlInvalid: string;
  urlBlocked: string;
  consult: string;
  consulting: string;
  consultingDetail: string;
  cancelConsult: string;
  consultCancelled: string;
  retry: string;
  urlErrors: Record<Exclude<SnapshotClientErrorCode, "cancelled">, UrlErrorCopy>;
  limitsTitle: string;
  limits: string[];

  /* Resultado de la consulta (ya cargada en la lista de archivos) */
  snapshotTitle: string;
  snapshotAddress: string;
  snapshotPageTitle: string;
  snapshotNotesTitle: string;
  snapshotNotes: Record<SnapshotNoteCode, string>;
  snapshotNoNotes: string;
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
  howItWorksBodyUrl:
    "La página que leyó nuestro servidor se abre en un marco aislado dentro de tu navegador, se fotografía tal y como se ve y esa imagen se reparte en páginas del PDF, cortando entre líneas, imágenes y filas de tabla para no partirlas.",
  fidelityWarning:
    "Es una instantánea visual, no un documento estructurado: el texto del PDF no se podrá seleccionar ni buscar, y los diseños CSS complejos, las tipografías externas y todo lo que dependa de JavaScript pueden no reproducirse igual que en un navegador. Las imágenes y hojas de estilo alojadas en otros servidores puede que no carguen y simplemente no aparecerán.",
  fidelityWarningUrl:
    "Es una instantánea visual, no un documento estructurado: el texto del PDF no se podrá seleccionar ni buscar. Se lee el HTML que envía la página, así que lo que se arma con JavaScript puede faltar, las tipografías propias de la página no se incluyen y las páginas que piden iniciar sesión no se pueden leer.",
  securityTitle: "Tu HTML no se ejecuta",
  securityBody:
    "El archivo se limpia antes de abrirlo y se muestra en un marco sin permisos de JavaScript: ni los scripts ni los manejadores que traiga llegan a ejecutarse. Nada sale de tu dispositivo.",
  securityBodyUrl:
    "La página se limpia en el servidor y otra vez en tu navegador, y se muestra en un marco sin permisos de JavaScript: ni sus scripts ni sus manejadores llegan a ejecutarse. Solo la consulta de la dirección pasa por nuestro servidor, que no guarda nada; el PDF se crea en tu dispositivo.",
  optionsNote:
    "La página se maqueta con el ancho de la hoja (816 px en Carta) y el contenido se ajusta al área útil: un margen mayor deja más blanco y reduce un poco el contenido. Si la página es más ancha que la hoja, se reduce para que quepa.",
  progress: "Convirtiendo el HTML",
  filenameSuffix: "html-a-pdf",

  modeLabel: "Origen de la página",
  modeUrl: "Dirección web",
  modeFile: "Archivo HTML",

  urlHeading: "Convertir una página web",
  urlNoticeTitle: "Qué pasa con la dirección",
  urlNotice:
    "Para leer esta dirección, nuestro servidor la consulta y te devuelve la página; no se guarda nada. El PDF se crea en tu dispositivo.",
  urlFieldLabel: "Dirección de la página",
  urlPlaceholder: "ejemplo.com/articulo",
  urlHint: "Escribe o pega la dirección. Si no pones http:// o https://, se usa https://.",
  urlReady: "La dirección tiene buena forma. Pulsa «Consultar» para leer la página.",
  urlInvalid: "Todavía no es una dirección completa. Escribe algo como ejemplo.com/articulo.",
  urlBlocked: "Esta dirección no se puede consultar: es privada, local o interna.",
  consult: "Consultar",
  consulting: "Consultando la dirección…",
  consultingDetail: "Nuestro servidor está leyendo la página; puede tardar unos segundos.",
  cancelConsult: "Cancelar consulta",
  consultCancelled: "Consulta cancelada. No se guardó nada.",
  retry: "Reintentar",
  urlErrors: {
    "invalid-url": {
      title: "La dirección no es válida",
      message:
        "Revisa que esté completa y empiece por http:// o https://. No se admiten usuario y contraseña ni puertos distintos de 80 y 443.",
    },
    "blocked-address": {
      title: "No se puede consultar esa dirección",
      message: "Solo se leen páginas públicas de Internet: no se permiten direcciones privadas, locales ni internas.",
    },
    unreachable: {
      title: "No se pudo leer la página",
      message:
        "El sitio no respondió, no existe o no deja que se lea. Prueba con otra dirección, o guarda la página como archivo HTML y súbela en «Archivo HTML».",
    },
    "too-large": {
      title: "La página es demasiado grande",
      message:
        "Pesa más de lo que se puede consultar (5 MB de HTML). Guárdala como archivo HTML y súbela en «Archivo HTML».",
    },
    "unsupported-type": {
      title: "Eso no es una página web",
      message: "La dirección apunta a otro tipo de contenido (un PDF, una imagen, un archivo). Solo se leen páginas HTML.",
    },
    timeout: {
      title: "La consulta tardó demasiado",
      message: "El sitio tardó más de 10 segundos en responder. Inténtalo otra vez o prueba más tarde.",
    },
    "rate-limited": {
      title: "Demasiadas consultas seguidas",
      message: "Espera un minuto y vuelve a intentarlo.",
    },
    forbidden: {
      title: "Esta consulta no está permitida desde aquí",
      message: "Recarga la página y vuelve a intentarlo.",
    },
    network: {
      title: "Sin conexión con el servidor",
      message:
        "No se pudo contactar con OptimusPDF. Consultar una dirección es la única función que necesita conexión: revísala y reintenta.",
    },
    "bad-response": {
      title: "Respuesta inesperada",
      message: "El servidor devolvió algo que no se puede usar. Inténtalo de nuevo.",
    },
  },
  limitsTitle: "Qué se puede leer y qué no",
  limits: [
    "Las páginas que se arman con JavaScript pueden salir incompletas o casi vacías: se lee el HTML que envía el servidor, no lo que el navegador construye después.",
    "Las páginas que piden iniciar sesión, o que están detrás de un muro de pago, no se pueden leer.",
    "Se incluyen hasta 10 hojas de estilo y 30 imágenes; las tipografías propias de la página no se incluyen.",
    "Límites: 5 MB de HTML y unos 3,5 MB en total una vez incluidos los estilos y las imágenes.",
  ],

  snapshotTitle: "Página leída",
  snapshotAddress: "Dirección",
  snapshotPageTitle: "Título",
  snapshotNotesTitle: "Avisos de la lectura",
  snapshotNotes: {
    "images-skipped": "Imágenes que no se pudieron descargar o no eran de un formato admitido: {count}.",
    "images-limit": "Imágenes que quedaron fuera por pasar del máximo de 30 por página: {count}.",
    "images-budget": "Imágenes omitidas, las más grandes primero, para que la página quepa en el tamaño máximo: {count}.",
    "styles-skipped": "Hojas de estilo que no se pudieron incluir (la página puede verse distinta): {count}.",
    "fonts-omitted": "La página declara tipografías propias; no se incluyen y se usan las del sistema.",
    "scripts-ignored": "La página trae JavaScript. No se ejecuta, así que lo que dependa de él puede faltar.",
    "embeds-omitted": "Contenidos incrustados (marcos, video, audio) que no se incluyen: {count}.",
    "little-content": "Casi no hay contenido legible: es normal en páginas que se arman con JavaScript.",
  },
  snapshotNoNotes: "Se leyó entera, con sus estilos e imágenes.",
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
  howItWorksBodyUrl:
    "The page our server read is opened in an isolated frame inside your browser, photographed exactly as it looks, and that image is split across the PDF pages, cutting between lines, images and table rows so none of them is split.",
  fidelityWarning:
    "This is a visual snapshot, not a structured document: the PDF text will not be selectable or searchable, and complex CSS layouts, external fonts and anything that depends on JavaScript may not render exactly as in a browser. Images and stylesheets hosted on other servers may fail to load and simply will not appear.",
  fidelityWarningUrl:
    "This is a visual snapshot, not a structured document: the PDF text will not be selectable or searchable. The HTML the page sends is what gets read, so anything built with JavaScript may be missing, the page's own fonts are not included, and pages that require signing in cannot be read.",
  securityTitle: "Your HTML never runs",
  securityBody:
    "The file is cleaned before it is opened and shown in a frame with no JavaScript permissions: neither its scripts nor its inline handlers ever execute. Nothing leaves your device.",
  securityBodyUrl:
    "The page is cleaned on the server and again in your browser, and shown in a frame with no JavaScript permissions: neither its scripts nor its handlers ever execute. Only the address lookup goes through our server, which stores nothing; the PDF is created on your device.",
  optionsNote:
    "The page is laid out at the sheet's width (816 px on Letter) and the content is fitted to the usable area: a larger margin leaves more white space and shrinks the content a little. A page wider than the sheet is scaled down to fit.",
  progress: "Converting the HTML",
  filenameSuffix: "html-to-pdf",

  modeLabel: "Page source",
  modeUrl: "Web address",
  modeFile: "HTML file",

  urlHeading: "Convert a web page",
  urlNoticeTitle: "What happens to the address",
  urlNotice:
    "To read this address, our server looks it up and sends the page back to you; nothing is stored. The PDF is created on your device.",
  urlFieldLabel: "Page address",
  urlPlaceholder: "example.com/article",
  urlHint: "Type or paste the address. If you leave out http:// or https://, https:// is used.",
  urlReady: "The address looks fine. Press “Look up” to read the page.",
  urlInvalid: "That is not a complete address yet. Type something like example.com/article.",
  urlBlocked: "This address cannot be looked up: it is private, local or internal.",
  consult: "Look up",
  consulting: "Looking up the address…",
  consultingDetail: "Our server is reading the page; it may take a few seconds.",
  cancelConsult: "Cancel lookup",
  consultCancelled: "Lookup cancelled. Nothing was stored.",
  retry: "Try again",
  urlErrors: {
    "invalid-url": {
      title: "The address is not valid",
      message:
        "Check that it is complete and starts with http:// or https://. User names and passwords, and ports other than 80 and 443, are not accepted.",
    },
    "blocked-address": {
      title: "That address cannot be looked up",
      message: "Only public web pages are read: private, local and internal addresses are not allowed.",
    },
    unreachable: {
      title: "The page could not be read",
      message:
        "The site did not respond, does not exist or does not allow reading. Try another address, or save the page as an HTML file and upload it in “HTML file”.",
    },
    "too-large": {
      title: "The page is too large",
      message: "It is bigger than what can be looked up (5 MB of HTML). Save it as an HTML file and upload it in “HTML file”.",
    },
    "unsupported-type": {
      title: "That is not a web page",
      message: "The address points to another kind of content (a PDF, an image, a file). Only HTML pages can be read.",
    },
    timeout: {
      title: "The lookup took too long",
      message: "The site took more than 10 seconds to respond. Try again, or try later.",
    },
    "rate-limited": {
      title: "Too many lookups in a row",
      message: "Wait a minute and try again.",
    },
    forbidden: {
      title: "This lookup is not allowed from here",
      message: "Reload the page and try again.",
    },
    network: {
      title: "No connection to the server",
      message:
        "OptimusPDF could not be reached. Looking up an address is the only feature that needs a connection: check yours and try again.",
    },
    "bad-response": {
      title: "Unexpected response",
      message: "The server returned something that cannot be used. Please try again.",
    },
  },
  limitsTitle: "What can and cannot be read",
  limits: [
    "Pages built with JavaScript may come out incomplete or nearly empty: the HTML the server sends is what is read, not what the browser builds afterwards.",
    "Pages that require signing in, or sit behind a paywall, cannot be read.",
    "Up to 10 stylesheets and 30 images are included; the page's own fonts are not.",
    "Limits: 5 MB of HTML and about 3.5 MB in total once styles and images are included.",
  ],

  snapshotTitle: "Page read",
  snapshotAddress: "Address",
  snapshotPageTitle: "Title",
  snapshotNotesTitle: "Notes about the lookup",
  snapshotNotes: {
    "images-skipped": "Images that could not be downloaded or were not a supported format: {count}.",
    "images-limit": "Images left out because the page has more than the 30-image maximum: {count}.",
    "images-budget": "Images omitted, largest first, so the page fits the size limit: {count}.",
    "styles-skipped": "Stylesheets that could not be included (the page may look different): {count}.",
    "fonts-omitted": "The page declares its own fonts; they are not included and system fonts are used.",
    "scripts-ignored": "The page contains JavaScript. It is not run, so anything that depends on it may be missing.",
    "embeds-omitted": "Embedded items (frames, video, audio) that are not included: {count}.",
    "little-content": "There is almost no readable content: this is normal for pages built with JavaScript.",
  },
  snapshotNoNotes: "It was read in full, with its styles and images.",
};

export const STRINGS: Record<Language, HtmlToPdfStrings> = { es, en };

/** «{count}» -> número. */
export function noteText(template: string, count: number | undefined): string {
  return template.replace("{count}", String(count ?? 0));
}
