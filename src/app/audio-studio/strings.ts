import type { Language } from "@/lib/i18n";

/** Textos propios de Audio Studio. Formatos, opciones de exportacion y errores: `@/lib/media/audio/ui/strings`. */
export type StudioStrings = {
  // Importar
  dropTitle: string;
  dropTitleActive: string;
  dropSubtitle: string;
  dropButton: string;
  addMore: string;
  /** `{formats}` y `{max}`. */
  limitsLine: string;
  localNotice: string;
  skipped: string;
  tooManyClips: string;
  memoryFull: string;
  importFailed: string;
  conformed: string;
  mono: string;
  stereo: string;
  importedOne: string;
  importedMany: string;
  opening: string;
  cancelImport: string;
  emptyTrack: string;
  // Transporte
  transportTitle: string;
  play: string;
  pause: string;
  positionLabel: string;
  undo: string;
  redo: string;
  undone: string;
  redone: string;
  // Onda y seleccion
  waveTitle: string;
  waveformLabel: string;
  waveHelp: string;
  summaryCursor: string;
  summarySelection: string;
  selectionTitle: string;
  selectionStart: string;
  selectionEnd: string;
  markStart: string;
  markEnd: string;
  selectAll: string;
  deselect: string;
  selectedAll: string;
  selectionAnnounce: string;
  selectionCleared: string;
  // Edicion
  editTitle: string;
  trim: string;
  cut: string;
  split: string;
  needSelection: string;
  fadeTitle: string;
  fadeDuration: string;
  fadeIn: string;
  fadeOut: string;
  fadeHint: string;
  volumeTitle: string;
  volumeLabel: string;
  volumeApply: string;
  volumeHint: string;
  normalize: string;
  normalizing: string;
  normalizeSilent: string;
  doneTrim: string;
  doneCut: string;
  doneSplit: string;
  doneFadeIn: string;
  doneFadeOut: string;
  doneVolume: string;
  doneNormalize: string;
  doneMoveClip: string;
  doneRemoveClip: string;
  // Clips
  clipsTitle: string;
  clipsHint: string;
  moveUp: string;
  moveDown: string;
  removeClip: string;
  clipOf: string;
  // Exportar
  exportTitle: string;
  exportButton: string;
  exporting: string;
  exportDone: string;
  fallbackName: string;
  suffix: string;
};

const es: StudioStrings = {
  dropTitle: "Suelta uno o más audios aquí",
  dropTitleActive: "Suelta para añadir",
  dropSubtitle: "Si eliges varios, se unirán en el orden en que los elijas.",
  dropButton: "Elegir audios",
  addMore: "Añadir otro audio al final",
  limitsLine: "Acepta {formats} · hasta {max} por archivo (según el navegador)",
  localNotice: "Todo ocurre en tu dispositivo",
  skipped: "No se añadieron porque no son audio: {names}.",
  tooManyClips: "Se pueden unir hasta {max} audios: el resto no se añadió.",
  memoryFull: "No se añadió {name}: no cabe más audio en la memoria de este dispositivo (caben unos {minutes} minutos en estéreo). Exporta lo que tienes o quita algún clip.",
  importFailed: "No se pudo abrir {name}: {reason}",
  conformed: "Los audios se ajustaron a la frecuencia y los canales del primero ({rate} kHz, {channels}).",
  mono: "mono",
  stereo: "estéreo",
  importedOne: "1 audio añadido.",
  importedMany: "{count} audios añadidos.",
  opening: "Abriendo {name} ({index} de {total})…",
  cancelImport: "Cancelar",
  emptyTrack: "No queda ningún audio en la pista.",
  transportTitle: "Reproducción",
  play: "Reproducir",
  pause: "Pausa",
  positionLabel: "Posición",
  undo: "Deshacer",
  redo: "Rehacer",
  undone: "Cambio deshecho.",
  redone: "Cambio rehecho.",
  waveTitle: "Forma de onda",
  waveformLabel: "Forma de onda del audio. Flechas: mover el cursor. Mayús con flechas: seleccionar. Espacio: reproducir o pausar.",
  waveHelp: "Arrastra sobre la onda para seleccionar un tramo. Con teclado: ← → mueven el cursor 0,1 s (con Ctrl, 1 s), Mayús + ← → seleccionan, Espacio reproduce y Esc quita la selección.",
  summaryCursor: "Duración {duration}. Cursor en {cursor}. Sin selección.",
  summarySelection: "Duración {duration}. Selección de {start} a {end} ({length}).",
  selectionTitle: "Selección",
  selectionStart: "Inicio (segundos)",
  selectionEnd: "Fin (segundos)",
  markStart: "Inicio en el cursor",
  markEnd: "Fin en el cursor",
  selectAll: "Seleccionar todo",
  deselect: "Quitar la marca",
  selectedAll: "Todo el audio seleccionado.",
  selectionAnnounce: "Selección de {start} a {end}.",
  selectionCleared: "Selección quitada.",
  editTitle: "Editar",
  trim: "Recortar a la selección",
  cut: "Quitar la selección",
  split: "Dividir en el cursor",
  needSelection: "Para recortar o quitar un tramo, selecciónalo primero en la onda o con los campos de inicio y fin.",
  fadeTitle: "Fundidos",
  fadeDuration: "Duración (segundos)",
  fadeIn: "Fundido de entrada",
  fadeOut: "Fundido de salida",
  fadeHint: "Con una selección, el fundido ocupa toda la selección. Sin ella, afecta a los primeros (entrada) o últimos (salida) segundos indicados.",
  volumeTitle: "Volumen",
  volumeLabel: "Cambio de volumen",
  volumeApply: "Aplicar volumen",
  volumeHint: "Se aplica a la selección o, si no hay, a todo el audio. «Normalizar» deja el punto más fuerte en −1 dB.",
  normalize: "Normalizar",
  normalizing: "Midiendo el volumen…",
  normalizeSilent: "No hay sonido que normalizar en ese tramo.",
  doneTrim: "Recortado. Ahora dura {duration}.",
  doneCut: "Tramo quitado. Ahora dura {duration}.",
  doneSplit: "Dividido en {time}.",
  doneFadeIn: "Fundido de entrada aplicado.",
  doneFadeOut: "Fundido de salida aplicado.",
  doneVolume: "Volumen cambiado {db} dB.",
  doneNormalize: "Volumen normalizado.",
  doneMoveClip: "Clip movido del puesto {from} al {to}.",
  doneRemoveClip: "Clip «{name}» quitado.",
  clipsTitle: "Clips, en orden",
  clipsHint: "Suenan y se exportan en este orden. «Dividir en el cursor» crea clips nuevos que puedes reordenar o quitar.",
  moveUp: "Subir el clip {index}: {name}",
  moveDown: "Bajar el clip {index}: {name}",
  removeClip: "Quitar el clip {index}: {name}",
  clipOf: "Clip {index} de {total}",
  exportTitle: "Exportar",
  exportButton: "Exportar audio",
  exporting: "Exportando el audio",
  exportDone: "Listo: {name} ({size}, {duration}).",
  fallbackName: "audio",
  suffix: "editado",
};

