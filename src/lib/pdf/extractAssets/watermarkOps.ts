/**
 * Recorrido de la lista de operadores de pdf.js de UNA pagina (con las anotaciones apagadas) para encontrar, en una sola
 * pasada, lo que necesitan las marcas de agua de texto, los sellos hechos con Form XObject y las imagenes translucidas:
 *
 * - Texto con su opacidad (`setGState ca`), tamano efectivo, angulo y caja, en unidades de VISTA (puntos, con la rotacion de pagina).
 * - Form XObjects (`paintFormXObjectBegin/End`) con la caja de lo que pintan, sus colores dominantes y la forma de sus trazos.
 * - Imagenes (`paintImageXObject`…) con su caja y la opacidad vigente.
 * - Grupos de contenido opcional (`beginMarkedContentProps «OC»`) que la pagina usa.
 *
 * Es una funcion pura sobre `fnArray`/`argsArray`: no toca pdf.js ni el DOM, y se prueba con listas fabricadas.
 */

import type { PdfOps } from "./annotationsTypes";
import type { ViewRect } from "./annotationsRaster";

export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m x n` con matrices de pdf.js ([a, b, c, d, e, f]); aplica primero `n`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** De espacio de usuario a unidades de vista (puntos, ya con la rotacion de la pagina). */
export type ViewMapper = {
  toView(x: number, y: number): [number, number];
};

export type TextRun = {
  text: string;
  /** Opacidad de relleno vigente (`ca`), 0..1. */
  alpha: number;
  /** Grados, antihorario tal como se ve en pantalla, en (-180, 180]. */
  angleDeg: number;
  /** Tamano efectivo del cuerpo en puntos de vista. */
  fontSizePt: number;
  bbox: ViewRect;
  /** Grupos de contenido opcional dentro de los que se pinta. */
  ocIds: string[];
  /** Cuantas veces se pinto (los mosaicos de marca de agua repiten el mismo texto muchas veces en una pagina). */
  count: number;
};

export type FormCandidate = {
  /** Cuerpo de la pagina donde empieza (indice en la lista de operadores). */
  beginIndex: number;
  endIndex: number;
  /** Caja de lo que PINTA (no de la `BBox` declarada), en unidades de vista. */
  bbox: ViewRect;
  /** Color dominante `#rrggbb` ponderado por operaciones de pintura, y su peso respecto al total (0..1). */
  dominantColor: string | null;
  dominantShare: number;
  curves: number;
  lines: number;
  paints: number;
  hasText: boolean;
  /** Texto pintado dentro (p. ej. «APROBADO»). */
  text: string;
  /** Huella del contenido (operadores y argumentos redondeados, sin posicion): agrupa el mismo sello repetido. */
  fingerprint: string;
  ocIds: string[];
};

export type ImagePaint = {
  /** Nombre del objeto en pdf.js; `null` en imagenes inline. */
  objectId: string | null;
  bbox: ViewRect;
  alpha: number;
  ocIds: string[];
};

export type PageGraphics = {
  textRuns: TextRun[];
  forms: FormCandidate[];
  images: ImagePaint[];
  /** Ids de grupos de contenido opcional que la pagina referencia. */
  ocgRefs: Set<string>;
  operators: number;
};

type GState = {
  ctm: Matrix;
  fillAlpha: number;
  strokeAlpha: number;
  fillColor: string;
  strokeColor: string;
  fontSize: number;
  renderMode: number;
};

type FormFrame = {
  beginIndex: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  colors: Map<string, number>;
  paints: number;
  curves: number;
  lines: number;
  hasText: boolean;
  text: string;
  shape: string[];
  ocIds: Set<string>;
};

type TextState = {
  tm: Matrix;
  lm: Matrix;
  leading: number;
  /** Indice de la ultima ejecucion de texto, para fusionar `Tj` consecutivos de una misma linea. */
  lastRun: TextRun | null;
  lastEnd: [number, number] | null;
};

/** `DrawOPS` de pdf.js 6 dentro de `constructPath` (se comprueba contra `pdfjs.DrawOPS` en las pruebas). */
export const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

function isMatrixLike(value: unknown): value is ArrayLike<number> {
  return value !== null && typeof value === "object" && typeof (value as ArrayLike<number>).length === "number";
}

