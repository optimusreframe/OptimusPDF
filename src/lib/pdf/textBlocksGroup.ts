import type {
  OrientedBox,
  SourceFontInfo,
  TextAlign,
  TextBlock,
  TextLine,
  UserBox,
} from "@/lib/pdf/editTypes";
import { fontIdentity } from "@/lib/pdf/fontInfo";

/**
 * Agrupado GEOMETRICO de los fragmentos de texto que devuelve pdf.js en
 * bloques editables (parrafos). Funcion pura: no toca pdf.js, asi que se
 * prueba con fragmentos construidos a mano (ver `textBlocksGroup.test.ts`).
 *
 * No se fia de `hasEOL` (pdf.js lo marca de forma poco fiable): todo sale de
 * las posiciones. Pipeline por pagina:
 *
 *  1. Limpieza: descarta fragmentos vacios, no finitos y duplicados exactos
 *     (el "negrita falsa" dibuja el mismo texto dos veces).
 *  2. Rotacion: los fragmentos se reparten en grupos de misma rotacion
 *     (+-1.5 grados). Dentro de cada grupo se trabaja en un marco (u, v)
 *     girado: u = a lo largo del texto, v = perpendicular hacia arriba.
 *  3. Superindices/subindices: fragmento mas pequeno (< 0.9x; Chrome usa
 *     0.83, Word 0.66) pegado a uno mayor y con la linea base desplazada
 *     (>= 0.2 em arriba o >= 0.12 em abajo). DECISION: NO se funde con
 *     su linea; va como bloque aparte (`script`) y actua de separador
 *     duro: una linea "x2 = 4" queda "x" | "2" | "= 4" para que editar un
 *     tramo nunca pise (ni borre al cubrir) el indice. Por la misma razon
 *     los tramos de la linea que lleva el indice (`cut`) no se funden en
 *     parrafo: un parrafo con notas al pie se fragmenta en lineas sueltas
 *     alrededor del indice, pero ninguna caja cubre a otra.
 *  4. Lineas: misma linea base (tolerancia 0.3x el tamano) y mismo tamano
 *     (+-5 %).
 *  5. Tramos: una linea se parte donde el hueco horizontal supera
 *     `SEGMENT_GAP_EM` (0.7 em, unas 2.5 veces un espacio; un poco mas
 *     holgado que 2x para no trocear texto justificado). Asi las columnas y
 *     las tablas nunca se mezclan en un mismo bloque.
 *  6. Parrafos: un tramo se une al de la linea de arriba si tamano, fuente
 *     y color coinciden, el margen (izquierdo, derecho o centro) coincide y
 *     el interlineado esta en [0.95, 1.45] x tamano (hasta 3 x con prueba
 *     fuerte de texto corrido: la linea llena la columna, el paso lo confirma
 *     una tercera linea o un parrafo ancho ya confirmado y la columna mide
 *     >= 16 tamanos) y es consistente con el de las lineas previas. Dos
 *     lineas sueltas separadas por un margen NUNCA se funden. Reglas de
 *     corte: marcador de lista al inicio, vineta vectorial, el texto envuelve
 *     (si la primera palabra de la linea siguiente cabia en el hueco, el
 *     parrafo acabo) y tramos "de tabla". Sangria colgante: la continuacion
 *     de un elemento "1. ..." empieza tras el marcador (0.8-4 tamanos).
 *     Calles estrechas: un fragmento que empieza sobre el inicio de linea de
 *     2+ lineas mas (o repite x y hueco) tras un hueco >= 0.4 em abre
 *     columna aunque el hueco sea menor que el umbral.
 *  7. Alineacion deducida de los margenes de las lineas del parrafo.
 *  8. Reglas vectoriales (`options.rules`): una regla vertical que cruza la
 *     linea entre dos fragmentos (borde de celda) los separa y parte el
 *     fragmento que pdf.js fundio (por el corte exacto de la instruccion de
 *     texto o, si no, por el espacio mas cercano); una regla horizontal entre
 *     dos lineas corta el parrafo. Las que no se pueden usar (subrayado, linea
 *     sobre una palabra sin espacios) se ignoran.
 */

/** Un fragmento de texto tal y como sale de pdf.js, ya normalizado. */
export type RawTextItem = {
  str: string;
  /** Origen del texto (inicio de la linea base) en espacio de usuario. */
  x: number;
  y: number;
  /** Rotacion en grados antihorarios. */
  rotation: number;
  /** Largo a lo largo de la linea base, en puntos. */
  width: number;
  fontSize: number;
  /** Fracciones del tamano por encima/debajo de la linea base (descent < 0). */
  ascent: number;
  descent: number;
  color: string;
  font: SourceFontInfo;
  /** Render mode 3/7 o alfa 0: texto que no se ve (capa OCR). */
  invisible: boolean;
  /** Fuente en modo vertical. */
  vertical: boolean;
  /**
   * Identificador de la instruccion `showText` de la que sale el fragmento.
   * Fragmentos de la MISMA instruccion son texto continuo (espaciado entre
   * letras o palabras, ajustes de TJ): nunca se parten por un hueco normal.
   */
  runId?: number;
  /** El fragmento mezcla estilos (pdf.js fundio tiradas de distinto color). */
  mixed?: boolean;
  /**
   * `true` si la fuente no traduce codigos a Unicode (todos sus glifos tienen
   * por texto su propio codigo: fuente CID sin ToUnicode); `false` si algun
   * glifo se traduce (hay mapa fiable); `undefined` sin evidencia. Solo con
   * `true` se aplica la heuristica de ids de glifo desplazados.
   */
  identityEncoding?: boolean;
  /**
   * Instrucciones de texto que EMPIEZAN dentro del fragmento (pdf.js funde las de
   * celdas contiguas en uno): distancia a lo largo de la linea base donde
   * empieza la siguiente (`along`), donde acaba la anterior (`leftEndAlong`) y
   * cuantos caracteres hay antes (`index`). Dan el punto de corte exacto.
   */
  cutPoints?: Array<{ along: number; leftEndAlong: number; index: number }>;
};

/** Forma pequena rellena (vineta dibujada como vector), en espacio de usuario. */
export type MarkerShape = { x: number; y: number; width: number; height: number };

/**
 * Regla vectorial fina y larga (borde de tabla, separador): segmento en
 * espacio de usuario con su grosor. Chromium dibuja cada borde como un
 * rectangulo relleno; Word/pdf-lib/pdfkit, como trazos `m/l/S` o `re S`.
 */
export type RuleLine = { x0: number; y0: number; x1: number; y1: number; thickness: number };

export type GroupOptions = {
  pageIndex: number;
  /** CropBox de la pagina (para deducir texto centrado en la pagina). */
  pageBox?: UserBox;
  /** Formas pequenas rellenas de la pagina: vinetas vectoriales de las listas. */
  markers?: readonly MarkerShape[];
  /**
   * Reglas finas de la pagina. Un fragmento no se une con otro a traves de una
   * regla VERTICAL que cruza la linea entre ambos (celdas de tabla, columnas
   * con filete) y una regla HORIZONTAL entre dos lineas corta el parrafo.
   * Una regla que atraviesa un solo fragmento sin espacio donde partirlo
   * (subrayado, tachado, linea decorativa) no se usa.
   */
  rules?: readonly RuleLine[];
};

export type GroupResult = {
  /** Bloques visibles en orden de lectura, con `id` ya asignado. */
  visible: TextBlock[];
  /** Bloques de texto invisible (capa OCR), `readOnlyReason: "invisible"`. */
  hidden: TextBlock[];
};

/* Constantes (documentadas arriba) ---------------------------------- */
export const SEGMENT_GAP_EM = 0.7;
const ROTATION_TOLERANCE_DEG = 1.5;
const SIZE_TOLERANCE = 0.05;
const BASELINE_TOLERANCE = 0.3;
/** Chrome usa 83 % para <sup>/<sub>, Word 66 %, LibreOffice 58 %: se admite hasta 0.9 CON desplazamiento de linea base. */
const SCRIPT_MAX_RATIO = 0.9;
const SCRIPT_MIN_RATIO = 0.3;
const SPACE_EM = 0.25;
const WORD_GAP_EM = 0.1;
const MARGIN_TOLERANCE_EM = 0.6;
const LEADING_MIN = 0.95;
/** Interlineado "normal" que se acepta sin mas pruebas en el primer par de lineas. */
const LEADING_MAX = 1.45;
/**
 * Interlineado maximo absoluto (doble espacio, lineGap): por encima de
 * LEADING_MAX el primer par solo se une si hay prueba de que el texto
 * envuelve (la linea llena la columna y su siguiente palabra no cabria).
 */
const LEADING_ABS_MAX = 3;
/** Hueco maximo (em) entre fragmentos de la MISMA instruccion de texto. */
const SAME_RUN_GAP_EM = 3;
/**
 * Un hueco menor que el umbral pero >= esto (0.4 em, mas que un espacio) es
 * "canalillo" de tabla si el MISMO par (x de inicio, ancho del hueco) se repite
 * en otras lineas: el relleno fijo de las celdas.
 */
const GUTTER_MIN_EM = 0.4;
/** Por encima de esta cantidad de fragmentos no se calculan canalillos (modo rapido). */
const MAX_GUTTER_ITEMS = 15000;
/** Duplicado (negrita falsa): desfase maximo en em. */
const DUPLICATE_OFFSET_EM = 0.03;
const MAX_NEIGHBOURS = 400;
const NO_UNICODE_RATIO = 0.25;
/** Proporcion de caracteres de control que delata un mapeo de glifos roto (sin ToUnicode). */
const CONTROL_CHAR_RATIO = 0.03;

