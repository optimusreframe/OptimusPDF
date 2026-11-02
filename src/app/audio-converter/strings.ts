import type { Language } from "@/lib/i18n";
import type { AudioWorkStrings } from "@/lib/media/audio/ui/AudioWorkFrame";

/** Textos propios de «Convertidor de audio». Formatos, opciones y errores: `@/lib/media/audio/ui/strings`. */

const es: AudioWorkStrings = {
  dropTitle: "Suelta tus audios aquí",
  dropTitleActive: "Suelta para añadir",
  dropSubtitle: "o elígelos en tu dispositivo",
  dropButton: "Elegir audios",
  addMore: "Añadir más audios",
  limitsLine: "Acepta {formats} · hasta {max} por archivo (según el navegador)",
  localNotice: "Todo ocurre en tu dispositivo",
  filesTitle: "Audios",
  checking: "Comprobando…",
  removeFile: "Quitar {name}",
  skipped: "No se añadieron porque no son audio: {names}.",
  tooManyFiles: "Se pueden convertir {max} archivos a la vez: el resto no se añadió.",
  progress: "Convirtiendo el audio",
  noneUsable: "«Procesar» se activa cuando hay al menos un audio que se pueda convertir.",
  doneOne: "1 audio convertido.",
  doneMany: "{count} audios convertidos y reunidos en un ZIP.",
  resultsTitle: "Tamaño antes y después",
  sizeChange: "{before} → {after}",
  failedTitle: "No se pudo convertir",
  fallbackName: "audio",
  suffix: "convertido",
  zipName: "audios-convertidos",
};

const en: AudioWorkStrings = {
  dropTitle: "Drop your audio files here",
  dropTitleActive: "Drop to add",
  dropSubtitle: "or pick them on your device",
  dropButton: "Choose audio files",
  addMore: "Add more audio files",
  limitsLine: "Accepts {formats} · up to {max} per file (depends on the browser)",
  localNotice: "Everything happens on your device",
  filesTitle: "Audio files",
  checking: "Checking…",
  removeFile: "Remove {name}",
  skipped: "Not added because they are not audio: {names}.",
  tooManyFiles: "{max} files can be converted at once: the rest were not added.",
  progress: "Converting the audio",
  noneUsable: "“Process” turns on when at least one audio file can be converted.",
  doneOne: "1 audio file converted.",
  doneMany: "{count} audio files converted and gathered in a ZIP.",
  resultsTitle: "Size before and after",
  sizeChange: "{before} → {after}",
  failedTitle: "Could not convert",
  fallbackName: "audio",
  suffix: "converted",
  zipName: "converted-audio",
};

export const STRINGS: Record<Language, AudioWorkStrings> = { es, en };
