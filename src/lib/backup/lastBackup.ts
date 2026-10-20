/**
 * «Último respaldo»: la fecha (ISO 8601) de la última vez que la persona exportó un paquete desde ESTE navegador. Vive en
 * `localStorage` (clave `optimuspdf.lastBackup`), no en IndexedDB, porque solo es un recordatorio: si se pierde, no se
 * pierde nada. Nunca lanza (almacenamiento bloqueado, modo privado...). Lo comparten «Mis documentos» y, cuando exista,
 * Ajustes ➜ «Respaldo y traslado».
 */
export const LAST_BACKUP_KEY = "optimuspdf.lastBackup";

/**
 * Estado del recordatorio de respaldo (U4.7: contador de cambios desde el último respaldo y «Recordármelo luego»).
 * La clave vive AQUÍ, junto a `LAST_BACKUP_KEY`, porque `markLastBackup` lo reinicia; la lógica está en `backupReminder.ts`.
 * Es de cada dispositivo y NUNCA viaja en el paquete (`SETTINGS_NEVER_EXPORTED_KEYS`).
 */
export const BACKUP_REMINDER_KEY = "optimuspdf.backupReminder";
/** Aviso a la misma pestaña de que cambió el estado de respaldo (el evento `storage` solo llega a las demás pestañas). */
export const BACKUP_STATE_EVENT = "optimuspdf:backup-state";

function announceBackupState(): void {
  try {
    window.dispatchEvent(new Event(BACKUP_STATE_EVENT));
  } catch {
    // Sin ventana: nadie a quien avisar.
  }
}

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

/**
 * Anota que se acaba de exportar un respaldo. Devuelve si se pudo guardar. Reinicia el recordatorio (contador de cambios y
 * «Recordármelo luego»): lo que había hasta ahora ya está en el respaldo.
 */
export function markLastBackup(at: Date = new Date()): boolean {
  try {
    window.localStorage.setItem(LAST_BACKUP_KEY, at.toISOString());
  } catch {
    return false;
  }
  try {
    window.localStorage.removeItem(BACKUP_REMINDER_KEY);
  } catch {
    // El recordatorio es prescindible: lo importante (la fecha) ya está guardado.
  }
  announceBackupState();
  return true;
}

/** Días completos desde `at` hasta `now` (0 si es hoy o está en el futuro). */
export function daysSince(at: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
}
