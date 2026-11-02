/**
 * Formato de numeros y tiempos para la interfaz de audio. Sin dependencias del resto de la aplicacion.
 */

export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** `75.4` -> `1:15.40` (minutos:segundos.centesimas); con horas, `1:02:03.40`. */
export function formatClock(seconds: number, withCentis = true): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalCentis = Math.round(safe * 100);
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return withCentis ? `${body}.${String(centis).padStart(2, "0")}` : body;
}

/** Duracion legible para un texto: `1 h 02 min`, `3 min 05 s`, `12,5 s`. */
export function formatDuration(seconds: number, locale: string): string {
  const safe = Math.max(0, seconds);
  if (safe < 60) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(safe)} s`;
  const total = Math.round(safe);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min ${String(s).padStart(2, "0")} s`;
}

/** Entrega un archivo al usuario (descarga local, sin red). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
