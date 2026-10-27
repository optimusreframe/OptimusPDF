import { maxCornerShift, quadArea } from "@/lib/scan/geometry";
import { detectLiveQuad } from "@/lib/scan/liveDetect";
import { downscaleRgba, toGray, type Gray, type Rgba } from "@/lib/scan/pixels";
import type { QuadCorners } from "@/lib/scan/perspective";
import { glareOf, medianLevel, sharpnessOf, DARK_PAPER_THRESHOLD } from "@/lib/scan/quality";
import type { FrameVerdict, ScanMode } from "@/lib/scan/types";

/**
 * Veredicto de un fotograma de camara: deteccion del documento, estabilidad temporal, enfoque, brillo/reflejos, cobertura
 * y la guia unica priorizada; decide la captura automatica. Todo sobre una muestra de <= 320 px (barato: ~5 ms).
 */

/** Ancho de la muestra de analisis. */
export const LIVE_SAMPLE_WIDTH = 320;
/** Tiempo continuo de estabilidad (ms) antes de disparar la captura automatica. */
export const AUTO_CAPTURE_STABLE_MS = 700;
/** Desplazamiento maximo de una esquina (fraccion del encuadre) entre dos fotogramas para seguir «quieto». */
export const STABLE_CORNER_SHIFT = 0.018;
/** Diferencia media de luminancia entre fotogramas (0-255) para seguir «quieto». */
export const STABLE_MOTION = 5;
/** Cobertura (fraccion del encuadre) razonable: ni lejos ni cortado. */
export const MIN_COVERAGE = 0.3;
export const MAX_COVERAGE = 0.96;
/** Confianza minima para fiarse del cuadrilatero. */
export const MIN_LIVE_CONFIDENCE = 0.6;
/** Acutancia minima en vivo (a 320 px; calibrada con el corpus). */
export const LIVE_SHARPNESS_THRESHOLD = 0.31;

/** Cobertura minima segun el modo: una tarjeta o un recibo ocupan menos encuadre que una hoja. */
export function minCoverageFor(mode: ScanMode | undefined): number {
  switch (mode) {
    case "id-card":
      return 0.2;
    case "receipt":
      return 0.12;
    default:
      return MIN_COVERAGE;
  }
}

/** Estado temporal entre fotogramas: cuando empezo la quietud y la miniatura anterior para medir el movimiento. */
export type FrameTracker = {
  lastAt: number | null;
  lastQuad: QuadCorners | null;
  lastGray: Uint8Array | null;
  lastSize: { width: number; height: number } | null;
  stableSince: number | null;
};

export function createFrameTracker(): FrameTracker {
  return { lastAt: null, lastQuad: null, lastGray: null, lastSize: null, stableSince: null };
}

/** Tracker compartido por la fachada del motor (una sola camara en vivo a la vez). */
export const sharedFrameTracker: FrameTracker = createFrameTracker();

export function resetFrameTracker(tracker: FrameTracker): void {
  tracker.lastAt = null;
  tracker.lastQuad = null;
  tracker.lastGray = null;
  tracker.lastSize = null;
  tracker.stableSince = null;
}

/** Mascara (1 = dentro) del cuadrilatero, erosionada `inset` px, sobre una muestra de gris. */
function quadMask(quad: QuadCorners, width: number, height: number, inset: number): Uint8Array {
  const pts = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map((p) => ({ x: p.x * width, y: p.y * height }));
  const mask = new Uint8Array(width * height);
  const sign = Math.sign(
    pts.reduce((acc, p, i) => {
      const q = pts[(i + 1) % 4];
      return acc + (p.x * q.y - q.x * p.y);
    }, 0),
  ) || 1;
  const lengths = pts.map((p, i) => Math.hypot(pts[(i + 1) % 4].x - p.x, pts[(i + 1) % 4].y - p.y) || 1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let inside = true;
      for (let i = 0; i < 4 && inside; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % 4];
        const distance = (sign * ((b.x - a.x) * (y + 0.5 - a.y) - (b.y - a.y) * (x + 0.5 - a.x))) / lengths[i];
        if (distance < inset) inside = false;
      }
      if (inside) mask[y * width + x] = 1;
    }
  }
  return mask;
}

export type FrameReading = {
  quad: QuadCorners | null;
  confidence: number;
  coverage: number;
  blurry: boolean;
  sharpness: number | null;
  glare: boolean;
  dark: boolean;
  cutOff: boolean;
  gray: Gray;
};

