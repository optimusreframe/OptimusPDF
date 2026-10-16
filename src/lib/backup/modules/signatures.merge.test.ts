import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVault,
  commitVaultImport,
  listVault,
  subscribeToVault,
  touchVaultEntry,
  updateVaultEntry,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { decisionOptions } from "@/app/sign-pdf/backupModel";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  applySignaturesImport,
  defaultSignatureDecisions,
  planSignaturesImport,
  signaturesModuleFromEntries,
  type ImportPlan,
  type PlanOptions,
} from "@/lib/backup/modules/signatures";
import { makeImage } from "@/lib/backup/__fixtures__/pngFactory";
import { replaceFile, vaultEntry } from "@/lib/backup/__fixtures__/testKit";

/**
 * U4.4-fix: lo que el verificador independiente encontro en la FUSION de «Importar firmas» — D2 (firmante renombrado:
 * «Reemplazar» deshacia el cambio y perdia el cargo), D3 (un id que coincide con el de OTRA persona), D4 (otra pestaña
 * cambio la entrada entre la vista previa y «Reemplazar»), T1 (lista blanca de `origin`), ids unicos de tarjetas
 * invalidas y el gancho de validacion de imagen (D5).
 */

beforeEach(async () => {
  await clearVault();
});

const vaultList = async (): Promise<VaultEntry[]> => (await listVault()).entries;

async function put(...entries: VaultEntry[]): Promise<void> {
  const result = await commitVaultImport({ puts: entries, deleteIds: [] });
  if (!result.ok) throw new Error(`put: ${result.reason}`);
}

async function planOf(
  packaged: VaultEntry[],
  vault: VaultEntry[],
  options?: PlanOptions,
): Promise<ImportPlan> {
  const blob = await buildPackage({ modules: [signaturesModuleFromEntries(packaged)] });
  return planSignaturesImport(await readPackage(blob), vault, options);
}

const withRole = (entry: VaultEntry, role: string): VaultEntry => ({ ...entry, role });
const noRole = (entry: VaultEntry): VaultEntry => {
  const { role: _role, ...rest } = entry;
  void _role;
  return rest;
};

async function hashes(entry: VaultEntry | undefined): Promise<[string, string]> {
  return [
    entry?.signature ? await sha256Hex(entry.signature.png) : "-",
    entry?.initials ? await sha256Hex(entry.initials.png) : "-",
  ];
}

