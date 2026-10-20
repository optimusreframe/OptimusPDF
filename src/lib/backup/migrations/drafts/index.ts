import { runMigrationChain, type Migration } from "@/lib/backup/migrations/chain";
import { draftsV1Identity } from "@/lib/backup/migrations/drafts/v1";

/** Esquema de `drafts/index.json` que escribe y entiende esta version. */
export const CURRENT_DRAFTS_SCHEMA = 1;

export const DRAFTS_MIGRATIONS: readonly Migration[] = [draftsV1Identity];

/** Lleva el `index.json` de un paquete (esquema `declared`) al esquema actual. */
export function migrateDraftsIndex(data: unknown, declared: number): unknown {
  return runMigrationChain(DRAFTS_MIGRATIONS, declared, CURRENT_DRAFTS_SCHEMA, data);
}
