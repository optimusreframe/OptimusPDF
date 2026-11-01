import { describe, expect, it } from "vitest";
import { cleanValue, clip, collapseSpaces, fold, hasFiller, isAllLower, isAllUpper, isBlank, isJunkValue, isSmallWord, normalizeText, stripFiller, titleWord } from "@/lib/autofill/text";

describe("fold — plegado que conserva la longitud", () => {
  it("quita tildes y mayusculas sin cambiar el largo", () => {
    for (const sample of ["Año Ñandú", "ÁLVAREZ PÉREZ", "Müller Straße", "İstanbul", "Crème brûlée", "123 Main St."]) {
      expect(fold(sample)).toHaveLength(sample.length);
    }
    expect(fold("ÁLVAREZ")).toBe("alvarez");
    expect(fold("Pérez García")).toBe("perez garcia");
  });

  it("no toca ASCII ni signos", () => {
    expect(fold("Policy No. 12-AB/3456 #")).toBe("policy no. 12-ab/3456 #");
  });

  it("emojis y caracteres raros no rompen los indices", () => {
    const sample = "Dirección 🏠 calle 5 — ñ";
    expect(fold(sample)).toHaveLength(sample.length);
  });
});

describe("normalizeText", () => {
  it("unifica comillas, espacios raros y quita caracteres de control", () => {
    expect(normalizeText("Named Insured’s Name​(s)")).toBe("Named Insured's Name(s)");
    expect(normalizeText("a\u0000b\u0007c")).toBe("a b c");
    expect(normalizeText("“hola”")).toBe('"hola"');
  });
});

describe("rellenos y valores basura", () => {
  it("reconoce rayas, puntos largos y casillas como relleno", () => {
    expect(hasFiller("____")).toBe(true);
    expect(hasFiller("Insured: ________")).toBe(true);
    expect(hasFiller("...... ")).toBe(true);
    expect(hasFiller("a.b.c")).toBe(false);
    expect(hasFiller("Maria Perez")).toBe(false);
    expect(hasFiller("1-2-3")).toBe(false);
  });

  it("stripFiller deja el texto de encima de la raya", () => {
    expect(collapseSpaces(stripFiller("____ Maria Perez ____"))).toBe("Maria Perez");
    expect(stripFiller("a____b", "|")).toBe("a|b");
  });

  it("isBlank: solo relleno, espacios y signos", () => {
    expect(isBlank("________")).toBe(true);
    expect(isBlank(" : ____ / ")).toBe(true);
    expect(isBlank("")).toBe(true);
    expect(isBlank("__ x __")).toBe(false);
  });

  it("isJunkValue", () => {
    for (const junk of ["N/A", "n/a", "NA", "none", "TBD", "pendiente", "Ninguno", "x", "-", "___", "Same as above", "no aplica", "  ", "?"]) expect(isJunkValue(junk)).toBe(true);
    for (const real of ["Maria", "12-AB", "Nadia", "Nancy"]) expect(isJunkValue(real)).toBe(false);
  });

  it("cleanValue quita relleno y signos de los extremos", () => {
    expect(cleanValue("  : ____ Maria  Perez ____ ,")).toBe("Maria Perez");
    expect(cleanValue("• Hello")).toBe("Hello");
  });
});

describe("mayusculas", () => {
  it("isAllUpper / isAllLower ignoran lo que no son letras", () => {
    expect(isAllUpper("MARIA PEREZ 123")).toBe(true);
    expect(isAllUpper("Maria PEREZ")).toBe(false);
    expect(isAllUpper("A")).toBe(false);
    expect(isAllLower("maria perez")).toBe(true);
    expect(isAllLower("maria Perez")).toBe(false);
  });

  it("titleWord respeta guiones, apostrofes y Mc", () => {
    expect(titleWord("PEREZ-LOPEZ")).toBe("Perez-Lopez");
    expect(titleWord("o'brien")).toBe("O'Brien");
    expect(titleWord("MCDONALD")).toBe("McDonald");
    expect(titleWord("MUÑOZ")).toBe("Muñoz");
    expect(titleWord("")).toBe("");
  });

  it("isSmallWord", () => {
    expect(isSmallWord("DE")).toBe(true);
    expect(isSmallWord("del")).toBe(true);
    expect(isSmallWord("Maria")).toBe(false);
  });

  it("clip recorta con puntos suspensivos", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
});
