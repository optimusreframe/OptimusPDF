import { decideAutoFilter } from "@/lib/scan/filters";
import { quadArea } from "@/lib/scan/geometry";
import { refineCrop } from "@/lib/scan/cropRefine";
import { chooseCorners, edgeSupport } from "@/lib/scan/documentDetection";
import { quadMask } from "@/lib/scan/liveFrame";
import { quadOutputSize, warpImageData, type QuadCorners } from "@/lib/scan/perspective";
import { downscaleRgba, lumaOf, type Rgba } from "@/lib/scan/pixels";
import type { ScanMode } from "@/lib/scan/types";

/**
 * PUERTA DEL RECORTE AUTOMATICO. Regla de oro: nunca perder contenido en silencio. El cuadrilatero que propone el detector solo
 * se aplica si es MUY fiable; ante la duda la pagina queda completa (y se marca «sin documento detectado» para que se ajuste a
 * mano). Un cuadrilatero es fiable cuando:
 *
 *  1. cubre una parte razonable del encuadre (ni una mota ni casi todo),
 *  2. tiene una proporcion plausible para el modo (hoja, recibo, carnet, libro, pizarra),
 *  3. sus cuatro lados son bordes reales (salto de color contra el fondo),
 *  4. por dentro parece PAPEL (claro, sin color, uniforme) —salvo en tarjetas, que pueden ser de colores— y no un objeto o
 *     un fragmento de una foto, y
 *  5. por fuera es OTRA cosa (el escritorio): si fuera igual que el interior, la foto ya es toda documento y recortar solo
 *     quitaria contenido, y
 *  6. el recorte abarca TODO el objeto: los lados se empujan hasta el borde real del papel y, si detras de alguno hay otro borde
 *     nitido y paralelo (un membrete oscuro o de color), no se recorta (`cropRefine.ts`).
 */

export type CropGateFeatures = {
  area: number;
  /** Ancho / alto de la hoja enderezada. */
  aspect: number;
  support: number;
  paperShare: number;
  colorful: number;
  paperLevel: number;
  /** Diferencia de brillo y de color entre el interior y el exterior. */
  lumaGap: number;
  colorGap: number;
};

export type CropVerdict = { accept: boolean; reason: "ok" | "area" | "aspect" | "edges" | "not-paper" | "same-as-outside" | "content-beyond" | "paper-continues"; features: CropGateFeatures };

/** Cobertura minima del encuadre y rango de proporcion (ancho/alto de la hoja enderezada, en cualquier orientacion) por modo. */
export function gateLimits(mode: ScanMode): { minArea: number; aspect: [number, number]; paper: boolean } {
  switch (mode) {
    case "id-card":
      return { minArea: 0.08, aspect: [1.35, 1.85], paper: false };
    case "receipt":
      return { minArea: 0.07, aspect: [0.13, 0.62], paper: true };
    case "book":
      return { minArea: 0.25, aspect: [0.9, 2.3], paper: true };
    case "whiteboard":
      return { minArea: 0.25, aspect: [1.0, 2.6], paper: true };
    default:
      return { minArea: 0.22, aspect: [0.45, 2.1], paper: true };
  }
}

/** Mayor lado de la muestra con la que se mide (basta y es barata). */
const SAMPLE = 320;

export const MIN_EDGE_SUPPORT = 0.9;
export const MIN_PAPER_SHARE = 0.72;
export const MAX_PAPER_COLORFUL = 0.08;
export const MIN_PAPER_LEVEL = 55;
export const MIN_LUMA_GAP = 22;
export const MIN_COLOR_GAP = 34;

function aspectIn(aspect: number, [min, max]: [number, number]): boolean {
  // La hoja puede estar de pie o apaisada: vale la proporcion o su inversa.
  return (aspect >= min && aspect <= max) || (1 / aspect >= min && 1 / aspect <= max);
}

function regionStats(image: Rgba, mask: Uint8Array): { luma: number; r: number; g: number; b: number; count: number } {
  const hist = new Uint32Array(256);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0, o = 0; i < mask.length; i += 1, o += 4) {
    if (!mask[i]) continue;
    hist[lumaOf(image.data[o], image.data[o + 1], image.data[o + 2])] += 1;
    r += image.data[o];
    g += image.data[o + 1];
    b += image.data[o + 2];
    count += 1;
  }
  let seen = 0;
  let luma = 0;
  for (let v = 0; v < 256; v += 1) {
    seen += hist[v];
    if (seen >= count / 2) {
      luma = v;
      break;
    }
  }
  return { luma, r: count ? r / count : 0, g: count ? g / count : 0, b: count ? b / count : 0, count };
}

