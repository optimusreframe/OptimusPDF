import { analysisGray, inkStatsOf, isBlankPage } from "@/lib/scan/quality";
import { downscaleGray, type Rgba } from "@/lib/scan/pixels";

/**
 * Paginas repetidas: firma compacta de cada hoja (mapa de tinta en una rejilla canonica + dHash perceptual) y comparacion
 * tolerante a pequenos desplazamientos. Dos capturas de la MISMA hoja dan un mapa casi identico (tras alinear); dos hojas
 * distintas del mismo formulario difieren en los datos escritos y NO se marcan como repetidas.
 */

/** Mapa canonico de tinta (pixeles). */
export const CANON_W = 384;
export const CANON_H = 512;
/** Bloques de comparacion (rejilla de BLOCKS_X x BLOCKS_Y sobre el area interior). */
const BLOCKS_X = 8;
const BLOCKS_Y = 8;
const MARGIN = 0.05;
/** Busqueda de alineacion local (px del mapa canonico) por bloque. */
const SEARCH = 9;

/** Distancia de Hamming maxima del dHash (de 64 bits) para siquiera comparar la tinta. */
export const DHASH_MAX_DISTANCE = 26;
/** Un bloque «coincide» si la tinta de cada lado cae sobre la del otro en al menos esta fraccion. */
export const BLOCK_MATCH = 0.86;
/**
 * Para ser repetidas: casi todos los bloques coinciden y la tinta de cada hoja queda explicada por la otra. Un formulario con otros datos tiene
 * varios bloques distintos (los campos rellenados) y por eso NO se marca.
 */
export const DUPLICATE_MIN_BLOCKS = 0.92;
export const DUPLICATE_MIN_EXPLAINED = 0.965;
/** Bloques con menos tinta que esto (px) no cuentan. */
const MIN_BLOCK_INK = 60;

export type PageSignature = {
  aspect: number;
  blank: boolean;
  dhash: Uint32Array; // 2 x 32 bits
  /** Mapa de tinta (1 = tinta) de CANON_W x CANON_H. */
  ink: Uint8Array;
  /** Tinta dilatada 1 px (se calcula al comparar; no viaja entre hilos). */
  dilated?: Uint8Array;
  inkCount: number;
};

function dilate(map: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(map.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!map[y * width + x]) continue;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy += 1) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) out[yy * width + xx] = 1;
      }
    }
  }
  return out;
}

/** dHash de 64 bits: gradiente horizontal de una miniatura 9x8 de la luminancia. */
export function dHashOf(image: Rgba): Uint32Array {
  const gray = analysisGray(image, 240);
  const resized = downscaleGray(gray, 9);
  // Fuerza exactamente 9x8 por muestreo (la reduccion mantiene la proporcion).
  const out = new Uint32Array(2);
  let bit = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const sx = (xi: number) => Math.min(resized.width - 1, Math.floor(((xi + 0.5) / 9) * resized.width));
      const sy = Math.min(resized.height - 1, Math.floor(((y + 0.5) / 8) * resized.height));
      const left = resized.data[sy * resized.width + sx(x)];
      const right = resized.data[sy * resized.width + sx(x + 1)];
      if (left > right) out[bit >> 5] |= 1 << (bit & 31);
      bit += 1;
    }
  }
  return out;
}

export function hamming(a: Uint32Array, b: Uint32Array): number {
  let count = 0;
  for (let word = 0; word < 2; word += 1) {
    let v = (a[word] ^ b[word]) >>> 0;
    while (v) {
      v &= v - 1;
      count += 1;
    }
  }
  return count;
}

export function computeSignature(image: Rgba): PageSignature {
  const gray = analysisGray(image, CANON_W);
  const stats = inkStatsOf(gray, { threshold: 20 });
  const { width, height } = gray;
  // Remuestreo (vecino mas cercano) de la mascara al mapa canonico.
  const ink = new Uint8Array(CANON_W * CANON_H);
  let inkCount = 0;
  for (let y = 0; y < CANON_H; y += 1) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) / CANON_H) * height));
    for (let x = 0; x < CANON_W; x += 1) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) / CANON_W) * width));
      if (stats.mask[sy * width + sx]) {
        ink[y * CANON_W + x] = 1;
        inkCount += 1;
      }
    }
  }
  return {
    aspect: image.width / image.height,
    blank: isBlankPage(stats),
    dhash: dHashOf(image),
    ink,
    inkCount,
  };
}

function dilatedOf(signature: PageSignature): Uint8Array {
  signature.dilated ??= dilate(signature.ink, CANON_W, CANON_H, 1);
  return signature.dilated;
}

/** Mejor coincidencia local de un bloque de `a` dentro de `b` (busqueda +-SEARCH px). Devuelve 0..1 o `null` sin tinta. */
type BlockMatch = { forwardHits: number; forwardTotal: number; backHits: number; backTotal: number; score: number };

