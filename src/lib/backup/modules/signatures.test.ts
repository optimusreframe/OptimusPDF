import "fake-indexeddb/auto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_ENTRIES,
  MAX_VAULT_IMAGE_BYTES,
  MAX_VAULT_TOTAL_BYTES,
  clearVault,
  listVault,
  saveVaultEntry,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { DEFAULT_MODULE_REGISTRY } from "@/lib/backup/registry";
import { signaturesV1Identity } from "@/lib/backup/migrations/signatures/v1";
import {
  applySignaturesImport,
  checkSignaturesLimits,
  defaultSignatureDecisions,
  exportSignatures,
  planSignaturesImport,
  signaturesModuleFromEntries,
  type ImportPlan,
} from "@/lib/backup/modules/signatures";
import { makeImage, makePng } from "@/lib/backup/__fixtures__/pngFactory";
import {
  asFile,
  editManifest,
  replaceFile,
  rewriteZip,
  vaultEntry,
  vaultInput,
} from "@/lib/backup/__fixtures__/testKit";

/**
 * Modulo «Firmas» del respaldo sobre un IndexedDB real (fake-indexeddb) y PNG
 * sinteticos generados aqui: ida y vuelta, fusion sin duplicar, limites del
 * baul, atomicidad ante cuota y aislamiento de elementos corruptos.
 */

beforeEach(async () => {
  await clearVault();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seed(
  ...inputs: ReturnType<typeof vaultInput>[]
): Promise<void> {
  for (const input of inputs) {
    const result = await saveVaultEntry(input);
    if (!result.ok) throw new Error(`seed fallo: ${result.reason}`);
  }
}

async function vaultList(): Promise<VaultEntry[]> {
  const list = await listVault();
  return list.entries;
}

async function exportBlob(password?: string): Promise<Blob> {
  return buildPackage({ modules: [await exportSignatures()], password });
}

async function planFor(blob: Blob, password?: string): Promise<ImportPlan> {
  return planSignaturesImport(await readPackage(blob, password), await vaultList());
}

/** Huella comparable de un baul: firmante + hash de cada imagen. */
async function fingerprint(entries: VaultEntry[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of entries) {
    out.push(
      [
        entry.signerName,
        entry.role ?? "",
        entry.signature ? await sha256Hex(entry.signature.png) : "-",
        entry.initials ? await sha256Hex(entry.initials.png) : "-",
      ].join("|"),
    );
  }
  return out.sort();
}

/** Texto poco comprimible (para no disparar el limite de ratio del zip). */
function noise(length: number): string {
  let state = 12345;
  let out = "";
  while (out.length < length) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out += state.toString(36);
  }
  return out.slice(0, length);
}

async function moduleFiles(blob: Blob): Promise<string[]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return Object.keys(zip.files).sort();
}

