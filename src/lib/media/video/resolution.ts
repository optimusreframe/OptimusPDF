/**
 * Resolucion de salida: «1080p/720p/480p/360p» es el LADO CORTO (un video vertical de movil en 720p sale de 720 x 1280, como
 * en cualquier plataforma), nunca se amplia y siempre se conserva la proporcion. Los lados salen pares: los codificadores
 * H.264/VP9 trabajan con 4:2:0 y rechazan o deforman medidas impares.
 */

export type ResolutionOption = "original" | "1080p" | "720p" | "480p" | "360p";

export const RESOLUTION_SHORT_SIDE: Record<Exclude<ResolutionOption, "original">, number> = {
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
  "360p": 360,
};

export const RESOLUTION_OPTIONS: readonly ResolutionOption[] = ["original", "1080p", "720p", "480p", "360p"];

/** Par mas cercano (minimo 2). */
export function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export type FittedSize = {
  width: number;
  height: number;
  /** `true` si se reduce de verdad (la opcion pedida era menor que el original). */
  scaled: boolean;
};

/**
 * Medidas de salida para la opcion pedida sobre un video de `width` x `height` (ya con la rotacion aplicada, es decir, tal y
 * como se ve). Sin ampliar: si el lado corto ya es igual o menor al pedido, devuelve las medidas del original.
 */
export function fitResolution(width: number, height: number, option: ResolutionOption): FittedSize {
  if (option === "original" || !(width > 0) || !(height > 0)) return { width, height, scaled: false };
  const target = RESOLUTION_SHORT_SIDE[option];
  const short = Math.min(width, height);
  if (short <= target) return { width, height, scaled: false };
  const scale = target / short;
  return { width: toEven(width * scale), height: toEven(height * scale), scaled: true };
}

/** Opciones de resolucion que tienen sentido para este video: «Original» y las que reducen de verdad. */
export function availableResolutions(width: number, height: number): ResolutionOption[] {
  const short = Math.min(width, height);
  const reductions = (Object.keys(RESOLUTION_SHORT_SIDE) as Array<Exclude<ResolutionOption, "original">>).filter(
    (option) => RESOLUTION_SHORT_SIDE[option] < short,
  );
  return ["original", ...reductions];
}