function toMatrix(value: unknown): Matrix | null {
  if (!isMatrixLike(value) || value.length < 6) return null;
  const out = [value[0], value[1], value[2], value[3], value[4], value[5]];
  return out.every((n) => Number.isFinite(n)) ? (out as Matrix) : null;
}

/** Color `#rrggbb` -> HSV. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const n = parseInt(match[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function boxOfPoints(points: Array<[number, number]>): ViewRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

/** Texto de un `showText`: letras (`unicode`) y ajustes numericos de `TJ`. Devuelve el texto y el avance en unidades de texto (ya por `fontSize`). */
function measureGlyphs(glyphs: unknown, fontSize: number): { text: string; advance: number } {
  let text = "";
  let advance = 0;
  if (!isMatrixLike(glyphs)) return { text, advance };
  for (let i = 0; i < glyphs.length; i += 1) {
    const glyph = (glyphs as ArrayLike<unknown>)[i];
    if (typeof glyph === "number") {
      advance += (-glyph * fontSize) / 1000;
      // Un ajuste grande hacia atras (> 0,2 em) es un espacio entre palabras.
      if (glyph < -200 && text.length > 0 && !text.endsWith(" ")) text += " ";
    } else if (glyph && typeof glyph === "object") {
      const item = glyph as { unicode?: unknown; width?: unknown };
      if (typeof item.unicode === "string") text += item.unicode;
      if (typeof item.width === "number") advance += (item.width * fontSize) / 1000;
    }
  }
  return { text, advance };
}

function angleOf(map: ViewMapper, m: Matrix): number {
  const origin = apply(m, 0, 0);
  const along = apply(m, 1, 0);
  const a = map.toView(origin[0], origin[1]);
  const b = map.toView(along[0], along[1]);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let degrees = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (degrees <= -180) degrees += 360;
  return Math.round(degrees * 10) / 10;
}

