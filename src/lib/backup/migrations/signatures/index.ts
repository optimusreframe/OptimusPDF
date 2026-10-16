import { runMigrationChain, type Migration } from "@/lib/backup/migrations/chain";
import { signaturesV1Identity } from "@/lib/backup/migrations/signatures/v1";

/** Esquema de `signatures/index.json` que escribe y entiende esta version. */
export const CURRENT_SIGNATURES_SCHEMA = 1;

export const SIGNATURES_MIGRATIONS: readonly Migration[] = [signaturesV1Identity];

/** Lleva el `index.json` de un paquete (esquema `declared`) al esquema actual. */
export function migrateSignaturesIndex(data: unknown, declared: number): unknown {
  return runMigrationChain(SIGNATURES_MIGRATIONS, declared, CURRENT_SIGNATURES_SCHEMA, data);
}
