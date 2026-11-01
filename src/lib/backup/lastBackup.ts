/**
 * «Último respaldo»: la fecha (ISO 8601) de la última vez que la persona exportó un paquete desde ESTE navegador. Vive en
 * `localStorage` (clave `optimuspdf.lastBackup`), no en IndexedDB, porque solo es un recordatorio: si se pierde, no se
 * pierde nada. Nunca lanza (almacenamiento bloqueado, modo privado...). Lo comparten «Mis documentos» y Ajustes ➜
 * «Respaldo y traslado».
 *
 * Un respaldo puede ser PARCIAL (solo Ajustes, solo Plantillas y documentos…). `optimuspdf.lastBackup` guarda únicamente
 * la fecha del último respaldo COMPLETO y `optimuspdf.lastBackupParts` la última vez que viajó cada parte: así «Último
 * respaldo» nunca presume de un respaldo que dejó fuera las firmas, y el recordatorio solo reinicia los contadores de lo que
 * de verdad se respaldó. COMPLETO = viajaron (o están vacías) las partes que protegen trabajo de la persona —firmas,
 * plantillas y documentos, borradores—; los ajustes (tema, idioma, interruptores) se recuperan en un minuto y no condicionan
 * lo completo, igual que no cuentan para el recordatorio.
 */
export const LAST_BACKUP_KEY = "optimuspdf.lastBackup";
/** Última vez que viajó cada parte del paquete (JSON `{ signatures?, library?, drafts?, scanSessions?, clientProfiles?, settings? }` con fechas ISO). */
export const LAST_BACKUP_PARTS_KEY = "optimuspdf.lastBackupParts";

/**
 * Estado del recordatorio de respaldo (U4.7: contador de cambios desde el último respaldo y «Recordármelo luego»).
 * La clave vive AQUÍ, junto a `LAST_BACKUP_KEY`, porque `markLastBackup` lo reinicia; la lógica está en `backupReminder.ts`.
 * Es de cada dispositivo y NUNCA viaja en el paquete (`SETTINGS_NEVER_EXPORTED_KEYS`).
 */
export const BACKUP_REMINDER_KEY = "optimuspdf.backupReminder";
/** Aviso a la misma pestaña de que cambió el estado de respaldo (el evento `storage` solo llega a las demás pestañas). */
export const BACKUP_STATE_EVENT = "optimuspdf:backup-state";

/** Las partes del paquete (el mismo orden que `PACKAGE_MODULES` de `globalPackage.ts`, que no se importa aquí). */
export const BACKUP_PARTS = ["signatures", "library", "drafts", "scanSessions", "clientProfiles", "settings"] as const;
export type BackupPart = (typeof BACKUP_PARTS)[number];
/**
 * Partes cuyos cambios cuenta el recordatorio (los ajustes solos no cuentan y los borradores se guardan solos). Los escaneos
 * en curso tampoco: duran 14 días y pesan cientos de MB, así que su respaldo es opcional y no condiciona lo «completo». Ni los
 * perfiles de cliente: se rehacen leyendo un documento y su respaldo (PII) es opcional.
 */
export const REMINDER_PARTS = ["signatures", "library", "drafts"] as const satisfies readonly BackupPart[];

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

/** La fecha del último respaldo COMPLETO, o `null` si nunca se hizo (o el valor guardado no es una fecha). */
export function readLastBackup(): Date | null {
  try {
    const raw = window.localStorage.getItem(LAST_BACKUP_KEY);
    return isIso(raw) ? new Date(raw) : null;
  } catch {
    return null;
  }
}

export type BackupParts = Partial<Record<BackupPart, Date>>;

type StoredParts = { traveled: BackupParts; empty: BackupParts };

function parseDates(value: unknown): BackupParts {
  const out: BackupParts = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const part of BACKUP_PARTS) {
    const date = Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
    if (isIso(date)) out[part] = new Date(date);
  }
  return out;
}

