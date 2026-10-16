import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_ENTRIES,
  MAX_VAULT_IMAGE_BYTES,
  clearVault,
  commitVaultImport,
  deleteVaultEntry,
  isStoredEntry,
  listVault,
  saveVaultEntry,
  subscribeToVault,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { makeImage } from "@/lib/backup/__fixtures__/pngFactory";
import { vaultEntry, vaultInput } from "@/lib/backup/__fixtures__/testKit";

/**
 * `commitVaultImport` (aditivo en `signVault.ts`): la escritura en bloque,
 * todo o nada, que usa la importacion del respaldo.
 */

beforeEach(async () => {
  await clearVault();
});

const list = async () => (await listVault()).entries;

describe("commitVaultImport — src/app/sign-pdf/signVault.ts", () => {
  it("escribe todas las entradas en una transaccion y avisa del cambio una vez", async () => {
    const changed = vi.fn();
    const off = subscribeToVault(changed);
    const result = await commitVaultImport({
      puts: [vaultEntry("vault-a", "Ana", { sig: 1 }), vaultEntry("vault-b", "Beto", { sig: 2 })],
      deleteIds: [],
    });
    off();
    expect(result).toEqual({ ok: true, written: 2, skipped: 0, deleted: 0 });
    expect((await list()).map((e) => e.id).sort()).toEqual(["vault-a", "vault-b"]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("borra los destinos y escribe las nuevas a la vez (sustitucion)", async () => {
    await saveVaultEntry(vaultInput("Ana", { sig: 9, ini: null }));
    const [old] = await list();
    const result = await commitVaultImport({ puts: [vaultEntry("vault-n", "Ana", { sig: 1 })], deleteIds: [old.id] });
    expect(result).toEqual({ ok: true, written: 1, skipped: 0, deleted: 1 });
    expect((await list()).map((e) => e.id)).toEqual(["vault-n"]);
  });

  it("una entrada que ya cubre otra del mismo firmante se OMITE; contra una borrada en la misma operacion, no", async () => {
    await saveVaultEntry(vaultInput("Ana", { sig: 1, ini: 2 }));
    const [existing] = await list();
    const dup = { ...vaultEntry("vault-dup", "ANA", { sig: 1, ini: 2 }), signerName: "Ana" };
    expect(await commitVaultImport({ puts: [dup], deleteIds: [] })).toMatchObject({ ok: true, written: 0, skipped: 1 });
    // si la cubridora se borra en la misma operacion, ya no cubre
    expect(await commitVaultImport({ puts: [dup], deleteIds: [existing.id] })).toMatchObject({ ok: true, written: 1, deleted: 1 });
    // otro firmante con las mismas imagenes NO se omite
    expect(await commitVaultImport({ puts: [vaultEntry("vault-otro", "Otro", { sig: 1, ini: 2 })], deleteIds: [] })).toMatchObject({ written: 1 });
  });

  it("un id ya ocupado recibe un id nuevo en vez de pisar la entrada existente", async () => {
    await saveVaultEntry(vaultInput("Ana", { sig: 1 }));
    const [existing] = await list();
    const clash = vaultEntry(existing.id, "Beto", { sig: 5 });
    expect(await commitVaultImport({ puts: [clash], deleteIds: [] })).toMatchObject({ ok: true, written: 1 });
    const all = await list();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.id === existing.id)?.signerName).toBe("Ana");
  });

  it("limites sobre el resultado FINAL: 30 entradas; con borrados que liberan sitio si cabe; nada se escribe si no", async () => {
    for (let i = 0; i < MAX_VAULT_ENTRIES; i += 1) await saveVaultEntry(vaultInput(`E${i}`, { sig: 100 + i, ini: null }));
    const before = await list();
    expect(await commitVaultImport({ puts: [vaultEntry("vault-x", "Nueva", { sig: 7 })], deleteIds: [] })).toEqual({ ok: false, reason: "limit" });
    expect(await list()).toEqual(before);
    expect(await commitVaultImport({ puts: [vaultEntry("vault-x", "Nueva", { sig: 7 })], deleteIds: [before[0].id] })).toMatchObject({ ok: true, written: 1, deleted: 1 });
    expect(await list()).toHaveLength(MAX_VAULT_ENTRIES);
  });

  it("entradas invalidas se rechazan ANTES de abrir la base: PNG falso, clave que no corresponde, sin imagenes, ids repetidos, nombre largo, bytes de mas", async () => {
    const good = vaultEntry("vault-a", "Ana");
    const bad: [string, VaultEntry[], string][] = [
      ["png falso", [{ ...good, signature: { ...good.signature!, png: new Uint8Array(40) } }], "invalid"],
      ["clave ajena", [{ ...good, signerKey: "otra" }], "invalid"],
      ["sin imagenes", [{ ...good, signature: null, initials: null }], "invalid"],
      ["ids repetidos", [good, { ...vaultEntry("vault-a", "Beto", { sig: 5 }) }], "invalid"],
      ["nombre largo", [{ ...good, signerName: "x".repeat(201), signerKey: "x".repeat(201) }], "invalid"],
      ["no es una entrada", [{ id: 5 } as never], "invalid"],
      [
        "imagen de mas de 600 KB",
        [{ ...good, signature: { ...makeImage({ seed: 3, totalBytes: MAX_VAULT_IMAGE_BYTES + 1 }) } }],
        "tooLarge",
      ],
    ];
    for (const [label, puts, reason] of bad) {
      expect([label, await commitVaultImport({ puts, deleteIds: [] })]).toEqual([label, { ok: false, reason }]);
    }
    expect(await commitVaultImport({ puts: "x" as never, deleteIds: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitVaultImport({ puts: [], deleteIds: [5 as never] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitVaultImport(null as never)).toEqual({ ok: false, reason: "invalid" });
    expect(await list()).toEqual([]);
  });

  it("sin IndexedDB devuelve `unavailable` sin lanzar", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await commitVaultImport({ puts: [vaultEntry("vault-a", "Ana")], deleteIds: [] })).toEqual({ ok: false, reason: "unavailable" });
    vi.unstubAllGlobals();
  });

  it("deleteVaultEntry y la API anterior siguen intactas junto a la nueva", async () => {
    await commitVaultImport({ puts: [vaultEntry("vault-a", "Ana")], deleteIds: [] });
    expect(isStoredEntry((await list())[0])).toBe(true);
    expect(await deleteVaultEntry("vault-a")).toEqual({ ok: true });
    expect(await list()).toEqual([]);
  });
});
