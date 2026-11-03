/*
 * Aritmetica pura (sin DOM ni React) de la vista del modo «Editar campos»: una hoja FIJA dentro de un escenario, con
 * zoom y desplazamiento propios en vez del scroll de la pagina.
 *
 * Modelo (el mismo de `lib/touch/panZoom.ts`, generalizado): la hoja mide `sheet` px de layout (sin zoom) y esta
 * centrada en el escenario; se ve con `transform: translate(pan) scale(zoom)` alrededor de su centro. `zoom` es relativo
 * al AJUSTE (1 = hoja entera o ajustada al ancho, segun `FitMode`). La CAJA LIBRE es la parte del escenario que no tapan
 * el inspector ni el teclado; el recorrido del `pan` se mide contra ella, no contra el escenario entero: asi un elemento
 * seleccionado siempre se puede llevar a la zona visible aunque la hoja entera cupiera sin zoom.
 */

export type Vec = { x: number; y: number };
export type Size = { width: number; height: number };
export type Insets = { top: number; right: number; bottom: number; left: number };

/** Ajustar la hoja entera (alto) o el ancho del escenario (la hoja puede ser mas alta que el escenario). */
export type FitMode = "height" | "width";

export const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Zoom maximo relativo al ajuste en este modo (el lienzo normal llega a 3). */
export const EDIT_MAX_ZOOM = 5;
/** Niveles de los botones y del teclado. */
export const EDIT_ZOOM_STEPS = [1, 1.5, 2, 3, 4, 5] as const;
/** Por debajo de este zoom la hoja cuenta como «ajustada» (cambio de pagina con dos dedos, encaje del pellizco). */
export const FIT_EPSILON = 1.02;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Caja libre del escenario: su tamano y el desplazamiento de su centro respecto al centro del escenario (`cx`, `cy`;
 * positivo = a la derecha / abajo). Con inspector abajo, `cy` es negativo (lo libre queda arriba).
 */
export type FreeBox = {
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** Aire (px) que se deja alrededor de la hoja al recorrerla hasta un borde (el del ajuste). */
  pad?: number;
};

export function freeBoxOf(stage: Size, insets: Insets, pad = 0): FreeBox {
  const width = Math.max(1, stage.width - insets.left - insets.right);
  const height = Math.max(1, stage.height - insets.top - insets.bottom);
  return { width, height, cx: (insets.left - insets.right) / 2, cy: (insets.top - insets.bottom) / 2, pad };
}

/**
 * Tamano de la hoja (px de layout) para un escenario y la proporcion ancho/alto de la pagina. `height` encaja la pagina
 * ENTERA (con `margin` de aire alrededor); `width` llena el ancho (la pagina puede salirse por abajo: se recorre con el
 * desplazamiento). Siempre `width / height = aspect`.
 */
export function fitSheetSize(stage: Size, aspect: number, mode: FitMode, margin: number): Size {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 0.75;
  const availableWidth = Math.max(1, stage.width - margin * 2);
  const availableHeight = Math.max(1, stage.height - margin * 2);
  const width =
    mode === "width" ? availableWidth : Math.min(availableWidth, availableHeight * safeAspect);
  return { width, height: width / safeAspect };
}

/** Recorrido del desplazamiento por eje: `min === max` cuando la hoja cabe (se centra en la caja libre). */
export function panLimits(zoom: number, sheet: Size, free: FreeBox) {
  const pad = free.pad ?? 0;
  const overflowX = (sheet.width * zoom + 2 * pad - free.width) / 2;
  const overflowY = (sheet.height * zoom + 2 * pad - free.height) / 2;
  return {
    minX: overflowX > 0 ? free.cx - overflowX : free.cx,
    maxX: overflowX > 0 ? free.cx + overflowX : free.cx,
    minY: overflowY > 0 ? free.cy - overflowY : free.cy,
    maxY: overflowY > 0 ? free.cy + overflowY : free.cy,
  };
}

/** Limita `pan` al recorrido de la hoja. `+ 0` normaliza el cero negativo. */
export function clampPanTo(pan: Vec, zoom: number, sheet: Size, free: FreeBox): Vec {
  const limits = panLimits(zoom, sheet, free);
  return {
    x: clamp(pan.x, limits.minX, limits.maxX) + 0,
    y: clamp(pan.y, limits.minY, limits.maxY) + 0,
  };
}

/** Pan inicial de un ajuste: centrado en horizontal y con el BORDE SUPERIOR de la hoja a la vista (lo que se lee primero). */
export function initialPan(zoom: number, sheet: Size, free: FreeBox): Vec {
  return clampPanTo({ x: free.cx, y: Number.POSITIVE_INFINITY }, zoom, sheet, free);
}

