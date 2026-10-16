import "fake-indexeddb/auto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_ENTRIES,
  clearVault,
  listVault,
  saveVaultEntry,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import {
  MIN_PASSWORD_LENGTH,
  applyBackupImport,
  backupFilename,
  buildSignaturesExport,
  canShareFile,
  checkNewPassword,
  passwordStrength,
  readFailureFor,
  readSignaturesBackup,
  shareFile,
  toFile,
} from "@/app/sign-pdf/backupFlow";
import { buildPackage, readPackage, type PackageErrorCode } from "@/lib/backup/package";
import { PACKAGE_ERROR_MESSAGES } from "@/lib/backup/types";
import { defaultSignatureDecisions, exportSignatures, planSignaturesImport } from "@/lib/backup/modules/signatures";
import { sha256Hex } from "@/lib/crypto/sha256";
import { hostileCorpus } from "@/lib/backup/__fixtures__/hostileCorpus";
import { asFile, editManifest, timed, vaultInput } from "@/lib/backup/__fixtures__/testKit";

/** «Exportar todas / Importar firmas»: la logica sin interfaz, sobre IndexedDB falso. */

beforeEach(async () => {
  await clearVault();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seed(...inputs: ReturnType<typeof vaultInput>[]) {
  for (const input of inputs) {
    const result = await saveVaultEntry(input);
    if (!result.ok) throw new Error(`seed: ${result.reason}`);
  }
}
const vault = async (): Promise<VaultEntry[]> => (await listVault()).entries;

async function fingerprint(entries: VaultEntry[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of entries) {
    out.push(
      [
        entry.signerName,
        entry.signature ? await sha256Hex(entry.signature.png) : "-",
        entry.initials ? await sha256Hex(entry.initials.png) : "-",
        entry.origin ?? "",
      ].join("|"),
    );
  }
  return out.sort();
}

describe("contrasena: minimo y medidor", () => {
  it("el minimo es 8 caracteres (se cuentan caracteres, no bytes) y vacia/espacios no valen", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("       ")).toBe(0);
    expect(passwordStrength("abcdefg")).toBe(0);
    expect(passwordStrength("1234567")).toBe(0);
    expect(passwordStrength("ñññññññ")).toBe(0); // 7 caracteres
    expect(passwordStrength("ñandú-12")).toBeGreaterThanOrEqual(1);
  });

  it("floja: comun, repetida o de una sola clase; buena y fuerte suben con largo y variedad", () => {
    expect(passwordStrength("password")).toBe(1);
    expect(passwordStrength("12345678")).toBe(1);
    expect(passwordStrength("aaaaaaaaaaaaaaaaaa")).toBe(1);
    expect(passwordStrength("abcdefgh")).toBe(1);
    expect(passwordStrength("Abcdefg1")).toBe(2);
    expect(passwordStrength("correcto-caballo")).toBe(3);
    expect(passwordStrength("Tr0ub4dor&3x!")).toBe(3);
    expect(passwordStrength("unabuenafrase")).toBe(2);
    // la fuerza nunca baja al añadir caracteres distintos
    expect(passwordStrength("Abcdefg1xyz!")).toBeGreaterThanOrEqual(passwordStrength("Abcdefg1"));
  });

  it("checkNewPassword: vacia, corta, no coincide, ok", () => {
    expect(checkNewPassword("", "")).toBe("empty");
    expect(checkNewPassword("   ", "   ")).toBe("empty");
    expect(checkNewPassword("corta", "corta")).toBe("tooShort");
    expect(checkNewPassword("sietech", "sietech")).toBe("tooShort");
    expect(checkNewPassword("ochochar", "ochochaX")).toBe("mismatch");
    expect(checkNewPassword("ochochar", "")).toBe("mismatch");
    expect(checkNewPassword("ochochar", "ochochar")).toBe("ok");
  });
});

describe("backupFilename", () => {
  it("firmas-optimuspdf-AAAA-MM-DD.optimuspdf.zip con la fecha LOCAL y ceros a la izquierda", () => {
    expect(backupFilename(new Date(2026, 0, 5, 23, 59))).toBe("firmas-optimuspdf-2026-01-05.optimuspdf.zip");
    expect(backupFilename(new Date(2026, 11, 31, 0, 0))).toBe("firmas-optimuspdf-2026-12-31.optimuspdf.zip");
    expect(backupFilename()).toMatch(/^firmas-optimuspdf-\d{4}-\d{2}-\d{2}\.optimuspdf\.zip$/);
  });
});

