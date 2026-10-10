/*
 * Navegacion con teclado entre las entradas de una capa (roving tabindex, patron APG):
 * una sola parada de Tab y flechas, Inicio, Fin, Re Pag y Av Pag para recorrer en orden de lectura.
 */

/** Movimientos de foco entre entradas (flechas, Inicio, Fin, Re Pag y Av Pag). */
export type LayerMove = "next" | "prev" | "first" | "last" | "pageNext" | "pagePrev";

/** Saltos de Re Pag y Av Pag. */
export const LAYER_PAGE_STEP = 10;

/** Que movimiento de foco corresponde a una tecla de navegacion, o `null`. */
export function moveForKey(key: string): LayerMove | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "PageDown":
      return "pageNext";
    case "PageUp":
      return "pagePrev";
    default:
      return null;
  }
}

/** Indice de destino de un movimiento de foco dentro de `total` entradas, recortado a los extremos. */
export function moveTarget(index: number, total: number, move: LayerMove): number {
  const last = Math.max(0, total - 1);
  switch (move) {
    case "next":
      return Math.min(last, index + 1);
    case "prev":
      return Math.max(0, index - 1);
    case "first":
      return 0;
    case "last":
      return last;
    case "pageNext":
      return Math.min(last, index + LAYER_PAGE_STEP);
    case "pagePrev":
      return Math.max(0, index - LAYER_PAGE_STEP);
  }
}
