import { runMigrationChain, type Migration } from "@/lib/backup/migrations/chain";
import { libraryV1Identity } from "@/lib/backup/migrations/library/v1";

/** Esquema de `documents/` + `templates/` que escribe y entiende esta versión. */
export const CURRENT_LIBRARY_SCHEMA = 1;

/**
 * Lo que migran los pasos: el JSON YA PARSEADO de cada archivo del módulo. `templates` va por ruta
 * (`templates/<archivo>.json`). Un paso futuro puede reescribir cualquiera de las tres partes.
 */
export type LibraryRaw = {
  documents: unknown;
  templateIndex: unknown;
  templates: Map<string, unknown>;
};

export const LIBRARY_MIGRATIONS: readonly Migration[] = [libraryV1Identity];

/** Lleva los JSON de un paquete (esquema `declared`) al esquema actual. Lanza `MigrationError` si falta un paso. */
export function migrateLibrary(raw: LibraryRaw, declared: number): LibraryRaw {
  return runMigrationChain(LIBRARY_MIGRATIONS, declared, CURRENT_LIBRARY_SCHEMA, raw) as LibraryRaw;
}
