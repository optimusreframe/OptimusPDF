import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_REMINDER_KEY, BACKUP_STATE_EVENT, LAST_BACKUP_KEY, markLastBackup } from "@/lib/backup/lastBackup";
import {
  REMINDER_AFTER_CHANGES,
  REMINDER_AFTER_DAYS,
  SNOOZE_DAYS,
  noteBackupRelevantChange,
  readReminderState,
  reminderStatus,
  reminderStatusFrom,
  snoozeBackupReminder,
  startReminderClock,
} from "@/lib/backup/backupReminder";
import { SETTINGS_KEYS, SETTINGS_NEVER_EXPORTED_KEYS, SETTINGS_WRITABLE_KEYS } from "@/lib/backup/settingsRegistry";
import { clearVault, deleteVaultEntry, saveVaultEntry, touchVaultEntry, updateVaultEntry } from "@/app/sign-pdf/signVault";
import { __resetLibraryForTests, clearLibrary, deleteDocument } from "@/lib/docLibrary/store";
import { seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { vaultInput } from "@/lib/backup/__fixtures__/testKit";

/** Recordatorio de respaldo (U4.7): contador de cambios, reglas de 30 días / 10 cambios, «Recordármelo luego» y reinicio. */

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T10:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

beforeEach(async () => {
  window.localStorage.clear();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("clave y clasificación", () => {
  it("la clave es optimuspdf.backupReminder y NUNCA viaja en el paquete", () => {
    expect(BACKUP_REMINDER_KEY).toBe("optimuspdf.backupReminder");
    expect(SETTINGS_NEVER_EXPORTED_KEYS).toContain(BACKUP_REMINDER_KEY);
    expect(SETTINGS_KEYS).not.toContain(BACKUP_REMINDER_KEY);
    expect(SETTINGS_WRITABLE_KEYS).not.toContain(BACKUP_REMINDER_KEY);
  });
});

describe("contador de cambios", () => {
  it("cada llamada suma uno, fija el comienzo una sola vez y no guarda nada personal", () => {
    expect(readReminderState()).toEqual({ changes: 0 });
    noteBackupRelevantChange(at(0));
    noteBackupRelevantChange(at(3));
    expect(readReminderState()).toEqual({ changes: 2, since: at(0).toISOString() });
    expect(Object.keys(JSON.parse(window.localStorage.getItem(BACKUP_REMINDER_KEY) as string)).sort()).toEqual(["changes", "since"]);
  });

  it("avisa a la misma pestaña con un evento", () => {
    const listener = vi.fn();
    window.addEventListener(BACKUP_STATE_EVENT, listener);
    noteBackupRelevantChange();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(BACKUP_STATE_EVENT, listener);
  });

  it("un valor roto, ajeno o enorme se lee como «sin cambios»", () => {
    for (const bad of ["", "no json", "[]", "null", '{"changes":"9"}', '{"changes":-3}', '{"changes":1.5}', `{"changes":4,"x":"${"a".repeat(600)}"}`]) {
      window.localStorage.setItem(BACKUP_REMINDER_KEY, bad);
      expect(readReminderState().changes, bad).toBe(0);
    }
    window.localStorage.setItem(BACKUP_REMINDER_KEY, '{"changes":4,"since":"ayer","snoozeUntil":42}');
    expect(readReminderState()).toEqual({ changes: 4 });
  });

  it("con localStorage bloqueado nada lanza", () => {
    const blocked = () => {
      throw new Error("bloqueado");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(() => noteBackupRelevantChange()).not.toThrow();
    expect(readReminderState()).toEqual({ changes: 0 });
    expect(snoozeBackupReminder()).toBe(false);
    expect(() => startReminderClock()).not.toThrow();
    expect(reminderStatus().due).toBe(false);
  });
});

describe("cuándo toca avisar", () => {
  it("con 10 cambios sí; con 9 no", () => {
    expect(REMINDER_AFTER_CHANGES).toBe(10);
    expect(reminderStatusFrom({ changes: 9, since: at(0).toISOString() }, null, at(1))).toMatchObject({ due: false, reason: null });
    expect(reminderStatusFrom({ changes: 10, since: at(0).toISOString() }, null, at(1))).toMatchObject({ due: true, reason: "changes", changes: 10 });
  });

  it("a los 30 días del último respaldo sí; a los 29 no", () => {
    expect(REMINDER_AFTER_DAYS).toBe(30);
    expect(reminderStatusFrom({ changes: 0 }, at(0), at(29))).toMatchObject({ due: false, days: 29 });
    expect(reminderStatusFrom({ changes: 0 }, at(0), at(30))).toMatchObject({ due: true, reason: "days", days: 30 });
    expect(reminderStatusFrom({ changes: 0 }, at(0), at(31))).toMatchObject({ due: true, reason: "days", days: 31 });
  });

  it("sin respaldo, los 30 días se cuentan desde el primer cambio; sin ancla no hay aviso por días", () => {
    expect(reminderStatusFrom({ changes: 2, since: at(0).toISOString() }, null, at(31))).toMatchObject({ due: true, reason: "days", lastBackup: null });
    expect(reminderStatusFrom({ changes: 0 }, null, at(400))).toMatchObject({ due: false, days: null });
  });

  it("si hay a la vez cambios y días, manda «cambios»", () => {
    expect(reminderStatusFrom({ changes: 12 }, at(0), at(40)).reason).toBe("changes");
  });

  it("un respaldo con la fecha en el futuro no cuenta días negativos", () => {
    expect(reminderStatusFrom({ changes: 0 }, at(10), at(0))).toMatchObject({ due: false, days: 0 });
  });

  it("«Recordármelo luego» calla 7 días y vuelve a avisar después", () => {
    expect(SNOOZE_DAYS).toBe(7);
    expect(snoozeBackupReminder(at(31))).toBe(true);
    const state = readReminderState();
    expect(state.snoozeUntil).toBe(at(38).toISOString());
    expect(reminderStatusFrom({ ...state, changes: 12 }, null, at(37))).toMatchObject({ due: false, snoozed: true });
    expect(reminderStatusFrom({ ...state, changes: 12 }, null, at(38.01))).toMatchObject({ due: true, snoozed: false });
  });

  it("posponer conserva el contador", () => {
    noteBackupRelevantChange(at(0));
    snoozeBackupReminder(at(1));
    expect(readReminderState().changes).toBe(1);
  });

  it("startReminderClock fija «desde hoy» solo si no hay respaldo ni comienzo, y no cuenta cambios", () => {
    startReminderClock(at(0));
    expect(readReminderState()).toEqual({ changes: 0, since: at(0).toISOString() });
    startReminderClock(at(5));
    expect(readReminderState().since).toBe(at(0).toISOString());
    window.localStorage.clear();
    window.localStorage.setItem(LAST_BACKUP_KEY, at(0).toISOString());
    startReminderClock(at(5));
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
  });

  it("reminderStatus lee el estado y el último respaldo reales", () => {
    window.localStorage.setItem(LAST_BACKUP_KEY, at(0).toISOString());
    expect(reminderStatus(at(31))).toMatchObject({ due: true, reason: "days", days: 31 });
    expect(reminderStatus(at(2))).toMatchObject({ due: false });
  });
});

describe("hacer un respaldo reinicia el recordatorio", () => {
  it("markLastBackup borra el contador y el aplazamiento y avisa a la pestaña", () => {
    for (let i = 0; i < 12; i += 1) noteBackupRelevantChange(at(0));
    snoozeBackupReminder(at(1));
    expect(reminderStatusFrom(readReminderState(), null, at(40)).changes).toBe(12);
    const listener = vi.fn();
    window.addEventListener(BACKUP_STATE_EVENT, listener);
    expect(markLastBackup(at(40))).toBe(true);
    window.removeEventListener(BACKUP_STATE_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
    expect(reminderStatus(at(41))).toMatchObject({ due: false, changes: 0, days: 1 });
  });
});

describe("qué cambios cuentan", () => {
  const changes = () => readReminderState().changes;

  it("una firma nueva y una edición cuentan; repetir la misma, usarla o consultarla, no", async () => {
    const saved = await saveVaultEntry(vaultInput("Ana Pérez"));
    expect(saved.ok && !saved.duplicate).toBe(true);
    expect(changes()).toBe(1);
    // Mismo firmante con los mismos PNG: es un duplicado (solo actualiza «último uso»).
    const again = await saveVaultEntry(vaultInput("Ana Pérez"));
    expect(again.ok && again.duplicate).toBe(true);
    expect(changes()).toBe(1);
    const id = saved.ok ? saved.entry.id : "";
    await touchVaultEntry(id);
    expect(changes()).toBe(1);
    expect((await updateVaultEntry(id, { signerName: "Ana P." })).ok).toBe(true);
    expect(changes()).toBe(2);
  });

  it("borrar todo el baúl no cuenta", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    await deleteVaultEntry("no-existe");
    await clearVault();
    expect(changes()).toBe(1);
  });

  it("documentos y plantillas: alta, edición y borrado cuentan", async () => {
    await seedDoc("doc-a", 1);
    expect(changes()).toBe(1);
    await seedTemplate("doc-a", {}, "tpl-a");
    expect(changes()).toBe(2);
    await deleteDocument("doc-a");
    expect(changes()).toBeGreaterThanOrEqual(3);
  });

  it("diez altas disparan el aviso por cambios", async () => {
    for (let i = 0; i < 10; i += 1) await seedDoc(`doc-${i}`, i + 1);
    expect(reminderStatus()).toMatchObject({ due: true, reason: "changes" });
  });
});
