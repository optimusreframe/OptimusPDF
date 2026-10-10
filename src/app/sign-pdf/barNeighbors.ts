import type { Insets, PxRect } from "@/app/sign-pdf/canvasGeometry";

/**
 * (W5-U5, minor b / D2) En tablas y listas apretadas la barra flotante arriba/abajo del bloque seleccionado tapa los
 * bloques de al lado y hay que cerrarla con Esc para tocarlos. Entre las posiciones razonables (el lado que ya eligio
 * `placeFloatingBar`, el contrario, mas lejos del bloque, deslizada en horizontal, o a la derecha/izquierda del bloque)
 * se prefiere la que menos bloques tapa POR COMPLETO y, a igualdad, la de menos area tapada y la mas cercana. Nunca
 * cubre el ancla (el bloque seleccionado y sus tiradores). Si la original ya no tapa nada, no se toca nada.
 */

export type BarSpot = { x: number; y: number; side: "top" | "bottom" };

type SpotInput = {
  placed: BarSpot;
  anchor: PxRect;
  anchorPad?: Partial<Insets>;
  bar: { width: number; height: number };
  safe: PxRect;
  stage: { left: number; right: number };
  gap: number;
  neighbors: readonly PxRect[];
};

/** Fraccion de un vecino que cubre la barra para contarlo como tapado «por completo». */
export const FULLY_COVERED = 0.9;

function overlapArea(a: PxRect, b: PxRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function pickBarSpot(input: SpotInput): BarSpot {
  const { placed, anchor, bar, safe, stage, gap, neighbors } = input;
  const pad: Insets = { top: 0, right: 0, bottom: 0, left: 0, ...input.anchorPad };
  const anchorBox: PxRect = {
    x: anchor.x - pad.left,
    y: anchor.y - pad.top,
    width: anchor.width + pad.left + pad.right,
    height: anchor.height + pad.top + pad.bottom,
  };

  const score = (x: number, y: number): { full: number; area: number } => {
    const rect: PxRect = { x, y, width: bar.width, height: bar.height };
    let full = 0;
    let area = 0;
    for (const neighbor of neighbors) {
      const covered = overlapArea(rect, neighbor);
      area += covered;
      if (covered >= FULLY_COVERED * neighbor.width * neighbor.height && neighbor.width * neighbor.height > 0) full += 1;
    }
    return { full, area };
  };
  const original = score(placed.x, placed.y);
  if (original.full === 0 && original.area === 0) return placed;

  const safeTop = safe.y;
  const safeBottom = safe.y + safe.height;
  const xMin = Math.max(stage.left, safe.x);
  const xMax = Math.min(stage.right, safe.x + safe.width) - bar.width;
  const clampX = (x: number) => Math.min(Math.max(x, xMin), Math.max(xMin, xMax));
  const clampY = (y: number) => Math.min(Math.max(y, safeTop), Math.max(safeTop, safeBottom - bar.height));
  const fitsY = (y: number) => y >= safeTop && y + bar.height <= safeBottom;
  const touchesAnchor = (x: number, y: number, box: PxRect) =>
    overlapArea({ x, y, width: bar.width, height: bar.height }, box) > 0;

  // Deslizamientos horizontales que mantienen la barra junto al bloque (alineada con su borde izquierdo o derecho).
  const xs = [...new Set([placed.x, anchor.x, anchor.x + anchor.width - bar.width].map(clampX))];
  const candidates: Array<BarSpot & { dist: number }> = [];
  /** `detach`: cuanto se aleja la opcion de la colocacion natural (se prefiere la mas cercana a igualdad de dano). */
  const push = (x: number, y: number, side: "top" | "bottom", detach: number, box: PxRect = anchorBox) => {
    if (!fitsY(y) || touchesAnchor(x, y, box)) return;
    candidates.push({ x, y, side, dist: detach + Math.abs(x - placed.x) * 0.5 });
  };
  // Encima y debajo, pegada al bloque y alejandose a saltos (cada salto se salta una linea vecina).
  for (const extra of [0, 14, 28, 42, 56]) {
    for (const x of xs) {
      push(x, anchorBox.y - gap - bar.height - extra, "top", extra);
      push(x, anchorBox.y + anchorBox.height + gap + extra, "bottom", extra);
    }
  }
  // A los lados del bloque (alineada arriba, centrada o alineada abajo con el). Aqui se permite llegar hasta el borde de
  // la VENTANA (no solo el del escenario): junto a una linea larga la barra puede sobresalir un poco de la hoja.
  const viewMax = safe.x + safe.width - 8 - bar.width;
  const yCenter = anchor.y + anchor.height / 2 - bar.height / 2;
  for (const y of [anchor.y, yCenter, anchor.y + anchor.height - bar.height]) {
    const yy = clampY(y);
    const xRight = anchor.x + anchor.width + gap;
    const xLeft = anchor.x - gap - bar.width;
    if (xRight >= xMin && xRight <= Math.max(xMax, viewMax)) push(xRight, yy, placed.side, 20, anchor);
    if (xLeft >= safe.x + 8 && xLeft <= Math.max(xMax, viewMax)) push(xLeft, yy, placed.side, 20, anchor);
  }

  let best: BarSpot = placed;
  let bestScore = original;
  let bestDist = 0;
  for (const candidate of candidates) {
    const candidateScore = score(candidate.x, candidate.y);
    const better =
      candidateScore.full < bestScore.full ||
      (candidateScore.full === bestScore.full && candidateScore.area < bestScore.area) ||
      (candidateScore.full === bestScore.full && candidateScore.area === bestScore.area && candidate.dist < bestDist);
    if (better) {
      best = { x: candidate.x, y: candidate.y, side: candidate.side };
      bestScore = candidateScore;
      bestDist = candidate.dist;
    }
  }
  return best;
}
