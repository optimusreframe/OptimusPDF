import type { Language } from "@/lib/i18n";
import type { VideoErrorCode } from "@/lib/media/video/errors";
import type { IssueCode } from "@/lib/media/video/plan";

/**
 * Textos propios de «Convertidor de video». Los entre llaves ({size}, {limit}...) los rellena la pagina. Todo lo que el usuario
 * puede encontrarse tiene su frase: ningun error de libreria llega a la pantalla tal cual.
 */
export type ErrorText = { title: string; message: string; hint?: string };

export type VideoConverterStrings = {
  checking: string;
  // --- Navegador sin WebCodecs (pagina informativa, no un error) ---
  unsupportedTitle: string;
  unsupported: Record<"insecure-context" | "no-video-encoder" | "no-video-decoder", string>;
  unsupportedBrowsers: string;
  unsupportedLocal: string;
  // --- Reposo ---
  idleTitle: string;
  idleBody: string;
  idleFormats: string;
  idleLimits: string;
  constrainedNote: string;
  // --- Lectura ---
  probing: string;
  chooseAnother: string;
  removeFile: string;
  // --- Tarjeta del archivo ---
  cardTitle: string;
  duration: string;
  dimensions: string;
  frameRate: string;
  container: string;
  videoTrack: string;
  audioTrack: string;
  noAudio: string;
  weight: string;
  rotated: string;
  fpsUnit: string;
  // --- Opciones ---
  formatLabel: string;
  formatMp4: string;
  formatWebm: string;
  formatUnavailable: Record<"mp4" | "webm", string>;
  resolutionLabel: string;
  resolutionOriginal: string;
  resolutionNote: string;
  qualityLabel: string;
  qualityKeep: string;
  qualityHigh: string;
  qualityBalanced: string;
  qualitySmall: string;
  qualityHint: Record<"keep" | "high" | "balanced" | "small", string>;
  fpsLabel: string;
  fpsOriginal: string;
  fpsOption: string;
  removeAudio: string;
  removeAudioHint: string;
  noAudioToRemove: string;
  // --- Estimacion ---
  estimateTitle: string;
  estimateCopy: string;
  estimateTranscode: string;
  estimateNote: string;
  // --- Ejecutar ---
  run: string;
  runBlocked: string;
  progress: string;
  cancelled: string;
  // --- Avisos previos (Record por codigo) ---
  levelBlock: string;
  levelWarn: string;
  levelInfo: string;
  issues: Record<IssueCode, string>;
  // --- Fallos (por codigo) ---
  errors: Record<VideoErrorCode, ErrorText>;
  invalidType: ErrorText;
  // --- Resultado ---
  filenameSuffix: string;
  summaryCopy: string;
  summaryTranscode: string;
  noticesTitle: string;
  noticeAudioDropped: string;
  noticeAudioRemoved: string;
  openAudioConverter: string;
};

