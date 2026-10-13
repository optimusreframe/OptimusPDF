import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { glyphNameText, simpleEncodingFor, standardGlyphWidth } from "@/lib/pdf/editTextRemoveEncoding";

/**
 * Wave 8 · F2 · ronda 3: codificaciones de las fuentes simples (WinAnsi real de
 * cp1252, MacRoman, StandardEncoding, /Differences) y anchos AFM por nombre de
 * glifo. Se comparan con la propia tabla de pdf-lib, que es con la que la app
 * dibuja el texto de las fuentes estandar.
 */

async function fontDict(entries: Record<string, unknown>): Promise<{ doc: PDFDocument; dict: PDFDict }> {
  const doc = await PDFDocument.create();
  const dict = doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", ...entries }) as PDFDict;
  return { doc, dict };
}

async function encodingOf(entries: Record<string, unknown>, nonSymbolic = false) {
  const { doc, dict } = await fontDict(entries);
  return simpleEncodingFor(doc.context, dict, nonSymbolic);
}

describe("WinAnsiEncoding (cp1252 real)", () => {
  it("0x80–0x9F son el euro, las comillas tipograficas, la vineta, el em dash, el ™ y el resto, no caracteres de control", async () => {
    const enc = (await encodingOf({ Encoding: "WinAnsiEncoding" }))!;
    const expected: Record<number, string> = {
      0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
      0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
      0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
    };
    for (const [code, text] of Object.entries(expected)) expect(enc.textOf(Number(code)), `0x${Number(code).toString(16)}`).toBe(text);
    expect(enc.nameOf(0x85)).toBe("ellipsis");
    expect(enc.nameOf(0x95)).toBe("bullet");
    expect(enc.nameOf(0x99)).toBe("trademark");
    expect(enc.nameOf(0x97)).toBe("emdash");
  });

  it("ASCII, Latin-1 y los casos especiales del anexo D (0xAD guion, codigos sin uso = vineta)", async () => {
    const enc = (await encodingOf({ Encoding: "WinAnsiEncoding" }))!;
    expect(enc.textOf(0x41)).toBe("A");
    expect(enc.textOf(0x20)).toBe(" ");
    expect(enc.textOf(0xa0)).toBe(" ");
    expect(enc.textOf(0xe9)).toBe("é");
    expect(enc.textOf(0xf1)).toBe("ñ");
    expect(enc.textOf(0xad)).toBe("-");
    for (const code of [0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d]) expect(enc.textOf(code)).toBe("•");
    expect(enc.textOf(0x05)).toBeNull();
  });
});

describe("MacRomanEncoding", () => {
  it("acentos, em dash, vineta, puntos suspensivos y el signo de moneda de PDF (0xDB)", async () => {
    const enc = (await encodingOf({ Encoding: "MacRomanEncoding" }))!;
    expect(enc.textOf(0x8e)).toBe("é");
    expect(enc.textOf(0x84)).toBe("Ñ");
    expect(enc.textOf(0x9c)).toBe("ú");
    expect(enc.textOf(0xd1)).toBe("—");
    expect(enc.textOf(0xd0)).toBe("–");
    expect(enc.textOf(0xa5)).toBe("•");
    expect(enc.textOf(0xc9)).toBe("…");
    expect(enc.textOf(0xaa)).toBe("™");
    expect(enc.textOf(0xdb)).toBe("¤");
    expect(enc.textOf(0xca)).toBe(" ");
    expect(enc.textOf(0xf0)).toBeNull(); // apple: no es un glifo estandar
    expect(enc.textOf(0x41)).toBe("A");
    expect(enc.nameOf(0xd1)).toBe("emdash");
    expect(enc.nameOf(0xa5)).toBe("bullet");
    expect(enc.nameOf(0xb0)).toBeNull(); // infinity: sin nombre WinAnsi, sin ancho conocido
  });
});

describe("StandardEncoding y fuentes sin /Encoding", () => {
  it("una fuente no simbolica sin /Encoding parte de StandardEncoding: comillas, ﬁ, ﬂ y mitad alta de Adobe", async () => {
    const enc = (await encodingOf({}, true))!;
    expect(enc.textOf(0x27)).toBe("’");
    expect(enc.textOf(0x60)).toBe("‘");
    expect(enc.textOf(0xae)).toBe("ﬁ");
    expect(enc.textOf(0xaf)).toBe("ﬂ");
    expect(enc.textOf(0xa4)).toBe("⁄");
    expect(enc.textOf(0xb7)).toBe("•");
    expect(enc.textOf(0xbc)).toBe("…");
    expect(enc.textOf(0xfb)).toBe("ß");
    expect(enc.textOf(0x41)).toBe("A");
    expect(enc.nameOf(0xae)).toBe("fi");
    expect(enc.nameOf(0x27)).toBe("quoteright");
  });

  it("sin /Encoding en una fuente simbolica o incrustada, o con una codificacion que no se conoce: null", async () => {
    expect(await encodingOf({}, false)).toBeNull();
    expect(await encodingOf({ Encoding: "MacExpertEncoding" }, true)).toBeNull();
    expect(await encodingOf({ Encoding: "Identity-H" }, true)).toBeNull();
    expect(await encodingOf({ Encoding: { Type: "Encoding", BaseEncoding: "MacExpertEncoding" } }, true)).toBeNull();
  });
});