/* Utilidades numericas ---------------------------------------------- */

const DEG = Math.PI / 180;

function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Normaliza un angulo a [0, 360), ajustando a multiplos de 90 si esta a < 0.5 grados. */
export function normalizeRotation(degrees: number): number {
  let angle = ((degrees % 360) + 360) % 360;
  const snapped = Math.round(angle / 90) * 90;
  if (Math.abs(angle - snapped) < 0.5) angle = snapped % 360;
  return round(angle, 2);
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** FNV-1a de 32 bits en hexadecimal (8 caracteres). */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Huella del texto original + su caja (a 0.1 pt) para detectar bloques movidos. */
export function computeOrigHash(text: string, box: UserBox): string {
  return fnv1a(
    `${text}|${box.x.toFixed(1)},${box.y.toFixed(1)},${box.width.toFixed(
      1,
    )},${box.height.toFixed(1)}`,
  );
}

/**
 * pdf.js inserta un espacio entre CADA letra cuando el texto lleva
 * espaciado entre caracteres (`Tc`): "S p a c e d". Si TODOS los "tokens"
 * son de una sola letra (y hay 4 o mas) se vuelve a juntar; un hueco doble
 * marca el limite de palabra.
 */
export function collapseLetterSpacing(str: string): string {
  if (str.length < 7 || !str.includes(" ")) return str;
  const tokens = str.split(" ");
  let single = 0;
  let nonEmpty = 0;
  for (const token of tokens) {
    if (token.length === 0) continue;
    nonEmpty += 1;
    if ([...token].length === 1) single += 1;
  }
  if (nonEmpty < 4 || single !== nonEmpty) return str;
  return tokens.map((token) => (token.length === 0 ? " " : token)).join("");
}

/** Cuenta caracteres "no legibles": control, PUA, U+FFFD. */
export function unreadableRatio(text: string): number {
  let bad = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total += 1;
    const c = ch.codePointAt(0) ?? 0;
    if (
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0xe000 && c <= 0xf8ff) ||
      c === 0xfffd
    ) {
      bad += 1;
    }
  }
  return total === 0 ? 0 : bad / total;
}

/**
 * Proporcion de caracteres de control (C0/C1, salvo tabulador y saltos) sobre
 * el total. Una fuente CID sin ToUnicode deja el ESPACIO como U+0003 y las
 * letras desplazadas ("/RUHP\u0003LSVXP"): pocas letras de control bastan.
 */
export function controlCharRatio(text: string): number {
  let bad = 0;
  let total = 0;
  for (const ch of text) {
    total += 1;
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f)) {
      bad += 1;
    }
  }
  return total === 0 ? 0 : bad / total;
}

/**
 * Fuente CID embebida (subconjunto) sin ToUnicode cuyos ids de glifo salieron
 * como si fueran codigos: el texto es ASCII IMPRIMIBLE desplazado
 * ("6XEWLWXOR" por "Subtitulo", desplazado 29). Como no hay caracteres de
 * control que lo delaten, se exige a la vez:
 *  (a) el texto NO tiene minusculas y no parece texto: algun "token" de 3+
 *      caracteres sin vocales, o con digitos pegados a letras (o los signos
 *      `[ \\ ] ^ _` dentro), en la mitad o mas de los tokens; y
 *  (b) existe un desplazamiento constante de los habituales (27..32: 29 en
 *      TrueType con espacio=gid 3, 31 en CFF con espacio=gid 1) que lo convierte en
 *      palabras con pinta de texto: mayoria de minusculas, proporcion de
 *      vocales entre 0.25 y 0.65 y ningun token de 4+ letras sin vocal.
 * Un titulo legitimo en mayusculas ("INFORME ANUAL") no cumple (a); un
 * acronimo o codigo ("HTML CSS", "PO-4521-X") no cumple (b).
 */
/** Palabras gramaticales muy frecuentes en espanol, ingles, portugues, frances. */
const FUNCTION_WORDS = new Set(
  "lorem ipsum dolor sit amet sed ut et ad est cum non de la el en que los las por con una del para se su al un le es lo como mas pero sus ya o fue este si entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros the of and to in is that for it as was with be by on not he this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no and y do does did of out up about into than them then some what only its over such our also new any these may after most those through between under while where each both own same other before should could here very just now the are est les des du pour dans que qui sur pas plus par au aux ce ces e os as um uma em no na nos nas com por para sao nao mais como mas foi ao ele das tem seu sua ou ser quando muito ha nos ja esta eu tambem so pelo pela ate isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estao voce tinha foram essa num nem suas meu as minha tem numa pelos elas havia seja qual sera nos tenho lhe deles essas esses pelas este fosse dele tu te voces vos lhes meus minhas teu tua teus tuas nosso nossa nossos nossas dela delas esta estes estas aquele aquela aqueles aquelas isto aquilo estou esta estamos estao estive esteve estivemos estiveram estava estavamos estavam estivera estiveramos".split(
    " ",
  ),
);

/** Grupos de dos consonantes frecuentes en espanol/ingles/portugues/frances. */
const COMMON_CC = new Set(
  "st nt nd ng th ch ll rr tr pr cr br bl pl cl fr gr ns ct rt rd sp sc ss mp mb nc rm rs ld lt lm sh ph wh ck gh cc ff nn mm tt dd pp bs ps ls rc rn rl rp rb rg rf lb lc lp lf lg lv nf ng nv ns nz tl dr fl gl sl sm sn sw tw ds ms xt".split(" "),
);

/**
 * Fraccion de pares de letras consecutivos (dentro de cada palabra) que
 * suenan a idioma: vocal-consonante, consonante-vocal, doble vocal o un
 * grupo de consonantes habitual. Texto aleatorio o acronimos desplazados
 * quedan muy por debajo de 0.8.
 */
function pairPlausibility(words: string[]): number {
  let good = 0;
  let total = 0;
  const isVowel = (c: string) => "aeiouAEIOU".includes(c);
  for (const word of words) {
    const letters = word.replace(/[^A-Za-z]/g, "");
    for (let i = 1; i < letters.length; i += 1) {
      const a = letters[i - 1].toLowerCase();
      const b = letters[i].toLowerCase();
      total += 1;
      if (isVowel(a) !== isVowel(b) || (isVowel(a) && isVowel(b)) || COMMON_CC.has(a + b)) {
        good += 1;
      }
    }
  }
  return total === 0 ? 0 : good / total;
}

/** Desplazamientos glifo->ASCII habituales (ver `looksLikeShiftedGlyphIds`). */
const GLYPH_ID_SHIFTS = [29, 31, 28, 30, 27, 32];

export function looksLikeShiftedGlyphIds(text: string): boolean {
  // Un id de glifo desplazado solo produce ASCII imprimible y controles: un
  // caracter fuera de ese rango (acento, enie, simbolo) es texto legitimo.
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 126) return false;
  }
  const compact = text.replace(/[\s\u0000-\u001f]/g, "");
  if (compact.length < 6) return false;
  let letters = 0;
  let lower = 0;
  for (const ch of compact) {
    if (/[A-Za-z]/.test(ch)) {
      letters += 1;
      if (ch >= "a" && ch <= "z") lower += 1;
    }
  }
  if (letters < 4 || lower / letters > 0.05) return false;

  // El original no suena a idioma (pares de letras absurdos).
  const originalWords = text.split(/[\s\u0000-\u001f]+/).filter(Boolean);
  // Un digito DETRAS de una letra ("BT5", "G20", "IPV6", "60FPS") es de un token
  // tecnico legitimo: al desplazar ids solo salen digitos al EMPEZAR palabra
  // (una mayuscula inicial desplazada), nunca despues de una letra.
  if (originalWords.some((w) => /[A-Za-z]\d/.test(w) || /\d\d/.test(w))) return false;
  if (pairPlausibility(originalWords) >= 0.8) return false;

  // Texto corto (<= 3 palabras o <= 12 caracteres): sin contexto es demasiado
  // ambiguo (tallas "S M L XL", unidades "MB GB TB", numeros romanos...).
  // Solo cuenta si ademas trae la huella del desplazamiento: una mayuscula
  // inicial desplazada se vuelve digito o signo PEGADO a letras ("6XEWLWXOR").
  // Pegado a 5 o mas letras: un token tecnico con digito inicial ("5GHZ", "1TB",
  // "3DPRINT") no llega, una palabra desplazada de 6+ letras si.
  const isShort = originalWords.length <= 3 || compact.length <= 12;
  if (
    isShort &&
    !originalWords.some(
      (w) => /^[\x24-\x3d][A-Za-z]{5,}/.test(w) || /[A-Za-z][[\\\]][A-Za-z]/.test(w),
    )
  ) {
    return false;
  }

  for (const shift of GLYPH_ID_SHIFTS) {
    let valid = 0;
    let out = "";
    for (const ch of text) {
      const c = ch.codePointAt(0) ?? 0;
      if (c > 32 && c < 127) {
        const m = c + shift;
        if (m > 32 && m < 127) {
          valid += 1;
          out += String.fromCharCode(m);
        } else out += "\u0001";
      } else out += " ";
    }
    const printable = [...text].filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c > 32 && c < 127;
    }).length;
    if (printable === 0 || valid / printable < 0.95) continue;
    const words = out.split(/[\s\u0001]+/).filter(Boolean);
    const outLetters = out.match(/[A-Za-z]/g) ?? [];
    if (outLetters.length < 0.97 * valid) continue;
    const outLower = outLetters.filter((l) => l >= "a" && l <= "z").length;
    if (outLower / outLetters.length < 0.6) continue;
    const outVowels = outLetters.filter((l) => /[aeiouAEIOU]/.test(l)).length;
    const ratio = outVowels / outLetters.length;
    if (ratio < 0.25 || ratio > 0.65) continue;
    if (words.some((w) => w.length >= 4 && !/[aeiouAEIOU]/.test(w))) continue;
    if (pairPlausibility(words) < 0.85) continue;
    // Texto largo (4+ palabras): el desplazado tiene que contener alguna palabra
    // gramatical corriente (de, the, and...). Frases de siglas y codigos, que
    // por azar "suenan", casi nunca las tienen.
    if (words.length >= 4 && !words.some((w) => FUNCTION_WORDS.has(w.toLowerCase()))) continue;
    return true;
  }
  return false;
}