const es: VideoConverterStrings = {
  checking: "Comprobando lo que puede hacer tu navegador…",
  unsupportedTitle: "Este navegador no puede convertir video aquí",
  unsupported: {
    "insecure-context":
      "Esta página se abrió sin conexión segura (http) y el navegador desactiva por eso las funciones de video que necesitamos. Ábrela desde una dirección https.",
    "no-video-encoder":
      "Tu navegador no incluye el codificador de video (WebCodecs) con el que convertimos. No es un fallo de tu archivo ni de tu equipo.",
    "no-video-decoder":
      "Tu navegador no incluye el decodificador de video (WebCodecs) con el que leemos el archivo. No es un fallo de tu archivo ni de tu equipo.",
  },
  unsupportedBrowsers: "Prueba con una versión reciente de Chrome, Edge, Firefox o Safari, en un ordenador si puedes.",
  unsupportedLocal:
    "Convertimos el video en tu propio dispositivo, sin subirlo a ningún servidor; por eso dependemos de lo que el navegador sepa hacer.",
  idleTitle: "Convierte un video sin subirlo a ningún sitio",
  idleBody:
    "Elige MP4 o WebM, la resolución y la calidad. El video se lee a trozos desde tu dispositivo y se convierte aquí mismo; solo se ofrece lo que tu navegador puede hacer de verdad.",
  idleFormats: "Entrada: MP4, MOV, M4V, WebM y MKV (según los códecs que entienda tu navegador). Salida: MP4 (H.264 + AAC) o WebM (VP9 + Opus).",
  idleLimits: "Avisamos a partir de {warn} y no aceptamos más de {max} ni más de {duration} de video.",
  constrainedNote:
    "En iPhone, iPad y móviles con poca memoria los límites son más bajos y la conversión es más lenta. Mantén esta pestaña abierta y la pantalla encendida mientras convierte; para videos largos, mejor un ordenador.",
  probing: "Leyendo el video…",
  chooseAnother: "Elegir otro archivo",
  removeFile: "Quitar archivo",
  cardTitle: "Video",
  duration: "Duración",
  dimensions: "Resolución",
  frameRate: "Fotogramas",
  container: "Contenedor",
  videoTrack: "Video",
  audioTrack: "Audio",
  noAudio: "Sin audio",
  weight: "Peso",
  rotated: "girado {degrees}° (se respeta)",
  fpsUnit: "{fps} fps",
  formatLabel: "Formato de salida",
  formatMp4: "MP4",
  formatWebm: "WebM",
  formatUnavailable: {
    mp4: "MP4 no está disponible en este navegador: no puede codificar H.264.",
    webm: "WebM no está disponible en este navegador: no puede codificar VP9 ni VP8.",
  },
  resolutionLabel: "Resolución",
  resolutionOriginal: "Original",
  resolutionNote: "Nunca se amplía y se conserva la proporción. En un video vertical, 720p son 720 píxeles de ancho.",
  qualityLabel: "Calidad",
  qualityKeep: "Conservar",
  qualityHigh: "Alta",
  qualityBalanced: "Equilibrada",
  qualitySmall: "Pequeña",
  qualityHint: {
    keep: "Sin recodificar cuando se puede: es lo más rápido y no pierde nada. Si hay que cambiar de códec, se recodifica con calidad alta.",
    high: "Casi igual al original, con un archivo bastante más ligero.",
    balanced: "Buen compromiso entre calidad y peso para compartir.",
    small: "El archivo más ligero; se nota algo de pérdida en escenas con mucho movimiento.",
  },
  fpsLabel: "Fotogramas por segundo (máximo)",
  fpsOriginal: "Original",
  fpsOption: "{fps} fps",
  removeAudio: "Quitar el audio",
  removeAudioHint: "El resultado saldrá sin sonido y pesará algo menos.",
  noAudioToRemove: "Este video no tiene audio.",
  estimateTitle: "Peso estimado del resultado",
  estimateCopy: "Sin recodificar: {size} aprox.",
  estimateTranscode: "{size} aprox. (original: {original})",
  estimateNote: "Es una estimación: el peso real depende del contenido del video.",
  run: "Convertir",
  runBlocked: "«Convertir» se activa cuando no quede ningún aviso rojo; cambia las opciones o elige otro archivo.",
  progress: "Convirtiendo el video…",
  cancelled: "Conversión cancelada. No se guardó nada.",
  levelBlock: "No se puede convertir",
  levelWarn: "Aviso",
  levelInfo: "Nota",
  issues: {
    noVideoTrack: "Este archivo no tiene imagen: no hay nada que convertir.",
    cannotDecodeVideo: "Tu navegador no sabe leer el códec de este video ({codec}). Prueba con otro navegador o con otro archivo.",
    formatUnavailable: "Este navegador no puede producir {format}. Elige el otro formato.",
    inputTooLarge: "El archivo pesa {size} y el límite en este dispositivo es {limit}. Si puedes, acórtalo o usa un ordenador.",
    tooLong: "El video dura {duration} y el límite en este dispositivo es {limit}. Acórtalo antes de convertirlo.",
    outputTooLarge:
      "Con estas opciones el resultado pesaría unos {size}, por encima de los {limit} que este dispositivo aguanta en memoria. Baja la calidad o la resolución.",
    bigFile: "El archivo pesa {size}: puede tardar bastante y, en equipos con poca memoria, fallar. Mantén la pestaña abierta.",
    longVideo: "El video dura {duration}: la conversión puede tardar mucho. Mantén la pestaña abierta y el equipo enchufado.",
    audioUndecodable: "Tu navegador no sabe leer el audio de este video ({codec}): el resultado saldrá sin sonido.",
    audioCannotEncode: "Este navegador no puede codificar el audio de este formato y el del original no se puede conservar tal cual: el resultado saldrá sin sonido. Prueba con el otro formato.",
    outputLarger: "El resultado podría pesar más que el original ({size} frente a {original}): el original está muy comprimido. Elige «Pequeña» si quieres reducirlo.",
    hdr: "Este video es HDR: al recodificarlo saldrá en SDR y los colores pueden verse más apagados. «Conservar» mantiene el HDR si no cambia el códec.",
    rotationBaked: "WebM no guarda la rotación del móvil: se gira la imagen de verdad, así que se recodifica.",
    fpsUnknown: "No pudimos medir los fotogramas por segundo de este video: el tope elegido no se aplicará.",
  },
  errors: {
    unreadable: {
      title: "No se puede leer este video",
      message: "El archivo no es un video que podamos abrir, o está incompleto o dañado.",
      hint: "Comprueba que se reproduce en tu equipo; si es un MP4 de una descarga cortada, vuelve a bajarlo.",
    },
    noVideoTrack: {
      title: "Este archivo no tiene imagen",
      message: "Solo contiene audio, así que no hay video que convertir.",
      hint: "Para cambiar el formato de un audio usa «Convertidor de audio».",
    },
    cannotDecodeVideo: {
      title: "No sabemos leer el códec de este video",
      message: "Tu navegador no incluye el decodificador para la imagen de este archivo.",
      hint: "Prueba con otro navegador (Safari entiende HEVC de iPhone; Chrome y Edge, H.264 y VP9) o con otro archivo.",
    },
    cannotEncode: {
      title: "Tu equipo no puede codificar con estas opciones",
      message: "El codificador del navegador rechazó estas medidas o este ritmo de fotogramas.",
      hint: "Baja la resolución o los fotogramas por segundo, o prueba con el otro formato.",
    },
    outOfMemory: {
      title: "Se agotó la memoria",
      message: "El navegador no tiene memoria para terminar este resultado. Tu archivo está bien.",
      hint: "Prueba con calidad «Pequeña», una resolución menor, o con un video más corto. En un ordenador suele ir mejor que en un móvil.",
    },
    cancelled: { title: "Conversión cancelada", message: "No se guardó nada." },
    failed: {
      title: "No se pudo completar la conversión",
      message: "Algo falló mientras se convertía el video. No se ha subido nada a ningún sitio.",
      hint: "Vuelve a intentarlo; si se repite, prueba con otro formato o con calidad «Equilibrada».",
    },
  },
  invalidType: {
    title: "Ese archivo no es un video",
    message: "Elige un video MP4, MOV, M4V, WebM o MKV.",
  },
  filenameSuffix: "convertido",
  summaryCopy: "{format}, {dimensions}. Sin recodificar el video: no pierde calidad.",
  summaryTranscode: "{format}, {dimensions}, recodificado.",
  noticesTitle: "Ten en cuenta",
  noticeAudioDropped: "El audio no se pudo conservar: el resultado no tiene sonido.",
  noticeAudioRemoved: "Como pediste, el resultado no tiene audio.",
  openAudioConverter: "Abrir Convertidor de audio",
};

