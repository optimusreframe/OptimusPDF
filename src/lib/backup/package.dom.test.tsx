import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { exportVaultEntry, importVaultFile } from "@/app/sign-pdf/signVaultFile";
import {
  applySignaturesImport,
  defaultSignatureDecisions,
  exportSignatures,
  planSignaturesImport,
} from "@/lib/backup/modules/signatures";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { vaultInput } from "@/lib/backup/__fixtures__/testKit";

/**
 * El mismo recorrido que `signatures.test.ts` pero en jsdom (proyecto
 * "components"): ahi `TextEncoder`/`Uint8Array`/`Blob` son de dominios
 * distintos y JSZip/WebCrypto/IndexedDB se comportan distinto. La interfaz de
 * «Exportar todas mis firmas / Importar firmas» correra en este entorno.
 */

beforeEach(async () => {
  await clearVault();
});

describe("respaldo de firmas en jsdom — src/lib/backup", () => {
  for (const password of [undefined, "contraseña de prueba"]) {
    it(`ida y vuelta ${password ? "cifrada" : "en claro"}: exportar -> vaciar -> importar`, async () => {
      await saveVaultEntry(vaultInput("Ana Pérez", { role: "Directora" }));
      await saveVaultEntry(vaultInput("Luis Gómez", { sig: 3, ini: null }));
      const before = (await listVault()).entries;
      const blob = await buildPackage({ modules: [await exportSignatures()], password });
      await clearVault();
      const read = await readPackage(blob, password);
      expect(read.encrypted).toBe(password !== undefined);
      const plan = await planSignaturesImport(read, []);
      expect(plan.counts).toMatchObject({ new: 2, invalid: 0 });
      const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
      expect(result).toMatchObject({ ok: true, written: 2 });
      const after = (await listVault()).entries;
      expect(after.map((e) => [e.id, e.signerName, Array.from(e.signature?.png ?? [])])).toEqual(
        before.map((e) => [e.id, e.signerName, Array.from(e.signature?.png ?? [])]),
      );
    });
  }

  it("el archivo de UNA firma cifrado (signVaultFile sobre passwordBox) sigue funcionando en jsdom", async () => {
    const exported = await exportVaultEntry(vaultInput("Ana Pérez"), { password: "pw" });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const imported = await importVaultFile(exported.blob, { password: "pw" });
    expect(imported.ok).toBe(true);
    expect(await importVaultFile(exported.blob, { password: "mala" })).toEqual({ ok: false, reason: "wrongPassword" });
  });
});