describe("buildSignaturesExport", () => {
  it("sin firmas no hay nada que exportar", async () => {
    expect(await buildSignaturesExport()).toEqual({ ok: false, reason: "empty" });
  });

  it("sin contraseña: zip en claro con TODAS las firmas, nombre con la fecha y conteo", async () => {
    await seed(vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3, ini: null }));
    const result = await buildSignaturesExport({ now: new Date(2026, 9, 15) });
    expect(result).toMatchObject({ ok: true, count: 2, encrypted: false, filename: "firmas-optimuspdf-2026-10-15.optimuspdf.zip" });
    if (!result.ok) return;
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(Object.keys(zip.files)).toContain("signatures/index.json");
    expect((await readPackage(result.blob)).encrypted).toBe(false);
  });

  it("con contraseña: cifrado (solo envelope.json + payload.bin) y se abre solo con ella", async () => {
    await seed(vaultInput("Ana Pérez"));
    const result = await buildSignaturesExport({ password: "una-clave-larga" });
    expect(result).toMatchObject({ ok: true, count: 1, encrypted: true });
    if (!result.ok) return;
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["envelope.json", "payload.bin"]);
    await expect(readPackage(result.blob)).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(result.blob, "otra")).rejects.toMatchObject({ code: "wrongPassword" });
    expect((await readPackage(result.blob, "una-clave-larga")).encrypted).toBe(true);
  });

  it("contraseña vacia = sin cifrar (nunca un archivo «protegido» con clave vacia)", async () => {
    await seed(vaultInput("Ana Pérez"));
    expect(await buildSignaturesExport({ password: "" })).toMatchObject({ ok: true, encrypted: false });
  });

  it("sin WebCrypto (http) y con contraseña: encryptionUnavailable, sin escribir nada", async () => {
    await seed(vaultInput("Ana Pérez"));
    vi.stubGlobal("crypto", {});
    expect(await buildSignaturesExport({ password: "una-clave-larga" })).toEqual({ ok: false, reason: "encryptionUnavailable" });
  });

  it("sin IndexedDB: unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await buildSignaturesExport()).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("compartir (iPad)", () => {
  const file = toFile(new Blob(["x"]), "a.optimuspdf.zip");

  it("toFile conserva nombre y tipo zip", () => {
    expect(file.name).toBe("a.optimuspdf.zip");
    expect(file.type).toBe("application/zip");
  });

  it("canShareFile exige share Y canShare({files}) verdadero", () => {
    vi.stubGlobal("navigator", {});
    expect(canShareFile(file)).toBe(false);
    vi.stubGlobal("navigator", { share: vi.fn() });
    expect(canShareFile(file)).toBe(false);
    vi.stubGlobal("navigator", { share: vi.fn(), canShare: () => false });
    expect(canShareFile(file)).toBe(false);
    vi.stubGlobal("navigator", { share: vi.fn(), canShare: () => { throw new Error("x"); } });
    expect(canShareFile(file)).toBe(false);
    const canShare = vi.fn(() => true);
    vi.stubGlobal("navigator", { share: vi.fn(), canShare });
    expect(canShareFile(file)).toBe(true);
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
  });

  it("shareFile: compartido, cancelado (AbortError) o fallido", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, canShare: () => true });
    expect(await shareFile(file)).toBe("shared");
    expect(share).toHaveBeenCalledWith({ files: [file], title: "a.optimuspdf.zip" });
    share.mockRejectedValueOnce(new DOMException("cancel", "AbortError"));
    expect(await shareFile(file)).toBe("cancelled");
    share.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    expect(await shareFile(file)).toBe("failed");
    share.mockRejectedValueOnce(new Error("raro"));
    expect(await shareFile(file)).toBe("failed");
  });
});

