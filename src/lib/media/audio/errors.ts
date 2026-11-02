/**
 * Errores del motor de audio, con codigo que la interfaz traduce (cada herramienta tiene sus textos en `strings.ts`).
 * Nunca llevan datos del archivo del usuario.
 */
export type AudioErrorCode =
  /** Ningun decodificador de este navegador entiende el formato o el codec. */
  | "unsupportedFormat"
  /** El archivo esta danado, truncado o no es de audio. */
  | "corrupt"
  /** El archivo tiene video pero ninguna pista de audio. */
  | "noAudioTrack"
  /** El archivo pesa mas de lo que se puede abrir con seguridad. */
  | "tooLarge"
  /** El audio decodificado ocuparia mas memoria de la razonable en este dispositivo. */
  | "tooLong"
  /** El archivo no tiene ningun byte (0 B) o el audio no tiene ni una muestra. */
  | "empty"
  /** Este navegador no puede crear el formato de salida elegido. */
  | "encoderUnavailable"
  /** El navegador se quedo sin memoria. */
  | "outOfMemory"
  | "cancelled"
  | "unknown";

export class AudioError extends Error {
  readonly code: AudioErrorCode;
  /** Dato tecnico opcional y SIN contenido del usuario (p. ej. el nombre del codec); nunca se muestra tal cual. */
  readonly detail?: string;

  constructor(code: AudioErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AudioError";
    this.code = code;
    this.detail = detail;
  }
}

/** Corta el trabajo si la persona ya cancelo. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AudioError("cancelled");
}

const OUT_OF_MEMORY_HINTS = ["allocation failed", "invalid array length", "out of memory", "invalid typed array length", "array buffer allocation"];

/** Convierte cualquier cosa lanzada (DOMException del navegador, RangeError de memoria...) en un `AudioError`. */
export function toAudioError(error: unknown): AudioError {
  if (error instanceof AudioError) return error;
  if (error instanceof DOMException || error instanceof Error) {
    const name = error.name;
    const text = `${name} ${error.message}`.toLowerCase();
    if (name === "AbortError") return new AudioError("cancelled");
    if (error instanceof RangeError || OUT_OF_MEMORY_HINTS.some((hint) => text.includes(hint))) {
      return new AudioError("outOfMemory");
    }
    if (name === "NotSupportedError") return new AudioError("unsupportedFormat");
    if (name === "EncodingError") return new AudioError("corrupt");
  }
  return new AudioError("unknown");
}
