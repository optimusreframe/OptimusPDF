import {
  VIEWER_MAX_FIT_WIDTH,
  VIEWER_MAX_ZOOM,
  VIEWER_MIN_FIT_WIDTH,
  VIEWER_MIN_ZOOM,
  VIEWER_PAD_X,
  VIEWER_PAD_Y,
  VIEWER_PAGE_GAP,
  VIEWER_ZOOM_STEPS,
} from "@/app/pdf-pro/viewer/viewerTypes";

/*
 * Matematica pura del visor continuo (Wave 7 · U3): maquetacion de N paginas en UNA columna con alto
 * reservado segun la proporcion REAL de cada una, ventana visible, pagina actual, saltos, anclas de
 * desplazamiento y zoom. Sin DOM ni React: se prueba con 500 paginas de tamanos distintos.
 *
 * Todas las paginas comparten el mismo ANCHO (ancho base x zoom) y su alto sale de su proporcion
 * (con `/Rotate` y CropBox ya aplicados por pdf.js): una hoja apaisada es mas baja, no mas ancha.
 */

/** Proporcion alto/ancho de un A4 vertical: se usa mientras aun no se conoce el tamano de una pagina. */
export const FALLBACK_ASPECT = 297 / 210;
/** Proporciones fuera de rango (paginas degeneradas) se acotan para no reservar 0 px ni un millon. */
const MIN_ASPECT = 0.05;
const MAX_ASPECT = 20;

export type ViewerLayout = {
  count: number;
  /** Ancho de cada hoja (px CSS, con zoom). */
  pageWidth: number;
  /** Desplazamiento superior de cada pagina (px CSS, coordenadas del contenido). */
  tops: Float64Array;
  heights: Float64Array;
  /** Alto total del contenido (incluye los margenes). */
  total: number;
};

export function clampAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return FALLBACK_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

/** Ancho base (zoom 1) para un contenedor de `containerWidth` px. */
export function baseWidthFor(containerWidth: number): number {
  const available = Number.isFinite(containerWidth) ? containerWidth - 2 * VIEWER_PAD_X : 0;
  return Math.min(VIEWER_MAX_FIT_WIDTH, Math.max(VIEWER_MIN_FIT_WIDTH, available));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(VIEWER_MAX_ZOOM, Math.max(VIEWER_MIN_ZOOM, zoom));
}

/** Ancho de hoja (px CSS) para ese contenedor y zoom. */
export function pageWidthFor(containerWidth: number, zoom: number): number {
  return baseWidthFor(containerWidth) * clampZoom(zoom);
}

/**
 * Maqueta la columna. `aspects[i]` = alto/ancho de la pagina i (0 o ausente = aun desconocida: se usa
 * `fallbackAspect`). El alto reservado es `pageWidth * aspect`, asi la barra de desplazamiento es correcta
 * aunque las paginas lleguen a medirse despues.
 */
export function computeLayout(
  aspects: ArrayLike<number>,
  count: number,
  pageWidth: number,
  fallbackAspect: number = FALLBACK_ASPECT,
): ViewerLayout {
  const tops = new Float64Array(count);
  const heights = new Float64Array(count);
  const fallback = clampAspect(fallbackAspect);
  let y = VIEWER_PAD_Y;
  for (let i = 0; i < count; i += 1) {
    const known = i < aspects.length ? aspects[i] : 0;
    const aspect = known > 0 ? clampAspect(known) : fallback;
    const height = pageWidth * aspect;
    tops[i] = y;
    heights[i] = height;
    y += height + (i < count - 1 ? VIEWER_PAGE_GAP : 0);
  }
  return { count, pageWidth, tops, heights, total: count === 0 ? 0 : y + VIEWER_PAD_Y };
}

/** Ancho del contenido desplazable: la hoja con zoom puede ser mas ancha que el visor. */
export function contentWidthFor(containerWidth: number, pageWidth: number): number {
  return Math.max(containerWidth, pageWidth + 2 * VIEWER_PAD_X);
}

/** Desplazamiento izquierdo de las hojas (centradas en el contenido). */
export function pageLeftFor(containerWidth: number, pageWidth: number): number {
  return Math.max(VIEWER_PAD_X, (contentWidthFor(containerWidth, pageWidth) - pageWidth) / 2);
}

