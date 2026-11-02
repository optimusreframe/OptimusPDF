/**
 * Parametros validos de MP3 (MPEG-1/2/2.5 Capa III). Solo aritmetica, sin importar el codificador: `encode.ts` la usa para
 * resolver frecuencia y tasa de bits ANTES de cargar nada, y `mp3.ts` (que si arrastra LAME) la repite al codificar.
 */

/** Frecuencias que admite una trama MP3: MPEG-1 (48, 44,1, 32 kHz), MPEG-2 (24, 22,05, 16 kHz) y MPEG-2.5 (12, 11,025, 8 kHz). */
export const MP3_VALID_RATES_HZ: readonly number[] = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000] as const;

/** La frecuencia valida de MP3 mas cercana (a igual distancia, la mayor). Un audio de 96 kHz sale a 48 kHz; uno de 6 kHz, a 8 kHz. */
export function snapMp3SampleRate(rate: number): number {
  let best = MP3_VALID_RATES_HZ[0];
  for (const candidate of MP3_VALID_RATES_HZ) if (Math.abs(candidate - rate) < Math.abs(best - rate)) best = candidate;
  return best;
}

/** Mayor tasa de bits (kbps) que existe a esa frecuencia: 320 en MPEG-1, 160 en MPEG-2 y 64 en MPEG-2.5. */
export function maxMp3BitrateKbps(rate: number): number {
  if (rate >= 32000) return 320;
  if (rate >= 16000) return 160;
  return 64;
}

/** La tasa pedida, recortada a lo que permite la frecuencia (LAME elegiria otra en silencio y el tamano estimado no cuadraria). */
export function clampMp3BitrateKbps(kbps: number, rate: number): number {
  return Math.max(8, Math.min(Math.round(kbps), maxMp3BitrateKbps(rate)));
}
