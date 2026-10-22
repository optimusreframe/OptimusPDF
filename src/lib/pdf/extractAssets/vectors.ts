/**
 * Firmas DIBUJADAS COMO VECTORES en el contenido de la pagina (U7.3, BETA): recorre la lista de operadores de pdf.js (`constructPath`
 * con los `DrawOPS` de pdf.js 6: moveTo, lineTo, curveTo, quadraticCurveTo, closePath), reune los trazos por cercania y calcula los
 * rasgos de cada grupo (curvas, bucles, cuanto de recto hay, grosor, color, si esta sobre una raya de firma). Aqui NO se decide si
 * es una firma: `classifyVectors.ts` lo decide con el texto cercano. Funcion pura sobre `fnArray`/`argsArray`: no toca pdf.js.
 *
 * Falsos positivos que se evitan de entrada: tablas y cuadros (todos los segmentos horizontales o verticales), la linea de firma
 * (una recta: no cuenta como trazo; sirve para `onLine`), graficos y mapas (mas de `MAX_PATHS` rutas), rellenos grandes y blancos.
 */

import type { PageVectors, VectorCandidate, VectorPath } from "./classifyTypes";

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** `DrawOPS` de pdf.js 6 (se comprueba contra `pdfjs.DrawOPS` en las pruebas del navegador). */
export const DRAW_OPS = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

export type VectorOps = Record<string, number>;

/** Rutas que se analizan como mucho por pagina: mas es un grafico, un mapa o un plano, no una firma. */
export const MAX_PATHS = 6000;
/** Distancia (puntos) bajo la cual dos trazos son del mismo grupo. */
export const GROUP_GAP_PT = 14;
/** Un grupo mas grande que esto (fraccion de la pagina) no es una firma. */
export const MAX_GROUP_WIDTH = 0.6;
export const MAX_GROUP_HEIGHT = 0.25;
/** Candidatas que se guardan como mucho por pagina. */
export const MAX_CANDIDATES_PER_PAGE = 12;
/** Un trazo claro (luminancia > esto) no es tinta de firma. */
export const MAX_STROKE_LUMA = 235;
/** Tolerancia (puntos) para llamar «horizontal» o «vertical» a un segmento. */
const AXIS_TOLERANCE_PT = 0.6;
/** Un segmento recto solo cuenta como horizontal/vertical si mide al menos esto (puntos). */
const MIN_AXIS_SEGMENT_PT = 3;
/** Un trazado cerrado de pocos segmentos y menos de esto es un marcador (circulo, cuadro). */
export const MAX_SHAPE_SEGMENTS = 8;
export const MAX_SHAPE_SIZE_PT = 22;
/** Una raya de firma mide al menos esto (puntos). */
export const MIN_LINE_LENGTH_PT = 30;
/** Comandos que se guardan por candidata para volver a dibujarla. */
const MAX_COMMANDS_PER_CANDIDATE = 6000;

type ViewMapper = { toView(x: number, y: number): [number, number] };

type PathRecord = {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  commands: Array<readonly [string, ...number[]]>;
  curves: number;
  segments: number;
  axis: number;
  /** Segmentos rectos diminutos (menos de `MIN_AXIS_SEGMENT_PT`). */
  tiny: number;
  /** El trazado se cierra (`closePath`). */
  closed: boolean;
  xRev: number;
  yRev: number;
  stroke: boolean;
  fill: boolean;
  color: string;
  lineWidth: number;
  length: number;
};

type GState = { ctm: Matrix; strokeColor: string; fillColor: string; lineWidth: number };

function hexLuma(hex: string): number {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return 0;
  return 0.2126 * parseInt(match[1], 16) + 0.7152 * parseInt(match[2], 16) + 0.0722 * parseInt(match[3], 16);
}

function toMatrix(value: unknown): Matrix | null {
  if (!value || typeof value !== "object" || typeof (value as ArrayLike<number>).length !== "number") return null;
  const source = value as ArrayLike<number>;
  if (source.length < 6) return null;
  const m = [source[0], source[1], source[2], source[3], source[4], source[5]];
  return m.every((n) => Number.isFinite(n)) ? (m as Matrix) : null;
}

