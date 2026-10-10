import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { getPdfJs } from "@/lib/pdf/core";
import type { TextBlock, UserBox } from "@/lib/pdf/editTypes";
import { sourceFontInfoFrom, type PdfJsFontLike } from "@/lib/pdf/fontInfo";
import {
  groupTextItems,
  normalizeRotation,
  type MarkerShape,
  type RawTextItem,
  type RuleLine,
} from "@/lib/pdf/textBlocksGroup";

export { blocksInReadingOrder } from "@/lib/pdf/textBlocksGroup";

/**
 * Extraccion de BLOQUES DE TEXTO editables de una pagina (Wave 5, U1).
 *
 * Une tres fuentes de pdf.js:
 *  - `getTextContent()`: texto, posicion (`transform`), ancho y fuente de
 *    cada fragmento. Las coordenadas ya vienen en el ESPACIO DE USUARIO de
 *    la pagina (sin `/Rotate`, con el origen del CropBox tal cual): el
 *    mismo en el que trabaja `core.ts` (`getPageGeometry`/`viewPointToUser`).
 *    pdf.js descarta por su cuenta el texto fuera del area visible.
 *  - `getOperatorList()`: el COLOR de relleno y el modo de render, que
 *    `getTextContent` no da. Se recorre el estado grafico (q/Q, cm, formas,
 *    BT/Tm/Td/TL/Tc/Tw/Tz/Ts, Tf, Tr, colores, `ca`) y se registra, por cada
 *    `showText`, donde empieza y cuanto avanza; cada fragmento de texto se
 *    asigna a la tirada que empieza justo antes de el en su misma linea base.
 *    Limite conocido: si pdf.js funde dos tiradas de distinto color en un
 *    unico fragmento, el fragmento toma el color de la primera.
 *  - `page.commonObjs`: la fuente (solo se puede leer DESPUES de
 *    `getOperatorList`; antes lanza "isn't resolved yet").
 *
 * Despues delega en `textBlocksGroup.ts` (agrupado puro y geometrico).
 *
 * REGLA DURA: nunca lanza a la interfaz. Cualquier fallo (PDF raro, pagina
 * ilegible) se traduce en `{ blocks: [], failed: true }`.
 *
 * Convenciones documentadas:
 *  - `TextBlock.box` es la caja envolvente alineada a los ejes (para texto
 *    girado es mayor que el texto); el rectangulo real esta en
 *    `orientedBox`.
 *  - Ascenso/descenso por linea: los de la fuente segun pdf.js
 *    (`styles[font].ascent/descent`); si faltan o son absurdos se usan
 *    0.8 / -0.2 veces el tamano (`DEFAULT_ASCENT`/`DEFAULT_DESCENT`).
 *  - Capa invisible (render mode 3 y 7, o alfa de relleno 0, tipica del
 *    OCR): se EXCLUYE de `blocks` y se cuenta en `hiddenCount`. Con
 *    `includeInvisible: true` se anade al final como bloques de solo lectura
 *    (`readOnlyReason: "invisible"`).
 *  - `hasTextLayer: false` => no hay ningun texto VISIBLE (pagina escaneada,
 *    con o sin capa OCR oculta): la interfaz debe ofrecer solo "Anadir
 *    texto". `hiddenCount > 0` junto con `hasTextLayer: false` es el caso de
 *    "escaneado con OCR".
 */

export const DEFAULT_ASCENT = 0.8;
export const DEFAULT_DESCENT = -0.2;

/** Subconjunto de la enumeracion `OPS` de pdf.js que se usa aqui. */
export type TextOps = Record<string, number>;

export type ExtractOptions = {
  /**
   * La enumeracion `OPS` de pdf.js. Si no se pasa se obtiene de
   * `getPdfJs()` (navegador). Los tests en Node la pasan desde el build
   * `legacy` porque el principal exige `DOMMatrix`.
   */
  OPS?: TextOps;
  /** Anade los bloques de texto invisible al final de `blocks`. */
  includeInvisible?: boolean;
};

