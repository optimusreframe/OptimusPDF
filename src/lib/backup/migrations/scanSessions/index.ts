import { runMigrationChain, type Migration } from "@/lib/backup/migrations/chain";
import { scanSessionsV1Identity } from "@/lib/backup/migrations/scanSessions/v1";

/** Esquema de `scan-sessions/index.json` que escribe y entiende esta version. */
export const CURRENT_SCAN_SESSIONS_SCHEMA = 1;

export const SCAN_SESSIONS_MIGRATIONS: readonly Migration[] = [scanSessionsV1Identity];

/** Lleva el `index.json` de un paquete (esquema `declared`) al esquema actual. */
export function migrateScanSessionsIndex(data: unknown, declared: number): unknown {
  return runMigrationChain(SCAN_SESSIONS_MIGRATIONS, declared, CURRENT_SCAN_SESSIONS_SCHEMA, data);
}
