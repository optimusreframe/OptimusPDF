import {
  LIBERATION_MONO_RANGES,
  LIBERATION_SANS_RANGES,
  LIBERATION_SERIF_RANGES,
} from "@/lib/pdf/editFontCoverage";
import type {
  CatalogFontKey,
  FontFamilyKind,
  SourceFontInfo,
} from "@/lib/pdf/editTypes";

/**
 * Catalogo de fuentes del editor de texto existente (Wave 5).
 *
 * Cuando el usuario edita un bloque, el texto se REDIBUJA con una fuente de
 * este catalogo (no se puede reescribir la fuente original: suele ser un
 * subconjunto embebido sin los glifos nuevos). Hay dos clases:
 *
 *  - ESTANDAR (`helvetica`, `times`, `courier`): las 14 fuentes base de PDF.
 *    No pesan nada en el archivo, pero solo codifican WinAnsi.
 *  - EMBEBIDA (`liberation-*`): TTF de licencia libre (OFL-1.1, ver
 *    `public/fonts/README`) servidos desde
 *    `public/fonts/` y embebidos como SUBCONJUNTO con `@pdf-lib/fontkit`
 *    (solo viajan los glifos usados: pocos KB frente a ~400 KB del TTF).
 *
 * Las tres familias (Sans, Serif y Mono, 4 estilos cada una) son Liberation
 * 2.1.5 (SIL OFL-1.1; origen, hashes y licencia en `public/fonts/README`).
 * Son clones metricos de Arial/Helvetica, Times New Roman y Courier New, y
 * cubren latin extendido, griego y cirilico: un texto con esos alfabetos
 * mantiene la FAMILIA (serif sigue siendo serif) en vez de caer a Sans.
 *
 * Este modulo es puro y ligero (sin pdf-lib ni fontkit): la interfaz lo usa
 * para mapear fuentes, comprobar glifos y montar la vista previa CSS sin
 * arrastrar el motor de exportacion.
 */

/* ------------------------------------------------------------------ *
 * Tabla del catalogo
 * ------------------------------------------------------------------ */

/** Familia de las 14 fuentes base de PDF (la misma que `PdfFontFamily`). */
export type StandardFamily = "helvetica" | "times" | "courier";

export type FontFiles = {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
};

/** Cobertura de glifos: WinAnsi (fuentes base) o la de cada familia Liberation. */
export type FontCoverage = "winansi" | "liberation-sans" | "liberation-serif" | "liberation-mono";

export type CatalogFontEntry = {
  key: CatalogFontKey;
  label: string;
  family: FontFamilyKind;
  /** Familia base de PDF si es una fuente estandar (0 bytes en el archivo). */
  standard: StandardFamily | null;
  /** Archivos TTF por estilo dentro de `FONT_BASE_URL`; null si no existen. */
  files: FontFiles | null;
  coverage: FontCoverage;
  /** Clave con la que se dibuja cuando `files` es null y no es estandar. */
  fallbackKey: CatalogFontKey | null;
};

/** Carpeta publica de los TTF (ver `public/fonts/README`). */
export const FONT_BASE_URL = "/fonts/";

function liberationFiles(family: "Sans" | "Serif" | "Mono"): FontFiles {
  return {
    regular: `Liberation${family}-Regular.ttf`,
    bold: `Liberation${family}-Bold.ttf`,
    italic: `Liberation${family}-Italic.ttf`,
    boldItalic: `Liberation${family}-BoldItalic.ttf`,
  };
}

