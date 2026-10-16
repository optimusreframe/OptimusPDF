/*
 * Lectura de una pagina de pdf.js para el automapeo: textos con posicion, lineas horizontales finas (trazos y
 * rellenos), cajas, verticales e imagenes, todo en el ESPACIO DE VISTA (con `/Rotate` aplicado), en puntos, con
 * el origen ABAJO-izquierda de la caja de recorte. Misma convencion que `findFillSlots`.
 *
 * Por que no se reutiliza `collectPageGeometry` (detectFields.ts): no aplica la matriz de los XObject de formulario
 * (`paintFormXObjectBegin`), ni separa los subtrazos de un mismo `constructPath` (Word y Acrobat dibujan varias
 * rayas en una sola ruta), ni recoge imagenes, ni gira con la pagina. Aqui se hace aparte; lo demas
 * (`underscoreSegments`, `mergeDashes`, `findFillSlots` y los umbrales de `detectSlots.ts`) si se reutiliza.
 */

import type { PDFPageProxy } from "pdfjs-dist";
import {
  SLOT_MAX_THICKNESS_PT,
  type DashMark,
  type PaintedBox,
  type RawText,
  type Seg,
  type VerticalSeg,
} from "@/lib/pdf/detectSlots";
import type { OpsTable } from "@/lib/pdf/autoMapTypes";

export type ViewGeometry = {
  /** Esquina inferior-izquierda de la caja de recorte en espacio de usuario. */
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  rotation: 0 | 90 | 180 | 270;
  viewWidth: number;
  viewHeight: number;
};

export type ImageBox = { x0: number; y0: number; x1: number; y1: number };

export type PageData = {
  pageIndex: number;
  width: number;
  height: number;
  texts: RawText[];
  /** Rayas horizontales finas: trazos, rellenos finos y marcas ya fundidas (sin los guiones bajos de texto). */
  segments: Seg[];
  dashes: DashMark[];
  verticals: VerticalSeg[];
  boxes: PaintedBox[];
  images: ImageBox[];
  /** Cuantas operaciones se leyeron y si se corto por exceso (pagina decorativa o gigante). */
  opCount: number;
  truncated: boolean;
};

/** Operaciones de una pagina que se leen como mucho (una pagina con mas es un grafico, no un contrato). */
export const MAX_OPS_PER_PAGE = 400_000;
const MAX_DASH_MARKS = 6000;
const MAX_IMAGES = 400;

