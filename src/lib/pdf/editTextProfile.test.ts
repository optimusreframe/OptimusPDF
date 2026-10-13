import { describe, expect, it } from "vitest";
import { countNonBlank, glyphProfile } from "@/lib/pdf/editTextProfile";
import { glyphsMatch } from "@/lib/pdf/editTextRemove";

describe("glyphProfile / countNonBlank (NFKC, por punto de codigo)", () => {
  it("cuenta solo los caracteres no blancos y expande lo que NFKC expande", () => {
    expect(glyphProfile("Hola mundo").chars).toBe(9);
    expect(glyphProfile("Oferta…").chars).toBe(9); // … = 3 puntos
    expect(glyphProfile("marca™").chars).toBe(7); // ™ = TM
    expect(glyphProfile("1½").chars).toBe(4); // ½ = 1⁄2
    expect(countNonBlank("a­ ​ b")).toBe(2); // guion blando, espacios y de ancho cero
  });

  it("las ligaduras (ff, fi, fl, ffi, ffl) se cuentan tambien cuando vienen ya fundidas en un solo caracter Unicode", () => {
    expect(glyphProfile("fino").ligatures).toBe(1);
    expect(glyphProfile("ﬁno")).toEqual({ chars: 4, ligatures: 1 }); // U+FB01
    expect(glyphProfile("ﬃce")).toEqual({ chars: 5, ligatures: 2 }); // U+FB03
    expect(glyphProfile("office").ligatures).toBe(2);
    expect(glyphProfile("ﬂor").ligatures).toBe(1);
    expect(glyphProfile("sin nada").ligatures).toBe(0);
  });

  it("el perfil de una ligadura fundida admite el glifo aproximado de un caracter por codigo", () => {
    const approx = (text: string) => ({ text, exact: false });
    // «ﬁne» sin ToUnicode: el glifo de la ligadura se estima como UN caracter; la holgura de ligaduras lo permite.
    expect(glyphsMatch(glyphProfile("ﬁne"), [approx("?"), approx("n"), approx("e")])).toBe(true);
    expect(glyphsMatch(glyphProfile("ﬁne"), [approx("?"), approx("n")])).toBe(false);
    expect(glyphsMatch(glyphProfile("ﬁne"), [approx("?"), approx("n"), approx("e"), approx("x"), approx("y")])).toBe(false);
  });
});

describe("glyphsMatch · rama aproximada (sin ToUnicode) cuenta como el perfil", () => {
  const approx = (text: string) => ({ text, exact: false });
  const glyphs = (text: string) => [...text].map(approx);

  it("N1: «…», «™», «½», «¼», «¾» aportan 3, 2, 3, 3 y 3 caracteres, no 1", () => {
    expect(glyphsMatch(glyphProfile("Oferta limitada… marca™ 1½ tazas"), glyphs("Oferta limitada… marca™ 1½ tazas"))).toBe(true);
    expect(glyphsMatch(glyphProfile("1¼ y 3¾"), glyphs("1¼ y 3¾"))).toBe(true);
  });

  it("sigue siendo exacta: un glifo que sobra o que falta la rompe", () => {
    const text = "Oferta…";
    expect(glyphsMatch(glyphProfile(text), [...glyphs(text), approx("x")])).toBe(false);
    expect(glyphsMatch(glyphProfile(text), glyphs("Oferta"))).toBe(false);
    expect(glyphsMatch(glyphProfile(text), glyphs("Oferta.."))).toBe(false);
    // Los espacios y blancos no cuentan.
    expect(glyphsMatch(glyphProfile("a b"), [approx("a"), approx(" "), approx("b"), approx(" ")])).toBe(true);
  });

  it("un glifo sin texto conocido puede ser un blanco, pero no mas de uno por glifo desconocido", () => {
    expect(glyphsMatch(glyphProfile("ab"), [approx("a"), approx("b"), null])).toBe(true);
    expect(glyphsMatch(glyphProfile("abc"), [approx("a"), approx("b"), null])).toBe(true);
    expect(glyphsMatch(glyphProfile("abcd"), [approx("a"), approx("b"), null])).toBe(false);
  });
});