export type PageTextAnalysis = {
  /** Bloques editables y de solo lectura visibles, en orden de lectura. */
  blocks: TextBlock[];
  /** Cuantos bloques de texto invisible (capa OCR) se dejaron fuera. */
  hiddenCount: number;
  /** Hay al menos un fragmento de texto VISIBLE no vacio. */
  hasTextLayer: boolean;
  /** La extraccion fallo del todo: la interfaz no debe asumir "escaneada". */
  failed: boolean;
};

const EMPTY_ANALYSIS: PageTextAnalysis = {
  blocks: [],
  hiddenCount: 0,
  hasTextLayer: false,
  failed: true,
};

/* ------------------------------------------------------------------ *
 * Estado grafico: tiradas de texto con color
 * ------------------------------------------------------------------ */

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` primero y despues `b` (convencion de PDF: punto fila x matriz). */
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

function asMatrix(value: unknown): Matrix | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  const source = value as ArrayLike<number>;
  if (typeof source.length !== "number" || source.length < 6) return null;
  const m = [0, 1, 2, 3, 4, 5].map((i) => Number(source[i])) as Matrix;
  return m.every(Number.isFinite) ? m : null;
}

const MAX_MARKERS = 3000;
/** Reglas vectoriales (bordes de tabla, separadores): tope de seguridad. */
const MAX_RULES = 20000;
/** Una regla es un trazo o relleno de <= 3 pt de grosor y >= 4 pt de largo. */
const MAX_RULE_PT = 3;
const MIN_RULE_PT = 4;
const MAX_RUN_MATCHES = 20_000_000;
/** Una vineta mide unos pocos puntos; mas grande ya es un recuadro o un fondo. */
const MAX_MARKER_PT = 14;

/** Operadores que TRAZAN el contorno (con o sin relleno). */
function STROKE_OPS(OPS: TextOps): Set<number> {
  return new Set(
    [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(
      (n): n is number => typeof n === "number",
    ),
  );
}

/**
 * Segmentos rectos [x0, y0, x1, y1] de los datos de camino de pdf.js
 * (0 moveTo, 1 lineTo, 2 curveTo, 3 quadratic, 4 closePath). Las curvas se
 * saltan: solo interesan bordes rectos.
 */
function pathSegments(data: unknown): Array<[number, number, number, number]> {
  let flat: ArrayLike<number> | null = null;
  if (data && typeof data === "object") {
    const first = (data as ArrayLike<unknown>)[0];
    if (first && typeof first === "object" && typeof (first as ArrayLike<number>).length === "number") {
      flat = first as ArrayLike<number>;
    } else if (typeof (data as ArrayLike<number>).length === "number") {
      flat = data as ArrayLike<number>;
    }
  }
  const out: Array<[number, number, number, number]> = [];
  if (!flat) return out;
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const n = flat.length;
  while (i < n && out.length < 64) {
    const op = flat[i];
    if (op === 0) {
      cx = Number(flat[i + 1]);
      cy = Number(flat[i + 2]);
      sx = cx;
      sy = cy;
      i += 3;
    } else if (op === 1) {
      const nx = Number(flat[i + 1]);
      const ny = Number(flat[i + 2]);
      if ([cx, cy, nx, ny].every(Number.isFinite)) out.push([cx, cy, nx, ny]);
      cx = nx;
      cy = ny;
      i += 3;
    } else if (op === 2) {
      cx = Number(flat[i + 5]);
      cy = Number(flat[i + 6]);
      i += 7;
    } else if (op === 3) {
      cx = Number(flat[i + 3]);
      cy = Number(flat[i + 4]);
      i += 5;
    } else if (op === 4) {
      if ([cx, cy, sx, sy].every(Number.isFinite)) out.push([cx, cy, sx, sy]);
      cx = sx;
      cy = sy;
      i += 1;
    } else {
      break;
    }
  }
  return out;
}

/** Operadores de trazo que RELLENAN (la vineta es un disco, no un contorno). */
function FILL_OPS(OPS: TextOps): Set<number> {
  return new Set(
    [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(
      (n): n is number => typeof n === "number",
    ),
  );
}

/**
 * Evidencia de si una fuente traduce sus codigos a Unicode. En cada glifo de
 * `showText` pdf.js da el codigo leido (`originalCharCode`) y el texto que
 * le asigna (`unicode`). Si el texto es siempre el propio codigo (`identity`)
 * y nunca otro (`mapped` = 0), la fuente no tiene un mapa que cambie nada:
 * es el caso de una fuente CID SIN ToUnicode (el texto sale como ids de
 * glifo) pero tambien el de una fuente simple de codificacion directa. Un
 * solo glifo traducido (`mapped` > 0) prueba que SI hay mapa (ToUnicode o
 * codificacion): ese texto no puede ser ids de glifo desplazados.
 */
export type GlyphMapEvidence = { identity: number; mapped: number };

/** Una instruccion `showText`: donde empieza, hacia donde va y de que color. */
export type TextRun = {
  x: number;
  y: number;
  /** Direccion unitaria a lo largo de la linea base. */
  dx: number;
  dy: number;
  length: number;
  color: string;
  invisible: boolean;
  fontId: string;
  /** Posicion de la tirada en la lista (identifica la instruccion `showText`). */
  index: number;
  /** Cuantos glifos (caracteres) pinta. */
  glyphs: number;
};

type GraphicsState = {
  ctm: Matrix;
  fill: string;
  stroke: string;
  fillAlpha: number;
  fontId: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  rise: number;
  leading: number;
  renderMode: number;
  lineWidth: number;
};

function hex2(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

/** "#rrggbb" a partir de los argumentos de un operador de color de pdf.js. */
function colorFromArgs(
  args: unknown,
  kind: "rgb" | "gray" | "cmyk",
): string | null {
  if (!Array.isArray(args) && !ArrayBuffer.isView(args)) return null;
  const list = Array.from(args as ArrayLike<unknown>);
  if (typeof list[0] === "string") {
    return /^#[0-9a-f]{6}$/i.test(list[0]) ? list[0].toLowerCase() : null;
  }
  const nums = list.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const unit = (n: number) => (n > 1 ? n / 255 : n);
  if (kind === "gray" && nums.length >= 1) {
    const g = hex2(unit(nums[0]) * 255);
    return `#${g}${g}${g}`;
  }
  if (kind === "rgb" && nums.length >= 3) {
    return `#${hex2(unit(nums[0]) * 255)}${hex2(unit(nums[1]) * 255)}${hex2(
      unit(nums[2]) * 255,
    )}`;
  }
  if (kind === "cmyk" && nums.length >= 4) {
    const [c, m, y, k] = nums.map((n) => Math.max(0, Math.min(1, n)));
    return `#${hex2(255 * (1 - c) * (1 - k))}${hex2(
      255 * (1 - m) * (1 - k),
    )}${hex2(255 * (1 - y) * (1 - k))}`;
  }
  return null;
}