describe("exportSignatures — src/lib/backup/modules/signatures.ts", () => {
  it("escribe signatures/index.json y un PNG por imagen, con manifiesto y SHA-256", async () => {
    await seed(vaultInput("Ana Pérez", { role: "Directora" }), vaultInput("Luis Gómez", { sig: 3, ini: null }));
    const blob = await exportBlob();
    const files = await moduleFiles(blob);
    const entries = await vaultList();
    expect(files).toContain("manifest.json");
    expect(files).toContain("signatures/index.json");
    for (const entry of entries) {
      expect(files).toContain(`signatures/${entry.id}-signature.png`);
    }
    expect(files.filter((f) => f.endsWith("-initials.png"))).toHaveLength(1);

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest).toMatchObject({
      format: "optimuspdf.package",
      formatVersion: 1,
      modules: { signatures: { schemaVersion: 1, count: 2 } },
    });
    for (const file of manifest.files) {
      const bytes = await zip.file(file.path)!.async("uint8array");
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(await sha256Hex(bytes));
    }
  });

  it("el indice no lleva signerKey ni el nombre del documento (privacidad) y no trae campos extra", async () => {
    await seed(vaultInput("Ana Pérez"));
    const zip = await JSZip.loadAsync(await (await exportBlob()).arrayBuffer());
    const text = await zip.file("signatures/index.json")!.async("text");
    expect(text).not.toContain("contrato-secreto");
    expect(text).not.toContain("signerKey");
    const [item] = JSON.parse(text);
    expect(Object.keys(item).sort()).toEqual(
      ["createdAt", "id", "initials", "lastUsedAt", "signature", "signerName"].sort(),
    );
  });

  it("conserva `origin` si la entrada ya lo trae y lo omite si no (campo opcional)", () => {
    const withOrigin = { ...vaultEntry("vault-a", "Ana"), origin: "typed" } as VaultEntry;
    const plain = vaultEntry("vault-b", "Luis");
    const moduleInput = signaturesModuleFromEntries([withOrigin, plain]);
    const index = JSON.parse(new TextDecoder().decode(moduleInput.files[0].data));
    expect(index.find((i: { id: string }) => i.id === "vault-a").origin).toBe("typed");
    expect("origin" in index.find((i: { id: string }) => i.id === "vault-b")).toBe(false);
    const bad = signaturesModuleFromEntries([{ ...vaultEntry("vault-c", "X"), origin: "hacked" } as unknown as VaultEntry]);
    expect(new TextDecoder().decode(bad.files[0].data)).not.toContain("hacked");
  });

  it("un baul vacio exporta un modulo valido con cero firmas", async () => {
    const blob = await exportBlob();
    const read = await readPackage(blob);
    const plan = await planSignaturesImport(read, []);
    expect(plan.state).toBe("ok");
    expect(plan.items).toEqual([]);
  });

  it("sin IndexedDB, exportSignatures lanza PackageError(unavailable)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(exportSignatures()).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("ida y vuelta — exportar -> importar en un baul vacio", () => {
  async function roundTrip(password?: string, readPassword?: string) {
    await seed(
      vaultInput("Ana Pérez", { role: "Directora" }),
      vaultInput("Luis Gómez", { sig: 3, ini: null }),
      vaultInput("Marta Ruiz", { sig: null, ini: 4 }),
    );
    const before = await vaultList();
    const blob = await exportBlob(password);
    await clearVault();
    const plan = await planFor(blob, readPassword ?? password);
    return { before, blob, plan };
  }

  it("queda IDENTICO por hash (firmante, cargo e imagenes) y conserva fechas e ids", async () => {
    const { before, plan } = await roundTrip();
    expect(plan.counts).toEqual({ new: 3, identical: 0, different: 0, invalid: 0 });
    const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    expect(result).toMatchObject({ ok: true, written: 3, replaced: 0 });
    const after = await vaultList();
    expect(await fingerprint(after)).toEqual(await fingerprint(before));
    expect(after.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
    for (const entry of after) {
      const original = before.find((b) => b.id === entry.id)!;
      expect(entry.createdAt).toBe(original.createdAt);
      expect(entry.lastUsedAt).toBe(original.lastUsedAt);
      expect(entry.signerKey).toBe(original.signerKey);
      // nunca viaja el documento de origen; `origin` solo aparece si la entrada ya lo traia (aqui no)
      expect(entry.sourceDocument).toBe("");
      expect("origin" in entry).toBe(false);
    }
  });

  it("con contraseña correcta: identico; sin contraseña o incorrecta: error tipado y nada escrito", async () => {
    const { before, blob } = await roundTrip("secreta ñ");
    await expect(readPackage(blob)).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(blob, "otra")).rejects.toMatchObject({ code: "wrongPassword" });
    expect(await vaultList()).toEqual([]);
    const plan = await planFor(blob, "secreta ñ");
    await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    expect(await fingerprint(await vaultList())).toEqual(await fingerprint(before));
  });

  it("el paquete cifrado no deja nada legible: ni nombres, ni rutas, ni PNG", async () => {
    const { blob } = await roundTrip("secreta");
    const raw = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    expect(raw).not.toContain("Ana");
    expect(raw).not.toContain("signatures/");
    expect(raw).not.toContain("PNG");
    expect(raw).toContain("envelope.json");
  });
});

