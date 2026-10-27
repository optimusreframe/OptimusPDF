import { downscaleRgba, type Rgba } from "@/lib/scan/pixels";
import { clampQuad, type QuadCorners, type ScanPoint } from "@/lib/scan/perspective";

/**
 * AJUSTE Y COMPROBACION DE LOS LADOS DEL RECORTE. Un detector suele quedarse unos pixeles DENTRO de la hoja (o agarrarse a la
 * parte clara y dejar fuera un membrete oscuro o de color pegado al borde). Perder esa franja es perder contenido, asi que,
 * antes de aplicar un recorte:
 *
 *  1. Cada lado se EMPUJA hacia fuera mientras lo que hay justo detras siga siendo papel (mismo color que el papel de dentro,
 *     medido junto al lado), con un margen de seguridad de un par de pixeles.
 *  2. Si detras de un lado hay OTRO borde nitido y paralelo (el final de un membrete, de una banda o de una segunda hoja),
 *     el cuadrilatero no abarca todo el objeto: NO se recorta (pagina completa y «sin documento detectado»).
 *  3. Si el papel sigue mas alla del limite razonable, tampoco.
 *
 * Todo se mide sobre la imagen que llega (hasta 800 px de lado), no sobre una miniatura.
 */

const MEASURE_SIDE = 800;
/** Cuantos puntos se miden a lo largo de cada lado. */
const SAMPLES = 96;
/** Margen de seguridad hacia fuera (px a 800) cuando un lado se empuja, y minimo siempre. */
export const SAFETY_MARGIN_PX = 2;
/** Diferencia maxima (por canal) para seguir llamando «papel» a un pixel respecto al papel de dentro. */
export const PAPER_TOLERANCE = 14;
/** Cuanto puede alejarse el papel de justo dentro del color tipico del papel (luz desigual) para seguir contando como papel. */
export const GLOBAL_PAPER_TOLERANCE = 40;
/** Salto minimo (por canal) para llamar «borde» al paso de un membrete/banda al fondo, y fraccion del lado que lo comparte. */
export const STEP_MIN_DELTA = 28;
/** El salto se mide a +-STEP_WIDE px; un borde nitido hace al menos STEP_SHARPNESS de ese salto dentro de +-1 px (una sombra, no). */
export const STEP_WIDE = 5;
export const STEP_SHARPNESS = 0.35;
export const STEP_MIN_SHARE = 0.7;
/** Cuanto se puede empujar un lado (fraccion del lado menor) antes de dudar, y hasta donde se busca un segundo borde. */
export const MAX_PUSH_FRACTION = 0.06;
export const SEARCH_FRACTION = 0.16;
/** Empuje maximo aceptado de un lado (fraccion del lado menor): mas que esto, el recorte propuesto no era fiable. */
export const MAX_SHIFT_FRACTION = 0.04;
/**
 * Contenido AJENO al fondo detras de un lado: puntos que difieren mucho (OUTLIER_DELTA por canal) de lo que ocupa casi toda la
 * franja de detras (el escritorio). Un membrete del mismo color que la mesa no tiene borde que ver, pero su texto o su logo si
 * (blanco sobre oscuro): si hay de eso, el recorte se queda corto. Se pide una fraccion minima y que este repartido en varias
 * posiciones del lado (un objeto suelto sobre la mesa no vale).
 */
export const OUTLIER_DELTA = 90;
export const OUTLIER_MIN_SHARE = 0.008;
export const OUTLIER_MIN_COLUMNS = 6;

export type RefineResult =
  | { ok: true; quad: QuadCorners; shifts: number[] }
  | { ok: false; reason: "content-beyond" | "paper-continues"; side: number };

type Vec = { x: number; y: number };

function rgbAt(image: Rgba, x: number, y: number): [number, number, number] | null {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return null;
  const o = (iy * image.width + ix) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2]];
}

/** Media de tres muestras a lo largo del lado (contra el ruido) en `p`. */
function sample(image: Rgba, p: Vec, tangent: Vec): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let k = -1; k <= 1; k += 1) {
    const c = rgbAt(image, p.x + tangent.x * k * 2, p.y + tangent.y * k * 2);
    if (!c) continue;
    r += c[0];
    g += c[1];
    b += c[2];
    n += 1;
  }
  return n ? [r / n, g / n, b / n] : null;
}

const channelGap = (a: readonly number[], b: readonly number[]): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/**
 * Recta (empuje en px en funcion de la posicion a lo largo del lado) por minimos cuadrados sobre los empujes medidos, subida lo
 * justo para cubrir el 90 % de las muestras. Devuelve el empuje en los dos extremos del lado (>= 0) o `null` sin datos.
 */