/* Tipos internos ---------------------------------------------------- */

type Prep = {
  str: string;
  /** Posicion en el marco girado del grupo. */
  u: number;
  v: number;
  endU: number;
  size: number;
  ascent: number;
  descent: number;
  color: string;
  font: SourceFontInfo;
  vertical: boolean;
  runId?: number;
  mixed: boolean;
  identity: boolean;
  /** pdf.js lo entrego con un espacio entre cada letra (Tc): el texto va "tracking". */
  letterSpaced: boolean;
  cutPoints?: Array<{ along: number; leftEndAlong: number; index: number }>;
  script?: "superscript" | "subscript";
  /** Indice del fragmento "base" al que se pega el indice. */
  base?: Prep;
};

type Segment = {
  items: Prep[];
  text: string;
  u0: number;
  u1: number;
  v: number;
  size: number;
  ascent: number;
  descent: number;
  color: string;
  font: SourceFontInfo;
  fontId: string;
  chars: number;
  /** Cuantos tramos comparten su linea (para detectar tablas). */
  rowCount: number;
  /**
   * Junto a un superindice/subindice: el tramo no se funde en parrafo para
   * que la caja del parrafo nunca cubra (y borre al editar) el indice.
   */
  cut: boolean;
  /** Lleva una vineta (vectorial a la izquierda o marca suelta): abre un parrafo nuevo. */
  bullet: boolean;
  /** Mezcla colores/fuentes dentro del tramo. */
  mixed: boolean;
  /** Todos sus fragmentos vienen de fuentes sin mapa Unicode comprobable. */
  identity: boolean;
  script?: "superscript" | "subscript";
};

type Paragraph = {
  lines: Segment[];
  last: Segment;
  /** Interlineado (distancia v entre lineas) medio, null con una sola linea. */
  leading: number | null;
  maxWidth: number;
  /** Borde derecho mas lejano de sus lineas (ancho de columna local). */
  maxRight: number;
  leftAligned: boolean;
  /** Elemento de lista con sangria colgante: la 1a linea lleva el marcador y las demas empiezan tras el. */
  hanging: boolean;
};

/* Paso 1-2: limpieza y reparto por rotacion ------------------------- */

function usable(item: RawTextItem): boolean {
  return (
    item.str.trim().length > 0 &&
    Number.isFinite(item.x) &&
    Number.isFinite(item.y) &&
    Number.isFinite(item.rotation) &&
    Number.isFinite(item.fontSize) &&
    item.fontSize > 0.01 &&
    item.fontSize < 5000
  );
}

type RotationGroup = { angle: number; items: RawTextItem[] };

function splitByRotation(items: RawTextItem[]): RotationGroup[] {
  const groups: RotationGroup[] = [];
  for (const item of items) {
    const angle = normalizeRotation(item.rotation);
    let target = groups.find(
      (group) => angleDiff(group.angle, angle) <= ROTATION_TOLERANCE_DEG,
    );
    if (!target) {
      target = { angle, items: [] };
      groups.push(target);
    }
    target.items.push(item);
  }
  return groups;
}

function prepare(items: RawTextItem[], angle: number): Prep[] {
  const cos = Math.cos(angle * DEG);
  const sin = Math.sin(angle * DEG);
  const kept = new Map<string, Array<{ u: number; v: number; size: number }>>();
  const out: Prep[] = [];
  for (const item of items) {
    const normalized = item.str.replace(/\u00a0/g, " ");
    const str = collapseLetterSpacing(normalized);
    const letterSpaced = str !== normalized;
    const size = item.fontSize;
    const width =
      Number.isFinite(item.width) && item.width >= 0
        ? item.width
        : str.length * size * 0.5;
    const u = item.x * cos + item.y * sin;
    const v = -item.x * sin + item.y * cos;
    // Duplicado (negrita falsa): mismo texto y tamano con un desfase minimo respecto de una pasada ANTERIOR, la
    // conservada o una ya descartada. Se anota la posicion de TODAS las pasadas (tambien las descartadas): una negrita
    // de 3-4 pasadas a 0,3 pt cada una (cuerpo 15) tiene la 3.ª a 0,6 pt de la 1.ª (> 0,45) pero a 0,3 de la 2.ª; si
    // solo se comparara con la conservada, la 3.ª sobreviviria como un texto aparte y el bloque saldria duplicado
    // («Hola mundoHola mundo»: el editor lo mostraba doble y el perfil de glifos no cuadraba con las 3 pasadas del
    // flujo, asi que el texto original no se quitaba). Cada pasada se encadena con la anterior.
    const same = kept.get(str);
    const duplicate = same?.some(
      (d) =>
        Math.abs(d.u - u) <= DUPLICATE_OFFSET_EM * size &&
        Math.abs(d.v - v) <= DUPLICATE_OFFSET_EM * size &&
        Math.abs(d.size - size) <= 0.01 * size,
    );
    if (same) same.push({ u, v, size });
    else kept.set(str, [{ u, v, size }]);
    if (duplicate) continue;
    let ascent = Number.isFinite(item.ascent) ? item.ascent : 0.8;
    let descent = Number.isFinite(item.descent) ? item.descent : -0.2;
    if (ascent <= 0.05) ascent = 0.8;
    descent = -Math.abs(descent);
    if (descent > -0.05) descent = -0.2;
    ascent = Math.min(ascent, 1.3);
    descent = Math.max(descent, -0.5);
    out.push({
      str,
      u,
      v,
      endU: u + width,
      size,
      ascent,
      descent,
      color: item.color,
      font: item.font,
      vertical: item.vertical,
      runId: item.runId,
      mixed: item.mixed === true,
      identity: item.identityEncoding === true,
      letterSpaced,
      cutPoints: item.cutPoints,
    });
  }
  return out;
}

/* Paso 3: superindices / subindices --------------------------------- */

function detectScripts(items: Prep[]): void {
  if (items.length < 2 || items.length > 30000) return;
  const byV = [...items].sort((a, b) => a.v - b.v);
  let maxSize = 0;
  for (const item of items) maxSize = Math.max(maxSize, item.size);

  for (let p = 0; p < byV.length; p += 1) {
    const small = byV[p];
    const window = Math.min(0.9 * maxSize, 4 * small.size);
    const consider = (big: Prep): boolean => {
      if (big === small) return false;
      const ratio = small.size / big.size;
      if (ratio >= SCRIPT_MAX_RATIO || ratio < SCRIPT_MIN_RATIO) return false;
      const dv = (small.v - big.v) / big.size;
      const isSuper = dv >= 0.2 && dv <= 0.9;
      const isSub = dv <= -0.12 && dv >= -0.5;
      if (!isSuper && !isSub) return false;
      // Adyacencia horizontal: pegado (o solapado) al fragmento mayor.
      const gap =
        small.u >= big.endU
          ? small.u - big.endU
          : big.u >= small.endU
            ? big.u - small.endU
            : 0;
      if (gap > 0.4 * big.size) return false;
      small.script = isSuper ? "superscript" : "subscript";
      small.base = big;
      return true;
    };
    let scanned = 0;
    for (let q = p - 1; q >= 0 && scanned < MAX_NEIGHBOURS; q -= 1, scanned += 1) {
      if (small.v - byV[q].v > window) break;
      if (byV[q].script) continue;
      if (consider(byV[q])) break;
    }
    if (small.script) continue;
    scanned = 0;
    for (
      let q = p + 1;
      q < byV.length && scanned < MAX_NEIGHBOURS;
      q += 1, scanned += 1
    ) {
      if (byV[q].v - small.v > window) break;
      if (byV[q].script) continue;
      if (consider(byV[q])) break;
    }
  }
}

/* Paso 4-5: lineas y tramos ----------------------------------------- */

type Line = { v: number; size: number; items: Prep[] };

function buildLines(items: Prep[]): Line[] {
  const sorted = [...items].sort((a, b) => b.v - a.v || a.u - b.u);
  const lines: Line[] = [];
  let active: Line[] = [];
  for (const item of sorted) {
    // Las lineas por encima de la tolerancia ya no pueden recibir mas.
    active = active.filter(
      (line) => line.v - item.v <= BASELINE_TOLERANCE * Math.max(line.size, item.size),
    );
    let best: Line | null = null;
    let bestDelta = Infinity;
    for (const line of active) {
      if (Math.abs(item.size - line.size) / line.size > SIZE_TOLERANCE) continue;
      const delta = Math.abs(line.v - item.v);
      if (delta <= BASELINE_TOLERANCE * line.size && delta < bestDelta) {
        best = line;
        bestDelta = delta;
      }
    }
    if (best) {
      best.items.push(item);
    } else {
      const line = { v: item.v, size: item.size, items: [item] };
      lines.push(line);
      active.push(line);
    }
  }
  return lines;
}

