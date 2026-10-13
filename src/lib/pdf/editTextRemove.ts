import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFContentStream,
  StandardFontEmbedder,
  decodePDFRawStream,
  type PDFContext,
  type PDFDocument,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { TextEdit, UserBox } from "@/lib/pdf/editTypes";
import { countNonBlank, type GlyphProfile } from "@/lib/pdf/editTextProfile";

/**
 * Wave 8 · F2: eliminar DE VERDAD el texto original que reemplaza una edicion.
 *
 * "Cubrir y redibujar" (F1) deja el texto viejo en el flujo de contenido: se
 * puede seleccionar, buscar y extraer. Este modulo recorre el flujo de la
 * pagina (y los Form XObjects que pinta) con un interprete propio: tokeniza
 * los operadores, lleva la CTM (`q`/`Q`/`cm`/`Do`), el estado de texto
 * (`BT`/`Tm`/`Td`/`TD`/`T*`/`TL`/`Tc`/`Tw`/`Tz`/`Ts`/`Tr`/`Tf`) y los anchos
 * reales de cada fuente, y asi sabe en que punto del espacio de usuario
 * empieza y acaba CADA glifo de `Tj`, `TJ`, `'` y `"`.
 *
 * Un glifo pertenece al bloque editado si empieza y termina dentro de su
 * caja de cobertura (`coverOriented` o `coverBox`) y no cae en la caja de un
 * vecino (`obstacles`). Los glifos del bloque se quitan del operador y su
 * avance se conserva como ajuste numerico de `TJ`: el resto de la linea (si
 * el bloque es una linea parcial) no se desplaza. Todo lo demas del flujo se
 * copia byte a byte (solo se empalman los rangos de los operadores tocados).
 *
 * FLUJO COMPARTIDO (copy-on-write): si el flujo `/Contents` de la pagina (o el
 * array que lo agrupa) lo usa tambien otra pagina u otro objeto (p. ej. una
 * pagina duplicada que comparte el flujo), NO se reescribe en su sitio: se crea
 * un flujo nuevo con el texto quitado y solo el `/Contents` de ESTA pagina
 * apunta a el. El original queda intacto para las demas.
 *
 * REGLA: ante la duda no se borra. Se deja el texto (y el aviso
 * `original-text-remains` con su `reason`) cuando:
 *  - la fuente es Type3, vertical, con CMap no Identity o sin anchos
 *    conocidos (no se puede situar cada glifo con fiabilidad);
 *  - el texto esta en modo invisible (3) o de recorte (4-7);
 *  - el texto vive en un Form XObject compartido con otras paginas, con otros
 *    XObjects/anotaciones o pintado mas de una vez (se cuentan TODAS las
 *    pintadas antes de decidir): reescribirlo borraria tambien las otras copias;
 *  - los glifos quitados no cuadran con el texto original del bloque
 *    (`TextEdit.originalGlyphs`): faltan o sobran, asi que no se quita nada;
 *  - el flujo no se pudo leer o no se encontro ningun glifo en la caja;
 *  - un glifo cae a la vez en la caja del bloque y en la de un vecino.
 */

/* ------------------------------------------------------------------ *
 * Tipos publicos
 * ------------------------------------------------------------------ */

export type RemoveFailReason =
  | "type3"
  | "vertical"
  | "encoding"
  | "widths"
  | "invisible"
  | "clip"
  | "shared-xobject"
  | "unreadable"
  | "not-found"
  | "ambiguous";

export type RemoveOutcome = {
  editId: string;
  /** Todos los glifos del bloque encontrados se quitaron del flujo. */
  removed: boolean;
  /** Glifos quitados. */
  glyphs: number;
  /** Por que NO se quito (solo si `removed` es false). */
  reason?: RemoveFailReason;
};

/* ------------------------------------------------------------------ *
 * Tokenizador del flujo de contenido (con offsets de byte)
 * ------------------------------------------------------------------ */

type Token =
  | { kind: "num"; value: number; start: number; end: number }
  | { kind: "name"; value: string; start: number; end: number }
  | { kind: "str"; bytes: Uint8Array; start: number; end: number }
  | { kind: "array"; items: Token[]; start: number; end: number }
  | { kind: "dict"; start: number; end: number }
  | { kind: "op"; value: string; start: number; end: number };

const isWhite = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
const isDelim = (b: number) =>
  b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d || b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25;
const isRegular = (b: number) => !isWhite(b) && !isDelim(b);

class ContentTokenizer {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private skipSpace(): void {
    const b = this.bytes;
    while (this.pos < b.length) {
      if (isWhite(b[this.pos])) this.pos += 1;
      else if (b[this.pos] === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos += 1;
      } else break;
    }
  }

