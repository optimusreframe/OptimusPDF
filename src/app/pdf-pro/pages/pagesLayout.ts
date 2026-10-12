/**
 * Geometria de la cuadricula del organizador de paginas (Wave 7 · U4). Funciones PURAS: sirven
 * para virtualizar (pintar solo las filas visibles), para colocar cada tarjeta y para saber en
 * que hueco cae un arrastre. Todo en pixeles CSS, en coordenadas del CONTENIDO desplazable.
 */

export type GridOptions = {
  /** Ancho minimo de una tarjeta. */
  minCard: number;
  /** Ancho maximo de una tarjeta (la cuadricula anade columnas antes de pasarlo). */
  maxCard: number;
  gap: number;
  minColumns: number;
  maxColumns: number;
  /** Alto de la franja de texto bajo la miniatura. */
  labelHeight: number;
  /** Alto de la miniatura = ancho × `aspect`. */
  aspect: number;
  /** Relleno interior de la cuadricula. */
  padding: number;
};

export const DEFAULT_GRID_OPTIONS: GridOptions = {
  minCard: 118,
  maxCard: 190,
  gap: 12,
  minColumns: 2,
  maxColumns: 10,
  labelHeight: 46,
  aspect: 1.3,
  padding: 12,
};

export type GridMetrics = {
  columns: number;
  cardWidth: number;
  cardHeight: number;
  gap: number;
  padding: number;
  /** Alto de una fila incluyendo el hueco inferior. */
  rowHeight: number;
  rows: number;
  count: number;
  /** Alto total del contenido. */
  totalHeight: number;
  /** Alto de la miniatura (sin la franja de texto). */
  thumbHeight: number;
};

/** Mide la cuadricula para `count` tarjetas en un contenedor de `width` px. */
export function computeGrid(
  width: number,
  count: number,
  options: Partial<GridOptions> = {},
): GridMetrics {
  const o = { ...DEFAULT_GRID_OPTIONS, ...options };
  const usable = Math.max(0, width - o.padding * 2);
  // Tantas columnas como quepan con el ancho minimo; mas columnas si las tarjetas pasarian del maximo.
  let columns = Math.floor((usable + o.gap) / (o.minCard + o.gap));
  columns = Math.max(o.minColumns, Math.min(o.maxColumns, columns));
  let cardWidth = (usable - o.gap * (columns - 1)) / columns;
  while (cardWidth > o.maxCard && columns < o.maxColumns) {
    columns += 1;
    cardWidth = (usable - o.gap * (columns - 1)) / columns;
  }
  cardWidth = Math.max(60, Math.floor(cardWidth));
  const thumbHeight = Math.round(cardWidth * o.aspect);
  const cardHeight = thumbHeight + o.labelHeight;
  const rowHeight = cardHeight + o.gap;
  const rows = Math.ceil(count / columns);
  return {
    columns,
    cardWidth,
    cardHeight,
    gap: o.gap,
    padding: o.padding,
    rowHeight,
    rows,
    count,
    thumbHeight,
    totalHeight: rows === 0 ? o.padding * 2 : o.padding * 2 + rows * rowHeight - o.gap,
  };
}

/** Esquina superior izquierda de la tarjeta `index`. */
export function itemPosition(metrics: GridMetrics, index: number): { x: number; y: number } {
  const row = Math.floor(index / metrics.columns);
  const column = index % metrics.columns;
  return {
    x: metrics.padding + column * (metrics.cardWidth + metrics.gap),
    y: metrics.padding + row * metrics.rowHeight,
  };
}

/** Indices de la primera y la ultima tarjeta que hay que pintar (con filas de margen). */
export function visibleRange(
  metrics: GridMetrics,
  scrollTop: number,
  viewportHeight: number,
  overscanRows = 2,
): { first: number; last: number } | null {
  if (metrics.count === 0) return null;
  const topRow = Math.floor((scrollTop - metrics.padding) / metrics.rowHeight);
  const bottomRow = Math.floor((scrollTop + viewportHeight - metrics.padding) / metrics.rowHeight);
  const lastRow = Math.min(metrics.rows - 1, bottomRow + overscanRows);
  // Un desplazamiento mas alla del final (rebote, redimensionado) se acota a las ultimas filas.
  const firstRow = Math.min(Math.max(0, topRow - overscanRows), Math.max(0, metrics.rows - 1));
  return {
    first: firstRow * metrics.columns,
    last: Math.min(metrics.count - 1, (lastRow + 1) * metrics.columns - 1),
  };
}