export type OperatorListLike = {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
};

/**
 * Recorre la lista de operadores y devuelve una tirada por cada
 * `showText`. Funcion pura (se prueba con listas hechas a mano).
 * `fontMatrixOf` da `fontMatrix[0]` de la fuente (0.001 por defecto).
 * Si se pasa `markers`, ademas recoge las formas pequenas rellenas (vinetas
 * vectoriales de listas) en espacio de usuario.
 */
export function collectTextRuns(
  operatorList: OperatorListLike,
  OPS: TextOps,
  fontMatrixOf: (fontId: string) => number = () => 0.001,
  markers?: MarkerShape[],
  glyphMaps?: Map<string, GlyphMapEvidence>,
  rules?: RuleLine[],
): TextRun[] {
  const runs: TextRun[] = [];
  const stack: GraphicsState[] = [];
  let state: GraphicsState = {
    ctm: IDENTITY,
    fill: "#000000",
    stroke: "#000000",
    fillAlpha: 1,
    fontId: "",
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    rise: 0,
    leading: 0,
    renderMode: 0,
    lineWidth: 1,
  };
  let tm: Matrix = IDENTITY;
  let lm: Matrix = IDENTITY;

  const moveText = (tx: number, ty: number) => {
    lm = multiply([1, 0, 0, 1, tx, ty], lm);
    tm = lm;
  };

  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const fn = operatorList.fnArray[i];
    const args = operatorList.argsArray[i] as unknown;
    const list = (Array.isArray(args) ? args : []) as unknown[];

    switch (fn) {
      case OPS.save:
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...state });
        if (fn === OPS.paintFormXObjectBegin) {
          const matrix = asMatrix(list[0]);
          if (matrix) state = { ...state, ctm: multiply(matrix, state.ctm) };
        }
        break;
      }
      case OPS.restore:
      case OPS.paintFormXObjectEnd: {
        const previous = stack.pop();
        if (previous) state = previous;
        break;
      }
      case OPS.transform: {
        const matrix = asMatrix(args) ?? asMatrix(list[0]);
        if (matrix) state = { ...state, ctm: multiply(matrix, state.ctm) };
        break;
      }
      case OPS.beginText:
        tm = IDENTITY;
        lm = IDENTITY;
        break;
      case OPS.setTextMatrix: {
        const matrix = list.length >= 6 ? asMatrix(list) : asMatrix(list[0]);
        if (matrix) {
          tm = matrix;
          lm = matrix;
        }
        break;
      }
      case OPS.moveText:
        moveText(Number(list[0]) || 0, Number(list[1]) || 0);
        break;
      case OPS.setLeadingMoveText:
        state.leading = -(Number(list[1]) || 0);
        moveText(Number(list[0]) || 0, Number(list[1]) || 0);
        break;
      case OPS.nextLine:
        moveText(0, -state.leading);
        break;
      case OPS.setLeading:
        state.leading = Number(list[0]) || 0;
        break;
      case OPS.setFont:
        state.fontId = String(list[0] ?? "");
        state.fontSize = Number(list[1]) || 0;
        break;
      case OPS.setCharSpacing:
        state.charSpacing = Number(list[0]) || 0;
        break;
      case OPS.setWordSpacing:
        state.wordSpacing = Number(list[0]) || 0;
        break;
      case OPS.setHScale:
        state.hScale = (Number(list[0]) || 100) / 100;
        break;
      case OPS.setTextRise:
        state.rise = Number(list[0]) || 0;
        break;
      case OPS.setTextRenderingMode:
        state.renderMode = Number(list[0]) || 0;
        break;
      case OPS.setFillRGBColor: {
        const color = colorFromArgs(args, "rgb");
        if (color) state.fill = color;
        break;
      }
      case OPS.setFillGray: {
        const color = colorFromArgs(args, "gray");
        if (color) state.fill = color;
        break;
      }
      case OPS.setFillCMYKColor: {
        const color = colorFromArgs(args, "cmyk");
        if (color) state.fill = color;
        break;
      }
      case OPS.setStrokeRGBColor: {
        const color = colorFromArgs(args, "rgb");
        if (color) state.stroke = color;
        break;
      }
      case OPS.setStrokeGray: {
        const color = colorFromArgs(args, "gray");
        if (color) state.stroke = color;
        break;
      }
      case OPS.setStrokeCMYKColor: {
        const color = colorFromArgs(args, "cmyk");
        if (color) state.stroke = color;
        break;
      }
      case OPS.setGState: {
        const entries = Array.isArray(list[0]) ? (list[0] as unknown[]) : [];
        for (const entry of entries) {
          if (Array.isArray(entry) && entry[0] === "ca") {
            const alpha = Number(entry[1]);
            if (Number.isFinite(alpha)) state.fillAlpha = alpha;
          }
        }
        break;
      }
      case OPS.setLineWidth:
        state.lineWidth = Number(list[0]) || 0;
        break;
      case OPS.constructPath: {
        const paintOp = Number(list[0]);
        const fills = FILL_OPS(OPS);
        const strokes = STROKE_OPS(OPS);
        const isFill = fills.has(paintOp);
        const isStroke = strokes.has(paintOp);
        if (!isFill && !isStroke) break;
        const wantMarkers = markers !== undefined && markers.length < MAX_MARKERS && isFill;
        const wantRules = rules !== undefined && rules.length < MAX_RULES;
        if (!wantMarkers && !wantRules) break;
        const box = list[2] as ArrayLike<number> | undefined;
        if (!box || box.length < 4) break;
        const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => Number(box[i]));
        if (![x0, y0, x1, y1].every(Number.isFinite)) break;
        const c = state.ctm;
        // Caja del trazo a espacio de usuario (4 esquinas por si la CTM gira).
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
          xs.push(c[0] * px + c[2] * py + c[4]);
          ys.push(c[1] * px + c[3] * py + c[5]);
        }
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const width = Math.max(...xs) - minX;
        const height = Math.max(...ys) - minY;
        if (wantMarkers && width >= 0.5 && height >= 0.5 && width <= MAX_MARKER_PT && height <= MAX_MARKER_PT) {
          markers!.push({ x: minX, y: minY, width, height });
        }
        if (wantRules) {
          // Relleno fino y largo (Chromium dibuja cada borde como un rectangulo).
          if (isFill && Math.min(width, height) <= MAX_RULE_PT && Math.max(width, height) >= MIN_RULE_PT) {
            if (width <= height) {
              const cx = minX + width / 2;
              rules!.push({ x0: cx, y0: minY, x1: cx, y1: minY + height, thickness: width });
            } else {
              const cy = minY + height / 2;
              rules!.push({ x0: minX, y0: cy, x1: minX + width, y1: cy, thickness: height });
            }
          } else if (isStroke) {
            // Trazo: cada segmento recto del camino es una regla del grosor de la linea.
            const scale = Math.sqrt(Math.abs(c[0] * c[3] - c[1] * c[2])) || 1;
            const thickness = state.lineWidth * scale;
            if (thickness <= MAX_RULE_PT) {
              for (const seg of pathSegments(list[1])) {
                const ax = c[0] * seg[0] + c[2] * seg[1] + c[4];
                const ay = c[1] * seg[0] + c[3] * seg[1] + c[5];
                const bx = c[0] * seg[2] + c[2] * seg[3] + c[4];
                const by = c[1] * seg[2] + c[3] * seg[3] + c[5];
                if (Math.hypot(bx - ax, by - ay) < MIN_RULE_PT) continue;
                if (rules!.length >= MAX_RULES) break;
                rules!.push({ x0: ax, y0: ay, x1: bx, y1: by, thickness });
              }
            }
          }
        }
        break;
      }
      case OPS.showText: {
        const glyphs = Array.isArray(list[0]) ? (list[0] as unknown[]) : [];
        const base = multiply(tm, state.ctm);
        const scale = Math.hypot(base[0], base[1]) || 1;
        const fm = fontMatrixOf(state.fontId) || 0.001;
        let advance = 0;
        for (const glyph of glyphs) {
          if (typeof glyph === "number") {
            advance -= ((glyph * state.fontSize) / 1000) * state.hScale;
            continue;
          }
          const g = glyph as {
            width?: number;
            isSpace?: boolean;
            originalCharCode?: number;
            unicode?: string;
          } | null;
          if (
            glyphMaps &&
            g &&
            typeof g.originalCharCode === "number" &&
            typeof g.unicode === "string" &&
            g.unicode.length > 0
          ) {
            let evidence = glyphMaps.get(state.fontId);
            if (!evidence) {
              evidence = { identity: 0, mapped: 0 };
              glyphMaps.set(state.fontId, evidence);
            }
            if (g.unicode === String.fromCharCode(g.originalCharCode)) evidence.identity += 1;
            else evidence.mapped += 1;
          }
          const width = Number(g?.width) || 0;
          advance +=
            (width * fm * state.fontSize +
              state.charSpacing +
              (g?.isSpace ? state.wordSpacing : 0)) *
            state.hScale;
        }
        // Posicion del origen del texto (con la elevacion `Ts`).
        const ox = base[2] * state.rise + base[4];
        const oy = base[3] * state.rise + base[5];
        const useStroke = state.renderMode === 1 || state.renderMode === 5;
        runs.push({
          x: ox,
          y: oy,
          dx: base[0] / scale,
          dy: base[1] / scale,
          length: advance * scale,
          color: useStroke ? state.stroke : state.fill,
          // 3 = invisible, 7 = solo recorte; alfa 0 tambien oculta el texto.
          invisible:
            state.renderMode === 3 ||
            state.renderMode === 7 ||
            (state.fillAlpha <= 0 && state.renderMode !== 1),
          fontId: state.fontId,
          index: runs.length,
          glyphs: glyphs.filter((g) => typeof g !== "number").length,
        });
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
        break;
      }
      default:
        break;
    }
  }
  return runs;
}