describe("readSignaturesBackup + applyBackupImport — ida y vuelta", () => {
  async function exported(password?: string) {
    await seed(
      vaultInput("Ana Pérez", { role: "Directora" }),
      vaultInput("Luis Gómez", { sig: 3, ini: null }),
      vaultInput("Marta Ruiz", { sig: null, ini: 4 }),
    );
    const result = await buildSignaturesExport({ password });
    if (!result.ok) throw new Error("export");
    return result;
  }

  for (const password of [undefined, "dorada-2026"]) {
    it(`${password ? "con" : "sin"} contraseña: exportar -> borrar el baul -> importar = identico por hash`, async () => {
      const out = await exported(password);
      const before = await fingerprint(await vault());
      await clearVault();
      const file = asFile(out.blob, out.filename);
      if (password) {
        expect(await readSignaturesBackup(file)).toMatchObject({ ok: false, reason: "needsPassword" });
        expect(await readSignaturesBackup(file, "mala-clave")).toMatchObject({ ok: false, reason: "wrongPassword" });
      }
      const read = await readSignaturesBackup(file, password);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.encrypted).toBe(password !== undefined);
      expect(read.plan.counts).toEqual({ new: 3, identical: 0, different: 0, invalid: 0 });
      const applied = await applyBackupImport(read.plan, defaultSignatureDecisions(read.plan));
      expect(applied).toEqual({ ok: true, summary: { imported: 3, skipped: 0, replaced: 0 } });
      expect(await fingerprint(await vault())).toEqual(before);
    });
  }

  it("importar dos veces: la segunda no duplica (todo «idéntico», 0 importadas, 3 omitidas)", async () => {
    const out = await exported();
    const read = await readSignaturesBackup(asFile(out.blob));
    expect(read.ok && read.plan.counts).toEqual({ new: 0, identical: 3, different: 0, invalid: 0 });
    if (!read.ok) return;
    const applied = await applyBackupImport(read.plan, defaultSignatureDecisions(read.plan));
    expect(applied).toEqual({ ok: true, summary: { imported: 0, skipped: 3, replaced: 0 } });
    expect((await vault()).length).toBe(3);
  });

  it("el origin viaja y se escribe: una firma subida vuelve como «uploaded»", async () => {
    const saved = await saveVaultEntry({ ...vaultInput("Ana Pérez"), origin: "uploaded" });
    expect(saved.ok).toBe(true);
    const out = await buildSignaturesExport();
    if (!out.ok) throw new Error("export");
    await clearVault();
    const read = await readSignaturesBackup(asFile(out.blob));
    if (!read.ok) throw new Error("read");
    await applyBackupImport(read.plan, defaultSignatureDecisions(read.plan));
    expect((await vault())[0].origin).toBe("uploaded");
  });

  it("«Distinto»: reemplazar sustituye y cuenta; conservar ambos añade; omitir no toca", async () => {
    await seed(vaultInput("Ana Pérez", { sig: 1, ini: 2 }));
    const out = await buildSignaturesExport();
    if (!out.ok) throw new Error("export");
    await clearVault();
    await seed(vaultInput("Ana Pérez", { sig: 9, ini: 8 }));
    const read = await readSignaturesBackup(asFile(out.blob));
    if (!read.ok) throw new Error("read");
    const item = read.plan.items[0];
    expect(item.status).toBe("different");
    const decide = (decision: "replace" | "keepBoth" | "omit") => ({ [item.id]: decision });
    expect(await applyBackupImport(read.plan, decide("omit"))).toEqual({ ok: true, summary: { imported: 0, skipped: 1, replaced: 0 } });
    expect((await vault()).length).toBe(1);
    expect(await applyBackupImport(read.plan, decide("keepBoth"))).toMatchObject({ ok: true, summary: { imported: 1, replaced: 0 } });
    expect((await vault()).length).toBe(2);
  });

  it("limites: si no caben todas las aprobadas, NO se escribe ninguna y se dice cuantas caben", async () => {
    await seed(vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3 }));
    const out = await buildSignaturesExport();
    if (!out.ok) throw new Error("export");
    await clearVault();
    for (let i = 0; i < MAX_VAULT_ENTRIES - 1; i += 1) await seed(vaultInput(`Otro ${i}`, { sig: 100 + i, ini: null }));
    const read = await readSignaturesBackup(asFile(out.blob));
    if (!read.ok) throw new Error("read");
    const before = await fingerprint(await vault());
    const applied = await applyBackupImport(read.plan, defaultSignatureDecisions(read.plan));
    expect(applied).toEqual({ ok: false, reason: "limit", fits: 1, wanted: 2 });
    expect(await fingerprint(await vault())).toEqual(before);
  });
});