/** Indices realmente a la vista (sin margen): para pedir miniaturas por prioridad. */
export function strictVisibleRange(
  metrics: GridMetrics,
  scrollTop: number,
  viewportHeight: number,
): { first: number; last: number } | null {
  return visibleRange(metrics, scrollTop, viewportHeight, 0);
}

/**
 * Hueco de insercion (0..count) para un punto de la cuadricula: antes de la tarjeta si el punto
 * esta en su mitad izquierda, despues si esta en la derecha.
 */
export function insertionIndexAt(metrics: GridMetrics, x: number, y: number): number {
  if (metrics.count === 0) return 0;
  // Por debajo de la ultima fila: al final.
  if (y > metrics.totalHeight - metrics.padding) return metrics.count;
  const row = Math.max(0, Math.min(metrics.rows - 1, Math.floor((y - metrics.padding) / metrics.rowHeight)));
  const stride = metrics.cardWidth + metrics.gap;
  const rawColumn = Math.floor((x - metrics.padding + metrics.gap / 2) / stride);
  const column = Math.max(0, Math.min(metrics.columns - 1, rawColumn));
  const index = row * metrics.columns + column;
  if (index >= metrics.count) return metrics.count;
  const cardLeft = metrics.padding + column * stride;
  return x > cardLeft + metrics.cardWidth / 2 ? index + 1 : index;
}

export type InsertionMarker = { x: number; y: number; height: number };

/** Donde pintar la barra de insercion del hueco `insertBefore` (0..count). */
export function insertionMarker(metrics: GridMetrics, insertBefore: number): InsertionMarker {
  const clamped = Math.max(0, Math.min(metrics.count, insertBefore));
  if (metrics.count === 0) return { x: metrics.padding, y: metrics.padding, height: metrics.cardHeight };
  if (clamped === metrics.count) {
    const last = itemPosition(metrics, metrics.count - 1);
    return { x: last.x + metrics.cardWidth + metrics.gap / 2, y: last.y, height: metrics.cardHeight };
  }
  const at = itemPosition(metrics, clamped);
  return { x: at.x - metrics.gap / 2, y: at.y, height: metrics.cardHeight };
}

/** `scrollTop` mas cercano al actual que deja la tarjeta `index` entera a la vista. */
export function scrollTopToReveal(
  metrics: GridMetrics,
  index: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const { y } = itemPosition(metrics, index);
  const top = y - metrics.padding;
  const bottom = y + metrics.cardHeight + metrics.padding;
  if (top < scrollTop) return Math.max(0, top);
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}

/** Indice de la tarjeta vecina al moverse con las flechas (`null` si no hay). */
export function neighbourIndex(
  metrics: GridMetrics,
  index: number,
  direction: "left" | "right" | "up" | "down" | "home" | "end" | "pageUp" | "pageDown",
  pageRows = 3,
): number | null {
  const last = metrics.count - 1;
  if (last < 0) return null;
  let next = index;
  switch (direction) {
    case "left":
      next = index - 1;
      break;
    case "right":
      next = index + 1;
      break;
    case "up":
      next = index - metrics.columns;
      break;
    case "down":
      next = index + metrics.columns;
      break;
    case "home":
      next = 0;
      break;
    case "end":
      next = last;
      break;
    case "pageUp":
      next = index - metrics.columns * pageRows;
      break;
    case "pageDown":
      next = index + metrics.columns * pageRows;
      break;
  }
  if (direction === "pageUp" || direction === "pageDown") next = Math.max(0, Math.min(last, next));
  if (next < 0 || next > last) return null;
  return next;
}

/**
 * Tamano del elemento SIN girar para que, tras girarlo `rotation` grados (CSS `rotate`) en torno a
 * su centro, la pagina entera quepa en `boxWidth × boxHeight`. `aspect` = ancho / alto de la pagina
 * tal como se ve antes del giro.
 */
export function fitRotated(
  boxWidth: number,
  boxHeight: number,
  aspect: number,
  rotation: number,
): { width: number; height: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1 / 1.3;
  const quarter = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  const sideways = quarter === 90 || quarter === 270;
  const visualAspect = sideways ? 1 / safeAspect : safeAspect;
  const visualWidth = Math.min(boxWidth, boxHeight * visualAspect);
  const visualHeight = visualWidth / visualAspect;
  return sideways
    ? { width: Math.max(1, visualHeight), height: Math.max(1, visualWidth) }
    : { width: Math.max(1, visualWidth), height: Math.max(1, visualHeight) };
}