describe("fusion sin duplicar", () => {
  it("importar dos veces el mismo paquete: la segunda todo es «identico» y no escribe nada", async () => {
    await seed(vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3 }));
    const blob = await exportBlob();
    const plan = await planFor(blob);
    expect(plan.counts).toMatchObject({ identical: 2, new: 0, different: 0 });
    const before = await vaultList();
    const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    expect(result).toMatchObject({ ok: true, written: 0 });
    expect(await vaultList()).toEqual(before);
  });

  it("«exportar -> anadir una -> reexportar -> importar sobre el primero»: solo entra la nueva", async () => {
    await seed(vaultInput("Ana Pérez"));
    const first = await exportBlob();
    await seed(vaultInput("Luis Gómez", { sig: 3 }));
    const second = await exportBlob();
    await clearVault();
    // el segundo dispositivo importa el primer paquete...
    const planA = await planFor(first);
    await applySignaturesImport(planA, defaultSignatureDecisions(planA));
    // ...y luego el segundo, que contiene lo mismo + una nueva
    const planB = await planFor(second);
    expect(planB.counts).toMatchObject({ new: 1, identical: 1 });
    await applySignaturesImport(planB, defaultSignatureDecisions(planB));
    expect((await vaultList()).map((e) => e.signerName).sort()).toEqual(["Ana Pérez", "Luis Gómez"]);
  });

  it("«idéntico» = mismo firmante (sin acentos ni mayusculas) + mismas imagenes por hash; otra imagen = «distinto»", async () => {
    await seed(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    const blob = await exportBlob();
    await clearVault();
    // en este baul: «ANA PEREZ» con la MISMA firma -> identico (aunque cambie el nombre escrito)
    await seed(vaultInput("ANA PEREZ", { sig: 1, ini: 2 }));
    expect((await planFor(blob)).counts).toMatchObject({ identical: 1, different: 0 });
    // misma firma pero el baul no tiene iniciales: el elemento trae MAS -> distinto
    await clearVault();
    await seed(vaultInput("Ana Pérez", { sig: 1, ini: null }));
    const plan = await planFor(blob);
    expect(plan.counts).toMatchObject({ different: 1, identical: 0 });
    expect(plan.items[0].supersedes).toBe(true);
    // otro firmante con las mismas imagenes -> nuevo
    await clearVault();
    await seed(vaultInput("Otra Persona", { sig: 1, ini: 2 }));
    expect((await planFor(blob)).counts).toMatchObject({ new: 1 });
    // si el baul tiene MAS (firma + iniciales) y el paquete solo la firma: identico (cubierto)
    const only = await (async () => {
      await clearVault();
      await seed(vaultInput("Ana Pérez", { sig: 1, ini: null }));
      return exportBlob();
    })();
    await clearVault();
    await seed(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    expect((await planFor(only)).counts).toMatchObject({ identical: 1 });
  });

  it("dos elementos iguales dentro del mismo paquete no se duplican en el baul", async () => {
    const entryA = vaultEntry("vault-a", "Ana Pérez");
    const entryB = { ...vaultEntry("vault-b", "Ana Pérez") };
    const blob = await buildPackage({ modules: [signaturesModuleFromEntries([entryA, entryB])] });
    const plan = await planFor(blob);
    expect(plan.counts.new).toBe(2);
    const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    expect(result).toMatchObject({ ok: true, written: 1 });
    expect(await vaultList()).toHaveLength(1);
  });
});

describe("«distinto»: Reemplazar / Conservar ambos / Omitir", () => {
  async function conflict() {
    // el baul de origen tiene a Ana con la firma 1; el de destino, con la firma 9
    await seed(vaultInput("Ana Pérez", { sig: 1, ini: 2, role: "Directora" }));
    const blob = await exportBlob();
    await clearVault();
    await seed(vaultInput("Ana Pérez", { sig: 9, ini: null }), vaultInput("Luis", { sig: 5 }));
    const plan = await planFor(blob);
    const item = plan.items[0];
    expect(item.status).toBe("different");
    return { blob, plan, item, targetId: item.conflictWith!.id };
  }

  it("Omitir deja el baul intacto", async () => {
    const { plan, item } = await conflict();
    const before = await vaultList();
    const result = await applySignaturesImport(plan, { [item.id]: "omit" });
    expect(result).toMatchObject({ ok: true, written: 0 });
    expect(await vaultList()).toEqual(before);
  });

  it("Conservar ambos anade la del paquete sin tocar la existente", async () => {
    const { plan, item, targetId } = await conflict();
    const result = await applySignaturesImport(plan, { [item.id]: "keepBoth" });
    expect(result).toMatchObject({ ok: true, written: 1, replaced: 0 });
    const list = await vaultList();
    expect(list).toHaveLength(3);
    expect(list.some((e) => e.id === targetId)).toBe(true);
    // idempotente: volver a planificar la ve ya como «identica»
    expect((await planSignaturesImport(await readPackage(await exportBlobFrom(list)), list)).counts.identical).toBeGreaterThan(0);
  });

  it("Reemplazar sustituye SOLO la entrada elegida", async () => {
    const { plan, item, targetId } = await conflict();
    const result = await applySignaturesImport(plan, { [item.id]: "replace" });
    expect(result).toMatchObject({ ok: true, written: 1, replaced: 1 });
    const list = await vaultList();
    expect(list).toHaveLength(2);
    expect(list.some((e) => e.id === targetId)).toBe(false);
    expect(list.find((e) => e.signerName === "Luis")).toBeDefined();
    expect(list.find((e) => e.signerName === "Ana Pérez")?.role).toBe("Directora");
  });

  it("sin decision explicita NO se escribe nada (ni lo nuevo ni lo distinto)", async () => {
    const { plan } = await conflict();
    const before = await vaultList();
    expect(await applySignaturesImport(plan, {})).toMatchObject({ ok: true, written: 0 });
    expect(await vaultList()).toEqual(before);
  });

  it("una decision incoherente con el estado (reemplazar lo nuevo, importar lo distinto, valores raros) se ignora", async () => {
    const { plan, item } = await conflict();
    const before = await vaultList();
    const weird = { [item.id]: "import", __proto__: "replace", otro: "replace" } as never;
    expect(await applySignaturesImport(plan, weird)).toMatchObject({ ok: true, written: 0 });
    expect(await applySignaturesImport(plan, { [item.id]: "borrar-todo" as never })).toMatchObject({ written: 0 });
    expect(await vaultList()).toEqual(before);
  });

  it("dos elementos que quieren reemplazar el MISMO destino: solo el primero lo hace", async () => {
    await seed(vaultInput("Ana Pérez", { sig: 9, ini: null }));
    const blob = await buildPackage({
      modules: [
        signaturesModuleFromEntries([
          vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 }),
          vaultEntry("vault-b", "Ana Pérez", { sig: 3, ini: 4 }),
        ]),
      ],
    });
    const plan = await planFor(blob);
    expect(plan.items.map((i) => i.status)).toEqual(["different", "different"]);
    const result = await applySignaturesImport(plan, { "vault-a": "replace", "vault-b": "replace" });
    expect(result).toMatchObject({ ok: true, written: 1, replaced: 1 });
    expect(await vaultList()).toHaveLength(1);
  });

  it("lo sugerido: reemplazar si el elemento trae todo lo que ya hay; si no, conservar ambos", async () => {
    await seed(vaultInput("Ana Pérez", { sig: 1, ini: null }));
    const superset = await buildPackage({
      modules: [signaturesModuleFromEntries([vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 })])],
    });
    expect(defaultSignatureDecisions(await planFor(superset))).toEqual({ "vault-a": "replace" });
    const other = await buildPackage({
      modules: [signaturesModuleFromEntries([vaultEntry("vault-b", "Ana Pérez", { sig: 7, ini: null })])],
    });
    expect(defaultSignatureDecisions(await planFor(other))).toEqual({ "vault-b": "keepBoth" });
  });
});

