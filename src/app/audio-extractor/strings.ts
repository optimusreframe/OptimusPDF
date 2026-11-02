import type { Language } from "@/lib/i18n";
import type { AudioWorkStrings } from "@/lib/media/audio/ui/AudioWorkFrame";

/** Textos propios de «Extraer audio de un video». Formatos, opciones y errores: `@/lib/media/audio/ui/strings`. */

const es: AudioWorkStrings = {
  dropTitle: "Suelta tu video aquí",
  dropTitleActive: "Suelta para añadir",
  dropSubtitle: "o elígelo en tu dispositivo",
  dropButton: "Elegir un video",
  addMore: "Elegir otro video",
  limitsLine: "Acepta {formats} · hasta {max} (según el navegador)",
  localNotice: "El video no sale de tu dispositivo",
  filesTitle: "Video",
  checking: "Comprobando…",
  removeFile: "Quitar {name}",
  skipped: "No se añadió porque no es un video: {names}.",
  tooManyFiles: "Solo se puede extraer el audio de un video cada vez.",
  progress: "Extrayendo el audio",
  noneUsable: "«Procesar» se activa cuando el video tiene una pista de audio que se pueda leer.",
  doneOne: "Audio extraído del video.",
  doneMany: "{count} audios extraídos.",
  resultsTitle: "Tamaño antes y después",
  sizeChange: "{before} → {after}",
  failedTitle: "No se pudo extraer",
  fallbackName: "audio-del-video",
  suffix: "audio",
  zipName: "audios-extraidos",
  panelNote:
    "Se lee el sonido del video y se vuelve a codificar en el formato elegido; el video no se modifica. Para no perder nada de calidad, elige WAV.",
};

const en: AudioWorkStrings = {
  dropTitle: "Drop your video here",
  dropTitleActive: "Drop to add",
  dropSubtitle: "or pick it on your device",
  dropButton: "Choose a video",
  addMore: "Choose another video",
  limitsLine: "Accepts {formats} · up to {max} (depends on the browser)",
  localNotice: "The video never leaves your device",
  filesTitle: "Video",
  checking: "Checking…",
  removeFile: "Remove {name}",
  skipped: "Not added because it is not a video: {names}.",
  tooManyFiles: "Audio can be extracted from one video at a time.",
  progress: "Extracting the audio",
  noneUsable: "“Process” turns on when the video has an audio track that can be read.",
  doneOne: "Audio extracted from the video.",
  doneMany: "{count} audio files extracted.",
  resultsTitle: "Size before and after",
  sizeChange: "{before} → {after}",
  failedTitle: "Could not extract",
  fallbackName: "video-audio",
  suffix: "audio",
  zipName: "extracted-audio",
  panelNote:
    "The sound is read from the video and encoded again in the chosen format; the video itself is not changed. To lose no quality at all, pick WAV.",
};

export const STRINGS: Record<Language, AudioWorkStrings> = { es, en };
