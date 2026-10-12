import { normalizeRotation, type RotatePlan } from "@/lib/pdf/rotate";

/**
 * Plan de giro de «todo el documento», COMPARTIDO por la herramienta suelta y por PDF Pro: el mismo
 * calculo en los dos sitios es lo que garantiza la misma salida byte a byte.
 */
export function rotateAllPlan(angle: number): RotatePlan {
  return { base: normalizeRotation(angle) };
}

export type RotateRangeSelection = {
  angle: number;
  /** 1-based, inclusive. */
  fromPage: number;
  /** 1-based, inclusive; 0 = hasta el final. */
  toPage: number;
  /** Solo las paginas impares / pares dentro del rango. */
  parity?: "all" | "odd" | "even";
};

/** Plan de giro de un rango (con filtro de paginas pares/impares) sobre `pageCount` paginas. */
export function rotateRangePlan(selection: RotateRangeSelection, pageCount: number): RotatePlan {
  const angle = normalizeRotation(selection.angle);
  const from = Math.min(Math.max(1, Math.floor(selection.fromPage) || 1), Math.max(1, pageCount));
  const rawTo = Math.floor(selection.toPage) || pageCount;
  const to = Math.min(Math.max(from, rawTo), pageCount);
  const byPage: Record<number, number> = {};
  for (let page = from; page <= to; page += 1) {
    if (selection.parity === "odd" && page % 2 === 0) continue;
    if (selection.parity === "even" && page % 2 === 1) continue;
    byPage[page] = angle;
  }
  return { base: 0, byPage };
}