/**
 * Tirada a la que pertenece un fragmento: misma linea base y direccion, y
 * la que EMPIEZA mas cerca por detras (o justo en) el inicio del fragmento.
 */
export function findRun(
  runs: readonly TextRun[],
  x: number,
  y: number,
  angleRad: number,
  size: number,
): TextRun | null {
  return findRunInfo(runs, x, y, angleRad, size, 0).run;
}

/**
 * Como `findRun` y ademas dice si dentro del fragmento (`width` a lo largo de
 * la linea base) empieza otra tirada de distinto color o fuente: pdf.js
 * funde tiradas contiguas en un fragmento y el color se tomaria solo de la
 * primera. `mixed` permite avisarlo.
 */
export function findRunInfo(
  runs: readonly TextRun[],
  x: number,
  y: number,
  angleRad: number,
  size: number,
  width: number,
): {
  run: TextRun | null;
  mixed: boolean;
  cutPoints: Array<{ along: number; leftEndAlong: number; index: number }>;
} {
  const ux = Math.cos(angleRad);
  const uy = Math.sin(angleRad);
  const perpendicularTol = 0.35 * size + 0.5;
  const alongTol = 0.25 * size + 0.5;
  let before: TextRun | null = null;
  let beforeT = -Infinity;
  let nearest: TextRun | null = null;
  let nearestAbs = Infinity;
  const inside: Array<{ run: TextRun; t: number }> = [];
  for (const run of runs) {
    if (run.dx * ux + run.dy * uy < 0.9986) continue; // ~3 grados
    const rx = run.x - x;
    const ry = run.y - y;
    const perpendicular = Math.abs(-rx * uy + ry * ux);
    if (perpendicular > perpendicularTol) continue;
    const t = rx * ux + ry * uy; // < 0: la tirada empieza antes que el fragmento
    if (t <= alongTol && t > beforeT) {
      before = run;
      beforeT = t;
    }
    if (Math.abs(t) < nearestAbs) {
      nearest = run;
      nearestAbs = Math.abs(t);
    }
    if (t > alongTol && t < width - alongTol) inside.push({ run, t });
  }
  const run = before ?? nearest;
  const mixed =
    run !== null &&
    inside.some(({ run: other }) => other.color !== run.color || other.fontId !== run.fontId);
  // Puntos de corte: donde empiezan las demas instrucciones dentro del fragmento.
  const cutPoints: Array<{ along: number; leftEndAlong: number; index: number }> = [];
  if (run && inside.length > 0) {
    inside.sort((a, b) => a.t - b.t);
    let index = run.glyphs;
    let previous = { run, t: Math.max(0, beforeT) };
    for (const entry of inside) {
      cutPoints.push({
        along: entry.t,
        leftEndAlong: previous.t + previous.run.length,
        index,
      });
      index += entry.run.glyphs;
      previous = entry;
    }
  }
  return { run, mixed, cutPoints };
}