describe("/Differences", () => {
  it("sustituye codigos por nombre de glifo: ligaduras, uniXXXX, nombres desconocidos y el resto sigue siendo la base", async () => {
    const enc = (await encodingOf({
      Encoding: { Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: [1, "fi", "uni0041", "g23", 10, "bullet", "Euro"] },
    }))!;
    expect(enc.textOf(1)).toBe("ﬁ");
    expect(enc.textOf(2)).toBe("A");
    expect(enc.textOf(3)).toBeNull();
    expect(enc.nameOf(3)).toBe("g23");
    expect(enc.textOf(10)).toBe("•");
    expect(enc.textOf(11)).toBe("€");
    expect(enc.nameOf(1)).toBe("fi");
    expect(enc.textOf(0x42)).toBe("B");
    expect(enc.textOf(0x95)).toBe("•");
  });

  it("sin /BaseEncoding parte de StandardEncoding en una fuente no simbolica y solo de los codigos dados en una simbolica", async () => {
    const entries = { Encoding: { Type: "Encoding", Differences: [65, "bullet"] } };
    const standard = (await encodingOf(entries, true))!;
    expect(standard.textOf(65)).toBe("•");
    expect(standard.textOf(66)).toBe("B");
    expect(standard.textOf(0xae)).toBe("ﬁ");
    const symbolic = (await encodingOf(entries, false))!;
    expect(symbolic.textOf(65)).toBe("•");
    expect(symbolic.textOf(66)).toBeNull();
  });
});

describe("glyphNameText", () => {
  it("lista latina, uniXXXX, uXXXXX, componentes con guion bajo y sufijos", () => {
    expect(glyphNameText("A")).toBe("A");
    expect(glyphNameText("space")).toBe(" ");
    expect(glyphNameText("hyphen")).toBe("-");
    expect(glyphNameText("Euro")).toBe("€");
    expect(glyphNameText("ellipsis")).toBe("…");
    expect(glyphNameText("trademark")).toBe("™");
    expect(glyphNameText("fi")).toBe("ﬁ");
    expect(glyphNameText("ffi")).toBe("ﬃ");
    expect(glyphNameText("f_i")).toBe("fi");
    expect(glyphNameText("a.alt")).toBe("a");
    expect(glyphNameText("uni00410042")).toBe("AB");
    expect(glyphNameText("u1F600")).toBe("😀");
    expect(glyphNameText("fraction")).toBe("⁄");
    expect(glyphNameText("zzz")).toBeNull();
    expect(glyphNameText("g23")).toBeNull();
    expect(glyphNameText("uniD800")).toBeNull();
    expect(glyphNameText("")).toBeNull();
  });
});

describe("standardGlyphWidth", () => {
  it("anchos AFM por nombre de glifo", () => {
    expect(standardGlyphWidth("Helvetica", "bullet")).toBe(350);
    expect(standardGlyphWidth("Helvetica", "emdash")).toBe(1000);
    expect(standardGlyphWidth("Helvetica", "ellipsis")).toBe(1000);
    expect(standardGlyphWidth("Helvetica", "trademark")).toBe(1000);
    expect(standardGlyphWidth("Helvetica", "fi")).toBe(500);
    expect(standardGlyphWidth("Helvetica", "space")).toBe(278);
    expect(standardGlyphWidth("Times-Roman", "bullet")).toBe(350);
    expect(standardGlyphWidth("Courier", "ellipsis")).toBe(600);
    expect(standardGlyphWidth("Helvetica", "no-existe")).toBe(0);
  });

  it("coincide con el ancho que usa pdf-lib para dibujar, en toda la tabla WinAnsi y en las 12 fuentes latinas", async () => {
    const doc = await PDFDocument.create();
    const names: Array<[StandardFonts, string]> = [
      [StandardFonts.Helvetica, "Helvetica"],
      [StandardFonts.HelveticaBold, "Helvetica-Bold"],
      [StandardFonts.HelveticaOblique, "Helvetica-Oblique"],
      [StandardFonts.HelveticaBoldOblique, "Helvetica-BoldOblique"],
      [StandardFonts.TimesRoman, "Times-Roman"],
      [StandardFonts.TimesRomanBold, "Times-Bold"],
      [StandardFonts.TimesRomanItalic, "Times-Italic"],
      [StandardFonts.TimesRomanBoldItalic, "Times-BoldItalic"],
      [StandardFonts.Courier, "Courier"],
      [StandardFonts.CourierBold, "Courier-Bold"],
      [StandardFonts.CourierOblique, "Courier-Oblique"],
      [StandardFonts.CourierBoldOblique, "Courier-BoldOblique"],
    ];
    const enc = (await encodingOf({ Encoding: "WinAnsiEncoding" }))!;
    let compared = 0;
    for (const [standard, afm] of names) {
      const font = await doc.embedFont(standard);
      for (let code = 0x20; code <= 0xff; code += 1) {
        const text = enc.textOf(code);
        const name = enc.nameOf(code);
        if (text === null || name === null || [0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(code)) continue;
        expect(standardGlyphWidth(afm, name), `${afm} 0x${code.toString(16)} ${name}`).toBe(font.widthOfTextAtSize(text, 1000));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(12 * 200);
  });
});

describe("la fuente que pdf-lib escribe en el PDF", () => {
  it("lleva /Encoding WinAnsiEncoding y ningun ToUnicode: el caso que cubre este modulo", async () => {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    source.addPage().drawText("hola", { font });
    const doc = await PDFDocument.load(await source.save());
    const dict = [...doc.context.enumerateIndirectObjects()]
      .map(([, object]) => object)
      .find((object): object is PDFDict => object instanceof PDFDict && object.get(PDFName.of("Type"))?.toString() === "/Font");
    expect(dict).toBeDefined();
    expect(dict!.get(PDFName.of("Encoding"))?.toString()).toBe("/WinAnsiEncoding");
    expect(dict!.has(PDFName.of("ToUnicode"))).toBe(false);
    expect(simpleEncodingFor(doc.context, dict!, true)!.textOf(0x85)).toBe("…");
  });
});
