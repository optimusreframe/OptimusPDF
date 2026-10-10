import type { PageMetrics, PxRect, ResizeHandle } from "@/app/edit-pdf/editCanvasMath";
import { TAP_MOVE_THRESHOLD_PX } from "@/app/edit-pdf/editCanvasMath";
import {
  imageAddOp,
  newEditId,
  type EditImageItem,
  type EditImageRef,
  type EditItem,
  type EditOp,
  type EditShapeElement,
  type EditShapeItem,
  type LinePoints,
} from "@/app/edit-pdf/editSession";
import {
  MIN_ELEMENT_SIDE,
  MIN_LINE_LENGTH,
  type CheckElement,
  type EditStyle,
  type ImageElement,
  type LineElement,
} from "@/lib/pdf/editPdf";

/**
 * Geometria y constructores PUROS de los elementos que se anaden a mano
 * (imagen, rectangulo, elipse, linea, resaltado y marca; W5-U4b).
 *
 * Sus coordenadas son las del motor `editPdf.ts`: fracciones 0..1 de la pagina
 * COMO SE VE (origen arriba a la izquierda, con `/Rotate` ya aplicado). Por eso
 * pasar de pixeles de la hoja a coordenadas del elemento es solo dividir entre
 * `cssWidth`/`cssHeight`, sin tocar la geometria del PDF.
 *
 * Limites heredados del editor anterior: `MIN_ELEMENT_SIDE` (lado minimo de una
 * caja), `MIN_LINE_LENGTH` (largo minimo de una linea), el trazo, la opacidad y
 * el simbolo de la marca. La marca nace de un clic con un tamano fijo
 * (`DEFAULT_CHECK_WIDTH`), como una casilla marcada.
 */

export type DrawTool = "rect" | "ellipse" | "line" | "highlight" | "check";

export const DRAW_TOOLS: readonly DrawTool[] = ["rect", "ellipse", "line", "highlight", "check"];

export function isDrawTool(tool: string): tool is DrawTool {
  return (DRAW_TOOLS as readonly string[]).includes(tool);
}

/** Ancho inicial de una imagen y lado de la marca de un clic, en fraccion de ancho de pagina. */
export const DEFAULT_IMAGE_WIDTH = 0.3;
export const DEFAULT_CHECK_WIDTH = 0.035;
/** Una imagen colocada no ocupa mas que esto del alto de la pagina. */
export const MAX_IMAGE_HEIGHT = 0.9;
/** Tamano (puntos PDF) de lo que crea un toque sin arrastrar. */
export const TAP_SIZE_PT: Record<"rect" | "ellipse" | "line" | "highlight", { width: number; height: number }> = {
  rect: { width: 140, height: 90 },
  ellipse: { width: 140, height: 90 },
  line: { width: 140, height: 0 },
  highlight: { width: 160, height: 16 },
};
/** Pixeles minimos del lado de un elemento para mostrar los cuatro tiradores. */
export const SMALL_ELEMENT_PX = 48;

export type NormPoint = { x: number; y: number };
export type NormBox = { x: number; y: number; width: number; height: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Punto en px de la hoja -> fraccion 0..1 (recortado a la pagina). */
export function pxToNorm(metrics: PageMetrics, point: { x: number; y: number }): NormPoint {
  return {
    x: clamp01(point.x / metrics.cssWidth),
    y: clamp01(point.y / metrics.cssHeight),
  };
}

export function normBoxToPx(metrics: PageMetrics, box: NormBox): PxRect {
  return {
    left: box.x * metrics.cssWidth,
    top: box.y * metrics.cssHeight,
    width: box.width * metrics.cssWidth,
    height: box.height * metrics.cssHeight,
  };
}

export function pxRectToNormBox(metrics: PageMetrics, rect: PxRect): NormBox {
  return {
    x: rect.left / metrics.cssWidth,
    y: rect.top / metrics.cssHeight,
    width: rect.width / metrics.cssWidth,
    height: rect.height / metrics.cssHeight,
  };
}

/** Extremos de una linea en px de la hoja. */
export function linePxPoints(
  metrics: PageMetrics,
  line: Pick<LineElement, "x1" | "y1" | "x2" | "y2">,
): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: line.x1 * metrics.cssWidth,
    y1: line.y1 * metrics.cssHeight,
    x2: line.x2 * metrics.cssWidth,
    y2: line.y2 * metrics.cssHeight,
  };
}