/** Lo guardado: la última vez que VIAJÓ cada parte y la última vez que estaba VACÍA al respaldar (nada que perder). */
function readStoredParts(): StoredParts {
  try {
    const raw = window.localStorage.getItem(LAST_BACKUP_PARTS_KEY);
    if (!raw || raw.length > 2048) return { traveled: {}, empty: {} };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { traveled: {}, empty: {} };
    return { traveled: parseDates(parsed), empty: parseDates((parsed as Record<string, unknown>).empty) };
  } catch {
    return { traveled: {}, empty: {} };
  }
}

/** La última vez que VIAJÓ cada parte (solo fechas válidas; lo demás se ignora). Es lo que se enseña como «respaldo parcial». */
export function readLastBackupParts(): BackupParts {
  return readStoredParts().traveled;
}

/** La última vez que quedó respaldada cada parte: la de su último viaje o la de cuando estaba vacía (lo más reciente). */
function readCoveredParts(): BackupParts {
  const { traveled, empty } = readStoredParts();
  const out: BackupParts = {};
  for (const part of BACKUP_PARTS) {
    const dates = [traveled[part], empty[part]].filter((date): date is Date => date !== undefined);
    if (dates.length > 0) out[part] = new Date(Math.max(...dates.map((date) => date.getTime())));
  }
  return out;
}

/**
 * Hasta cuándo está cubierto lo que el recordatorio vigila (firmas, plantillas y documentos, borradores): la más reciente
 * entre el último respaldo completo y la fecha en que TODAS esas partes quedaron respaldadas (una parte vacía cuenta como
 * respaldada). `null` si todavía no lo están. Un respaldo solo de Ajustes no la mueve.
 */
