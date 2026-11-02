/**
 * Limites de tamaño y memoria del audio (OptimusTOOLS · W-AUDIO).
 *
 * Todo el trabajo ocurre en la memoria de la pestana: un audio decodificado ocupa `segundos x Hz x canales x 4` bytes
 * (flotante de 32 bits). Una hora estereo a 44,1 kHz son ~1,3 GB, mas de lo que aguanta una pestana de movil, asi que se
 * avisa ANTES de decodificar (cuando se conoce la duracion) y con un mensaje que dice cuanto cabe, en vez de colgar la
 * pestana.
 */

const MiB = 1024 * 1024;

/** Archivo de audio que se lee entero a memoria para decodificarlo con el navegador. */
export const MAX_AUDIO_FILE_BYTES = 300 * MiB;
/**
 * Video del que solo se lee la pista de audio por trozos (sin cargarlo entero). Con el decodificador del navegador
 * (que exige leerlo entero) el tope es `MAX_DIRECT_DECODE_BYTES`.
 */
export const MAX_VIDEO_FILE_BYTES = 2048 * MiB;
/** Mayor archivo que se entrega entero a `decodeAudioData` (contenedor con video incluido). */
export const MAX_DIRECT_DECODE_BYTES = 200 * MiB;

/** Memoria maxima de audio decodificado en un dispositivo normal / uno con poca memoria (movil, tablet). */
export const DECODED_BUDGET_BYTES = 1024 * MiB;
export const DECODED_BUDGET_LOW_MEMORY_BYTES = 384 * MiB;

/** WAV de 16 bits: el RIFF guarda tamanos de 32 bits, asi que ~4 GiB es el techo real. */
export const MAX_WAV_BYTES = 4096 * MiB - 1024 * 1024;

/** Archivos por lote y bytes de salida acumulados en un ZIP. */
export const MAX_BATCH_FILES = 50;
export const MAX_BATCH_OUTPUT_BYTES = 800 * MiB;

/** Clips que se pueden unir en el estudio. */
export const MAX_STUDIO_CLIPS = 40;

type NavigatorWithMemory = Navigator & { deviceMemory?: number };

/** Dispositivo con poca memoria: lo declara `deviceMemory` (Chromium) o es un iPhone/iPad (Safari no lo declara). */
export function isLowMemoryDevice(nav: NavigatorWithMemory | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!nav) return false;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4) return true;
  const ua = nav.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS se presenta como Mac con pantalla tactil.
  return /Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export function decodedBudgetBytes(): number {
  return isLowMemoryDevice() ? DECODED_BUDGET_LOW_MEMORY_BYTES : DECODED_BUDGET_BYTES;
}

/** Bytes que ocupa un audio decodificado (flotante de 32 bits). */
export function decodedBytes(durationSec: number, sampleRate: number, channels: number): number {
  return Math.ceil(durationSec * sampleRate * channels * 4);
}

/** Minutos de audio estereo a 44,1 kHz que caben en `budget` bytes (para el mensaje al usuario). */
export function minutesThatFit(budget: number = decodedBudgetBytes()): number {
  return Math.max(1, Math.floor(budget / (44100 * 2 * 4 * 60)));
}
