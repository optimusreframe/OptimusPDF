import "fake-indexeddb/auto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SCAN_CREATED, GOLDEN_SCAN_PASSWORD, buildGoldenScan } from "@/lib/backup/__fixtures__/goldenScan";
import { readPackage } from "@/lib/backup/package";

/**
 * GENERADOR de los dorados `scan-sessions-v1*.optimuspdf.zip`. Esta APAGADO: solo corre con `GEN_GOLDEN_SCAN=1` y escribe en
 * `__fixtures__/packages/`. Los dorados ya publicados NO se regeneran (un dorado nuevo de otra version se AÑADE al lado); esto
 * queda como constancia del codigo que los produjo. El contenido lo comprueba `goldenPackages.scanSessions.test.ts`.
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");
afterEach(() => vi.useRealTimers());

describe.skipIf(!process.env.GEN_GOLDEN_SCAN)("generar los dorados de escaneos en curso", () => {
  it("escribe scan-sessions-v1 (en claro) y scan-sessions-v1-encrypted (dorada-2026)", async () => {
    // Las sesiones se «guardan» a la hora del dorado: su fecha de guardado (la que cuenta para la caducidad) sale fija.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(GOLDEN_SCAN_CREATED) });
    const plain = await buildGoldenScan();
    const encrypted = await buildGoldenScan({ password: GOLDEN_SCAN_PASSWORD });
    writeFileSync(path.join(DIR, "scan-sessions-v1.optimuspdf.zip"), new Uint8Array(await plain.arrayBuffer()));
    writeFileSync(path.join(DIR, "scan-sessions-v1-encrypted.optimuspdf.zip"), new Uint8Array(await encrypted.arrayBuffer()));
    const read = await readPackage(plain);
    expect(read.modules.map((m) => m.name)).toEqual(["scan-sessions"]);
  });
});
