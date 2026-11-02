/*
 * Geometria PURA de la cuadricula de paginas del Escaner (sin DOM): columnas segun el ancho, tamano de tarjeta, posicion de cada
 * una, ventana de filas visibles (virtualizacion) y a que hueco cae un arrastre. Cada tarjeta mide LO MISMO (miniatura 3:4 mas
 * una fila de acciones fija), asi que la posicion de cualquier tarjeta se calcula sin medirla.
 */

export const GRID_GAP = 12;
export const MIN_TILE = 148;
/** Alto fijo (px) de la fila de acciones bajo la miniatura: 8 px de separacion con la tarjeta + 3 botones de 44 px. */
export const ACTIONS_H = 52;
/** Alto (px) de la franja superior de la tarjeta: numero de pagina a la izquierda y asa a la derecha, SIN tapar la miniatura. */
export const STRIP_H = 36;

export type GridLayout = {
  cols: number;
  tileW: number;
  thumbH: number;
  /** Caja con borde: franja + miniatura. */
  boxH: number;
  tileH: number;
  rowH: number;
  gap: number;
  width: number;
};

export function computeLayout(width: number, minTile = MIN_TILE, gap = GRID_GAP): GridLayout {
  const usable = Math.max(1, width);
  const cols = Math.max(2, Math.floor((usable + gap) / (minTile + gap)));
  const tileW = Math.max(1, (usable - gap * (cols - 1)) / cols);
  const thumbH = Math.round((tileW * 4) / 3);
  const boxH = thumbH + STRIP_H;
  const tileH = boxH + ACTIONS_H;
  return { cols, tileW, thumbH, boxH, tileH, rowH: tileH + gap, gap, width: usable };
}

export function totalHeight(layout: GridLayout, count: number): number {
  const rows = Math.ceil(count / layout.cols);
  return rows === 0 ? 0 : rows * layout.rowH - layout.gap;
}

export function tilePosition(layout: GridLayout, index: number): { x: number; y: number } {
  const row = Math.floor(index / layout.cols);
  const col = index % layout.cols;
  return { x: col * (layout.tileW + layout.gap), y: row * layout.rowH };
}

/**
 * Filas a pintar: las que cruzan la zona visible `[top, top + height]` (coordenadas del contenedor) mas `overscan` filas por
 * lado. `null` si no hay filas.
 */
export function visibleRange(layout: GridLayout, count: number, top: number, height: number, overscan = 2): { first: number; last: number } | null {
  if (count <= 0) return null;
  const rows = Math.ceil(count / layout.cols);
  // Con el desplazamiento pasado del final (la lista acaba de encogerse, rebote de iOS) se pintan las ultimas filas, no ninguna.
  const firstRow = Math.min(rows - 1, Math.max(0, Math.floor(top / layout.rowH) - overscan));
  const lastRow = Math.min(rows - 1, Math.floor((top + height) / layout.rowH) + overscan);
  if (lastRow < firstRow) return null;
  return { first: firstRow * layout.cols, last: Math.min(count - 1, (lastRow + 1) * layout.cols - 1) };
}

/** Hueco (0..count) donde caeria un arrastre con el puntero en `(x, y)` del contenedor. */
export function insertionIndexAt(layout: GridLayout, count: number, x: number, y: number): number {
  if (count === 0) return 0;
  const rows = Math.ceil(count / layout.cols);
  const row = Math.max(0, Math.min(rows - 1, Math.floor(y / layout.rowH)));
  const col = Math.max(0, Math.min(layout.cols - 1, Math.floor(x / (layout.tileW + layout.gap))));
  const within = x - col * (layout.tileW + layout.gap);
  const after = within > layout.tileW / 2 ? 1 : 0;
  return Math.min(count, row * layout.cols + col + after);
}

/** Marcador de insercion: barra vertical en el hueco `index` (a la izquierda de la tarjeta que ocupara ese sitio). */
export function insertionMarker(layout: GridLayout, count: number, index: number): { x: number; y: number; height: number } {
  const clamped = Math.max(0, Math.min(count, index));
  if (clamped === count && count > 0) {
    // Al final: a la derecha de la ultima tarjeta.
    const last = tilePosition(layout, count - 1);
    return { x: last.x + layout.tileW + layout.gap / 2, y: last.y, height: layout.tileH };
  }
  const position = tilePosition(layout, clamped);
  return { x: Math.max(0, position.x - layout.gap / 2), y: position.y, height: layout.tileH };
}