const en: StudioStrings = {
  dropTitle: "Drop one or more audio files here",
  dropTitleActive: "Drop to add",
  dropSubtitle: "If you pick several, they are joined in the order you pick them.",
  dropButton: "Choose audio files",
  addMore: "Add another audio at the end",
  limitsLine: "Accepts {formats} · up to {max} per file (depends on the browser)",
  localNotice: "Everything happens on your device",
  skipped: "Not added because they are not audio: {names}.",
  tooManyClips: "Up to {max} audio files can be joined: the rest were not added.",
  memoryFull: "{name} was not added: there is no more room for audio in this device's memory (about {minutes} minutes of stereo fit). Export what you have or remove a clip.",
  importFailed: "Could not open {name}: {reason}",
  conformed: "The audio files were adjusted to the sample rate and channels of the first one ({rate} kHz, {channels}).",
  mono: "mono",
  stereo: "stereo",
  importedOne: "1 audio file added.",
  importedMany: "{count} audio files added.",
  opening: "Opening {name} ({index} of {total})…",
  cancelImport: "Cancel",
  emptyTrack: "No audio is left in the track.",
  transportTitle: "Playback",
  play: "Play",
  pause: "Pause",
  positionLabel: "Position",
  undo: "Undo",
  redo: "Redo",
  undone: "Change undone.",
  redone: "Change redone.",
  waveTitle: "Waveform",
  waveformLabel: "Audio waveform. Arrow keys: move the cursor. Shift with arrows: select. Space: play or pause.",
  waveHelp: "Drag across the waveform to select a part. With the keyboard: ← → move the cursor 0.1 s (with Ctrl, 1 s), Shift + ← → select, Space plays and Esc clears the selection.",
  summaryCursor: "Duration {duration}. Cursor at {cursor}. No selection.",
  summarySelection: "Duration {duration}. Selection from {start} to {end} ({length}).",
  selectionTitle: "Selection",
  selectionStart: "Start (seconds)",
  selectionEnd: "End (seconds)",
  markStart: "Start at the cursor",
  markEnd: "End at the cursor",
  selectAll: "Select all",
  deselect: "Clear the selection",
  selectedAll: "All the audio is selected.",
  selectionAnnounce: "Selection from {start} to {end}.",
  selectionCleared: "Selection cleared.",
  editTitle: "Edit",
  trim: "Trim to selection",
  cut: "Remove selection",
  split: "Split at the cursor",
  needSelection: "To trim or remove a part, select it first on the waveform or with the start and end fields.",
  fadeTitle: "Fades",
  fadeDuration: "Length (seconds)",
  fadeIn: "Fade in",
  fadeOut: "Fade out",
  fadeHint: "With a selection, the fade covers the whole selection. Without one, it affects the first (in) or last (out) seconds given.",
  volumeTitle: "Volume",
  volumeLabel: "Volume change",
  volumeApply: "Apply volume",
  volumeHint: "Applies to the selection or, if there is none, to all the audio. “Normalize” sets the loudest point to −1 dB.",
  normalize: "Normalize",
  normalizing: "Measuring the volume…",
  normalizeSilent: "There is no sound to normalize in that part.",
  doneTrim: "Trimmed. It now lasts {duration}.",
  doneCut: "Part removed. It now lasts {duration}.",
  doneSplit: "Split at {time}.",
  doneFadeIn: "Fade in applied.",
  doneFadeOut: "Fade out applied.",
  doneVolume: "Volume changed {db} dB.",
  doneNormalize: "Volume normalized.",
  doneMoveClip: "Clip moved from position {from} to {to}.",
  doneRemoveClip: "Clip “{name}” removed.",
  clipsTitle: "Clips, in order",
  clipsHint: "They play and export in this order. “Split at the cursor” creates new clips you can reorder or remove.",
  moveUp: "Move up clip {index}: {name}",
  moveDown: "Move down clip {index}: {name}",
  removeClip: "Remove clip {index}: {name}",
  clipOf: "Clip {index} of {total}",
  exportTitle: "Export",
  exportButton: "Export audio",
  exporting: "Exporting the audio",
  exportDone: "Done: {name} ({size}, {duration}).",
  fallbackName: "audio",
  suffix: "edited",
};

export const STRINGS: Record<Language, StudioStrings> = { es, en };
