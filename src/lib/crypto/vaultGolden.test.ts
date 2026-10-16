import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importVaultFile } from "@/app/sign-pdf/signVaultFile";
import { makeImage } from "@/lib/backup/__fixtures__/pngFactory";

/**
 * Archivos "dorados": generados con el codigo de `signVaultFile.ts` ANTERIOR
 * a extraer el cifrado a `passwordBox.ts`. Mientras esta prueba pase, el
 * formato en disco no ha cambiado y los archivos que los usuarios ya
 * exportaron siguen importandose. NO regenerar estos .zip: si falla, se ha
 * roto la compatibilidad, no los fixtures.
 */

const DIR = path.resolve(__dirname, "__fixtures__");
const PASSWORD = "contraseña-dorada·ñ 1";

function golden(name: string): File {
  const bytes = readFileSync(path.join(DIR, name));
  return new File([new Uint8Array(bytes)], name, { type: "application/zip" });
}

const SIGNATURE = makeImage({ seed: 11 });
const INITIALS = makeImage({ width: 20, height: 20, seed: 12 });

describe("archivos de firma dorados (formato v1)", () => {
  it("el zip en claro sigue importandose con sus datos y sus PNG exactos", async () => {
    const result = await importVaultFile(golden("vault-plain-v1.zip"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.signerName).toBe("Ana Pérez");
    expect(result.entry.role).toBe("Directora");
    expect(result.entry.sourceDocument).toBe("Contrato de arrendamiento.pdf");
    expect(Array.from(result.entry.signature?.png ?? [])).toEqual(Array.from(SIGNATURE.png));
    expect(Array.from(result.entry.initials?.png ?? [])).toEqual(Array.from(INITIALS.png));
  });

  it("el zip cifrado sigue importandose con la contraseña correcta", async () => {
    const result = await importVaultFile(golden("vault-encrypted-v1.zip"), {
      password: PASSWORD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.signerName).toBe("Ana Pérez");
    expect(Array.from(result.entry.signature?.png ?? [])).toEqual(Array.from(SIGNATURE.png));
    expect(Array.from(result.entry.initials?.png ?? [])).toEqual(Array.from(INITIALS.png));
  });

  it("la misma contraseña con otra composicion Unicode (NFD) tambien descifra", async () => {
    const result = await importVaultFile(golden("vault-encrypted-v1.zip"), {
      password: PASSWORD.normalize("NFD"),
    });
    expect(result.ok).toBe(true);
  });

  it("sin contraseña pide contraseña y con una incorrecta la rechaza", async () => {
    expect(await importVaultFile(golden("vault-encrypted-v1.zip"))).toEqual({
      ok: false,
      reason: "needsPassword",
    });
    expect(
      await importVaultFile(golden("vault-encrypted-v1.zip"), { password: "otra" }),
    ).toEqual({ ok: false, reason: "wrongPassword" });
  });
});
