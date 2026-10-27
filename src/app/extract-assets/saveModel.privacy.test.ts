import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearVault, listVault } from "@/app/sign-pdf/signVault";
import { vaultFilename } from "@/app/sign-pdf/signVaultFile";
import { makeImage } from "@/app/sign-pdf/vaultTestUtils";
import type { PreparedInk } from "@/app/sign-pdf/inkImportModel";
import { signaturesModuleFromEntries } from "@/lib/backup/modules/signatures";
import { executeSave, planSave } from "@/app/extract-assets/saveModel";

/**
 * H14 (verificacion independiente): el bául guarda el nombre del PDF de origen (`sourceDocument`) de lo extraido, y es lo previsto:
 * se muestra en «Firmas guardadas» y el export POR ENTRADA lo mete en el nombre del archivo (casilla marcada por defecto). Lo que NO
 * puede pasar es que el paquete de respaldo («Respaldo y traslado», «Exportar todas mis firmas») lo filtre. Este test lo fija.
 */

beforeEach(async () => {
  await clearVault();
});

const SECRET = "Contrato Confidencial Mitigacion Garcia.pdf";
const ink = (seed: number): PreparedInk => {
  const image = makeImage({ seed, width: 60, height: 30 });
  return { png: image.png, width: image.width, height: image.height };
};

describe("sourceDocument de lo extraido", () => {
  it("se guarda en la entrada (informativo, solo en este dispositivo) junto con `origin: extracted`", async () => {
    const plan = planSave({ entries: [], choice: { kind: "new" }, kind: "signature", conflict: null, name: "Ines Duarte", role: "Titular", ink: ink(1), sourceDocument: SECRET });
    expect(plan.action).toBe("save");
    if (plan.action !== "save") return;
    expect(plan.input.origin).toBe("extracted");
    expect(plan.input.sourceDocument).toBe(SECRET);
    expect((await executeSave(plan)).ok).toBe(true);
    const listed = await listVault();
    expect(listed.ok && listed.entries[0].sourceDocument).toBe(SECRET);
    expect(listed.ok && listed.entries[0].origin).toBe("extracted");
  });

  it("el paquete de respaldo NO lo lleva: ni en `signatures/index.json` ni en ningun archivo, pero si conserva el origen", async () => {
    const plan = planSave({ entries: [], choice: { kind: "new" }, kind: "signature", conflict: null, name: "Ines Duarte", role: "", ink: ink(2), sourceDocument: SECRET });
    if (plan.action !== "save") throw new Error("plan");
    await executeSave(plan);
    const listed = await listVault();
    if (!listed.ok) throw new Error("baul");
    const pack = signaturesModuleFromEntries(listed.entries);
    const text = new TextDecoder();
    for (const file of pack.files) {
      if (file.type === "application/json") {
        const json = text.decode(file.data);
        expect(json).not.toContain("Confidencial");
        expect(json).not.toContain("sourceDocument");
        expect(json).not.toContain(".pdf");
        expect(JSON.parse(json)[0].origin).toBe("extracted");
      }
      expect(file.path).not.toMatch(/confidencial|garcia|contrato/i);
    }
    expect(JSON.stringify(pack.meta)).not.toContain("Confidencial");
  });

  it("el export por entrada SI usa el documento en el nombre del archivo (lo previsto, con casilla): se sigue pudiendo omitir", () => {
    expect(vaultFilename("Ines Duarte", SECRET)).toBe("Firma-ines-duarte-contrato-confidencial-mitigacion-garcia.zip");
    expect(vaultFilename("Ines Duarte")).toBe("Firma-ines-duarte.zip");
  });
});
