import { describe, expect, it } from "vitest";
import { normalizeTypedAddress, validateSnapshotUrl } from "@/lib/htmlSnapshot/urlGuard";

function code(raw: string) {
  const result = validateSnapshotUrl(raw);
  return result.ok ? "ok" : result.code;
}

describe("validateSnapshotUrl — direcciones validas", () => {
  it("acepta http y https con los puertos por defecto o 80/443", () => {
    expect(code("https://example.com/")).toBe("ok");
    expect(code("http://example.com/a/b?c=d#e")).toBe("ok");
    expect(code("https://example.com:443/x")).toBe("ok");
    expect(code("http://example.com:80/x")).toBe("ok");
    expect(code("  https://example.com/con-espacios-fuera  ")).toBe("ok");
    expect(code("https://[2606:4700:4700::1111]/")).toBe("ok");
    expect(code("https://8.8.8.8/")).toBe("ok");
    expect(code("https://ejemplo.mx./")).toBe("ok"); // punto final
    expect(code("https://español.example.com/")).toBe("ok"); // IDN -> punycode
  });

  it("devuelve el nombre normalizado y la IP literal", () => {
    const result = validateSnapshotUrl("https://EXAMPLE.com/Path");
    expect(result.ok && result.hostname).toBe("example.com");
    const literal = validateSnapshotUrl("https://8.8.8.8/");
    expect(literal.ok && literal.literalIp).toBe("8.8.8.8");
  });
});

describe("validateSnapshotUrl — corpus hostil", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://127.0.0.1:80/admin",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.5/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[64:ff9b::7f00:1]/",
    // Formas camufladas de 127.0.0.1 que el analizador de URL normaliza
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://127.0.0.1./",
    // Nombres que nunca son publicos
    "http://localhost/",
    "http://LOCALHOST:80/",
    "http://api.localhost/",
    "http://impresora.local/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://servidor.internal/",
    "http://intranet/",
    "http://router/",
    "http://wpad.home.arpa/",
  ];
  for (const raw of blocked) {
    it(`bloquea ${raw}`, () => {
      expect(code(raw)).toBe("blocked-address");
    });
  }

  const invalid: Array<[string, string]> = [
    ["puerto raro", "https://example.com:8443/"],
    ["puerto 22", "http://example.com:22/"],
    ["usuario y contrasena", "https://user:pass@example.com/"],
    ["solo usuario", "https://user@example.com/"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://example.com/"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["javascript:", "javascript:alert(1)"],
    ["blob:", "blob:https://example.com/abc"],
    ["vacia", ""],
    ["solo espacios", "    "],
    ["sin esquema", "example.com/pagina"],
    ["espacio dentro", "https://exam ple.com/"],
    ["salto de linea dentro", "https://example.com/\nGET /x"],
    ["tabulador dentro", "https://exa\tmple.com/"],
    ["IPv4 invalida", "http://1.2.3.4.5/"],
    ["URL de 3 KB", `https://example.com/${"a".repeat(3000)}`],
  ];
  for (const [label, raw] of invalid) {
    it(`rechaza (${label})`, () => {
      expect(code(raw)).toBe("invalid-url");
    });
  }

  it("rechaza lo que no es texto", () => {
    expect(validateSnapshotUrl(undefined as unknown as string)).toEqual({ ok: false, code: "invalid-url" });
    expect(validateSnapshotUrl(42 as unknown as string)).toEqual({ ok: false, code: "invalid-url" });
  });

  it("el limite de 2048 caracteres es exacto", () => {
    const base = "https://example.com/";
    expect(code(base + "a".repeat(2048 - base.length))).toBe("ok");
    expect(code(base + "a".repeat(2049 - base.length))).toBe("invalid-url");
  });
});

describe("normalizeTypedAddress", () => {
  it("añade https:// cuando no hay esquema", () => {
    expect(normalizeTypedAddress("  ejemplo.com/pagina ")).toBe("https://ejemplo.com/pagina");
    expect(normalizeTypedAddress("//ejemplo.com")).toBe("https://ejemplo.com");
    expect(normalizeTypedAddress("localhost:3000/x")).toBe("https://localhost:3000/x");
  });
  it("respeta los esquemas escritos (y deja que los raros fallen en la validacion)", () => {
    expect(normalizeTypedAddress("http://ejemplo.com")).toBe("http://ejemplo.com");
    expect(normalizeTypedAddress("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(normalizeTypedAddress("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(normalizeTypedAddress("")).toBe("");
  });
});
