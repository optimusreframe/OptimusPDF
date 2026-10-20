import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearVault, listVault, type VaultEntry } from "@/app/sign-pdf/signVault";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  applySignaturesImport,
  defaultSignatureDecisions,
  planSignaturesImport,
  signaturesModuleFromEntries,
  type ImportPlan,
} from "@/lib/backup/modules/signatures";
import { vaultEntry } from "@/lib/backup/__fixtures__/testKit";

/**
 * H9a (verificación independiente): quitar `revalidate` de `applySignaturesImport` no hacía fallar ninguna prueba; con
 * un plan manipulado (p. ej. un PNG al que le falta IEND) la entrada se escribía. El plan puede venir de la interfaz, así
 * que aplicar vuelve a validar CADA entrada aprobada con los mismos validadores y no escribe nada si alguna no vale.
 */

beforeEach(async () => {
  await clearVault();
});

async function freshPlan(): Promise<ImportPlan> {
  const blob = await buildPackage({ modules: [signaturesModuleFromEntries([vaultEntry("v1", "Ana Pérez")])] });
  return planSignaturesImport(await readPackage(blob), []);
}

type Tamper = (entry: VaultEntry) => void;

const TAMPERS: Array<[string, Tamper]> = [
  ["PNG de la firma sin IEND", (e) => { const png = (e.signature as NonNullable<VaultEntry["signature"]>).png; (e.signature as NonNullable<VaultEntry["signature"]>).png = png.slice(0, png.length - 12); }],
  ["PNG de las iniciales sin IEND", (e) => { const png = (e.initials as NonNullable<VaultEntry["initials"]>).png; (e.initials as NonNullable<VaultEntry["initials"]>).png = png.slice(0, png.length - 12); }],
  ["ancho declarado que no es el del PNG", (e) => { (e.signature as NonNullable<VaultEntry["signature"]>).width += 7; }],
  ["alto declarado que no es el del PNG", (e) => { (e.initials as NonNullable<VaultEntry["initials"]>).height += 3; }],
  ["PNG que no es un PNG", (e) => { (e.signature as NonNullable<VaultEntry["signature"]>).png = new Uint8Array([1, 2, 3, 4]); }],
  ["clave de firmante que no corresponde al nombre", (e) => { e.signerKey = "otra persona"; }],
  ["sin firma ni iniciales", (e) => { e.signature = null; e.initials = null; }],
];

describe("H9a — un plan manipulado no escribe nada en el baúl", () => {
  for (const [name, tamper] of TAMPERS) {
    it(`${name} -> invalid, baúl intacto`, async () => {
      const plan = await freshPlan();
      const item = plan.items[0];
      expect(item.entry).toBeDefined();
      tamper(item.entry as VaultEntry);
      const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
      expect(result).toEqual({ ok: false, reason: "invalid" });
      expect((await listVault()).entries).toHaveLength(0);
    });
  }

  it("control: sin manipular, el mismo plan se aplica", async () => {
    const plan = await freshPlan();
    expect(await applySignaturesImport(plan, defaultSignatureDecisions(plan))).toMatchObject({ ok: true, written: 1 });
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("una entrada manipulada que NO está aprobada no impide aplicar las demás (solo se revalida lo que se escribe)", async () => {
    const blob = await buildPackage({
      modules: [signaturesModuleFromEntries([vaultEntry("v1", "Ana Pérez", { sig: 1, ini: 2 }), vaultEntry("v2", "Luis Gómez", { sig: 3, ini: 4 })])],
    });
    const plan = await planSignaturesImport(await readPackage(blob), []);
    const [a, b] = plan.items;
    const png = (b.entry as VaultEntry).signature!.png;
    (b.entry as VaultEntry).signature!.png = png.slice(0, png.length - 12);
    const decisions = { ...defaultSignatureDecisions(plan), [b.id]: "omit" as const };
    expect(await applySignaturesImport(plan, decisions)).toMatchObject({ ok: true, written: 1 });
    expect((await listVault()).entries.map((e) => e.signerName)).toEqual([(a.entry as VaultEntry).signerName]);
  });
});
