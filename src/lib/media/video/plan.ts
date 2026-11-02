import type { VideoCapabilities } from "@/lib/media/video/capabilities";
import { FORMAT_INFO, type AudioCodecId, type OutputFormat, type VideoCodecId } from "@/lib/media/video/formats";
import { planFps } from "@/lib/media/video/fps";
import { LIMITS, type DeviceClass } from "@/lib/media/video/limits";
import { audioBitrate, videoBitrate } from "@/lib/media/video/profiles";
import { fitResolution, toEven } from "@/lib/media/video/resolution";
import type { ConversionOptions, VideoInfo } from "@/lib/media/video/types";

/**
 * Planificador: de lo que se sabe del video, lo que se pide y lo que el navegador puede, decide QUE se hara (copiar o
 * recodificar cada pista, a que medidas, ritmo y bitrate), cuanto pesara el resultado y que avisos hay. Es una funcion pura:
 * la pagina la recalcula en cada cambio de opcion y la misma ejecucion la usa el worker, asi lo que se estima es lo que se hace.
 */

export type IssueCode =
  | "noVideoTrack"
  | "cannotDecodeVideo"
  | "formatUnavailable"
  | "inputTooLarge"
  | "tooLong"
  | "outputTooLarge"
  | "bigFile"
  | "longVideo"
  | "audioUndecodable"
  | "audioCannotEncode"
  | "outputLarger"
  | "hdr"
  | "rotationBaked"
  | "fpsUnknown";

/** `block`: no se puede convertir; `warn`: se puede, pero la persona debe saberlo; `info`: dato util. */
export type IssueLevel = "block" | "warn" | "info";

export type PlanIssue = { code: IssueCode; level: IssueLevel };

export type VideoPlan = {
  mode: "copy" | "transcode";
  /** Codec de salida (con `copy`, el del original). */
  codec: VideoCodecId;
  width: number;
  height: number;
  /** Se pide una medida distinta de la del original. */
  resize: boolean;
  /** Tope de fotogramas por segundo a pedir; `null` = no tocar. */
  fpsCap: number | null;
  outputFps: number;
  /** bits/s a pedir; `null` con `copy`. */
  bitrate: number | null;
};

export type AudioPlan =
  | { mode: "none"; reason: "removed" | "absent" | "undecodable" | "unencodable" }
  | { mode: "copy"; codec: string }
  | { mode: "transcode"; codec: AudioCodecId; bitrate: number; channels: number };

export type ConversionPlan = {
  format: OutputFormat;
  extension: string;
  mime: string;
  video: VideoPlan;
  audio: AudioPlan;
  /** Peso estimado del resultado en bytes (orientativo: la codificacion real varia con el contenido). */
  estimatedBytes: number;
  issues: PlanIssue[];
  /** `true` si ningun aviso bloquea la conversion. */
  canConvert: boolean;
};

/** Margen del contenedor (indices, cabeceras) sobre la suma de las pistas. */
const CONTAINER_OVERHEAD = 1.012;
const ASSUMED_AUDIO_BITRATE = 128_000;

function bytesOf(bitrate: number, seconds: number): number {
  return (bitrate * seconds) / 8;
}

