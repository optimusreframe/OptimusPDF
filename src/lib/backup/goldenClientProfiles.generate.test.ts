import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GOLDEN_PROFILES_PASSWORD, buildGoldenClientProfiles } from "@/lib/backup/__fixtures__/goldenClientProfiles";
import { readPackage } from "@/lib/backup/package";

/**
 * GENERADOR de los dorados `client-profiles-v1*.optimuspdf.zip`. Esta APAGADO: solo corre con `GEN_GOLDEN_CLIENT_PROFILES=1` y
 * escribe en `__fixtures__/packages/`. Los dorados ya publicados NO se regeneran (uno nuevo de otra version se AÑADE al lado);
 * esto queda como constancia del codigo que los produjo. El contenido lo comprueba `goldenPackages.clientProfiles.test.tsx`.
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");

describe.skipIf(!process.env.GEN_GOLDEN_CLIENT_PROFILES)("generar los dorados de perfiles de cliente", () => {
  it("escribe client-profiles-v1 (en claro) y client-profiles-v1-encrypted (dorada-2026)", async () => {
    const plain = await buildGoldenClientProfiles();
    const encrypted = await buildGoldenClientProfiles({ password: GOLDEN_PROFILES_PASSWORD });
    writeFileSync(path.join(DIR, "client-profiles-v1.optimuspdf.zip"), new Uint8Array(await plain.arrayBuffer()));
    writeFileSync(path.join(DIR, "client-profiles-v1-encrypted.optimuspdf.zip"), new Uint8Array(await encrypted.arrayBuffer()));
    const read = await readPackage(plain);
    expect(read.modules.map((m) => m.name)).toEqual(["client-profiles"]);
  });
});
