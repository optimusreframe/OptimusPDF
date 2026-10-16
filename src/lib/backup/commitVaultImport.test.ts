import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_ENTRIES,
  MAX_VAULT_IMAGE_BYTES,
  MAX_VAULT_TOTAL_BYTES,
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

  // Estas pruebas llenan el baul hasta el tope real de 20 MiB dentro de fake-indexeddb (clonado estructurado de ~20 MB por
  // prueba): en el runner de CI (2 nucleos compartidos) tardan > 30 s, asi que llevan un plazo propio y holgado.
  describe("T2 — tope de 20 MB comprobado DENTRO de la transaccion (guarda contra la carrera entre pestañas)", { timeout: 180_000 }, () => {
    const FULL = MAX_VAULT_IMAGE_BYTES; // 600 KB: lo maximo de una imagen
    const bytesOf = (entries: VaultEntry[]) =>
      entries.reduce((sum, e) => sum + (e.signature?.png.byteLength ?? 0) + (e.initials?.png.byteLength ?? 0), 0);
    /**
     * Igualdad profunda del baul SIN `toEqual` sobre ~20 MB de bytes (el recorrido de `pretty-format`/`equals` por
     * `Uint8Array` es el que hacia lentas estas pruebas): mismo orden, mismos campos y bytes con `Buffer.compare`.
     */
    const sameVault = (a: VaultEntry[], b: VaultEntry[]): boolean =>
      a.length === b.length &&
      a.every((x, i) => {
        const y = b[i];
        const same = (p?: { png: Uint8Array } | null, q?: { png: Uint8Array } | null) =>
          (!p && !q) || (!!p && !!q && Buffer.compare(Buffer.from(p.png), Buffer.from(q.png)) === 0);
        return (
          x.id === y.id &&
          x.signerName === y.signerName &&
          x.signerKey === y.signerKey &&
          same(x.signature, y.signature) &&
          same(x.initials, y.initials)
        );
      });
    /** 17 firmas con firma e iniciales de 600 KB: 20.889.600 bytes, quedan 81.920 hasta los 20 MiB. */
    async function fillNearly() {
      const puts = Array.from({ length: 17 }, (_, i) => ({
        ...vaultEntry(`vault-${i}`, `Persona ${i}`, { sig: 200 + i, ini: 300 + i }),
        signature: makeImage({ seed: 200 + i, totalBytes: FULL }),
        initials: makeImage({ width: 20, height: 20, seed: 300 + i, totalBytes: FULL }),
      }));
      expect(await commitVaultImport({ puts, deleteIds: [] })).toMatchObject({ ok: true, written: 17 });
      const all = await list();
      expect(bytesOf(all)).toBe(17 * 2 * FULL);
      return all;
    }

    it("lo que pasa del tope se rechaza con `limit` y NO se escribe nada (ni lo que si cabia)", async () => {
      const all = await fillNearly();
      const room = MAX_VAULT_TOTAL_BYTES - bytesOf(all);
      expect(room).toBe(81_920);
      const small = vaultEntry("vault-ok", "Cabe", { sig: 1, ini: null });
      const tooBig = { ...vaultEntry("vault-big", "No cabe", { sig: 2, ini: null }), signature: makeImage({ seed: 2, totalBytes: room + 1 }) };
      expect(await commitVaultImport({ puts: [small, tooBig], deleteIds: [] })).toEqual({ ok: false, reason: "limit" });
      expect(sameVault(await list(), all)).toBe(true);
    });

    it("el borde es exacto: justo 20 MiB entra; un byte mas no", async () => {
      const all = await fillNearly();
      const room = MAX_VAULT_TOTAL_BYTES - bytesOf(all);
      const exact = { ...vaultEntry("vault-exact", "Justo", { sig: 3, ini: null }), signature: makeImage({ seed: 3, totalBytes: room }) };
      expect(await commitVaultImport({ puts: [exact], deleteIds: [] })).toMatchObject({ ok: true, written: 1 });
      expect(bytesOf(await list())).toBe(MAX_VAULT_TOTAL_BYTES);
      // lleno hasta el byte: cualquier otra, por pequeña que sea, ya no cabe
      const before = await list();
      expect(await commitVaultImport({ puts: [vaultEntry("vault-uno-mas", "Una mas", { sig: 4, ini: null })], deleteIds: [] })).toEqual({ ok: false, reason: "limit" });
      expect(sameVault(await list(), before)).toBe(true);
    });

    it("contra el baul de AHORA, no contra el de la vista previa: otra pestaña lo llena entre medias", async () => {
      const wanted = vaultEntry("vault-wanted", "Querida", { sig: 5, ini: null });
      // la «vista previa» vio un baul vacio: cabe
      expect(bytesOf([wanted])).toBeLessThan(MAX_VAULT_TOTAL_BYTES);
      const all = await fillNearly(); // otra pestaña
      const big = { ...wanted, signature: makeImage({ seed: 5, totalBytes: 100_000 }) };
      expect(await commitVaultImport({ puts: [big], deleteIds: [] })).toEqual({ ok: false, reason: "limit" });
      expect(sameVault(await list(), all)).toBe(true);
    });

    it("sustituir libera sitio: con el baul al limite, reemplazar una de 1,2 MB por otra igual cabe; por otra que ademas pase de lo libre, no", async () => {
      const all = await fillNearly();
      const victim = all[0];
      const bigAgain = {
        ...vaultEntry("vault-new", "Reemplazo", { sig: 6, ini: 7 }),
        signature: makeImage({ seed: 6, totalBytes: FULL }),
        initials: makeImage({ width: 20, height: 20, seed: 7, totalBytes: FULL }),
      };
      // 17 firmas + 81.920 libres: la nueva ocupa lo mismo que la que se borra
      expect(await commitVaultImport({ puts: [bigAgain], deleteIds: [victim.id] })).toMatchObject({ ok: true, written: 1, deleted: 1 });
      expect(bytesOf(await list())).toBe(17 * 2 * FULL);
      const after = await list();
      const two = [
        {
          ...vaultEntry("vault-p", "P", { sig: 8, ini: 10 }),
          signature: makeImage({ seed: 8, totalBytes: FULL }),
          initials: makeImage({ width: 20, height: 20, seed: 10, totalBytes: FULL }),
        },
        { ...vaultEntry("vault-q", "Q", { sig: 9, ini: null }), signature: makeImage({ seed: 9, totalBytes: 100_000 }) },
      ];
      expect(await commitVaultImport({ puts: two, deleteIds: [after[0].id] })).toEqual({ ok: false, reason: "limit" });
      expect(await list()).toEqual(after);
    });
  });

  it("D4 — `expectUnchanged`: si la entrada que se iba a reemplazar ya no es la de la vista previa, `changed` y NADA se escribe", async () => {
    const seen = vaultEntry("vault-a", "Ana", { sig: 1, ini: null });
    expect(await commitVaultImport({ puts: [seen], deleteIds: [] })).toMatchObject({ ok: true });
    const incoming = vaultEntry("vault-n", "Ana", { sig: 2, ini: 3 });
    const input = { puts: [incoming], deleteIds: ["vault-a"], expectUnchanged: [(await list())[0]] };
    // sin cambios: pasa
    expect(await commitVaultImport(input)).toMatchObject({ ok: true, written: 1, deleted: 1 });
    // ahora la «vista previa» ve a vault-n y otra pestaña la toca antes de reemplazar
    const preview = (await list())[0];
    await commitVaultImport({ puts: [{ ...preview, initials: null }], deleteIds: [preview.id] });
    const current = await list();
    const result = await commitVaultImport({ puts: [vaultEntry("vault-m", "Ana", { sig: 4, ini: null })], deleteIds: [preview.id], expectUnchanged: [preview] });
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(await list()).toEqual(current);
    // una entrada esperada que no es valida no es una guarda: `invalid`
    expect(await commitVaultImport({ puts: [], deleteIds: [], expectUnchanged: [{ id: 5 } as never] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitVaultImport({ puts: [], deleteIds: [], expectUnchanged: "x" as never })).toEqual({ ok: false, reason: "invalid" });
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