async function exportBlobFrom(entries: VaultEntry[]): Promise<Blob> {
  return buildPackage({ modules: [signaturesModuleFromEntries(entries)] });
}

describe("limites del baul (30 firmas, 20 MB) antes de importar", () => {
  async function packageOf(count: number, opts: { bytes?: number } = {}) {
    const entries = Array.from({ length: count }, (_, i) => ({
      ...vaultEntry(`vault-p${String(i).padStart(2, "0")}`, `Firmante ${i}`, { sig: 100 + i, ini: null }),
      signature: makeImage({ seed: 100 + i, totalBytes: opts.bytes }),
      initials: opts.bytes ? makeImage({ width: 20, height: 20, seed: 200 + i, totalBytes: opts.bytes }) : null,
    }));
    return exportBlobFrom(entries);
  }

  it("avisa de cuantas CABEN por numero de firmas y no escribe NINGUNA si no caben todas", async () => {
    for (let i = 0; i < 28; i += 1) await seed(vaultInput(`Existente ${i}`, { sig: 300 + i, ini: null }));
    const blob = await packageOf(5);
    const plan = await planFor(blob);
    const decisions = defaultSignatureDecisions(plan);
    const check = checkSignaturesLimits(plan, decisions);
    expect(check).toMatchObject({ wanted: 5, fits: 2, ok: false });
    const before = await vaultList();
    const result = await applySignaturesImport(plan, decisions);
    expect(result).toEqual({ ok: false, reason: "limit", fits: 2, wanted: 5 });
    expect(await vaultList()).toEqual(before);
    // omitiendo tres, caben las 2 restantes
    const some = { ...decisions, "vault-p02": "omit", "vault-p03": "omit", "vault-p04": "omit" } as const;
    expect(checkSignaturesLimits(plan, some)).toMatchObject({ wanted: 2, fits: 2, ok: true });
    expect(await applySignaturesImport(plan, some)).toMatchObject({ ok: true, written: 2 });
    expect(await vaultList()).toHaveLength(MAX_VAULT_ENTRIES);
  });

  it("justo 30 caben; 31 no", async () => {
    for (let i = 0; i < 25; i += 1) await seed(vaultInput(`E ${i}`, { sig: 400 + i, ini: null }));
    const plan5 = await planFor(await packageOf(5));
    expect(checkSignaturesLimits(plan5, defaultSignatureDecisions(plan5))).toMatchObject({ fits: 5, ok: true });
    await seed(vaultInput("Uno mas", { sig: 999, ini: null }));
    const plan6 = await planFor(await packageOf(5));
    expect(checkSignaturesLimits(plan6, defaultSignatureDecisions(plan6))).toMatchObject({ fits: 4, ok: false });
  });

  it("limite de BYTES totales (20 MB): cuenta cuantas caben", async () => {
    const big = 590 * 1024;
    for (let i = 0; i < 10; i += 1) {
      await seed(vaultInput(`Grande ${i}`, { sig: 500 + i, ini: 600 + i, sigBytes: big, iniBytes: big }));
    }
    const plan = await planFor(await packageOf(8, { bytes: big }));
    const check = checkSignaturesLimits(plan, defaultSignatureDecisions(plan));
    const room = MAX_VAULT_TOTAL_BYTES - plan.limits.currentBytes;
    expect(check.fits).toBe(Math.floor(room / (2 * big)));
    expect(check.fits).toBeLessThan(8);
    expect(check.ok).toBe(false);
    expect(await applySignaturesImport(plan, defaultSignatureDecisions(plan))).toMatchObject({
      ok: false,
      reason: "limit",
      fits: check.fits,
    });
  });

  it("Reemplazar no consume cupo de entradas: con el baul lleno, reemplazar cabe y conservar ambos no", async () => {
    for (let i = 0; i < 29; i += 1) await seed(vaultInput(`E ${i}`, { sig: 700 + i, ini: null }));
    await seed(vaultInput("Ana Pérez", { sig: 9, ini: null }));
    expect(await vaultList()).toHaveLength(30);
    const blob = await buildPackage({
      modules: [signaturesModuleFromEntries([vaultEntry("vault-n", "Ana Pérez", { sig: 1, ini: 2 })])],
    });
    const plan = await planFor(blob);
    expect(checkSignaturesLimits(plan, { "vault-n": "replace" }).ok).toBe(true);
    expect(checkSignaturesLimits(plan, { "vault-n": "keepBoth" })).toMatchObject({ ok: false, fits: 0 });
  });
});

