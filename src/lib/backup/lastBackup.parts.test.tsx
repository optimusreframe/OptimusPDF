import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_REMINDER_KEY,
  LAST_BACKUP_KEY,
  LAST_BACKUP_PARTS_KEY,
  backupCoverageDate,
  markLastBackup,
  readLastBackup,
  readLastBackupParts,
} from "@/lib/backup/lastBackup";
import { noteBackupRelevantChange, readReminderState, reminderStatus } from "@/lib/backup/backupReminder";
import { SETTINGS_NEVER_EXPORTED_KEYS } from "@/lib/backup/settingsRegistry";
import { recordBackup } from "@/lib/backup/globalPackage";
import { clearVault, deleteVaultEntry, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { __resetLibraryForTests, clearLibrary, deleteDocument } from "@/lib/docLibrary/store";
import { deleteTemplate } from "@/lib/docLibrary/templatesStore";
import { seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { vaultInput } from "@/lib/backup/__fixtures__/testKit";
import { lastBackupLine, partialBackup } from "@/app/settings/packageModel";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/**
 * H2 + H3 (verificación independiente de «Respaldo y traslado»).
 *  - H2: una exportación PARCIAL (p. ej. solo Ajustes) marcaba «último respaldo» y reiniciaba el recordatorio como si todo
 *    estuviera respaldado. Ahora solo se anota (y se descuenta del contador) lo que de verdad viajó.
 *  - H3: borrar una firma no sumaba al contador del recordatorio aunque el comentario decía «alta, edición o borrado».
 */

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

const reminder = () => readReminderState();
const seedReminder = (state: object) => window.localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify(state));

describe("H2 — markLastBackup solo anota y reinicia lo que viajó", () => {
  it("sin partes (compatibilidad) es un respaldo completo: fecha, todas las partes y recordatorio reiniciado", () => {
    seedReminder({ changes: 12, by: { signatures: 7, library: 5 }, since: at(-40).toISOString(), snoozeUntil: at(3).toISOString() });
    expect(markLastBackup(at(0))).toBe(true);
    expect(readLastBackup()).toEqual(at(0));
    expect(Object.keys(readLastBackupParts()).sort()).toEqual(["drafts", "library", "scanSessions", "settings", "signatures"]);
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
  });

  it("SOLO Ajustes (y hay firmas y documentos sin respaldar): no marca «último respaldo» ni toca el contador ni el aplazamiento", () => {
    const state = { changes: 12, by: { signatures: 7, library: 5 }, since: at(-40).toISOString(), snoozeUntil: at(3).toISOString() };
    seedReminder(state);
    markLastBackup(at(0), { traveled: ["settings"], empty: ["drafts"] });
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    // Solo lo que VIAJÓ cuenta como «respaldo parcial»; lo vacío (drafts) cuenta como cubierto pero no se presume.
    expect(readLastBackupParts()).toEqual({ settings: at(0) });
    expect(JSON.parse(window.localStorage.getItem(BACKUP_REMINDER_KEY) as string)).toEqual(state);
  });

  it("solo Firmas: descuenta SOLO los cambios de las firmas; lo de la biblioteca sigue contando", () => {
    seedReminder({ changes: 12, by: { signatures: 7, library: 5 }, since: at(-5).toISOString() });
    markLastBackup(at(0), { traveled: ["signatures"] });
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    expect(reminder()).toEqual({ changes: 5, by: { library: 5 }, since: at(-5).toISOString() });
  });

  it("solo Plantillas y documentos: descuenta los de la biblioteca", () => {
    seedReminder({ changes: 12, by: { signatures: 7, library: 5 } });
    markLastBackup(at(0), { traveled: ["library"] });
    expect(reminder()).toEqual({ changes: 7, by: { signatures: 7 } });
  });

  it("firmas + biblioteca + borradores (sin Ajustes) es un respaldo completo y reinicia el recordatorio entero", () => {
    seedReminder({ changes: 12, by: { signatures: 7, library: 5 }, snoozeUntil: at(3).toISOString() });
    markLastBackup(at(0), { traveled: ["signatures", "library", "drafts"] });
    expect(readLastBackup()).toEqual(at(0));
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
  });

  it("las partes vacías cuentan como respaldadas: exportar lo único que hay es un respaldo completo", () => {
    markLastBackup(at(0), { traveled: ["library"], empty: ["signatures", "drafts", "settings"] });
    expect(readLastBackup()).toEqual(at(0));
  });

  it("un cambio sin parte atribuida (contador antiguo) solo se limpia con un respaldo de todas las partes contadas", () => {
    seedReminder({ changes: 4 });
    markLastBackup(at(0), { traveled: ["signatures"] });
    expect(reminder().changes).toBe(4);
    markLastBackup(at(1), { traveled: ["signatures", "library", "drafts"] });
    expect(window.localStorage.getItem(BACKUP_REMINDER_KEY)).toBeNull();
  });

  it("la clave de las partes nunca viaja en el paquete", () => {
    expect(LAST_BACKUP_PARTS_KEY).toBe("optimuspdf.lastBackupParts");
    expect(SETTINGS_NEVER_EXPORTED_KEYS).toContain(LAST_BACKUP_PARTS_KEY);
  });

  it("un valor roto en las partes se ignora", () => {
    window.localStorage.setItem(LAST_BACKUP_PARTS_KEY, "{no es json");
    expect(readLastBackupParts()).toEqual({});
    window.localStorage.setItem(LAST_BACKUP_PARTS_KEY, JSON.stringify({ signatures: "ayer", library: at(0).toISOString(), extra: at(0).toISOString() }));
    expect(readLastBackupParts()).toEqual({ library: at(0) });
  });
});

describe("H2 — el recordatorio de 30 días mira lo respaldado, no el último clic", () => {
  it("un respaldo solo de Ajustes no mueve el ancla: a los 31 días del completo sigue tocando avisar", () => {
    markLastBackup(at(0));
    markLastBackup(at(30), { traveled: ["settings"] });
    expect(readLastBackup()).toEqual(at(0));
    expect(backupCoverageDate()).toEqual(at(0));
    expect(reminderStatus(at(31))).toMatchObject({ due: true, reason: "days", days: 31 });
  });

  it("varios respaldos parciales que juntos cubren todo: el ancla es la parte MÁS antigua", () => {
    markLastBackup(at(0), { traveled: ["signatures"], empty: [] });
    markLastBackup(at(5), { traveled: ["library", "drafts"] });
    expect(readLastBackup()).toBeNull();
    expect(backupCoverageDate()).toEqual(at(0));
    expect(reminderStatus(at(34)).due).toBe(true);
    expect(reminderStatus(at(29)).due).toBe(false);
  });

  it("una parte VACÍA anotada en un respaldo anterior sigue contando como cubierta (el ancla no depende de que viaje)", () => {
    // Lunes: viajan las firmas y los borradores estaban vacíos. Viernes: viaja la biblioteca. Juntos cubren lo vigilado.
    markLastBackup(at(0), { traveled: ["signatures"], empty: ["drafts"] });
    markLastBackup(at(4), { traveled: ["library"] });
    expect(readLastBackup()).toBeNull();
    expect(readLastBackupParts()).toEqual({ signatures: at(0), library: at(4) });
    expect(backupCoverageDate()).toEqual(at(0));
    expect(reminderStatus(at(31))).toMatchObject({ due: true, reason: "days", days: 31 });
    expect(reminderStatus(at(29)).due).toBe(false);
  });

  it("recordBackup: lo que no viajó y TIENE datos no se anota; lo vacío sí", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    await recordBackup(["settings"], at(0));
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    expect(Object.keys(readLastBackupParts())).toEqual(["settings"]);
    // las firmas tienen datos y no viajaron: no se anotan (ni como viajadas ni como vacías)
    expect(backupCoverageDate()).toBeNull();
    await recordBackup(["signatures"], at(1));
    expect(readLastBackup()).toEqual(at(1));
  });
});