function scaleOf(map: ViewMapper, m: Matrix): number {
  const origin = apply(m, 0, 0);
  const along = apply(m, 0, 1);
  const a = map.toView(origin[0], origin[1]);
  const b = map.toView(along[0], along[1]);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

const MAX_RUNS = 4000;
const MAX_FORMS = 400;
const MAX_IMAGES = 600;

/**
 * Recorre `fnArray`/`argsArray` de una pagina. Nunca lanza por datos raros: cualquier operador con argumentos que no encajen se salta.
 */
export function scanPageOperators(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: PdfOps, map: ViewMapper): PageGraphics {
  const result: PageGraphics = { textRuns: [], forms: [], images: [], ocgRefs: new Set(), operators: fnArray.length };
  const o = ops;
  let state: GState = { ctm: IDENTITY, fillAlpha: 1, strokeAlpha: 1, fillColor: "#000000", strokeColor: "#000000", fontSize: 0, renderMode: 0 };
  const stack: GState[] = [];
  let text: TextState = { tm: IDENTITY, lm: IDENTITY, leading: 0, lastRun: null, lastEnd: null };
  const marked: string[][] = [];
  const currentOc = (): string[] => marked.flatMap((entry) => entry);
  const frames: FormFrame[] = [];
  const formStates: GState[] = [];

  const fillOps = new Set([o.fill, o.eoFill].filter((n) => n !== undefined));
  const strokeOps = new Set([o.stroke, o.closeStroke].filter((n) => n !== undefined));
  const bothOps = new Set([o.fillStroke, o.eoFillStroke, o.closeFillStroke, o.closeEOFillStroke].filter((n) => n !== undefined));

  const addColor = (frame: FormFrame, color: string, weight = 1): void => {
    frame.colors.set(color, (frame.colors.get(color) ?? 0) + weight);
  };

  const extendFrame = (frame: FormFrame, points: Array<[number, number]>): void => {
    for (const [ux, uy] of points) {
      const [vx, vy] = map.toView(ux, uy);
      if (vx < frame.minX) frame.minX = vx;
      if (vy < frame.minY) frame.minY = vy;
      if (vx > frame.maxX) frame.maxX = vx;
      if (vy > frame.maxY) frame.maxY = vy;
    }
  };

  const round2 = (n: number): number => Math.round(n * 100) / 100;

  // Con las anotaciones activas pdf.js anade al final `beginAnnotation … endAnnotation` por cada una: no son contenido de la pagina.
  let annotationDepth = 0;

  for (let index = 0; index < fnArray.length; index += 1) {
    const op = fnArray[index];
    const args = argsArray[index] as unknown;
    try {
      if (op === o.beginAnnotation) {
        annotationDepth += 1;
        continue;
      }
      if (op === o.endAnnotation) {
        annotationDepth = Math.max(0, annotationDepth - 1);
        continue;
      }
      if (annotationDepth > 0) continue;
      if (op === o.save) {
        stack.push({ ...state });
      } else if (op === o.restore) {
        const previous = stack.pop();
        if (previous) state = previous;
      } else if (op === o.transform) {
        const m = toMatrix(args);
        if (m) state = { ...state, ctm: multiply(state.ctm, m) };
      } else if (op === o.setGState) {
        if (Array.isArray(args) && Array.isArray(args[0])) {
          for (const entry of args[0] as unknown[]) {
            if (!Array.isArray(entry)) continue;
            const [key, value] = entry as [unknown, unknown];
            if (key === "ca" && typeof value === "number") state = { ...state, fillAlpha: Math.min(1, Math.max(0, value)) };
            else if (key === "CA" && typeof value === "number") state = { ...state, strokeAlpha: Math.min(1, Math.max(0, value)) };
          }
        }
      } else if (op === o.setFillRGBColor) {
        if (Array.isArray(args) && typeof args[0] === "string") state = { ...state, fillColor: args[0] };
      } else if (op === o.setStrokeRGBColor) {
        if (Array.isArray(args) && typeof args[0] === "string") state = { ...state, strokeColor: args[0] };
      } else if (op === o.beginText) {
        text = { tm: IDENTITY, lm: IDENTITY, leading: text.leading, lastRun: null, lastEnd: null };
      } else if (op === o.endText) {
        text = { ...text, lastRun: null, lastEnd: null };
      } else if (op === o.setFont) {
        if (Array.isArray(args) && typeof args[1] === "number") state = { ...state, fontSize: Math.abs(args[1]) };
      } else if (op === o.setTextRenderingMode) {
        if (Array.isArray(args) && typeof args[0] === "number") state = { ...state, renderMode: args[0] };
      } else if (op === o.setLeading) {
        if (Array.isArray(args) && typeof args[0] === "number") text.leading = args[0];
      } else if (op === o.setTextMatrix) {
        const m = Array.isArray(args) && args.length === 1 ? toMatrix(args[0]) : toMatrix(args);
        if (m) text = { ...text, tm: m, lm: m };
      } else if (op === o.moveText || op === o.setLeadingMoveText) {
        if (Array.isArray(args) && typeof args[0] === "number" && typeof args[1] === "number") {
          if (op === o.setLeadingMoveText) text.leading = -args[1];
          const lm = multiply(text.lm, [1, 0, 0, 1, args[0], args[1]]);
          text = { ...text, tm: lm, lm };
        }
      } else if (op === o.nextLine) {
        const lm = multiply(text.lm, [1, 0, 0, 1, 0, -text.leading]);
        text = { ...text, tm: lm, lm };
      } else if (op === o.showText) {
        const glyphs = Array.isArray(args) ? args[0] : null;
        const { text: letters, advance } = measureGlyphs(glyphs, state.fontSize);
        const full = multiply(state.ctm, text.tm);
        const visible = state.renderMode !== 3 && state.renderMode < 4;
        const alpha = state.renderMode === 1 ? state.strokeAlpha : state.fillAlpha;
        const trimmed = letters.replace(/\s+/g, " ");
        if (visible && trimmed.trim().length > 0 && state.fontSize > 0 && result.textRuns.length < MAX_RUNS) {
          const size = scaleOf(map, full) * state.fontSize;
          const corners: Array<[number, number]> = [
            apply(full, 0, -0.22 * state.fontSize),
            apply(full, Math.max(advance, state.fontSize * 0.3), -0.22 * state.fontSize),
            apply(full, Math.max(advance, state.fontSize * 0.3), 0.85 * state.fontSize),
            apply(full, 0, 0.85 * state.fontSize),
          ].map(([ux, uy]) => map.toView(ux, uy));
          const bbox = boxOfPoints(corners);
          const angleDeg = angleOf(map, full);
          const start = map.toView(...apply(full, 0, 0));
          const previous = text.lastRun;
          let merged = false;
          if (
            previous &&
            text.lastEnd &&
            Math.abs(previous.alpha - alpha) < 0.001 &&
            Math.abs(previous.angleDeg - angleDeg) <= 1 &&
            Math.abs(previous.fontSizePt - size) <= 0.5 &&
            previous.ocIds.join(",") === currentOc().join(",")
          ) {
            const gap = Math.hypot(start[0] - text.lastEnd[0], start[1] - text.lastEnd[1]);
            if (gap <= size * 0.6) {
              previous.text += (gap > size * 0.25 ? " " : "") + trimmed.trim();
              const x0 = Math.min(previous.bbox.x, bbox.x);
              const y0 = Math.min(previous.bbox.y, bbox.y);
              const x1 = Math.max(previous.bbox.x + previous.bbox.width, bbox.x + bbox.width);
              const y1 = Math.max(previous.bbox.y + previous.bbox.height, bbox.y + bbox.height);
              previous.bbox = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
              merged = true;
            }
          }
          if (!merged) {
            const run: TextRun = { text: trimmed.trim(), alpha, angleDeg, fontSizePt: Math.round(size * 10) / 10, bbox, ocIds: currentOc(), count: 1 };
            result.textRuns.push(run);
            text.lastRun = run;
          }
          const endUser = apply(full, advance, 0);
          text.lastEnd = map.toView(endUser[0], endUser[1]);
        }
        text.tm = multiply(text.tm, [1, 0, 0, 1, advance, 0]);
        const frame = frames[0];
        if (frame && visible) {
          frame.hasText = true;
          if (frame.text.length < 80) frame.text += (frame.text ? " " : "") + trimmed.trim();
          addColor(frame, state.fillColor, 2);
          frame.paints += 1;
          const corners: Array<[number, number]> = [apply(full, 0, -0.22 * state.fontSize), apply(full, advance, 0.85 * state.fontSize)];
          extendFrame(frame, corners);
          frame.shape.push(`T${round2(state.fontSize)}`);
        }
      } else if (op === o.beginMarkedContentProps || op === o.beginMarkedContent) {
        const ids: string[] = [];
        if (op === o.beginMarkedContentProps && Array.isArray(args) && args[0] === "OC") {
          const group = args[1] as { type?: string; id?: string; ids?: unknown } | string | null | undefined;
          if (typeof group === "string") ids.push(group);
          else if (group && typeof group === "object") {
            if (typeof group.id === "string") ids.push(group.id);
            if (Array.isArray(group.ids)) for (const id of group.ids) if (typeof id === "string") ids.push(id);
          }
        }
        for (const id of ids) result.ocgRefs.add(id);
        marked.push(ids);
      } else if (op === o.endMarkedContent) {
        marked.pop();
      } else if (op === o.paintFormXObjectBegin) {
        formStates.push({ ...state });
        const m = Array.isArray(args) ? toMatrix(args[0]) : null;
        if (m) state = { ...state, ctm: multiply(state.ctm, m) };
        if (frames.length === 0) {
          frames.push({
            beginIndex: index,
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity,
            colors: new Map(),
            paints: 0,
            curves: 0,
            lines: 0,
            hasText: false,
            text: "",
            shape: [],
            ocIds: new Set(currentOc()),
          });
        } else {
          frames.push(frames[0]);
        }
      } else if (op === o.paintFormXObjectEnd) {
        const previous = formStates.pop();
        if (previous) state = previous;
        const frame = frames.pop();
        if (frame && frames.length === 0 && result.forms.length < MAX_FORMS && frame.maxX >= frame.minX) {
          let best: string | null = null;
          let bestWeight = 0;
          let total = 0;
          for (const [color, weight] of frame.colors) {
            total += weight;
            if (weight > bestWeight) {
              best = color;
              bestWeight = weight;
            }
          }
          result.forms.push({
            beginIndex: frame.beginIndex,
            endIndex: index,
            bbox: { x: frame.minX, y: frame.minY, width: frame.maxX - frame.minX, height: frame.maxY - frame.minY },
            dominantColor: best,
            dominantShare: total > 0 ? bestWeight / total : 0,
            curves: frame.curves,
            lines: frame.lines,
            paints: frame.paints,
            hasText: frame.hasText,
            text: frame.text,
            fingerprint: frame.shape.slice(0, 200).join("|"),
            ocIds: [...frame.ocIds],
          });
        }
      } else if (op === o.constructPath) {
        const frame = frames[0];
        if (frame && Array.isArray(args)) {
          const paintOp = args[0] as number;
          // pdf.js 6 envuelve el trazado en una lista de un elemento: `[ [Float32Array] ]`.
          const rawData = args[1] as unknown;
          const data = (Array.isArray(rawData) && rawData.length === 1 && isMatrixLike(rawData[0]) ? rawData[0] : rawData) as ArrayLike<number> | undefined;
          const bounds = args[2] as ArrayLike<number> | undefined;
          let painted = false;
          let color = state.fillColor;
          if (fillOps.has(paintOp)) {
            painted = true;
            color = state.fillColor;
          } else if (strokeOps.has(paintOp)) {
            painted = true;
            color = state.strokeColor;
          } else if (bothOps.has(paintOp)) {
            painted = true;
            addColor(frame, state.fillColor);
            color = state.strokeColor;
          }
          if (painted) {
            addColor(frame, color);
            frame.paints += 1;
            if (isMatrixLike(bounds) && bounds.length >= 4 && Number.isFinite(bounds[0])) {
              extendFrame(frame, [
                apply(state.ctm, bounds[0], bounds[1]),
                apply(state.ctm, bounds[2], bounds[1]),
                apply(state.ctm, bounds[2], bounds[3]),
                apply(state.ctm, bounds[0], bounds[3]),
              ]);
            }
            let segments = "";
            if (isMatrixLike(data)) {
              for (let i = 0; i < data.length; ) {
                const code = data[i];
                if (code === DRAW.moveTo) {
                  i += 3;
                } else if (code === DRAW.lineTo) {
                  frame.lines += 1;
                  segments += "l";
                  i += 3;
                } else if (code === DRAW.curveTo) {
                  frame.curves += 1;
                  segments += "c";
                  i += 7;
                } else if (code === DRAW.quadraticCurveTo) {
                  frame.curves += 1;
                  segments += "q";
                  i += 5;
                } else {
                  segments += "z";
                  i += 1;
                }
              }
            }
            frame.shape.push(`P${paintOp}${segments}${isMatrixLike(bounds) ? `:${round2(Number(bounds[2]) - Number(bounds[0]))}x${round2(Number(bounds[3]) - Number(bounds[1]))}` : ""}`);
          }
        }
      } else if (op === o.paintImageXObject || op === o.paintInlineImageXObject || op === o.paintImageMaskXObject) {
        if (result.images.length < MAX_IMAGES) {
          const corners: Array<[number, number]> = [apply(state.ctm, 0, 0), apply(state.ctm, 1, 0), apply(state.ctm, 1, 1), apply(state.ctm, 0, 1)].map(([ux, uy]) => map.toView(ux, uy));
          const objectId = op !== o.paintInlineImageXObject && Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
          result.images.push({ objectId, bbox: boxOfPoints(corners), alpha: state.fillAlpha, ocIds: currentOc() });
        }
      }
    } catch {
      // Operador con argumentos inesperados: se salta y se sigue con el resto de la pagina.
    }
  }
  // Fusiona las ejecuciones repetidas (mosaico) en una sola con `count`.
  const merged = new Map<string, TextRun>();
  for (const run of result.textRuns) {
    const key = `${run.text}|${run.alpha.toFixed(3)}|${run.angleDeg.toFixed(0)}|${run.fontSizePt.toFixed(0)}`;
    const existing = merged.get(key);
    if (existing) existing.count += run.count;
    else merged.set(key, { ...run });
  }
  result.textRuns = [...merged.values()];
  return result;
}
