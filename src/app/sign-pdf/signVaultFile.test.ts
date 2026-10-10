import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_FILE_BYTES,
  encryptionAvailable,
  exportVaultEntry,
  importVaultFile,
  vaultFilename,
  type ExportVaultResult,
} from "@/app/sign-pdf/signVaultFile";
import {
  MAX_VAULT_IMAGE_BYTES,
  crc32,
  type VaultImage,
} from "@/app/sign-pdf/signVault";

/**
 * Las pruebas generan PNG minimos con el IHDR correcto (jsdom/Node no
 * decodifican imagenes, y la importacion tampoco las re-codifica: solo lee
 * cabecera y dimensiones). Los zips hostiles se arman a mano con JSZip.
 */

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

function makePng(
  opts: { width?: number; height?: number; seed?: number; totalBytes?: number } = {},
): Uint8Array {
  const { width = 40, height = 20, seed = 0, totalBytes } = opts;
  const ihdr = new Uint8Array(25);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 13);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4);
  view.setUint32(8, width);
  view.setUint32(12, height);
  ihdr.set([8, 6, 0, 0, 0], 16);
  // CRC valido del IHDR (la importacion lo exige).
  view.setUint32(21, crc32(ihdr.subarray(4, 21)));
  const base = PNG_HEAD.length + ihdr.length + PNG_END.length;
  const pad = Math.max(1, (totalBytes ?? base + 8) - base);
  const out = new Uint8Array(base + pad);
  out.set(PNG_HEAD, 0);
  out.set(ihdr, PNG_HEAD.length);
  out.fill(seed & 0xff, PNG_HEAD.length + ihdr.length, out.length - PNG_END.length);
  out.set(PNG_END, out.length - PNG_END.length);
  return out;
}

function makeImage(
  opts: { width?: number; height?: number; seed?: number } = {},
): VaultImage {
  const { width = 40, height = 20 } = opts;
  return { png: makePng(opts), ratio: height / width, width, height };
}

const ENTRY = {
  signerName: "Ana Pérez",
  role: "Directora",
  sourceDocument: "Contrato de arrendamiento.pdf",
  signature: makeImage({ seed: 1 }),
  initials: makeImage({ width: 20, height: 20, seed: 2 }),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function exported(
  opts?: Parameters<typeof exportVaultEntry>[1],
  entry: Parameters<typeof exportVaultEntry>[0] = ENTRY,
): Promise<Extract<ExportVaultResult, { ok: true }>> {
  const result = await exportVaultEntry(entry, opts);
  if (!result.ok) throw new Error(`export fallo: ${result.reason}`);
  return result;
}

function asFile(blob: Blob, name = "firma.zip"): File {
  return new File([blob], name, { type: "application/zip" });
}

async function unzip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

type ZipContents = Record<string, Uint8Array | string>;

async function zipFile(
  contents: ZipContents,
  generate: { compression?: "STORE" | "DEFLATE" } = {},
): Promise<File> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(contents)) zip.file(name, data);
  const bytes = await zip.generateAsync({ type: "uint8array", ...generate });
  return new File([bytes as BlobPart], "x.zip", { type: "application/zip" });
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    kind: "signature-vault",
    signerName: "Ana Pérez",
    sourceDocument: "contrato.pdf",
    exportedAt: "2026-10-08T12:00:00.000Z",
    ...overrides,
  });
}

function validContents(
  manifestOverrides: Record<string, unknown> = {},
): ZipContents {
  return {
    "manifest.json": manifestJson(manifestOverrides),
    "firma.png": makePng({ seed: 1 }),
  };
}

async function importReason(file: File | Blob, password?: string) {
  const result = await importVaultFile(file, password ? { password } : undefined);
  return result.ok ? "ok" : result.reason;
}