/** Lee un fotograma SIN estado temporal (deteccion + calidad). En modo `photo` no se busca documento: solo luz y reflejos. */
export function readFrame(frame: Rgba, mode?: ScanMode): FrameReading {
  const sample = frame.width > LIVE_SAMPLE_WIDTH ? downscaleRgba(frame, LIVE_SAMPLE_WIDTH) : frame;
  const gray = toGray(sample);
  if (mode === "photo") {
    return {
      quad: null,
      confidence: 1,
      coverage: 1,
      blurry: false,
      sharpness: sharpnessOf(gray),
      glare: false,
      dark: medianLevel(gray) < 45,
      cutOff: false,
      gray,
    };
  }
  const live = detectLiveQuad(sample);
  if (!live || live.confidence < MIN_LIVE_CONFIDENCE) {
    return { quad: null, confidence: live?.confidence ?? 0, coverage: 0, blurry: false, sharpness: null, glare: false, dark: false, cutOff: false, gray };
  }
  const coverage = quadArea(live.quad);
  const mask = quadMask(live.quad, gray.width, gray.height, Math.max(3, gray.width * 0.02));
  const sharpness = sharpnessOf(gray, mask);
  const glare = glareOf(gray, mask, 2).glare;
  const paper = medianLevel(gray, mask);
  const corners = [live.quad.topLeft, live.quad.topRight, live.quad.bottomRight, live.quad.bottomLeft];
  const nearEdge = corners.filter((p) => p.x < 0.012 || p.x > 0.988 || p.y < 0.012 || p.y > 0.988).length;
  return {
    quad: live.quad,
    confidence: live.confidence,
    coverage,
    sharpness,
    blurry: sharpness !== null && sharpness < LIVE_SHARPNESS_THRESHOLD,
    glare,
    dark: paper < DARK_PAPER_THRESHOLD,
    cutOff: nearEdge >= 2 && coverage > 0.8,
    gray,
  };
}

function motionBetween(a: Gray, previous: Uint8Array, size: { width: number; height: number }): number {
  if (a.width !== size.width || a.height !== size.height) return Number.POSITIVE_INFINITY;
  const step = 3;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += step) {
    sum += Math.abs(a.data[i] - previous[i]);
    count += 1;
  }
  return count ? sum / count : 0;
}

/** Guia unica, de mayor a menor prioridad. */
export function pickHint(reading: FrameReading, stable: boolean, mode?: ScanMode): FrameVerdict["hint"] {
  if (mode === "photo") return reading.dark ? "too_dark" : !stable ? "hold_steady" : "ok";
  if (!reading.quad) return "no_document";
  if (reading.dark) return "too_dark";
  if (reading.glare) return "glare";
  if (reading.cutOff || reading.coverage > MAX_COVERAGE) return "move_away";
  if (reading.coverage < minCoverageFor(mode)) return "move_closer";
  if (!stable || reading.blurry) return "hold_steady";
  return "ok";
}

/**
 * Analiza un fotograma con el estado temporal `tracker`. `previous` (si la interfaz lo pasa) tiene prioridad para el
 * encuadre anterior; el movimiento de la imagen y el inicio de la quietud los lleva el propio tracker.
 */
export function analyzeLiveFrame(
  frame: Rgba,
  tracker: FrameTracker,
  previous: { quad: QuadCorners | null; at: number } | undefined,
  now: number,
  options: { mode?: ScanMode } = {},
): FrameVerdict {
  const mode = options.mode;
  const reading = readFrame(frame, mode);
  const { gray } = reading;
  const sinceLast = tracker.lastAt === null ? Infinity : now - tracker.lastAt;
  // Una pausa larga (la pestana estuvo en segundo plano) reinicia la cuenta.
  if (sinceLast > 1500) {
    tracker.stableSince = null;
    tracker.lastQuad = null;
    tracker.lastGray = null;
  }
  const referenceQuad = previous ? previous.quad : tracker.lastQuad;

  const found = reading.quad !== null || mode === "photo";
  let still = false;
  if (found && tracker.lastGray && tracker.lastSize && (mode === "photo" || referenceQuad)) {
    const shift = reading.quad && referenceQuad ? maxCornerShift(reading.quad, referenceQuad) : 0;
    const motion = motionBetween(gray, tracker.lastGray, tracker.lastSize);
    still = shift <= STABLE_CORNER_SHIFT && motion <= STABLE_MOTION;
  }
  if (!found) {
    tracker.stableSince = null;
  } else if (still) {
    tracker.stableSince ??= tracker.lastAt ?? now;
  } else {
    tracker.stableSince = null;
  }
  tracker.lastAt = now;
  tracker.lastQuad = reading.quad;
  tracker.lastGray = gray.data;
  tracker.lastSize = { width: gray.width, height: gray.height };

  const stableMs = tracker.stableSince === null ? 0 : Math.max(0, now - tracker.stableSince);
  const stable = tracker.stableSince !== null;
  const hint = pickHint(reading, stable, mode);
  const shouldAutoCapture =
    found && hint === "ok" && stableMs >= AUTO_CAPTURE_STABLE_MS && !reading.blurry && !reading.glare && !reading.dark;
  return {
    quad: reading.quad,
    confidence: reading.confidence,
    stable,
    stableMs,
    blurry: reading.blurry,
    glare: reading.glare,
    dark: reading.dark,
    coverage: reading.coverage,
    hint,
    shouldAutoCapture,
  };
}
