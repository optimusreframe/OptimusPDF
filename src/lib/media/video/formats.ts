/**
 * Formatos y codecs del convertidor de video (todo en `src/lib/media/video/` es logica pura: sin DOM, sin red; el unico
 * archivo que toca la libreria de contenedores es `convertCore.ts`).
 *
 * Salida: MP4 (H.264 + AAC) y WebM (VP9, o VP8 si no hay, + Opus). Los nombres de codec son los de la libreria
 * (`avc`, `vp9`...); las cadenas de WebCodecs que sirven para preguntar al navegador si puede codificar van aparte.
 */

export type OutputFormat = "mp4" | "webm";
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["mp4", "webm"];

export type VideoCodecId = "avc" | "vp9" | "vp8";
export type AudioCodecId = "aac" | "opus";

export type FormatInfo = {
  extension: string;
  mime: string;
  /** Codecs de video que se ofrecen, por orden de preferencia. */
  videoCodecs: readonly VideoCodecId[];
  audioCodec: AudioCodecId;
  /**
   * Codecs que ya trae el original y se pueden pasar al resultado SIN recodificar (rapido y sin perdida): solo los que
   * prometemos en ese formato. HEVC dentro de un MP4 existe, pero no es el «MP4 (H.264)» que se anuncia.
   */
  copyableVideo: readonly string[];
  copyableAudio: readonly string[];
  /** WebM no guarda la rotacion de los moviles como dato: hay que girar los fotogramas (y entonces se recodifica). */
  storesRotation: boolean;
};

export const FORMAT_INFO: Record<OutputFormat, FormatInfo> = {
  mp4: {
    extension: "mp4",
    mime: "video/mp4",
    videoCodecs: ["avc"],
    audioCodec: "aac",
    copyableVideo: ["avc"],
    copyableAudio: ["aac"],
    storesRotation: true,
  },
  webm: {
    extension: "webm",
    mime: "video/webm",
    videoCodecs: ["vp9", "vp8"],
    audioCodec: "opus",
    copyableVideo: ["vp9", "vp8"],
    copyableAudio: ["opus", "vorbis"],
    storesRotation: false,
  },
};

/** Cadenas `codec` de WebCodecs con las que se pregunta a `VideoEncoder`/`AudioEncoder` (la primera que sirva basta). */
export const VIDEO_ENCODER_PROBES: Record<VideoCodecId, readonly string[]> = {
  avc: ["avc1.640028", "avc1.4d0028", "avc1.42001f"],
  vp9: ["vp09.00.10.08"],
  vp8: ["vp8"],
};

export const AUDIO_ENCODER_PROBES: Record<AudioCodecId, string> = {
  aac: "mp4a.40.2",
  opus: "opus",
};

/** Nombre corto y legible de un codec (para la tarjeta del archivo y los avisos). */
export function codecLabel(codec: string | null | undefined): string {
  if (!codec) return "?";
  const names: Record<string, string> = {
    avc: "H.264",
    hevc: "H.265 (HEVC)",
    vp8: "VP8",
    vp9: "VP9",
    av1: "AV1",
    prores: "ProRes",
    aac: "AAC",
    opus: "Opus",
    mp3: "MP3",
    vorbis: "Vorbis",
    flac: "FLAC",
    ac3: "AC-3",
    eac3: "E-AC-3",
    dts: "DTS",
    truehd: "TrueHD",
  };
  if (names[codec]) return names[codec];
  if (codec.startsWith("pcm")) return "PCM";
  return codec.toUpperCase();
}
