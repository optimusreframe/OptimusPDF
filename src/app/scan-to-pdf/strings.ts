import type { Language } from "@/lib/i18n";
import type { CameraErrorCode } from "@/lib/pdf/scanToPdf";
import type { CaptureHint } from "@/lib/scan/frameAnalysis";

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
  autoCaptureLabel: string;
  autoCaptureHint: string;
  /** Contiene `{seconds}`, que se sustituye por los segundos restantes. */
  autoCountdown: string;
  captureHints: Record<CaptureHint, string>;
  nativeCamera: string;
  nativeCameraHint: string;
  burstTitle: string;
  /** Contiene `{count}`, que se sustituye por las fotos ya tomadas. */
  burstCount: string;
  burstDone: string;
  capturesTitle: string;
  capturesEmpty: string;
  captureAlt: string;
  removeCapture: string;
  croppedBadge: string;
  cropping: string;
  editCorners: string;
  undoCrop: string;
  cornersTitle: string;
  cornersHint: string;
  cornersLoading: string;
  cornersApply: string;
  cornersReset: string;
  cornersCancel: string;
  cornersInvalid: string;
  filterLabel: string;
  filterColor: string;
  filterGrayscale: string;
  filterBw: string;
  filterEnhance: string;
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
  /** Motivos junto al boton de generar cuando esta desactivado. */
  needCapture: string;
  capturePending: string;
  cameraErrorTitle: string;
  cameraErrors: Record<CameraErrorCode, string>;
};

export const STRINGS: Record<Language, ScanToPdfStrings> = {
  es: {
    startTitle: "Usa la cámara como escáner",
    startBody:
      "La vía rápida: activa la cámara, encuadra el documento y la auto-captura dispara sola, página tras página. El vídeo se queda en tu dispositivo: no se transmite ni se graba.",
    startButton: "Activar cámara",
    starting: "Abriendo la cámara…",
    liveTitle: "Vista de la cámara",
    capture: "Capturar página",
    stopCamera: "Apagar cámara",
    retryCamera: "Volver a intentarlo",
    uploadInstead: "Elegir fotos del dispositivo",
    uploadHint:
      "¿Sin cámara disponible? Puedes añadir fotos que ya tengas guardadas.",
    autoCaptureLabel: "Auto-captura",
    autoCaptureHint:
      "Captura sola cuando el documento se ve nítido y la cámara está quieta.",
    autoCountdown: "Capturando en {seconds}…",
    captureHints: {
      ok: "Listo para capturar",
      hold_steady: "Mantén firme",
      too_dark: "Muy oscuro",
      unknown: "Buscando el encuadre…",
    },
    nativeCamera: "Usar la app de Cámara del sistema",
    nativeCameraHint:
      "Más lenta: la app de Cámara te pide confirmar cada foto antes de volver aquí. Solo merece la pena si necesitas flash o enfoque manual reales.",
    burstTitle: "Ráfaga activa",
    burstCount: "Fotos capturadas: {count}",
    burstDone: "Terminar",
    capturesTitle: "Páginas capturadas",
    capturesEmpty: "Todavía no has capturado ninguna página.",
    captureAlt: "Captura",
    removeCapture: "Descartar captura",
    croppedBadge: "Recortada",
    cropping: "Buscando los bordes…",
    editCorners: "Editar recorte",
    undoCrop: "Deshacer recorte",
    cornersTitle: "Ajusta las esquinas",
    cornersHint:
      "Arrastra cada esquina hasta los bordes del documento. Con el teclado: tabula hasta una esquina y muévela con las flechas.",
    cornersLoading: "Preparando el editor…",
    cornersApply: "Aplicar recorte",
    cornersReset: "Toda la foto",
    cornersCancel: "Cerrar sin cambios",
    cornersInvalid: "Las esquinas se cruzan",
    filterLabel: "Aspecto",
    filterColor: "Color",
    filterGrayscale: "Grises",
    filterBw: "Blanco y negro",
    filterEnhance: "Realzar",
    filterHint:
      "«Grises» quita el color sin tocar el contraste, «Blanco y negro» lo sube para que el texto se lea mejor y «Realzar» estira el contraste según la propia foto.",
    pageSizeLabel: "Tamaño de página",
    pageSizeA4: "A4",
    pageSizeLetter: "Carta",
    pageSizeFit: "Ajustar",
    marginLabel: "Margen",
    marginNone: "Sin margen",
    marginSmall: "Pequeño",
    marginLarge: "Grande",
    generate: "Generar PDF",
    needCapture: "Haz o importa al menos una captura para generar el PDF.",
    capturePending: "Espera a que termine de procesarse la última captura.",
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
      "The fast way: turn the camera on, frame the document and auto capture shoots on its own, page after page. The video stays on your device: nothing is streamed or recorded.",
    startButton: "Turn camera on",
    starting: "Opening the camera…",
    liveTitle: "Camera view",
    capture: "Capture page",
    stopCamera: "Turn camera off",
    retryCamera: "Try again",
    uploadInstead: "Pick photos from this device",
    uploadHint: "No camera around? You can add photos you already have.",
    autoCaptureLabel: "Auto capture",
    autoCaptureHint:
      "Shoots on its own once the document looks sharp and the camera is still.",
    autoCountdown: "Capturing in {seconds}…",
    captureHints: {
      ok: "Ready to capture",
      hold_steady: "Hold steady",
      too_dark: "Too dark",
      unknown: "Reading the frame…",
    },
    nativeCamera: "Use the system Camera app",
    nativeCameraHint:
      "Slower: the Camera app asks you to confirm every photo before returning here. Only worth it for real flash or manual focus.",
    burstTitle: "Burst mode on",
    burstCount: "Photos captured: {count}",
    burstDone: "Done",
    capturesTitle: "Captured pages",
    capturesEmpty: "You have not captured any page yet.",
    captureAlt: "Capture",
    removeCapture: "Discard capture",
    croppedBadge: "Cropped",
    cropping: "Looking for the edges…",
    editCorners: "Edit crop",
    undoCrop: "Undo crop",
    cornersTitle: "Adjust the corners",
    cornersHint:
      "Drag each corner onto the edges of the document. With a keyboard: tab to a corner and move it with the arrow keys.",
    cornersLoading: "Getting the editor ready…",
    cornersApply: "Apply crop",
    cornersReset: "Whole photo",
    cornersCancel: "Close without changes",
    cornersInvalid: "The corners cross over",
    filterLabel: "Look",
    filterColor: "Colour",
    filterGrayscale: "Greyscale",
    filterBw: "Black and white",
    filterEnhance: "Enhance",
    filterHint:
      "“Greyscale” drops the colour without touching contrast, “Black and white” raises it so the text reads more clearly, and “Enhance” stretches the contrast to fit the photo itself.",
    pageSizeLabel: "Page size",
    pageSizeA4: "A4",
    pageSizeLetter: "Letter",
    pageSizeFit: "Fit",
    marginLabel: "Margin",
    marginNone: "No margin",
    marginSmall: "Small",
    marginLarge: "Large",
    generate: "Build PDF",
    needCapture: "Take or import at least one capture to build the PDF.",
    capturePending: "Wait for the last capture to finish processing.",
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