describe("atomicidad: todo o nada ante un fallo de cuota", () => {
  async function threeNew() {
    const blob = await exportBlobFrom([
      vaultEntry("vault-a", "Ana", { sig: 1, ini: null }),
      vaultEntry("vault-b", "Beto", { sig: 2, ini: null }),
      vaultEntry("vault-c", "Cris", { sig: 3, ini: null }),
    ]);
    return planFor(blob);
  }

  it("si la escritura n.º 2 revienta con QuotaExceededError, el baul queda EXACTAMENTE como estaba", async () => {
    await seed(vaultInput("Existente", { sig: 50 }));
    const plan = await threeNew();
    const before = await vaultList();
    const realPut = IDBObjectStore.prototype.put;
    let calls = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      calls += 1;
      if (calls === 2) throw new DOMException("cuota", "QuotaExceededError");
      return realPut.apply(this, args as never);
    });
    const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    // H7: la cuota del navegador llena es `quota` («No hay espacio suficiente…»), no `limit` («No caben…» = los 30 firmas de la app).
    expect(result).toMatchObject({ ok: false, reason: "quota" });
    expect(calls).toBe(2);
    vi.restoreAllMocks();
    expect(await vaultList()).toEqual(before);
  });

  it("un reemplazo que falla al escribir NO deja borrado el destino", async () => {
    await seed(vaultInput("Ana", { sig: 9, ini: null }));
    const target = (await vaultList())[0];
    const blob = await exportBlobFrom([vaultEntry("vault-n", "Ana", { sig: 1, ini: 2 })]);
    const plan = await planFor(blob);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("cuota", "QuotaExceededError");
    });
    const result = await applySignaturesImport(plan, { "vault-n": "replace" });
    expect(result.ok).toBe(false);
    vi.restoreAllMocks();
    expect(await vaultList()).toEqual([target]);
  });

  it("otro fallo de IndexedDB se informa como `unavailable` y tampoco escribe", async () => {
    const plan = await threeNew();
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new Error("boom");
    });
    const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    vi.restoreAllMocks();
    expect(await vaultList()).toEqual([]);
  });

  it("sin IndexedDB devuelve `unavailable` sin lanzar", async () => {
    const plan = await threeNew();
    vi.stubGlobal("indexedDB", undefined);
    expect(await applySignaturesImport(plan, defaultSignatureDecisions(plan))).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("otra pestaña llenó el baul entre la vista previa y «Importar»: se detecta dentro de la transaccion", async () => {
    const plan = await threeNew();
    expect(checkSignaturesLimits(plan, defaultSignatureDecisions(plan)).ok).toBe(true);
    for (let i = 0; i < 29; i += 1) await seed(vaultInput(`Otra ${i}`, { sig: 800 + i, ini: null }));
    const before = await vaultList();
    const result = await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    expect(result).toMatchObject({ ok: false, reason: "limit" });
    expect(await vaultList()).toEqual(before);
  });
});

