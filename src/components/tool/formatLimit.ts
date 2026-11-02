/**
 * Un tope (de peso) dicho a una persona: «64 MB», «4 GB», «100 MB». Es un numero redondo, asi que no lleva el «,0» que da
 * `formatFileSize` (pensado para pesos reales: «64,0 MB» parecia una medida). El numero y la unidad van unidos por un espacio
 * duro (U+00A0): sin el, «4,0 / GB» se partia en dos lineas en una pantalla de 320 px.
 */
export function formatLimit(bytes: number, locale = "es-ES"): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 KB`;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}