function dominant<T>(entries: Array<{ key: string; weight: number; value: T }>): T {
  const totals = new Map<string, { weight: number; value: T }>();
  for (const entry of entries) {
    const found = totals.get(entry.key);
    if (found) found.weight += entry.weight;
    else totals.set(entry.key, { weight: entry.weight, value: entry.value });
  }
  let best: { weight: number; value: T } | null = null;
  for (const total of totals.values()) {
    if (!best || total.weight > best.weight) best = total;
  }
  return (best as { weight: number; value: T }).value;
}

function makeSegment(items: Prep[], rowCount: number, cut = false): Segment {
  const sorted = [...items].sort((a, b) => a.u - b.u);
  let text = "";
  let prev: Prep | null = null;
  for (const item of sorted) {
    if (prev) {
      const gap = item.u - prev.endU;
      const glued = /\s$/.test(prev.str) || /^\s/.test(item.str);
      if (!glued && gap > WORD_GAP_EM * Math.min(prev.size, item.size)) text += " ";
    }
    text += item.str;
    prev = item;
  }
  const size = sorted.reduce((s, it) => s + it.size * it.str.length, 0) /
    sorted.reduce((s, it) => s + it.str.length, 0);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const u0 = first.u + lead * SPACE_EM * size;
  const u1 = Math.max(u0, last.endU - trail * SPACE_EM * size);
  const colorEntry = dominant(
    sorted.map((it) => ({ key: it.color, weight: it.str.length, value: it.color })),
  );
  const font = dominant(
    sorted.map((it) => ({
      key: fontIdentity(it.font),
      weight: it.str.length,
      value: it.font,
    })),
  );
  const ys = [...sorted.map((it) => it.v)].sort((a, b) => a - b);
  return {
    items: sorted,
    text: text.trim(),
    u0,
    u1,
    v: ys[Math.floor(ys.length / 2)],
    size,
    ascent: Math.max(...sorted.map((it) => it.ascent)),
    descent: Math.min(...sorted.map((it) => it.descent)),
    color: colorEntry,
    font,
    fontId: fontIdentity(font),
    chars: text.trim().length,
    rowCount,
    cut,
    bullet: false,
    identity: sorted.every((it) => it.identity),
    mixed:
      sorted.some((it) => it.mixed) ||
      sorted.some(
        (it) =>
          it.color !== sorted[0].color ||
          fontIdentity(it.font) !== fontIdentity(sorted[0].font),
      ),
    script: sorted.every((it) => it.script === sorted[0].script)
      ? sorted[0].script
      : undefined,
  };
}

function splitLineIntoSegments(
  line: Line,
  cuts: Prep[],
  bases: ReadonlySet<Prep>,
  gutters?: GutterIndex,
  rules?: RuleIndex,
): Segment[] {
  const sorted = [...line.items].sort((a, b) => a.u - b.u);

  // Primera pasada: huecos que superan el umbral (que depende de si los
  // fragmentos son de la misma instruccion o van con espaciado entre letras).
  const isBig = (prev: Prep, item: Prep): boolean => {
    // Una regla vertical entre ambos que cruza la linea (borde de celda) los separa.
    if (
      rules &&
      rules.verticalsIn(prev.endU - 0.3, item.u + 0.3, line.v, Math.max(prev.size, item.size)).length > 0
    ) {
      return true;
    }
    const gap = item.u - prev.endU;
    const sameRun = prev.runId !== undefined && prev.runId === item.runId;
    const tracking = prev.letterSpaced || item.letterSpaced ? 2 : 1;
    const em = sameRun ? SAME_RUN_GAP_EM : SEGMENT_GAP_EM * tracking;
    if (gap > em * Math.max(prev.size, item.size)) return true;
    // Canalillo de tabla (relleno de celdas pequeno): no aplica al texto de la
    // misma instruccion, con espaciado entre letras ni en fuentes monoespaciadas
    // (donde TODOS los huecos son iguales y caen en una rejilla).
    return (
      !sameRun &&
      !prev.letterSpaced &&
      !item.letterSpaced &&
      prev.font.family !== "mono" &&
      item.font.family !== "mono" &&
      gutters !== undefined &&
      gap >= GUTTER_MIN_EM * Math.max(prev.size, item.size) &&
      gutters.isGutter(item.u, gap, line)
    );
  };
  const bigGaps: number[] = [];
  let allBig = sorted.length > 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (isBig(sorted[i - 1], sorted[i])) bigGaps.push(sorted[i].u - sorted[i - 1].endU);
    else allBig = false;
  }
  // Texto con espaciado de palabras (`Tw`, "word-spacing"): TODOS los huecos
  // de la linea son grandes y casi iguales. Una fila de tabla no se parece:
  // sus huecos dependen del ancho de cada celda.
  let uniformGaps = false;
  if (allBig && bigGaps.length >= 3) {
    const mean = bigGaps.reduce((a, b) => a + b, 0) / bigGaps.length;
    const spread = Math.max(...bigGaps) - Math.min(...bigGaps);
    uniformGaps = spread <= 0.2 * mean + 1 && mean <= 2.5 * line.size;
  }

  const groups: Prep[][] = [];
  let current: Prep[] = [];
  let scriptCut = false;
  for (const item of sorted) {
    const prev = current[current.length - 1];
    if (prev) {
      let split = !uniformGaps && isBig(prev, item);
      if (!split && cuts.length > 0) {
        // Un indice entre ambos fragmentos: corte duro.
        split = cuts.some(
          (cut) =>
            Math.abs(cut.v - line.v) <= 1.0 * line.size &&
            cut.u >= prev.u &&
            cut.u < item.u + 0.01 &&
            cut.endU > prev.endU - 0.01 &&
            cut.endU <= item.endU + 0.01,
        );
        if (split) scriptCut = true;
      }
      if (split) {
        groups.push(current);
        current = [];
      }
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group) =>
    makeSegment(
      group,
      groups.length,
      scriptCut || group.some((item) => bases.has(item)),
    ),
  );
}

/* Reglas vectoriales ------------------------------------------------- */

type VRule = { u: number; v0: number; v1: number; t: number };
type HRule = { v: number; u0: number; u1: number; t: number };

type RuleIndex = {
  /** Reglas verticales con el centro en [a, b] que cruzan la banda de texto de la linea. */
  verticalsIn: (a: number, b: number, v: number, size: number) => VRule[];
  /** Hay una regla horizontal larga entre las dos lineas (por debajo de `prev`, por encima de `seg`). */
  horizontalBetween: (prev: Segment, seg: Segment) => boolean;
};