export const CATALOG: Readonly<Record<CatalogFontKey, CatalogFontEntry>> = {
  helvetica: {
    key: "helvetica",
    label: "Helvetica",
    family: "sans",
    standard: "helvetica",
    files: null,
    coverage: "winansi",
    fallbackKey: null,
  },
  times: {
    key: "times",
    label: "Times",
    family: "serif",
    standard: "times",
    files: null,
    coverage: "winansi",
    fallbackKey: null,
  },
  courier: {
    key: "courier",
    label: "Courier",
    family: "mono",
    standard: "courier",
    files: null,
    coverage: "winansi",
    fallbackKey: null,
  },
  "liberation-sans": {
    key: "liberation-sans",
    label: "Liberation Sans",
    family: "sans",
    standard: null,
    files: liberationFiles("Sans"),
    coverage: "liberation-sans",
    fallbackKey: "helvetica",
  },
  "liberation-serif": {
    key: "liberation-serif",
    label: "Liberation Serif",
    family: "serif",
    standard: null,
    files: liberationFiles("Serif"),
    coverage: "liberation-serif",
    fallbackKey: "times",
  },
  "liberation-mono": {
    key: "liberation-mono",
    label: "Liberation Mono",
    family: "mono",
    standard: null,
    files: liberationFiles("Mono"),
    coverage: "liberation-mono",
    fallbackKey: "courier",
  },
};

export const CATALOG_FONT_KEYS: readonly CatalogFontKey[] = [
  "helvetica",
  "times",
  "courier",
  "liberation-sans",
  "liberation-serif",
  "liberation-mono",
];

/**
 * Clave con la que SE DIBUJA realmente `key`: ella misma si es estandar o
 * tiene TTF, y su `fallbackKey` si faltara el archivo. Nunca devuelve una
 * clave sin forma de dibujarse.
 */
export function effectiveFontKey(key: CatalogFontKey): CatalogFontKey {
  const entry = CATALOG[key];
  if (entry.standard || entry.files) return key;
  return entry.fallbackKey ?? "helvetica";
}

/** True si `key` se dibuja con su propia fuente y no con un sustituto. */
export function isCatalogFontNative(key: CatalogFontKey): boolean {
  return effectiveFontKey(key) === key;
}

/** True si la clave se embebe desde un TTF (hace falta fontkit + archivo). */
export function isEmbeddedFont(key: CatalogFontKey): boolean {
  return CATALOG[effectiveFontKey(key)].files !== null;
}

/* ------------------------------------------------------------------ *
 * Mapeo de la fuente original a una del catalogo
 * ------------------------------------------------------------------ */

