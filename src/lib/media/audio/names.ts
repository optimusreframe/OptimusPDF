import { uniqueZipName } from "@/lib/pdf/entryNames";
import { FORMAT_INFO, type OutputFormat } from "@/lib/media/audio/types";

/**
 * Nombres de los archivos de salida. Solo el nombre que ya trae el archivo del usuario: nunca se inventan datos.
 */

/** `informe.pdf` -> `informe`. Sin extension no cambia nada (no se importa `pdf/core` para no arrastrar pdf-lib). */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Caracteres que no valen en un nombre de archivo (Windows) y controles. */
const UNSAFE = new RegExp("[\\\\/:*?\"<>|\\u0000-\\u001f]", "g");

export function safeBaseName(filename: string, fallback: string): string {
  const base = stripExtension(filename).replace(UNSAFE, "-").trim().replace(/^\.+/, "");
  return (base.length > 0 ? base : fallback).slice(0, 120);
}

/**
 * `cancion.mp3` -> `cancion.wav`. Si el formato de salida coincide con la extension de entrada se anade el sufijo
 * (`cancion-convertido.wav`) para no confundirlo con el original.
 */
export function outputName(filename: string, format: OutputFormat, suffix: string, fallback: string): string {
  const extension = FORMAT_INFO[format].extension;
  const base = safeBaseName(filename, fallback);
  const input = filename.toLowerCase();
  const sameFormat = input.endsWith(`.${extension}`) || (format === "opus" && input.endsWith(".ogg")) || (format === "m4a" && input.endsWith(".mp4"));
  return sameFormat ? `${base}-${suffix}.${extension}` : `${base}.${extension}`;
}

export { uniqueZipName };

/** Nombre de lo exportado desde el estudio: `grabacion.mp3` -> `grabacion-editado.wav` (siempre con sufijo). */
export function editedName(firstClipName: string, format: OutputFormat, suffix: string, fallback: string): string {
  return `${safeBaseName(firstClipName, fallback)}-${suffix}.${FORMAT_INFO[format].extension}`;
}
