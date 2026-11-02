/**
 * Errores del convertidor, con un codigo que la pagina traduce a un mensaje honesto (nunca el texto crudo de una libreria).
 * `classifyVideoError` convierte lo que lance el motor (libreria de contenedores, WebCodecs, el propio navegador) en uno de
 * estos codigos mirando `name`/`message`; lo que no reconoce es `failed`, un fallo del que no se sabe mas.
 */

export type VideoErrorCode =
  /** El archivo no es un video que se pueda leer (formato desconocido, vacio, truncado, danado). */
  | "unreadable"
  /** Es un contenedor valido pero sin pista de video (un audio, por ejemplo). */
  | "noVideoTrack"
  /** El navegador no sabe decodificar el codec del video. */
  | "cannotDecodeVideo"
  /** El codificador rechazo la configuracion (medidas o ritmo que este equipo no soporta). */
  | "cannotEncode"
  /** El navegador se quedo sin memoria. */
  | "outOfMemory"
  | "cancelled"
  | "failed";

export class VideoError extends Error {
  readonly code: VideoErrorCode;

  constructor(code: VideoErrorCode, message?: string) {
    super(message ?? code);
    this.name = "VideoError";
    this.code = code;
  }
}

const OUT_OF_MEMORY = ["allocation failed", "out of memory", "invalid array length", "invalid typed array length", "array buffer allocation", "quotaexceeded"];
const UNREADABLE = ["unsupported or unrecognizable", "unsupportedinputformat", "unexpected end", "invalid data", "corrupt", "not a valid", "failed to parse", "reached the end"];
const ENCODE = ["encoder", "encodingerror", "notsupportederror", "configure", "no_encodable_target_codec"];

export function classifyVideoError(error: unknown): VideoError {
  if (error instanceof VideoError) return error;
  const name = error instanceof Error || (typeof error === "object" && error !== null && "name" in error) ? String((error as { name?: unknown }).name) : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = `${name} ${message}`.toLowerCase();
  if (name === "AbortError" || name === "ConversionCanceledError" || text.includes("canceled") || text.includes("cancelled")) {
    return new VideoError("cancelled", message);
  }
  if (OUT_OF_MEMORY.some((hint) => text.includes(hint))) return new VideoError("outOfMemory", message);
  if (UNREADABLE.some((hint) => text.includes(hint))) return new VideoError("unreadable", message);
  if (ENCODE.some((hint) => text.includes(hint))) return new VideoError("cannotEncode", message);
  return new VideoError("failed", message);
}
