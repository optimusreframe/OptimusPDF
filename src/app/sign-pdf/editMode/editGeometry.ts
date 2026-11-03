import type { NormalizedRect } from "@/lib/pdf/core";

/*
 * Operaciones puras sobre los rectangulos (fracciones de pagina, origen arriba-izquierda) de los elementos del lienzo:
 * lo que usa el inspector del modo «Editar campos» (deslizadores de tamano, alinear, igualar, pegar, repetir). Sin DOM.
 */

/** Lado minimo de un elemento (el mismo del lienzo). */
export const MIN_SIDE = 0.02;
/** Distancia (fraccion de pagina) a la que se desplaza una copia pegada o una repeticion que choca con otra. */
const PASTE_OFFSET = 0.02;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

export type Rect = NormalizedRect;

/** Deja `rect` dentro de la pagina: lados entre `MIN_SIDE` y 1, y la esquina dentro del margen que deja el lado. */
export function fitInPage(rect: Rect): Rect {
  const width = clamp(rect.width, MIN_SIDE, 1);
  const height = clamp(rect.height, MIN_SIDE, 1);
  return {
    x: round(clamp(rect.x, 0, 1 - width)),
    y: round(clamp(rect.y, 0, 1 - height)),
    width: round(width),
    height: round(height),
  };
}

/** Cambia el ancho y/o el alto sin mover la esquina superior izquierda (salvo que se saldria de la pagina). */
export function resizeTo(rect: Rect, size: { width?: number; height?: number }): Rect {
  return fitInPage({ ...rect, width: size.width ?? rect.width, height: size.height ?? rect.height });
}

/** Mueve `rect` (dx, dy en fracciones de pagina) sin salir de ella. */
export function nudge(rect: Rect, dx: number, dy: number): Rect {
  return fitInPage({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** Distancia vertical entre los centros de dos rectangulos. */
function verticalGap(a: Rect, b: Rect): number {
  return Math.abs(a.y + a.height / 2 - (b.y + b.height / 2));
}

/**
 * El elemento mas cercano en vertical a `rect` entre `others` (el campo de arriba o de abajo con el que se quiere alinear),
 * o `null` si no hay otro. `prefer` desempata a favor de los que cumplen el predicado (mismo tipo).
 */
export function nearestOther<T extends { rect: Rect }>(
  rect: Rect,
  others: readonly T[],
  prefer?: (candidate: T) => boolean,
): T | null {
  let best: T | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  let bestPreferred = false;
  for (const candidate of others) {
    const gap = verticalGap(rect, candidate.rect);
    const preferred = prefer ? prefer(candidate) : false;
    if (preferred && !bestPreferred) {
      best = candidate;
      bestGap = gap;
      bestPreferred = true;
    } else if (preferred === bestPreferred && gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

export type AlignMode = "left" | "center" | "right";

/** Alinea `rect` con `reference` por el borde izquierdo, el centro o el borde derecho (solo en horizontal). */
export function alignTo(rect: Rect, reference: Rect, mode: AlignMode): Rect {
  const x =
    mode === "left"
      ? reference.x
      : mode === "right"
        ? reference.x + reference.width - rect.width
        : reference.x + reference.width / 2 - rect.width / 2;
  return fitInPage({ ...rect, x });
}

/** Da a `rect` el ancho y el alto de `reference`, conservando su esquina superior izquierda. */
export function matchSizeTo(rect: Rect, reference: Rect): Rect {
  return fitInPage({ ...rect, width: reference.width, height: reference.height });
}

/** ¿Se pisan dos rectangulos? */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Donde pegar una copia de `source` en una pagina con `others` ya puestos: en el MISMO sitio si esta libre (iniciales
 * en la misma esquina de cada pagina) y, si choca con alguno, un poco desplazada en diagonal hasta que deje de chocar.
 */
export function pasteSpot(source: Rect, others: readonly Rect[]): Rect {
  let candidate = fitInPage(source);
  for (let step = 0; step < 24; step += 1) {
    if (!others.some((other) => overlaps(candidate, other))) return candidate;
    candidate = fitInPage({ ...source, x: source.x + PASTE_OFFSET * (step + 1), y: source.y + PASTE_OFFSET * (step + 1) });
  }
  return fitInPage(source);
}

/** Paginas (0-based) a las que repetir un elemento: todas menos la suya. */
export function repeatTargets(pageCount: number, fromPage: number): number[] {
  const pages: number[] = [];
  for (let page = 0; page < pageCount; page += 1) if (page !== fromPage) pages.push(page);
  return pages;
}

/** Fraccion de pagina -> porcentaje con un decimal (lo que ensenan los deslizadores). */
export function toPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

/** Porcentaje -> fraccion de pagina. */
export function fromPercent(percent: number): number {
  return round(percent / 100);
}

/** Tamanos de letra (pt) que ofrece el inspector. */
export const FONT_SIZE_MIN = 6;
export const FONT_SIZE_MAX = 36;
export function clampFontSize(value: number): number {
  return Math.round(clamp(value, FONT_SIZE_MIN, FONT_SIZE_MAX) * 2) / 2;
}