describe("D2 — firmante renombrado con los mismos dibujos (src/lib/backup/modules/signatures.ts)", () => {
  /** Baul: «Anita Pérez», cargo «Directora», id vault-a. Paquete: vault-a = «Ana Pérez», mismas imagenes, sin cargo. */
  async function scenario(extra?: { packageRole?: string; packageOnlySignature?: boolean }) {
    const mine = withRole(vaultEntry("vault-a", "Anita Pérez", { sig: 1, ini: 2 }), "Directora");
    await put(mine);
    const fromFile = vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: extra?.packageOnlySignature ? null : 2 });
    const plan = await planOf([extra?.packageRole ? withRole(fromFile, extra.packageRole) : fromFile], await vaultList());
    return { mine, plan, item: plan.items[0] };
  }

  it("sale «Mismos dibujos, datos distintos» (difference=data), con la nota correcta de QUE cambia y NO la de «otra imagen»", async () => {
    const { item } = await scenario();
    expect(item).toMatchObject({
      status: "different",
      difference: "data",
      differs: ["name"],
      canReplace: true,
      supersedes: true,
      conflictWith: { id: "vault-a", signerName: "Anita Pérez", role: "Directora" },
    });
  });

  it("si el paquete trae OTRO cargo, tambien se dice (name + role); sin cargo en el paquete no cuenta como diferencia", async () => {
    expect((await scenario({ packageRole: "Gerente" })).item.differs).toEqual(["name", "role"]);
    expect((await scenario({ packageRole: "Directora" })).item.differs).toEqual(["name"]);
    expect((await scenario()).item.differs).toEqual(["name"]);
  });

  it("la decision por defecto es «Conservar la que ya tienes» (omit): aplicarla no toca NADA", async () => {
    const { plan, mine } = await scenario();
    expect(defaultSignatureDecisions(plan)).toEqual({ "vault-a": "omit" });
    const before = await vaultList();
    expect(await applySignaturesImport(plan, defaultSignatureDecisions(plan))).toMatchObject({ ok: true, written: 0 });
    expect(await vaultList()).toEqual(before);
    expect(before[0]).toMatchObject({ signerName: "Anita Pérez", role: "Directora", id: mine.id });
  });

  it("«Reemplazar» actualiza el nombre y CONSERVA el cargo (nunca lo pone a null), las imagenes, las fechas y el id", async () => {
    const { plan, mine } = await scenario();
    expect(await applySignaturesImport(plan, { "vault-a": "replace" })).toMatchObject({ ok: true, written: 1, replaced: 1 });
    const list = await vaultList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "vault-a",
      signerName: "Ana Pérez",
      signerKey: "ana perez",
      role: "Directora",
      createdAt: mine.createdAt,
      lastUsedAt: mine.lastUsedAt,
    });
    expect(await hashes(list[0])).toEqual(await hashes(mine));
  });

  it("«Reemplazar» con un cargo en el paquete lo actualiza", async () => {
    const { plan } = await scenario({ packageRole: "Gerente" });
    await applySignaturesImport(plan, { "vault-a": "replace" });
    expect((await vaultList())[0]).toMatchObject({ signerName: "Ana Pérez", role: "Gerente" });
  });

  it("si el paquete trae MENOS imagenes que la entrada renombrada, reemplazar no pierde las que ya tienes", async () => {
    const { plan, mine } = await scenario({ packageOnlySignature: true });
    expect(plan.items[0]).toMatchObject({ status: "different", difference: "data", hasInitials: false });
    await applySignaturesImport(plan, { "vault-a": "replace" });
    const [after] = await vaultList();
    expect(after.signerName).toBe("Ana Pérez");
    expect(await hashes(after)).toEqual(await hashes(mine)); // sigue con las iniciales
  });

  it("las opciones de la tarjeta son Reemplazar y Omitir (conservar ambos duplicaria los dibujos)", async () => {
    const { item } = await scenario();
    expect(decisionOptions(item.status, item)).toEqual(["replace", "omit"]);
  });

  it("la nota «con otra imagen» queda solo para cuando las imagenes SI difieren (difference=images)", async () => {
    await put(withRole(vaultEntry("vault-a", "Ana Pérez", { sig: 9, ini: 8 }), "Directora"));
    const plan = await planOf([vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 })], await vaultList());
    expect(plan.items[0]).toMatchObject({ status: "different", difference: "images", canReplace: true });
    expect(plan.items[0].differs).toBeUndefined();
  });

  it("mismo firmante e imagenes iguales sigue siendo «identico» aunque cambie el nombre solo en mayusculas (regresion)", async () => {
    await put(vaultEntry("vault-a", "ANA PEREZ", { sig: 1, ini: 2 }));
    const plan = await planOf([vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 })], await vaultList());
    expect(plan.items[0].status).toBe("identical");
  });
});

describe("«Reemplazar» nunca borra el cargo si el paquete no trae uno (imagenes distintas)", () => {
  it("mismo firmante, imagenes de mas en el archivo, sin cargo: el cargo del baul se conserva", async () => {
    await put(withRole(vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: null }), "Directora"));
    const plan = await planOf([noRole(vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 }))], await vaultList());
    expect(defaultSignatureDecisions(plan)).toEqual({ "vault-a": "replace" });
    await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    const [after] = await vaultList();
    expect(after).toMatchObject({ signerName: "Ana Pérez", role: "Directora" });
    expect(after.initials).not.toBeNull();
  });

  it("si el paquete trae cargo, gana el del paquete", async () => {
    await put(withRole(vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: null }), "Directora"));
    const plan = await planOf([withRole(vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 }), "Gerente")], await vaultList());
    await applySignaturesImport(plan, { "vault-a": "replace" });
    expect((await vaultList())[0].role).toBe("Gerente");
  });
});

