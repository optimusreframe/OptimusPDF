import {
  BACKUP_STATE_EVENT,
  MAX_REMINDER_CHANGES,
  REMINDER_PARTS,
  backupCoverageDate,
  daysSince,
  readLastBackupParts,
  readReminderState,
  writeReminderState,
  type ReminderState,
} from "@/lib/backup/lastBackup";

export { readReminderState, type ReminderState };

/**
 * Recordatorio de respaldo (U4.7, `docs/PLAN-FIRMA-AGIL.md` §9.3): avisa, sin insistir, cuando pasaron 30 días o 10 cambios
 * relevantes desde el último respaldo (mitiga la regla de Safari que puede borrar los datos de un sitio tras 7 días sin uso).
 *
 * El estado vive en UNA clave de `localStorage` (`optimuspdf.backupReminder`) y NO lleva datos personales: solo cuántas
 * altas/ediciones hubo (un número), desde cuándo se cuentan y hasta cuándo se pospuso el aviso. «Cambio relevante» = alta,
 * edición o borrado de una firma, un documento o una plantilla; usar una firma ya guardada no cuenta. Nunca lanza.
 */

export const REMINDER_AFTER_DAYS = 30;
export const REMINDER_AFTER_CHANGES = 10;
export const SNOOZE_DAYS = 7;
const DAY_MS = 86_400_000;

function announce(): void {
  try {
    window.dispatchEvent(new Event(BACKUP_STATE_EVENT));
  } catch {
    // Sin ventana: nadie a quien avisar.
  }
}

/**
 * Cuenta UN cambio relevante (alta o edición de una firma, un documento o una plantilla). Barato: una lectura y una
 * escritura de una clave diminuta. Si nunca hubo un respaldo, el primer cambio fija el comienzo de los 30 días.
 */
export function noteBackupRelevantChange(now: Date = new Date(), part?: (typeof REMINDER_PARTS)[number]): void {
  const state = readReminderState();
  const by = { ...(state.by ?? {}) };
  if (part !== undefined) by[part] = Math.min((by[part] ?? 0) + 1, MAX_REMINDER_CHANGES);
  const next: ReminderState = {
    changes: Math.min(state.changes + 1, MAX_REMINDER_CHANGES),
    ...(Object.keys(by).length > 0 ? { by } : {}),
    since: state.since ?? now.toISOString(),
    ...(state.snoozeUntil ? { snoozeUntil: state.snoozeUntil } : {}),
  };
  if (writeReminderState(next)) announce();
}

/**
 * Quien ya tenía datos antes de existir el contador (y nunca respaldó) no tiene ancla para los 30 días: la primera vez que
 * se mira el recordatorio se fija «desde hoy». No cuenta cambios ni avisa a nadie.
 */
export function startReminderClock(now: Date = new Date()): void {
  if (backupCoverageDate() !== null) return;
  const state = readReminderState();
  if (state.since !== undefined) return;
  writeReminderState({ ...state, since: now.toISOString() });
}

/** «Recordármelo luego»: no vuelve a avisar hasta dentro de 7 días. Devuelve si se pudo guardar. */
export function snoozeBackupReminder(now: Date = new Date()): boolean {
  const state = readReminderState();
  const ok = writeReminderState({ ...state, snoozeUntil: new Date(now.getTime() + SNOOZE_DAYS * DAY_MS).toISOString() });
  if (ok) announce();
  return ok;
}

export type ReminderReason = "days" | "changes";

export type ReminderStatus = {
  /** Hay que avisar (falta confirmar que existen datos que respaldar: `hasBackupData`). */
  due: boolean;
  reason: ReminderReason | null;
  /** Días desde el último respaldo (o, si nunca hubo, desde el primer cambio contado); `null` si no hay ancla. */
  days: number | null;
  changes: number;
  snoozed: boolean;
  lastBackup: Date | null;
  /** Nunca hubo un respaldo completo, pero sí alguno parcial (solo de algunas partes): el aviso no dice «ningún respaldo». */
  partialBackups?: boolean;
};

/** Función pura sobre el estado: ¿toca avisar ahora? (La interfaz además comprueba que haya algo que respaldar.) */
export function reminderStatusFrom(state: ReminderState, lastBackup: Date | null, now: Date = new Date()): ReminderStatus {
  const anchor = lastBackup ?? (state.since ? new Date(state.since) : null);
  const days = anchor ? daysSince(anchor, now) : null;
  const byChanges = state.changes >= REMINDER_AFTER_CHANGES;
  const byDays = days !== null && days >= REMINDER_AFTER_DAYS;
  const snoozed = state.snoozeUntil !== undefined && Date.parse(state.snoozeUntil) > now.getTime();
  const reason: ReminderReason | null = byChanges ? "changes" : byDays ? "days" : null;
  return { due: reason !== null && !snoozed, reason, days, changes: state.changes, snoozed, lastBackup };
}

/**
 * El estado de ahora (lee `localStorage`). El ancla de los 30 días es hasta cuándo está respaldado lo que se vigila
 * (`backupCoverageDate`): un respaldo solo de Ajustes no la mueve.
 */
export function reminderStatus(now: Date = new Date()): ReminderStatus {
  const status = reminderStatusFrom(readReminderState(), backupCoverageDate(), now);
  return Object.keys(readLastBackupParts()).length > 0 ? { ...status, partialBackups: true } : status;
}