/* ------------------------------------------------------------------ *
 * Extraccion
 * ------------------------------------------------------------------ */

type FontObject = NonNullable<PdfJsFontLike> & {
  fontMatrix?: number[];
  ascent?: number;
  descent?: number;
  vertical?: boolean;
};
type FontCache = Map<string, FontObject | null>;

function readFont(page: PDFPageProxy, fontName: string): FontObject | null {
  try {
    const commonObjs = page.commonObjs as unknown as {
      has?: (id: string) => boolean;
      get: (id: string) => unknown;
    };
    if (commonObjs.has && !commonObjs.has(fontName)) return null;
    const font = commonObjs.get(fontName) as FontObject | null | undefined;
    return font && typeof font === "object" ? font : null;
  } catch {
    // "isn't resolved yet" o fuente irresoluble: se sigue con lo que haya.
    return null;
  }
}

type TextContentItem = {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
  fontName?: string;
};

type TextStyle = {
  fontFamily?: string;
  ascent?: number;
  descent?: number;
  vertical?: boolean;
};

/** `true`: sin mapa Unicode comprobable; `false`: hay mapa; `undefined`: sin datos. */
function identityOf(evidence: GlyphMapEvidence | undefined): boolean | undefined {
  if (!evidence) return undefined;
  if (evidence.mapped > 0) return false;
  return evidence.identity > 0 ? true : undefined;
}

