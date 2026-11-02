import type { Language } from "@/lib/i18n";
import type { AudioErrorCode } from "@/lib/media/audio/errors";
import type { UnavailableReason } from "@/lib/media/audio/capabilities";
import type { OutputFormat } from "@/lib/media/audio/types";

/**
 * Textos compartidos por las tres herramientas de audio (formatos, opciones, errores). Cada herramienta tiene ademas su
 * propio `strings.ts` con lo que solo le toca a ella.
 */

export type AudioErrorText = { message: string; hint?: string };

export type SharedAudioStrings = {
  formatLabel: string;
  formatNames: Record<OutputFormat | "mp3", string>;
  formatHints: Record<OutputFormat | "mp3", string>;
  /** «Pronto»/«No disponible» junto a un formato que este navegador no puede crear. */
  unavailableBadge: string;
  checkingFormats: string;
  unavailable: Record<UnavailableReason, string>;
  bitrateLabel: string;
  /** `{n}` kbps. */
  bitrateOption: string;
  sampleRateLabel: string;
  sampleRateOriginal: string;
  /** `{n}` kHz. */
  sampleRateOption: string;
  opusRateNote: string;
  lossyNote: string;
  channelsLabel: string;
  channelsOriginal: string;
  channelsMono: string;
  channelsStereo: string;
  errorTitle: string;
  fileProblemTitle: string;
  errors: Record<AudioErrorCode, AudioErrorText>;
  privacyNote: string;
};

const es: SharedAudioStrings = {
  formatLabel: "Formato de salida",
  formatNames: { wav: "WAV", m4a: "M4A (AAC)", opus: "Opus", mp3: "MP3" },
  formatHints: {
    wav: "Sin pérdida de calidad. Pesa mucho.",
    m4a: "Se abre en casi todo: iPhone, Android y ordenador.",
    opus: "Muy compacto y de gran calidad. Para navegadores, Android y apps modernas.",
    mp3: "Muy extendido, pero aquí no lo creamos (motivo debajo).",
  },
  unavailableBadge: "No disponible",
  checkingFormats: "Comprobando qué formatos admite tu navegador…",
  unavailable: {
    license:
      "No creamos MP3: los codificadores de MP3 que funcionan en el navegador usan una licencia (LGPL) que no podemos empaquetar en esta aplicación, y el navegador no trae uno propio. Elige M4A, que se abre en todo, o WAV.",
    noWebCodecs: "Tu navegador no puede crear este formato (le falta WebCodecs). Prueba con una versión reciente de Chrome, Edge o Safari, o elige WAV.",
    codecUnsupported: "Tu navegador no sabe crear este formato en este dispositivo. Elige otro, por ejemplo WAV.",
  },
  bitrateLabel: "Calidad (tasa de bits)",
  bitrateOption: "{n} kbps",
  sampleRateLabel: "Frecuencia de muestreo",
  sampleRateOriginal: "La del original",
  sampleRateOption: "{n} kHz",
  opusRateNote: "Opus siempre se crea a 48 kHz.",
  lossyNote: "Los formatos M4A y Opus comprimen con una pequeña pérdida; WAV no pierde nada.",
  channelsLabel: "Canales",
  channelsOriginal: "Igual que el original",
  channelsMono: "Mono",
  channelsStereo: "Estéreo",
  errorTitle: "No se pudo completar",
  fileProblemTitle: "No se puede usar este archivo",
  errors: {
    unsupportedFormat: {
      message: "Este navegador no puede leer este archivo: está dañado o usa un formato o códec que no soporta.",
      hint: "Prueba con otro navegador (Chrome, Edge o Safari reciente) o con otro archivo.",
    },
    corrupt: { message: "No parece un archivo de audio o de video válido, o está dañado.", hint: "Elige otro archivo." },
    noAudioTrack: { message: "Este video no tiene pista de audio: no hay nada que extraer.", hint: "Elige un video con sonido." },
    tooLarge: { message: "El archivo es demasiado grande para abrirlo con seguridad en este dispositivo.", hint: "Elige un archivo más pequeño." },
    tooLong: {
      message: "Este audio es demasiado largo para tratarlo en la memoria de este dispositivo (caben unos {minutes} minutos en estéreo).",
      hint: "Córtalo antes o prueba en un ordenador con más memoria.",
    },
    empty: { message: "El archivo está vacío.", hint: "Elige otro archivo." },
    encoderUnavailable: { message: "Tu navegador no puede crear el formato elegido.", hint: "Elige otro formato, por ejemplo WAV." },
    outOfMemory: { message: "El navegador se quedó sin memoria.", hint: "Cierra otras pestañas o prueba con un archivo más corto." },
    cancelled: { message: "Proceso cancelado." },
    unknown: { message: "Algo ha fallado durante el proceso.", hint: "Vuelve a intentarlo; si se repite, prueba con otro archivo." },
  },
  privacyNote: "Tu audio se queda en este dispositivo: no se envía ni se guarda en ningún sitio.",
};

