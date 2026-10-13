import { PDFArray, PDFDict, PDFName, PDFNumber, StandardFontEmbedder, type PDFContext } from "@cantoo/pdf-lib";

/**
 * Wave 8 · F2 · ronda 3: codificaciones de las fuentes SIMPLES (un byte por
 * codigo) para el intérprete de `editTextRemove.ts`.
 *
 * Hacen dos cosas, las dos solo para CASAR glifos con el texto del bloque (el
 * intérprete nunca decide por si solo que un glifo se borra):
 *  - codigo -> texto Unicode cuando la fuente NO trae `ToUnicode` (estimacion
 *    `exact: false`): WinAnsi (cp1252 real, con `…`, `™`, `€`, comillas
 *    tipograficas en 0x80–0x9F), MacRoman, StandardEncoding y `/Differences`;
 *  - codigo -> nombre de glifo, para leer el ancho AFM de las 14 fuentes
 *    estandar que no declaran `/Widths`.
 *
 * Los nombres de glifo y la tabla WinAnsi salen de la propia tabla de pdf-lib
 * (`StandardFontEmbedder.encoding`), la misma con la que se dibuja el texto
 * de las fuentes estandar: lo que escribe la app y lo que se lee aqui coinciden.
 */

export type SimpleEncoding = {
  /** Nombre de glifo del codigo (para el ancho AFM), o null si no se conoce. */
  nameOf: (code: number) => string | null;
  /** Texto Unicode del codigo, o null si no se puede determinar. */
  textOf: (code: number) => string | null;
};

/* ------------------------------------------------------------------ *
 * WinAnsi a partir de la tabla de pdf-lib
 * ------------------------------------------------------------------ */

type WinAnsiTables = {
  names: Array<string | undefined>;
  points: Array<number | undefined>;
  nameToPoint: Map<string, number>;
  pointToName: Map<number, string>;
};

let winAnsiTables: WinAnsiTables | null = null;

function winAnsi(): WinAnsiTables {
  if (winAnsiTables) return winAnsiTables;
  const embedder = StandardFontEmbedder.for("Helvetica" as never);
  const names: Array<string | undefined> = new Array(256).fill(undefined);
  const points: Array<number | undefined> = new Array(256).fill(undefined);
  const nameToPoint = new Map<string, number>();
  const pointToName = new Map<number, string>();
  for (const point of embedder.encoding.supportedCodePoints) {
    const { code, name } = embedder.encoding.encodeUnicodeCodePoint(point);
    if (code < 0 || code > 255) continue;
    if (points[code] === undefined) {
      points[code] = point;
      names[code] = name;
    }
    if (!nameToPoint.has(name)) nameToPoint.set(name, point);
    if (!pointToName.has(point)) pointToName.set(point, name);
  }
  // PDF 32000, Anexo D: en WinAnsiEncoding el 0xAD es un guion (como el 0x2D)...
  points[0xad] = 0x2d;
  names[0xad] = "hyphen";
  // ...y los codigos sin uso de WinAnsi (0x7F, 0x81, 0x8D, 0x8F, 0x90, 0x9D) se dibujan como vineta.
  for (const code of [0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
    if (points[code] === undefined) {
      points[code] = 0x2022;
      names[code] = "bullet";
    }
  }
  winAnsiTables = { names, points, nameToPoint, pointToName };
  return winAnsiTables;
}

const WINANSI: SimpleEncoding = {
  nameOf: (code) => winAnsi().names[code] ?? null,
  textOf: (code) => {
    const point = winAnsi().points[code];
    return point === undefined ? null : String.fromCodePoint(point);
  },
};

/* ------------------------------------------------------------------ *
 * MacRoman (PDF 32000 Anexo D: 0xDB es `currency`, 0xCA un espacio)
 * ------------------------------------------------------------------ */

/** Puntos de codigo de los codigos 0x80..0xFF de MacRomanEncoding (0 = sin glifo estandar). */
const MAC_ROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7,
  0x00e9, 0x00e8, 0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3, 0x00f2, 0x00f4, 0x00f6, 0x00f5,
  0x00fa, 0x00f9, 0x00fb, 0x00fc, 0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9,
  0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8, 0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211,
  0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8, 0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248,
  0x2206, 0x00ab, 0x00bb, 0x2026, 0x0020, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153, 0x2013, 0x2014, 0x201c, 0x201d,
  0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x00a4, 0x2039, 0x203a, 0xfb01, 0xfb02, 0x2021, 0x00b7,
  0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0x0000, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd,
  0x02db, 0x02c7,
];

