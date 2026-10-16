import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PASSWORD_BOX_ITERATIONS,
  PasswordBoxError,
  assertPasswordBoxShape,
  decryptWithPassword,
  encryptWithPassword,
  passwordBoxAvailable,
  type PasswordBoxEnvelope,
} from "@/lib/crypto/passwordBox";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const header = (box: PasswordBoxEnvelope) => JSON.parse(text(box.header));

async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no-error";
  } catch (error) {
    return error instanceof PasswordBoxError ? error.code : `otro:${String(error)}`;
  }
}

describe("passwordBox — src/lib/crypto/passwordBox.ts", () => {
  it("ida y vuelta: bytes vacios, pequeños y de 1 MB", async () => {
    for (const data of [new Uint8Array(), bytes(1, 2, 3), new Uint8Array(1_000_000).map((_, i) => i & 0xff)]) {
      const box = await encryptWithPassword(data, "contraseña");
      expect(Array.from(await decryptWithPassword(box, "contraseña"))).toEqual(Array.from(data));
    }
  });

  it("formato: cabecera JSON {version, kind, kdf{PBKDF2,SHA-256,600000,salt 16 B}, iv 12 B} y payload = cifrado + etiqueta de 16 B", async () => {
    const data = bytes(9, 8, 7);
    const box = await encryptWithPassword(data, "x", { kind: "mi-kind", version: 3 });
    const parsed = header(box);
    expect(Object.keys(parsed)).toEqual(["version", "kind", "kdf", "iv"]);
    expect(parsed).toMatchObject({ version: 3, kind: "mi-kind", kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000 } });
    expect(Object.keys(parsed.kdf)).toEqual(["name", "hash", "iterations", "salt"]);
    expect(atob(parsed.kdf.salt)).toHaveLength(16);
    expect(atob(parsed.iv)).toHaveLength(12);
    expect(box.payload.length).toBe(data.length + 16);
    expect(PASSWORD_BOX_ITERATIONS).toBe(600000);
    // valores por defecto
    expect(header(await encryptWithPassword(data, "x"))).toMatchObject({ version: 1, kind: "password-box" });
  });

  it("es AES-GCM-256 con PBKDF2-SHA256 de verdad: se descifra con WebCrypto a mano (AAD = bytes exactos de la cabecera)", async () => {
    const data = new TextEncoder().encode("hola mundo");
    const box = await encryptWithPassword(data, "pw ñ");
    const parsed = header(box);
    const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode("pw ñ".normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: fromB64(parsed.kdf.salt), iterations: 600000 },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(parsed.iv), additionalData: box.header as BufferSource },
      key,
      box.payload as BufferSource,
    );
    expect(text(new Uint8Array(plain))).toBe("hola mundo");
  });

  it("cada cifrado usa sal e IV nuevos", async () => {
    const [a, b] = [await encryptWithPassword(bytes(1), "x"), await encryptWithPassword(bytes(1), "x")];
    expect(header(a).kdf.salt).not.toBe(header(b).kdf.salt);
    expect(header(a).iv).not.toBe(header(b).iv);
    expect(Array.from(a.payload)).not.toEqual(Array.from(b.payload));
  });

  it("contraseña incorrecta (mayusculas, espacio final, vacia) -> wrongPassword / needsPassword", async () => {
    const box = await encryptWithPassword(bytes(1, 2), "Secreta");
    expect(await code(() => decryptWithPassword(box, "secreta"))).toBe("wrongPassword");
    expect(await code(() => decryptWithPassword(box, "Secreta "))).toBe("wrongPassword");
    expect(await code(() => decryptWithPassword(box, ""))).toBe("needsPassword");
    expect(await code(() => decryptWithPassword(box, undefined))).toBe("needsPassword");
    expect(await code(() => decryptWithPassword(box, "Secreta"))).toBe("no-error");
  });

  it("otra composicion Unicode de la misma contraseña (NFC/NFD, ancho completo) descifra", async () => {
    const box = await encryptWithPassword(bytes(5), "niño-café");
    expect(await code(() => decryptWithPassword(box, "niño-café"))).toBe("no-error");
    const full = await encryptWithPassword(bytes(5), "abc");
    expect(await code(() => decryptWithPassword(full, "ａｂｃ"))).toBe("no-error"); // NFKC
  });

  it("manipulacion = MISMO error que contraseña incorrecta (no se distingue): payload, IV, sal, o cabecera re-serializada", async () => {
    const box = await encryptWithPassword(bytes(1, 2, 3, 4), "pw");
    const flipped = box.payload.slice();
    flipped[0] ^= 1;
    expect(await code(() => decryptWithPassword({ ...box, payload: flipped }, "pw"))).toBe("wrongPassword");
    const b64 = (n: number, fill: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(fill)));
    const iv = header(box);
    iv.iv = b64(12, 7);
    expect(await code(() => decryptWithPassword({ ...box, header: new TextEncoder().encode(JSON.stringify(iv)) }, "pw"))).toBe("wrongPassword");
    const salt = header(box);
    salt.kdf.salt = b64(16, 9);
    expect(await code(() => decryptWithPassword({ ...box, header: new TextEncoder().encode(JSON.stringify(salt)) }, "pw"))).toBe("wrongPassword");
    const pretty = new TextEncoder().encode(JSON.stringify(header(box), null, 1));
    expect(await code(() => decryptWithPassword({ ...box, header: pretty }, "pw"))).toBe("wrongPassword");
    const appended = new Uint8Array([...box.payload, 0]);
    expect(await code(() => decryptWithPassword({ ...box, payload: appended }, "pw"))).toBe("wrongPassword");
  });

  it("estructura mala = `corrupt` ANTES de derivar ninguna clave (un archivo hostil no clava el navegador)", async () => {
    const box = await encryptWithPassword(bytes(1, 2, 3, 4), "pw");
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edit = (change: (h: Record<string, any>) => void): PasswordBoxEnvelope => {
      const h = header(box);
      change(h);
      return { ...box, header: new TextEncoder().encode(JSON.stringify(h)) };
    };
    const cases: Record<string, PasswordBoxEnvelope> = {
      iteraciones: edit((h) => (h.kdf.iterations = 2_000_000_000)),
      iteraciones599: edit((h) => (h.kdf.iterations = 599_999)),
      hash: edit((h) => (h.kdf.hash = "SHA-1")),
      kdfNombre: edit((h) => (h.kdf.name = "scrypt")),
      sinKdf: edit((h) => delete h.kdf),
      kdfNoObjeto: edit((h) => (h.kdf = "x")),
      saltCorta: edit((h) => (h.kdf.salt = btoa("123456789012345"))),
      saltLarga: edit((h) => (h.kdf.salt = btoa("12345678901234567"))),
      saltNoBase64: edit((h) => (h.kdf.salt = "no es base64!!")),
      saltNoString: edit((h) => (h.kdf.salt = 5)),
      ivCorto: edit((h) => (h.iv = btoa("12345678901"))),
      ivLargo: edit((h) => (h.iv = btoa("1234567890123"))),
      ivNoString: edit((h) => (h.iv = null)),
      cabeceraArray: { ...box, header: new TextEncoder().encode("[]") },
      cabeceraNoJson: { ...box, header: new TextEncoder().encode("{no") },
      cabeceraVacia: { ...box, header: new Uint8Array() },
      cabeceraGigante: { ...box, header: new Uint8Array(4097).fill(32) },
      cabeceraNoUtf8: { ...box, header: bytes(0xff, 0xfe, 0xfd) },
      payloadCorto: { ...box, payload: new Uint8Array(15) },
      payloadVacio: { ...box, payload: new Uint8Array() },
      noEsBytes: { ...box, payload: "texto" as never },
    };
    for (const [label, envelope] of Object.entries(cases)) {
      expect([label, await code(() => decryptWithPassword(envelope, "pw"))]).toEqual([label, "corrupt"]);
    }
    expect(derive).not.toHaveBeenCalled();
    // y la caja entera mala: ni objeto
    expect(await code(() => decryptWithPassword(null as never, "pw"))).toBe("corrupt");
    expect(() => assertPasswordBoxShape(box)).not.toThrow();
  });

  it("`expect` exige kind y version: cualquier diferencia es `corrupt`", async () => {
    const box = await encryptWithPassword(bytes(1), "pw", { kind: "k", version: 2 });
    expect(await code(() => decryptWithPassword(box, "pw", { kind: "k", version: 2 }))).toBe("no-error");
    expect(await code(() => decryptWithPassword(box, "pw", { kind: "otro", version: 2 }))).toBe("corrupt");
    expect(await code(() => decryptWithPassword(box, "pw", { kind: "k", version: 1 }))).toBe("corrupt");
  });

  it("orden de comprobaciones: corrupt -> unavailable -> needsPassword -> wrongPassword", async () => {
    const box = await encryptWithPassword(bytes(1), "pw");
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    expect(passwordBoxAvailable()).toBe(false);
    // sin WebCrypto: una caja mala sigue siendo `corrupt`; una buena, `unavailable` (con o sin contraseña)
    expect(await code(() => decryptWithPassword({ ...box, payload: new Uint8Array(3) }, "pw"))).toBe("corrupt");
    expect(await code(() => decryptWithPassword(box, "pw"))).toBe("unavailable");
    expect(await code(() => decryptWithPassword(box, undefined))).toBe("unavailable");
    expect(await code(() => encryptWithPassword(bytes(1), "pw"))).toBe("unavailable");
    vi.stubGlobal("crypto", undefined);
    expect(passwordBoxAvailable()).toBe(false);
  });

  it("cifrar con contraseña vacia o que no es texto -> invalidPassword", async () => {
    expect(await code(() => encryptWithPassword(bytes(1), ""))).toBe("invalidPassword");
    expect(await code(() => encryptWithPassword(bytes(1), undefined as never))).toBe("invalidPassword");
    expect(await code(() => encryptWithPassword(bytes(1), 5 as never))).toBe("invalidPassword");
  });

  it("los errores no filtran nada: mensaje fijo (= codigo), sin la contraseña ni bytes", async () => {
    const box = await encryptWithPassword(bytes(1), "contraseña-super-secreta");
    try {
      await decryptWithPassword(box, "otra-contraseña-privada");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordBoxError);
      const e = error as PasswordBoxError;
      expect(e.message).toBe("wrongPassword");
      expect(e.name).toBe("PasswordBoxError");
      expect(JSON.stringify([e.message, e.stack ?? ""])).not.toContain("privada");
      expect(Object.keys(e).sort()).toEqual(["code", "name"]);
    }
  });

  it("COMPATIBILIDAD: descifra la caja de un archivo de firma exportado con la version anterior (cabecera = manifest.json, payload = vault.enc)", async () => {
    const file = readFileSync(path.resolve(__dirname, "__fixtures__/vault-encrypted-v1.zip"));
    const zip = await JSZip.loadAsync(file);
    const box = {
      header: await zip.file("manifest.json")!.async("uint8array"),
      payload: await zip.file("vault.enc")!.async("uint8array"),
    };
    expect(header(box)).toMatchObject({ version: 1, kind: "signature-vault-encrypted" });
    const inner = await JSZip.loadAsync(await decryptWithPassword(box, "contraseña-dorada·ñ 1"));
    expect(Object.keys(inner.files).sort()).toEqual(["firma.png", "iniciales.png", "manifest.json"]);
    expect(await code(() => decryptWithPassword(box, "mala"))).toBe("wrongPassword");
  });
});