async function loadOps(options: ExtractOptions): Promise<TextOps> {
  if (options.OPS) return options.OPS;
  const pdfjs = await getPdfJs();
  return pdfjs.OPS as unknown as TextOps;
}

async function analyze(
  page: PDFPageProxy,
  pageIndex: number,
  options: ExtractOptions,
): Promise<PageTextAnalysis> {
  const OPS = await loadOps(options);
  // Primero la lista de operadores: asi las fuentes quedan resueltas.
  const operatorList = await page.getOperatorList();
  const textContent = await page.getTextContent();
  if (!operatorList || !textContent) return { ...EMPTY_ANALYSIS };

  const fonts: FontCache = new Map();
  const fontFor = (name: string) => {
    if (!fonts.has(name)) fonts.set(name, readFont(page, name));
    return fonts.get(name) ?? null;
  };

  const markers: MarkerShape[] = [];
  const glyphMaps = new Map<string, GlyphMapEvidence>();
  const rules: RuleLine[] = [];
  const runs = collectTextRuns(
    operatorList,
    OPS,
    (id) => {
      const matrix = fontFor(id)?.fontMatrix;
      return Array.isArray(matrix) && matrix.length >= 1 && matrix[0] > 0
        ? matrix[0]
        : 0.001;
    },
    markers,
    glyphMaps,
    rules,
  );
  const entryCount = Array.isArray(textContent?.items) ? textContent.items.length : 0;
  // Asignar cada fragmento a su tirada es O(fragmentos x tiradas): en paginas
  // gigantes con un unico color se salta (sin ids de tirada ni aviso de mezcla).
  const matchRuns = runs.length * entryCount <= MAX_RUN_MATCHES;
  const uniform =
    !matchRuns &&
    runs.length > 0 &&
    runs.every((r) => r.color === runs[0].color && !r.invisible);

  const styles = (textContent.styles ?? {}) as Record<string, TextStyle>;
  const raw: RawTextItem[] = [];
  let visibleText = false;

  const entries = Array.isArray(textContent?.items)
    ? (textContent.items as Array<TextContentItem | null | undefined>)
    : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.str !== "string" || entry.str.trim().length === 0) continue;
    const t = entry.transform;
    if (!t || t.length < 6 || !t.every(Number.isFinite)) continue;
    const [a, b, c, d, e, f] = t;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || Math.abs(entry.height ?? 0);
    const angle = Math.atan2(b, a);
    const fontName = entry.fontName ?? "";
    const style = styles[fontName];
    const fontObject = fontFor(fontName);
    let run: TextRun | null = null;
    let mixed = false;
    let cutPoints: Array<{ along: number; leftEndAlong: number; index: number }> = [];
    if (uniform) {
      run = runs[0];
    } else {
      const found = findRunInfo(runs, e, f, angle, size, Number(entry.width) || 0);
      run = found.run;
      mixed = found.mixed;
      cutPoints = found.cutPoints;
    }

    // Ascenso/descenso: de la fuente; si falta, valores por defecto.
    const ascent = style?.ascent ?? fontObject?.ascent;
    const descent = style?.descent ?? fontObject?.descent;
    const invisible = run?.invisible === true;
    if (!invisible) visibleText = true;

    raw.push({
      str: entry.str,
      x: e,
      y: f,
      rotation: (angle * 180) / Math.PI,
      width: Number(entry.width),
      fontSize: size,
      ascent: typeof ascent === "number" ? ascent : DEFAULT_ASCENT,
      descent: typeof descent === "number" ? descent : DEFAULT_DESCENT,
      color: run?.color ?? "#000000",
      font: sourceFontInfoFrom(fontObject, fontName, style?.fontFamily),
      invisible,
      vertical: style?.vertical === true || fontObject?.vertical === true,
      runId: uniform ? undefined : run?.index,
      mixed,
      cutPoints: cutPoints.length > 0 ? cutPoints : undefined,
      identityEncoding: identityOf(glyphMaps.get(fontName)),
    });
  }

  const view = (page as unknown as { view?: number[] }).view;
  const pageBox: UserBox | undefined =
    Array.isArray(view) && view.length >= 4 && view.every(Number.isFinite)
      ? {
          x: Math.min(view[0], view[2]),
          y: Math.min(view[1], view[3]),
          width: Math.abs(view[2] - view[0]),
          height: Math.abs(view[3] - view[1]),
        }
      : undefined;

  const { visible, hidden } = groupTextItems(raw, { pageIndex, pageBox, markers, rules });
  return {
    blocks: options.includeInvisible ? [...visible, ...hidden] : visible,
    hiddenCount: hidden.length,
    hasTextLayer: visibleText,
    failed: false,
  };
}