describe("vaultFilename — src/app/sign-pdf/signVaultFile.ts", () => {
  it("ensambla Firma-<Firmante>-<Documento>.zip con slugs", () => {
    expect(vaultFilename("Ana Pérez", "Contrato de arrendamiento.pdf")).toBe(
      "Firma-ana-perez-contrato-de-arrendamiento.zip",
    );
    expect(vaultFilename("Ana Pérez", "informe.final.pdf")).toBe(
      "Firma-ana-perez-informe-final.zip",
    );
  });

  it("sin documento: Firma-<Firmante>.zip", () => {
    for (const doc of [undefined, "", "   "]) {
      expect(vaultFilename("Ana Pérez", doc)).toBe("Firma-ana-perez.zip");
    }
  });

  it.each([
    ["../../etc/passwd", "../../../windows\\system32:evil.pdf"],
    ["a/b\\c:d", "x/y\\z:..pdf"],
    ["..", ".."],
    ["Ana\u0000\u0007\n\r\t\u001bPérez", "doc\u0000\u0001.pdf"],
    ["C:\\Users\\ana", "CON.pdf"],
    ["<script>alert(1)</script>", "a|b?c*d.pdf"],
  ])("neutraliza / \\ .. : y caracteres de control (%j, %j)", (signer, doc) => {
    const name = vaultFilename(signer, doc);
    expect(name).toMatch(/^Firma-[a-z0-9-]+\.zip$/);
    expect(name).not.toMatch(/[/\\:]|\.\.|[\u0000-\u001f]/);
    expect(name).not.toContain("--");
  });

  it("usa 'firmante' / 'documento' cuando el slug queda vacio", () => {
    expect(vaultFilename("", "contrato.pdf")).toBe("Firma-firmante-contrato.zip");
    expect(vaultFilename("李雷", "合同.pdf")).toBe("Firma-firmante-documento.zip");
    expect(vaultFilename("///", "///")).toBe("Firma-firmante-documento.zip");
    expect(vaultFilename("", undefined)).toBe("Firma-firmante.zip");
    expect(vaultFilename(undefined as unknown as string, "a.pdf")).toBe(
      "Firma-firmante-a.zip",
    );
  });

  it("recorta a ~80 caracteres y siempre termina en .zip", () => {
    const long = "palabra ".repeat(60);
    for (const [signer, doc] of [
      [long, long],
      [long, "corto.pdf"],
      ["Ana", long],
      [long, undefined],
    ] as const) {
      const name = vaultFilename(signer, doc);
      expect(name.length).toBeLessThanOrEqual(80);
      expect(name).toMatch(/^Firma-[a-z0-9]+(-[a-z0-9]+)*\.zip$/);
    }
  });

  it("un nombre que ya parece un archivo no puede cambiar la extension", () => {
    expect(vaultFilename("evil.exe", "a.pdf.exe")).toBe("Firma-evil-exe-a-pdf.zip");
  });
});

describe("exportVaultEntry / importVaultFile en claro — src/app/sign-pdf/signVaultFile.ts", () => {
  it("ida y vuelta: conserva firmante, cargo, documento y bytes de ambos PNG", async () => {
    const out = await exported();
    expect(out.encrypted).toBe(false);
    expect(out.filename).toBe("Firma-ana-perez-contrato-de-arrendamiento.zip");

    const result = await importVaultFile(asFile(out.blob, out.filename));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.signerName).toBe("Ana Pérez");
    expect(result.entry.role).toBe("Directora");
    expect(result.entry.sourceDocument).toBe("Contrato de arrendamiento.pdf");
    expect(result.entry.signature?.png).toEqual(ENTRY.signature.png);
    expect(result.entry.signature?.ratio).toBe(0.5);
    expect(result.entry.signature?.width).toBe(40);
    expect(result.entry.initials?.png).toEqual(ENTRY.initials.png);
    expect(result.entry.initials?.ratio).toBe(1);
  });

  it("el zip tiene nombres FIJOS aunque el firmante o el documento sean hostiles", async () => {
    const out = await exported(undefined, {
      ...ENTRY,
      signerName: "../../evil\\name:x",
      sourceDocument: "../../../etc/passwd",
    });
    const zip = await unzip(out.blob);
    expect(Object.keys(zip.files).sort()).toEqual([
      "firma.png",
      "iniciales.png",
      "manifest.json",
    ]);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest).toMatchObject({
      version: 1,
      kind: "signature-vault",
      signerName: "../../evil\\name:x",
    });
    expect(typeof manifest.exportedAt).toBe("string");
    expect(out.filename).toMatch(/^Firma-[a-z0-9-]+\.zip$/);
  });

  it("solo incluye los PNG que existen", async () => {
    const onlySignature = await exported(undefined, { ...ENTRY, initials: null });
    expect(Object.keys((await unzip(onlySignature.blob)).files).sort()).toEqual([
      "firma.png",
      "manifest.json",
    ]);
    const onlyInitials = await exported(undefined, { ...ENTRY, signature: null });
    const imported = await importVaultFile(asFile(onlyInitials.blob));
    expect(imported.ok && imported.entry.signature).toBeNull();
    expect(imported.ok && imported.entry.initials?.png).toEqual(ENTRY.initials.png);
  });

  it("includeDocumentName=false omite el documento del manifiesto y del nombre", async () => {
    const out = await exported({ includeDocumentName: false });
    expect(out.filename).toBe("Firma-ana-perez.zip");
    const manifest = JSON.parse(
      await (await unzip(out.blob)).file("manifest.json")!.async("text"),
    );
    expect("sourceDocument" in manifest).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("arrendamiento");

    const result = await importVaultFile(asFile(out.blob));
    expect(result.ok && result.entry.sourceDocument).toBe("");
  });

  it("sin cargo: el manifiesto no lo lleva y la importacion tampoco", async () => {
    const out = await exported(undefined, { ...ENTRY, role: undefined });
    const result = await importVaultFile(asFile(out.blob));
    expect(result.ok && "role" in result.entry).toBe(false);
  });

  it("acepta un Blob sin nombre, no solo File", async () => {
    const out = await exported();
    expect((await importVaultFile(out.blob)).ok).toBe(true);
  });
});

