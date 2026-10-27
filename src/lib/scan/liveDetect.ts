import { orderCorners, polygonArea, quadArea } from "@/lib/scan/geometry";
import { boxBlur, downscaleRgba, histogram256, otsuThreshold, toGray, type Rgba } from "@/lib/scan/pixels";
import type { QuadCorners, ScanPoint } from "@/lib/scan/perspective";

/**
 * Deteccion SINCRONA y barata del documento en un fotograma de camara (muestra de <= 320 px, ~5-10 veces por segundo).
 *
 * scanic es asincrono y mas pesado: se reserva para la captura (`documentDetection.ts`). En vivo se usa este detector
 * clasico: umbral de Otsu del fotograma suavizado -> mayor componente conexa (papel claro sobre fondo oscuro, o al reves)
 * -> casco convexo -> cuadrilatero circunscrito de area minima. Devuelve esquinas normalizadas (0..1) y una confianza
 * basada en lo «rectangular» que es la region.
 */

export type LiveQuad = { quad: QuadCorners; confidence: number; polarity: "light" | "dark" | "color"; touchesBorder: number };

const ANALYSIS_SIDE = 160;
const MIN_AREA = 0.1;
const MAX_REGION_SHARE = 0.97;

/** Cierre de agujeros pequenos y suavizado previo: el texto del papel no debe partir la region. */

type Component = { size: number; points: ScanPoint[]; touchesBorder: number };

/**
 * Mayor componente conexa (4-vecinos) de la mascara, MAS las que tengan un tamano comparable (>= 12 % de la mayor): un libro
 * abierto cuya costura oscura parte el papel en dos mitades sigue siendo UN documento. Devuelve los puntos de contorno.
 */
function largestComponent(mask: Uint8Array, width: number, height: number): Component | null {
  const label = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const found: Component[] = [];
  let current = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || label[start]) continue;
    current += 1;
    let size = 0;
    let top = 0;
    stack[top++] = start;
    label[start] = current;
    const boundary: ScanPoint[] = [];
    let border = 0;
    while (top > 0) {
      const index = stack[--top];
      size += 1;
      const x = index % width;
      const y = (index - x) / width;
      let isBoundary = false;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        border += 1;
        isBoundary = true;
      }
      const neighbours = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
      for (const n of neighbours) {
        if (n < 0 || !mask[n]) {
          isBoundary = true;
          continue;
        }
        if (!label[n]) {
          label[n] = current;
          stack[top++] = n;
        }
      }
      if (isBoundary) boundary.push({ x: x + 0.5, y: y + 0.5 });
    }
    found.push({ size, points: boundary, touchesBorder: border });
  }
  if (found.length === 0) return null;
  const biggest = found.reduce((best, c) => (c.size > best.size ? c : best));
  const merged: Component = { size: 0, points: [], touchesBorder: 0 };
  for (const c of found) {
    if (c.size >= biggest.size * 0.12) {
      merged.size += c.size;
      merged.points.push(...c.points);
      merged.touchesBorder += c.touchesBorder;
    }
  }
  return merged;
}

function cross(o: ScanPoint, a: ScanPoint, b: ScanPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Casco convexo (cadena monotona de Andrew). */
export function convexHull(points: readonly ScanPoint[]): ScanPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const lower: ScanPoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: ScanPoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function lineIntersection(a1: ScanPoint, a2: ScanPoint, b1: ScanPoint, b2: ScanPoint): ScanPoint | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denominator;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

/**
 * Reduce un poligono convexo a 4 vertices CIRCUNSCRITOS: en cada paso se quita la arista cuya sustitucion (prolongando las
 * dos vecinas hasta cortarse) anade menos area. El resultado contiene al casco y se ajusta a sus lados mayores.
 */
export function circumscribedQuad(hull: readonly ScanPoint[]): ScanPoint[] | null {
  let polygon = [...hull];
  while (polygon.length > 4) {
    let bestIndex = -1;
    let bestPoint: ScanPoint | null = null;
    let bestCost = Infinity;
    const n = polygon.length;
    for (let i = 0; i < n; i += 1) {
      const p0 = polygon[(i + n - 1) % n];
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % n];
      const p3 = polygon[(i + 2) % n];
      const point = lineIntersection(p0, p1, p2, p3);
      if (!point) continue;
      // La nueva esquina debe quedar «delante» de la arista que se quita (no detras).
      if (cross(p1, p2, point) * cross(p1, p2, polygon[(i + 3) % n]) > 0 && n > 4) {
        // Mismo lado que el resto del poligono: la prolongacion no envuelve la arista. Se descarta.
        continue;
      }
      const cost = polygonArea([p1, point, p2]);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = i;
        bestPoint = point;
      }
    }
    if (bestIndex < 0 || !bestPoint) return null;
    const next: ScanPoint[] = [];
    for (let k = 0; k < n; k += 1) {
      if (k === bestIndex) next.push(bestPoint);
      else if (k !== (bestIndex + 1) % n) next.push(polygon[k]);
    }
    polygon = next;
  }
  return polygon.length === 4 ? polygon : null;
}

