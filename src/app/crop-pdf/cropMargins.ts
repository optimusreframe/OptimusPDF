import type { NormalizedRect } from "@/lib/pdf/core";

/**
 * Margenes de la seleccion de recorte en porcentaje de la pagina (0-100), para la alternativa SIN ARRASTRAR (WCAG 2.5.7): quien no
 * puede arrastrar los tiradores escribe cuanto quitar de cada lado. Funciones puras (se prueban en Node).
 */
export type CropSide = "top" | "right" | "bottom" | "left";

/** Lado minimo de la seleccion (fraccion de pagina): el mismo que usa el arrastre del lienzo. */
export const CROP_MIN_SIDE = 0.05;
/** Margen maximo que se puede escribir en un lado (queda siempre >= `CROP_MIN_SIDE` de pagina en el otro eje). */
export const CROP_MAX_MARGIN_PERCENT = 95;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Margenes actuales en % (enteros: es lo que se muestra en los campos). */
export function marginsOf(rect: NormalizedRect): Record<CropSide, number> {
  const pct = (fraction: number) => Math.round(clamp(fraction, 0, 1) * 100);
  return {
    top: pct(rect.y),
    left: pct(rect.x),
    right: pct(1 - (rect.x + rect.width)),
    bottom: pct(1 - (rect.y + rect.height)),
  };
}

/** Selecciona un nuevo margen (en %) de un lado; el lado contrario no se mueve y la seleccion nunca baja de `CROP_MIN_SIDE`. */
export function withMargin(rect: NormalizedRect, side: CropSide, percent: number): NormalizedRect {
  const margin = clamp(percent / 100, 0, CROP_MAX_MARGIN_PERCENT / 100);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (side === "left") {
    const x = clamp(margin, 0, right - CROP_MIN_SIDE);
    return { x, y: rect.y, width: right - x, height: rect.height };
  }
  if (side === "right") {
    const edge = clamp(1 - margin, rect.x + CROP_MIN_SIDE, 1);
    return { x: rect.x, y: rect.y, width: edge - rect.x, height: rect.height };
  }
  if (side === "top") {
    const y = clamp(margin, 0, bottom - CROP_MIN_SIDE);
    return { x: rect.x, y, width: rect.width, height: bottom - y };
  }
  const edge = clamp(1 - margin, rect.y + CROP_MIN_SIDE, 1);
  return { x: rect.x, y: rect.y, width: rect.width, height: edge - rect.y };
}