/** Quita el prefijo de subconjunto "ABCDEF+" y deja solo [a-z0-9]. */
function normalizeFontName(pdfName: string): string {
  return pdfName
    .replace(/^[A-Z]{6}\+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Lo que puede seguir al nombre base sin que la fuente deje de ser la misma
 * (peso, estilo y sufijos PostScript/TrueType: "ArialMT", "Arial-BoldMT",
 * "TimesNewRomanPS-BoldItalicMT"...) y el sufijo numerico con que pdf-lib
 * nombra sus subconjuntos ("LiberationSans-8450"). Si queda algo mas ("Narrow",
 * "Black", "Neue", "Unicode"...) es otra fuente y la sustitucion es aproximada.
 */
const STYLE_TAIL =
  /^(?:bolditalic|boldoblique|bold|italic|oblique|regular|roman|normal|bd|it|bi|ps|mt)*\d*$/;

type FamilyRule = {
  /** Prefijo ya normalizado. */
  prefix: string;
  key: CatalogFontKey;
  /** Si `true`, el prefijo es la misma fuente (o su clon metrico). */
  native: boolean;
};

// El orden importa: prefijos mas largos primero para que "timesnewroman" no
// lo capture "times" ni "arialnarrow" lo capture "arial" como exacta.
const FAMILY_RULES: readonly FamilyRule[] = [
  // Fuentes y clones metricos con equivalente exacto.
  { prefix: "liberationsans", key: "liberation-sans", native: true },
  { prefix: "liberationserif", key: "liberation-serif", native: true },
  { prefix: "liberationmono", key: "liberation-mono", native: true },
  { prefix: "arimo", key: "liberation-sans", native: true },
  { prefix: "tinos", key: "liberation-serif", native: true },
  { prefix: "cousine", key: "liberation-mono", native: true },
  { prefix: "arial", key: "helvetica", native: true },
  { prefix: "helvetica", key: "helvetica", native: true },
  { prefix: "timesnewroman", key: "times", native: true },
  { prefix: "times", key: "times", native: true },
  { prefix: "couriernew", key: "courier", native: true },
  { prefix: "courier", key: "courier", native: true },
  // Sustitutas aproximadas con la que el plan manda (Wave 5, decision 2).
  { prefix: "calibri", key: "liberation-sans", native: false },
  { prefix: "verdana", key: "liberation-sans", native: false },
  { prefix: "tahoma", key: "liberation-sans", native: false },
  { prefix: "segoe", key: "liberation-sans", native: false },
  { prefix: "cambria", key: "liberation-serif", native: false },
  { prefix: "georgia", key: "liberation-serif", native: false },
  { prefix: "garamond", key: "liberation-serif", native: false },
];

/** Familia de respaldo cuando el nombre no se reconoce: se usa `family`. */
const FAMILY_FALLBACK: Readonly<Record<FontFamilyKind, CatalogFontKey>> = {
  sans: "helvetica",
  serif: "times",
  mono: "courier",
};

/**
 * Elige la fuente del catalogo con la que redibujar un bloque.
 *
 * - `exact: true`: la fuente original ES esa fuente (o su clon metrico), el
 *   redibujado cambiara poco o nada.
 * - `exact: false`: sustitucion aproximada; la interfaz debe avisar.
 *
 * Un nombre desconocido se resuelve por `family` hacia la fuente base de
 * PDF equivalente (0 bytes). Negrita y cursiva NO cambian la clave: se
 * leen de `info` (ver `sourceFontStyle`) y existen los 4 estilos en todas
 * las fuentes del catalogo.
 */
export function mapSourceFont(info: SourceFontInfo): {
  key: CatalogFontKey;
  exact: boolean;
} {
  const name = normalizeFontName(info.pdfName);
  for (const rule of FAMILY_RULES) {
    if (rule.native) {
      if (!name.startsWith(rule.prefix)) continue;
      const exactName = STYLE_TAIL.test(name.slice(rule.prefix.length));
      return { key: rule.key, exact: exactName };
    }
    // Las sustitutas se reconocen tambien por contenido ("EGaramond").
    if (name.includes(rule.prefix)) return { key: rule.key, exact: false };
  }
  return { key: FAMILY_FALLBACK[info.family], exact: false };
}

/**
 * Negrita y cursiva de la fuente original. Se fia de las banderas de pdf.js
 * y, por si el PDF no las marca, tambien del nombre ("Arial-BoldMT").
 */
export function sourceFontStyle(info: SourceFontInfo): {
  bold: boolean;
  italic: boolean;
} {
  const name = info.pdfName.replace(/^[A-Z]{6}\+/, "").toLowerCase();
  return {
    bold: info.bold || /bold|black|heavy|demi/.test(name),
    italic: info.italic || /italic|oblique/.test(name),
  };
}

/* ------------------------------------------------------------------ *
 * Cobertura de glifos
 * ------------------------------------------------------------------ */

/** Puntos de codigo de 0x80-0x9F que WinAnsi sustituye por simbolos. */
const WIN_ANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function inWinAnsi(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)
    ? true
    : WIN_ANSI_HIGH.has(code);
}

/** Tablas de glifos de cada familia Liberation (generadas; ver `editFontCoverage.ts`). */
const LIBERATION_RANGES: Readonly<
  Record<
    Exclude<FontCoverage, "winansi">,
    ReadonlyArray<readonly [number, number]>
  >
> = {
  "liberation-sans": LIBERATION_SANS_RANGES,
  "liberation-serif": LIBERATION_SERIF_RANGES,
  "liberation-mono": LIBERATION_MONO_RANGES,
};

function inRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  code: number,
): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid];
    if (code < start) high = mid - 1;
    else if (code > end) low = mid + 1;
    else return true;
  }
  return false;
}

/** True si la fuente que dibuja `key` tiene glifo para `code`. */
export function fontHasCodePoint(key: CatalogFontKey, code: number): boolean {
  const coverage = CATALOG[effectiveFontKey(key)].coverage;
  return coverage === "winansi"
    ? inWinAnsi(code)
    : inRanges(LIBERATION_RANGES[coverage], code);
}

/* ------------------------------------------------------------------ *
 * Limpieza del texto antes de medirlo / dibujarlo
 * ------------------------------------------------------------------ */