/** Pagina cuyo bloque (hoja + hueco posterior) contiene `y`; acotada al documento. -1 si no hay paginas. */
export function pageAtOffset(layout: ViewerLayout, y: number): number {
  const { count, tops } = layout;
  if (count === 0) return -1;
  if (!(y > tops[0])) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (tops[mid] <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

export type PageRange = { first: number; last: number };

/** Paginas con alguna parte a la vista (`null` si no hay paginas o el visor no tiene alto). */
export function visibleRange(
  layout: ViewerLayout,
  scrollTop: number,
  viewportHeight: number,
): PageRange | null {
  const { count, tops, heights } = layout;
  if (count === 0 || !(viewportHeight > 0)) return null;
  const bottom = scrollTop + viewportHeight;
  let first = pageAtOffset(layout, scrollTop);
  // `y` en el hueco que sigue a la pagina: la primera con algo a la vista es la siguiente.
  if (first < count - 1 && tops[first] + heights[first] <= scrollTop) first += 1;
  let last = pageAtOffset(layout, bottom - 0.001);
  if (last < first) last = first;
  if (tops[last] >= bottom && last > first) last -= 1;
  return { first, last };
}

/** Pagina actual: la que ocupa mas del area visible (empata la primera). `pinned` gana si sigue a la vista. */
export function currentPageFor(
  layout: ViewerLayout,
  scrollTop: number,
  viewportHeight: number,
  pinned?: number | null,
): number {
  const range = visibleRange(layout, scrollTop, viewportHeight);
  if (!range) return 0;
  const bottom = scrollTop + viewportHeight;
  if (pinned !== null && pinned !== undefined && pinned >= range.first && pinned <= range.last) {
    return pinned;
  }
  let best = range.first;
  let bestOverlap = -1;
  for (let i = range.first; i <= range.last; i += 1) {
    const overlap = Math.min(bottom, layout.tops[i] + layout.heights[i]) - Math.max(scrollTop, layout.tops[i]);
    if (overlap > bestOverlap + 0.5) {
      best = i;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Lista ordenada de paginas con alguna parte a la vista. */
export function visiblePages(range: PageRange | null): number[] {
  if (!range) return [];
  const pages: number[] = [];
  for (let i = range.first; i <= range.last; i += 1) pages.push(i);
  return pages;
}

/** Con paginas diminutas pueden verse muchisimas a la vez; por encima de esto se dejan sin montar las mas lejanas al centro. */
export const HARD_MAX_MOUNTED = 48;

/**
 * Paginas que se montan: el rango visible mas `overscan` a cada lado y mas las `pinned` (la que tiene el foco: si
 * se desmontara el foco caeria a <body>). El margen se recorta para no pasar de `max`, pero NUNCA se desmonta una
 * pagina visible (quedaria un hueco en blanco) salvo por encima de `HARD_MAX_MOUNTED`.
 */
export function mountedPages(
  range: PageRange | null,
  count: number,
  overscan: number,
  max: number,
  pinned: readonly number[] = [],
): number[] {
  const out = new Set<number>();
  if (range && count > 0) {
    let from = Math.max(0, range.first - overscan);
    let to = Math.min(count - 1, range.last + overscan);
    while (to - from + 1 > max) {
      // Se recorta el extremo del margen mas lejano de lo visible.
      const farFrom = range.first - from;
      const farTo = to - range.last;
      if (farFrom >= farTo && from < range.first) from += 1;
      else if (to > range.last) to -= 1;
      else break;
    }
    // Pagina visible en exceso (documento de paginas diminutas): se conservan las del centro.
    if (to - from + 1 > HARD_MAX_MOUNTED) {
      const middle = Math.round((range.first + range.last) / 2);
      from = Math.max(from, middle - Math.floor(HARD_MAX_MOUNTED / 2));
      to = Math.min(to, from + HARD_MAX_MOUNTED - 1);
    }
    for (let i = from; i <= to; i += 1) out.add(i);
  }
  for (const page of pinned) if (page >= 0 && page < count) out.add(page);
  return [...out].sort((a, b) => a - b);
}

/** Paginas cuya imagen se mantiene: visibles +- `overscan`, las `max` mas cercanas al centro. */
export function imagePages(
  range: PageRange | null,
  count: number,
  overscan: number,
  max: number,
  center: number,
): number[] {
  if (!range || count === 0) return [];
  const from = Math.max(0, range.first - overscan);
  const to = Math.min(count - 1, range.last + overscan);
  const pages: number[] = [];
  for (let i = from; i <= to; i += 1) pages.push(i);
  if (pages.length > max) {
    pages.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
    pages.length = max;
  }
  return pages.sort((a, b) => a - b);
}

/** `scrollTop` que deja la pagina arriba (o centrada), acotado al contenido. */
export function scrollTopForPage(
  layout: ViewerLayout,
  index: number,
  viewportHeight: number,
  align: "start" | "center" = "start",
): number {
  if (layout.count === 0) return 0;
  const i = Math.min(layout.count - 1, Math.max(0, Math.round(index)));
  const maxScroll = Math.max(0, layout.total - viewportHeight);
  const target =
    align === "center"
      ? layout.tops[i] + layout.heights[i] / 2 - viewportHeight / 2
      : layout.tops[i] - VIEWER_PAGE_GAP;
  return Math.min(maxScroll, Math.max(0, target));
}

/* ------------------------------------------------------------------ *
 * Anclas: un punto de una pagina que debe seguir en el mismo sitio de la pantalla tras cambiar el zoom,
 * el ancho o el contenido.
 * ------------------------------------------------------------------ */

export type ViewerAnchor = {
  page: number;
  /** Fraccion vertical dentro de la pagina (puede salir de 0..1 si el punto cae en el hueco). */
  fy: number;
  /** Fraccion horizontal dentro de la hoja. */
  fx: number;
  /** Donde esta el punto dentro del visor (px, relativo al borde superior/izquierdo visible). */
  vy: number;
  vx: number;
};

export function captureAnchor(
  layout: ViewerLayout,
  containerWidth: number,
  scrollTop: number,
  scrollLeft: number,
  vx: number,
  vy: number,
): ViewerAnchor | null {
  if (layout.count === 0) return null;
  const y = scrollTop + vy;
  const page = pageAtOffset(layout, y);
  const left = pageLeftFor(containerWidth, layout.pageWidth);
  const height = Math.max(1, layout.heights[page]);
  return {
    page,
    fy: (y - layout.tops[page]) / height,
    fx: (scrollLeft + vx - left) / Math.max(1, layout.pageWidth),
    vy,
    vx,
  };
}

/** Nuevo desplazamiento que devuelve el punto anclado a su sitio. */
export function restoreAnchor(
  layout: ViewerLayout,
  containerWidth: number,
  viewportHeight: number,
  anchor: ViewerAnchor,
): { scrollTop: number; scrollLeft: number } {
  const page = Math.min(Math.max(0, anchor.page), Math.max(0, layout.count - 1));
  const left = pageLeftFor(containerWidth, layout.pageWidth);
  const contentWidth = contentWidthFor(containerWidth, layout.pageWidth);
  const top = layout.tops[page] + anchor.fy * layout.heights[page] - anchor.vy;
  const horizontal = left + anchor.fx * layout.pageWidth - anchor.vx;
  return {
    scrollTop: Math.min(Math.max(0, layout.total - viewportHeight), Math.max(0, top)),
    scrollLeft: Math.min(Math.max(0, contentWidth - containerWidth), Math.max(0, horizontal)),
  };
}

/* ------------------------------------------------------------------ *
 * Zoom
 * ------------------------------------------------------------------ */

/** Siguiente paso de zoom (`+1` acerca, `-1` aleja); se queda en el extremo. */
export function nextZoomStep(zoom: number, direction: 1 | -1): number {
  const steps = VIEWER_ZOOM_STEPS;
  if (direction > 0) {
    for (const step of steps) if (step > zoom + 0.001) return step;
    return steps[steps.length - 1];
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i] < zoom - 0.001) return steps[i];
  return steps[0];
}

/** Tope de un giro de rueda: una rueda de raton da saltos de 100; el pellizco del trackpad, de 1 a 15. */
const WHEEL_STEP_CAP = 30;
const WHEEL_SENSITIVITY = 0.01;

/** Zoom resultante de un evento de rueda con Ctrl/Cmd (el pellizco del trackpad llega asi). */
export function zoomFromWheel(zoom: number, deltaY: number, deltaMode = 0): number {
  const lines = deltaMode === 1 ? deltaY * 16 : deltaY;
  const capped = Math.max(-WHEEL_STEP_CAP, Math.min(WHEEL_STEP_CAP, lines));
  return clampZoom(zoom * Math.exp(-capped * WHEEL_SENSITIVITY));
}

/** Zoom de un pellizco: proporcional a como cambia la distancia entre los dedos. */
export function zoomFromPinch(startZoom: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return clampZoom(startZoom);
  return clampZoom(startZoom * (distance / startDistance));
}

/** Zoom al paso de 0,25 hacia arriba: el bitmap se dibuja a ese tamano y el pellizco continuo no lanza un render por pixel. */
export function bucketViewerZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0.25) return 0.25;
  return Math.round(Math.ceil(zoom / 0.25 - 1e-9) * 0.25 * 1000) / 1000;
}

export function zoomPercent(zoom: number): number {
  return Math.round(clampZoom(zoom) * 100);
}
