import "fake-indexeddb/auto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearVault, listVault } from "@/app/sign-pdf/signVault";
import { sha256Hex } from "@/lib/crypto/sha256";
import {
  applySignaturesImport,
  defaultSignatureDecisions,
  planSignaturesImport,
} from "@/lib/backup/modules/signatures";
import { readPackage } from "@/lib/backup/package";
import { makePng } from "@/lib/backup/__fixtures__/pngFactory";

/**
 * Paquetes «dorados»: archivos generados con una version PUBLICADA del
 * formato y guardados en `__fixtures__/packages/`. Prueba de no regresion
 * (§9.3): todo paquete dorado tiene que seguir importandose. NO se regeneran:
 * si una prueba falla, se ha roto la compatibilidad (cuando haya un esquema 2,
 * se AÑADE `signatures-v2…zip` junto al v1, nunca lo reemplaza).
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");
const PASSWORD = "dorada-2026";
const goldens = readdirSync(DIR).filter((f) => f.endsWith(".optimuspdf.zip")).sort();
/** Los dorados de cada modulo se nombran `<modulo>-v<N>[-encrypted]…`; el contenido de cada familia lo comprueba su propia prueba. */
const signatureGoldens = goldens.filter((f) => f.startsWith("signatures-"));
/** Familia del «OptimusPDF Package» global (U4.8): los CUATRO módulos en un solo archivo; su contenido lo comprueba `goldenPackages.packageAll.test.tsx`. */
const packageAllGoldens = goldens.filter((f) => f.startsWith("package-all-"));

beforeEach(async () => {
  await clearVault();
});

function open(name: string): Blob {
  return new Blob([new Uint8Array(readFileSync(path.join(DIR, name)))]);
}

describe("paquetes dorados — src/lib/backup/__fixtures__/packages", () => {
  it("hay al menos el dorado de firmas v1 (en claro y cifrado)", () => {
    expect(signatureGoldens).toEqual(["signatures-v1-encrypted.optimuspdf.zip", "signatures-v1.optimuspdf.zip"]);
  });

  it("hay el dorado del paquete global v1 (en claro y cifrado) con los cuatro módulos", async () => {
    expect(packageAllGoldens).toEqual(["package-all-v1-encrypted.optimuspdf.zip", "package-all-v1.optimuspdf.zip"]);
    for (const name of packageAllGoldens) {
      const read = await readPackage(open(name), name.includes("-encrypted") ? PASSWORD : undefined);
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([
        ["signatures", 1, "ok"],
        ["library", 1, "ok"],
        ["drafts", 1, "ok"],
        ["settings", 1, "ok"],
      ]);
    }
  });

  // Cualquier familia (firmas, ajustes, borradores, biblioteca...): el paquete se abre con su contrasena, todos sus modulos se
  // leen sin avisos y declaran un esquema que esta version soporta.
  for (const name of goldens) {
    it(`${name}: se abre, todos sus modulos son legibles y no hay avisos`, async () => {
      const encrypted = name.includes("-encrypted");
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      expect(read).toMatchObject({ formatVersion: 1, encrypted, app: { version: "0.1.0", build: "golden" } });
      expect(read.modules.length).toBeGreaterThan(0);
      expect(read.modules.every((m) => m.status === "ok" && m.declaredSchemaVersion >= 1)).toBe(true);
      expect(read.modules.flatMap((m) => [...m.files.values()]).every((f) => f.status === "ok")).toBe(true);
      expect(read.warnings).toEqual([]);
    });
  }

  for (const name of signatureGoldens) {
    it(`${name}: se lee, se planifica y se importa con los datos y PNG exactos`, async () => {
      const encrypted = name.includes("-encrypted");
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      expect(read).toMatchObject({ formatVersion: 1, encrypted, app: { version: "0.1.0", build: "golden" } });
      expect(read.createdAt).toBe("2026-10-15T12:00:00.000Z");
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([["signatures", 1, "ok"]]);
      expect(read.warnings).toEqual([]);

      const plan = await planSignaturesImport(read, []);
      expect(plan.state).toBe("ok");
      expect(plan.items.map((i) => [i.id, i.status, i.signerName, i.role, i.hasSignature, i.hasInitials])).toEqual([
        ["vault-golden-ana", "new", "Ana Pérez", "Directora", true, true],
        ["vault-golden-luis", "new", "Luis Gómez", undefined, true, false],
        ["vault-golden-marta", "new", "Marta Ruiz", undefined, false, true],
      ]);

      expect(await applySignaturesImport(plan, defaultSignatureDecisions(plan))).toMatchObject({ ok: true, written: 3 });
      const { entries } = await listVault();
      const ana = entries.find((e) => e.id === "vault-golden-ana")!;
      expect(ana.createdAt).toBe("2026-10-01T10:00:00.000Z");
      expect(ana.lastUsedAt).toBe("2026-10-05T10:00:00.000Z");
      // los PNG son los de la semilla 11/12 (determinista)
      expect(await sha256Hex(ana.signature!.png)).toBe(await sha256Hex(makePng({ seed: 11 })));
      expect(await sha256Hex(ana.initials!.png)).toBe(await sha256Hex(makePng({ width: 20, height: 20, seed: 12 })));
      const luis = entries.find((e) => e.id === "vault-golden-luis")!;
      expect(luis.initials).toBeNull();
      expect(await sha256Hex(luis.signature!.png)).toBe(await sha256Hex(makePng({ seed: 13 })));
    });
  }

  it("el dorado cifrado no se abre sin contraseña ni con una mala", async () => {
    await expect(readPackage(open("signatures-v1-encrypted.optimuspdf.zip"))).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(open("signatures-v1-encrypted.optimuspdf.zip"), "nope")).rejects.toMatchObject({ code: "wrongPassword" });
  });
});