export function planConversion(
  info: VideoInfo,
  options: ConversionOptions,
  caps: VideoCapabilities,
  device: DeviceClass,
): ConversionPlan {
  const format = FORMAT_INFO[options.format];
  const capability = caps.formats[options.format];
  const limits = LIMITS[device];
  const issues: PlanIssue[] = [];
  const add = (code: IssueCode, level: IssueLevel) => issues.push({ code, level });

  // --- Lo que bloquea desde el original --------------------------------------------------------------------------
  if (info.width <= 0 || info.height <= 0) add("noVideoTrack", "block");
  else if (!info.canDecodeVideo) add("cannotDecodeVideo", "block");
  if (!capability.available) add("formatUnavailable", "block");
  if (info.fileSize > limits.maxInputBytes) add("inputTooLarge", "block");
  else if (info.fileSize >= limits.warnInputBytes) add("bigFile", "warn");
  if (info.duration > limits.maxDurationSec) add("tooLong", "block");
  else if (info.duration >= limits.warnDurationSec) add("longVideo", "warn");

  // --- Video -----------------------------------------------------------------------------------------------------
  const fitted = fitResolution(info.width, info.height, options.resolution);
  const fps = planFps(info.fps, options.maxFps);
  if (info.fps === null && options.maxFps !== "original") add("fpsUnknown", "info");
  const odd = info.width % 2 !== 0 || info.height % 2 !== 0;

  const sourceCopyable = info.videoCodec !== null && format.copyableVideo.includes(info.videoCodec);
  const keepsRotation = info.rotation === 0 || format.storesRotation;
  const wantsCopy = options.quality === "keep" && !fitted.scaled && fps.cap === null && sourceCopyable && keepsRotation;

  // Codec de salida: si se copia, el del original; si no, el primero que el navegador pueda codificar.
  const encodable = capability.videoCodecs;
  const codec: VideoCodecId = wantsCopy
    ? (info.videoCodec as VideoCodecId)
    : (encodable[0] ?? format.videoCodecs[0]);
  // Medidas impares solo importan al recodificar (copiar no las toca).
  const evenize = odd && !wantsCopy && !fitted.scaled;
  const outWidth = fitted.scaled ? fitted.width : evenize ? toEven(info.width) : info.width;
  const outHeight = fitted.scaled ? fitted.height : evenize ? toEven(info.height) : info.height;
  const resize = fitted.scaled || evenize;

  let video: VideoPlan;
  let videoBytes: number;
  if (wantsCopy) {
    video = { mode: "copy", codec, width: outWidth, height: outHeight, resize: false, fpsCap: null, outputFps: fps.output, bitrate: null };
    videoBytes = info.videoBitrate ? bytesOf(info.videoBitrate, info.duration) : info.fileSize * 0.9;
  } else {
    const bitrate = videoBitrate({
      profile: options.quality,
      codec,
      width: outWidth,
      height: outHeight,
      fps: fps.output,
      source: { codec: info.videoCodec, bitrate: info.videoBitrate, width: info.width, height: info.height },
    });
    video = { mode: "transcode", codec, width: outWidth, height: outHeight, resize, fpsCap: fps.cap, outputFps: fps.output, bitrate };
    videoBytes = bytesOf(bitrate, info.duration);
  }
  if (!keepsRotation && info.rotation !== 0) add("rotationBaked", "info");
  if (info.hdr && video.mode === "transcode") add("hdr", "warn");

  // --- Audio -----------------------------------------------------------------------------------------------------
  let audio: AudioPlan;
  let audioBytes = 0;
  const source = info.audio;
  if (options.removeAudio) {
    audio = { mode: "none", reason: "removed" };
  } else if (!source) {
    audio = { mode: "none", reason: "absent" };
  } else if (!source.canDecode || !source.codec) {
    audio = { mode: "none", reason: "undecodable" };
    add("audioUndecodable", "warn");
  } else {
    const target = format.audioCodec;
    const channels = Math.min(2, Math.max(1, source.channels || 2));
    const wanted = audioBitrate(options.quality, target, channels);
    const compatible = format.copyableAudio.includes(source.codec);
    // Se copia lo que ya es del codec del formato y, fuera de «Conservar», solo si ya es igual de ligero que el perfil.
    const copy = compatible && (options.quality === "keep" || (source.bitrate !== null && source.bitrate <= wanted * 1.1));
    if (copy) {
      audio = { mode: "copy", codec: source.codec };
      audioBytes = bytesOf(source.bitrate ?? ASSUMED_AUDIO_BITRATE, info.duration);
    } else if (capability.audioEncodable) {
      audio = { mode: "transcode", codec: target, bitrate: wanted, channels };
      audioBytes = bytesOf(wanted, info.duration);
    } else {
      audio = { mode: "none", reason: "unencodable" };
      add("audioCannotEncode", "warn");
    }
  }

  // --- Peso estimado y avisos que dependen de el ----------------------------------------------------------------
  const estimatedBytes = Math.round((videoBytes + audioBytes) * CONTAINER_OVERHEAD);
  if (estimatedBytes > limits.maxOutputBytes) add("outputTooLarge", "block");
  else if (video.mode === "transcode" && estimatedBytes > info.fileSize * 1.05 && info.fileSize > 0) add("outputLarger", "warn");

  return {
    format: options.format,
    extension: format.extension,
    mime: format.mime,
    video,
    audio,
    estimatedBytes,
    issues,
    canConvert: !issues.some((issue) => issue.level === "block"),
  };
}

export function hasIssue(plan: ConversionPlan, code: IssueCode): boolean {
  return plan.issues.some((issue) => issue.code === code);
}