describe("aislamiento de elementos corruptos y datos hostiles dentro del modulo", () => {
  async function healthy() {
    return exportBlobFrom([
      vaultEntry("vault-a", "Ana", { sig: 1, ini: 2 }),
      vaultEntry("vault-b", "Beto", { sig: 3, ini: null }),
    ]);
  }

  it("un PNG cuyo SHA-256 no coincide invalida SOLO su elemento, con motivo, y el resto se importa", async () => {
    const blob = await rewriteZip(await healthy(), (zip) => {
      zip.file("signatures/vault-a-signature.png", makePng({ seed: 77 })); // otro contenido, manifiesto igual
    });
    const read = await readPackage(blob);
    const plan = await planSignaturesImport(read, []);
    expect(plan.items.map((i) => [i.id, i.status, i.reason])).toEqual([
      ["vault-a", "invalid", "integrity"],
      ["vault-b", "new", undefined],
    ]);
    expect(await applySignaturesImport(plan, defaultSignatureDecisions(plan))).toMatchObject({ ok: true, written: 1 });
    expect((await vaultList()).map((e) => e.signerName)).toEqual(["Beto"]);
  });

  it("un archivo AUSENTE del zip invalida su elemento", async () => {
    const blob = await rewriteZip(await healthy(), (zip) => {
      zip.remove("signatures/vault-b-signature.png");
    });
    const plan = await planSignaturesImport(await readPackage(blob), []);
    expect(plan.items.find((i) => i.id === "vault-b")).toMatchObject({ status: "invalid", reason: "integrity" });
    expect(plan.items.find((i) => i.id === "vault-a")?.status).toBe("new");
  });

  it("PNG con cabecera falsa, CRC del IHDR alterado, dimensiones 0 o > 4096, sin IEND: invalido (aun con SHA correcto)", async () => {
    const cases: Record<string, Uint8Array> = {
      cabecera: new Uint8Array(60).fill(7),
      crc: (() => {
        const p = makePng({ seed: 5 });
        p[30] ^= 0xff;
        return p;
      })(),
      anchoCero: makePng({ width: 0, seed: 5 }),
      anchoEnorme: makePng({ width: 100000, seed: 5 }),
      altoEnorme: makePng({ height: 4097, seed: 5 }),
      sinIend: (() => {
        const p = makePng({ seed: 5 });
        return p.slice(0, p.length - 12);
      })(),
    };
    for (const [label, png] of Object.entries(cases)) {
      const blob = await replaceFile(await healthy(), "signatures/vault-b-signature.png", png);
      const plan = await planSignaturesImport(await readPackage(blob), []);
      const item = plan.items.find((i) => i.id === "vault-b")!;
      expect([label, item.status, item.reason]).toEqual([label, "invalid", "invalidImage"]);
      expect(plan.items.find((i) => i.id === "vault-a")?.status).toBe("new");
    }
  });

  it("un PNG de mas de 600 KB se aisla como `tooLarge` SIN inflarlo (aunque el SHA sea correcto)", async () => {
    const huge = makePng({ seed: 5, totalBytes: MAX_VAULT_IMAGE_BYTES + 1 });
    const blob = await replaceFile(await healthy(), "signatures/vault-b-signature.png", huge);
    const read = await readPackage(blob);
    const file = read.modules[0].files.get("signatures/vault-b-signature.png")!;
    expect(file).toMatchObject({ status: "tooLarge", bytes: null });
    const plan = await planSignaturesImport(read, []);
    expect(plan.items.find((i) => i.id === "vault-b")).toMatchObject({ status: "invalid", reason: "tooLarge" });
    // exactamente 600 KB si entra
    const exact = makePng({ seed: 5, totalBytes: MAX_VAULT_IMAGE_BYTES });
    const ok = await replaceFile(await healthy(), "signatures/vault-b-signature.png", exact);
    expect((await planSignaturesImport(await readPackage(ok), [])).items.find((i) => i.id === "vault-b")?.status).toBe("new");
  });

  async function withIndex(index: unknown): Promise<Blob> {
    return replaceFile(
      await healthy(),
      "signatures/index.json",
      new TextEncoder().encode(typeof index === "string" ? index : JSON.stringify(index)),
    );
  }

  it("campos desconocidos del indice se ignoran; `origin` valido se muestra Y se escribe en el baul (U6.2)", async () => {
    const png = (id: string) => `signatures/${id}-signature.png`;
    const blob = await withIndex([
      {
        id: "vault-a",
        signerName: "Ana",
        createdAt: "2026-10-01T10:00:00Z",
        lastUsedAt: "2026-10-02T10:00:00Z",
        signature: png("vault-a"),
        initials: "signatures/vault-a-initials.png",
        origin: "extracted",
        rareza: { x: 1 },
        signerKey: "otra-clave",
        sourceDocument: "secreto.pdf",
      },
    ]);
    const plan = await planSignaturesImport(await readPackage(blob), []);
    expect(plan.items[0]).toMatchObject({ status: "new", origin: "extracted" });
    await applySignaturesImport(plan, defaultSignatureDecisions(plan));
    const [entry] = await vaultList();
    expect(entry.signerKey).toBe("ana"); // recalculada, no la del paquete
    expect(entry.sourceDocument).toBe("");
    expect(entry.origin).toBe("extracted");
    expect("rareza" in entry).toBe(false);
  });

  it("rutas de imagen falsas, ids con `../` o repetidos, y campos mal tipados: elementos `invalid` sin tumbar el resto", async () => {
    const base = {
      createdAt: "2026-10-01T10:00:00Z",
      lastUsedAt: "2026-10-02T10:00:00Z",
    };
    const blob = await withIndex([
      { ...base, id: "vault-a", signerName: "Ana", signature: "signatures/vault-a-signature.png" },
      { ...base, id: "vault-b", signerName: "Beto", signature: "../../etc/passwd" },
      { ...base, id: "../x", signerName: "Mal", signature: "signatures/../x-signature.png" },
      { ...base, id: "vault-a", signerName: "Ana otra vez", signature: "signatures/vault-a-signature.png" },
      { ...base, id: "vault-d", signerName: 42, signature: "signatures/vault-d-signature.png" },
      { ...base, id: "vault-e", signerName: "Sin imagenes" },
      { ...base, id: "vault-f", signerName: "Fecha mala", signature: "signatures/vault-f-signature.png", createdAt: "ayer" },
      "una cadena",
      null,
    ]);
    const plan = await planSignaturesImport(await readPackage(blob), []);
    expect(plan.items.map((i) => [i.status, i.reason])).toEqual([
      ["new", undefined],
      ["invalid", "invalidEntry"],
      ["invalid", "invalidEntry"],
      ["invalid", "duplicateId"],
      ["invalid", "invalidEntry"],
      ["invalid", "invalidEntry"],
      ["invalid", "invalidEntry"],
      ["invalid", "invalidEntry"],
      ["invalid", "invalidEntry"],
    ]);
    expect(plan.counts).toEqual({ new: 1, identical: 0, different: 0, invalid: 8 });
  });

  it("nombres: quita marcas bidi y caracteres de control; un nombre vacio tras limpiar o de > 200 caracteres es invalido", async () => {
    const base = {
      createdAt: "2026-10-01T10:00:00Z",
      lastUsedAt: "2026-10-02T10:00:00Z",
    };
    const blob = await withIndex([
      { ...base, id: "vault-a", signerName: "Ana‮tca\u0000X", role: "  Dir\u0007ectora ", signature: "signatures/vault-a-signature.png" },
      { ...base, id: "vault-b", signerName: "‮‏", signature: "signatures/vault-b-signature.png" },
    ]);
    const plan = await planSignaturesImport(await readPackage(blob), []);
    expect(plan.items[0]).toMatchObject({ status: "new", signerName: "Anatca X", role: "Dir ectora" });
    expect(plan.items[1].status).toBe("invalid");
  });

  it("tope de 200 caracteres en nombre y cargo: 200 pasan, 201 es invalido", async () => {
    const entry = (name: string, role?: string) => ({
      id: "vault-a",
      signerName: name,
      ...(role ? { role } : {}),
      createdAt: "2026-10-01T10:00:00Z",
      lastUsedAt: "2026-10-02T10:00:00Z",
      signature: "signatures/vault-a-signature.png",
    });
    const status = async (e: object) => (await planSignaturesImport(await readPackage(await withIndex([e])), [])).items[0].status;
    expect(await status(entry("x".repeat(200)))).toBe("new");
    expect(await status(entry("x".repeat(201)))).toBe("invalid");
    expect(await status(entry("Ana", "r".repeat(200)))).toBe("new");
    expect(await status(entry("Ana", "r".repeat(201)))).toBe("invalid");
  });

  it("indice ilegible (JSON invalido, profundo, enorme, con SHA malo, ausente o con demasiados elementos) => modulo `damaged`, sin escribir", async () => {
    const deep = "[".repeat(5000) + "]".repeat(5000);
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `v${i}` }));
    const cases: Record<string, () => Promise<Blob>> = {
      noJson: () => withIndex("esto no es json"),
      profundo: () => withIndex(deep),
      noArray: () => withIndex({ a: 1 }),
      demasiados: () => withIndex(many),
      grande: () => withIndex(`["${noise(1024 * 1024 + 10)}"]`),
      shaMalo: async () =>
        rewriteZip(await healthy(), (zip) => {
          zip.file("signatures/index.json", "[]");
        }),
      ausente: async () =>
        rewriteZip(await healthy(), (zip) => {
          zip.remove("signatures/index.json");
        }),
    };
    for (const [label, make] of Object.entries(cases)) {
      const plan = await planSignaturesImport(await readPackage(await make()), []);
      expect([label, plan.state, plan.items.length]).toEqual([label, "damaged", 0]);
      expect(await applySignaturesImport(plan, { x: "import" })).toEqual({ ok: false, reason: "blocked" });
    }
    expect(await vaultList()).toEqual([]);
  });

  it("readPackage y planSignaturesImport nunca abren IndexedDB (solo la importacion final escribe)", async () => {
    const blob = await healthy();
    const open = vi.spyOn(indexedDB, "open");
    const plan = await planSignaturesImport(await readPackage(blob), []);
    expect(open).not.toHaveBeenCalled();
    expect(plan.counts.new).toBe(2);
  });

  it("un `applySignaturesImport` con un plan manipulado (PNG falso, clave ajena) se rechaza antes de escribir", async () => {
    const plan = await planFor(await healthy());
    const forged: ImportPlan = {
      ...plan,
      items: plan.items.map((item, i) =>
        i === 0 && item.entry
          ? { ...item, entry: { ...item.entry, signature: { ...item.entry.signature!, png: new Uint8Array(50) } } }
          : item,
      ),
    };
    expect(await applySignaturesImport(forged, defaultSignatureDecisions(forged))).toEqual({ ok: false, reason: "invalid" });
    const wrongKey: ImportPlan = {
      ...plan,
      items: plan.items.map((item) => (item.entry ? { ...item, entry: { ...item.entry, signerKey: "otra" } } : item)),
    };
    expect(await applySignaturesImport(wrongKey, defaultSignatureDecisions(wrongKey))).toEqual({ ok: false, reason: "invalid" });
    expect(await vaultList()).toEqual([]);
  });
});