  next(): Token | null {
    this.skipSpace();
    const b = this.bytes;
    if (this.pos >= b.length) return null;
    const start = this.pos;
    const c = b[this.pos];
    if (c === 0x5b) {
      this.pos += 1;
      const items: Token[] = [];
      for (;;) {
        this.skipSpace();
        if (this.pos >= b.length) break;
        if (b[this.pos] === 0x5d) {
          this.pos += 1;
          break;
        }
        const t = this.next();
        if (!t) break;
        items.push(t);
      }
      return { kind: "array", items, start, end: this.pos };
    }
    if (c === 0x5d) {
      this.pos += 1;
      return { kind: "op", value: "]", start, end: this.pos };
    }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        let depth = 1;
        while (this.pos < b.length && depth > 0) {
          const t = this.next();
          if (!t) break;
          if (t.kind === "op" && t.value === ">>") depth -= 1;
          else if (t.kind === "dict") {
            // anidado ya consumido
          }
        }
        return { kind: "dict", start, end: this.pos };
      }
      this.pos += 1;
      const out: number[] = [];
      let hi = -1;
      while (this.pos < b.length && b[this.pos] !== 0x3e) {
        const d = b[this.pos];
        this.pos += 1;
        let v = -1;
        if (d >= 0x30 && d <= 0x39) v = d - 0x30;
        else if (d >= 0x41 && d <= 0x46) v = d - 0x41 + 10;
        else if (d >= 0x61 && d <= 0x66) v = d - 0x61 + 10;
        else continue;
        if (hi < 0) hi = v;
        else {
          out.push(hi * 16 + v);
          hi = -1;
        }
      }
      if (hi >= 0) out.push(hi * 16);
      this.pos += 1;
      return { kind: "str", bytes: Uint8Array.from(out), start, end: this.pos };
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { kind: "op", value: ">>", start, end: this.pos };
      }
      this.pos += 1;
      return { kind: "op", value: ">", start, end: this.pos };
    }
    if (c === 0x28) {
      this.pos += 1;
      const out: number[] = [];
      let depth = 1;
      while (this.pos < b.length) {
        const d = b[this.pos];
        this.pos += 1;
        if (d === 0x5c) {
          const e = b[this.pos];
          this.pos += 1;
          if (e === 0x6e) out.push(10);
          else if (e === 0x72) out.push(13);
          else if (e === 0x74) out.push(9);
          else if (e === 0x62) out.push(8);
          else if (e === 0x66) out.push(12);
          else if (e === 0x0a) {
            // continuacion de linea
          } else if (e === 0x0d) {
            if (b[this.pos] === 0x0a) this.pos += 1;
          } else if (e >= 0x30 && e <= 0x37) {
            let v = e - 0x30;
            for (let k = 0; k < 2; k += 1) {
              const f = b[this.pos];
              if (f >= 0x30 && f <= 0x37) {
                v = v * 8 + (f - 0x30);
                this.pos += 1;
              } else break;
            }
            out.push(v & 0xff);
          } else if (e !== undefined) out.push(e);
          continue;
        }
        if (d === 0x28) depth += 1;
        else if (d === 0x29) {
          depth -= 1;
          if (depth === 0) break;
        }
        out.push(d);
      }
      return { kind: "str", bytes: Uint8Array.from(out), start, end: this.pos };
    }
    if (c === 0x2f) {
      this.pos += 1;
      let s = "";
      while (this.pos < b.length && isRegular(b[this.pos])) {
        let ch = b[this.pos];
        this.pos += 1;
        if (ch === 0x23) {
          const h = parseInt(String.fromCharCode(b[this.pos], b[this.pos + 1]), 16);
          if (Number.isFinite(h)) {
            ch = h;
            this.pos += 2;
          }
        }
        s += String.fromCharCode(ch);
      }
      return { kind: "name", value: s, start, end: this.pos };
    }
    if (c === 0x29 || c === 0x7b || c === 0x7d) {
      this.pos += 1;
      return { kind: "op", value: String.fromCharCode(c), start, end: this.pos };
    }
    // numero u operador
    let s = "";
    while (this.pos < b.length && isRegular(b[this.pos])) {
      s += String.fromCharCode(b[this.pos]);
      this.pos += 1;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) {
      return { kind: "num", value: parseFloat(s), start, end: this.pos };
    }
    if (s === "BI") {
      // Imagen en linea: saltar hasta `ID`, un espacio y los datos hasta `EI`.
      for (;;) {
        const t = this.next();
        if (!t) break;
        if (t.kind === "op" && t.value === "ID") break;
      }
      this.pos += 1;
      while (this.pos < b.length) {
        if (
          b[this.pos] === 0x45 &&
          b[this.pos + 1] === 0x49 &&
          (this.pos + 2 >= b.length || isWhite(b[this.pos + 2]) || isDelim(b[this.pos + 2])) &&
          isWhite(b[this.pos - 1])
        ) {
          this.pos += 2;
          break;
        }
        this.pos += 1;
      }
      return { kind: "op", value: "BI", start, end: this.pos };
    }
    return { kind: "op", value: s, start, end: this.pos };
  }
}

/* ------------------------------------------------------------------ *
 * Fuentes: bytes por codigo y anchos
 * ------------------------------------------------------------------ */

type FontModel = {
  bytesPerCode: 1 | 2;
  /** Ancho del glifo en milesimas de espacio de texto. */
  widthOf: (code: number) => number;
  unsafe?: RemoveFailReason;
  /**
   * Texto Unicode de un codigo segun el `ToUnicode` de la fuente (`exact`), o
   * una estimacion de un caracter por codigo cuando no lo hay. null = se
   * ignora (ni siquiera se sabe si es un espacio).
   */
  unicodeOf?: (code: number) => { text: string; exact: boolean } | null;
};

const STANDARD_NAMES = new Set([
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Symbol",
  "ZapfDingbats",
]);

/** Nombre de fuente base 14 equivalente a `baseFont`, o null. */
export function standardFontNameFor(baseFont: string): string | null {
  const name = baseFont.replace(/^[A-Z]{6}\+/, "");
  if (STANDARD_NAMES.has(name)) return name;
  const lower = name.toLowerCase();
  const bold = /bold|black|heavy|semibold/.test(lower);
  const italic = /italic|oblique/.test(lower);
  if (/arial|helvetica/.test(lower)) {
    return bold && italic ? "Helvetica-BoldOblique" : bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica";
  }
  if (/times/.test(lower)) {
    return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  }
  if (/courier|mono/.test(lower)) {
    return bold && italic ? "Courier-BoldOblique" : bold ? "Courier-Bold" : italic ? "Courier-Oblique" : "Courier";
  }
  if (lower === "symbol") return "Symbol";
  if (/zapf|dingbat/.test(lower)) return "ZapfDingbats";
  return null;
}