/** Caja envolvente (px) de un elemento cualquiera, linea incluida. */
export function elementPxRect(metrics: PageMetrics, element: EditShapeElement | EditImageRef): PxRect {
  if (element.type === "line") {
    const p = linePxPoints(metrics, element);
    return {
      left: Math.min(p.x1, p.x2),
      top: Math.min(p.y1, p.y2),
      width: Math.abs(p.x2 - p.x1),
      height: Math.abs(p.y2 - p.y1),
    };
  }
  return normBoxToPx(metrics, element);
}

/* ------------------------------------------------------------------ *
 * Creacion
 * ------------------------------------------------------------------ */

/** El movimiento (px) entre dos puntos es un toque, no un arrastre. */
export function isTap(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) <= TAP_MOVE_THRESHOLD_PX;
}

function styleFields(style: EditStyle) {
  return {
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    fill: style.fill,
    fillColor: style.fillColor,
    fillOpacity: style.fillOpacity,
  };
}

/** Marca de tamano fijo centrada en el punto (cuadrada EN PANTALLA), siempre dentro de la pagina. */
export function checkAt(
  metrics: PageMetrics,
  pageIndex: number,
  id: string,
  center: NormPoint,
  style: EditStyle,
): CheckElement {
  const width = DEFAULT_CHECK_WIDTH;
  const height = Math.min(0.95, (width * metrics.cssWidth) / metrics.cssHeight);
  return {
    id,
    pageIndex,
    type: "check",
    x: clamp(center.x - width / 2, 0, 1 - width),
    y: clamp(center.y - height / 2, 0, Math.max(0, 1 - height)),
    width,
    height,
    mark: style.checkMark,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
  };
}

/**
 * Elemento que nace de un gesto sobre la pagina. `start`/`end` en fracciones.
 * Un toque (`tap`) deja una figura de tamano por defecto centrada en el punto; un
 * arrastre define la caja (o los extremos de la linea). Devuelve `null` si el
 * resultado esta por debajo de los minimos del motor.
 */
export function shapeFromGesture(args: {
  tool: DrawTool;
  metrics: PageMetrics;
  pageIndex: number;
  id: string;
  start: NormPoint;
  end: NormPoint;
  tap: boolean;
  style: EditStyle;
}): EditShapeElement | null {
  const { tool, metrics, pageIndex, id, start, end, tap, style } = args;

  if (tool === "check") {
    if (tap) return checkAt(metrics, pageIndex, id, start, style);
    const box = boxBetween(start, end);
    if (box.width < MIN_ELEMENT_SIDE || box.height < MIN_ELEMENT_SIDE) return null;
    return {
      id,
      pageIndex,
      type: "check",
      ...box,
      mark: style.checkMark,
      strokeColor: style.strokeColor,
      strokeWidth: style.strokeWidth,
    };
  }

  if (tool === "line") {
    let a = start;
    let b = end;
    if (tap) {
      const half = TAP_SIZE_PT.line.width / 2 / Math.max(1, metrics.geometry.viewWidth);
      const x = clamp(start.x, half, 1 - half);
      a = { x: x - half, y: start.y };
      b = { x: x + half, y: start.y };
    }
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_LINE_LENGTH) return null;
    return {
      id,
      pageIndex,
      type: "line",
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      strokeColor: style.strokeColor,
      strokeWidth: style.strokeWidth,
    };
  }

  let box: NormBox;
  if (tap) {
    const size = TAP_SIZE_PT[tool];
    const width = Math.min(1, size.width / Math.max(1, metrics.geometry.viewWidth));
    const height = Math.min(1, size.height / Math.max(1, metrics.geometry.viewHeight));
    box = {
      x: clamp(start.x - width / 2, 0, 1 - width),
      y: clamp(start.y - height / 2, 0, 1 - height),
      width,
      height,
    };
  } else {
    box = boxBetween(start, end);
  }
  if (box.width < MIN_ELEMENT_SIDE || box.height < MIN_ELEMENT_SIDE) return null;

  if (tool === "highlight") {
    return {
      id,
      pageIndex,
      type: "highlight",
      ...box,
      color: style.highlightColor,
      opacity: style.highlightOpacity,
    };
  }
  return { id, pageIndex, type: tool, ...box, ...styleFields(style) };
}