/**
 * Caracteres que no se dibujan ni se avisan: controles C0/C1, marcas de
 * ancho cero y de direccion. Un salto de linea NO es ignorable (parte el
 * texto); el tabulador se trata aparte (se convierte en espacios).
 */
function isIgnorable(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a && code !== 0x09) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff
  );
}

/** Normaliza saltos de linea (CRLF, CR, U+2028/2029) a "\n" y NFC. */
function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/\t/g, "    ");
}

/** Caracteres de `text` que `key` no puede dibujar (unicos, en orden). */
export function uncoveredChars(key: CatalogFontKey, text: string): string[] {
  const seen = new Set<string>();
  for (const char of normalizeText(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a || isIgnorable(code)) continue;
    if (!fontHasCodePoint(key, code)) seen.add(char);
  }
  return [...seen];
}

/** True si `key` dibuja TODO el texto sin sustituir ningun caracter. */
export function fontCoversText(key: CatalogFontKey, text: string): boolean {
  return uncoveredChars(key, text).length === 0;
}

/**
 * Deja `text` listo para medirlo y dibujarlo con `key`: saltos de linea
 * normalizados, controles fuera y cada caracter sin glifo cambiado por "?"
 * (que se devuelve en `unsupported` para avisar; nunca se hace en silencio).
 */
export function sanitizeTextForFont(
  key: CatalogFontKey,
  text: string,
): { text: string; unsupported: string[] } {
  const unsupported = new Set<string>();
  let out = "";
  for (const char of normalizeText(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      out += char;
    } else if (isIgnorable(code)) {
      continue;
    } else if (fontHasCodePoint(key, code)) {
      out += char;
    } else {
      unsupported.add(char);
      out += "?";
    }
  }
  return { text: out, unsupported: [...unsupported] };
}

const LIBERATION_BY_FAMILY: Readonly<Record<FontFamilyKind, CatalogFontKey>> = {
  sans: "liberation-sans",
  serif: "liberation-serif",
  mono: "liberation-mono",
};

/**
 * Fuentes que se prueban, por orden, cuando la preferida no cubre el texto:
 * primero la Liberation de la MISMA familia (serif sigue siendo serif) y
 * despues las otras dos.
 */
function glyphFallbacks(preferredKey: CatalogFontKey): CatalogFontKey[] {
  const own = LIBERATION_BY_FAMILY[CATALOG[preferredKey].family];
  const all: CatalogFontKey[] = [
    own,
    ...Object.values(LIBERATION_BY_FAMILY).filter((key) => key !== own),
  ];
  return all.filter((key) => key !== effectiveFontKey(preferredKey));
}

export type FontPick = {
  /** Fuente con la que dibujar (la preferida, o un respaldo con mas glifos). */
  key: CatalogFontKey;
  /** True si no es la preferida. */
  changed: boolean;
  /** Caracteres que la preferida no puede dibujar (vacio si no cambio nada). */
  outsidePreferred: string[];
  /** Caracteres que NINGUNA fuente del catalogo dibuja: saldran como "?". */
  unsupported: string[];
};

/**
 * Fuente con la que dibujar `text` partiendo de `preferredKey`.
 *
 * Si la preferida no tiene algun glifo (fuera de WinAnsi en las fuentes
 * base) se pasa a la Liberation de su misma familia y, si tampoco los tiene
 * todos, a la primera fuente del catalogo que si; si
 * ninguna los cubre todos se queda con la que cubra mas y se devuelve la
 * lista de caracteres imposibles. Se elige UNA fuente para todo el texto:
 * mezclar fuentes dentro de un parrafo rompe el ritmo y el ajuste de linea.
 */