/** Puntos de una curva cubica a t = 0,25 / 0,5 / 0,75 y al final (para contar cambios de sentido sin muestrear todo). */
function cubicSamples(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const t of [0.25, 0.5, 0.75, 1]) {
    const u = 1 - t;
    out.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
  }
  return out;
}

function countReversals(points: ReadonlyArray<readonly [number, number]>, axis: 0 | 1): number {
  let reversals = 0;
  let direction = 0;
  for (let i = 1; i < points.length; i += 1) {
    const delta = points[i][axis] - points[i - 1][axis];
    if (Math.abs(delta) < 0.25) continue;
    const sign = delta > 0 ? 1 : -1;
    if (direction !== 0 && sign !== direction) reversals += 1;
    direction = sign;
  }
  return reversals;
}

/** Convierte los comandos de `constructPath` a un registro en puntos de VISTA. `null` si no trae nada pintable. */
function recordPath(data: ArrayLike<number>, ctm: Matrix, map: ViewMapper, paint: { stroke: boolean; fill: boolean; color: string; lineWidth: number }): { record: PathRecord; horizontals: Array<{ x0: number; x1: number; y: number }> } | null {
  const commands: Array<readonly [string, ...number[]]> = [];
  const horizontals: Array<{ x0: number; x1: number; y: number }> = [];
  let curves = 0;
  let segments = 0;
  let axis = 0;
  let tiny = 0;
  let closed = false;
  let xRev = 0;
  let yRev = 0;
  let length = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let sub: Array<[number, number]> = [];
  let startPoint: [number, number] | null = null;
  let last: [number, number] | null = null;
  const to = (ux: number, uy: number): [number, number] => {
    const px = ctm[0] * ux + ctm[2] * uy + ctm[4];
    const py = ctm[1] * ux + ctm[3] * uy + ctm[5];
    return map.toView(px, py);
  };
  const extend = (p: readonly [number, number]): void => {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  };
  const flushSub = (): void => {
    if (sub.length > 1) {
      xRev += countReversals(sub, 0);
      yRev += countReversals(sub, 1);
    }
    sub = [];
  };
  const segment = (from: [number, number], dest: [number, number], curved: boolean): void => {
    segments += 1;
    length += Math.hypot(dest[0] - from[0], dest[1] - from[1]);
    if (!curved) {
      const dx = Math.abs(dest[0] - from[0]);
      const dy = Math.abs(dest[1] - from[1]);
      // Un tramo diminuto (tinta digital) no cuenta como recto: solo las rectas de verdad (cuadros, tablas, rayas).
      if (Math.hypot(dx, dy) < MIN_AXIS_SEGMENT_PT) tiny += 1;
      else if (dx <= AXIS_TOLERANCE_PT || dy <= AXIS_TOLERANCE_PT) {
        axis += 1;
        if (dy <= AXIS_TOLERANCE_PT && dx >= 1) horizontals.push({ x0: Math.min(from[0], dest[0]), x1: Math.max(from[0], dest[0]), y: (from[1] + dest[1]) / 2 });
      }
    }
  };

  for (let i = 0; i < data.length; ) {
    const code = data[i];
    if (code === DRAW_OPS.moveTo) {
      flushSub();
      const p = to(data[i + 1], data[i + 2]);
      commands.push(["M", p[0], p[1]]);
      extend(p);
      sub.push(p);
      startPoint = p;
      last = p;
      i += 3;
    } else if (code === DRAW_OPS.lineTo) {
      const p = to(data[i + 1], data[i + 2]);
      if (last) segment(last, p, false);
      commands.push(["L", p[0], p[1]]);
      extend(p);
      sub.push(p);
      last = p;
      i += 3;
    } else if (code === DRAW_OPS.curveTo) {
      const c1 = to(data[i + 1], data[i + 2]);
      const c2 = to(data[i + 3], data[i + 4]);
      const p = to(data[i + 5], data[i + 6]);
      if (last) {
        segment(last, p, true);
        for (const sample of cubicSamples(last[0], last[1], c1[0], c1[1], c2[0], c2[1], p[0], p[1])) sub.push(sample);
      }
      curves += 1;
      commands.push(["C", c1[0], c1[1], c2[0], c2[1], p[0], p[1]]);
      extend(c1);
      extend(c2);
      extend(p);
      last = p;
      i += 7;
    } else if (code === DRAW_OPS.quadraticCurveTo) {
      const c = to(data[i + 1], data[i + 2]);
      const p = to(data[i + 3], data[i + 4]);
      if (last) {
        segment(last, p, true);
        sub.push([(last[0] + 2 * c[0] + p[0]) / 4, (last[1] + 2 * c[1] + p[1]) / 4], p);
      }
      curves += 1;
      commands.push(["Q", c[0], c[1], p[0], p[1]]);
      extend(c);
      extend(p);
      last = p;
      i += 5;
    } else if (code === DRAW_OPS.closePath) {
      if (last && startPoint) segment(last, startPoint, false);
      closed = true;
      commands.push(["Z"]);
      last = startPoint;
      i += 1;
    } else {
      return null;
    }
  }
  flushSub();
  if (commands.length === 0 || !Number.isFinite(x0)) return null;
  return {
    record: { bbox: { x0, y0, x1, y1 }, commands, curves, segments, axis, tiny, closed, xRev, yRev, stroke: paint.stroke, fill: paint.fill, color: paint.color, lineWidth: paint.lineWidth, length },
    horizontals,
  };
}

