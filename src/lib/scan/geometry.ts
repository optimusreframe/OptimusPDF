import type { QuadCorners, ScanPoint } from "@/lib/scan/perspective";

/** Orden de las esquinas (copia de `QUAD_KEYS` de `perspective.ts`: este modulo no debe arrastrar el motor de PDF al importarlo). */
const QUAD_KEYS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

/**
 * Geometria de cuadrilateros del Escaner (pura): area, interseccion sobre union (IoU) y desplazamiento entre dos
 * encuadres. La usan la estabilidad temporal del fotograma en vivo y las metricas de deteccion.
 */

export function quadPoints(quad: QuadCorners): ScanPoint[] {
  return QUAD_KEYS.map((key) => quad[key]);
}

/** Area (siempre positiva) de un poligono por la formula del cordon. */
export function polygonArea(points: readonly ScanPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

function signedArea(points: readonly ScanPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/** Recorta el poligono `subject` con el poligono CONVEXO `clip` (Sutherland-Hodgman). */
export function clipConvex(subject: readonly ScanPoint[], clip: readonly ScanPoint[]): ScanPoint[] {
  const orientation = Math.sign(signedArea(clip)) || 1;
  let output = [...subject];
  for (let index = 0; index < clip.length && output.length > 0; index += 1) {
    const a = clip[index];
    const b = clip[(index + 1) % clip.length];
    const inside = (p: ScanPoint) => orientation * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= 0;
    const intersect = (p: ScanPoint, q: ScanPoint): ScanPoint => {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const denominator = dx * ey - dy * ex;
      if (denominator === 0) return p;
      const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / denominator;
      return { x: p.x + t * dx, y: p.y + t * dy };
    };
    const input = output;
    output = [];
    for (let k = 0; k < input.length; k += 1) {
      const current = input[k];
      const previous = input[(k + input.length - 1) % input.length];
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(intersect(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(intersect(previous, current));
      }
    }
  }
  return output;
}

/** Interseccion sobre union de dos cuadrilateros convexos (0..1). */
export function quadIoU(a: QuadCorners, b: QuadCorners): number {
  const pa = quadPoints(a);
  const pb = quadPoints(b);
  const areaA = polygonArea(pa);
  const areaB = polygonArea(pb);
  if (areaA <= 0 || areaB <= 0) return 0;
  const inter = polygonArea(clipConvex(pa, pb));
  const union = areaA + areaB - inter;
  return union > 0 ? Math.min(1, inter / union) : 0;
}

/** Area de la interseccion de dos cuadrilateros convexos. */
export function quadIntersectionArea(a: QuadCorners, b: QuadCorners): number {
  return polygonArea(clipConvex(quadPoints(a), quadPoints(b)));
}

/** Area del cuadrilatero (en las unidades de sus coordenadas; normalizadas = fraccion del encuadre). */
export function quadArea(quad: QuadCorners): number {
  return polygonArea(quadPoints(quad));
}

/** Mayor desplazamiento de una esquina entre dos encuadres (en las unidades de sus coordenadas). */
export function maxCornerShift(a: QuadCorners, b: QuadCorners): number {
  let worst = 0;
  for (const key of QUAD_KEYS) worst = Math.max(worst, Math.hypot(a[key].x - b[key].x, a[key].y - b[key].y));
  return worst;
}

export function quadCentroid(quad: QuadCorners): ScanPoint {
  const points = quadPoints(quad);
  return { x: points.reduce((s, p) => s + p.x, 0) / 4, y: points.reduce((s, p) => s + p.y, 0) / 4 };
}

/**
 * Ordena cuatro puntos como TL, TR, BR, BL (por suma y diferencia de coordenadas), la convencion de `QuadCorners`.
 */
export function orderCorners(points: readonly ScanPoint[]): QuadCorners {
  const sum = (p: ScanPoint) => p.x + p.y;
  const diff = (p: ScanPoint) => p.x - p.y;
  const pick = (score: (p: ScanPoint) => number, sign: 1 | -1) => points.reduce((best, p) => (sign * score(p) > sign * score(best) ? p : best), points[0]);
  return { topLeft: pick(sum, -1), topRight: pick(diff, 1), bottomRight: pick(sum, 1), bottomLeft: pick(diff, -1) };
}
