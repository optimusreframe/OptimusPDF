/**
 * Tipos comunes del motor de audio (OptimusTOOLS · W-AUDIO).
 *
 * El audio se maneja SIEMPRE como muestras flotantes planares (`Float32Array` por canal, rango -1..1) en memoria del
 * navegador: nada se guarda en disco ni sale del dispositivo. El nombre `PcmAudio` evita chocar con el `AudioData` de
 * WebCodecs, que tambien se usa en `encode.ts` / `decode.ts`.
 */

/** Audio ya decodificado: un `Float32Array` por canal, todos de la misma longitud. */
export type PcmAudio = {
  sampleRate: number;
  channels: Float32Array[];
};

/**
 * Origen de muestras PERESOZO: quien codifica pide bloques con `read` y el origen los calcula en el momento (remezcla de
 * canales, cambio de frecuencia, ediciones del estudio...). Asi un audio largo no se copia entero en cada paso.
 */
export interface PcmSource {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /** Numero de fotogramas (muestras por canal). */
  readonly length: number;
  /** Devuelve un `Float32Array` nuevo por canal con los fotogramas `[start, end)` (se recorta a `[0, length]`). */
  read(start: number, end: number): Float32Array[];
}

/** Progreso normalizado 0..1. */
export type Progress = (value: number) => void;

export function frameCount(audio: PcmAudio): number {
  return audio.channels[0]?.length ?? 0;
}

export function durationOf(audio: PcmAudio): number {
  return audio.sampleRate > 0 ? frameCount(audio) / audio.sampleRate : 0;
}

/** Formatos que sabe crear el codificador. `mp3` no esta: ver `capabilities.ts`. */
export type OutputFormat = "wav" | "m4a" | "opus";

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["wav", "m4a", "opus"] as const;

/** Extension y tipo MIME de cada formato de salida. */
export const FORMAT_INFO: Record<OutputFormat, { extension: string; mime: string }> = {
  wav: { extension: "wav", mime: "audio/wav" },
  m4a: { extension: "m4a", mime: "audio/mp4" },
  // Opus dentro de Ogg: `.opus` es la extension oficial (RFC 7845).
  opus: { extension: "opus", mime: "audio/ogg" },
};

/** Opciones de salida elegidas por la persona. `"original"` conserva lo del audio de entrada. */
export type EncodeOptions = {
  format: OutputFormat;
  /** kbps del formato con perdida (M4A, Opus). Ignorado en WAV. */
  bitrateKbps: number;
  /** Hz o `"original"`. Opus siempre se codifica a 48 000 Hz. */
  sampleRate: number | "original";
  /** 1 mono, 2 estereo o `"original"` (maximo 2 en los formatos con perdida). */
  channels: 1 | 2 | "original";
};

export const DEFAULT_ENCODE_OPTIONS: EncodeOptions = {
  format: "wav",
  bitrateKbps: 128,
  sampleRate: "original",
  channels: "original",
};

export const BITRATES_KBPS: Record<Exclude<OutputFormat, "wav">, readonly number[]> = {
  m4a: [64, 96, 128, 160, 192, 256, 320],
  opus: [32, 48, 64, 96, 128, 160, 192, 256],
};

export const SAMPLE_RATES_HZ: readonly number[] = [48000, 44100, 32000, 22050, 16000, 8000] as const;