function macRomanPoint(code: number): number | null {
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0x80 && code <= 0xff) {
    const point = MAC_ROMAN_HIGH[code - 0x80];
    return point ? point : null;
  }
  return null;
}

const MAC_ROMAN: SimpleEncoding = {
  nameOf: (code) => {
    const point = macRomanPoint(code);
    // Solo los glifos que tambien tiene WinAnsi tienen nombre conocido (para el ancho AFM).
    return point === null ? null : (winAnsi().pointToName.get(point) ?? null);
  },
  textOf: (code) => {
    const point = macRomanPoint(code);
    return point === null ? null : String.fromCodePoint(point);
  },
};

/* ------------------------------------------------------------------ *
 * StandardEncoding (Adobe): ASCII salvo comillas, mas su mitad alta
 * ------------------------------------------------------------------ */

const STANDARD_HIGH: Record<number, string> = {
  161: "exclamdown", 162: "cent", 163: "sterling", 164: "fraction", 165: "yen", 166: "florin", 167: "section",
  168: "currency", 169: "quotesingle", 170: "quotedblleft", 171: "guillemotleft", 172: "guilsinglleft",
  173: "guilsinglright", 174: "fi", 175: "fl", 177: "endash", 178: "dagger", 179: "daggerdbl", 180: "periodcentered",
  182: "paragraph", 183: "bullet", 184: "quotesinglbase", 185: "quotedblbase", 186: "quotedblright",
  187: "guillemotright", 188: "ellipsis", 189: "perthousand", 191: "questiondown", 193: "grave", 194: "acute",
  195: "circumflex", 196: "tilde", 197: "macron", 198: "breve", 199: "dotaccent", 200: "dieresis", 202: "ring",
  203: "cedilla", 205: "hungarumlaut", 206: "ogonek", 207: "caron", 208: "emdash", 225: "AE", 227: "ordfeminine",
  232: "Lslash", 233: "Oslash", 234: "OE", 235: "ordmasculine", 241: "ae", 245: "dotlessi", 248: "lslash",
  249: "oslash", 250: "oe", 251: "germandbls",
};

function standardName(code: number): string | null {
  if (code === 0x27) return "quoteright";
  if (code === 0x60) return "quoteleft";
  if (code >= 0x20 && code <= 0x7e) return winAnsi().names[code] ?? null;
  return STANDARD_HIGH[code] ?? null;
}

const STANDARD: SimpleEncoding = {
  nameOf: standardName,
  textOf: (code) => {
    const name = standardName(code);
    return name === null ? null : glyphNameText(name);
  },
};

/* ------------------------------------------------------------------ *
 * Nombres de glifo -> Unicode
 * ------------------------------------------------------------------ */

/** Nombres que no estan en WinAnsi pero si en StandardEncoding o en TeX. */
const EXTRA_GLYPHS: Record<string, number> = {
  ff: 0xfb00, fi: 0xfb01, fl: 0xfb02, ffi: 0xfb03, ffl: 0xfb04, dotlessi: 0x0131, fraction: 0x2044, Lslash: 0x0141,
  lslash: 0x0142, minus: 0x2212, acute: 0x00b4, macron: 0x00af, breve: 0x02d8, dotaccent: 0x02d9, dieresis: 0x00a8,
  ring: 0x02da, cedilla: 0x00b8, hungarumlaut: 0x02dd, ogonek: 0x02db, caron: 0x02c7, circumflex: 0x02c6,
  tilde: 0x02dc, nbspace: 0x00a0, nonbreakingspace: 0x00a0,
};