const embedders = new Map<string, StandardFontEmbedder>();
function standardWidth(name: string, code: number): number {
  let embedder = embedders.get(name);
  if (!embedder) {
    embedder = StandardFontEmbedder.for(name as never);
    embedders.set(name, embedder);
  }
  try {
    return embedder.widthOfTextAtSize(String.fromCharCode(code), 1000);
  } catch {
    return 0;
  }
}

function num(value: unknown, fallback: number): number {
  return value instanceof PDFNumber ? value.asNumber() : fallback;
}

function parseCidWidths(context: PDFContext, w: PDFArray | undefined): Map<number, number> {
  const widths = new Map<number, number>();
  if (!w) return widths;
  const items = w.asArray().map((item) => context.lookup(item));
  let i = 0;
  while (i < items.length) {
    const first = items[i];
    if (!(first instanceof PDFNumber)) break;
    const second = items[i + 1];
    if (second instanceof PDFArray) {
      const list = second.asArray().map((v) => num(context.lookup(v), 0));
      list.forEach((width, k) => widths.set(first.asNumber() + k, width));
      i += 2;
    } else if (second instanceof PDFNumber) {
      const third = items[i + 2];
      const width = num(third, 0);
      const from = first.asNumber();
      const to = second.asNumber();
      if (to - from > 65535 || to < from) break;
      for (let c = from; c <= to; c += 1) widths.set(c, width);
      i += 3;
    } else break;
  }
  return widths;
}

function utf16Hex(hex: string): string {
  if (hex.length <= 2) return String.fromCharCode(parseInt(hex || "0", 16));
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/** Lee un CMap `ToUnicode` (bfchar/bfrange) como codigo -> texto. */
export function parseToUnicode(source: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1], 16), utf16Hex(m[2]));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi < lo || hi - lo > 65535) continue;
      if (m[4] !== undefined) {
        const list = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16Hex(x[1]));
        list.forEach((text, k) => {
          if (lo + k <= hi) map.set(lo + k, text);
        });
      } else {
        const base = utf16Hex(m[3] ?? "");
        for (let code = lo; code <= hi; code += 1) {
          if (base.length === 0) continue;
          map.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (code - lo)));
        }
      }
    }
  }
  return map;
}

function toUnicodeOf(dict: PDFDict, bytesPerCode: 1 | 2): FontModel["unicodeOf"] {
  let map: Map<number, string> | null = null;
  try {
    const stream = dict.lookup(PDFName.of("ToUnicode"));
    if (stream instanceof PDFStream) {
      const bytes = decodeStream(stream);
      if (bytes) {
        let text = "";
        for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
        map = parseToUnicode(text);
        if (map.size === 0) map = null;
      }
    }
  } catch {
    map = null;
  }
  if (map) {
    const table = map;
    return (code) => {
      const text = table.get(code);
      return text === undefined ? null : { text, exact: true };
    };
  }
  if (bytesPerCode === 1) {
    return (code) => ({ text: code === 32 || code === 160 ? " " : String.fromCharCode(code), exact: false });
  }
  return () => null;
}

function fontModel(context: PDFContext, dict: PDFDict): FontModel {
  const subtype = dict.lookup(PDFName.of("Subtype"));
  const subtypeName = subtype instanceof PDFName ? subtype.decodeText() : "";
  const unsafe = (reason: RemoveFailReason): FontModel => ({ bytesPerCode: 1, widthOf: () => 0, unsafe: reason });
  if (subtypeName === "Type3") return unsafe("type3");
  if (subtypeName === "Type0") {
    const encoding = dict.lookup(PDFName.of("Encoding"));
    const encodingName = encoding instanceof PDFName ? encoding.decodeText() : "";
    if (encodingName === "Identity-V") return unsafe("vertical");
    if (encodingName !== "Identity-H") return unsafe("encoding");
    const descendants = dict.lookup(PDFName.of("DescendantFonts"));
    const first = descendants instanceof PDFArray ? descendants.lookup(0) : null;
    if (!(first instanceof PDFDict)) return unsafe("widths");
    const dw = num(first.lookup(PDFName.of("DW")), 1000);
    const w = first.lookup(PDFName.of("W"));
    const widths = parseCidWidths(context, w instanceof PDFArray ? w : undefined);
    return { bytesPerCode: 2, widthOf: (code) => widths.get(code) ?? dw, unicodeOf: toUnicodeOf(dict, 2) };
  }
  // Fuente simple: Type1, TrueType, MMType1.
  const widthsArray = dict.lookup(PDFName.of("Widths"));
  const firstChar = num(dict.lookup(PDFName.of("FirstChar")), 0);
  const descriptor = dict.lookup(PDFName.of("FontDescriptor"));
  const missing = descriptor instanceof PDFDict ? num(descriptor.lookup(PDFName.of("MissingWidth")), 0) : 0;
  if (widthsArray instanceof PDFArray && widthsArray.size() > 0) {
    const widths = widthsArray.asArray().map((v) => context.lookup(v));
    return {
      bytesPerCode: 1,
      widthOf: (code) => {
        const entry = widths[code - firstChar];
        return entry instanceof PDFNumber ? entry.asNumber() : missing;
      },
      unicodeOf: toUnicodeOf(dict, 1),
    };
  }
  const baseFont = dict.lookup(PDFName.of("BaseFont"));
  const standard = baseFont instanceof PDFName ? standardFontNameFor(baseFont.decodeText()) : null;
  if (!standard) return unsafe("widths");
  return { bytesPerCode: 1, widthOf: (code) => standardWidth(standard, code), unicodeOf: toUnicodeOf(dict, 1) };
}

