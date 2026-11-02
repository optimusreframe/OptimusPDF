import { FORMAT_INFO, type OutputFormat } from "@/lib/media/video/formats";

/** Caracteres que ningun sistema de archivos admite en un nombre (y los de control). */
const FORBIDDEN = new RegExp("[\\\\/:*?\"<>|\\u0000-\\u001f]", "g");

/** `Vacaciones 2024.MOV` -> `Vacaciones 2024` (solo quita una extension de verdad: 1-5 letras o cifras tras el ultimo punto). */
export function stripVideoExtension(name: string): string {
  const match = /^(.*)\.[A-Za-z0-9]{1,5}$/.exec(name.trim());
  return match ? match[1] : name.trim();
}

/**
 * Nombre del resultado: `<nombre original>-<sufijo>.<extension del formato>`. El sufijo evita pisar el original cuando se
 * convierte un MP4 a MP4 con otra calidad.
 */
export function outputFileName(inputName: string, format: OutputFormat, suffix: string, fallbackBase = "video"): string {
  const base = stripVideoExtension(inputName).replace(FORBIDDEN, "-").replace(/\s+/g, " ").replace(/^\.+/, "").trim() || fallbackBase;
  const tail = suffix.trim() ? `-${suffix.trim()}` : "";
  return `${base}${tail}.${FORMAT_INFO[format].extension}`;
}