export function pickFontForText(
  preferredKey: CatalogFontKey,
  text: string,
): FontPick {
  const outside = uncoveredChars(preferredKey, text);
  if (outside.length === 0) {
    return {
      key: preferredKey,
      changed: false,
      outsidePreferred: [],
      unsupported: [],
    };
  }

  let best: { key: CatalogFontKey; missing: string[] } | null = null;
  for (const candidate of glyphFallbacks(preferredKey)) {
    const missing = uncoveredChars(candidate, text);
    if (missing.length === 0) {
      return {
        key: candidate,
        changed: true,
        outsidePreferred: outside,
        unsupported: [],
      };
    }
    if (!best || missing.length < best.missing.length) {
      best = { key: candidate, missing };
    }
  }

  // Ninguna cubre todo: solo cambia si el respaldo mejora a la preferida.
  if (best && best.missing.length < outside.length) {
    return {
      key: best.key,
      changed: true,
      outsidePreferred: outside,
      unsupported: best.missing,
    };
  }
  return {
    key: preferredKey,
    changed: false,
    outsidePreferred: [],
    unsupported: outside,
  };
}

/* ------------------------------------------------------------------ *
 * Carga perezosa de los TTF
 * ------------------------------------------------------------------ */

export class CatalogFontLoadError extends Error {
  constructor(
    message: string,
    readonly key: CatalogFontKey,
  ) {
    super(message);
    this.name = "CatalogFontLoadError";
  }
}

/** Nombre del archivo TTF de un estilo, o null si la clave no se embebe. */
export function catalogFontFile(
  key: CatalogFontKey,
  bold: boolean,
  italic: boolean,
): string | null {
  const files = CATALOG[effectiveFontKey(key)].files;
  if (!files) return null;
  if (bold && italic) return files.boldItalic;
  if (bold) return files.bold;
  if (italic) return files.italic;
  return files.regular;
}

/** Lee los bytes de un archivo de `public/fonts` por su nombre. */
export type FontFileReader = (fileName: string) => Promise<Uint8Array>;

