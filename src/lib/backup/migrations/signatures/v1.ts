import type { Migration } from "@/lib/backup/migrations/chain";

/**
 * v1 -> v1: identidad. Es el ejemplo vivo de como se escribe un paso (y la
 * prueba de que la cadena aplica la normalizacion de la version actual).
 * Cuando exista el esquema 2 se anadira `v1-to-v2.ts` junto a este y se
 * registrara en `index.ts`; el paquete dorado v1 de `__fixtures__/packages/`
 * garantiza que seguira importandose.
 */
export const signaturesV1Identity: Migration = {
  from: 1,
  to: 1,
  migrate: (data) => data,
};
