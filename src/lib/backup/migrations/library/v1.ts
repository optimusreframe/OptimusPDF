import type { Migration } from "@/lib/backup/migrations/chain";

/**
 * v1 -> v1: identidad. El módulo «library» (plantillas + documentos) arranca en el esquema 1. Cuando exista el 2 se
 * añadirá `v1-to-v2.ts` junto a este y se registrará en `index.ts`; el paquete dorado
 * `__fixtures__/packages/library-v1*.optimuspdf.zip` garantiza que el esquema 1 seguirá importándose.
 */
export const libraryV1Identity: Migration = {
  from: 1,
  to: 1,
  migrate: (data) => data,
};