/* ------------------------------------------------------------------ *
 * Interprete
 * ------------------------------------------------------------------ */

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

type GState = {
  ctm: Matrix;
  font: FontModel | null;
  fontUnsafe: RemoveFailReason | null;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  rise: number;
  leading: number;
  renderMode: number;
};

type Glyph = {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Tamano de fuente en espacio de usuario. */
  size: number;
  /** Avance en espacio de texto (ya con Tz). */
  tx: number;
};

type StrItem = { kind: "str"; bytes: Uint8Array; glyphs: Glyph[]; codes: number[]; bytesPerCode: 1 | 2; font: FontModel | null };
type NumItem = { kind: "num"; value: number; raw: string };

type ShowOp = {
  slot: StreamSlot;
  op: "Tj" | "TJ" | "'" | '"';
  start: number;
  end: number;
  items: Array<StrItem | NumItem>;
  /** Operandos `aw ac` de `"` tal cual estaban escritos. */
  quoteArgs: string[];
  fontSize: number;
  hScale: number;
  unsafe: RemoveFailReason | null;
  /**
   * Otro `Tj`/`TJ` sigue en el mismo objeto de texto sin reposicionar (`Td`,
   * `Tm`, `T*`...): si este operador se vacia, su avance hay que conservarlo
   * como ajuste numerico para que el resto de la linea no se mueva.
   */
  needsAdvance: boolean;
};

type StreamSlot = {
  ref: PDFRef | null;
  stream: PDFStream;
  bytes: Uint8Array;
  /** XObject que contiene el flujo (null = contenido de la pagina). */
  xobject: PDFRef | null;
  splices: Array<{ start: number; end: number; text: string }>;
};

type Walk = {
  context: PDFContext;
  slots: StreamSlot[];
  shows: ShowOp[];
  paints: Map<string, number>;
  state: GState;
  stack: GState[];
  tm: Matrix;
  lm: Matrix;
  fontCache: Map<PDFDict, FontModel>;
  depth: number;
  visiting: Set<string>;
  /** Ultimo operador de texto cuyo avance aun podria importar. */
  lastShow: ShowOp | null;
};

function decodeStream(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
    return stream.getContents();
  } catch {
    return null;
  }
}

