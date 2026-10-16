import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  VAULT_ORIGINS,
  clearVault,
  commitVaultImport,
  getVaultEntry,
  isStoredEntry,
  isVaultOrigin,
  listVault,
  saveVaultEntry,
  touchVaultEntry,
  updateVaultEntry,
  type VaultEntry,
  type VaultOrigin,
} from "@/app/sign-pdf/signVault";
import { makeImage, vaultInput } from "@/app/sign-pdf/vaultTestUtils";

/** Campo opcional `origin` del baul (F6 · U6.2): validador, guardado, migracion (sin `origin` = valido) y propagacion. */

beforeEach(async () => {
  await clearVault();
});

function entry(extra: Record<string, unknown> = {}): VaultEntry {
  return {
    id: "vault-a",
    schema: 1,
    signerName: "Ana",
    signerKey: "ana",
    sourceDocument: "",
    createdAt: "2026-10-01T10:00:00.000Z",
    lastUsedAt: "2026-10-02T10:00:00.000Z",
    signature: makeImage({ seed: 1 }),
    initials: null,
    ...extra,
  } as VaultEntry;
}

/** Escribe un registro CRUDO en la base real del baul (sin pasar por la API): lo que dejaria una version anterior. */
async function putRaw(record: Record<string, unknown>): Promise<void> {
  await listVault(); // crea la base y el almacen
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("optimuspdf-signature-vault", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("signatures", "readwrite");
      tx.objectStore("signatures").put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe("isStoredEntry y origin", () => {
  it("origin ausente es valido (migracion: las firmas guardadas antes no lo traen)", () => {
    expect(isStoredEntry(entry())).toBe(true);
    expect(isStoredEntry(entry({ origin: undefined }))).toBe(true);
  });

  it("acepta cada valor de la lista", () => {
    expect([...VAULT_ORIGINS]).toEqual(["drawn", "typed", "uploaded", "extracted"]);
    for (const origin of VAULT_ORIGINS) expect(isStoredEntry(entry({ origin }))).toBe(true);
  });

  it("rechaza lo que no esta en la lista (otro texto, vacio, numero, null, objeto)", () => {
    for (const origin of ["hacked", "", "UPLOADED", 3, null, {}, ["uploaded"]]) {
      expect([origin, isStoredEntry(entry({ origin }))]).toEqual([origin, false]);
    }
    expect(isVaultOrigin("typed")).toBe(true);
    expect(isVaultOrigin("otro")).toBe(false);
    expect(isVaultOrigin(undefined)).toBe(false);
  });
});

describe("saveVaultEntry con origin", () => {
  it("guarda el origen tal cual y lo devuelve al listar y al leer", async () => {
    for (const origin of VAULT_ORIGINS) {
      await clearVault();
      const saved = await saveVaultEntry({ ...vaultInput("Ana"), origin });
      expect(saved.ok).toBe(true);
      expect((await listVault()).entries[0].origin).toBe(origin);
      if (saved.ok) expect((await getVaultEntry(saved.entry.id))?.origin).toBe(origin);
    }
  });

  it("sin origin no escribe la clave (el registro es el de siempre)", async () => {
    const saved = await saveVaultEntry(vaultInput("Ana"));
    expect(saved.ok && "origin" in saved.entry).toBe(false);
  });

  it("un origin que no es de la lista se rechaza como invalido y no guarda nada", async () => {
    const result = await saveVaultEntry({ ...vaultInput("Ana"), origin: "hacked" as unknown as VaultOrigin });
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("duplicado exacto: conserva el origen de la entrada que ya estaba", async () => {
    await saveVaultEntry({ ...vaultInput("Ana"), origin: "drawn" });
    const again = await saveVaultEntry({ ...vaultInput("Ana"), origin: "uploaded" });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect((await listVault()).entries[0].origin).toBe("drawn");
  });

  it("ampliar (firma sola -> firma + iniciales): manda el origen nuevo; si no trae, se conserva el anterior", async () => {
    await saveVaultEntry({ ...vaultInput("Ana", { initials: null }), origin: "typed" });
    await saveVaultEntry({ ...vaultInput("Ana"), origin: "uploaded" });
    let entries = (await listVault()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("uploaded");

    await clearVault();
    await saveVaultEntry({ ...vaultInput("Ana", { initials: null }), origin: "typed" });
    await saveVaultEntry(vaultInput("Ana"));
    entries = (await listVault()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("typed");
  });

  it("renombrar y marcar como usada no pierden el origen", async () => {
    const saved = await saveVaultEntry({ ...vaultInput("Ana"), origin: "uploaded" });
    if (!saved.ok) throw new Error("save");
    expect(await updateVaultEntry(saved.entry.id, { signerName: "Ana María" })).toMatchObject({ ok: true });
    expect(await touchVaultEntry(saved.entry.id)).toEqual({ ok: true });
    const [after] = (await listVault()).entries;
    expect(after.signerName).toBe("Ana María");
    expect(after.origin).toBe("uploaded");
  });
});

describe("migracion: registros de antes", () => {
  it("un registro CRUDO sin origin se lista y se puede usar (nada se descarta)", async () => {
    await putRaw(entry());
    const { entries } = await listVault();
    expect(entries.map((e) => e.id)).toEqual(["vault-a"]);
    expect("origin" in entries[0]).toBe(false);
  });

  it("un registro crudo con origin invalido no se lista (no se confia en el)", async () => {
    await putRaw(entry({ origin: "hacked" }));
    expect((await listVault()).entries).toHaveLength(0);
    expect(await getVaultEntry("vault-a")).toBeNull();
  });
});

describe("commitVaultImport con origin", () => {
  it("escribe el origen valido y rechaza uno ajeno sin escribir nada", async () => {
    expect(await commitVaultImport({ puts: [entry({ origin: "extracted" })], deleteIds: [] })).toMatchObject({ ok: true, written: 1 });
    expect((await listVault()).entries[0].origin).toBe("extracted");
    await clearVault();
    expect(await commitVaultImport({ puts: [entry({ origin: "hacked" })], deleteIds: [] })).toEqual({ ok: false, reason: "invalid" });
    expect((await listVault()).entries).toHaveLength(0);
  });
});
