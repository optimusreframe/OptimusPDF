/**
 * «Último respaldo»: la fecha (ISO 8601) de la última vez que la persona exportó un paquete desde ESTE navegador. Vive en
 * `localStorage` (clave `optimuspdf.lastBackup`), no en IndexedDB, porque solo es un recordatorio: si se pierde, no se
 * pierde nada. Nunca lanza (almacenamiento bloqueado, modo privado...). Lo comparten «Mis documentos» y, cuando exista,
 * Ajustes ➜ «Respaldo y traslado».
 */
export const LAST_BACKUP_KEY = "optimuspdf.lastBackup";

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

/** La fecha del último respaldo, o `null` si nunca se hizo (o el valor guardado no es una fecha). */
export function readLastBackup(): Date | null {
  try {
    const raw = window.localStorage.getItem(LAST_BACKUP_KEY);
    return isIso(raw) ? new Date(raw) : null;
  } catch {
    return null;
  }
}

/** Anota que se acaba de exportar un respaldo. Devuelve si se pudo guardar. */
export function markLastBackup(at: Date = new Date()): boolean {
  try {
    window.localStorage.setItem(LAST_BACKUP_KEY, at.toISOString());
    return true;
  } catch {
    return false;
  }
}

/** Días completos desde `at` hasta `now` (0 si es hoy o está en el futuro). */
export function daysSince(at: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
}