export function backupCoverageDate(): Date | null {
  const full = readLastBackup();
  const parts = readCoveredParts();
  let covered: Date | null = null;
  if (REMINDER_PARTS.every((part) => parts[part] !== undefined)) {
    covered = new Date(Math.min(...REMINDER_PARTS.map((part) => (parts[part] as Date).getTime())));
  }
  if (full && covered) return full.getTime() >= covered.getTime() ? full : covered;
  return full ?? covered;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Estado del recordatorio (se lee y se escribe aquí para que un respaldo lo pueda reiniciar sin ciclos de módulos) */
/* ------------------------------------------------------------------------------------------------------------ */

export const MAX_REMINDER_CHANGES = 100_000;

export type ReminderState = {
  /** Cambios relevantes desde el último respaldo (0 si no hay). Es el total, incluidos los de cada parte. */
  changes: number;
  /** De ellos, los de cada parte contada (firmas, biblioteca): un respaldo parcial solo descuenta las suyas. */
  by?: Partial<Record<(typeof REMINDER_PARTS)[number], number>>;
  /** Primer cambio contado desde el último respaldo (ISO): ancla de los 30 días cuando nunca se hizo un respaldo. */
  since?: string;
  /** «Recordármelo luego»: no avisar antes de esta fecha (ISO). */
  snoozeUntil?: string;
};

/** El estado guardado, ya validado (un valor roto o ajeno se lee como «sin cambios»). */
export function readReminderState(): ReminderState {
  try {
    const raw = window.localStorage.getItem(BACKUP_REMINDER_KEY);
    if (!raw || raw.length > 512) return { changes: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { changes: 0 };
    const record = parsed as Record<string, unknown>;
    const count = (value: unknown): number =>
      typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, MAX_REMINDER_CHANGES) : 0;
    const changes = count(record.changes);
    const by: NonNullable<ReminderState["by"]> = {};
    if (typeof record.by === "object" && record.by !== null && !Array.isArray(record.by)) {
      for (const part of REMINDER_PARTS) {
        const value = Object.hasOwn(record.by, part) ? count((record.by as Record<string, unknown>)[part]) : 0;
        if (value > 0) by[part] = Math.min(value, changes);
      }
    }
    return {
      changes,
      ...(Object.keys(by).length > 0 ? { by } : {}),
      ...(isIso(record.since) ? { since: record.since } : {}),
      ...(isIso(record.snoozeUntil) ? { snoozeUntil: record.snoozeUntil } : {}),
    };
  } catch {
    return { changes: 0 };
  }
}

export function writeReminderState(state: ReminderState): boolean {
  try {
    window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Descuenta del contador los cambios de las partes que acaban de respaldarse (los de las demás se conservan). */
function resetCountersFor(parts: readonly BackupPart[]): void {
  const state = readReminderState();
  const by = { ...(state.by ?? {}) };
  let removed = 0;
  for (const part of REMINDER_PARTS) {
    if (!parts.includes(part)) continue;
    removed += by[part] ?? 0;
    delete by[part];
  }
  // Con TODAS las partes contadas respaldadas no queda nada pendiente (ni siquiera lo que no se atribuyó a ninguna).
  const everyCounted = REMINDER_PARTS.every((part) => parts.includes(part));
  const changes = everyCounted ? 0 : Math.max(0, state.changes - removed);
  const next: ReminderState = {
    changes,
    ...(changes > 0 && Object.keys(by).length > 0 ? { by } : {}),
    ...(state.since ? { since: state.since } : {}),
    ...(state.snoozeUntil ? { snoozeUntil: state.snoozeUntil } : {}),
  };
  try {
    if (next.changes === 0 && next.since === undefined && next.snoozeUntil === undefined) window.localStorage.removeItem(BACKUP_REMINDER_KEY);
    else writeReminderState(next);
  } catch {
    // El recordatorio es prescindible.
  }
}

export type MarkBackupParts = {
  /** Partes que viajaron en este paquete. */
  traveled: readonly BackupPart[];
  /** Partes que no viajaron porque NO tienen nada que respaldar (cuentan como respaldadas). */
  empty?: readonly BackupPart[];
};

/**
 * Anota que se acaba de exportar un respaldo. Devuelve si se pudo guardar.
 * - Sin `parts` (compatibilidad): respaldo completo.
 * - Con `parts`: anota la fecha de cada parte que viajó (o estaba vacía) y descuenta del recordatorio SOLO los cambios de
 *   esas partes. Si con ellas quedan cubiertas las que protegen trabajo (`REMINDER_PARTS`) es un respaldo completo (guarda
 *   `lastBackup` y reinicia el recordatorio entero); si no, `lastBackup` y la fecha del recordatorio NO se mueven.
 */
export function markLastBackup(at: Date = new Date(), parts?: MarkBackupParts): boolean {
  const covered = new Set<BackupPart>(parts ? [...parts.traveled, ...(parts.empty ?? [])] : BACKUP_PARTS);
  const complete = REMINDER_PARTS.every((part) => covered.has(part));
  try {
    const stored = readStoredParts();
    const traveledNow = new Set<BackupPart>(parts ? parts.traveled : BACKUP_PARTS);
    const traveled: Record<string, string> = {};
    const empty: Record<string, string> = {};
    for (const part of BACKUP_PARTS) {
      const travel = traveledNow.has(part) ? at : stored.traveled[part];
      if (travel) traveled[part] = travel.toISOString();
      const nothing = !traveledNow.has(part) && covered.has(part) ? at : stored.empty[part];
      if (nothing) empty[part] = nothing.toISOString();
    }
    window.localStorage.setItem(LAST_BACKUP_PARTS_KEY, JSON.stringify({ ...traveled, ...(Object.keys(empty).length > 0 ? { empty } : {}) }));
    if (complete) window.localStorage.setItem(LAST_BACKUP_KEY, at.toISOString());
  } catch {
    return false;
  }
  if (complete) {
    try {
      window.localStorage.removeItem(BACKUP_REMINDER_KEY);
    } catch {
      // El recordatorio es prescindible: lo importante (la fecha) ya está guardado.
    }
  } else {
    resetCountersFor([...covered]);
  }
  announceBackupState();
  return true;
}

/** Días completos desde `at` hasta `now` (0 si es hoy o está en el futuro). */
export function daysSince(at: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
}