export type ScanOptions = { maxPaths?: number };

export type VectorScan = {
  candidates: VectorCandidate[];
  /** Rayas horizontales largas (candidatas a raya de firma), en puntos de vista. */
  lines: Array<{ x0: number; x1: number; y: number }>;
  /** `true` si la pagina tenia tantas rutas que se descarto (grafico, mapa, plano). */
  skipped: boolean;
  paths: number;
};

type Union = { parent: number[] };
function find(u: Union, i: number): number {
  let root = i;
  while (u.parent[root] !== root) root = u.parent[root];
  while (u.parent[i] !== root) {
    const next = u.parent[i];
    u.parent[i] = root;
    i = next;
  }
  return root;
}

/**
 * Recorre una pagina y devuelve las candidatas a firma vectorial. `pageWidth`/`pageHeight` en puntos de vista.
 * Nunca lanza por datos raros: un operador con argumentos que no encajen se salta.
 */
export function scanVectors(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: VectorOps, map: ViewMapper, pageIndex: number, pageWidth: number, pageHeight: number, options: ScanOptions = {}): VectorScan {
  const maxPaths = options.maxPaths ?? MAX_PATHS;
  const records: PathRecord[] = [];
  const lines: Array<{ x0: number; x1: number; y: number }> = [];
  let state: GState = { ctm: IDENTITY, strokeColor: "#000000", fillColor: "#000000", lineWidth: 1 };
  const stack: GState[] = [];
  const formStack: GState[] = [];
  let annotationDepth = 0;
  let total = 0;
  let skipped = false;
  const strokeOps = new Set([ops.stroke, ops.closeStroke].filter((n) => n !== undefined));
  const fillOps = new Set([ops.fill, ops.eoFill].filter((n) => n !== undefined));
  const bothOps = new Set([ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke].filter((n) => n !== undefined));

  for (let index = 0; index < fnArray.length; index += 1) {
    const op = fnArray[index];
    const args = argsArray[index] as unknown;
    try {
      if (op === ops.beginAnnotation) {
        annotationDepth += 1;
      } else if (op === ops.endAnnotation) {
        annotationDepth = Math.max(0, annotationDepth - 1);
      } else if (annotationDepth > 0) {
        continue;
      } else if (op === ops.save) {
        stack.push({ ...state });
      } else if (op === ops.restore) {
        const previous = stack.pop();
        if (previous) state = previous;
      } else if (op === ops.transform) {
        const m = toMatrix(args);
        if (m) state = { ...state, ctm: multiply(state.ctm, m) };
      } else if (op === ops.paintFormXObjectBegin) {
        formStack.push({ ...state });
        const m = Array.isArray(args) ? toMatrix(args[0]) : null;
        if (m) state = { ...state, ctm: multiply(state.ctm, m) };
      } else if (op === ops.paintFormXObjectEnd) {
        const previous = formStack.pop();
        if (previous) state = previous;
      } else if (op === ops.setLineWidth) {
        if (Array.isArray(args) && typeof args[0] === "number") state = { ...state, lineWidth: Math.abs(args[0]) };
      } else if (op === ops.setGState) {
        if (Array.isArray(args) && Array.isArray(args[0])) {
          for (const entry of args[0] as unknown[]) {
            if (Array.isArray(entry) && entry[0] === "LW" && typeof entry[1] === "number") state = { ...state, lineWidth: Math.abs(entry[1]) };
          }
        }
      } else if (op === ops.setStrokeRGBColor) {
        if (Array.isArray(args) && typeof args[0] === "string") state = { ...state, strokeColor: args[0] };
      } else if (op === ops.setFillRGBColor) {
        if (Array.isArray(args) && typeof args[0] === "string") state = { ...state, fillColor: args[0] };
      } else if (op === ops.constructPath && Array.isArray(args)) {
        const paintOp = args[0] as number;
        const stroke = strokeOps.has(paintOp) || bothOps.has(paintOp);
        const fill = fillOps.has(paintOp) || bothOps.has(paintOp);
        if (!stroke && !fill) continue;
        total += 1;
        if (total > maxPaths) {
          skipped = true;
          break;
        }
        const raw = args[1] as unknown;
        const data = (Array.isArray(raw) && raw.length === 1 && raw[0] && typeof (raw[0] as ArrayLike<number>).length === "number" ? raw[0] : raw) as ArrayLike<number> | undefined;
        if (!data || typeof data.length !== "number") continue;
        const scale = Math.sqrt(Math.abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2]));
        const color = stroke ? state.strokeColor : state.fillColor;
        const made = recordPath(data, state.ctm, map, { stroke, fill: fill && !stroke, color, lineWidth: stroke ? state.lineWidth * scale : 0 });
        if (!made) continue;
        const { record, horizontals } = made;
        // Cuadros, tablas y rayas: todo horizontal/vertical. Las rayas largas se guardan (raya de firma) y no cuentan como trazo.
        if (record.curves === 0 && record.axis >= 1 && record.axis + record.tiny === record.segments) {
          for (const line of horizontals) if (line.x1 - line.x0 >= MIN_LINE_LENGTH_PT) lines.push(line);
          continue;
        }
        // Una recta suelta (diagonal o no) no es un trazo de firma.
        if (record.segments <= 1) continue;
        if (hexLuma(record.color) > MAX_STROKE_LUMA) continue;
        const w = record.bbox.x1 - record.bbox.x0;
        const h = record.bbox.y1 - record.bbox.y0;
        if (w > pageWidth * MAX_GROUP_WIDTH || h > pageHeight * MAX_GROUP_HEIGHT) continue;
        records.push(record);
      }
    } catch {
      // Operador con argumentos inesperados: se salta.
    }
  }
  if (skipped) return { candidates: [], lines, skipped: true, paths: total };

  // Agrupar por cercania (barrido por x).
  const order = records.map((_, i) => i).sort((a, b) => records[a].bbox.x0 - records[b].bbox.x0);
  const union: Union = { parent: records.map((_, i) => i) };
  const active: number[] = [];
  for (const i of order) {
    const a = records[i].bbox;
    for (let k = active.length - 1; k >= 0; k -= 1) {
      const other = records[active[k]].bbox;
      if (other.x1 + GROUP_GAP_PT < a.x0) {
        active.splice(k, 1);
        continue;
      }
      if (a.y0 - GROUP_GAP_PT <= other.y1 && other.y0 - GROUP_GAP_PT <= a.y1) {
        const ra = find(union, i);
        const rb = find(union, active[k]);
        if (ra !== rb) union.parent[rb] = ra;
      }
    }
    active.push(i);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < records.length; i += 1) {
    const root = find(union, i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const candidates: VectorCandidate[] = [];
  for (const members of groups.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let curves = 0;
    let segments = 0;
    let axis = 0;
    let xRev = 0;
    let yRev = 0;
    const widths: number[] = [];
    const colorWeight = new Map<string, number>();
    const paths: VectorPath[] = [];
    let shapes = 0;
    let commandBudget = MAX_COMMANDS_PER_CANDIDATE;
    for (const memberIndex of members) {
      const r = records[memberIndex];
      x0 = Math.min(x0, r.bbox.x0);
      y0 = Math.min(y0, r.bbox.y0);
      x1 = Math.max(x1, r.bbox.x1);
      y1 = Math.max(y1, r.bbox.y1);
      // Marcadores de un grafico (circulos, cuadros, triangulos): trazados CERRADOS y chicos.
      if (r.closed && r.segments <= MAX_SHAPE_SEGMENTS && r.bbox.x1 - r.bbox.x0 <= MAX_SHAPE_SIZE_PT && r.bbox.y1 - r.bbox.y0 <= MAX_SHAPE_SIZE_PT) shapes += 1;
      curves += r.curves;
      segments += r.segments;
      axis += r.axis;
      xRev += r.xRev;
      yRev += r.yRev;
      if (r.stroke) widths.push(r.lineWidth);
      colorWeight.set(r.color, (colorWeight.get(r.color) ?? 0) + Math.max(1, r.length));
      if (commandBudget > 0) {
        paths.push({ commands: r.commands.slice(0, commandBudget), stroke: r.stroke, fill: r.fill, color: r.color, lineWidth: r.lineWidth });
        commandBudget -= r.commands.length;
      }
    }
    const width = x1 - x0;
    const height = y1 - y0;
    if (width < 8 || height < 4) continue;
    if (width > pageWidth * MAX_GROUP_WIDTH || height > pageHeight * MAX_GROUP_HEIGHT) continue;
    // Prefiltro barato: una firma tiene muchas curvas o muchos segmentos cortos.
    if (curves + segments < 8) continue;
    let color = "#000000";
    let best = -1;
    for (const [value, weight] of colorWeight) {
      if (weight > best) {
        best = weight;
        color = value;
      }
    }
    widths.sort((a, b) => a - b);
    candidates.push({
      pageIndex,
      bbox: { x: x0, y: y0, width, height },
      rect: { x: Math.max(0, x0 / pageWidth), y: Math.max(0, y0 / pageHeight), width: Math.min(1, width / pageWidth), height: Math.min(1, height / pageHeight) },
      curves,
      segments,
      strokes: members.length,
      shapeShare: shapes / members.length,
      xReversals: xRev,
      yReversals: yRev,
      axisAligned: segments > 0 ? axis / segments : 1,
      strokeWidth: widths.length > 0 ? widths[Math.floor(widths.length / 2)] : 0,
      color,
      paths,
    });
  }
  candidates.sort((a, b) => b.curves + b.segments - (a.curves + a.segments));
  return { candidates: candidates.slice(0, MAX_CANDIDATES_PER_PAGE), lines, skipped: false, paths: total };
}

/** Agrupa en `PageVectors` (con la raya de firma ya resuelta en cada candidata) para el clasificador. */
export function toPageVectors(pageIndex: number, scan: VectorScan): PageVectors {
  return { pageIndex, candidates: scan.candidates, lines: scan.lines };
}

/**
 * ¿Hay una raya horizontal larga justo debajo del grupo (o cruzando su parte baja) que lo cubre por lo menos a medias? Es la raya de
 * firma de los formularios: una firma encima de una linea es una senal fuerte.
 */
/** Hasta donde (puntos) por debajo de la firma se busca la raya. */
export const SIGN_LINE_REACH_PT = 24;

export function sitsOnLine(bbox: { x: number; y: number; width: number; height: number }, lines: ReadonlyArray<{ x0: number; x1: number; y: number }>): boolean {
  const bottom = bbox.y + bbox.height;
  for (const line of lines) {
    if (line.y < bbox.y + bbox.height * 0.55 || line.y > bottom + SIGN_LINE_REACH_PT) continue;
    const overlap = Math.min(bbox.x + bbox.width, line.x1) - Math.max(bbox.x, line.x0);
    if (overlap >= bbox.width * 0.5 && line.x1 - line.x0 >= bbox.width * 0.6) return true;
  }
  return false;
}