describe("H2 — «Último respaldo» no presume de un respaldo parcial", () => {
  const copy = es.settings.backup;
  it("completo: la línea de siempre", () => {
    expect(lastBackupLine(at(0), { signatures: at(0), library: at(0), drafts: at(0), settings: at(0) }, copy, at(0))).toBe("Último respaldo: hoy.");
    expect(partialBackup(at(0), { library: at(0) })).toBeNull();
  });
  it("solo Ajustes y nunca hubo uno completo", () => {
    expect(lastBackupLine(null, { settings: at(0) }, copy, at(0))).toBe("Último respaldo parcial (Ajustes): hoy. Aún no has hecho un respaldo completo.");
  });
  it("parcial más reciente que un completo antiguo: dice los dos", () => {
    expect(lastBackupLine(at(0), { signatures: at(0), settings: at(40) }, copy, at(41))).toBe(
      "Último respaldo parcial (Ajustes): ayer. Último respaldo completo: hace 41 días.",
    );
  });
  it("en inglés", () => {
    expect(lastBackupLine(null, { library: at(0), settings: at(0) }, en.settings.backup, at(2))).toBe(
      "Last partial backup (Templates and documents, Settings): 2 days ago. You have not made a full backup yet.",
    );
  });
  it("nunca: el texto de siempre", () => {
    expect(lastBackupLine(null, {}, copy, at(0))).toBe("Aún no has hecho un respaldo.");
  });
});

describe("H3 — borrar también es un cambio relevante para el recordatorio", () => {
  const changes = () => readReminderState().changes;

  it("borrar una firma que existe suma uno (a las firmas)", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    const before = changes();
    const list = await listVault();
    await deleteVaultEntry(list.entries[0].id);
    expect(changes()).toBe(before + 1);
    expect(readReminderState().by?.signatures).toBe(before + 1);
  });

  it("borrar un id que no existe no cuenta; vaciar el baúl tampoco", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    const before = changes();
    await deleteVaultEntry("no-existe");
    expect(changes()).toBe(before);
    await clearVault();
    expect(changes()).toBe(before);
  });

  it("borrar un documento y borrar una plantilla suman uno cada uno (a la biblioteca)", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    const before = changes();
    expect(await deleteTemplate("tpl-a")).toBe(true);
    expect(changes()).toBe(before + 1);
    expect(await deleteDocument("doc-a")).toBe(true);
    expect(changes()).toBe(before + 2);
    expect(readReminderState().by?.library).toBe(before + 2);
  });

  it("borrar lo que no existe no suma", async () => {
    const before = changes();
    expect(await deleteDocument("no-existe")).toBe(false);
    expect(await deleteTemplate("no-existe")).toBe(false);
    expect(changes()).toBe(before);
  });

  it("el contador atribuye cada cambio a su parte", () => {
    noteBackupRelevantChange(at(0), "signatures");
    noteBackupRelevantChange(at(0), "library");
    noteBackupRelevantChange(at(0), "library");
    noteBackupRelevantChange(at(0));
    expect(readReminderState()).toEqual({ changes: 4, by: { signatures: 1, library: 2 }, since: at(0).toISOString() });
  });
});