export function viewGeometryOf(page: PDFPageProxy): ViewGeometry {
  const [x0, y0, x1, y1] = page.view;
  const rotation = ((((Math.round((page.rotate || 0) / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const width = x1 - x0;
  const height = y1 - y0;
  const swapped = rotation === 90 || rotation === 270;
  return {
    boxX: x0,
    boxY: y0,
    boxWidth: width,
    boxHeight: height,
    rotation,
    viewWidth: swapped ? height : width,
    viewHeight: swapped ? width : height,
  };
}

/** Espacio de usuario -> espacio de vista (origen abajo-izquierda), el inverso de `viewPointToUser` de core.ts. */
export function userToView(g: ViewGeometry, x: number, y: number): { x: number; y: number } {
  switch (g.rotation) {
    case 90:
      return { x: y - g.boxY, y: g.boxX + g.boxWidth - x };
    case 180:
      return { x: g.boxX + g.boxWidth - x, y: g.boxY + g.boxHeight - y };
    case 270:
      return { x: g.boxY + g.boxHeight - y, y: x - g.boxX };
    default:
      return { x: x - g.boxX, y: y - g.boxY };
  }
}

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function compose(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = inner;
  const [a2, b2, c2, d2, e2, f2] = outer;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ];
}

function hexLuminance(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) return undefined;
  const [r, g, b] = [match[1], match[2], match[3]].map((hex) => parseInt(hex, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const QUAD = 3;
const CLOSE = 4;

type SubPath = { xs: number[]; ys: number[]; closed: boolean; curved: boolean };

/** Descompone los comandos de un `constructPath` de pdf.js (v5+: `[op, [Float32Array], minMax]`) en subtrazos. */
function subPathsOf(data: unknown): SubPath[] | null {
  let cmds: ArrayLike<number> | undefined;
  if (Array.isArray(data) && data.length > 0 && data[0] && typeof (data[0] as ArrayLike<number>).length === "number") {
    cmds = data[0] as ArrayLike<number>;
  } else if (data && typeof (data as ArrayLike<number>).length === "number") {
    cmds = data as ArrayLike<number>;
  }
  if (!cmds || cmds.length === 0) return null;
  const out: SubPath[] = [];
  let current: SubPath | null = null;
  for (let i = 0; i < cmds.length; ) {
    const op = cmds[i];
    if (op === MOVE) {
      current = { xs: [cmds[i + 1]], ys: [cmds[i + 2]], closed: false, curved: false };
      out.push(current);
      i += 3;
    } else if (op === LINE) {
      if (!current) {
        current = { xs: [], ys: [], closed: false, curved: false };
        out.push(current);
      }
      current.xs.push(cmds[i + 1]);
      current.ys.push(cmds[i + 2]);
      i += 3;
    } else if (op === CURVE) {
      if (!current) return null;
      current.xs.push(cmds[i + 5]);
      current.ys.push(cmds[i + 6]);
      current.curved = true;
      i += 7;
    } else if (op === QUAD) {
      if (!current) return null;
      current.xs.push(cmds[i + 3]);
      current.ys.push(cmds[i + 4]);
      current.curved = true;
      i += 5;
    } else if (op === CLOSE) {
      if (current) current.closed = true;
      i += 1;
    } else {
      return null;
    }
  }
  return out;
}

/** Cede el control al hilo principal (para no bloquear la interfaz con paginas grandes). */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (scheduler?.yield) {
      void scheduler.yield().then(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export type CollectContext = {
  yieldEveryMs: number;
  now: () => number;
  signal?: AbortSignal;
};

export function throwIfAbortedSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Automapeo cancelado", "AbortError");
}

export async function readPageTexts(page: PDFPageProxy, g: ViewGeometry): Promise<RawText[]> {
  const content = await page.getTextContent();
  const out: RawText[] = [];
  for (const item of content.items) {
    if (!("str" in item) || item.str.trim().length === 0) continue;
    const t = item.transform as number[];
    const dirX = t[0];
    const dirY = t[1];
    const dirLength = Math.hypot(dirX, dirY) || 1;
    const start = userToView(g, t[4], t[5]);
    const end = userToView(g, t[4] + (item.width * dirX) / dirLength, t[5] + (item.width * dirY) / dirLength);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    // Texto girado o vertical en la VISTA: no sirve de etiqueta de una raya horizontal.
    if (Math.abs(dy) > 0.1 * Math.max(Math.abs(dx), 0.01) || dx < 0) continue;
    const height = item.height || Math.hypot(t[2], t[3]) || 10;
    out.push({
      text: item.str.trim(),
      raw: item.str,
      left: start.x,
      right: end.x,
      baseline: start.y,
      height,
    });
  }
  return out;
}

/**
 * Lee la geometria vectorial de una pagina. Los umbrales de forma escalan con el ancho de la pagina (carta = 1).
 */
export async function readPageGraphics(
  page: PDFPageProxy,
  g: ViewGeometry,
  ops: OpsTable,
  context: CollectContext,
): Promise<Pick<PageData, "segments" | "dashes" | "verticals" | "boxes" | "images" | "opCount" | "truncated">> {
  const operatorList = await page.getOperatorList();
  // Escala de la PAGINA (no del texto): los umbrales de forma son fracciones del ancho de una carta (612 pt).
  const sc = Math.max(g.viewWidth, 1) / 612;
  const maxThin = SLOT_MAX_THICKNESS_PT * sc;
  const segments: Seg[] = [];
  const dashes: DashMark[] = [];
  const verticals: VerticalSeg[] = [];
  const boxes: PaintedBox[] = [];
  const images: ImageBox[] = [];

  const strokeOps = new Set([ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const fillOps = new Set([ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const paintOps = new Set([...strokeOps, ...fillOps]);
  const imageOps = new Set(
    [ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject, ops.paintImageXObjectRepeat].filter(
      (value): value is number => typeof value === "number",
    ),
  );

  const stack: Array<{ matrix: Matrix; lineWidth: number; shade: number; dashed: boolean }> = [];
  let current: Matrix = IDENTITY;
  let lineWidth = 1;
  let shade = 0;
  let dashed = false;
  let truncated = false;
  const total = Math.min(operatorList.fnArray.length, MAX_OPS_PER_PAGE);
  if (operatorList.fnArray.length > MAX_OPS_PER_PAGE) truncated = true;
  let sliceStart = context.now();

  const toView = (m: Matrix, x: number, y: number) => userToView(g, m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  const detScale = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

  for (let index = 0; index < total; index += 1) {
    if ((index & 0x3ff) === 0 && context.now() - sliceStart > context.yieldEveryMs) {
      await yieldToMain();
      throwIfAbortedSignal(context.signal);
      sliceStart = context.now();
    }
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    if (fn === ops.save) {
      stack.push({ matrix: current, lineWidth, shade, dashed });
      continue;
    }
    if (fn === ops.restore) {
      const top = stack.pop();
      current = top?.matrix ?? IDENTITY;
      lineWidth = top?.lineWidth ?? 1;
      shade = top?.shade ?? 0;
      dashed = top?.dashed ?? false;
      continue;
    }
    if (fn === ops.transform) {
      const m = args as number[];
      if (m?.length === 6) current = compose(current, m as unknown as Matrix);
      continue;
    }
    if (ops.paintFormXObjectBegin !== undefined && fn === ops.paintFormXObjectBegin) {
      stack.push({ matrix: current, lineWidth, shade, dashed });
      const m = (Array.isArray(args) ? args[0] : null) as number[] | null;
      if (m && m.length === 6) current = compose(current, m as unknown as Matrix);
      continue;
    }
    if (ops.paintFormXObjectEnd !== undefined && fn === ops.paintFormXObjectEnd) {
      const top = stack.pop();
      current = top?.matrix ?? IDENTITY;
      lineWidth = top?.lineWidth ?? 1;
      shade = top?.shade ?? 0;
      dashed = top?.dashed ?? false;
      continue;
    }
    if (ops.setLineWidth !== undefined && fn === ops.setLineWidth) {
      const value = Array.isArray(args) ? Number(args[0]) : Number.NaN;
      if (Number.isFinite(value)) lineWidth = value;
      continue;
    }
    if (ops.setDash !== undefined && fn === ops.setDash) {
      const pattern = Array.isArray(args) && Array.isArray(args[0]) ? (args[0] as number[]) : [];
      dashed = pattern.some((value) => value > 0);
      continue;
    }
    if (ops.setFillRGBColor !== undefined && fn === ops.setFillRGBColor) {
      shade = hexLuminance(Array.isArray(args) ? args[0] : undefined) ?? shade;
      continue;
    }
    if (imageOps.has(fn)) {
      if (images.length < MAX_IMAGES) {
        const corners = [toView(current, 0, 0), toView(current, 1, 0), toView(current, 0, 1), toView(current, 1, 1)];
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        images.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
      }
      continue;
    }
    if (ops.paintSolidColorImageMask !== undefined && fn === ops.paintSolidColorImageMask) {
      // Rellena el cuadrado unidad con el color vigente: algunos exportadores dibujan asi las rayas.
      const a = toView(current, 0, 0);
      const b = toView(current, 1, 1);
      pushRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), true, false, 0);
      continue;
    }
    if (fn !== ops.constructPath) continue;

    const [paintOp, data, minMax] = args as [number, unknown, ArrayLike<number> | undefined];
    if (!paintOps.has(paintOp)) continue;
    const stroked = strokeOps.has(paintOp);
    const filled = fillOps.has(paintOp);
    const strokeWidth = stroked ? lineWidth * detScale(current) : 0;

    const sub = subPathsOf(data);
    if (sub) {
      for (const path of sub) {
        if (path.xs.length === 0) continue;
        // Bucle (no `Math.min(...xs)`): una ruta de miles de puntos desbordaria la pila de llamadas.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let k = 0; k < path.xs.length; k += 1) {
          const point = toView(current, path.xs[k], path.ys[k]);
          if (point.x < minX) minX = point.x;
          if (point.x > maxX) maxX = point.x;
          if (point.y < minY) minY = point.y;
          if (point.y > maxY) maxY = point.y;
        }
        classify(minX, minY, maxX, maxY, path, stroked, filled, strokeWidth);
      }
    } else if (minMax && minMax.length >= 4) {
      const [minX, minY, maxX, maxY] = Array.from(minMax);
      if ([minX, minY, maxX, maxY].every(Number.isFinite)) {
        const corners = [toView(current, minX, minY), toView(current, maxX, minY), toView(current, minX, maxY), toView(current, maxX, maxY)];
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        classify(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), null, stroked, filled, strokeWidth);
      }
    }
  }

  function pushRect(x0: number, y0: number, x1: number, y1: number, filled: boolean, stroked: boolean, shadeValue: number) {
    const width = x1 - x0;
    const height = y1 - y0;
    if (height <= maxThin && width >= 30 * sc) {
      segments.push({ x0, x1, y: (y0 + y1) / 2, thickness: Math.max(height, 0.1), fromText: -1 });
    } else if (width <= maxThin && height >= 8 * sc) {
      verticals.push({ x: (x0 + x1) / 2, y0, y1 });
    } else if (width > maxThin && height > maxThin) {
      boxes.push({ x0, y0, x1, y1, fill: filled, stroke: stroked, shade: filled ? shadeValue : undefined });
    }
  }

  function classify(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    path: SubPath | null,
    stroked: boolean,
    filled: boolean,
    strokeWidth: number,
  ) {
    const width = x1 - x0;
    const height = y1 - y0;
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const pointCount = path ? path.xs.length : 4;
    const rectLike = path ? !path.curved && pointCount <= 5 : true;
    if (height <= maxThin && width >= 30 * sc && rectLike) {
      // Una raya: trazo de una linea (o rectangulo muy bajo relleno / trazado).
      const thickness = Math.max(height, stroked ? strokeWidth : 0, 0.1);
      segments.push({ x0, x1, y: (y0 + y1) / 2, thickness, fromText: -1, dashed: stroked && dashed });
      return;
    }
    if (width <= maxThin && height >= 8 * sc && rectLike) {
      verticals.push({ x: (x0 + x1) / 2, y0, y1 });
      return;
    }
    if (width > maxThin && height > maxThin && rectLike) {
      boxes.push({ x0, y0, x1, y1, fill: filled, stroke: stroked, shade: filled ? shade : undefined });
      return;
    }
    if (height <= maxThin && width > 0.05 && dashes.length < MAX_DASH_MARKS) {
      dashes.push({ x0, x1, y: (y0 + y1) / 2, thickness: Math.max(height, strokeWidth) });
    }
  }

  return { segments, dashes, verticals, boxes, images, opCount: total, truncated };
}

/** Texto + geometria de una pagina. */
export async function collectPage(
  page: PDFPageProxy,
  pageIndex: number,
  ops: OpsTable,
  context: CollectContext,
): Promise<{ data: PageData; geometry: ViewGeometry }> {
  const geometry = viewGeometryOf(page);
  const texts = await readPageTexts(page, geometry);
  throwIfAbortedSignal(context.signal);
  const graphics = await readPageGraphics(page, geometry, ops, context);
  return {
    geometry,
    data: { pageIndex, width: geometry.viewWidth, height: geometry.viewHeight, texts, ...graphics },
  };
}