/**
 * Analiza una pagina: bloques de texto, cuanta capa invisible hay y si la
 * pagina tiene texto visible. Nunca lanza.
 */
export async function analyzePageText(
  page: PDFPageProxy,
  pageIndex: number,
  options: ExtractOptions = {},
): Promise<PageTextAnalysis> {
  try {
    return await analyze(page, pageIndex, options);
  } catch {
    return { ...EMPTY_ANALYSIS };
  }
}

/** Atajo: solo los bloques de `analyzePageText`. Nunca lanza. */
export async function extractTextBlocks(
  page: PDFPageProxy,
  pageIndex: number,
  options: ExtractOptions = {},
): Promise<TextBlock[]> {
  return (await analyzePageText(page, pageIndex, options)).blocks;
}

/** Como `analyzePageText` pero obteniendo la pagina del documento. Nunca lanza. */
export async function analyzeDocPageText(
  doc: PDFDocumentProxy,
  pageIndex: number,
  options: ExtractOptions = {},
): Promise<PageTextAnalysis> {
  let page: PDFPageProxy | null = null;
  try {
    page = await doc.getPage(pageIndex + 1);
    return await analyzePageText(page, pageIndex, options);
  } catch {
    return { ...EMPTY_ANALYSIS };
  } finally {
    try {
      // Libera lo que pdf.js guarda de la pagina; `commonObjs` ya se leyo.
      page?.cleanup();
    } catch {
      // Nada que liberar.
    }
  }
}

