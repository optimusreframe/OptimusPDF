import { describe, expect, it } from "vitest";
import { forgeZip } from "@/lib/backup/__fixtures__/zipForge";
import { parseStrictJson } from "@/lib/backup/strictJson";
import { PACKAGE_LIMITS } from "@/lib/backup/types";
import { isSafeEntryPath, readZipDirectory } from "@/lib/backup/zipDirectory";

const enc = new TextEncoder();

function codeOf(run: () => unknown): string {
  try {
    run();
    return "no-error";
  } catch (error) {
    return (error as { code?: string }).code ?? "otro";
  }
}

describe("isSafeEntryPath — src/lib/backup/zipDirectory.ts", () => {
  it("acepta rutas normales y carpetas", () => {
    for (const ok of ["manifest.json", "signatures/a-signature.png", "templates/", "a/b/c.txt", "ñandú/x.png", "a b.png", ".hidden", "..a", "a..b", "a./b"]) {
      expect([ok, isSafeEntryPath(ok)]).toEqual([ok, true]);
    }
  });

  it("rechaza lo que escapa o disfraza", () => {
    for (const bad of ["", "/", "//", "/abs", "..", "../x", "a/..", "a/../b", ".", "./a", "a/./b", "a//b", "a\\b", "C:/x", "z:x", "a\u0000b", "a\tb", "a\u007fb", "a\u0085b", "a\u202eb", "a\u200fb", "a\u2066b", "x".repeat(201)]) {
      expect([JSON.stringify(bad).slice(0, 24), isSafeEntryPath(bad)]).toEqual([JSON.stringify(bad).slice(0, 24), false]);
    }
    expect(isSafeEntryPath("x".repeat(200))).toBe(true);
  });
});

describe("readZipDirectory — src/lib/backup/zipDirectory.ts", () => {
  it("lee nombres, metodo y tamaños declarados sin inflar", () => {
    const dirEntries = readZipDirectory(
      forgeZip([
        { name: "a.json", data: enc.encode("{\"a\":1,\"a\":1,\"a\":1,\"a\":1}") },
        { name: "b.bin", data: enc.encode("xyz"), method: 0 },
        { name: "carpeta/", data: new Uint8Array(), method: 0 },
      ]),
    );
    expect(dirEntries.map((e) => [e.name, e.isDir, e.method, e.uncompressedSize])).toEqual([
      ["a.json", false, 8, 25],
      ["b.bin", false, 0, 3],
      ["carpeta/", true, 0, 0],
    ]);
  });

  it("limite de entradas exacto: 2000 si, 2001 no", () => {
    const make = (n: number) => forgeZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: enc.encode("x"), method: 0 as const })));
    expect(readZipDirectory(make(PACKAGE_LIMITS.maxEntries))).toHaveLength(2000);
    expect(codeOf(() => readZipDirectory(make(PACKAGE_LIMITS.maxEntries + 1)))).toBe("tooManyEntries");
  });

  it("metodo de compresion distinto de 0 y 8 -> badZip ya en el directorio (sin depender de JSZip)", () => {
    const manifest = { name: "manifest.json", data: enc.encode("{}") };
    expect(codeOf(() => readZipDirectory(forgeZip([manifest, { name: "x", data: enc.encode("x"), method: 9 as never }])))).toBe("badZip");
    expect(codeOf(() => readZipDirectory(forgeZip([manifest, { name: "x", data: enc.encode("x"), method: 0 }])))).toBe("no-error");
  });

  it("un zip sin entradas, sin EOCD o mas corto que un EOCD es badZip", () => {
    expect(codeOf(() => readZipDirectory(new Uint8Array(10)))).toBe("badZip");
    expect(codeOf(() => readZipDirectory(new Uint8Array(100)))).toBe("badZip");
    expect(codeOf(() => readZipDirectory(forgeZip([])))).toBe("badZip");
  });

  it("nombre con bytes que no son UTF-8 valido (bandera UTF-8) -> unsafePath", () => {
    const bytes = forgeZip([{ name: "aXb", data: enc.encode("x") }]);
    const at = bytes.findIndex((b, i) => b === 0x58 && bytes[i - 1] === 0x61 && i > 40);
    // parchea el nombre del registro central (y el local)
    for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x58 && bytes[i - 1] === 0x61) bytes[i] = 0xff;
    expect(at).toBeGreaterThan(0);
    expect(codeOf(() => readZipDirectory(bytes))).toBe("unsafePath");
  });
});

describe("parseStrictJson — src/lib/backup/strictJson.ts", () => {
  const parse = (text: string, max = 1000, depth?: number) => parseStrictJson(enc.encode(text), max, depth);

  it("acepta JSON normal y respeta el tope de bytes exacto", () => {
    expect(parse("{\"a\":[1,2,{\"b\":null}]}")).toEqual({ a: [1, 2, { b: null }] });
    expect(parse("[1]", 3)).toEqual([1]);
    expect(codeOf(() => parse("[1]", 2))).toBe("invalidJson");
  });

  it("profundidad: 16 niveles pasan, 17 no; los corchetes dentro de cadenas no cuentan", () => {
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(parse(nest(16), 1000)).toBeTruthy();
    expect(codeOf(() => parse(nest(17), 1000))).toBe("invalidJson");
    expect(parse(`["${"[".repeat(500)}", "\\"[[[["]`, 5000)).toBeTruthy();
    expect(parse(nest(5), 1000, 5)).toBeTruthy();
    expect(codeOf(() => parse(nest(6), 1000, 5))).toBe("invalidJson");
  });

  it("no JSON, BOM, UTF-8 invalido, NaN y comentarios -> invalidJson", () => {
    for (const bad of ["", "{", "{'a':1}", "[1,]", "NaN", "// c\n{}", "\ufeff{}", "undefined"]) {
      expect([bad, codeOf(() => parse(bad))]).toEqual([bad, "invalidJson"]);
    }
    expect(codeOf(() => parseStrictJson(new Uint8Array([0x7b, 0xff, 0x7d]), 100))).toBe("invalidJson");
  });

  it("una cadena con la barra invertida al final del escapado no desordena la cuenta de profundidad", () => {
    expect(parse(String.raw`["a\\", [1]]`)).toEqual(["a\\", [1]]);
  });
});