describe("D3 — un id del paquete que coincide con el de OTRA persona", () => {
  async function scenario() {
    const luis = vaultEntry("vault-l", "Luis", { sig: 5, ini: null });
    await put(luis);
    const plan = await planOf([vaultEntry("vault-l", "Ana", { sig: 1, ini: 2 })], await vaultList());
    return { luis, plan, item: plan.items[0] };
  }

  it("es «distinto» pero NO se puede reemplazar: solo conservar ambos u omitir (por defecto conservar ambos)", async () => {
    const { plan, item } = await scenario();
    expect(item).toMatchObject({
      status: "different",
      difference: "images",
      canReplace: false,
      conflictWith: { id: "vault-l", signerName: "Luis" },
    });
    expect(decisionOptions(item.status, item)).toEqual(["keepBoth", "omit"]);
    expect(defaultSignatureDecisions(plan)).toEqual({ "vault-l": "keepBoth" });
  });

  it("aunque la decision llegue como «replace», la firma de Luis NO se borra y no se escribe nada", async () => {
    const { plan, luis } = await scenario();
    const before = await vaultList();
    expect(await applySignaturesImport(plan, { "vault-l": "replace" })).toMatchObject({ ok: true, written: 0, replaced: 0 });
    expect(await vaultList()).toEqual(before);
    expect(before[0].id).toBe(luis.id);
  });

  it("«Conservar ambos» guarda a Ana con un id NUEVO y deja a Luis intacto", async () => {
    const { plan, luis } = await scenario();
    expect(await applySignaturesImport(plan, { "vault-l": "keepBoth" })).toMatchObject({ ok: true, written: 1, replaced: 0 });
    const list = await vaultList();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.signerName === "Luis")).toMatchObject({ id: "vault-l" });
    expect(await hashes(list.find((e) => e.signerName === "Luis"))).toEqual(await hashes(luis));
    expect(list.find((e) => e.signerName === "Ana")?.id).not.toBe("vault-l");
  });

  it("si Ana YA existe en el baul con otro id, el destino de «Reemplazar» es ELLA (misma persona), nunca Luis", async () => {
    await put(vaultEntry("vault-z", "Ana", { sig: 9, ini: null }));
    const { plan, item, luis } = await scenario();
    expect(item).toMatchObject({ status: "different", canReplace: true, conflictWith: { id: "vault-z", signerName: "Ana" } });
    expect(await applySignaturesImport(plan, { "vault-l": "replace" })).toMatchObject({ ok: true, written: 1, replaced: 1 });
    const list = await vaultList();
    expect(list.map((e) => e.signerName).sort()).toEqual(["Ana", "Luis"]);
    expect(list.find((e) => e.signerName === "Luis")?.id).toBe(luis.id);
    expect(list.find((e) => e.id === "vault-z")).toBeUndefined();
  });

  it("mismo id con OTRO nombre pero imagenes DISTINTAS tambien es otra persona; con las mismas imagenes es un renombrado", async () => {
    await put(vaultEntry("vault-l", "Luis", { sig: 5, ini: 6 }));
    const otherPerson = (await planOf([vaultEntry("vault-l", "Ana", { sig: 1, ini: 2 })], await vaultList())).items[0];
    expect(otherPerson).toMatchObject({ difference: "images", canReplace: false });
    const rename = (await planOf([vaultEntry("vault-l", "Luisa", { sig: 5, ini: 6 })], await vaultList())).items[0];
    expect(rename).toMatchObject({ difference: "data", canReplace: true });
    // una sola imagen en comun no basta si la otra difiere
    const half = (await planOf([vaultEntry("vault-l", "Luisa", { sig: 5, ini: 7 })], await vaultList())).items[0];
    expect(half).toMatchObject({ difference: "images", canReplace: false });
  });
});