const en: VideoConverterStrings = {
  checking: "Checking what your browser can do…",
  unsupportedTitle: "This browser can't convert video here",
  unsupported: {
    "insecure-context":
      "This page was opened without a secure connection (http), so the browser turns off the video features we need. Open it from an https address.",
    "no-video-encoder":
      "Your browser doesn't include the video encoder (WebCodecs) we convert with. This isn't a problem with your file or your device.",
    "no-video-decoder":
      "Your browser doesn't include the video decoder (WebCodecs) we read the file with. This isn't a problem with your file or your device.",
  },
  unsupportedBrowsers: "Try a recent version of Chrome, Edge, Firefox or Safari, on a computer if you can.",
  unsupportedLocal:
    "We convert the video on your own device without uploading it to any server, so we depend on what the browser can do.",
  idleTitle: "Convert a video without uploading it anywhere",
  idleBody:
    "Pick MP4 or WebM, the resolution and the quality. The video is read in pieces from your device and converted right here; we only offer what your browser can really do.",
  idleFormats: "Input: MP4, MOV, M4V, WebM and MKV (depending on the codecs your browser understands). Output: MP4 (H.264 + AAC) or WebM (VP9 + Opus).",
  idleLimits: "We warn from {warn} and don't accept more than {max} or more than {duration} of video.",
  constrainedNote:
    "On iPhone, iPad and phones with little memory the limits are lower and conversion is slower. Keep this tab open and the screen on while it converts; for long videos, a computer works better.",
  probing: "Reading the video…",
  chooseAnother: "Choose another file",
  removeFile: "Remove file",
  cardTitle: "Video",
  duration: "Duration",
  dimensions: "Resolution",
  frameRate: "Frame rate",
  container: "Container",
  videoTrack: "Video",
  audioTrack: "Audio",
  noAudio: "No audio",
  weight: "Size",
  rotated: "rotated {degrees}° (respected)",
  fpsUnit: "{fps} fps",
  formatLabel: "Output format",
  formatMp4: "MP4",
  formatWebm: "WebM",
  formatUnavailable: {
    mp4: "MP4 isn't available in this browser: it can't encode H.264.",
    webm: "WebM isn't available in this browser: it can't encode VP9 or VP8.",
  },
  resolutionLabel: "Resolution",
  resolutionOriginal: "Original",
  resolutionNote: "It's never enlarged and the proportions are kept. On a vertical video, 720p means 720 pixels wide.",
  qualityLabel: "Quality",
  qualityKeep: "Keep",
  qualityHigh: "High",
  qualityBalanced: "Balanced",
  qualitySmall: "Small",
  qualityHint: {
    keep: "No re-encoding when possible: the fastest, and nothing is lost. If the codec has to change, it's re-encoded at high quality.",
    high: "Almost identical to the original, with a much lighter file.",
    balanced: "A good balance between quality and size for sharing.",
    small: "The lightest file; some loss shows in scenes with a lot of motion.",
  },
  fpsLabel: "Frames per second (maximum)",
  fpsOriginal: "Original",
  fpsOption: "{fps} fps",
  removeAudio: "Remove the audio",
  removeAudioHint: "The result will have no sound and be a bit lighter.",
  noAudioToRemove: "This video has no audio.",
  estimateTitle: "Estimated result size",
  estimateCopy: "Without re-encoding: about {size}",
  estimateTranscode: "About {size} (original: {original})",
  estimateNote: "This is an estimate: the real size depends on the video's content.",
  run: "Convert",
  runBlocked: "“Convert” turns on when no red notice is left; change the options or choose another file.",
  progress: "Converting the video…",
  cancelled: "Conversion cancelled. Nothing was saved.",
  levelBlock: "Can't convert",
  levelWarn: "Warning",
  levelInfo: "Note",
  issues: {
    noVideoTrack: "This file has no picture: there is nothing to convert.",
    cannotDecodeVideo: "Your browser can't read this video's codec ({codec}). Try another browser or another file.",
    formatUnavailable: "This browser can't produce {format}. Choose the other format.",
    inputTooLarge: "The file weighs {size} and the limit on this device is {limit}. If you can, trim it or use a computer.",
    tooLong: "The video lasts {duration} and the limit on this device is {limit}. Trim it before converting.",
    outputTooLarge:
      "With these options the result would weigh about {size}, above the {limit} this device can hold in memory. Lower the quality or the resolution.",
    bigFile: "The file weighs {size}: it may take a long time and, on devices with little memory, fail. Keep the tab open.",
    longVideo: "The video lasts {duration}: converting can take a long time. Keep the tab open and the device plugged in.",
    audioUndecodable: "Your browser can't read this video's audio ({codec}): the result will have no sound.",
    audioCannotEncode: "This browser can't encode the audio of this format and the original's can't be kept as is: the result will have no sound. Try the other format.",
    outputLarger: "The result could weigh more than the original ({size} versus {original}): the original is already very compressed. Choose “Small” if you want to reduce it.",
    hdr: "This video is HDR: re-encoding it produces SDR and colors may look duller. “Keep” preserves HDR as long as the codec doesn't change.",
    rotationBaked: "WebM can't store the phone's rotation: the picture is really rotated, so it is re-encoded.",
    fpsUnknown: "We couldn't measure this video's frames per second: the chosen cap won't be applied.",
  },
  errors: {
    unreadable: {
      title: "This video can't be read",
      message: "The file isn't a video we can open, or it is incomplete or damaged.",
      hint: "Check that it plays on your device; if it is an MP4 from a cut-off download, download it again.",
    },
    noVideoTrack: {
      title: "This file has no picture",
      message: "It only contains audio, so there is no video to convert.",
      hint: "To change an audio file's format use “Audio converter”.",
    },
    cannotDecodeVideo: {
      title: "We can't read this video's codec",
      message: "Your browser doesn't include the decoder for this file's picture.",
      hint: "Try another browser (Safari understands iPhone HEVC; Chrome and Edge, H.264 and VP9) or another file.",
    },
    cannotEncode: {
      title: "Your device can't encode with these options",
      message: "The browser's encoder rejected these dimensions or this frame rate.",
      hint: "Lower the resolution or the frames per second, or try the other format.",
    },
    outOfMemory: {
      title: "Out of memory",
      message: "The browser doesn't have enough memory to finish this result. Your file is fine.",
      hint: "Try “Small” quality, a lower resolution, or a shorter video. A computer usually does better than a phone.",
    },
    cancelled: { title: "Conversion cancelled", message: "Nothing was saved." },
    failed: {
      title: "The conversion couldn't be completed",
      message: "Something failed while converting the video. Nothing was uploaded anywhere.",
      hint: "Try again; if it keeps happening, try another format or “Balanced” quality.",
    },
  },
  invalidType: {
    title: "That file isn't a video",
    message: "Choose an MP4, MOV, M4V, WebM or MKV video.",
  },
  filenameSuffix: "converted",
  summaryCopy: "{format}, {dimensions}. The video wasn't re-encoded: no quality was lost.",
  summaryTranscode: "{format}, {dimensions}, re-encoded.",
  noticesTitle: "Keep in mind",
  noticeAudioDropped: "The audio couldn't be kept: the result has no sound.",
  noticeAudioRemoved: "As you asked, the result has no audio.",
  openAudioConverter: "Open Audio converter",
};

export const STRINGS: Record<Language, VideoConverterStrings> = { es, en };

/** Rellena `{clave}` en una plantilla. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