const en: SharedAudioStrings = {
  formatLabel: "Output format",
  formatNames: { wav: "WAV", m4a: "M4A (AAC)", opus: "Opus", mp3: "MP3" },
  formatHints: {
    wav: "No quality loss. Large files.",
    m4a: "Opens almost everywhere: iPhone, Android and computers.",
    opus: "Very compact and high quality. For browsers, Android and modern apps.",
    mp3: "Very common, but we do not create it here (reason below).",
  },
  unavailableBadge: "Not available",
  checkingFormats: "Checking which formats your browser supports…",
  unavailable: {
    license:
      "We do not create MP3: the MP3 encoders that run in a browser use a licence (LGPL) we cannot bundle into this app, and the browser has none of its own. Pick M4A, which opens everywhere, or WAV.",
    noWebCodecs: "Your browser cannot create this format (WebCodecs is missing). Try a recent Chrome, Edge or Safari, or pick WAV.",
    codecUnsupported: "Your browser cannot create this format on this device. Pick another one, for example WAV.",
  },
  bitrateLabel: "Quality (bitrate)",
  bitrateOption: "{n} kbps",
  sampleRateLabel: "Sample rate",
  sampleRateOriginal: "Same as the original",
  sampleRateOption: "{n} kHz",
  opusRateNote: "Opus is always created at 48 kHz.",
  lossyNote: "M4A and Opus compress with a small loss; WAV loses nothing.",
  channelsLabel: "Channels",
  channelsOriginal: "Same as the original",
  channelsMono: "Mono",
  channelsStereo: "Stereo",
  errorTitle: "Could not finish",
  fileProblemTitle: "This file cannot be used",
  errors: {
    unsupportedFormat: {
      message: "This browser cannot read this file: it is damaged or uses a format or codec it does not support.",
      hint: "Try another browser (Chrome, Edge or a recent Safari) or another file.",
    },
    corrupt: { message: "This does not look like a valid audio or video file, or it is damaged.", hint: "Pick another file." },
    noAudioTrack: { message: "This video has no audio track: there is nothing to extract.", hint: "Pick a video with sound." },
    tooLarge: { message: "The file is too large to open safely on this device.", hint: "Pick a smaller file." },
    tooLong: {
      message: "This audio is too long for this device's memory (about {minutes} minutes of stereo fit).",
      hint: "Trim it first or try on a computer with more memory.",
    },
    empty: { message: "The file is empty.", hint: "Pick another file." },
    encoderUnavailable: { message: "Your browser cannot create the chosen format.", hint: "Pick another format, for example WAV." },
    outOfMemory: { message: "The browser ran out of memory.", hint: "Close other tabs or try a shorter file." },
    cancelled: { message: "Process cancelled." },
    unknown: { message: "Something went wrong.", hint: "Try again; if it keeps happening, try another file." },
  },
  privacyNote: "Your audio stays on this device: it is not sent or stored anywhere.",
};

export const SHARED_STRINGS: Record<Language, SharedAudioStrings> = { es, en };

/** Texto del error con sus huecos (`{minutes}`) rellenos. */
export function describeAudioError(strings: SharedAudioStrings, code: AudioErrorCode, detail?: string): AudioErrorText {
  const entry = strings.errors[code] ?? strings.errors.unknown;
  const fill = (text: string | undefined) => text?.replace("{minutes}", detail && /^\d+$/.test(detail) ? detail : "—");
  return { message: fill(entry.message) as string, hint: fill(entry.hint) };
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
