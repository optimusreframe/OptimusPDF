/**
 * Migraciones de esquema de un modulo del respaldo: funciones PURAS
 * encadenadas (`vN -> vN+1`), sin tocar almacenes ni red. Un paquete antiguo
 * se lleva a la version actual aplicando, en orden, cada paso que arranca en
 * la version en la que va. Un paso con `from === to` es una normalizacion de
 * esa version (se aplica una vez al llegar a ella).
 */
export type Migration = {
  from: number;
  to: number;
  /** Pura: no muta su entrada y no tiene efectos secundarios. */
  migrate: (data: unknown) => unknown;
};

export class MigrationError extends Error {
  constructor() {
    super("migration-chain-broken");
    this.name = "MigrationError";
  }
}

/**
 * Lleva `data` de `declared` a `current`. Lanza `MigrationError` si falta un
 * paso en la cadena o la version declarada es mayor que la actual (quien llama
 * debe rechazar antes los paquetes mas nuevos con su mensaje propio).
 */
export function runMigrationChain(
  migrations: readonly Migration[],
  declared: number,
  current: number,
  data: unknown,
): unknown {
  if (
    !Number.isInteger(declared) ||
    !Number.isInteger(current) ||
    declared < 1 ||
    declared > current
  ) {
    throw new MigrationError();
  }
  let version = declared;
  let value = data;
  const used = new Set<Migration>();
  for (;;) {
    const step = migrations.find(
      (m) => m.from === version && !used.has(m) && m.to >= m.from && m.to <= current,
    );
    if (!step) break;
    used.add(step);
    value = step.migrate(value);
    version = step.to;
  }
  if (version !== current) throw new MigrationError();
  return value;
}