function fitEdge(pushes: number[], length: number): { start: number; end: number } | null {
  // Solo cuentan las muestras donde SE MIDIO papel mas alla del lado (empuje > 0): un 0 puede ser «el borde esta justo aqui» o «no hay
  // dato» (la luz o el color de ese tramo no se parece al papel) y no debe enderezar la recta.
  const points: Array<{ t: number; p: number }> = [];
  pushes.forEach((p, k) => {
    if (p > 0) points.push({ t: length * (0.1 + (0.8 * k) / (pushes.length - 1)), p });
  });
  const n = points.length;
  if (n < 8 || n < pushes.length * 0.15) return null;
  const meanT = points.reduce((a, q) => a + q.t, 0) / n;
  const meanP = points.reduce((a, q) => a + q.p, 0) / n;
  let num = 0;
  let den = 0;
  for (const q of points) {
    num += (q.t - meanT) * (q.p - meanP);
    den += (q.t - meanT) ** 2;
  }
  const slope = den > 1e-9 ? num / den : 0;
  const intercept = meanP - slope * meanT;
  const lift = Math.max(0, percentile(points.map((q) => q.p - (intercept + slope * q.t)), 0.9));
  return { start: Math.max(0, intercept + lift), end: Math.max(0, intercept + slope * length + lift) };
}