function codePointText(hex: string): string | null {
  const point = parseInt(hex, 16);
  if (!Number.isFinite(point) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
  return String.fromCodePoint(point);
}

/** Texto Unicode de un nombre de glifo (lista de Adobe en su parte latina, `uniXXXX`, `uXXXX`, `f_i`, `a.alt`), o null. */
export function glyphNameText(name: string): string | null {
  const base = name.split(".")[0];
  if (!base) return null;
  const direct = winAnsi().nameToPoint.get(base) ?? EXTRA_GLYPHS[base];
  if (direct !== undefined) return String.fromCodePoint(direct);
  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (uni) {
    let text = "";
    for (let i = 0; i < uni[1].length; i += 4) {
      const piece = codePointText(uni[1].slice(i, i + 4));
      if (piece === null) return null;
      text += piece;
    }
    return text;
  }
  const u = /^u([0-9A-F]{4,6})$/.exec(base);
  if (u) return codePointText(u[1]);
  if (base.includes("_")) {
    let text = "";
    for (const part of base.split("_")) {
      const piece = part ? glyphNameText(part) : null;
      if (piece === null) return null;
      text += piece;
    }
    return text;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Codificacion de una fuente simple
 * ------------------------------------------------------------------ */

function namedBase(name: string): SimpleEncoding | null {
  if (name === "WinAnsiEncoding") return WINANSI;
  if (name === "MacRomanEncoding") return MAC_ROMAN;
  if (name === "StandardEncoding") return STANDARD;
  return null;
}

function parseDifferences(context: PDFContext, raw: unknown): Map<number, string> {
  const map = new Map<number, string>();
  if (!(raw instanceof PDFArray)) return map;
  let code = 0;
  for (const entry of raw.asArray()) {
    const value = context.lookup(entry);
    if (value instanceof PDFNumber) code = value.asNumber();
    else if (value instanceof PDFName) {
      if (code >= 0 && code <= 255) map.set(code, value.decodeText());
      code += 1;
    }
  }
  return map;
}

/**
 * Codificacion declarada por una fuente simple (`/Encoding`: nombre o diccionario
 * con `/BaseEncoding` y `/Differences`), o null si no se puede conocer (sin
 * `/Encoding` en una fuente incrustada o simbolica, MacExpert, ...). Una
 * fuente no simbolica sin `/BaseEncoding` parte de StandardEncoding.
 */
export function simpleEncodingFor(
  context: PDFContext,
  dict: PDFDict,
  nonSymbolic: boolean,
): SimpleEncoding | null {
  const raw = dict.lookup(PDFName.of("Encoding"));
  let base: SimpleEncoding | null = null;
  let differences = new Map<number, string>();
  if (raw instanceof PDFName) {
    base = namedBase(raw.decodeText());
    if (!base) return null;
  } else if (raw instanceof PDFDict) {
    const declared = raw.lookup(PDFName.of("BaseEncoding"));
    if (declared instanceof PDFName) {
      base = namedBase(declared.decodeText());
      if (!base) return null;
    } else base = nonSymbolic ? STANDARD : null;
    differences = parseDifferences(context, raw.lookup(PDFName.of("Differences")));
  } else if (raw === undefined) {
    base = nonSymbolic ? STANDARD : null;
  } else return null;
  if (!base && differences.size === 0) return null;
  return {
    nameOf: (code) => differences.get(code) ?? base?.nameOf(code) ?? null,
    textOf: (code) => {
      const name = differences.get(code);
      return name !== undefined ? glyphNameText(name) : (base?.textOf(code) ?? null);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Anchos AFM de las fuentes base 14
 * ------------------------------------------------------------------ */

const embedders = new Map<string, StandardFontEmbedder>();

/** Ancho (milesimas de em) del glifo `glyphName` en la fuente base 14 `fontName`; 0 si no lo tiene. */
export function standardGlyphWidth(fontName: string, glyphName: string): number {
  let embedder = embedders.get(fontName);
  if (!embedder) {
    embedder = StandardFontEmbedder.for(fontName as never);
    embedders.set(fontName, embedder);
  }
  try {
    const width = embedder.font.getWidthOfGlyph(glyphName);
    return typeof width === "number" && Number.isFinite(width) ? width : 0;
  } catch {
    return 0;
  }
}