/** Como `extractTextBlocks` pero obteniendo la pagina del documento. Nunca lanza. */
export async function extractTextBlocksFromDoc(
  doc: PDFDocumentProxy,
  pageIndex: number,
  options: ExtractOptions = {},
): Promise<TextBlock[]> {
  return (await analyzeDocPageText(doc, pageIndex, options)).blocks;
}

/* ------------------------------------------------------------------ *
 * Utilidades sobre bloques
 * ------------------------------------------------------------------ */

export { normalizeRotation };

/** Punto dentro del rectangulo orientado del bloque (o de su caja si no hay). */
function containsPoint(
  block: TextBlock,
  point: { x: number; y: number },
  slop: number,
): boolean {
  const oriented = block.orientedBox;
  if (oriented && block.rotation % 90 !== 0) {
    const angle = (block.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = point.x - oriented.origin.x;
    const dy = point.y - oriented.origin.y;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    return (
      u >= -slop &&
      u <= oriented.width + slop &&
      v >= -slop &&
      v <= oriented.height + slop
    );
  }
  const box = block.box;
  return (
    point.x >= box.x - slop &&
    point.x <= box.x + box.width + slop &&
    point.y >= box.y - slop &&
    point.y <= box.y + box.height + slop
  );
}

/**
 * Bloque bajo un punto en espacio de usuario. Si varios lo contienen
 * (cajas solapadas) gana el de menor area: el mas especifico. `slop` amplia
 * la caja unos puntos para facilitar el clic.
 */
export function blockAtPoint(
  blocks: readonly TextBlock[],
  point: { x: number; y: number },
  slop = 0,
): TextBlock | null {
  let best: TextBlock | null = null;
  let bestArea = Infinity;
  for (const block of blocks) {
    if (!containsPoint(block, point, slop)) continue;
    const area = block.box.width * block.box.height;
    if (area < bestArea) {
      best = block;
      bestArea = area;
    }
  }
  return best;
}
