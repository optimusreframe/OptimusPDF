import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto/sha256";
import { readPackage } from "@/lib/backup/package";
import { applyClientProfilesImport, defaultClientProfileDecisions, planClientProfilesImport } from "@/lib/backup/modules/clientProfiles";
import { applyEverything, defaultEverythingDecisions, readAndPlanEverything } from "@/lib/backup/globalPackage";
import { GOLDEN_PROFILES } from "@/lib/backup/__fixtures__/goldenClientProfiles";
import { wipeProfiles } from "@/lib/backup/__fixtures__/clientProfilesKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";
import { listClientProfiles } from "@/lib/clientProfile/store";

/**
 * Dorados de «Perfiles de cliente» (`__fixtures__/packages/client-profiles-v1*.zip`), generados con el codigo de
 * `__fixtures__/goldenClientProfiles.ts` y NUNCA regenerados: si una prueba de aqui falla, se rompio la compatibilidad de un
 * formato publicado (cuando exista el esquema 2 se AÑADE su dorado junto al v1). Contrasena de los cifrados: `dorada-2026`. Que se
 * abren sin avisos lo cubre `goldenPackages.test.ts`, que itera TODOS los dorados.
 *
 * El SHA-256 del JSON es el del archivo publicado (no se recalcula con codigo actual).
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");
const PASSWORD = "dorada-2026";
const open = (name: string) => new Blob([new Uint8Array(readFileSync(path.join(DIR, name)))]);
const PROFILES_SHA256 = "9194176200ec6e7ed112dda0aad09c64e27bd6b61ce0cf9f7a03cfeeb04e7d37";

beforeEach(() => {
  window.localStorage.clear();
  wipeProfiles();
});

describe("dorados de perfiles de cliente", () => {
  for (const name of ["client-profiles-v1.optimuspdf.zip", "client-profiles-v1-encrypted.optimuspdf.zip"]) {
    const encrypted = name.includes("encrypted");

    it(`${name}: el modulo client-profiles con esquema 1, su JSON intacto y sin avisos`, async () => {
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      expect(read).toMatchObject({ formatVersion: 1, encrypted, app: { version: "0.1.0", build: "golden" }, createdAt: "2026-10-15T12:00:00.000Z" });
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([["client-profiles", 1, "ok"]]);
      expect(read.modules[0].meta).toEqual({ count: 3, values: 13 });
      expect(read.warnings).toEqual([]);
      const entry = read.modules[0].files.get("client-profiles/profiles.json");
      expect(entry?.status).toBe("ok");
      expect(await sha256Hex(entry!.bytes!)).toBe(PROFILES_SHA256);
    });

    it(`${name}: se planifica (tres perfiles nuevos), se importa y queda cada perfil con sus valores, fechas y origen exactos`, async () => {
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      const plan = planClientProfilesImport(read);
      expect(plan.state).toBe("ok");
      expect(plan.counts).toEqual({ new: 3, identical: 0, different: 0, invalid: 0 });
      expect(plan.items.map((i) => [i.id, i.status, i.name, i.valueCount]).sort()).toEqual([
        ["cp-golden-0001", "new", "Pérez Soto, María", 8],
        ["cp-golden-0002", "new", "Gómez, Luis", 3],
        ["cp-golden-0003", "new", "Cliente con clave futura", 2],
      ]);
      expect(await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan))).toEqual({ ok: true, written: 3, replaced: 0, keptBoth: 0, skipped: 0 });
      const stored = listClientProfiles();
      for (const golden of GOLDEN_PROFILES) expect(stored.find((p) => p.id === golden.id), golden.id).toEqual(golden);
      // La clave que este registro no conoce se conserva.
      expect(stored.find((p) => p.id === "cp-golden-0003")?.values["roof.material"]).toMatchObject({ value: "teja demo", source: "typed" });
    });

    it(`${name}: por la via global entra igual, y reimportarlo es «ya lo tienes» en todo`, async () => {
      const first = await readAndPlanEverything(asFile(open(name)), encrypted ? PASSWORD : undefined);
      if (!first.ok) throw new Error(first.reason);
      expect(first.modules.map((m) => [m.module, m.state, m.counts.new])).toEqual([["clientProfiles", "ok", 3]]);
      const applied = await applyEverything(first.plans, defaultEverythingDecisions(first.plans));
      expect(applied.applied).toEqual(["clientProfiles"]);
      expect(applied.failed).toEqual([]);
      const second = await readAndPlanEverything(asFile(open(name)), encrypted ? PASSWORD : undefined);
      if (!second.ok) throw new Error(second.reason);
      expect(second.plans.clientProfiles?.counts).toEqual({ new: 0, identical: 3, different: 0, invalid: 0 });
    });
  }

  it("el dorado cifrado no se abre sin contraseña ni con una mala", async () => {
    await expect(readPackage(open("client-profiles-v1-encrypted.optimuspdf.zip"))).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(open("client-profiles-v1-encrypted.optimuspdf.zip"), "nope")).rejects.toMatchObject({ code: "wrongPassword" });
  });
});