function boxBetween(a: NormPoint, b: NormPoint): NormBox {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Imagen nueva centrada en `center`, con el ancho por defecto (o menos si no cabe a lo alto). */
export function imageElementAt(args: {
  metrics: PageMetrics;
  pageIndex: number;
  id: string;
  center: NormPoint;
  image: { bytes: Uint8Array; previewUrl: string; ratio: number };
}): ImageElement {
  const { metrics, pageIndex, id, center, image } = args;
  const aspect = metrics.cssWidth / metrics.cssHeight;
  let width = DEFAULT_IMAGE_WIDTH;
  let height = width * image.ratio * aspect;
  if (height > MAX_IMAGE_HEIGHT) {
    height = MAX_IMAGE_HEIGHT;
    width = height / (image.ratio * aspect);
  }
  return {
    id,
    pageIndex,
    type: "image",
    x: clamp(center.x - width / 2, 0, 1 - width),
    y: clamp(center.y - height / 2, 0, Math.max(0, 1 - height)),
    width,
    height,
    bytes: image.bytes,
    previewUrl: image.previewUrl,
    ratio: image.ratio,
  };
}

/** Op `add` de una imagen subida (los bytes viajan una sola vez, en la op). */
export function addImageOp(element: ImageElement): EditOp {
  return imageAddOp(element);
}

/**
 * Centro de la parte VISIBLE de la hoja (la que cae dentro de la ventana util),
 * en fracciones. Si la hoja no se ve, su centro.
 */
export function visibleCenterNorm(
  host: { left: number; top: number; width: number; height: number },
  view: { top: number; bottom: number; left: number; right: number },
): NormPoint {
  const left = Math.max(host.left, view.left);
  const right = Math.min(host.left + host.width, view.right);
  const top = Math.max(host.top, view.top);
  const bottom = Math.min(host.top + host.height, view.bottom);
  if (right <= left || bottom <= top || host.width <= 0 || host.height <= 0) {
    return { x: 0.5, y: 0.5 };
  }
  return {
    x: clamp01(((left + right) / 2 - host.left) / host.width),
    y: clamp01(((top + bottom) / 2 - host.top) / host.height),
  };
}

/* ------------------------------------------------------------------ *
 * Duplicar
 * ------------------------------------------------------------------ */

const DUPLICATE_OFFSET = 0.02;

/** Copia desplazada de una imagen o forma, con id nuevo (la imagen comparte los bytes). */
export function duplicateElementItem(
  item: EditShapeItem | EditImageItem,
  id: string = newEditId("el"),
): EditShapeItem | EditImageItem {
  if (item.kind === "image") {
    const el = item.element;
    return {
      kind: "image",
      id,
      element: {
        ...el,
        id,
        x: clamp(el.x + DUPLICATE_OFFSET, 0, 1 - el.width),
        y: clamp(el.y + DUPLICATE_OFFSET, 0, 1 - el.height),
      },
    };
  }
  const el = item.element;
  if (el.type === "line") {
    const dx = clamp(DUPLICATE_OFFSET, -Math.min(el.x1, el.x2), 1 - Math.max(el.x1, el.x2));
    const dy = clamp(DUPLICATE_OFFSET, -Math.min(el.y1, el.y2), 1 - Math.max(el.y1, el.y2));
    return {
      kind: "shape",
      id,
      element: { ...el, id, x1: el.x1 + dx, x2: el.x2 + dx, y1: el.y1 + dy, y2: el.y2 + dy },
    };
  }
  return {
    kind: "shape",
    id,
    element: {
      ...el,
      id,
      x: clamp(el.x + DUPLICATE_OFFSET, 0, 1 - el.width),
      y: clamp(el.y + DUPLICATE_OFFSET, 0, 1 - el.height),
    },
  };
}

/** Op `add` de un duplicado (la imagen reutiliza su asset: no viajan bytes). */
export function duplicateOp(item: EditItem): EditOp | null {
  if (item.kind === "text" || item.kind === "flatten") return null;
  return { type: "add", item: duplicateElementItem(item) };
}

/* ------------------------------------------------------------------ *
 * Redimensionar
 * ------------------------------------------------------------------ */

/**
 * Redimensiona arrastrando una esquina CONSERVANDO la proporcion (las imagenes
 * no se deforman). La esquina opuesta queda fija; el lado dominante manda.
 * `ratio` = alto / ancho en px de la hoja.
 */
export function resizeLockedPxRect(
  rect: PxRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  ratio: number,
  min: number,
  bounds: { width: number; height: number },
): PxRect {
  const west = handle === "nw" || handle === "sw";
  const north = handle === "nw" || handle === "ne";
  const safeRatio = ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
  const anchorX = west ? rect.left + rect.width : rect.left;
  const anchorY = north ? rect.top + rect.height : rect.top;
  const cornerX = (west ? rect.left : rect.left + rect.width) + dx;
  const cornerY = (north ? rect.top : rect.top + rect.height) + dy;
  let width = Math.max(Math.abs(cornerX - anchorX), Math.abs(cornerY - anchorY) / safeRatio);
  const roomX = west ? anchorX : bounds.width - anchorX;
  const roomY = north ? anchorY : bounds.height - anchorY;
  width = Math.min(width, roomX, roomY / safeRatio);
  width = Math.max(width, Math.max(min, min / safeRatio));
  const height = width * safeRatio;
  return {
    left: west ? anchorX - width : anchorX,
    top: north ? anchorY - height : anchorY,
    width,
    height,
  };
}

/** Extremos nuevos de una linea al arrastrar uno (`p1`/`p2`) a un punto de la hoja. */
export function moveLineEnd(
  metrics: PageMetrics,
  line: Pick<LineElement, "x1" | "y1" | "x2" | "y2">,
  end: "p1" | "p2",
  point: { x: number; y: number },
): LinePoints {
  const target = pxToNorm(metrics, point);
  return end === "p1"
    ? { x1: target.x, y1: target.y, x2: line.x2, y2: line.y2 }
    : { x1: line.x1, y1: line.y1, x2: target.x, y2: target.y };
}

/** Desplaza una linea entera `dx`/`dy` (px de la hoja) sin sacarla de la pagina. */
export function shiftLinePoints(
  metrics: PageMetrics,
  line: Pick<LineElement, "x1" | "y1" | "x2" | "y2">,
  dxPx: number,
  dyPx: number,
): LinePoints {
  const dx = clamp(
    dxPx / metrics.cssWidth,
    -Math.min(line.x1, line.x2),
    1 - Math.max(line.x1, line.x2),
  );
  const dy = clamp(
    dyPx / metrics.cssHeight,
    -Math.min(line.y1, line.y2),
    1 - Math.max(line.y1, line.y2),
  );
  return { x1: line.x1 + dx, y1: line.y1 + dy, x2: line.x2 + dx, y2: line.y2 + dy };
}

/* ------------------------------------------------------------------ *
 * Estilo activo <-> parche de la sesion
 * ------------------------------------------------------------------ */

/**
 * Parche de `EditStyle` (lo que nace con el SIGUIENTE elemento) que corresponde a
 * un cambio hecho a un elemento seleccionado: igual que el editor anterior, lo
 * que se cambia a uno es lo que se usara en el proximo.
 */
export function styleFromRestyle(
  element: EditShapeElement | EditImageRef,
  patch: Record<string, unknown>,
): Partial<EditStyle> {
  const out: Partial<EditStyle> = {};
  if (element.type === "highlight") {
    if (typeof patch.color === "string") out.highlightColor = patch.color;
    if (typeof patch.opacity === "number") out.highlightOpacity = patch.opacity;
    return out;
  }
  if (element.type === "image") return out;
  if (typeof patch.strokeColor === "string") out.strokeColor = patch.strokeColor;
  if (typeof patch.strokeWidth === "number") out.strokeWidth = patch.strokeWidth;
  if (element.type === "check") {
    if (patch.mark === "check" || patch.mark === "cross") out.checkMark = patch.mark;
    return out;
  }
  if (element.type === "rect" || element.type === "ellipse") {
    if (typeof patch.fill === "boolean") out.fill = patch.fill;
    if (typeof patch.fillColor === "string") out.fillColor = patch.fillColor;
    if (typeof patch.fillOpacity === "number") out.fillOpacity = patch.fillOpacity;
  }
  return out;
}

/** Clave de la geometria de un elemento: cambia cuando se mueve o cambia de tamano (recoloca la barra). */
export function elementGeometryKey(item: EditShapeItem | EditImageItem): string {
  const el = item.element;
  if (el.type === "line") return `${el.x1},${el.y1},${el.x2},${el.y2}`;
  return `${el.x},${el.y},${el.width},${el.height}`;
}