describe("D4 — otra pestaña cambia la entrada entre la vista previa y «Reemplazar»", () => {
  async function scenario() {
    const target = vaultEntry("vault-a", "Ana Pérez", { sig: 9, ini: null });
    await put(target);
    const newcomer = vaultEntry("vault-n", "Nueva Persona", { sig: 40, ini: null });
    const plan = await planOf(
      [vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 }), newcomer],
      await vaultList(),
    );
    expect(plan.items.map((i) => i.status)).toEqual(["different", "new"]);
    return { target, plan, decisions: { "vault-a": "replace", "vault-n": "import" } as const };
  }

  it("la otra pestaña añadio las iniciales a la entrada objetivo: se aborta TODO (ni reemplazo ni lo nuevo), 'changed'", async () => {
    const { target, plan, decisions } = await scenario();
    // «otra pestaña»
    const withInitials = { ...target, initials: makeImage({ width: 20, height: 20, seed: 77 }) };
    await commitVaultImport({ puts: [withInitials], deleteIds: [target.id] });
    const afterOtherTab = await vaultList();
    expect(afterOtherTab[0].initials).not.toBeNull();

    const changed = vi.fn();
    const off = subscribeToVault(changed);
    const result = await applySignaturesImport(plan, decisions);
    off();
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(await vaultList()).toEqual(afterOtherTab); // las iniciales siguen ahi y nadie escribio
    expect(changed).not.toHaveBeenCalled();
  });

  it("detecta tambien un cambio de nombre, de cargo, de la firma o que la entrada ya no exista", async () => {
    const edits: [string, (target: VaultEntry) => Promise<void>][] = [
      ["cargo", async (t) => void (await updateVaultEntry(t.id, { role: "Otro cargo" }))],
      ["nombre", async (t) => void (await updateVaultEntry(t.id, { signerName: "Ana P." }))],
      [
        "firma",
        async (t) => void (await commitVaultImport({ puts: [{ ...t, signature: makeImage({ seed: 123 }) }], deleteIds: [t.id] })),
      ],
      ["borrada", async (t) => void (await commitVaultImport({ puts: [vaultEntry("vault-q", "Q", { sig: 3 })], deleteIds: [t.id] }))],
    ];
    for (const [label, edit] of edits) {
      await clearVault();
      const { target, plan, decisions } = await scenario();
      await edit(target);
      const snapshot = await vaultList();
      expect([label, await applySignaturesImport(plan, decisions)]).toEqual([label, { ok: false, reason: "changed" }]);
      expect([label, await vaultList()]).toEqual([label, snapshot]);
    }
  });

  it("usar la firma en otra pestaña (solo cambia `lastUsedAt`) NO aborta el reemplazo", async () => {
    const { target, plan, decisions } = await scenario();
    await touchVaultEntry(target.id);
    expect(await applySignaturesImport(plan, decisions)).toMatchObject({ ok: true, written: 2, replaced: 1 });
    expect((await vaultList()).map((e) => e.signerName).sort()).toEqual(["Ana Pérez", "Nueva Persona"]);
  });

  it("sin cambios el reemplazo funciona y una decision distinta de «reemplazar» no exige que la entrada siga igual", async () => {
    const { target, plan } = await scenario();
    await updateVaultEntry(target.id, { role: "Cambiado" });
    // solo se importa lo nuevo; la entrada «distinta» se omite: no hay nada que proteger
    expect(await applySignaturesImport(plan, { "vault-a": "omit", "vault-n": "import" })).toMatchObject({ ok: true, written: 1 });
    expect((await vaultList()).find((e) => e.id === target.id)?.role).toBe("Cambiado");
  });
});

describe("tarjetas invalidas con ids unicos (clave de React)", () => {
  it("un elemento valido llamado `invalid-2` no choca con el marcador del elemento invalido n.º 2, ni `x#3` con el repetido", async () => {
    const base = { createdAt: "2026-10-01T10:00:00Z", lastUsedAt: "2026-10-02T10:00:00Z" };
    const first = vaultEntry("invalid-2", "Ana", { sig: 1, ini: null });
    const blob = await buildPackage({ modules: [signaturesModuleFromEntries([first])] });
    const index = [
      { ...base, id: "invalid-2", signerName: "Ana", signature: "signatures/invalid-2-signature.png" },
      "una cadena", // posicion 2: marcador
      { ...base, id: "invalid-2", signerName: "Ana otra vez", signature: "signatures/invalid-2-signature.png" }, // repetido en la posicion 3
      null, // posicion 4
      { ...base, id: "../x", signerName: "Mal" }, // posicion 5
    ];
    const edited = await replaceFile(blob, "signatures/index.json", new TextEncoder().encode(JSON.stringify(index)));
    const plan = await planSignaturesImport(await readPackage(edited), []);
    const ids = plan.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan.items.map((i) => i.status)).toEqual(["new", "invalid", "invalid", "invalid", "invalid"]);
    // los sinteticos usan `#`, que ningun id real puede contener
    for (const item of plan.items.filter((i) => i.status === "invalid")) expect(item.id).toContain("#");
    expect(plan.items[0].id).toBe("invalid-2");
  });
});