/** Indice de reglas en el marco girado del grupo: busqueda binaria, O(n log n). */
function buildRuleIndex(rules: readonly RuleLine[], angle: number): RuleIndex | undefined {
  if (rules.length === 0) return undefined;
  const cos = Math.cos(angle * DEG);
  const sin = Math.sin(angle * DEG);
  const verticals: VRule[] = [];
  const horizontals: HRule[] = [];
  for (const rule of rules) {
    const ua = rule.x0 * cos + rule.y0 * sin;
    const va = -rule.x0 * sin + rule.y0 * cos;
    const ub = rule.x1 * cos + rule.y1 * sin;
    const vb = -rule.x1 * sin + rule.y1 * cos;
    if (![ua, va, ub, vb].every(Number.isFinite)) continue;
    if (Math.abs(ua - ub) <= 0.6 && Math.abs(vb - va) >= 4) {
      verticals.push({ u: (ua + ub) / 2, v0: Math.min(va, vb), v1: Math.max(va, vb), t: rule.thickness });
    } else if (Math.abs(va - vb) <= 0.6 && Math.abs(ub - ua) >= 4) {
      horizontals.push({ v: (va + vb) / 2, u0: Math.min(ua, ub), u1: Math.max(ua, ub), t: rule.thickness });
    }
  }
  verticals.sort((a, b) => a.u - b.u);
  horizontals.sort((a, b) => a.v - b.v);
  const lowerBound = <T,>(list: T[], key: (item: T) => number, value: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (key(list[mid]) < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    verticalsIn: (a, b, v, size) => {
      const out: VRule[] = [];
      for (let i = lowerBound(verticals, (r) => r.u, a); i < verticals.length && verticals[i].u <= b; i += 1) {
        const r = verticals[i];
        // Cruza la altura de las letras y es larga (>= 1 tamano de letra): borde de celda.
        if (r.v1 - r.v0 >= 1.0 * size && r.v0 <= v + 0.1 * size && r.v1 >= v + 0.6 * size) out.push(r);
      }
      return out;
    },
    horizontalBetween: (prev, seg) => {
      const below = prev.v + prev.descent * prev.size - 0.2;
      const above = seg.v + seg.ascent * seg.size + 0.2;
      if (above >= below) return false;
      const left = Math.min(prev.u0, seg.u0);
      const right = Math.max(prev.u1, seg.u1);
      const minWidth = Math.min(prev.u1 - prev.u0, seg.u1 - seg.u0);
      const size = Math.max(prev.size, seg.size);
      for (let i = lowerBound(horizontals, (r) => r.v, above); i < horizontals.length && horizontals[i].v <= below; i += 1) {
        const r = horizontals[i];
        const overlap = Math.min(r.u1, right) - Math.max(r.u0, left);
        if (r.u1 - r.u0 >= 1.2 * size && overlap >= 0.5 * minWidth) return true;
      }
      return false;
    },
  };
}

/** Anchura relativa de cada caracter (fraccion de em) para repartir un fragmento. */
function charWeight(ch: string): number {
  if (/\s/.test(ch)) return 0.28;
  if (/[iljtf.,;:'|!]/.test(ch)) return 0.27;
  if (/[mwMW@]/.test(ch)) return 0.85;
  if (/[A-Z]/.test(ch)) return 0.67;
  if (/\d/.test(ch)) return 0.556;
  return 0.5;
}

/**
 * pdf.js funde en UN fragmento el texto de celdas contiguas ("Servicio uno 2").
 * Si una regla vertical atraviesa el interior de un fragmento, se parte por el
 * espacio mas cercano a la regla (posicion estimada por el ancho de cada
 * caracter). Las partes se ajustan para no tocar la regla; sin un espacio a
 * menos de 0.9 em de la regla (texto sobre una linea) no se parte.
 */
function splitItemsAtRules(items: Prep[], index: RuleIndex | undefined): Prep[] {
  if (!index) return items;
  const out: Prep[] = [];
  for (const item of items) {
    const crossing = index
      .verticalsIn(item.u + 1, item.endU - 1, item.v, item.size)
      .filter((r) => r.u > item.u + 1 + r.t / 2 && r.u < item.endU - 1 - r.t / 2);
    if (crossing.length === 0) {
      out.push(item);
      continue;
    }
    const chars = [...item.str];
    const width = item.endU - item.u;
    const weights = chars.map(charWeight);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const pos: number[] = [0];
    weights.forEach((w, i) => pos.push(pos[i] + (w / total) * width));

    type Cut = { leftIdx: number; rightIdx: number; leftEnd: number; rightStart: number };
    const cuts: Cut[] = [];
    for (const rule of crossing) {
      const clampLeft = rule.u - rule.t / 2 - 0.2;
      const clampRight = rule.u + rule.t / 2 + 0.2;
      // 1) Una instruccion de texto empieza junto a la regla: corte exacto.
      let best: Cut | null = null;
      let bestD = rule.t / 2 + 1.5;
      for (const cp of item.cutPoints ?? []) {
        if (cp.index <= 0 || cp.index >= chars.length) continue;
        const d = Math.abs(item.u + cp.along - rule.u);
        if (d > bestD) continue;
        // pdf.js puede haber metido un espacio entre ambas instrucciones.
        const rightIdx = /\s/.test(chars[cp.index]) ? cp.index + 1 : cp.index;
        best = {
          leftIdx: cp.index,
          rightIdx,
          leftEnd: Math.min(item.u + cp.leftEndAlong, clampLeft),
          rightStart: Math.max(item.u + cp.along, clampRight),
        };
        bestD = d;
      }
      // 2) Sin instrucciones: el espacio mas cercano a la regla (anchos estimados).
      if (!best) {
        let bestSpace: { a: number; b: number; d: number } | null = null;
        for (let i = 0; i < chars.length; i += 1) {
          if (!/\s/.test(chars[i])) continue;
          let k = i;
          while (k < chars.length && /\s/.test(chars[k])) k += 1;
          const d = Math.abs(item.u + (pos[i] + pos[k]) / 2 - rule.u);
          if (!bestSpace || d < bestSpace.d) bestSpace = { a: i, b: k, d };
          i = k - 1;
        }
        if (bestSpace && bestSpace.d <= 0.9 * item.size) {
          best = {
            leftIdx: bestSpace.a,
            rightIdx: bestSpace.b,
            leftEnd: Math.min(item.u + pos[bestSpace.a], clampLeft),
            rightStart: Math.max(item.u + pos[bestSpace.b], clampRight),
          };
        }
      }
      if (best && best.leftIdx > 0 && best.rightIdx < chars.length) cuts.push(best);
    }
    cuts.sort((a, b) => a.leftIdx - b.leftIdx);
    // Descarta cortes solapados o que dejan una parte sin texto o sin anchura.
    const kept: Cut[] = [];
    let lastIdx = 0;
    let lastU = item.u;
    for (const cut of cuts) {
      const text = chars.slice(lastIdx, cut.leftIdx).join("").trim();
      if (text.length === 0 || cut.leftEnd <= lastU || cut.rightStart >= item.endU) continue;
      kept.push(cut);
      lastIdx = cut.rightIdx;
      lastU = cut.rightStart;
    }
    if (kept.length === 0) {
      out.push(item);
      continue;
    }
    let startIdx = 0;
    let startU = item.u;
    for (const cut of kept) {
      out.push({ ...item, str: chars.slice(startIdx, cut.leftIdx).join("").trimEnd(), u: startU, endU: cut.leftEnd, cutPoints: undefined });
      startIdx = cut.rightIdx;
      startU = cut.rightStart;
    }
    const tail = chars.slice(startIdx).join("").trimStart();
    if (tail.length > 0) out.push({ ...item, str: tail, u: startU, endU: item.endU, cutPoints: undefined });
  }
  return out;
}

/* Canalillos de tabla ------------------------------------------------ */

type GutterIndex = { isGutter: (u: number, gap: number, line: Line) => boolean };

/**
 * Indice de "columnas conocidas" para huecos entre una palabra y el 0.7 em que
 * parte la linea (tablas con celdas de poco relleno, columnas con calle
 * estrecha). Un fragmento que empieza tras un hueco >= 0.4 em es inicio de
 * columna si:
 *  - su x coincide (a 0.6 pt) con el INICIO de linea de 2 o mas OTRAS lineas
 *    (el margen izquierdo de una celda/columna; en texto corrido ninguna
 *    palabra a mitad de linea cae sobre el margen izquierdo de otras lineas), o
 *  - el mismo par (x de inicio, ancho del hueco) se repite en 2 o mas otras
 *    lineas (relleno fijo de celdas con el texto anterior de ancho constante).
 * Trade-off con el espaciado entre letras (D6): esas lineas ya van aparte
 * (`letterSpaced` y mismas instrucciones nunca se consultan aqui).
 */
function buildGutterIndex(lines: Line[]): GutterIndex {
  const starts = new Map<number, Set<Line>>();
  const pairs = new Map<string, Set<Line>>();
  const add = <K,>(map: Map<K, Set<Line>>, k: K, line: Line) => {
    const set = map.get(k);
    if (set) set.add(line);
    else map.set(k, new Set([line]));
  };
  for (const line of lines) {
    const sorted = [...line.items].sort((a, b) => a.u - b.u);
    add(starts, Math.round(sorted[0].u / 0.6), line);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i].u - sorted[i - 1].endU;
      if (gap < GUTTER_MIN_EM * Math.max(sorted[i].size, sorted[i - 1].size)) continue;
      add(pairs, `${Math.round(sorted[i].u / 0.6)}|${Math.round(gap / 0.6)}`, line);
    }
  }
  const countOthers = (sets: Iterable<Set<Line> | undefined>, line: Line): number => {
    const seen = new Set<Line>();
    for (const set of sets) {
      if (!set) continue;
      for (const other of set) if (other !== line) seen.add(other);
    }
    return seen.size;
  };
  return {
    isGutter: (u, gap, line) => {
      const bu = Math.round(u / 0.6);
      const bg = Math.round(gap / 0.6);
      if (countOthers([-1, 0, 1].map((d) => starts.get(bu + d)), line) >= 2) return true;
      const near: Array<Set<Line> | undefined> = [];
      for (const du of [-1, 0, 1]) for (const dg of [-1, 0, 1]) near.push(pairs.get(`${bu + du}|${bg + dg}`));
      return countOthers(near, line) >= 2;
    },
  };
}

/* Vinetas ------------------------------------------------------------ */

/** Marca de lista sola en su tramo: "•", "-", "1.", "a)"... */
const MARKER_ONLY = /^(?:[\u2022\u00b7\u25aa\u25e6\u2023\u2043\u25cf\u25cb\u25a0\u25a1\u2013\u2014*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])$/;

/**
 * Una vineta o numero suelto seguido, en su misma linea, del texto del
 * elemento (Word: marca + tabulador + texto) no es un bloque editable: se
 * descarta y el tramo siguiente pasa a abrir parrafo (`bullet`). DECISION: la
 * marca NO entra en el texto ni en la caja del bloque, asi que se queda
 * intacta en la pagina (la caja que se cubre al editar empieza en el texto).
 */
function absorbMarkerSegments(lineSegments: Segment[]): Segment[] {
  if (lineSegments.length < 2) return lineSegments;
  const out: Segment[] = [];
  for (let i = 0; i < lineSegments.length; i += 1) {
    const seg = lineSegments[i];
    const next = lineSegments[i + 1];
    if (
      next &&
      !seg.script &&
      MARKER_ONLY.test(seg.text) &&
      next.u0 - seg.u1 <= 4 * seg.size &&
      next.u0 >= seg.u1 &&
      !MARKER_ONLY.test(next.text)
    ) {
      next.bullet = true;
      continue;
    }
    out.push(seg);
  }
  for (const seg of out) seg.rowCount = out.length;
  return out;
}

/**
 * Vinetas dibujadas como vector (Chromium `<ul>`, pdfkit `list()`): una forma
 * pequena, rellena y casi cuadrada justo a la izquierda del inicio de una
 * linea y a la altura de sus letras marca el tramo como elemento de lista.
 */
function flagVectorBullets(
  segments: Segment[],
  angle: number,
  markers: readonly MarkerShape[] | undefined,
): void {
  if (!markers || markers.length === 0 || markers.length > 3000) return;
  const cos = Math.cos(angle * DEG);
  const sin = Math.sin(angle * DEG);
  const shapes = markers.map((m) => {
    const cx = m.x + m.width / 2;
    const cy = m.y + m.height / 2;
    return {
      cu: cx * cos + cy * sin,
      cv: -cx * sin + cy * cos,
      w: m.width,
      h: m.height,
    };
  });
  for (const seg of segments) {
    if (seg.script || seg.bullet) continue;
    for (const m of shapes) {
      const big = Math.max(m.w, m.h);
      if (big > 0.9 * seg.size || big < 0.12 * seg.size) continue;
      if (Math.abs(m.w - m.h) > 0.4 * big) continue;
      const gap = seg.u0 - (m.cu + big / 2);
      if (gap < 0.05 * seg.size || gap > 3.5 * seg.size) continue;
      if (m.cv < seg.v - 0.1 * seg.size || m.cv > seg.v + 0.8 * seg.size) continue;
      seg.bullet = true;
      break;
    }
  }
}

/* Paso 6: parrafos --------------------------------------------------- */

const LIST_MARKER = /^(?:[•·▪◦‣⁃●○■□–—*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s/;

function sameSize(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(a, b) <= SIZE_TOLERANCE;
}

type Match = { score: number; leftAligned: boolean; hanging: boolean } | null;

/** Contexto de pagina que comparten todas las decisiones de `matchParagraph`. */
type MatchContext = {
  sorted: readonly Segment[];
  order: ReadonlyMap<Segment, number>;
  /** Interlineados anchos (en tamanos) ya confirmados por parrafos de 3+ lineas. */
  wideRatios: number[];
  rules?: RuleIndex;
};

function matchParagraph(para: Paragraph, seg: Segment, ctx: MatchContext): Match {
  const prev = para.last;
  if (!sameSize(prev.size, seg.size)) return null;
  if (prev.fontId !== seg.fontId || prev.color !== seg.color) return null;
  if (prev.script || seg.script) return null;
  if (prev.cut || seg.cut) return null;
  if (prev.font.type3 !== seg.font.type3) return null;

  if (seg.bullet) return null;
  // Una regla horizontal larga entre las dos lineas (filete, borde de fila) corta el parrafo.
  if (ctx.rules?.horizontalBetween(prev, seg)) return null;

  const size = (prev.size + seg.size) / 2;
  const dv = prev.v - seg.v;
  if (dv < LEADING_MIN * size || dv > LEADING_ABS_MAX * size) return null;
  if (para.leading !== null) {
    const tolerance = 0.25 * para.leading + 0.1 * size;
    if (Math.abs(dv - para.leading) > tolerance) return null;
  }

  // Tablas: tramos estrechos con vecinos en su misma linea no se funden.
  // Con un parrafo ya establecido (2+ lineas) se mira su ancho, no el de la
  // linea nueva: la ultima linea de una columna es corta y sigue siendo texto
  // corrido. En el primer par cuentan las dos: una celda ancha y una estrecha
  // apiladas en una tabla son celdas distintas.
  if (prev.rowCount > 1 || seg.rowCount > 1) {
    const established = para.lines.length >= 2;
    const narrow = established
      ? para.maxWidth < 8 * size
      : prev.u1 - prev.u0 < 8 * size || seg.u1 - seg.u0 < 8 * size;
    if (narrow) return null;
  }
  if (LIST_MARKER.test(seg.text)) return null;

  const tol = MARGIN_TOLERANCE_EM * size;
  const overlap = Math.min(prev.u1, seg.u1) - Math.max(prev.u0, seg.u0);
  if (overlap <= 0) return null;

  const leftDiff = Math.abs(seg.u0 - prev.u0);
  const rightDiff = Math.abs(seg.u1 - prev.u1);
  const centerDiff = Math.abs((seg.u0 + seg.u1) / 2 - (prev.u0 + prev.u1) / 2);
  const indent = para.lines.length === 1 ? prev.u0 - seg.u0 : -1;

  // Elemento de lista con sangria colgante ("1. Texto" y las lineas siguientes
  // empiezan tras el marcador): la continuacion queda a la DERECHA del inicio.
  const hangingGap = seg.u0 - prev.u0;
  const hanging =
    para.lines.length === 1 &&
    LIST_MARKER.test(prev.text) &&
    hangingGap >= 0.8 * size &&
    hangingGap <= 4 * size;

  let leftAligned = false;
  let alignError: number;
  if (leftDiff <= tol) {
    leftAligned = true;
    alignError = leftDiff;
  } else if (indent > 0 && indent <= 3 * size) {
    // Sangria de primera linea: la 2a empieza mas a la izquierda.
    leftAligned = true;
    alignError = tol;
  } else if (hanging) {
    leftAligned = true;
    alignError = tol;
  } else if (rightDiff <= tol) {
    alignError = rightDiff;
  } else if (centerDiff <= tol) {
    alignError = centerDiff;
  } else {
    return null;
  }

  // El texto envuelve en el borde derecho de la columna (el de su propia
  // linea mas larga): si la primera palabra de la linea siguiente CABIA en el
  // hueco que dejo la anterior, el parrafo acabo ahi. Asi la ultima linea
  // corta (o una penultima corta por una palabra larga) se trata bien, y las
  // listas de elementos cortos no se funden.
  if (leftAligned) {
    const columnRight = Math.max(para.maxRight, seg.u1);
    const remainder = columnRight - prev.u1;
    const charWidth = (seg.u1 - seg.u0) / Math.max(1, seg.chars);
    const firstWord = (seg.text.split(/\s+/)[0] ?? "").length * charWidth;
    const fits = remainder > 1.15 * firstWord + SPACE_EM * size;
    if (fits) return null;
    // Interlineado ancho en el primer par (doble espacio, lineGap, o parrafos
    // de UNA linea separados por margen): hace falta una prueba fuerte de que
    // es texto corrido y no lineas sueltas.
    if (para.leading === null && dv > LEADING_MAX * size) {
      if (!wideLeadingConfirmed(prev, seg, dv, size, remainder, columnRight, ctx)) {
        return null;
      }
    }
  } else if (para.leading === null && dv > LEADING_MAX * size) {
    return null;
  }

  return {
    score: Math.abs(dv - (para.leading ?? 1.2 * size)) + alignError,
    leftAligned,
    hanging,
  };
}

/** Palabras de un tramo -> ancho de su primera palabra (estimado). */
function firstWordWidth(seg: Segment): number {
  const charWidth = (seg.u1 - seg.u0) / Math.max(1, seg.chars);
  return (seg.text.split(/\s+/)[0] ?? "").length * charWidth;
}

/** Cota por encima de la cual no se hace la comprobacion global (modo rapido). */
const MAX_SEGMENTS_WIDE_CHECK = 6000;

/**
 * Primer par con interlineado ancho (> LEADING_MAX x tamano). Lo normal en
 * esa distancia son parrafos de una linea separados por un margen, asi que
 * solo se une cuando TODO apunta a texto corrido de doble espacio:
 *  1. la linea anterior llena la columna local (su hueco no admite la
 *     primera palabra de la siguiente) y la columna mide >= 8 tamanos;
 *  2. la anterior llega al borde derecho de TODO lo que hay sobre ella
 *     (la linea mas ancha de la pagina que se le solapa);
 *  3. el paso esta confirmado: o coincide (+-8 %) con el de un parrafo
 *     ancho ya confirmado en la pagina, o una TERCERA linea alineada,
 *     a la misma distancia y con la segunda tambien llena, lo continua.
 * Dos lineas sueltas nunca cumplen la 3: se quedan como bloques propios.
 */
function wideLeadingConfirmed(
  prev: Segment,
  seg: Segment,
  dv: number,
  size: number,
  remainder: number,
  columnRight: number,
  ctx: MatchContext,
): boolean {
  if (remainder > 0.3 * (columnRight - prev.u0) || columnRight - prev.u0 < 8 * size) {
    return false;
  }
  if (ctx.sorted.length > MAX_SEGMENTS_WIDE_CHECK) return false;
  let pageRight = prev.u1;
  for (const other of ctx.sorted) {
    if (other.u1 > prev.u0 && other.u0 < prev.u1) pageRight = Math.max(pageRight, other.u1);
  }
  // Una columna estrecha (< 16 tamanos, ~35 caracteres) no distingue "llena la
  // columna" de "etiqueta corta cuya primera palabra es larga".
  if (pageRight - prev.u0 < 16 * size) return false;
  const fillsPage = (line: Segment, next: Segment) =>
    pageRight - line.u1 <= 1.15 * firstWordWidth(next) + SPACE_EM * size;
  if (!fillsPage(prev, seg)) return false;
  const ratio = dv / size;
  if (ctx.wideRatios.some((r) => Math.abs(r - ratio) <= 0.08 * r)) return true;

  // Tercera linea que continua el paso; si ademas hay una cuarta, la tercera
  // tambien tiene que llenar la columna (lineas sueltas que casualmente
  // rozan el ancho maximo no suelen encadenar tres seguidas).
  const continuation = (from: Segment): Segment | null => {
    const start = ctx.order.get(from) ?? 0;
    for (let i = start + 1; i < ctx.sorted.length; i += 1) {
      const next = ctx.sorted[i];
      const step = from.v - next.v;
      if (step > dv * 1.4 + size) break;
      if (Math.abs(step - dv) > 0.2 * dv + 0.1 * size) continue;
      if (!sameSize(next.size, seg.size) || next.fontId !== seg.fontId) continue;
      if (next.color !== seg.color || next.cut || next.bullet || next.script) continue;
      if (Math.abs(next.u0 - from.u0) > MARGIN_TOLERANCE_EM * size) continue;
      if (obstructed(ctx.sorted, ctx.order, from, next)) continue;
      return next;
    }
    return null;
  };
  const third = continuation(seg);
  if (!third || !fillsPage(seg, third)) return false;
  const fourth = continuation(third);
  return fourth ? fillsPage(third, fourth) : true;
}

/** Hay otro tramo, horizontalmente solapado, entre las lineas `from` y `to`. */
function obstructed(
  sorted: readonly Segment[],
  order: ReadonlyMap<Segment, number>,
  from: Segment,
  to: Segment,
): boolean {
  const start = order.get(from) ?? 0;
  const end = order.get(to) ?? 0;
  const size = Math.max(from.size, to.size);
  const left = Math.min(from.u0, to.u0);
  const right = Math.max(from.u1, to.u1);
  for (let i = start + 1; i < end; i += 1) {
    const other = sorted[i];
    if (other === to) continue;
    if (from.v - other.v < 0.3 * size) continue; // misma linea que `from`
    if (other.v - to.v < 0.3 * size) break; // ya llegamos a la linea de `to`
    if (other.u1 > left && other.u0 < right) return true;
  }
  return false;
}

function buildParagraphs(segments: Segment[], rules?: RuleIndex): Paragraph[] {
  // Dos pasadas: la primera descubre los interlineados anchos CONFIRMADOS de la
  // pagina (parrafos de 3+ lineas); la segunda los usa tambien para los
  // parrafos de dos lineas que aparecen antes en la pagina.
  const first = buildParagraphsPass(segments, [], rules);
  if (first.wideRatios.length === 0) return first.paragraphs;
  return buildParagraphsPass(segments, first.wideRatios, rules).paragraphs;
}

function buildParagraphsPass(
  segments: Segment[],
  preset: readonly number[],
  rules?: RuleIndex,
): { paragraphs: Paragraph[]; wideRatios: number[] } {
  const sorted = [...segments].sort((a, b) => b.v - a.v || a.u0 - b.u0);
  const order = new Map<Segment, number>();
  sorted.forEach((seg, i) => order.set(seg, i));
  const ctx: MatchContext = { sorted, order, wideRatios: [...preset], rules };
  const paragraphs: Paragraph[] = [];
  let active: Paragraph[] = [];
  for (const seg of sorted) {
    active = active.filter(
      (para) =>
        para.last.v - seg.v <=
        LEADING_ABS_MAX * Math.max(para.last.size, seg.size) * 1.3,
    );
    let best: { para: Paragraph; match: NonNullable<Match> } | null = null;
    for (const para of active) {
      // Un tramo ajeno entre ambas lineas (p. ej. una linea con indice, que
      // queda suelta) impide saltarselo y fundir las de arriba y abajo.
      if (obstructed(sorted, order, para.last, seg)) continue;
      const match = matchParagraph(para, seg, ctx);
      if (match && (!best || match.score < best.match.score)) {
        best = { para, match };
      }
    }
    if (best) {
      const { para } = best;
      const dv = para.last.v - seg.v;
      if (para.leading === null && dv > LEADING_MAX * ((para.last.size + seg.size) / 2)) {
        ctx.wideRatios.push(dv / ((para.last.size + seg.size) / 2));
      }
      para.leading =
        para.leading === null
          ? dv
          : (para.leading * (para.lines.length - 1) + dv) / para.lines.length;
      if (best.match.hanging) para.hanging = true;
      para.lines.push(seg);
      para.last = seg;
      para.maxWidth = Math.max(para.maxWidth, seg.u1 - seg.u0);
      para.maxRight = Math.max(para.maxRight, seg.u1);
      para.leftAligned = para.leftAligned && best.match.leftAligned;
    } else {
      const para: Paragraph = {
        lines: [seg],
        last: seg,
        leading: null,
        maxWidth: seg.u1 - seg.u0,
        maxRight: seg.u1,
        leftAligned: true,
        hanging: false,
      };
      paragraphs.push(para);
      active.push(para);
    }
  }
  return { paragraphs, wideRatios: ctx.wideRatios };
}

/* Paso 7: construccion de bloques ----------------------------------- */

function joinLines(lines: Segment[]): string {
  let text = "";
  for (const line of lines) {
    if (text.length === 0) {
      text = line.text;
    } else if (/[A-Za-zÀ-ɏ]-$/.test(text) && /^[a-zß-ÿ]/.test(line.text)) {
      // Palabra cortada con guion al final de linea: se une sin espacio.
      text += line.text;
    } else {
      text += ` ${line.text}`;
    }
  }
  return text;
}

function deduceAlign(
  lines: Segment[],
  size: number,
  angle: number,
  pageBox: UserBox | undefined,
  hanging = false,
): TextAlign {
  const tol = 0.5 * size;
  // Elemento de lista con sangria colgante: la 1a linea (marcador) y las
  // demas no comparten margen izquierdo y no por eso es centrado.
  if (hanging) return "left";
  if (lines.length >= 2) {
    // La primera linea puede llevar sangria: se ignora si hay 3 o mas.
    const body = lines.length >= 3 ? lines.slice(1) : lines;
    const range = (values: number[]) => Math.max(...values) - Math.min(...values);
    const lefts = body.map((l) => l.u0);
    const rights = body.map((l) => l.u1);
    const centers = body.map((l) => (l.u0 + l.u1) / 2);
    if (range(lefts) <= tol) return "left";
    if (range(rights) <= tol) return "right";
    if (range(centers) <= tol) return "center";
    return "left";
  }
  // Una sola linea: solo se puede deducir "centrado en la pagina".
  const line = lines[0];
  if (pageBox && angle === 0) {
    const pageCenter = pageBox.x + pageBox.width / 2;
    const center = (line.u0 + line.u1) / 2;
    const leftMargin = line.u0 - pageBox.x;
    const rightMargin = pageBox.x + pageBox.width - line.u1;
    if (
      Math.abs(center - pageCenter) <= 1 &&
      leftMargin > 0.08 * pageBox.width &&
      rightMargin > 0.08 * pageBox.width
    ) {
      return "center";
    }
  }
  return "left";
}

function toUser(u: number, v: number, cos: number, sin: number): { x: number; y: number } {
  return { x: u * cos - v * sin, y: u * sin + v * cos };
}

function aabb(points: Array<{ x: number; y: number }>): UserBox {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

function lineOf(seg: Segment, cos: number, sin: number): TextLine {
  const bottom = seg.v + seg.descent * seg.size;
  const top = seg.v + seg.ascent * seg.size;
  const box = aabb([
    toUser(seg.u0, bottom, cos, sin),
    toUser(seg.u1, bottom, cos, sin),
    toUser(seg.u0, top, cos, sin),
    toUser(seg.u1, top, cos, sin),
  ]);
  const origin = toUser(seg.u0, seg.v, cos, sin);
  return {
    text: seg.text,
    box,
    baseline: origin.y,
    origin,
    length: seg.u1 - seg.u0,
  };
}

function blockOf(
  para: Paragraph,
  angle: number,
  options: GroupOptions,
  hidden: boolean,
): TextBlock {
  const cos = Math.cos(angle * DEG);
  const sin = Math.sin(angle * DEG);
  const lines = para.lines;
  const chars = lines.reduce((s, l) => s + Math.max(1, l.chars), 0);
  const fontSize = lines.reduce((s, l) => s + l.size * Math.max(1, l.chars), 0) / chars;
  const u0 = Math.min(...lines.map((l) => l.u0));
  const u1 = Math.max(...lines.map((l) => l.u1));
  const vBottom = Math.min(...lines.map((l) => l.v + l.descent * l.size));
  const vTop = Math.max(...lines.map((l) => l.v + l.ascent * l.size));
  const corners = [
    toUser(u0, vBottom, cos, sin),
    toUser(u1, vBottom, cos, sin),
    toUser(u0, vTop, cos, sin),
    toUser(u1, vTop, cos, sin),
  ];
  const box = aabb(corners);
  const oriented: OrientedBox = {
    origin: toUser(u0, vBottom, cos, sin),
    width: u1 - u0,
    height: vTop - vBottom,
  };
  const color = dominant(
    lines.map((l) => ({ key: l.color, weight: Math.max(1, l.chars), value: l.color })),
  );
  const font = dominant(
    lines.map((l) => ({ key: l.fontId, weight: Math.max(1, l.chars), value: l.font })),
  );
  const text = joinLines(lines);
  const block: TextBlock = {
    id: "",
    pageIndex: options.pageIndex,
    box: roundBox(box),
    text,
    lines: lines.map((l) => lineOf(l, cos, sin)),
    fontSize: round(fontSize, 3),
    color,
    rotation: angle,
    align: deduceAlign(lines, fontSize, angle, options.pageBox, para.hanging),
    font,
    editable: true,
    origHash: "",
    orientedBox: {
      origin: { x: round(oriented.origin.x, 3), y: round(oriented.origin.y, 3) },
      width: round(oriented.width, 3),
      height: round(oriented.height, 3),
    },
  };
  if (lines.length >= 2 && para.leading !== null) {
    block.lineHeight = round(para.leading / fontSize, 3);
  }
  if (lines[0].script && lines.every((l) => l.script === lines[0].script)) {
    block.script = lines[0].script;
  }
  // Solo aparece cuando hay mezcla: sin mezcla la salida no cambia.
  if (lines.some((l) => l.mixed)) block.mixedStyle = true;
  block.origHash = computeOrigHash(text, block.box);
  applyReadOnly(block, hidden, lines.every((l) => l.identity));
  return block;
}

function roundBox(box: UserBox): UserBox {
  return {
    x: round(box.x, 3),
    y: round(box.y, 3),
    width: round(box.width, 3),
    height: round(box.height, 3),
  };
}

/**
 * Decide si el bloque se puede editar. Prioridad cuando coinciden varios
 * motivos: invisible > type3 > vertical > no-unicode > symbolic.
 */
function applyReadOnly(block: TextBlock, hidden: boolean, unmapped: boolean): void {
  let reason: TextBlock["readOnlyReason"];
  if (hidden) reason = "invisible";
  else if (block.font.type3) reason = "type3";
  else if (
    unreadableRatio(block.text) >= NO_UNICODE_RATIO ||
    controlCharRatio(block.text) >= CONTROL_CHAR_RATIO
  ) {
    reason = "no-unicode";
  }
  else if (unmapped && block.font.subset && looksLikeShiftedGlyphIds(block.text)) {
    reason = "no-unicode";
  }
  else if (block.font.symbolic) reason = "symbolic";
  if (reason) {
    block.editable = false;
    block.readOnlyReason = reason;
  }
}

/* Orden de lectura -------------------------------------------------- */

/**
 * Orden de lectura estable: de arriba abajo en bandas (dos bloques cuyo
 * borde superior difiere menos de medio cuerpo van en la misma banda) y de
 * izquierda a derecha dentro de cada banda. No muta el arreglo recibido.
 */
export function blocksInReadingOrder<T extends { box: UserBox; fontSize: number }>(
  blocks: readonly T[],
): T[] {
  const byTop = blocks
    .map((block, index) => ({ block, index }))
    .sort(
      (a, b) =>
        b.block.box.y + b.block.box.height - (a.block.box.y + a.block.box.height) ||
        a.block.box.x - b.block.box.x ||
        a.index - b.index,
    );
  const result: T[] = [];
  let band: Array<{ block: T; index: number }> = [];
  let bandTop = 0;
  const flush = () => {
    band.sort((a, b) => a.block.box.x - b.block.box.x || a.index - b.index);
    for (const entry of band) result.push(entry.block);
    band = [];
  };
  for (const entry of byTop) {
    const top = entry.block.box.y + entry.block.box.height;
    const tolerance = 0.5 * Math.max(1, entry.block.fontSize);
    if (band.length === 0) {
      bandTop = top;
    } else if (bandTop - top > tolerance) {
      flush();
      bandTop = top;
    }
    band.push(entry);
  }
  flush();
  return result;
}

/**
 * Una linea sola no tiene margenes propios con los que deducir su
 * alineacion. Con el CONTEXTO de la pagina se afina con prudencia (solo se
 * cambia "left", nunca al reves):
 *  - margenes: el borde izquierdo mas repetido de la pagina es el margen
 *    izquierdo y el simetrico, el derecho. Una linea que termina en el margen
 *    derecho y empieza bien dentro es `right`; si su centro es el de los
 *    margenes, `center`.
 *  - columna: tres o mas bloques de una linea con el mismo borde derecho y
 *    bordes izquierdos distintos => `right`.
 */
function refineSingleLineAlignment(blocks: TextBlock[], pageBox: UserBox | undefined): void {
  const candidates = blocks.filter((b) => b.rotation === 0 && !b.script);
  if (candidates.length < 2) return;
  const counts = new Map<number, number>();
  for (const b of candidates) {
    const key = Math.round(b.box.x);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let marginKey: number | null = null;
  let best = 1;
  for (const [key, count] of counts) {
    if (count > best || (count === best && count > 1 && marginKey !== null && key < marginKey)) {
      best = count;
      marginKey = key;
    }
  }
  let leftMargin: number | null = null;
  let rightMargin: number | null = null;
  if (pageBox && marginKey !== null) {
    leftMargin = marginKey;
    rightMargin = pageBox.x + pageBox.width - (marginKey - pageBox.x);
    if (rightMargin - leftMargin < 0.3 * pageBox.width) leftMargin = rightMargin = null;
  }

  // Indice por borde derecho (a 1 pt): la comprobacion de columna es O(1)
  // por bloque y la funcion entera O(n) incluso con decenas de miles de bloques.
  const byRight = new Map<number, TextBlock[]>();
  for (const o of candidates) {
    if (o.lines.length !== 1) continue;
    const k = Math.round(o.box.x + o.box.width);
    const bucket = byRight.get(k);
    if (bucket) bucket.push(o);
    else byRight.set(k, [o]);
  }

  for (const block of candidates) {
    if (block.lines.length !== 1 || block.align !== "left") continue;
    const left = block.box.x;
    const right = block.box.x + block.box.width;
    if (leftMargin !== null && rightMargin !== null) {
      const span = rightMargin - leftMargin;
      if (Math.abs(right - rightMargin) <= 1.5 && left - leftMargin > 0.15 * span) {
        block.align = "right";
        continue;
      }
      if (
        Math.abs((left + right) / 2 - (leftMargin + rightMargin) / 2) <= 1.5 &&
        left - leftMargin > 0.1 * span &&
        rightMargin - right > 0.1 * span
      ) {
        block.align = "center";
        continue;
      }
    }
    // Columna alineada a la derecha: 3 o mas bloques con el mismo borde derecho
    // y bordes izquierdos que NO coinciden entre si (una columna izquierda de
    // textos de distinto largo no tiene bordes derechos iguales).
    const key = Math.round(right);
    let count = 0;
    let minLeft = Infinity;
    let maxLeft = -Infinity;
    for (const k of [key - 1, key, key + 1]) {
      for (const o of byRight.get(k) ?? []) {
        if (Math.abs(o.box.x + o.box.width - right) > 1) continue;
        count += 1;
        minLeft = Math.min(minLeft, o.box.x);
        maxLeft = Math.max(maxLeft, o.box.x);
      }
    }
    if (count >= 3 && maxLeft - minLeft > 2) block.align = "right";
  }
}

/* Punto de entrada --------------------------------------------------- */

function groupVisibility(
  items: RawTextItem[],
  options: GroupOptions,
  hidden: boolean,
): TextBlock[] {
  const blocks: TextBlock[] = [];
  const verticalItems = items.filter((item) => item.vertical);
  const horizontal = items.filter((item) => !item.vertical);

  for (const group of splitByRotation(horizontal)) {
    const ruleIndex = options.rules ? buildRuleIndex(options.rules, group.angle) : undefined;
    const prepared = splitItemsAtRules(prepare(group.items, group.angle), ruleIndex);
    detectScripts(prepared);
    const main = prepared.filter((item) => !item.script);
    const scripts = prepared.filter((item) => item.script);

    const bases = new Set<Prep>();
    for (const script of scripts) if (script.base) bases.add(script.base);
    const noBases = new Set<Prep>();

    const segments: Segment[] = [];
    const mainLines = buildLines(main);
    const gutters = main.length <= MAX_GUTTER_ITEMS ? buildGutterIndex(mainLines) : undefined;
    for (const line of mainLines) {
      segments.push(
        ...absorbMarkerSegments(splitLineIntoSegments(line, scripts, bases, gutters, ruleIndex)),
      );
    }
    for (const line of buildLines(scripts)) {
      segments.push(...splitLineIntoSegments(line, [], noBases, undefined, ruleIndex));
    }
    flagVectorBullets(segments, group.angle, options.markers);
    // Los indices nunca se funden en parrafo con nada (ver `matchParagraph`).
    for (const para of buildParagraphs(segments, ruleIndex)) {
      blocks.push(blockOf(para, group.angle, options, hidden));
    }
  }

  // Texto vertical: sin agrupar, cada fragmento es un bloque de solo lectura.
  for (const item of verticalItems) {
    const angle = normalizeRotation(item.rotation);
    const prepared = prepare([item], angle);
    if (prepared.length === 0) continue;
    const seg = makeSegment(prepared, 1);
    const block = blockOf(
      {
        lines: [seg],
        last: seg,
        leading: null,
        maxWidth: seg.u1 - seg.u0,
        maxRight: seg.u1,
        leftAligned: true,
        hanging: false,
      },
      angle,
      options,
      hidden,
    );
    block.editable = false;
    block.readOnlyReason = hidden ? "invisible" : "vertical";
    blocks.push(block);
  }
  return blocks;
}

/**
 * Agrupa los fragmentos de una pagina en bloques. Nunca lanza: ante
 * cualquier fallo inesperado devuelve lo que haya podido construir.
 */
export function groupTextItems(
  rawItems: readonly RawTextItem[],
  options: GroupOptions,
): GroupResult {
  const usableItems = rawItems.filter(usable);
  let visible: TextBlock[] = [];
  let hidden: TextBlock[] = [];
  try {
    visible = groupVisibility(
      usableItems.filter((item) => !item.invisible),
      options,
      false,
    );
    hidden = groupVisibility(
      usableItems.filter((item) => item.invisible),
      options,
      true,
    );
  } catch {
    // REGLA DURA: nunca lanzar a la interfaz por un PDF raro.
  }
  try {
    refineSingleLineAlignment(visible, options.pageBox);
  } catch {
    // Solo es un refinamiento: ante un fallo se conserva la alineacion de partida.
  }
  visible = blocksInReadingOrder(visible);
  hidden = blocksInReadingOrder(hidden);
  let index = 0;
  const assign = (block: TextBlock) => {
    block.id = `p${options.pageIndex}-b${index}`;
    index += 1;
  };
  visible.forEach(assign);
  hidden.forEach(assign);
  return { visible, hidden };
}