/** Pan que mantiene el punto `anchor` (px, relativos al centro del escenario) quieto al pasar de `zoom0` a `zoom1`. */
export function panForZoomAt(pan0: Vec, zoom0: number, zoom1: number, anchor: Vec): Vec {
  const ratio = zoom1 / zoom0;
  return { x: anchor.x - (anchor.x - pan0.x) * ratio, y: anchor.y - (anchor.y - pan0.y) * ratio };
}

/** Siguiente nivel de zoom de los botones (`direction` 1 = acercar, -1 = alejar); el actual si no hay mas. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction === 1) return EDIT_ZOOM_STEPS.find((step) => step > zoom + 0.01) ?? zoom;
  return [...EDIT_ZOOM_STEPS].reverse().find((step) => step < zoom - 0.01) ?? 1;
}

export type ScreenBox = { left: number; top: number; right: number; bottom: number };

/**
 * Cuanto hay que mover la hoja (px de pantalla) para que `target` quede dentro de `free` con `margin` de aire. Si ya esta
 * dentro, `{0, 0}`. Si `target` es mayor que la zona libre en un eje, se alinea su borde de arranque (izquierdo / superior).
 * Con `center` lo deja en el centro de `free` aunque ya cupiera (el campo que se esta escribiendo sobre el teclado).
 */
export function revealShift(
  target: ScreenBox,
  free: ScreenBox,
  options: { margin?: number; center?: boolean } = {},
): Vec {
  const margin = options.margin ?? 12;
  const axis = (start: number, end: number, freeStart: number, freeEnd: number): number => {
    const from = freeStart + margin;
    const to = freeEnd - margin;
    const size = end - start;
    if (options.center) return (from + to) / 2 - (start + end) / 2;
    if (size > to - from || start < from) return from - start;
    if (end > to) return to - end;
    return 0;
  };
  return {
    x: axis(target.left, target.right, free.left, free.right),
    y: axis(target.top, target.bottom, free.top, free.bottom),
  };
}

/**
 * Zoom con el que un campo de ancho `fieldWidthPx` (px de pantalla al zoom actual `zoom`) ocupa `fraction` de la caja libre,
 * sin bajar del zoom actual ni pasar de `max`. Lo usa el campo que se va a escribir: se acerca hasta que se lee comodo.
 */
export function zoomForField(input: {
  zoom: number;
  fieldWidthPx: number;
  freeWidth: number;
  fraction?: number;
  /** Ancho (px de pantalla) a partir del cual el campo ya se lee comodo aunque quepa mas: en una pantalla grande no hace falta llenarla. */
  comfortablePx?: number;
  max?: number;
}): number {
  const { zoom, fieldWidthPx, freeWidth } = input;
  if (!(fieldWidthPx > 0) || !(freeWidth > 0)) return zoom;
  const targetPx = Math.min(freeWidth * (input.fraction ?? 0.8), input.comfortablePx ?? Number.POSITIVE_INFINITY);
  const wanted = (zoom * targetPx) / fieldWidthPx;
  return clamp(Math.max(zoom, wanted), 1, input.max ?? EDIT_MAX_ZOOM);
}

/** Dos dedos arrastrados en horizontal sobre la hoja AJUSTADA: ¿es un cambio de pagina? Devuelve -1 (anterior), 1 (siguiente) o 0. */
export const PAGE_SWIPE_MIN_PX = 72;
export function pageSwipeIntent(input: {
  dx: number;
  dy: number;
  zoom: number;
  scaled: boolean;
}): -1 | 0 | 1 {
  if (input.scaled || input.zoom > FIT_EPSILON) return 0;
  const ax = Math.abs(input.dx);
  if (ax < PAGE_SWIPE_MIN_PX || ax < 2 * Math.abs(input.dy)) return 0;
  // Arrastrar hacia la izquierda pasa a la pagina siguiente (como pasar una hoja).
  return input.dx < 0 ? 1 : -1;
}

/** Siguiente pagina (0-based) distinta de `from`, en la direccion pedida y sin dar la vuelta, que tenga campos; `null` si no hay. */
export function nextPageWithFields(
  from: number,
  direction: 1 | -1,
  pageCount: number,
  fieldsOnPage: (index: number) => number,
): number | null {
  for (let index = from + direction; index >= 0 && index < pageCount; index += direction) {
    if (fieldsOnPage(index) > 0) return index;
  }
  return null;
}
