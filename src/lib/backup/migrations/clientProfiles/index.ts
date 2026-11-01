import { runMigrationChain, type Migration } from "@/lib/backup/migrations/chain";
import { clientProfilesV1Identity } from "@/lib/backup/migrations/clientProfiles/v1";

/** Esquema de `client-profiles/profiles.json` que escribe y entiende esta version (el mismo `version` de dentro del JSON). */
export const CURRENT_CLIENT_PROFILES_SCHEMA = 1;

export const CLIENT_PROFILES_MIGRATIONS: readonly Migration[] = [clientProfilesV1Identity];

/** Lleva el `profiles.json` de un paquete (esquema `declared`) al esquema actual. */
export function migrateClientProfiles(data: unknown, declared: number): unknown {
  return runMigrationChain(CLIENT_PROFILES_MIGRATIONS, declared, CURRENT_CLIENT_PROFILES_SCHEMA, data);
}