function lineIntersection(p1: Vec, d1: Vec, p2: Vec, d2: Vec): Vec | null {
  const det = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / det;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/**
 * Empuja los lados hacia fuera hasta el borde real del papel y rechaza el recorte si detras de algun lado hay otro borde nitido
 * paralelo o el papel no acaba. `quad` normalizado; el resultado tambien.
 */
export function refineCrop(source: Rgba, quad: QuadCorners): RefineResult {
  const image = source.width > MEASURE_SIDE || source.height > MEASURE_SIDE ? downscaleRgba(source, MEASURE_SIDE) : source;
  const minSide = Math.min(image.width, image.height);
  const corners: Vec[] = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map((p) => ({ x: p.x * image.width, y: p.y * image.height }));
  const center = { x: corners.reduce((s, p) => s + p.x, 0) / 4, y: corners.reduce((s, p) => s + p.y, 0) / 4 };
  const maxPush = Math.max(6, minSide * MAX_PUSH_FRACTION);
  const maxShift = Math.max(8, minSide * MAX_SHIFT_FRACTION);
  const searchTo = Math.max(24, Math.round(minSide * SEARCH_FRACTION));
  const lines: Array<{ point: Vec; dir: Vec }> = [];
  // Color del papel: mediana del centro del cuadrilatero. Solo se empuja un lado donde lo de justo dentro se parece a el (si el
  // lado ya cae fuera del papel, lo de dentro es fondo y «seguir en el mismo color» no dice nada).
  const centerSamples: Array<[number, number, number]> = [];
  for (let iy = 0; iy < 9; iy += 1) {
    for (let ix = 0; ix < 9; ix += 1) {
      const u = 0.3 + (0.4 * ix) / 8;
      const v = 0.3 + (0.4 * iy) / 8;
      const top = { x: corners[0].x + (corners[1].x - corners[0].x) * u, y: corners[0].y + (corners[1].y - corners[0].y) * u };
      const bottom = { x: corners[3].x + (corners[2].x - corners[3].x) * u, y: corners[3].y + (corners[2].y - corners[3].y) * u };
      const c = rgbAt(image, top.x + (bottom.x - top.x) * v, top.y + (bottom.y - top.y) * v);
      if (c) centerSamples.push(c);
    }
  }
  const globalPaper: [number, number, number] = [median(centerSamples.map((c) => c[0])), median(centerSamples.map((c) => c[1])), median(centerSamples.map((c) => c[2]))];
  const shifts: number[] = [];

  for (let side = 0; side < 4; side += 1) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const tangent = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    let normal = { x: -tangent.y, y: tangent.x };
    if (normal.x * (a.x - center.x) + normal.y * (a.y - center.y) < 0) normal = { x: -normal.x, y: -normal.y };

    const pushes: number[] = [];
    const profiles: Array<Array<[number, number, number] | null>> = [];
    let paperReachedCap = 0;
    for (let k = 0; k < SAMPLES; k += 1) {
      const t = 0.1 + (0.8 * k) / (SAMPLES - 1);
      const origin = { x: a.x + tangent.x * length * t, y: a.y + tangent.y * length * t };
      const at = (d: number) => sample(image, { x: origin.x + normal.x * d, y: origin.y + normal.y * d }, tangent);
      const inner: Array<[number, number, number]> = [];
      for (let d = -10; d <= -4; d += 1) {
        const c = at(d);
        if (c) inner.push(c);
      }
      const profile: Array<[number, number, number] | null> = [];
      for (let d = 0; d <= searchTo + 6; d += 1) profile.push(at(d));
      profiles.push(profile);
      if (inner.length < 4) {
        pushes.push(0);
        continue;
      }
      const paper: [number, number, number] = [median(inner.map((c) => c[0])), median(inner.map((c) => c[1])), median(inner.map((c) => c[2]))];
      if (channelGap(paper, globalPaper) > GLOBAL_PAPER_TOLERANCE) {
        pushes.push(0);
        continue;
      }
      // El papel continua mientras el color siga siendo el del papel (se tolera un pixel suelto).
      let push = 0;
      let misses = 0;
      for (let d = -3; d <= Math.ceil(maxPush) + 2; d += 1) {
        const c = d < 0 ? at(d) : profile[d];
        if (!c) break;
        if (channelGap(c, paper) <= PAPER_TOLERANCE) {
          misses = 0;
          push = Math.max(push, d + 1);
        } else {
          misses += 1;
          if (misses >= 2) break;
        }
      }
      if (push > maxPush) paperReachedCap += 1;
      pushes.push(Math.max(0, push));
    }
    if (paperReachedCap > SAMPLES * 0.25) return { ok: false, reason: "paper-continues", side };
    const shift = Math.max(0, percentile(pushes, 0.85));
    // Un lado que hay que empujar mucho no estaba bien puesto: el detector no es de fiar y mas vale no recortar.
    if (shift > maxShift) return { ok: false, reason: "paper-continues", side };
    // El lado puede estar GIRADO respecto al borde real (una cuña de papel queda fuera en un extremo): se ajusta una recta a los
    // puntos de borde medidos y se sube hasta cubrir el 90 % de ellos; si sale algo raro, se queda el empuje paralelo.
    let start = shift;
    let end = shift;
    const fit = fitEdge(pushes, length);
    if (fit && fit.start <= maxShift && fit.end <= maxShift) {
      start = Math.min(maxShift, Math.max(0, fit.start));
      end = Math.min(maxShift, Math.max(0, fit.end));
    }
    const edge = Math.max(start, end) + SAFETY_MARGIN_PX;

    // Detras del lado (ya empujado) no puede haber otro borde nitido y paralelo.
    const first = Math.ceil(edge) + STEP_WIDE;
    const steps = new Map<number, number>();
    for (const profile of profiles) {
      const seen = new Set<number>();
      for (let d = first; d + STEP_WIDE < profile.length - 1; d += 1) {
        const before = profile[d - STEP_WIDE];
        const after = profile[d + STEP_WIDE];
        const near0 = profile[d - 1];
        const near1 = profile[d + 1];
        if (!before || !after || !near0 || !near1) continue;
        const wide = channelGap(before, after);
        // Un borde nitido concentra el salto en 2 px; la penumbra de una sombra lo reparte en muchos y no cuenta.
        if (wide >= STEP_MIN_DELTA && channelGap(near0, near1) >= wide * STEP_SHARPNESS) {
          for (let near = d - 2; near <= d + 2; near += 1) seen.add(near);
        }
      }
      for (const position of seen) steps.set(position, (steps.get(position) ?? 0) + 1);
    }
    let best = 0;
    for (const count of steps.values()) best = Math.max(best, count);
    if (best >= SAMPLES * STEP_MIN_SHARE) return { ok: false, reason: "content-beyond", side };

    // Contenido ajeno al fondo (texto o logo de un membrete) en la franja de detras.
    const beyond: Array<[number, number, number]> = [];
    for (const profile of profiles) for (let d = Math.ceil(edge) + 3; d < profile.length; d += 1) if (profile[d]) beyond.push(profile[d] as [number, number, number]);
    if (beyond.length > 200) {
      const typical: [number, number, number] = [median(beyond.map((c) => c[0])), median(beyond.map((c) => c[1])), median(beyond.map((c) => c[2]))];
      let outliers = 0;
      let columns = 0;
      for (const profile of profiles) {
        let hits = 0;
        for (let d = Math.ceil(edge) + 3; d < profile.length; d += 1) {
          const c = profile[d];
          if (c && channelGap(c, typical) >= OUTLIER_DELTA) hits += 1;
        }
        outliers += hits;
        if (hits > 0) columns += 1;
      }
        if (outliers / beyond.length >= OUTLIER_MIN_SHARE && columns >= OUTLIER_MIN_COLUMNS) return { ok: false, reason: "content-beyond", side };
    }

    shifts.push(edge);
    const o0 = start + SAFETY_MARGIN_PX;
    const o1 = end + SAFETY_MARGIN_PX;
    const slanted = { x: tangent.x * length + normal.x * (o1 - o0), y: tangent.y * length + normal.y * (o1 - o0) };
    const slantedLength = Math.hypot(slanted.x, slanted.y) || 1;
    lines.push({ point: { x: a.x + normal.x * o0, y: a.y + normal.y * o0 }, dir: { x: slanted.x / slantedLength, y: slanted.y / slantedLength } });
  }

  const next: Vec[] = [];
  for (let i = 0; i < 4; i += 1) {
    const hit = lineIntersection(lines[(i + 3) % 4].point, lines[(i + 3) % 4].dir, lines[i].point, lines[i].dir);
    if (!hit) return { ok: true, quad, shifts };
    next.push(hit);
  }
  const toNorm = (p: Vec): ScanPoint => ({ x: p.x / image.width, y: p.y / image.height });
  return { ok: true, quad: clampQuad({ topLeft: toNorm(next[0]), topRight: toNorm(next[1]), bottomRight: toNorm(next[2]), bottomLeft: toNorm(next[3]) }), shifts };
}
