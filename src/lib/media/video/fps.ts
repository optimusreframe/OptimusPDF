/** Maximo de fotogramas por segundo: «Original» o un tope. Solo baja, nunca inventa fotogramas. */
export type FpsOption = "original" | "60" | "30" | "24" | "15";
export const FPS_OPTIONS: readonly FpsOption[] = ["original", "60", "30", "24", "15"];

/** Margen: un video de 29,97 fps no se recodifica solo para «bajarlo» a 30. */
const FPS_TOLERANCE = 0.5;

export type FpsPlan = {
  /** Tope a pedir al codificador, o `null` si no se toca el ritmo del original. */
  cap: number | null;
  /** Fotogramas por segundo del resultado (para estimar). */
  output: number;
};

/** Sin dato de fps del original se supone 30 para estimar, y no se pide ningun tope (no se puede saber si hace falta). */
export const ASSUMED_FPS = 30;

export function planFps(sourceFps: number | null, option: FpsOption): FpsPlan {
  const known = sourceFps !== null && sourceFps > 0 && Number.isFinite(sourceFps);
  if (!known) return { cap: null, output: ASSUMED_FPS };
  if (option === "original") return { cap: null, output: sourceFps };
  const limit = Number(option);
  if (sourceFps <= limit + FPS_TOLERANCE) return { cap: null, output: sourceFps };
  return { cap: limit, output: limit };
}

/** Opciones de fps que reducen de verdad el ritmo de este video (siempre incluye «Original»). */
export function availableFps(sourceFps: number | null): FpsOption[] {
  if (sourceFps === null || !(sourceFps > 0)) return ["original"];
  return FPS_OPTIONS.filter((option) => option === "original" || Number(option) + FPS_TOLERANCE < sourceFps);
}