describe("version del esquema del modulo", () => {
  it("un modulo de esquema MAS NUEVO se rechaza con el mensaje y el resto del paquete se sigue leyendo", async () => {
    const registry = {
      ...DEFAULT_MODULE_REGISTRY,
      notas: {
        name: "notas",
        schemaVersion: 1,
        folders: ["templates"],
        maxFileBytes: 1000,
        maxJsonBytes: 1000,
      },
    };
    const blob = await buildPackage({
      registry,
      modules: [
        signaturesModuleFromEntries([vaultEntry("vault-a", "Ana")]),
        {
          name: "notas",
          schemaVersion: 1,
          files: [{ path: "templates/n.json", data: new TextEncoder().encode("{}"), type: "application/json" }],
        },
      ],
    });
    const newer = await editManifest(blob, (m) => {
      m.modules.signatures.schemaVersion = 2;
    });
    const read = await readPackage(newer, undefined, { registry });
    const sig = read.modules.find((m) => m.name === "signatures")!;
    expect(sig).toMatchObject({
      status: "newerVersion",
      declaredSchemaVersion: 2,
      message: "Creado con una versión más nueva de OptimusPDF; actualiza la página.",
    });
    expect(sig.files.size).toBe(0); // ni siquiera se infló
    const notes = read.modules.find((m) => m.name === "notas")!;
    expect(notes.status).toBe("ok");
    expect(notes.files.get("templates/n.json")?.status).toBe("ok");
    const plan = await planSignaturesImport(read, []);
    expect(plan).toMatchObject({ state: "newerVersion", items: [] });
    expect(plan.message).toContain("más nueva");
    expect(await applySignaturesImport(plan, {})).toEqual({ ok: false, reason: "blocked" });
  });

  it("el indice pasa por la CADENA de migraciones con la version declarada en el paquete", async () => {
    const spy = vi.spyOn(signaturesV1Identity, "migrate");
    const blob = await exportBlobFrom([vaultEntry("vault-a", "Ana")]);
    const plan = await planFor(blob);
    expect(plan.counts.new).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(Array.isArray(spy.mock.calls[0][0])).toBe(true);
    // una migracion que transforma el indice se refleja en el plan (v1 -> v1 de «normalizacion»)
    spy.mockImplementationOnce((data) => (data as Record<string, unknown>[]).map((item) => ({ ...item, signerName: "Renombrada" })));
    expect((await planFor(blob)).items[0].signerName).toBe("Renombrada");
  });

  it("un paquete sin el modulo `signatures` da un plan `absent`", async () => {
    const registry = {
      ...DEFAULT_MODULE_REGISTRY,
      notas: { name: "notas", schemaVersion: 1, folders: ["templates"], maxFileBytes: 1000, maxJsonBytes: 1000 },
    };
    const blob = await buildPackage({
      registry,
      modules: [{ name: "notas", schemaVersion: 1, files: [{ path: "templates/n.json", data: new Uint8Array([123, 125]), type: "application/json" }] }],
    });
    expect((await planSignaturesImport(await readPackage(blob, undefined, { registry }), [])).state).toBe("absent");
  });
});

describe("paquete como archivo del usuario", () => {
  it("acepta un File (no solo Blob) y el nombre no influye", async () => {
    await seed(vaultInput("Ana Pérez"));
    const blob = await exportBlob();
    const plan = await planSignaturesImport(await readPackage(asFile(blob, "../../x.zip")), []);
    expect(plan.counts.new).toBe(1);
  });
});
