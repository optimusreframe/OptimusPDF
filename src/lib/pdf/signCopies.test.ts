import { describe, expect, it } from "vitest";
import {
  DEFAULT_COPIES,
  MAX_COPIES,
  MAX_OUTPUT_FILES,
  isValidCopies,
  normalizeCopies,
  outputFileCount,
} from "@/lib/pdf/signCopies";
import {
  MAX_ENTRY_BYTES,
  MAX_ENTRY_CHARS,
  copyFilename,
  signedFilename,
  uniqueNames,
} from "@/lib/pdf/signOutputNames";

describe("limites de copias", () => {
  it("5 copias por documento y 50 archivos por ronda (10 documentos x 5 copias)", () => {
    expect(MAX_COPIES).toBe(5);
    expect(DEFAULT_COPIES).toBe(1);
    expect(MAX_OUTPUT_FILES).toBe(50);
    expect(MAX_OUTPUT_FILES).toBe(10 * MAX_COPIES);
  });

  it("isValidCopies: solo enteros 1..5", () => {
    for (const ok of [1, 2, 3, 4, 5]) expect(isValidCopies(ok)).toBe(true);
    for (const bad of [0, -1, 6, 2.5, Number.NaN, Infinity, "2", null, undefined, {}]) {
      expect(isValidCopies(bad)).toBe(false);
    }
  });

  it("normalizeCopies lleva lo que venga de fuera a 1..5", () => {
    expect([1, 2, 5].map(normalizeCopies)).toEqual([1, 2, 5]);
    expect([0, -4, 0.9, Number.NaN, Infinity, -Infinity].map(normalizeCopies)).toEqual([1, 1, 1, 1, 1, 1]);
    expect([2.9, 5.5, 6, 99].map(normalizeCopies)).toEqual([2, 5, 5, 5]);
    expect([undefined, null, "3", {}, true].map(normalizeCopies)).toEqual([1, 1, 1, 1, 1]);
  });

  it("outputFileCount: suma de las copias (sin dato = 1)", () => {
    expect(outputFileCount([])).toBe(0);
    expect(outputFileCount([2, 2, 2, 2])).toBe(8);
    expect(outputFileCount([undefined, 3, 99, 0])).toBe(1 + 3 + 5 + 1);
  });
});

describe("copyFilename", () => {
  it("la copia 1 es el archivo tal cual; las demas llevan «(copia N)» antes de la extension", () => {
    const name = "Ana y Luis - Contrato-firmado.pdf";
    expect(copyFilename(name, 1, "es")).toBe(name);
    expect(copyFilename(name, 2, "es")).toBe("Ana y Luis - Contrato-firmado (copia 2).pdf");
    expect(copyFilename(name, 5, "es")).toBe("Ana y Luis - Contrato-firmado (copia 5).pdf");
    expect(copyFilename("Ana and Luis - Deal-signed.pdf", 3, "en")).toBe("Ana and Luis - Deal-signed (copy 3).pdf");
  });

  it("copias no validas (0, negativas, decimales) devuelven el nombre original", () => {
    expect(copyFilename("a.pdf", 0, "es")).toBe("a.pdf");
    expect(copyFilename("a.pdf", -2, "es")).toBe("a.pdf");
    expect(copyFilename("a.pdf", 2.5, "es")).toBe("a.pdf");
  });

  it("un nombre sin extension se queda con el sufijo al final", () => {
    expect(copyFilename("sin-extension", 2, "es")).toBe("sin-extension (copia 2)");
  });

  it("respeta los limites del nombre: recorta el cuerpo (con elipsis) y nunca el sufijo", () => {
    const long = signedFilename({ signerNames: ["Ana Maria de los Angeles Fernandez Gonzalez"], documentName: "x".repeat(300), lang: "es" });
    for (const copy of [2, 3, 4, 5]) {
      const result = copyFilename(long, copy, "es");
      expect(result.endsWith(` (copia ${copy}).pdf`)).toBe(true);
      expect([...result].length).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
      expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    }
    // Con multibyte (CJK/emoji) el limite en BYTES manda.
    const wide = `${"合同🙂".repeat(30)}-firmado.pdf`;
    const result = copyFilename(wide, 2, "es");
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(result.endsWith(" (copia 2).pdf")).toBe(true);
    expect(result).toContain("…");
  });

  it("un nombre que ya cabe no se toca ni se le anade elipsis", () => {
    expect(copyFilename("Corto-firmado.pdf", 2, "es")).not.toContain("…");
  });

  it("junto a uniqueNames: 4 documentos x 2 copias = 8 nombres distintos y estables", () => {
    const base = ["Ana - A-firmado.pdf", "Ana - B-firmado.pdf", "Ana - C-firmado.pdf", "Ana - D-firmado.pdf"];
    const wanted = base.flatMap((name) => [1, 2].map((copy) => copyFilename(name, copy, "es")));
    const names = uniqueNames(wanted);
    expect(names).toEqual(wanted);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(8);
  });
});
