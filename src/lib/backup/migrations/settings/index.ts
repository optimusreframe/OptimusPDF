import { runMigrationChain, type Migration } from "@/lib/backup/migrations/chain";
import { settingsV1Identity } from "@/lib/backup/migrations/settings/v1";

/** Esquema de `settings/settings.json` (y de `value-history.json`) que escribe y entiende esta version. */
export const CURRENT_SETTINGS_SCHEMA = 1;

export const SETTINGS_MIGRATIONS: readonly Migration[] = [settingsV1Identity];

/** Lleva el contenido de un paquete (esquema `declared`) al esquema actual. */
export function migrateSettings(data: unknown, declared: number): unknown {
  return runMigrationChain(SETTINGS_MIGRATIONS, declared, CURRENT_SETTINGS_SCHEMA, data);
}
