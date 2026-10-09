import { describe, expect, it } from "vitest";
import {
  MAX_ENTRY_BYTES,
  MAX_ENTRY_CHARS,
  joinSignerNames,
  safeFilenamePart,
  signedFilename,
  uniqueNames,
  zipFilename,
} from "@/lib/pdf/signOutputNames";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const chars = (text: string) => Array.from(text).length;

describe("safeFilenamePart — src/lib/pdf/signOutputNames.ts", () => {
  it("conserva acentos, mayusculas, enes y espacios internos", () => {
    expect(safeFilenamePart("María José Pérez Ñandú")).toBe("María José Pérez Ñandú");
  });

  it("normaliza a NFC (e + acento combinante -> e acentuada)", () => {
    const decomposed = "Jose\u0301";
    expect(safeFilenamePart(decomposed)).toBe("José");
    expect(safeFilenamePart(decomposed).normalize("NFC")).toBe(safeFilenamePart(decomposed));
  });

  it("quita los caracteres peligrosos \\ / : * ? \" < > |", () => {
    expect(safeFilenamePart('a\\b/c:d*e?f"g<h>i|j')).toBe("abcdefghij");
  });

  it("quita controles, saltos de linea y tabuladores (los convierte en espacio)", () => {
    expect(safeFilenamePart("Ana\u0000\nPérez\tLópez\u007f")).toBe("Ana Pérez López");
  });

  it("quita invisibles que falsean nombres (RLO, BOM, ancho cero)", () => {
    expect(safeFilenamePart("fdp.\u202Eexe\u200b\ufeff")).toBe("fdp.exe");
  });

  it("colapsa espacios y quita espacios y puntos de los extremos", () => {
    expect(safeFilenamePart("  ..  Ana    Pérez  .. ")).toBe("Ana Pérez");
    expect(safeFilenamePart("...")).toBe("");
    expect(safeFilenamePart("   ")).toBe("");
  });

  it("cadena vacia -> cadena vacia", () => {
    expect(safeFilenamePart("")).toBe("");
  });

  it("evita nombres reservados de Windows (sin distinguir mayusculas)", () => {
    for (const name of ["CON", "prn", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
      const safe = safeFilenamePart(name);
      expect(safe).toBe(`${name}_`);
    }
    expect(safeFilenamePart("con.algo")).toBe("con.algo_");
    // No son reservados: se dejan tal cual.
    expect(safeFilenamePart("COM10")).toBe("COM10");
    expect(safeFilenamePart("Conchita")).toBe("Conchita");
    expect(safeFilenamePart("COM0")).toBe("COM0");
  });

  it("conserva CJK y emoji, incluido un emoji compuesto con ZWJ", () => {
    expect(safeFilenamePart("王小明")).toBe("王小明");
    expect(safeFilenamePart("田中 太郎")).toBe("田中 太郎");
    expect(safeFilenamePart("Ana 🙂")).toBe("Ana 🙂");
    expect(safeFilenamePart("👩\u200d👩\u200d👧")).toBe("👩\u200d👩\u200d👧");
  });

  it("descarta sustitutos UTF-16 sueltos (no rompen TextEncoder)", () => {
    const lone = `Ana\ud83d`;
    expect(safeFilenamePart(lone)).toBe("Ana");
    expect(safeFilenamePart("\ude00Luis")).toBe("Luis");
  });
});

describe("joinSignerNames — src/lib/pdf/signOutputNames.ts", () => {
  it("1 nombre", () => {
    expect(joinSignerNames(["Ana"], "es")).toBe("Ana");
    expect(joinSignerNames(["Ana"], "en")).toBe("Ana");
  });

  it("2 nombres: «y» en es, «and» en en", () => {
    expect(joinSignerNames(["Ana", "Luis"], "es")).toBe("Ana y Luis");
    expect(joinSignerNames(["Ana", "Luis"], "en")).toBe("Ana and Luis");
  });

  it("mas de 2 (datos heredados): «Ana, Luis +1»", () => {
    expect(joinSignerNames(["Ana", "Luis", "Marta"], "es")).toBe("Ana, Luis +1");
    expect(joinSignerNames(["Ana", "Luis", "Marta", "Pablo", "Eva"], "en")).toBe(
      "Ana, Luis +3",
    );
  });

  it("sin nombres, o con nombres vacios o que quedan vacios al sanear -> cadena vacia", () => {
    expect(joinSignerNames([], "es")).toBe("");
    expect(joinSignerNames(["", "   ", "..."], "es")).toBe("");
    expect(joinSignerNames(["/:*?"], "es")).toBe("");
  });

  it("omite los vacios sin dejar huecos: ['', 'Ana', '  '] -> «Ana»", () => {
    expect(joinSignerNames(["", "Ana", "  "], "es")).toBe("Ana");
    expect(joinSignerNames(["Ana", "", "Luis"], "es")).toBe("Ana y Luis");
  });

  it("un nombre repetido (sin distinguir mayusculas) cuenta una sola vez", () => {
    expect(joinSignerNames(["Ana", "ANA"], "es")).toBe("Ana");
  });

  it("conserva acentos y mayusculas, y sanea cada nombre", () => {
    expect(joinSignerNames(["Ángela Núñez", "J/o:s*é"], "es")).toBe(
      "Ángela Núñez y José",
    );
  });

  it("CJK y emoji", () => {
    expect(joinSignerNames(["王小明", "Ana 🙂"], "es")).toBe("王小明 y Ana 🙂");
  });
});

describe("signedFilename — src/lib/pdf/signOutputNames.ts", () => {
  it("un firmante: «Ana - Contrato-firmado.pdf»", () => {
    expect(
      signedFilename({ signerNames: ["Ana"], documentName: "Contrato.pdf", lang: "es" }),
    ).toBe("Ana - Contrato-firmado.pdf");
  });

  it("dos firmantes (es y en)", () => {
    expect(
      signedFilename({
        signerNames: ["Ana", "Luis"],
        documentName: "Contrato.pdf",
        lang: "es",
      }),
    ).toBe("Ana y Luis - Contrato-firmado.pdf");
    expect(
      signedFilename({
        signerNames: ["Ana", "Luis"],
        documentName: "Contract.pdf",
        lang: "en",
      }),
    ).toBe("Ana and Luis - Contract-signed.pdf");
  });

  it("N firmantes heredados", () => {
    expect(
      signedFilename({
        signerNames: ["Ana", "Luis", "Marta"],
        documentName: "Acta.pdf",
        lang: "es",
      }),
    ).toBe("Ana, Luis +1 - Acta-firmado.pdf");
  });

  it("sin firmantes (lista vacia o solo nombres vacios): «Doc-firmado.pdf»", () => {
    expect(
      signedFilename({ signerNames: [], documentName: "Contrato.pdf", lang: "es" }),
    ).toBe("Contrato-firmado.pdf");
    expect(
      signedFilename({ signerNames: ["", "  "], documentName: "Contrato.pdf", lang: "en" }),
    ).toBe("Contrato-signed.pdf");
  });

  it("conserva acentos y mayusculas del documento y de los firmantes", () => {
    expect(
      signedFilename({
        signerNames: ["Ángela Núñez"],
        documentName: "Informe Anual ÑOÑO.PDF",
        lang: "es",
      }),
    ).toBe("Ángela Núñez - Informe Anual ÑOÑO-firmado.pdf");
  });

  it("documento sin extension .pdf: no corta un «.2» interno", () => {
    expect(
      signedFilename({ signerNames: [], documentName: "informe v1.2", lang: "es" }),
    ).toBe("informe v1.2-firmado.pdf");
    expect(
      signedFilename({ signerNames: [], documentName: "informe", lang: "es" }),
    ).toBe("informe-firmado.pdf");
  });

  it("documento vacio o solo peligroso -> «documento» / «document»", () => {
    expect(
      signedFilename({ signerNames: ["Ana"], documentName: "", lang: "es" }),
    ).toBe("Ana - documento-firmado.pdf");
    expect(
      signedFilename({ signerNames: ["Ana"], documentName: ".pdf", lang: "en" }),
    ).toBe("Ana - document-signed.pdf");
    expect(
      signedFilename({ signerNames: [], documentName: "///.pdf", lang: "en" }),
    ).toBe("document-signed.pdf");
  });

  it("caracteres peligrosos y de ruta fuera del resultado", () => {
    const name = signedFilename({
      signerNames: ['A/n\\a:*?"<>|'],
      documentName: "../../etc/passwd.pdf",
      lang: "es",
    });
    expect(name).toBe("Ana - etcpasswd-firmado.pdf");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("nombre de firmante reservado de Windows: no es el nombre completo, pero se sanea", () => {
    expect(
      signedFilename({ signerNames: ["CON"], documentName: "a.pdf", lang: "es" }),
    ).toBe("CON_ - a-firmado.pdf");
  });

  it("CJK y emoji pasan intactos", () => {
    expect(
      signedFilename({
        signerNames: ["王小明"],
        documentName: "合同🙂.pdf",
        lang: "es",
      }),
    ).toBe("王小明 - 合同🙂-firmado.pdf");
  });

  it("firmantes > 50 caracteres: recorte con elipsis (total 50)", () => {
    const long = "A".repeat(80);
    const name = signedFilename({
      signerNames: [long],
      documentName: "Doc.pdf",
      lang: "es",
    });
    const [signersPart] = name.split(" - ");
    expect(chars(signersPart)).toBe(50);
    expect(signersPart.endsWith("…")).toBe(true);
    expect(name.endsWith(" - Doc-firmado.pdf")).toBe(true);
  });

  it("documento > 80 caracteres: recorte a 80 con elipsis (sin firmantes cabe todo)", () => {
    const name = signedFilename({
      signerNames: [],
      documentName: `${"B".repeat(120)}.pdf`,
      lang: "es",
    });
    expect(name).toBe(`${"B".repeat(79)}…-firmado.pdf`);
  });

  it("entrada total <= 120 caracteres con firmantes y documento al maximo", () => {
    const name = signedFilename({
      signerNames: ["C".repeat(60), "D".repeat(60)],
      documentName: `${"E".repeat(200)}.pdf`,
      lang: "es",
    });
    expect(chars(name)).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(name.endsWith("-firmado.pdf")).toBe(true);
    expect(name.includes(" - ")).toBe(true);
  });

  it("limite de BYTES: CJK (3 bytes/caracter) se recorta aunque cumpla los caracteres", () => {
    const name = signedFilename({
      signerNames: ["王".repeat(30)],
      documentName: `${"合".repeat(70)}.pdf`,
      lang: "es",
    });
    expect(chars(name)).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(name.endsWith("-firmado.pdf")).toBe(true);
    // El recorte nunca deja un caracter partido.
    expect(name.includes("�")).toBe(false);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(name))).toBe(
      name,
    );
  });

  it("limite de bytes con emoji (4 bytes) no parte el par sustituto ni el ZWJ", () => {
    const family = "👩\u200d👩\u200d👧";
    const name = signedFilename({
      signerNames: [family.repeat(5)],
      documentName: `${family.repeat(12)}.pdf`,
      lang: "en",
    });
    expect(bytes(name)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(chars(name)).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    // Sin sustitutos sueltos.
    expect(name.isWellFormed()).toBe(true);
    expect(name.endsWith("-signed.pdf")).toBe(true);
  });

  it("sin firmantes y con documento enorme en bytes tambien respeta 200 bytes", () => {
    const name = signedFilename({
      signerNames: [],
      documentName: `${"é".repeat(300)}.pdf`,
      lang: "es",
    });
    expect(bytes(name)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(name.endsWith("-firmado.pdf")).toBe(true);
  });

  it("el nombre resultante es NFC", () => {
    const name = signedFilename({
      signerNames: ["Jose\u0301"],
      documentName: "Cafe\u0301.pdf",
      lang: "es",
    });
    expect(name).toBe(name.normalize("NFC"));
    expect(name).toBe("José - Café-firmado.pdf");
  });
});

describe("uniqueNames — src/lib/pdf/signOutputNames.ts", () => {
  it("sin colisiones deja los nombres como estan", () => {
    expect(uniqueNames(["a.pdf", "b.pdf"])).toEqual(["a.pdf", "b.pdf"]);
  });

  it("mismo documento y mismos firmantes: « (2)», « (3)» antes de la extension", () => {
    const same = "Ana - Contrato-firmado.pdf";
    expect(uniqueNames([same, same, same])).toEqual([
      "Ana - Contrato-firmado.pdf",
      "Ana - Contrato-firmado (2).pdf",
      "Ana - Contrato-firmado (3).pdf",
    ]);
  });

  it("compara sin distinguir mayusculas: «Ana» y «ANA» chocan", () => {
    expect(
      uniqueNames(["Ana - Doc-firmado.pdf", "ANA - DOC-FIRMADO.pdf"]),
    ).toEqual(["Ana - Doc-firmado.pdf", "ANA - DOC-FIRMADO (2).pdf"]);
  });

  it("compara en NFC: forma compuesta y descompuesta chocan", () => {
    const composed = "José-firmado.pdf";
    const decomposed = "Jose\u0301-firmado.pdf";
    const result = uniqueNames([composed, decomposed]);
    expect(result[0]).toBe(composed);
    expect(result[1]).toBe("Jose\u0301-firmado (2).pdf");
  });

  it("el candidato desambiguado tambien se comprueba (ya existe «(2)»)", () => {
    expect(uniqueNames(["a.pdf", "a (2).pdf", "a.pdf"])).toEqual([
      "a.pdf",
      "a (2).pdf",
      "a (3).pdf",
    ]);
  });

  it("lista vacia y nombres vacios", () => {
    expect(uniqueNames([])).toEqual([]);
    expect(uniqueNames(["", ""])).toEqual(["", " (2)"]);
  });

  it("conserva el orden", () => {
    expect(uniqueNames(["b.pdf", "a.pdf", "b.pdf"])).toEqual([
      "b.pdf",
      "a.pdf",
      "b (2).pdf",
    ]);
  });
});

describe("uniqueNames — el nombre FINAL con sufijo respeta los limites (120 caracteres / 200 bytes)", () => {
  const chars = (name: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)).length;
  const bytes = (name: string) => new TextEncoder().encode(name).length;
  const within = (name: string) => chars(name) <= MAX_ENTRY_CHARS && bytes(name) <= MAX_ENTRY_BYTES;

  it("un nombre ya en el tope de caracteres sigue dentro con ' (2)'", () => {
    const name = `${"a".repeat(MAX_ENTRY_CHARS - 4)}.pdf`;
    expect(chars(name)).toBe(MAX_ENTRY_CHARS);
    const [first, second] = uniqueNames([name, name]);
    expect(first).toBe(name);
    expect(second.endsWith(" (2).pdf")).toBe(true);
    expect(within(second)).toBe(true);
  });

  it("un nombre CJK en el tope de bytes (3 bytes por caracter) sigue dentro con sufijo", () => {
    const name = `${"文".repeat(65)}.pdf`; // 195 + 4 = 199 bytes
    expect(bytes(name)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    const out = uniqueNames([name, name, name]);
    for (const item of out) expect(within(item)).toBe(true);
    expect(new Set(out.map((item) => item.toLowerCase())).size).toBe(3);
    expect(out[1].endsWith(" (2).pdf")).toBe(true);
    expect(out[2].endsWith(" (3).pdf")).toBe(true);
  });

  it("el sufijo no se recorta nunca y el cuerpo no deja puntos ni espacios colgando", () => {
    const name = `${"x".repeat(115)}. .pdf`;
    const [, second] = uniqueNames([name, name]);
    expect(second.endsWith(" (2).pdf")).toBe(true);
    expect(second.replace(" (2).pdf", "")).not.toMatch(/[.\s]$/);
  });

  it("propiedad: con nombres generados al azar (ASCII, acentos, CJK, emoji) todos son unicos y dentro de limites", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const alphabets = ["abcdef", "áéíóúñ", "文字漢語", "😀🎉✍️", "Ab cD-"];
    for (let round = 0; round < 60; round += 1) {
      const alphabet = Array.from(alphabets[Math.floor(rand() * alphabets.length)]);
      const make = () => {
        let body = "";
        const target = 1 + Math.floor(rand() * 200);
        while (body.length < target) body += alphabet[Math.floor(rand() * alphabet.length)];
        return signedFilename({ signerNames: ["Ana"], documentName: `${body}.pdf`, lang: "es" });
      };
      const pool = Array.from({ length: 3 }, make);
      const names = Array.from({ length: 8 }, () => pool[Math.floor(rand() * pool.length)]);
      const out = uniqueNames(names);
      expect(out).toHaveLength(names.length);
      for (const item of out) expect(within(item)).toBe(true);
      expect(new Set(out.map((item) => item.normalize("NFC").toLowerCase())).size).toBe(out.length);
    }
  });
});

describe("zipFilename — src/lib/pdf/signOutputNames.ts", () => {
  it("es / en con plural", () => {
    expect(zipFilename(3, "es")).toBe("Firmados - 3 documentos.zip");
    expect(zipFilename(3, "en")).toBe("Signed - 3 documents.zip");
    expect(zipFilename(10, "es")).toBe("Firmados - 10 documentos.zip");
  });

  it("1 usa singular (aunque en la practica un documento no va en ZIP)", () => {
    expect(zipFilename(1, "es")).toBe("Firmados - 1 documento.zip");
    expect(zipFilename(1, "en")).toBe("Signed - 1 document.zip");
  });
});