describe("T1 — la lista blanca de `origin` en el plan descarta valores ajenos", () => {
  async function planWithOrigin(origin: unknown): Promise<ImportPlan> {
    const entry = vaultEntry("vault-a", "Ana", { sig: 1, ini: null });
    const blob = await buildPackage({ modules: [signaturesModuleFromEntries([entry])] });
    const index = [
      {
        id: "vault-a",
        signerName: "Ana",
        createdAt: "2026-10-01T10:00:00Z",
        lastUsedAt: "2026-10-02T10:00:00Z",
        signature: "signatures/vault-a-signature.png",
        ...(origin === undefined ? {} : { origin }),
      },
    ];
    const edited = await replaceFile(blob, "signatures/index.json", new TextEncoder().encode(JSON.stringify(index)));
    return planSignaturesImport(await readPackage(edited), []);
  }

  it("los cuatro valores de la lista pasan al plan Y a la entrada que se escribe", async () => {
    for (const origin of ["drawn", "typed", "uploaded", "extracted"] as const) {
      await clearVault();
      const plan = await planWithOrigin(origin);
      expect([origin, plan.items[0].origin, plan.items[0].entry?.origin]).toEqual([origin, origin, origin]);
      await applySignaturesImport(plan, defaultSignatureDecisions(plan));
      expect((await vaultList())[0].origin).toBe(origin);
    }
  });

  it("cualquier otro valor se ignora: la firma se importa SIN origen (ni en el plan ni en el baul)", async () => {
    const foreign: unknown[] = ["hacked", "DRAWN", "Drawn", " drawn", "drawn ", "", "__proto__", "constructor", "toString", "hasOwnProperty", 5, 0, true, null, ["drawn"], { a: 1 }, "x".repeat(300)];
    for (const origin of foreign) {
      await clearVault();
      const plan = await planWithOrigin(origin);
      expect([origin, plan.items[0].status, plan.items[0].origin, plan.items[0].entry && "origin" in plan.items[0].entry]).toEqual([origin, "new", undefined, false]);
      await applySignaturesImport(plan, defaultSignatureDecisions(plan));
      const [stored] = await vaultList();
      expect([origin, stored.origin, "origin" in stored]).toEqual([origin, undefined, false]);
    }
  });

  it("sin el campo, tampoco hay origen", async () => {
    const plan = await planWithOrigin(undefined);
    expect(plan.items[0].origin).toBeUndefined();
  });
});

describe("D5 — gancho `validateImage` del plan", () => {
  it("una imagen que el validador rechaza deja el elemento `invalid/invalidImage`; el resto sigue importable", async () => {
    const entries = [vaultEntry("vault-a", "Ana", { sig: 1, ini: 2 }), vaultEntry("vault-b", "Beto", { sig: 3, ini: null })];
    const bad = await sha256Hex(entries[0].initials!.png);
    const seen: string[] = [];
    const plan = await planOf(entries, [], {
      validateImage: async (png) => {
        const digest = await sha256Hex(png);
        seen.push(digest);
        return digest !== bad;
      },
    });
    expect(plan.items.map((i) => [i.id, i.status, i.reason])).toEqual([
      ["vault-a", "invalid", "invalidImage"],
      ["vault-b", "new", undefined],
    ]);
    expect(seen).toHaveLength(3); // firma+iniciales de Ana, firma de Beto
    expect(plan.counts).toMatchObject({ new: 1, invalid: 1 });
    expect(await applySignaturesImport(plan, defaultSignatureDecisions(plan))).toMatchObject({ ok: true, written: 1 });
    expect((await vaultList()).map((e) => e.signerName)).toEqual(["Beto"]);
  });

  it("solo se llama con imagenes que YA pasaron los validadores del baul (un PNG falso ni se pregunta)", async () => {
    const entry = vaultEntry("vault-a", "Ana", { sig: 1, ini: null });
    const blob = await buildPackage({ modules: [signaturesModuleFromEntries([entry])] });
    const broken = await replaceFile(blob, "signatures/vault-a-signature.png", new Uint8Array(60));
    const validateImage = vi.fn(async () => true);
    const plan = await planSignaturesImport(await readPackage(broken), [], { validateImage });
    expect(plan.items[0]).toMatchObject({ status: "invalid", reason: "invalidImage" });
    expect(validateImage).not.toHaveBeenCalled();
  });

  it("sin validador (paquetes dorados, pruebas con PNG sinteticos) el comportamiento no cambia", async () => {
    const plan = await planOf([vaultEntry("vault-a", "Ana", { sig: 1, ini: 2 })], []);
    expect(plan.items[0].status).toBe("new");
  });
});

describe("renombrar en el baul y reimportar — recorrido completo", () => {
  it("exportar, renombrar a «Anita», reimportar el paquete viejo: nada se pierde por defecto y el cargo sobrevive al reemplazo", async () => {
    await put(withRole(vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 }), "Directora"));
    const blob = await buildPackage({ modules: [signaturesModuleFromEntries(await vaultList())] });
    await updateVaultEntry("vault-a", { signerName: "Anita Pérez" });
    const plan = await planSignaturesImport(await readPackage(blob), await vaultList());
    expect(plan.items[0]).toMatchObject({ status: "different", difference: "data" });
    await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    expect((await vaultList())[0]).toMatchObject({ signerName: "Anita Pérez", role: "Directora" });
    await applySignaturesImport(plan, { "vault-a": "replace" });
    expect((await vaultList())[0]).toMatchObject({ signerName: "Ana Pérez", role: "Directora" });
  });
});
