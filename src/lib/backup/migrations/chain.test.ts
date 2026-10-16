import { describe, expect, it, vi } from "vitest";
import { MigrationError, runMigrationChain, type Migration } from "@/lib/backup/migrations/chain";
import {
  CURRENT_SIGNATURES_SCHEMA,
  SIGNATURES_MIGRATIONS,
  migrateSignaturesIndex,
} from "@/lib/backup/migrations/signatures";
import { signaturesV1Identity } from "@/lib/backup/migrations/signatures/v1";

const step = (from: number, to: number, tag: string): Migration => ({
  from,
  to,
  migrate: (data) => ({ ...(data as object), steps: [...((data as { steps: string[] }).steps ?? []), tag] }),
});

describe("cadena de migraciones — src/lib/backup/migrations/chain.ts", () => {
  const chain = [step(1, 2, "1>2"), step(2, 3, "2>3")];

  it("encadena los pasos en orden desde la version declarada hasta la actual", () => {
    expect(runMigrationChain(chain, 1, 3, { steps: [] })).toEqual({ steps: ["1>2", "2>3"] });
    expect(runMigrationChain(chain, 2, 3, { steps: [] })).toEqual({ steps: ["2>3"] });
    expect(runMigrationChain(chain, 3, 3, { steps: ["x"] })).toEqual({ steps: ["x"] });
  });

  it("es PURA: no muta la entrada", () => {
    const input = Object.freeze({ steps: Object.freeze([]) });
    expect(() => runMigrationChain(chain, 1, 3, input)).not.toThrow();
    expect(input).toEqual({ steps: [] });
  });

  it("un paso con from === to (normalizacion de la version actual) se aplica UNA vez", () => {
    const normalize = vi.fn((d: unknown) => ({ ...(d as object), norm: true }));
    expect(runMigrationChain([{ from: 1, to: 1, migrate: normalize }], 1, 1, {})).toEqual({ norm: true });
    expect(normalize).toHaveBeenCalledTimes(1);
    // dos pasos identicos iguales: cada uno una vez, sin bucle infinito
    const twice = [
      { from: 1, to: 1, migrate: normalize },
      { from: 1, to: 1, migrate: normalize },
    ];
    normalize.mockClear();
    runMigrationChain(twice, 1, 1, {});
    expect(normalize).toHaveBeenCalledTimes(2);
  });

  it("un paso puede saltar versiones (1 -> 3)", () => {
    expect(runMigrationChain([step(1, 3, "1>3")], 1, 3, { steps: [] })).toEqual({ steps: ["1>3"] });
  });

  it("falta un paso -> MigrationError; version declarada mayor, menor que 1 o no entera -> MigrationError", () => {
    expect(() => runMigrationChain([step(1, 2, "1>2")], 1, 3, {})).toThrow(MigrationError);
    expect(() => runMigrationChain(chain, 4, 3, {})).toThrow(MigrationError);
    expect(() => runMigrationChain(chain, 0, 3, {})).toThrow(MigrationError);
    expect(() => runMigrationChain(chain, 1.5, 3, {})).toThrow(MigrationError);
    expect(() => runMigrationChain([], 1, 2, {})).toThrow(MigrationError);
  });

  it("ignora pasos que retroceden o se pasan de la version actual", () => {
    expect(() => runMigrationChain([{ from: 1, to: 0, migrate: (d) => d }], 1, 2, {})).toThrow(MigrationError);
    expect(() => runMigrationChain([step(1, 5, "1>5")], 1, 3, {})).toThrow(MigrationError);
  });
});

describe("migraciones de firmas — src/lib/backup/migrations/signatures", () => {
  it("el esquema actual es 1 y la cadena registrada es la identidad v1 -> v1", () => {
    expect(CURRENT_SIGNATURES_SCHEMA).toBe(1);
    expect(SIGNATURES_MIGRATIONS).toEqual([signaturesV1Identity]);
    expect(signaturesV1Identity).toMatchObject({ from: 1, to: 1 });
    const data = [{ id: "a" }];
    expect(migrateSignaturesIndex(data, 1)).toBe(data);
  });

  it("una version mayor que la actual no se migra (quien llama la rechaza antes)", () => {
    expect(() => migrateSignaturesIndex([], 2)).toThrow(MigrationError);
  });
});
