/**
 * Aritmetica pura del zoom y el desplazamiento de una hoja (sin DOM): la usa `DocumentCanvas` y la puede reutilizar
 * cualquier visor que ponga la hoja en una tarjeta que recorta (`overflow: hidden`) y la amplie con
 * `transform: translate(pan) scale(zoom)` alrededor de su centro (`transform-origin: center`).
 *
 * Modelo: `pan` es el desplazamiento (px de pantalla) del CENTRO de la hoja respecto a su sitio sin zoom. Un punto de la
 * hoja a distancia `p` de su centro (en px de layout, sin zoom) se ve en `centro + pan + zoom * p`.
 */

export type Vec = { x: number; y: number };
export type Size = { width: number; height: number };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Limita `pan` para que la hoja ampliada nunca deje de cubrir la tarjeta: a `zoom` la hoja mide `size * zoom`, y su
 * centro puede alejarse hasta `size * (zoom - 1) / 2` en cada eje. Es TODO el recorrido de la hoja (no una cota fija).
 */
export function clampPan(pan: Vec, zoom: number, size: Size): Vec {
  const maxX = Math.max(0, (size.width * (zoom - 1)) / 2);
  const maxY = Math.max(0, (size.height * (zoom - 1)) / 2);
  // `+ 0` normaliza -0 (con maxX = 0): el centro es 0, no un cero negativo.
  return { x: clamp(pan.x, -maxX, maxX) + 0, y: clamp(pan.y, -maxY, maxY) + 0 };
}

/**
 * Pan que mantiene el punto de la hoja que estaba bajo el centro de los dedos BAJO el centro de los dedos al pasar de
 * `zoom0` a `zoom1` (y lo sigue si los dedos se desplazan de `mid0` a `mid1`).
 *
 * `rectCenter0` es el centro (px de pantalla) de la hoja tal como se veia al empezar el gesto: con transformacion
 * alrededor del centro coincide con `centro de layout + pan0`.
 *
 * Derivacion: el punto `p` bajo `mid0` cumple `mid0 = rectCenter0 + zoom0 * p'`, con `p' = p` (px de layout). Tras el
 * gesto debe cumplirse `mid1 = layoutCenter + pan1 + zoom1 * p`, con `layoutCenter = rectCenter0 - pan0`. Despejando:
 * `pan1 = mid1 - rectCenter0 + pan0 - (zoom1 / zoom0) * (mid0 - rectCenter0)`.
 */
export function panForPinch(input: {
  pan0: Vec;
  zoom0: number;
  zoom1: number;
  mid0: Vec;
  mid1: Vec;
  rectCenter0: Vec;
}): Vec {
  const { pan0, zoom0, zoom1, mid0, mid1, rectCenter0 } = input;
  const ratio = zoom1 / zoom0;
  return {
    x: mid1.x - rectCenter0.x + pan0.x - ratio * (mid0.x - rectCenter0.x),
    y: mid1.y - rectCenter0.y + pan0.y - ratio * (mid0.y - rectCenter0.y),
  };
}

/**
 * Aplica un arrastre de un dedo (`delta`, px) al pan y devuelve lo que no cupo: `pan` es el nuevo desplazamiento (ya
 * limitado) y `overflow` el trozo del movimiento que la hoja no pudo absorber. Quien llama lo reenvia al scroll de la
 * pagina («encadenado»): la hoja se mueve primero y, al llegar a su borde, el dedo sigue desplazando la pagina.
 */
export function panWithOverflow(
  pan: Vec,
  delta: Vec,
  zoom: number,
  size: Size,
): { pan: Vec; overflow: Vec } {
  const desired = { x: pan.x + delta.x, y: pan.y + delta.y };
  const next = clampPan(desired, zoom, size);
  return { pan: next, overflow: { x: desired.x - next.x, y: desired.y - next.y } };
}

/**
 * Pan que lleva el punto de la hoja que AHORA se ve en `point` (px de pantalla) a `target`, moviendo la hoja (sin salirse
 * de su recorrido). Lo usa «ver este hueco» con la hoja ampliada.
 */
export function panToCenterPoint(input: {
  pan: Vec;
  zoom: number;
  size: Size;
  /** Punto de la hoja medido en pantalla AHORA (el que se quiere llevar a `target`). */
  point: Vec;
  target: Vec;
}): Vec {
  const { pan, zoom, size, point, target } = input;
  return clampPan({ x: pan.x + (target.x - point.x), y: pan.y + (target.y - point.y) }, zoom, size);
}