function matchBlock(a: PageSignature, b: PageSignature, x0: number, y0: number, w: number, h: number): BlockMatch | null {
  const dilatedB = dilatedOf(b);
  const dilatedA = dilatedOf(a);
  const cells: number[] = [];
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) if (a.ink[y * CANON_W + x]) cells.push(y * CANON_W + x);
  if (cells.length < MIN_BLOCK_INK) return null;
  let best = -1;
  let bestDx = 0;
  let bestDy = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy += 1) {
    for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
      let hits = 0;
      for (let k = 0; k < cells.length; k += 1) {
        const i = cells[k];
        const x = (i % CANON_W) + dx;
        const y = Math.floor(i / CANON_W) + dy;
        if (x >= 0 && x < CANON_W && y >= 0 && y < CANON_H && dilatedB[y * CANON_W + x]) hits += 1;
      }
      if (hits > best) {
        best = hits;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  const forward = best / cells.length;
  // Sentido inverso en la mejor alineacion: la tinta de `b` en ese sitio debe caer sobre la de `a`.
  let backHits = 0;
  let backCount = 0;
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const bx = x + bestDx;
      const by = y + bestDy;
      if (bx < 0 || bx >= CANON_W || by < 0 || by >= CANON_H) continue;
      if (b.ink[by * CANON_W + bx]) {
        backCount += 1;
        if (dilatedA[y * CANON_W + x]) backHits += 1;
      }
    }
  }
  const backward = backCount > 0 ? backHits / backCount : 0;
  return { forwardHits: best, forwardTotal: cells.length, backHits, backTotal: backCount, score: Math.min(forward, backward) };
}

export type PageSimilarity = { matched: number; considered: number; fraction: number; /** Bloques claramente distintos (coincidencia < 0,75). */ bad: number; /** Tinta de cada hoja explicada por la otra (menor de los dos sentidos), 0..1. */ explained: number };

/** Compara dos hojas bloque a bloque (alineacion local por bloque: tolera la perspectiva residual de dos capturas). */
export function comparePages(a: PageSignature, b: PageSignature): PageSimilarity {
  const innerX = Math.round(CANON_W * MARGIN);
  const innerY = Math.round(CANON_H * MARGIN);
  const bw = Math.floor((CANON_W - 2 * innerX) / BLOCKS_X);
  const bh = Math.floor((CANON_H - 2 * innerY) / BLOCKS_Y);
  let matched = 0;
  let considered = 0;
  let fHits = 0;
  let fTotal = 0;
  let bHits = 0;
  let bTotal = 0;
  let bad = 0;
  const order: Array<[number, number]> = [];
  // Orden entrelazado: los primeros bloques ya reparten la pagina (permite descartar pronto).
  for (let r = 0; r < BLOCKS_Y; r += 1) for (let c = 0; c < BLOCKS_X; c += 1) order.push([c, r]);
  order.sort((p, q) => ((p[0] * 5 + p[1] * 3) % 7) - ((q[0] * 5 + q[1] * 3) % 7));
  const result = () => ({
    matched,
    considered,
    fraction: considered > 0 ? matched / considered : 0,
    bad,
    explained: Math.min(fTotal > 0 ? fHits / fTotal : 0, bTotal > 0 ? bHits / bTotal : 0),
  });
  for (const [c, r] of order) {
    const block = matchBlock(a, b, innerX + c * bw, innerY + r * bh, bw, bh);
    if (block === null) continue;
    considered += 1;
    if (block.score >= BLOCK_MATCH) matched += 1;
    if (block.score < 0.75) bad += 1;
    fHits += block.forwardHits;
    fTotal += block.forwardTotal;
    bHits += block.backHits;
    bTotal += block.backTotal;
    // Descarte temprano: con 10 bloques leidos y menos de la mitad coincidiendo no hay repeticion.
    if (considered === 10 && matched < 5) return result();
  }
  return result();
}

/**
 * Lectura independiente del orden: la busqueda de alineacion parte de una hoja y no es exactamente reversible, asi que se mira
 * en los dos sentidos y se toma el PEOR (una repeticion de verdad se reconoce en ambos). Solo se calcula el segundo sentido si
 * el primero ya pasa (la mayoria de las parejas distintas se descartan al primer vistazo).
 */
export function comparePagesBothWays(a: PageSignature, b: PageSignature): PageSimilarity {
  const forward = comparePages(a, b);
  if (!isDuplicateReading(forward)) return forward;
  const backward = comparePages(b, a);
  return {
    matched: Math.min(forward.matched, backward.matched),
    considered: Math.min(forward.considered, backward.considered),
    fraction: Math.min(forward.fraction, backward.fraction),
    bad: Math.max(forward.bad, backward.bad),
    explained: Math.min(forward.explained, backward.explained),
  };
}

function isDuplicateReading(similarity: PageSimilarity): boolean {
  return (
    similarity.considered >= 6 &&
    similarity.fraction >= DUPLICATE_MIN_BLOCKS &&
    similarity.explained >= DUPLICATE_MIN_EXPLAINED
  );
}

/** `true` si las dos hojas son la misma captura repetida. Las hojas en blanco nunca se comparan (tienen su propio aviso). */
export function areDuplicates(a: PageSignature, b: PageSignature): boolean {
  if (a.blank || b.blank) return false;
  if (Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect) > 0.12) return false;
  if (hamming(a.dhash, b.dhash) > DHASH_MAX_DISTANCE) return false;
  const ratio = a.inkCount / Math.max(1, b.inkCount);
  if (ratio < 0.6 || ratio > 1.67) return false;
  return isDuplicateReading(comparePagesBothWays(a, b));
}
