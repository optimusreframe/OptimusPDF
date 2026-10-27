import { CROP_MIN_FRACTION, moveCorner, shiftCrop, type CropFraction } from "@/app/sign-pdf/inkImportModel";

/**
 * Modelo PURO del rectangulo de recorte (F7 · U7.4, correcciones H13): ocho asas (cuatro esquinas y cuatro bordes) que se pueden
 * arrastrar, mover con el teclado o colocar con DOS toques (tocar el asa y luego el sitio: la alternativa de un solo puntero de
 * WCAG 2.5.7), y los botones de «Ajustar sin arrastrar» (mover y cambiar ancho/alto). Todo en fracciones de la pagina (0..1).
 */

export type RegionHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const REGION_HANDLES: readonly RegionHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Paso de las flechas sobre un asa (1 %) y con Mayus (5 %). */
export const HANDLE_STEP = 0.01;
export const HANDLE_STEP_LARGE = 0.05;
/** Paso de los botones de ajuste (2 %: cada toque cuenta). */
export const NUDGE_STEP = 0.02;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Mueve el asa a `(px, py)` (fracciones de la pagina): una esquina cambia dos lados; un borde, solo uno. Los lados opuestos no se mueven. */
export function moveHandle(rect: CropFraction, handle: RegionHandle, px: number, py: number): CropFraction {
  if (handle.length === 2) return moveCorner(rect, handle as "nw" | "ne" | "sw" | "se", px, py);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const nextX = clamp(px, 0, 1);
  const nextY = clamp(py, 0, 1);
  switch (handle) {
    case "w": {
      const left = Math.min(nextX, right - CROP_MIN_FRACTION);
      return { ...rect, x: left, width: right - left };
    }
    case "e": {
      const edge = Math.max(nextX, rect.x + CROP_MIN_FRACTION);
      return { ...rect, width: edge - rect.x };
    }
    case "n": {
      const top = Math.min(nextY, bottom - CROP_MIN_FRACTION);
      return { ...rect, y: top, height: bottom - top };
    }
    default: {
      const edge = Math.max(nextY, rect.y + CROP_MIN_FRACTION);
      return { ...rect, height: edge - rect.y };
    }
  }
}

/** Posicion actual del asa (fracciones de la pagina). */
export function handlePoint(rect: CropFraction, handle: RegionHandle): { x: number; y: number } {
  const x = handle.includes("w") ? rect.x : handle.includes("e") ? rect.x + rect.width : rect.x + rect.width / 2;
  const y = handle.includes("n") ? rect.y : handle.includes("s") ? rect.y + rect.height : rect.y + rect.height / 2;
  return { x, y };
}

/** Mueve el asa `(dx, dy)` desde donde esta (teclado, botones). Un asa de borde solo cambia en su eje. */
export function nudgeHandle(rect: CropFraction, handle: RegionHandle, dx: number, dy: number): CropFraction {
  const point = handlePoint(rect, handle);
  return moveHandle(rect, handle, point.x + (handle === "n" || handle === "s" ? 0 : dx), point.y + (handle === "e" || handle === "w" ? 0 : dy));
}

export type NudgeAction = "left" | "right" | "up" | "down" | "wider" | "narrower" | "taller" | "shorter";
export const NUDGE_ACTIONS: readonly NudgeAction[] = ["left", "right", "up", "down", "wider", "narrower", "taller", "shorter"];

/**
 * Efecto de un boton de «Ajustar sin arrastrar»: mover todo el rectangulo, o cambiar su ancho / alto manteniendo el centro (se
 * ensancha por los dos lados; si un lado topa con la pagina, solo crece por el otro).
 */
export function applyNudge(rect: CropFraction, action: NudgeAction, step: number = NUDGE_STEP): CropFraction {
  switch (action) {
    case "left":
      return shiftCrop(rect, -step, 0);
    case "right":
      return shiftCrop(rect, step, 0);
    case "up":
      return shiftCrop(rect, 0, -step);
    case "down":
      return shiftCrop(rect, 0, step);
    case "wider":
    case "narrower": {
      const delta = action === "wider" ? step : -step;
      const width = clamp(rect.width + delta, CROP_MIN_FRACTION, 1);
      const x = clamp(rect.x - (width - rect.width) / 2, 0, 1 - width);
      return { ...rect, x, width };
    }
    default: {
      const delta = action === "taller" ? step : -step;
      const height = clamp(rect.height + delta, CROP_MIN_FRACTION, 1);
      const y = clamp(rect.y - (height - rect.height) / 2, 0, 1 - height);
      return { ...rect, y, height };
    }
  }
}

/** Dibujo de las flechas: que teclas mueven un asa (las de borde ignoran el eje que no es suyo). */
export function keyDelta(key: string, large: boolean): { dx: number; dy: number } | null {
  const step = large ? HANDLE_STEP_LARGE : HANDLE_STEP;
  switch (key) {
    case "ArrowLeft":
      return { dx: -step, dy: 0 };
    case "ArrowRight":
      return { dx: step, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -step };
    case "ArrowDown":
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

/** Clave del texto de cada asa y de cada boton de ajuste en el diccionario (`extract.regionHandleNw`, `extract.regionNudgeLeft`...). */
export const HANDLE_NAME_KEY = {
  nw: "regionHandleNw",
  n: "regionHandleN",
  ne: "regionHandleNe",
  e: "regionHandleE",
  se: "regionHandleSe",
  s: "regionHandleS",
  sw: "regionHandleSw",
  w: "regionHandleW",
} as const satisfies Record<RegionHandle, string>;

export const NUDGE_LABEL_KEY = {
  left: "regionNudgeLeft",
  right: "regionNudgeRight",
  up: "regionNudgeUp",
  down: "regionNudgeDown",
  wider: "regionNudgeWider",
  narrower: "regionNudgeNarrower",
  taller: "regionNudgeTaller",
  shorter: "regionNudgeShorter",
} as const satisfies Record<NudgeAction, string>;