describe("exportVaultEntry — rutas de error — src/app/sign-pdf/signVaultFile.ts", () => {
  it("rechaza entradas sin imagenes, con PNG falso o sin nombre (sin lanzar)", async () => {
    const fakeImage = {
      png: new TextEncoder().encode("no soy un png de ninguna manera, en serio"),
      ratio: 1,
      width: 1,
      height: 1,
    };
    for (const entry of [
      { ...ENTRY, signature: null, initials: null },
      { ...ENTRY, signature: fakeImage },
      { ...ENTRY, signerName: "   " },
      null as unknown as typeof ENTRY,
    ]) {
      expect(await exportVaultEntry(entry)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("una contraseña vacia es invalida (no exporta en claro por sorpresa)", async () => {
    expect(await exportVaultEntry(ENTRY, { password: "" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("cifrado con contraseña — src/app/sign-pdf/signVaultFile.ts", () => {
  it("ida y vuelta cifrada; el manifiesto exterior no revela nada del firmante", async () => {
    const out = await exported({ password: "correcto caballo" });
    expect(out.encrypted).toBe(true);
    expect(out.filename).toBe("Firma-ana-perez-contrato-de-arrendamiento.zip");

    const zip = await unzip(out.blob);
    expect(Object.keys(zip.files).sort()).toEqual(["manifest.json", "vault.enc"]);
    const manifestText = await zip.file("manifest.json")!.async("text");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({
      version: 1,
      kind: "signature-vault-encrypted",
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000 },
    });
    expect(atob(manifest.kdf.salt)).toHaveLength(16);
    expect(atob(manifest.iv)).toHaveLength(12);
    expect(manifestText).not.toContain("Ana");
    // Nada legible en el cifrado: ni el nombre ni la cabecera PNG.
    const cipher = await zip.file("vault.enc")!.async("uint8array");
    const asText = new TextDecoder("latin1").decode(cipher);
    expect(asText).not.toContain("Ana");
    expect(asText).not.toContain("PNG");

    const result = await importVaultFile(asFile(out.blob), {
      password: "correcto caballo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.signerName).toBe("Ana Pérez");
    expect(result.entry.role).toBe("Directora");
    expect(result.entry.signature?.png).toEqual(ENTRY.signature.png);
    expect(result.entry.initials?.png).toEqual(ENTRY.initials.png);
  });

  it("sin contraseña pide contraseña; con una incorrecta, wrongPassword", async () => {
    const out = await exported({ password: "secreta" });
    const file = asFile(out.blob);
    expect(await importReason(file)).toBe("needsPassword");
    expect(await importVaultFile(file, { password: "" })).toEqual({
      ok: false,
      reason: "needsPassword",
    });
    expect(await importReason(file, "Secreta")).toBe("wrongPassword");
    expect(await importReason(file, "secreta")).toBe("ok");
  });

  it("la misma contraseña con otra composicion Unicode abre el archivo", async () => {
    const out = await exported({ password: "ni\u00f1o-caf\u00e9" });
    expect(await importReason(asFile(out.blob), "nin\u0303o-cafe\u0301")).toBe("ok");
  });

  it("cada exportacion usa sal e IV distintos", async () => {
    const a = await exported({ password: "x" });
    const b = await exported({ password: "x" });
    const read = async (blob: Blob) =>
      JSON.parse(await (await unzip(blob)).file("manifest.json")!.async("text"));
    const [ma, mb] = [await read(a.blob), await read(b.blob)];
    expect(ma.kdf.salt).not.toBe(mb.kdf.salt);
    expect(ma.iv).not.toBe(mb.iv);
  });

  describe("archivo manipulado: mismo error que contraseña incorrecta", () => {
    async function encrypted() {
      return (await exported({ password: "secreta" })).blob;
    }
    async function tamper(
      blob: Blob,
      change: (zip: JSZip) => Promise<void>,
    ): Promise<File> {
      const zip = await unzip(blob);
      await change(zip);
      return asFile(await zip.generateAsync({ type: "blob" }));
    }

    it("un byte cambiado en vault.enc", async () => {
      const file = await tamper(await encrypted(), async (zip) => {
        const bytes = await zip.file("vault.enc")!.async("uint8array");
        bytes[Math.floor(bytes.length / 2)] ^= 0xff;
        zip.file("vault.enc", bytes);
      });
      expect(await importReason(file, "secreta")).toBe("wrongPassword");
    });

    it("el IV cambiado en el manifiesto exterior", async () => {
      const file = await tamper(await encrypted(), async (zip) => {
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
        manifest.iv = btoa(String.fromCharCode(...new Uint8Array(12).fill(7)));
        zip.file("manifest.json", JSON.stringify(manifest));
      });
      expect(await importReason(file, "secreta")).toBe("wrongPassword");
    });

    it("la sal cambiada en el manifiesto exterior", async () => {
      const file = await tamper(await encrypted(), async (zip) => {
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
        manifest.kdf.salt = btoa(String.fromCharCode(...new Uint8Array(16).fill(9)));
        zip.file("manifest.json", JSON.stringify(manifest));
      });
      expect(await importReason(file, "secreta")).toBe("wrongPassword");
    });

    it("el manifiesto exterior re-serializado (AAD distinto) aunque diga lo mismo", async () => {
      const file = await tamper(await encrypted(), async (zip) => {
        const text = await zip.file("manifest.json")!.async("text");
        zip.file("manifest.json", JSON.stringify(JSON.parse(text), null, 2));
      });
      expect(await importReason(file, "secreta")).toBe("wrongPassword");
    });

    it("parametros del KDF ajenos (iteraciones) se rechazan sin derivar nada", async () => {
      const file = await tamper(await encrypted(), async (zip) => {
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
        manifest.kdf.iterations = 2_000_000_000;
        zip.file("manifest.json", JSON.stringify(manifest));
      });
      expect(await importReason(file, "secreta")).toBe("invalid");
    });

    it("vault.enc ausente o truncado", async () => {
      const missing = await tamper(await encrypted(), async (zip) => {
        zip.remove("vault.enc");
      });
      expect(await importReason(missing, "secreta")).toBe("invalid");
      const truncated = await tamper(await encrypted(), async (zip) => {
        zip.file("vault.enc", new Uint8Array(5));
      });
      expect(await importReason(truncated, "secreta")).toBe("invalid");
    });

    it("una entrada extra junto al cifrado", async () => {
      const file = await tamper(await encrypted(), async (zip) => {
        zip.file("firma.png", makePng());
      });
      expect(await importReason(file, "secreta")).toBe("invalid");
    });
  });

  it("un zip interior ya descifrado pasa las MISMAS validaciones (entrada extra)", async () => {
    // Cifrado "legitimo" (clave y AAD correctos) pero con un zip interior hostil.
    const inner = new JSZip();
    inner.file("manifest.json", manifestJson());
    inner.file("firma.png", makePng());
    inner.file("../x.png", makePng());
    const innerBytes = await inner.generateAsync({ type: "uint8array" });

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const outerManifest = JSON.stringify({
      version: 1,
      kind: "signature-vault-encrypted",
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 600000,
        salt: btoa(String.fromCharCode(...salt)),
      },
      iv: btoa(String.fromCharCode(...iv)),
    });
    const base = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("pw"),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(outerManifest) },
        key,
        innerBytes as BufferSource,
      ),
    );
    const file = await zipFile({ "manifest.json": outerManifest, "vault.enc": cipher });

    expect(await importReason(file, "pw")).toBe("invalid");
  });
});

describe("sin crypto.subtle — src/app/sign-pdf/signVaultFile.ts", () => {
  function stubWithoutSubtle() {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
  }

  it("encryptionAvailable refleja si existe crypto.subtle", () => {
    expect(encryptionAvailable()).toBe(true);
    stubWithoutSubtle();
    expect(encryptionAvailable()).toBe(false);
    vi.stubGlobal("crypto", undefined);
    expect(encryptionAvailable()).toBe(false);
  });

  it("el export con contraseña da encryptionUnavailable y el plano sigue funcionando", async () => {
    stubWithoutSubtle();
    expect(await exportVaultEntry(ENTRY, { password: "x" })).toEqual({
      ok: false,
      reason: "encryptionUnavailable",
    });
    const plain = await exported();
    expect(plain.encrypted).toBe(false);
    expect((await importVaultFile(asFile(plain.blob))).ok).toBe(true);
  });

  it("importar un archivo cifrado sin crypto.subtle da encryptionUnavailable (con o sin contraseña)", async () => {
    const out = await exported({ password: "x" });
    stubWithoutSubtle();
    expect(await importReason(asFile(out.blob), "x")).toBe("encryptionUnavailable");
    expect(await importReason(asFile(out.blob))).toBe("encryptionUnavailable");
  });
});

describe("importVaultFile — archivos hostiles o rotos — src/app/sign-pdf/signVaultFile.ts", () => {
  it("un zip valido a mano es aceptado (linea base de las pruebas siguientes)", async () => {
    expect(await importReason(await zipFile(validContents()))).toBe("ok");
  });

  it("rechaza ANTES de abrir el zip un archivo de mas de 4 MB", async () => {
    const loadAsync = vi.spyOn(JSZip, "loadAsync");
    const big = new File([new Uint8Array(MAX_VAULT_FILE_BYTES + 1)], "grande.zip");
    expect(await importVaultFile(big)).toEqual({ ok: false, reason: "tooLarge" });
    expect(loadAsync).not.toHaveBeenCalled();
  });

  it("no lanza con entradas que no son un archivo", async () => {
    expect(await importReason(null as unknown as File)).toBe("invalid");
    expect(await importReason({} as unknown as File)).toBe("invalid");
    expect(await importReason(new File([], "vacio.zip"))).toBe("invalid");
    expect(
      await importReason(new File([new Uint8Array(500).fill(7)], "basura.zip")),
    ).toBe("invalid");
    const failing = {
      size: 10,
      arrayBuffer: () => Promise.reject(new Error("lectura fallida")),
    } as unknown as File;
    expect(await importReason(failing)).toBe("invalid");
  });

  it("rechaza rutas con ../ , barras o carpetas", async () => {
    for (const evil of ["../x.png", "a/firma.png", "a\\firma.png", "..\\x.png", "/firma.png"]) {
      const file = await zipFile({ ...validContents(), [evil]: makePng() });
      expect(await importReason(file), evil).toBe("invalid");
    }
    // Y tampoco si el nombre malicioso REEMPLAZA a una entrada de la lista blanca.
    const replaced = await zipFile({
      "manifest.json": manifestJson(),
      "../firma.png": makePng(),
    });
    expect(await importReason(replaced)).toBe("invalid");
  });

  it("rechaza una entrada extra fuera de la lista blanca", async () => {
    const file = await zipFile({ ...validContents(), "extra.txt": "hola" });
    expect(await importReason(file)).toBe("invalid");
    const withEnc = await zipFile({ ...validContents(), "vault.enc": new Uint8Array(40) });
    expect(await importReason(withEnc)).toBe("invalid");
  });

  it("rechaza mas de 4 entradas", async () => {
    const file = await zipFile({
      ...validContents(),
      "iniciales.png": makePng(),
      "a.png": makePng(),
      "b.png": makePng(),
      "c.png": makePng(),
    });
    expect(await importReason(file)).toBe("invalid");
  });

  it("rechaza si falta el manifiesto o si no hay ninguna imagen", async () => {
    expect(await importReason(await zipFile({ "firma.png": makePng() }))).toBe("invalid");
    expect(
      await importReason(await zipFile({ "manifest.json": manifestJson() })),
    ).toBe("invalid");
  });

  it("rechaza un PNG falso (cabecera incorrecta) o truncado", async () => {
    const fake = await zipFile({
      "manifest.json": manifestJson(),
      "firma.png": new TextEncoder().encode("GIF89a esto no es un png ni de broma"),
    });
    expect(await importReason(fake)).toBe("invalid");

    const truncated = makePng().subarray(0, 30);
    expect(
      await importReason(
        await zipFile({ "manifest.json": manifestJson(), "firma.png": truncated }),
      ),
    ).toBe("invalid");

    const noEnd = makePng();
    noEnd[noEnd.length - 1] ^= 0xff;
    expect(
      await importReason(
        await zipFile({ "manifest.json": manifestJson(), "firma.png": noEnd }),
      ),
    ).toBe("invalid");
  });

  it("rechaza dimensiones fuera de rango en el IHDR (0 o > 4096 px)", async () => {
    for (const dims of [
      { width: 4097, height: 10 },
      { width: 10, height: 5000 },
      { width: 0, height: 10 },
      { width: 10, height: 0 },
    ]) {
      const file = await zipFile({
        "manifest.json": manifestJson(),
        "firma.png": makePng(dims),
      });
      expect(await importReason(file), JSON.stringify(dims)).toBe("invalid");
    }
    const edge = await zipFile({
      "manifest.json": manifestJson(),
      "firma.png": makePng({ width: 4096, height: 4096 }),
    });
    expect(await importReason(edge)).toBe("ok");
  });

  it("rechaza un PNG de mas de 600 KB, incluso si comprime muy bien (bomba)", async () => {
    const over = await zipFile({
      "manifest.json": manifestJson(),
      "firma.png": makePng({ totalBytes: MAX_VAULT_IMAGE_BYTES + 1 }),
    });
    expect(await importReason(over)).toBe("invalid");

    const bomb = await zipFile(
      {
        "manifest.json": manifestJson(),
        "firma.png": makePng({ totalBytes: 3 * 1024 * 1024 }),
      },
      { compression: "DEFLATE" },
    );
    // Comprimido es minusculo; descomprimido pasaria de los 600 KB.
    expect(bomb.size).toBeLessThan(50 * 1024);
    expect(await importReason(bomb)).toBe("invalid");
  });

  it("corta la descompresion aunque la cabecera MIENTA sobre el tamaño", async () => {
    const bomb = await zipFile(
      {
        "manifest.json": manifestJson(),
        "firma.png": makePng({ totalBytes: 3 * 1024 * 1024 }),
      },
      { compression: "DEFLATE" },
    );
    const bytes = new Uint8Array(await bomb.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let patched = 0;
    for (let i = 0; i + 46 < bytes.length; i += 1) {
      // Cabecera del directorio central: PK\x01\x02.
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLength));
      if (name === "firma.png") {
        view.setUint32(i + 24, 1000, true); // tamaño descomprimido "declarado"
        patched += 1;
      }
    }
    expect(patched).toBe(1);
    expect(
      await importReason(new File([bytes as BlobPart], "mentira.zip")),
    ).toBe("invalid");
  });

  it("manifiesto de version futura -> unsupportedVersion; version rara -> invalid", async () => {
    expect(
      await importReason(await zipFile(validContents({ version: 2 }))),
    ).toBe("unsupportedVersion");
    expect(
      await importReason(await zipFile(validContents({ version: 99 }))),
    ).toBe("unsupportedVersion");
    for (const version of [0, -1, 1.5, "1", null]) {
      expect(
        await importReason(await zipFile(validContents({ version }))),
        String(version),
      ).toBe("invalid");
    }
  });

  it("una version futura se detecta aunque traiga entradas que esta version no conoce", async () => {
    const file = await zipFile({
      ...validContents({ version: 2 }),
      "firma.webp": makePng(),
    });
    expect(await importReason(file)).toBe("unsupportedVersion");
  });

  it("rechaza manifiestos con campos de tipo incorrecto, vacios o demasiado largos", async () => {
    const bad: Record<string, unknown>[] = [
      { signerName: 42 },
      { signerName: ["Ana"] },
      { signerName: null },
      { signerName: "" },
      { signerName: "   " },
      { signerName: "\u0001\u0002" },
      { signerName: "x".repeat(201) },
      { role: 7 },
      { role: "r".repeat(201) },
      { sourceDocument: { a: 1 } },
      { sourceDocument: "d".repeat(201) },
      { exportedAt: 123 },
      { kind: "otra-cosa" },
      { kind: undefined },
    ];
    for (const override of bad) {
      const file = await zipFile(validContents(override));
      expect(await importReason(file), JSON.stringify(override)).toBe("invalid");
    }
    // 200 exactos si entran.
    expect(
      await importReason(await zipFile(validContents({ signerName: "x".repeat(200) }))),
    ).toBe("ok");
  });

  it("rechaza un manifiesto que no es JSON, que no es objeto o que pesa demasiado", async () => {
    for (const text of ["esto no es json", "[]", "null", "42", "{"]) {
      const file = await zipFile({ "manifest.json": text, "firma.png": makePng() });
      expect(await importReason(file), text).toBe("invalid");
    }
    const huge = await zipFile({
      "manifest.json": manifestJson({ relleno: "z".repeat(40_000) }),
      "firma.png": makePng(),
    });
    expect(await importReason(huge)).toBe("invalid");
  });

  it("limpia los caracteres de control de los nombres importados", async () => {
    const file = await zipFile(
      validContents({ signerName: "Ana\u0000\u0007\nPérez", role: "\u0001Jefa\u001b" }),
    );
    const result = await importVaultFile(file);
    expect(result.ok && result.entry.signerName).toBe("Ana   Pérez");
    expect(result.ok && result.entry.role).toBe("Jefa");
  });

  it("un zip cifrado cuyo interior declara kind 'encrypted' no se anida", async () => {
    // El interior de un cifrado debe ser "signature-vault"; aqui un archivo
    // plano que se declara cifrado pero sin vault.enc ni parametros.
    const file = await zipFile({
      "manifest.json": JSON.stringify({ version: 1, kind: "signature-vault-encrypted" }),
      "firma.png": makePng(),
    });
    expect(await importReason(file, "pw")).toBe("invalid");
  });
});

describe("importar: IHDR y texto endurecidos (W3 r2) — src/app/sign-pdf/signVaultFile.ts", () => {
  async function importPng(png: Uint8Array) {
    return importReason(
      await zipFile({ "manifest.json": manifestJson(), "firma.png": png }),
    );
  }

  it("un PNG integro sigue importandose", async () => {
    expect(await importPng(makePng({ seed: 3 }))).toBe("ok");
  });

  it("rechaza un IHDR cuya longitud no es 13", async () => {
    for (const length of [0, 12, 14, 0xffffffff]) {
      const png = makePng();
      new DataView(png.buffer).setUint32(8, length);
      expect(await importPng(png)).toBe("invalid");
    }
  });

  it("rechaza un IHDR con el CRC alterado (aunque las dimensiones sigan siendo validas)", async () => {
    const png = makePng();
    png[29] ^= 0xff;
    expect(await importPng(png)).toBe("invalid");

    // Cambiar las dimensiones sin recalcular el CRC tambien se detecta.
    const resized = makePng({ width: 40, height: 20 });
    new DataView(resized.buffer).setUint32(16, 41);
    expect(await importPng(resized)).toBe("invalid");
  });

  it("quita las marcas bidireccionales de nombre, cargo y documento", async () => {
    const file = await zipFile({
      "manifest.json": manifestJson({
        signerName: "Ana‮ P‎érez⁦",
        role: "Dir‪ectora‏",
        sourceDocument: "con⁩trato‭.pdf",
      }),
      "firma.png": makePng({ seed: 1 }),
    });
    const result = await importVaultFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.signerName).toBe("Ana Pérez");
    expect(result.entry.role).toBe("Directora");
    expect(result.entry.sourceDocument).toBe("contrato.pdf");
  });

  it("un nombre que son SOLO marcas bidireccionales queda vacio y se rechaza", async () => {
    const file = await zipFile({
      "manifest.json": manifestJson({ signerName: "‮‏⁦" }),
      "firma.png": makePng({ seed: 1 }),
    });
    expect(await importReason(file)).toBe("invalid");
  });

  it("exportar con el documento por defecto lo incluye en el nombre y exportar una entrada SIN documento no falla", async () => {
    const withDoc = await exported(undefined, ENTRY);
    expect(withDoc.filename).toBe("Firma-ana-perez-contrato-de-arrendamiento.zip");
    for (const opts of [undefined, { includeDocumentName: true }, { includeDocumentName: false }]) {
      const result = await exportVaultEntry({ ...ENTRY, sourceDocument: "" }, opts);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.filename).toBe("Firma-ana-perez.zip");
    }
  });
});
