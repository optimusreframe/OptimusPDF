/*
 * Objetivo tactil de 44 px (WCAG 2.5.5 / HIG) para controles visualmente mas
 * pequeños, SOLO con puntero grueso: un pseudo-elemento transparente de 44 px
 * de alto, centrado en el control, forma parte del elemento para el
 * hit-testing (el toque llega al mismo manejador). Con raton no cambia nada:
 * ni aspecto ni flujo.
 *
 * - Alto exacto 44 px y centrado (`top-1/2` + `-translate-y-1/2`), tenga o no
 *   borde el control: con `inset-y-*` un borde de 1 px dejaba 42 px.
 * - Ancho: el del control o 44 px, el que sea mayor (un icono de 24 px
 *   tambien alcanza 44 px de ancho).
 * - Requiere que el control sea el bloque contenedor del pseudo-elemento:
 *   `HIT_44` ya incluye `pointer-coarse:relative`. Para un control que ya es
 *   `absolute`/`fixed`/`sticky`, usar `HIT_44_PSEUDO` (sin `relative`).
 * - No debe solapar a un vecino: deja >= 8 px (4 + 4) entre controles
 *   contiguos o reduce el area en ese eje.
 */
export const HIT_44_PSEUDO =
  "pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 " +
  "pointer-coarse:before:h-11 pointer-coarse:before:w-11 pointer-coarse:before:min-w-full " +
  "pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']";

export const HIT_44 = `pointer-coarse:relative ${HIT_44_PSEUDO}`;