function evaluate(mask: Uint8Array, width: number, height: number, polarity: LiveQuad["polarity"]): LiveQuad | null {
  const component = largestComponent(mask, width, height);
  if (!component) return null;
  const frameArea = width * height;
  const share = component.size / frameArea;
  // Casi todo el encuadre de un solo tono: no se distingue la hoja del fondo (un fotograma liso no es un documento).
  if (share < MIN_AREA || share > MAX_REGION_SHARE) return null;
  const hull = convexHull(component.points);
  if (hull.length < 3) return null;
  const hullArea = polygonArea(hull);
  const quadPts = hull.length === 4 ? hull : circumscribedQuad(hull);
  if (!quadPts) return null;
  const clamped = quadPts.map((p) => ({ x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) }));
  const ordered = orderCorners(clamped);
  const normalized: QuadCorners = {
    topLeft: { x: ordered.topLeft.x / width, y: ordered.topLeft.y / height },
    topRight: { x: ordered.topRight.x / width, y: ordered.topRight.y / height },
    bottomRight: { x: ordered.bottomRight.x / width, y: ordered.bottomRight.y / height },
    bottomLeft: { x: ordered.bottomLeft.x / width, y: ordered.bottomLeft.y / height },
  };
  const area = quadArea(normalized);
  if (area < MIN_AREA || area > 0.995) return null;
  // Solidez: cuanto del cuadrilatero llena la region. Un papel con texto y un cuadrilatero ajustado dan ~0.9+.
  const solidity = Math.min(1, (hullArea / frameArea) / area);
  const fill = Math.min(1, component.size / (area * frameArea));
  const confidence = Math.max(0, Math.min(1, solidity * 0.6 + fill * 0.4 + (fill > 0.75 ? 0.1 : 0) - 0.1));
  return { quad: normalized, confidence, polarity, touchesBorder: component.touchesBorder / (2 * (width + height)) };
}

/** Mediana por canal del anillo exterior de la muestra (el fondo, si el documento no llena el encuadre). */
function borderColor(image: Rgba): [number, number, number] {
  const { data, width, height } = image;
  const ring = Math.max(1, Math.round(Math.min(width, height) * 0.04));
  const samples: number[][] = [[], [], []];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) {
        x = width - ring - 1;
        continue;
      }
      const o = (y * width + x) * 4;
      samples[0].push(data[o]);
      samples[1].push(data[o + 1]);
      samples[2].push(data[o + 2]);
    }
  }
  return samples.map((list) => {
    list.sort((a, b) => a - b);
    return list[Math.floor(list.length / 2)] ?? 0;
  }) as [number, number, number];
}

/**
 * Busca el documento en una muestra RGBA. Prueba tres lecturas (papel claro sobre fondo oscuro, papel oscuro sobre fondo
 * claro y «lo que no se parece al color del borde», que sirve para tarjetas de colores) y se queda con la de mayor
 * confianza. `null` si no hay una region lo bastante grande y rectangular.
 */
export function detectLiveQuad(frame: Rgba): LiveQuad | null {
  const small = downscaleRgba(frame, ANALYSIS_SIDE);
  const gray = toGray(small);
  const blurred = boxBlur(gray.data, gray.width, gray.height, 2);
  const bytes = new Uint8Array(blurred.length);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = blurred[i];
  const t = otsuThreshold(histogram256(bytes));
  const light = new Uint8Array(bytes.length);
  const dark = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > t) light[i] = 1;
    else dark[i] = 1;
  }
  // Fondo por color: distancia (max por canal) a la mediana del borde, con el mismo suavizado.
  const [br, bg, bb] = borderColor(small);
  const distance = new Float32Array(small.width * small.height);
  for (let i = 0, o = 0; i < distance.length; i += 1, o += 4) {
    distance[i] = Math.max(Math.abs(small.data[o] - br), Math.abs(small.data[o + 1] - bg), Math.abs(small.data[o + 2] - bb));
  }
  const smoothDistance = boxBlur(distance, small.width, small.height, 2);
  const color = new Uint8Array(smoothDistance.length);
  for (let i = 0; i < color.length; i += 1) color[i] = smoothDistance[i] > 38 ? 1 : 0;
  const results = [evaluate(light, small.width, small.height, "light"), evaluate(dark, small.width, small.height, "dark"), evaluate(color, small.width, small.height, "color")];
  // El fondo (la lectura que toca los bordes de la muestra) pierde frente al papel (la que queda dentro).
  // A igual confianza gana la region mas grande (la completa, no solo su parte clara).
  const score = (q: LiveQuad) => q.confidence - q.touchesBorder * 1.5 + quadArea(q.quad) * 0.15;
  let best: LiveQuad | null = null;
  for (const candidate of results) if (candidate && (!best || score(candidate) > score(best) + 0.005)) best = candidate;
  return best;
}