function tokenText(bytes: Uint8Array, t: Token): string {
  let s = "";
  for (let i = t.start; i < t.end; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

function resolveFont(walk: Walk, resources: PDFDict | null, name: string): FontModel | null {
  if (!resources) return null;
  const fonts = resources.lookup(PDFName.of("Font"));
  if (!(fonts instanceof PDFDict)) return null;
  const dict = fonts.lookup(PDFName.of(name));
  if (!(dict instanceof PDFDict)) return null;
  let model = walk.fontCache.get(dict);
  if (!model) {
    try {
      model = fontModel(walk.context, dict);
    } catch {
      model = { bytesPerCode: 1, widthOf: () => 0, unsafe: "widths" };
    }
    walk.fontCache.set(dict, model);
  }
  return model;
}

function codesOf(bytes: Uint8Array, bytesPerCode: 1 | 2): number[] {
  const codes: number[] = [];
  if (bytesPerCode === 1) {
    for (let i = 0; i < bytes.length; i += 1) codes.push(bytes[i]);
  } else {
    for (let i = 0; i + 1 < bytes.length; i += 2) codes.push(bytes[i] * 256 + bytes[i + 1]);
    if (bytes.length % 2 === 1) codes.push(bytes[bytes.length - 1] * 256);
  }
  return codes;
}

function showString(walk: Walk, bytes: Uint8Array): StrItem {
  const { state } = walk;
  const font = state.font;
  const bytesPerCode = font?.bytesPerCode ?? 1;
  const codes = codesOf(bytes, bytesPerCode);
  const glyphs: Glyph[] = [];
  for (const code of codes) {
    const m = multiply(walk.tm, state.ctm);
    const start = apply(m, 0, state.rise);
    const w0 = font ? font.widthOf(code) / 1000 : 0;
    const word = bytesPerCode === 1 && code === 32 ? state.wordSpacing : 0;
    const tx = (w0 * state.size + state.charSpacing + word) * state.hScale;
    walk.tm = multiply([1, 0, 0, 1, tx, 0], walk.tm);
    const end = apply(multiply(walk.tm, state.ctm), 0, state.rise);
    glyphs.push({ start, end, size: state.size * Math.hypot(m[2], m[3]), tx });
  }
  return { kind: "str", bytes, glyphs, codes, bytesPerCode, font };
}

function showAdjust(walk: Walk, value: number): void {
  const { state } = walk;
  const tx = (-value / 1000) * state.size * state.hScale;
  walk.tm = multiply([1, 0, 0, 1, tx, 0], walk.tm);
}

function nextLine(walk: Walk): void {
  walk.lm = multiply([1, 0, 0, 1, 0, -walk.state.leading], walk.lm);
  walk.tm = walk.lm;
}

function walkStream(walk: Walk, slot: StreamSlot, resources: PDFDict | null): void {
  const tokenizer = new ContentTokenizer(slot.bytes);
  let operands: Token[] = [];
  for (;;) {
    const token = tokenizer.next();
    if (!token) break;
    if (token.kind !== "op") {
      operands.push(token);
      if (operands.length > 64) operands = operands.slice(-64);
      continue;
    }
    const args = operands;
    operands = [];
    const n = (i: number) => {
      const t = args[i];
      return t && t.kind === "num" ? t.value : 0;
    };
    const { state } = walk;
    switch (token.value) {
      case "q":
        walk.stack.push({ ...state });
        if (walk.stack.length > 256) walk.stack.shift();
        break;
      case "Q": {
        const previous = walk.stack.pop();
        if (previous) walk.state = previous;
        break;
      }
      case "cm":
        if (args.length >= 6) {
          const m = [n(0), n(1), n(2), n(3), n(4), n(5)] as Matrix;
          walk.state = { ...state, ctm: multiply(m, state.ctm) };
        }
        break;
      case "BT":
      case "ET":
        walk.tm = IDENTITY;
        walk.lm = IDENTITY;
        walk.lastShow = null;
        break;
      case "Tf": {
        const nameToken = args[0];
        const model = nameToken && nameToken.kind === "name" ? resolveFont(walk, resources, nameToken.value) : null;
        walk.state = { ...state, font: model, fontUnsafe: model ? (model.unsafe ?? null) : "widths", size: n(1) };
        break;
      }
      case "Td":
        walk.lm = multiply([1, 0, 0, 1, n(0), n(1)], walk.lm);
        walk.tm = walk.lm;
        walk.lastShow = null;
        break;
      case "TD":
        walk.state = { ...state, leading: -n(1) };
        walk.lm = multiply([1, 0, 0, 1, n(0), n(1)], walk.lm);
        walk.tm = walk.lm;
        walk.lastShow = null;
        break;
      case "Tm":
        if (args.length >= 6) {
          walk.tm = [n(0), n(1), n(2), n(3), n(4), n(5)];
          walk.lm = walk.tm;
        }
        walk.lastShow = null;
        break;
      case "T*":
        nextLine(walk);
        walk.lastShow = null;
        break;
      case "TL":
        walk.state = { ...state, leading: n(0) };
        break;
      case "Tc":
        walk.state = { ...state, charSpacing: n(0) };
        break;
      case "Tw":
        walk.state = { ...state, wordSpacing: n(0) };
        break;
      case "Tz":
        walk.state = { ...state, hScale: n(0) / 100 };
        break;
      case "Ts":
        walk.state = { ...state, rise: n(0) };
        break;
      case "Tr":
        walk.state = { ...state, renderMode: n(0) };
        break;
      case "Tj":
      case "'":
      case '"':
      case "TJ": {
        const op = token.value as ShowOp["op"];
        if (op === '"') {
          walk.state = { ...state, wordSpacing: n(0), charSpacing: n(1) };
        }
        if (op === "'" || op === '"') {
          nextLine(walk);
          walk.lastShow = null;
        } else if (walk.lastShow) {
          walk.lastShow.needsAdvance = true;
        }
        const items: Array<StrItem | NumItem> = [];
        const last = args[args.length - 1];
        if (op === "TJ") {
          if (last && last.kind === "array") {
            for (const item of last.items) {
              if (item.kind === "str") items.push(showString(walk, item.bytes));
              else if (item.kind === "num") {
                showAdjust(walk, item.value);
                items.push({ kind: "num", value: item.value, raw: tokenText(slot.bytes, item) });
              }
            }
          }
        } else if (last && last.kind === "str") {
          items.push(showString(walk, last.bytes));
        }
        const mode = walk.state.renderMode;
        let unsafe: RemoveFailReason | null = walk.state.fontUnsafe;
        if (mode === 3) unsafe = "invisible";
        else if (mode >= 4) unsafe = "clip";
        // Las pintadas de un XObject se cuentan enteras ANTES de decidir (abajo): aqui
        // la primera pintada aun veria un contador de 1.
        const first = args[0];
        const show: ShowOp = {
          slot,
          op,
          start: first ? first.start : token.start,
          end: token.end,
          items,
          quoteArgs: op === '"' && args.length >= 3 ? [tokenText(slot.bytes, args[0]), tokenText(slot.bytes, args[1])] : [],
          fontSize: walk.state.size,
          hScale: walk.state.hScale,
          unsafe,
          needsAdvance: false,
        };
        walk.shows.push(show);
        walk.lastShow = show;
        break;
      }
      case "Do": {
        const nameToken = args[0];
        if (!nameToken || nameToken.kind !== "name" || !resources || walk.depth >= 8) break;
        const xobjects = resources.lookup(PDFName.of("XObject"));
        if (!(xobjects instanceof PDFDict)) break;
        const ref = xobjects.get(PDFName.of(nameToken.value));
        if (!(ref instanceof PDFRef)) break;
        const stream = walk.context.lookup(ref);
        if (!(stream instanceof PDFStream)) break;
        const subtype = stream.dict.lookup(PDFName.of("Subtype"));
        if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Form") break;
        const key = ref.toString();
        if (walk.visiting.has(key)) break;
        walk.paints.set(key, (walk.paints.get(key) ?? 0) + 1);
        const bytes = decodeStream(stream);
        if (!bytes) break;
        const matrixArray = stream.dict.lookup(PDFName.of("Matrix"));
        let matrix: Matrix = IDENTITY;
        if (matrixArray instanceof PDFArray && matrixArray.size() >= 6) {
          const values = matrixArray.asArray().map((v) => num(walk.context.lookup(v), 0));
          matrix = values.slice(0, 6) as Matrix;
        }
        const innerResources = stream.dict.lookup(PDFName.of("Resources"));
        const inner: StreamSlot = { ref, stream, bytes, xobject: ref, splices: [] };
        walk.slots.push(inner);
        const saved = { state: walk.state, stack: walk.stack, tm: walk.tm, lm: walk.lm };
        walk.state = { ...walk.state, ctm: multiply(matrix, walk.state.ctm) };
        walk.stack = [];
        walk.depth += 1;
        walk.visiting.add(key);
        try {
          walkStream(walk, inner, innerResources instanceof PDFDict ? innerResources : resources);
        } finally {
          walk.visiting.delete(key);
          walk.depth -= 1;
          walk.state = saved.state;
          walk.stack = saved.stack;
          walk.tm = saved.tm;
          walk.lm = saved.lm;
        }
        break;
      }
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Casado de glifos con los bloques editados
 * ------------------------------------------------------------------ */

type Target = {
  edit: TextEdit;
  origin: { x: number; y: number };
  width: number;
  height: number;
  cos: number;
  sin: number;
  pad: number;
  obstacles: UserBox[];
};

function targetOf(edit: TextEdit): Target | null {
  const pad = Math.max(0.5, Math.min(2, edit.fontSize * 0.08));
  const obstacles = (edit.obstacles ?? []).map((o) => o.box);
  if (edit.coverOriented) {
    const r = (edit.coverOriented.rotation * Math.PI) / 180;
    return {
      edit,
      origin: edit.coverOriented.origin,
      width: edit.coverOriented.width,
      height: edit.coverOriented.height,
      cos: Math.cos(r),
      sin: Math.sin(r),
      pad,
      obstacles,
    };
  }
  const box = edit.coverBox ?? edit.box;
  return { edit, origin: { x: box.x, y: box.y }, width: box.width, height: box.height, cos: 1, sin: 0, pad, obstacles };
}

function insideTarget(t: Target, p: { x: number; y: number }): boolean {
  const dx = p.x - t.origin.x;
  const dy = p.y - t.origin.y;
  const lx = dx * t.cos + dy * t.sin;
  const ly = -dx * t.sin + dy * t.cos;
  return lx >= -t.pad && lx <= t.width + t.pad && ly >= -t.pad && ly <= t.height + t.pad;
}

function insideBox(box: UserBox, p: { x: number; y: number }): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}

function formatNumber(value: number): string {
  const s = value.toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

function hexOf(bytes: Uint8Array): string {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `${s}>`;
}

/** Nuevo texto del operador con los glifos `removed` quitados y su avance conservado. */
function rewriteShow(show: ShowOp, removed: Set<Glyph>): string {
  const parts: Array<{ kind: "str"; hex: string } | { kind: "num"; value: number; raw?: string }> = [];
  const pushNum = (value: number, raw?: string) => {
    const previous = parts[parts.length - 1];
    if (previous && previous.kind === "num") {
      previous.value += value;
      previous.raw = undefined;
    } else parts.push({ kind: "num", value, raw });
  };
  const denominator = show.fontSize * show.hScale;
  for (const item of show.items) {
    if (item.kind === "num") {
      pushNum(item.value, item.raw);
      continue;
    }
    let kept: number[] = [];
    let pendingTx = 0;
    const flushKept = () => {
      if (kept.length > 0) {
        parts.push({ kind: "str", hex: hexOf(Uint8Array.from(kept)) });
        kept = [];
      }
    };
    const flushRemoved = () => {
      if (pendingTx !== 0) {
        pushNum((-pendingTx * 1000) / denominator);
        pendingTx = 0;
      }
    };
    item.glyphs.forEach((glyph, index) => {
      const code = item.codes[index];
      if (removed.has(glyph)) {
        flushKept();
        pendingTx += glyph.tx;
      } else {
        flushRemoved();
        if (item.bytesPerCode === 2) kept.push(code >> 8, code & 0xff);
        else kept.push(code);
      }
    });
    flushKept();
    flushRemoved();
  }
  let prefix = "";
  if (show.op === '"') prefix = `${show.quoteArgs[0] ?? "0"} Tw ${show.quoteArgs[1] ?? "0"} Tc T* `;
  else if (show.op === "'") prefix = "T* ";
  // Sin glifos que conservar y sin otro Tj/TJ detras en el mismo objeto de
  // texto: el avance no importa y no se deja ni un fragmento vacio (pdf.js lo
  // fundiria con el texto siguiente como un hueco).
  if (!parts.some((p) => p.kind === "str") && !show.needsAdvance) return prefix.trimEnd();
  const body = parts
    .map((p) => (p.kind === "str" ? p.hex : p.raw ?? formatNumber(p.value)))
    .join(" ");
  return `${prefix}[${body}] TJ`;
}

/* ------------------------------------------------------------------ *
 * Reescritura de los flujos
 * ------------------------------------------------------------------ */

function applySplices(bytes: Uint8Array, splices: Array<{ start: number; end: number; text: string }>): Uint8Array {
  const ordered = [...splices].sort((a, b) => a.start - b.start);
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const splice of ordered) {
    chunks.push(bytes.subarray(cursor, splice.start));
    const encoded = new Uint8Array(splice.text.length);
    for (let i = 0; i < splice.text.length; i += 1) encoded[i] = splice.text.charCodeAt(i) & 0xff;
    chunks.push(encoded);
    cursor = splice.end;
  }
  chunks.push(bytes.subarray(cursor));
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function writeStream(context: PDFContext, page: PDFPage, slot: StreamSlot, bytes: Uint8Array): void {
  const encoded = context.flateStream(bytes);
  if (slot.stream instanceof PDFRawStream) {
    // En su sitio: el objeto sigue siendo el mismo (lo que ya lo referencia no cambia).
    (slot.stream as unknown as { contents: Uint8Array }).contents = encoded.contents;
    slot.stream.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
    slot.stream.dict.delete(PDFName.of("DecodeParms"));
    slot.stream.dict.set(PDFName.of("Length"), PDFNumber.of(encoded.contents.length));
    return;
  }
  if (!slot.ref) throw new Error("content stream without ref");
  // Flujo creado por pdf-lib (documento sin guardar): se sustituye el objeto.
  for (const [key, value] of slot.stream.dict.entries()) {
    const name = key.decodeText();
    if (name !== "Filter" && name !== "Length" && name !== "DecodeParms") encoded.dict.set(key, value);
  }
  context.assign(slot.ref, encoded);
  const cache = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  if (cache.contentStreamRef === slot.ref || cache.contentStream === slot.stream) {
    cache.contentStream = undefined;
    cache.contentStreamRef = undefined;
  }
}

/** Copia-al-escribir: el flujo de la pagina lo comparten otras paginas, asi que se crea uno NUEVO con `bytes`. */
function cloneStream(context: PDFContext, page: PDFPage, slot: StreamSlot, bytes: Uint8Array): PDFRef {
  const encoded = context.flateStream(bytes);
  for (const [key, value] of slot.stream.dict.entries()) {
    const name = key.decodeText();
    if (name !== "Filter" && name !== "Length" && name !== "DecodeParms") encoded.dict.set(key, value);
  }
  const ref = context.register(encoded);
  const cache = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  if ((slot.ref && cache.contentStreamRef === slot.ref) || cache.contentStream === slot.stream) {
    cache.contentStream = undefined;
    cache.contentStreamRef = undefined;
  }
  return ref;
}

/** Cuantas veces referencia cada objeto indirecto el resto del documento (diccionarios, arrays y flujos). */
function incomingReferences(context: PDFContext): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 16) return;
    if (value instanceof PDFRef) {
      const key = value.toString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else if (value instanceof PDFDict) {
      for (const [, inner] of value.entries()) visit(inner, depth + 1);
    } else if (value instanceof PDFArray) {
      for (const inner of value.asArray()) visit(inner, depth + 1);
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    visit(object instanceof PDFStream ? object.dict : object, 0);
  }
  return counts;
}

/**
 * Los glifos que se van a quitar corresponden al texto original del bloque:
 * con `ToUnicode` la cuenta de caracteres no blancos es exacta; sin el (o con
 * codigos sin entrada) se admite la holgura de las ligaduras y de los espacios
 * desconocidos. Un glifo ajeno que sobra, o uno propio que falta, la rompe.
 */
export function glyphsMatch(
  profile: GlyphProfile,
  texts: ReadonlyArray<{ text: string; exact: boolean } | null>,
): boolean {
  let known = "";
  let approximate = 0;
  let unknown = 0;
  for (const entry of texts) {
    if (!entry) unknown += 1;
    else if (entry.exact) known += entry.text;
    else if (/^\s$/u.test(entry.text)) continue;
    else approximate += 1;
  }
  const base = countNonBlank(known) + approximate;
  if (unknown === 0 && approximate === 0) return profile.chars === base;
  return profile.chars >= base && profile.chars <= base + unknown + profile.ligatures;
}

/** XObjects (y los anidados en ellos) que usan las demas paginas del documento. */
function xobjectsUsedElsewhere(document: PDFDocument, page: PDFPage): Set<string> {
  const used = new Set<string>();
  const visit = (resources: unknown, depth: number) => {
    if (!(resources instanceof PDFDict) || depth > 8) return;
    const xobjects = resources.lookup(PDFName.of("XObject"));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, value] of xobjects.entries()) {
      if (!(value instanceof PDFRef)) continue;
      const key = value.toString();
      if (used.has(key)) continue;
      used.add(key);
      const stream = document.context.lookup(value);
      if (stream instanceof PDFStream) visit(stream.dict.lookup(PDFName.of("Resources")), depth + 1);
    }
  };
  for (const other of document.getPages()) {
    if (other === page || other.ref === page.ref) continue;
    try {
      visit(other.node.Resources(), 0);
    } catch {
      // Una pagina ilegible no bloquea: sus XObjects no se conocen.
    }
  }
  return used;
}

/**
 * Quita del flujo de contenido de `page` el texto original de las ediciones
 * que reemplazan un bloque. Devuelve un resultado por edicion (en el mismo
 * orden). Nunca lanza: un flujo ilegible deja todas las ediciones en
 * `removed: false` con `reason: "unreadable"` y no toca el PDF.
 */
export function removeOriginalText(
  document: PDFDocument,
  page: PDFPage,
  edits: readonly TextEdit[],
): RemoveOutcome[] {
  const outcomes: RemoveOutcome[] = edits.map((edit) => ({ editId: edit.id, removed: false, glyphs: 0, reason: "not-found" }));
  const targets = edits.map(targetOf);
  if (targets.every((t) => t === null)) return outcomes;
  const context = document.context;

  let walk: Walk;
  let pageSlotCount = 0;
  let contentsContainer: PDFRef | null = null;
  let contentsWasArray = false;
  try {
    const contents = page.node.Contents();
    const slots: StreamSlot[] = [];
    const entries: Array<{ ref: PDFRef | null; stream: PDFStream }> = [];
    if (contents instanceof PDFStream) {
      const raw = page.node.get(PDFName.of("Contents"));
      entries.push({ ref: raw instanceof PDFRef ? raw : null, stream: contents });
    } else if (contents instanceof PDFArray) {
      contentsWasArray = true;
      const raw = page.node.get(PDFName.of("Contents"));
      contentsContainer = raw instanceof PDFRef ? raw : null;
      for (let i = 0; i < contents.size(); i += 1) {
        const raw = contents.get(i);
        const stream = context.lookup(raw);
        if (stream instanceof PDFStream) entries.push({ ref: raw instanceof PDFRef ? raw : null, stream });
      }
    }
    if (entries.length === 0) return outcomes;
    for (const entry of entries) {
      const bytes = decodeStream(entry.stream);
      if (!bytes) throw new Error("unreadable content stream");
      slots.push({ ref: entry.ref, stream: entry.stream, bytes, xobject: null, splices: [] });
    }
    pageSlotCount = slots.length;
    walk = {
      context,
      slots: [...slots],
      shows: [],
      paints: new Map(),
      state: {
        ctm: IDENTITY,
        font: null,
        fontUnsafe: null,
        size: 0,
        charSpacing: 0,
        wordSpacing: 0,
        hScale: 1,
        rise: 0,
        leading: 0,
        renderMode: 0,
      },
      stack: [],
      tm: IDENTITY,
      lm: IDENTITY,
      fontCache: new Map(),
      depth: 0,
      visiting: new Set(),
      lastShow: null,
    };
    const resources = page.node.Resources();
    for (const slot of slots) walkStream(walk, slot, resources instanceof PDFDict ? resources : null);
  } catch {
    return outcomes.map((o) => ({ ...o, reason: "unreadable" as const }));
  }

  const shared = xobjectsUsedElsewhere(document, page);
  let references: Map<string, number> | null = null;
  const incoming = (ref: PDFRef | null): number => {
    if (!ref) return 0;
    references ??= incomingReferences(context);
    return references.get(ref.toString()) ?? 0;
  };
  const blocked = new Map<number, RemoveFailReason>();
  const found = new Array<number>(edits.length).fill(0);
  type Candidate = { owner: number; show: ShowOp; glyph: Glyph; text: ReturnType<NonNullable<FontModel["unicodeOf"]>> };
  const candidates: Candidate[] = [];

  for (const show of walk.shows) {
    const xobjectKey = show.slot.xobject?.toString() ?? null;
    // Un XObject es exclusivo de esta pintada solo si se pinta UNA vez en la pagina, no lo usa
    // ninguna otra pagina y nada mas del documento (otro XObject, anotacion, patron) lo referencia.
    const sharedHere =
      xobjectKey !== null &&
      (shared.has(xobjectKey) || (walk.paints.get(xobjectKey) ?? 0) > 1 || incoming(show.slot.xobject) > 1);
    for (const item of show.items) {
      if (item.kind !== "str") continue;
      item.glyphs.forEach((glyph, index) => {
        let owner = -1;
        for (let i = 0; i < targets.length; i += 1) {
          const t = targets[i];
          if (!t) continue;
          if (!insideTarget(t, glyph.start) || !insideTarget(t, glyph.end)) continue;
          // Un glifo mucho mayor o menor que el bloque no es suyo (fondo, marca de agua).
          if (glyph.size > t.edit.fontSize * 1.8 + 1 || glyph.size < t.edit.fontSize * 0.4 - 1) continue;
          owner = i;
          break;
        }
        if (owner < 0) return;
        const t = targets[owner]!;
        found[owner] += 1;
        const mid = { x: (glyph.start.x + glyph.end.x) / 2, y: (glyph.start.y + glyph.end.y) / 2 };
        let reason: RemoveFailReason | null = show.unsafe;
        if (!reason && sharedHere) reason = "shared-xobject";
        if (!reason && t.obstacles.some((box) => insideBox(box, mid))) reason = "ambiguous";
        if (!reason && !(show.fontSize * show.hScale > 0)) reason = "widths";
        if (reason) {
          if (!blocked.has(owner)) blocked.set(owner, reason);
          return;
        }
        candidates.push({ owner, show, glyph, text: item.font?.unicodeOf?.(item.codes[index]) ?? null });
      });
    }
  }

  // Los glifos quitados deben ser los del bloque: ni faltan ni sobran.
  for (let i = 0; i < edits.length; i += 1) {
    if (blocked.has(i) || found[i] === 0) continue;
    const profile = edits[i].originalGlyphs;
    if (!profile) continue;
    if (!glyphsMatch(profile, candidates.filter((c) => c.owner === i).map((c) => c.text))) blocked.set(i, "ambiguous");
  }

  // Un bloque se quita entero o no se quita: si algun glifo suyo esta bloqueado, se dejan todos.
  const removedByShow = new Map<ShowOp, Set<Glyph>>();
  for (const candidate of candidates) {
    if (blocked.has(candidate.owner)) continue;
    let set = removedByShow.get(candidate.show);
    if (!set) {
      set = new Set();
      removedByShow.set(candidate.show, set);
    }
    set.add(candidate.glyph);
    outcomes[candidate.owner].glyphs += 1;
  }

  for (const [show, set] of removedByShow) {
    show.slot.splices.push({ start: show.start, end: show.end, text: rewriteShow(show, set) });
  }

  try {
    const pageSlots = walk.slots.slice(0, pageSlotCount);
    const containerShared = contentsContainer !== null && incoming(contentsContainer) > 1;
    const replacements = new Map<StreamSlot, PDFRef>();
    for (const slot of walk.slots) {
      if (slot.splices.length === 0) continue;
      const bytes = applySplices(slot.bytes, slot.splices);
      const pageLevel = slot.xobject === null;
      if (pageLevel && (containerShared || incoming(slot.ref) > 1)) {
        replacements.set(slot, cloneStream(context, page, slot, bytes));
      } else {
        writeStream(context, page, slot, bytes);
      }
    }
    if (replacements.size > 0) {
      const refs = pageSlots.map((slot) => replacements.get(slot) ?? slot.ref);
      if (refs.some((ref) => ref === null)) throw new Error("content stream without ref");
      page.node.set(PDFName.of("Contents"), refs.length === 1 && !contentsWasArray ? refs[0]! : context.obj(refs as PDFRef[]));
    }
  } catch {
    return outcomes.map((o) => ({ ...o, removed: false, glyphs: 0, reason: "unreadable" as const }));
  }

  return outcomes.map((outcome, i) => {
    const reason = blocked.get(i);
    if (reason) return { ...outcome, removed: false, glyphs: 0, reason };
    if (found[i] === 0) return { ...outcome, removed: false, glyphs: 0, reason: "not-found" };
    return { editId: outcome.editId, removed: true, glyphs: outcome.glyphs };
  });
}
