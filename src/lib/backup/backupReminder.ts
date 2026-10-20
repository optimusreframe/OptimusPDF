import {
  BACKUP_REMINDER_KEY,
  BACKUP_STATE_EVENT,
  daysSince,
  readLastBackup,
} from "@/lib/backup/lastBackup";

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
const MAX_CHANGES = 100_000;
const DAY_MS = 86_400_000;

export type ReminderState = {
  /** Cambios relevantes desde el último respaldo (0 si no hay). */
  changes: number;
  /** Primer cambio contado desde el último respaldo (ISO): ancla de los 30 días cuando nunca se hizo un respaldo. */
  since?: string;
  /** «Recordármelo luego»: no avisar antes de esta fecha (ISO). */
  snoozeUntil?: string;
};

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function announce(): void {
  try {
    window.dispatchEvent(new Event(BACKUP_STATE_EVENT));
  } catch {
    // Sin ventana: nadie a quien avisar.
  }
}

/** El estado guardado, ya validado (un valor roto o ajeno se lee como «sin cambios»). */
export function readReminderState(): ReminderState {
  try {
    const raw = window.localStorage.getItem(BACKUP_REMINDER_KEY);
    if (!raw || raw.length > 512) return { changes: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { changes: 0 };
    const record = parsed as Record<string, unknown>;
    const changes = typeof record.changes === "number" && Number.isInteger(record.changes) && record.changes > 0 ? Math.min(record.changes, MAX_CHANGES) : 0;
    return {
      changes,
      ...(isIso(record.since) ? { since: record.since } : {}),
      ...(isIso(record.snoozeUntil) ? { snoozeUntil: record.snoozeUntil } : {}),
    };
  } catch {
    return { changes: 0 };
  }
}

function writeReminderState(state: ReminderState): boolean {
  try {
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * Cuenta UN cambio relevante (alta o edición de una firma, un documento o una plantilla). Barato: una lectura y una
 * escritura de una clave diminuta. Si nunca hubo un respaldo, el primer cambio fija el comienzo de los 30 días.
 */
export function noteBackupRelevantChange(now: Date = new Date()): void {
  const state = readReminderState();
  const next: ReminderState = {
    changes: Math.min(state.changes + 1, MAX_CHANGES),
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
  if (readLastBackup() !== null) return;
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

/** El estado de ahora (lee `localStorage`). */
export function reminderStatus(now: Date = new Date()): ReminderStatus {
  return reminderStatusFrom(readReminderState(), readLastBackup(), now);
}
