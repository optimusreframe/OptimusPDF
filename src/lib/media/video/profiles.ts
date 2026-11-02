import type { AudioCodecId, VideoCodecId } from "@/lib/media/video/formats";

/**
 * Perfiles de calidad. «Conservar» no recodifica cuando se puede (el codec del original ya vale en el formato elegido y no se
 * cambia tamano ni fotogramas por segundo): es lo mas rapido y no pierde nada. Cuando hay que recodificar de todos modos
 * (otro codec, otra resolucion...) usa el perfil «alta» y nunca supera lo que tenia el original (ver `videoBitrate`).
 *
 * El bitrate de video sale de bits por pixel y fotograma: es lo que mantiene la calidad al cambiar la resolucion (a 360p
 * hace falta mucho menos que a 1080p) y permite estimar el peso ANTES de convertir.
 */

export type QualityProfile = "keep" | "high" | "balanced" | "small";
export const QUALITY_PROFILES: readonly QualityProfile[] = ["keep", "high", "balanced", "small"];

/** El perfil con el que se codifica de verdad (el de «Conservar» cuando no hay mas remedio que recodificar). */
export type EncodeProfile = Exclude<QualityProfile, "keep">;
export function encodeProfileOf(profile: QualityProfile): EncodeProfile {
  return profile === "keep" ? "high" : profile;
}

/** Bits por pixel y fotograma (H.264 a 30 fps de referencia). VP9 necesita ~30 % menos para la misma calidad, VP8 ~15 % mas. */
const BITS_PER_PIXEL: Record<VideoCodecId, Record<EncodeProfile, number>> = {
  avc: { high: 0.12, balanced: 0.075, small: 0.045 },
  vp9: { high: 0.085, balanced: 0.053, small: 0.032 },
  vp8: { high: 0.14, balanced: 0.09, small: 0.054 },
};

export const MIN_VIDEO_BITRATE = 150_000;
export const MAX_VIDEO_BITRATE = 40_000_000;

/**
 * Cuanto bitrate necesita cada codec respecto a H.264 para ver lo mismo (para no pedirle al resultado mas de lo que el original
 * tenia: un HEVC de 6 Mbps no mejora por pasarlo a H.264 de 30 Mbps). Los codecs desconocidos o sin perdida (ProRes) no limitan.
 */
const CODEC_NEED: Record<string, number> = { avc: 1, vp8: 1.15, vp9: 0.7, hevc: 0.6, av1: 0.5 };

/** Los fotogramas por encima de 30 no cuestan proporcionalmente (el movimiento entre ellos es menor). */
function rateFps(fps: number): number {
  const safe = Math.min(Math.max(fps, 1), 120);
  return safe <= 30 ? safe : 30 + (safe - 30) * 0.6;
}

export type VideoBitrateInput = {
  profile: QualityProfile;
  codec: VideoCodecId;
  width: number;
  height: number;
  fps: number;
  /** Lo que tenia el original (si se conoce) y su tamano, para no pasarse. */
  source?: { codec: string | null; bitrate: number | null; width: number; height: number } | null;
};

/** Bitrate de video (bits/s) para recodificar. */
export function videoBitrate(input: VideoBitrateInput): number {
  const profile = encodeProfileOf(input.profile);
  const raw = input.width * input.height * rateFps(input.fps) * BITS_PER_PIXEL[input.codec][profile];
  let bitrate = raw;
  const source = input.source;
  if (source && source.bitrate && source.bitrate > 0 && source.codec && CODEC_NEED[source.codec]) {
    const pixelRatio = Math.min(1, (input.width * input.height) / Math.max(1, source.width * source.height));
    const cap = source.bitrate * pixelRatio * (CODEC_NEED[input.codec] / CODEC_NEED[source.codec]) * 1.15;
    bitrate = Math.min(bitrate, cap);
  }
  return Math.round(Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, bitrate)) / 1000) * 1000;
}

const AUDIO_STEREO_BITRATE: Record<AudioCodecId, Record<EncodeProfile, number>> = {
  aac: { high: 192_000, balanced: 128_000, small: 96_000 },
  opus: { high: 160_000, balanced: 112_000, small: 64_000 },
};

/** Bitrate de audio (bits/s) para recodificar: el de estereo del perfil, y ~60 % en mono. */
export function audioBitrate(profile: QualityProfile, codec: AudioCodecId, channels: number): number {
  const stereo = AUDIO_STEREO_BITRATE[codec][encodeProfileOf(profile)];
  return channels <= 1 ? Math.round((stereo * 0.6) / 8000) * 8000 : stereo;
}
