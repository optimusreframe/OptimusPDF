import type { Language } from "@/lib/i18n";
import type { CameraErrorCode } from "@/lib/pdf/scanToPdf";

/** Textos propios de "Escanear a PDF". Copy original ES/EN. */
export type ScanToPdfStrings = {
  startTitle: string;
  startBody: string;
  startButton: string;
  starting: string;
  liveTitle: string;
  capture: string;
  stopCamera: string;
  retryCamera: string;
  uploadInstead: string;
  uploadHint: string;
  capturesTitle: string;
  capturesEmpty: string;
  captureAlt: string;
  removeCapture: string;
  filterLabel: string;
  filterColor: string;
  filterBw: string;
  filterHint: string;
  pageSizeLabel: string;
  pageSizeA4: string;
  pageSizeLetter: string;
  pageSizeFit: string;
  marginLabel: string;
  marginNone: string;
  marginSmall: string;
  marginLarge: string;
  generate: string;
  cameraErrorTitle: string;
  cameraErrors: Record<CameraErrorCode, string>;
};

export const STRINGS: Record<Language, ScanToPdfStrings> = {
  es: {
    startTitle: "Usa la cámara como escáner",
    startBody:
      "Activa la cámara, encuadra el documento y captura una página tras otra. El vídeo se queda en tu dispositivo: no se transmite ni se graba.",
    startButton: "Activar cámara",
    starting: "Abriendo la cámara…",
    liveTitle: "Vista de la cámara",
    capture: "Capturar página",
    stopCamera: "Apagar cámara",
    retryCamera: "Volver a intentarlo",
    uploadInstead: "Elegir fotos del dispositivo",
    uploadHint:
      "¿Sin cámara disponible? Puedes añadir fotos que ya tengas guardadas.",
    capturesTitle: "Páginas capturadas",
    capturesEmpty: "Todavía no has capturado ninguna página.",
    captureAlt: "Captura",
    removeCapture: "Descartar captura",
    filterLabel: "Aspecto",
    filterColor: "Color",
    filterBw: "Blanco y negro",
    filterHint:
      "El modo blanco y negro sube el contraste para que el texto se lea mejor.",
    pageSizeLabel: "Tamaño de página",
    pageSizeA4: "A4",
    pageSizeLetter: "Carta",
    pageSizeFit: "Ajustar",
    marginLabel: "Margen",
    marginNone: "Sin margen",
    marginSmall: "Pequeño",
    marginLarge: "Grande",
    generate: "Generar PDF",
    cameraErrorTitle: "La cámara no está disponible",
    cameraErrors: {
      denied:
        "Has bloqueado el acceso a la cámara. Permítelo en los ajustes del navegador y vuelve a intentarlo.",
      notFound: "No hemos encontrado ninguna cámara conectada a este equipo.",
      busy: "Otra aplicación está usando la cámara. Ciérrala e inténtalo otra vez.",
      insecure:
        "El navegador solo abre la cámara en conexiones seguras (HTTPS).",
      unsupported: "Este navegador no permite abrir la cámara desde una web.",
      unknown: "No se ha podido abrir la cámara. Vuelve a intentarlo.",
    },
  },
  en: {
    startTitle: "Turn your camera into a scanner",
    startBody:
      "Turn the camera on, frame the document and capture one page after another. The video stays on your device: nothing is streamed or recorded.",
    startButton: "Turn camera on",
    starting: "Opening the camera…",
    liveTitle: "Camera view",
    capture: "Capture page",
    stopCamera: "Turn camera off",
    retryCamera: "Try again",
    uploadInstead: "Pick photos from this device",
    uploadHint: "No camera around? You can add photos you already have.",
    capturesTitle: "Captured pages",
    capturesEmpty: "You have not captured any page yet.",
    captureAlt: "Capture",
    removeCapture: "Discard capture",
    filterLabel: "Look",
    filterColor: "Colour",
    filterBw: "Black and white",
    filterHint:
      "Black and white raises the contrast so the text reads more clearly.",
    pageSizeLabel: "Page size",
    pageSizeA4: "A4",
    pageSizeLetter: "Letter",
    pageSizeFit: "Fit",
    marginLabel: "Margin",
    marginNone: "No margin",
    marginSmall: "Small",
    marginLarge: "Large",
    generate: "Build PDF",
    cameraErrorTitle: "The camera is not available",
    cameraErrors: {
      denied:
        "Camera access is blocked. Allow it in your browser settings and try again.",
      notFound: "We could not find any camera attached to this device.",
      busy: "Another app is using the camera. Close it and try again.",
      insecure: "Browsers only open the camera over a secure connection (HTTPS).",
      unsupported: "This browser cannot open the camera from a web page.",
      unknown: "The camera could not be opened. Please try again.",
    },
  },
};
