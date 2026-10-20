import "fake-indexeddb/auto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GOLDEN_ALL_PASSWORD, buildGoldenAll } from "@/lib/backup/__fixtures__/goldenAll";
import { readPackage } from "@/lib/backup/package";

/**
 * GENERADOR de los dorados `package-all-v1*.optimuspdf.zip` (U4.8). Está APAGADO: solo corre con `GEN_GOLDEN_ALL=1` y escribe
 * en `__fixtures__/packages/`. Los dorados ya publicados NO se regeneran (un dorado nuevo de otra versión se AÑADE al lado);
 * esto queda como constancia del código determinista que los produjo. El contenido lo comprueba
 * `goldenPackages.packageAll.test.tsx`.
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");

describe.skipIf(!process.env.GEN_GOLDEN_ALL)("generar los dorados del paquete global", () => {
  it("escribe package-all-v1 (en claro) y package-all-v1-encrypted (dorada-2026)", async () => {
    const plain = await buildGoldenAll({ withHistory: false });
    const encrypted = await buildGoldenAll({ password: GOLDEN_ALL_PASSWORD, withHistory: true });
    writeFileSync(path.join(DIR, "package-all-v1.optimuspdf.zip"), new Uint8Array(await plain.arrayBuffer()));
    writeFileSync(path.join(DIR, "package-all-v1-encrypted.optimuspdf.zip"), new Uint8Array(await encrypted.arrayBuffer()));
    const read = await readPackage(plain);
    expect(read.modules.map((m) => m.name)).toEqual(["signatures", "library", "drafts", "settings"]);
  });
});