/** Decide si el cuadrilatero `quad` (normalizado) puede aplicarse como recorte sobre `image` (cualquier tamano). */
export function evaluateCrop(image: Rgba, quad: QuadCorners, mode: ScanMode): CropVerdict {
  const limits = gateLimits(mode);
  const small = image.width > SAMPLE || image.height > SAMPLE ? downscaleRgba(image, SAMPLE) : image;
  const area = quadArea(quad);
  const size = quadOutputSize(quad, small.width, small.height);
  const aspect = size.width / Math.max(1, size.height);
  const features: CropGateFeatures = { area, aspect, support: 0, paperShare: 0, colorful: 0, paperLevel: 0, lumaGap: 0, colorGap: 0 };
  if (area < limits.minArea || area > 0.9) return { accept: false, reason: "area", features };
  if (!aspectIn(aspect, limits.aspect)) return { accept: false, reason: "aspect", features };
  features.support = edgeSupport(small, quad);

  const inset = Math.max(3, Math.min(small.width, small.height) * 0.03);
  const inner = quadMask(quad, small.width, small.height, inset);
  const outerMask = quadMask(quad, small.width, small.height, -inset);
  const outer = new Uint8Array(outerMask.length);
  for (let i = 0; i < outer.length; i += 1) outer[i] = outerMask[i] ? 0 : 1;
  const inside = regionStats(small, inner);
  const outside = regionStats(small, outer);
  if (inside.count < 100 || outside.count < small.width * small.height * 0.03) return { accept: false, reason: "area", features };
  features.lumaGap = Math.abs(inside.luma - outside.luma);
  features.colorGap = Math.max(Math.abs(inside.r - outside.r), Math.abs(inside.g - outside.g), Math.abs(inside.b - outside.b));

  // Aspecto del interior: la hoja enderezada (se mide la «cara de papel»).
  const width = 200;
  const rect = warpImageData(small, quad, { width, height: Math.max(40, Math.min(400, Math.round(width / Math.max(0.2, Math.min(5, aspect))))) });
  if (rect) {
    const look = decideAutoFilter(rect);
    features.paperShare = look.paperShare;
    features.colorful = look.colorfulShare;
    features.paperLevel = look.paperLevel;
  }
  if (features.support < MIN_EDGE_SUPPORT) return { accept: false, reason: "edges", features };
  if (limits.paper && !(features.paperShare >= MIN_PAPER_SHARE && features.colorful < MAX_PAPER_COLORFUL && features.paperLevel >= MIN_PAPER_LEVEL)) {
    return { accept: false, reason: "not-paper", features };
  }
  if (features.lumaGap < MIN_LUMA_GAP && features.colorGap < MIN_COLOR_GAP) return { accept: false, reason: "same-as-outside", features };
  return { accept: true, reason: "ok", features };
}

/**
 * Del cuadrilatero propuesto por scanic y/o por el detector ligero al que SE APLICA: `chooseCorners` elige el mejor candidato y
 * la puerta (`evaluateCrop`) decide si es lo bastante fiable. `null` = no recortar (pagina completa).
 */
export function selectCrop(scanic: QuadCorners | null, live: QuadCorners | null, image: Rgba, mode: ScanMode, liveConfidence = 0): { quad: QuadCorners | null; verdict: CropVerdict | null } {
  if (mode === "photo") return { quad: null, verdict: null };
  const candidate = chooseCorners(scanic, live, image, liveConfidence);
  if (!candidate) return { quad: null, verdict: null };
  const verdict = evaluateCrop(image, candidate, mode);
  if (!verdict.accept) return { quad: null, verdict };
  // Ultima comprobacion: los lados se empujan hasta el borde real del papel y, si detras hay otro borde (un membrete oscuro o de
  // color que el detector dejo fuera) o el papel no acaba, no se recorta.
  const refined = refineCrop(image, candidate);
  if (!refined.ok) return { quad: null, verdict: { accept: false, reason: refined.reason, features: verdict.features } };
  return { quad: refined.quad, verdict };
}