describe("readSignaturesBackup — fallos con mensaje claro", () => {
  it("modulo de una version mas nueva -> newer; contenedor mas nuevo -> newer", async () => {
    await seed(vaultInput("Ana Pérez"));
    const out = await buildSignaturesExport();
    if (!out.ok) throw new Error("export");
    const newerModule = await editManifest(out.blob, (m) => {
      m.modules.signatures.schemaVersion = 99;
    });
    expect(await readSignaturesBackup(asFile(newerModule))).toMatchObject({ ok: false, reason: "newer" });
    const newerFormat = await editManifest(out.blob, (m) => {
      m.formatVersion = 99;
    });
    expect(await readSignaturesBackup(asFile(newerFormat))).toMatchObject({ ok: false, reason: "newer" });
  });

  it("paquete valido sin modulo de firmas -> noSignatures", async () => {
    await seed(vaultInput("Ana Pérez"));
    const out = await buildSignaturesExport();
    if (!out.ok) throw new Error("export");
    const none = await editManifest(out.blob, (m) => {
      m.modules = {};
      m.files = [];
    });
    expect(await readSignaturesBackup(asFile(none))).toMatchObject({ ok: false, reason: "noSignatures" });
  });

  it("indice corrupto -> damaged; un archivo suelto alterado se aisla («invalid») sin tumbar el resto", async () => {
    await seed(vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3, ini: null }));
    const out = await buildSignaturesExport();
    if (!out.ok) throw new Error("export");
    const zip = await JSZip.loadAsync(await out.blob.arrayBuffer());
    const target = Object.keys(zip.files).find((name) => name.endsWith("-signature.png"))!;
    zip.file(target, new Uint8Array([1, 2, 3]));
    const tampered = await zip.generateAsync({ type: "blob" });
    await clearVault();
    const read = await readSignaturesBackup(asFile(tampered));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.plan.counts.invalid).toBe(1);
    expect(read.plan.counts.new).toBe(1);
  });

  it("cada codigo de la libreria tiene su clave y ninguna filtra datos", () => {
    const codes = Object.keys(PACKAGE_ERROR_MESSAGES) as PackageErrorCode[];
    const expected: Record<PackageErrorCode, string> = {
      badZip: "badFile",
      tooLarge: "tooLarge",
      tooManyEntries: "tooLarge",
      bomb: "unsafe",
      unsafePath: "unsafe",
      duplicateEntry: "unsafe",
      invalidManifest: "damaged",
      invalidJson: "damaged",
      corrupt: "damaged",
      newerFormat: "newer",
      needsPassword: "needsPassword",
      wrongPassword: "wrongPassword",
      unavailable: "unavailable",
      invalidModule: "generic",
    };
    for (const code of codes) expect([code, readFailureFor(code)]).toEqual([code, expected[code]]);
  });

  it("corpus de zips hostiles: rechazo claro, < 2 s, sin escribir nada", async () => {
    await seed(vaultInput("Ana Pérez"));
    const before = await fingerprint(await vault());
    for (const hostile of hostileCorpus()) {
      const result = await timed(() => readSignaturesBackup(asFile(new Blob([hostile.bytes as unknown as BlobPart]))), 2000);
      expect([hostile.name, result.ok]).toEqual([hostile.name, false]);
      if (!result.ok) expect([hostile.name, result.code]).toEqual([hostile.name, hostile.code]);
    }
    expect(await fingerprint(await vault())).toEqual(before);
  });

  it("un archivo que no es zip no lanza: badFile", async () => {
    expect(await readSignaturesBackup(new Blob(["hola"]))).toMatchObject({ ok: false, reason: "badFile" });
    expect(await readSignaturesBackup("no-es-un-blob" as unknown as Blob)).toMatchObject({ ok: false, reason: "badFile" });
  });
});

describe("exportSignatures y buildPackage siguen siendo los de la libreria", () => {
  it("el plan de un paquete propio sobre un baul vacio lo ve todo «nuevo»", async () => {
    await seed(vaultInput("Ana Pérez"));
    const blob = await buildPackage({ modules: [await exportSignatures()] });
    const plan = await planSignaturesImport(await readPackage(blob), []);
    expect(plan.counts.new).toBe(1);
  });
});
