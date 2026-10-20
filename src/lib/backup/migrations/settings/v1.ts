import type { Migration } from "@/lib/backup/migrations/chain";

/**
 * v1 -> v1: identidad. Ejemplo vivo de como se escribe un paso. Cuando exista el esquema 2 de `settings/settings.json`
 * se anadira `v1-to-v2.ts` junto a este y se registrara en `index.ts`; el paquete dorado v1 de `__fixtures__/packages/`
 * garantiza que seguira importandose.
 */
export const settingsV1Identity: Migration = {
  from: 1,
  to: 1,
  migrate: (data) => data,
};