async function fetchFontFile(fileName: string): Promise<Uint8Array> {
  const response = await fetch(`${FONT_BASE_URL}${fileName}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al pedir ${fileName}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * En Node (pruebas, scripts) lee de `public/fonts` en disco. Usa
 * `process.getBuiltinModule` en vez de `import "node:fs"` para que el
 * empaquetador del cliente nunca vea una dependencia de Node.
 */
async function readFontFileFromDisk(fileName: string): Promise<Uint8Array> {
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  const fs = proc?.getBuiltinModule?.("node:fs/promises");
  if (!proc || !fs) throw new Error("Sin acceso a disco para leer fuentes");
  const path = proc.getBuiltinModule("node:path");
  const buffer = await fs.readFile(
    path.join(proc.cwd(), "public", "fonts", fileName),
  );
  return new Uint8Array(buffer);
}

let fileReader: FontFileReader | null = null;
const fontCache = new Map<string, Promise<Uint8Array>>();

/**
 * Sustituye el lector de archivos (pruebas, entornos sin `fetch` relativo).
 * `null` restaura el comportamiento por defecto: `fetch` en el navegador y
 * lectura de disco en Node. Vacia la cache.
 */
export function setCatalogFontReader(reader: FontFileReader | null): void {
  fileReader = reader;
  fontCache.clear();
}

export function clearCatalogFontCache(): void {
  fontCache.clear();
}

function defaultReader(): FontFileReader {
  return typeof window === "undefined" ? readFontFileFromDisk : fetchFontFile;
}

/**
 * Devuelve los bytes del TTF de una fuente del catalogo. Perezoso (solo se
 * pide lo que el documento usa) y con cache por archivo; un fallo no se
 * cachea para poder reintentar. Solo las fuentes con archivo propio se
 * pueden cargar: para las estandar (o las que se dibujan con un sustituto)
 * lanza `CatalogFontLoadError`; compruebalo antes con `isEmbeddedFont`.
 */
export async function loadCatalogFont(
  key: CatalogFontKey,
  bold: boolean,
  italic: boolean,
): Promise<Uint8Array> {
  const fileName = catalogFontFile(key, bold, italic);
  if (!fileName) {
    throw new CatalogFontLoadError(
      `La fuente "${key}" no se embebe desde un archivo`,
      key,
    );
  }
  let pending = fontCache.get(fileName);
  if (!pending) {
    const reader = fileReader ?? defaultReader();
    pending = reader(fileName).catch((error: unknown) => {
      fontCache.delete(fileName);
      throw new CatalogFontLoadError(
        error instanceof Error ? error.message : String(error),
        key,
      );
    });
    fontCache.set(fileName, pending);
  }
  return pending;
}

/* ------------------------------------------------------------------ *
 * Vista previa CSS
 * ------------------------------------------------------------------ */

/**
 * Nombre de la familia CSS que apunta a los TTF de `public/fonts`. Distinto
 * de "Liberation Sans" a proposito: si el sistema ya la tiene instalada, el
 * `@font-face` con el mismo nombre la taparia con una descarga innecesaria.
 */
export const LIBERATION_FONT_FACE = "Optimus Liberation Sans";

const LIBERATION_FACES = {
  "liberation-sans": LIBERATION_FONT_FACE,
  "liberation-serif": "Optimus Liberation Serif",
  "liberation-mono": "Optimus Liberation Mono",
} as const;

export type CssFontSpec = {
  fontFamily: string;
  fontWeight: 400 | 700;
  fontStyle: "normal" | "italic";
};

const CSS_STACKS: Readonly<Record<CatalogFontKey, string>> = {
  // Las fuentes base usan pilas del SISTEMA (0 descargas): Arial, Helvetica
  // y Liberation Sans comparten metricas, igual que Times New Roman/Times y
  // Courier New/Courier, asi que el ajuste de linea de la vista previa
  // coincide con el de la exportacion.
  helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
  "liberation-sans": `"${LIBERATION_FONT_FACE}", "Liberation Sans", Arial, Helvetica, sans-serif`,
  "liberation-serif": `"${LIBERATION_FACES["liberation-serif"]}", "Liberation Serif", "Times New Roman", Times, serif`,
  "liberation-mono": `"${LIBERATION_FACES["liberation-mono"]}", "Liberation Mono", "Courier New", Courier, monospace`,
};

/**
 * Tipografia CSS para la vista previa inline de un bloque en edicion. Solo
 * las `liberation-*` necesitan `ensureCatalogFontFaces()` (las fuentes base
 * usan fuentes del sistema equivalentes).
 */
export function cssFontStack(
  key: CatalogFontKey,
  bold: boolean,
  italic: boolean,
): CssFontSpec {
  return {
    fontFamily: CSS_STACKS[key],
    fontWeight: bold ? 700 : 400,
    fontStyle: italic ? "italic" : "normal",
  };
}

/** CSS `@font-face` de las tres Liberation (4 estilos cada una, carga solo si se usa). */
export function catalogFontFaceCss(): string {
  const rules: string[] = [];
  for (const key of Object.keys(LIBERATION_FACES) as Array<keyof typeof LIBERATION_FACES>) {
    const files = CATALOG[key].files;
    if (!files) continue;
    const faces: Array<[string, 400 | 700, "normal" | "italic"]> = [
      [files.regular, 400, "normal"],
      [files.bold, 700, "normal"],
      [files.italic, 400, "italic"],
      [files.boldItalic, 700, "italic"],
    ];
    for (const [file, weight, style] of faces) {
      rules.push(
        `@font-face{font-family:"${LIBERATION_FACES[key]}";` +
          `src:url("${FONT_BASE_URL}${file}") format("truetype");` +
          `font-weight:${weight};font-style:${style};font-display:swap;}`,
      );
    }
  }
  return rules.join("\n");
}

const FONT_FACE_STYLE_ID = "optimus-catalog-font-faces";

/**
 * Registra (una sola vez) los `@font-face` del catalogo en el documento. El
 * navegador solo descarga un TTF cuando algun texto lo usa. CSP: los TTF son
 * del mismo origen (`font-src 'self'`) y la hoja es `<style>` en linea
 * (`style-src 'unsafe-inline'`).
 */
export function ensureCatalogFontFaces(
  target: Document | undefined = typeof document === "undefined"
    ? undefined
    : document,
): void {
  if (!target || target.getElementById(FONT_FACE_STYLE_ID)) return;
  const css = catalogFontFaceCss();
  if (!css) return;
  const style = target.createElement("style");
  style.id = FONT_FACE_STYLE_ID;
  style.textContent = css;
  target.head.appendChild(style);
}
