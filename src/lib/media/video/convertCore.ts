import {
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  Quality,
  WEBM,
  WebMOutputFormat,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
} from "mediabunny";
import { VideoError, classifyVideoError } from "@/lib/media/video/errors";
import type { ConversionPlan } from "@/lib/media/video/plan";
import type { VideoInfo } from "@/lib/media/video/types";

/**
 * Motor real del convertidor sobre WebCodecs, con `mediabunny` (demux/mux en TypeScript puro, empaquetado: no hay CDN, ni
 * ffmpeg.wasm, ni cabeceras COOP/COEP). Es el UNICO archivo que importa la libreria. Corre dentro de `video.worker.ts` (fuera del
 * hilo principal) y, si el navegador no deja crear el worker, tal cual en la pagina (`videoEngine.ts`).
 *
 * El original se lee a trozos desde el disco (`BlobSource`, cache de 8 MiB): nunca se carga entero. Los fotogramas y muestras de
 * audio los decodifica, reescala y cierra la propia libreria con contrapresion (no acumula: no pide el siguiente hasta que el
 * codificador tiene sitio). El resultado se arma en un `ArrayBuffer`.
 */

/**
 * Solo los contenedores que la herramienta anuncia (MP4/M4V, MOV, WebM, MKV): con `ALL_FORMATS` el worker arrastraba tambien los
 * lectores de MP3, Ogg, FLAC, WAV, ADTS, MPEG-TS y HLS (~40 % mas de codigo) sin que ninguno de esos sea un video de entrada.
 */
const INPUT_FORMATS = [MP4, QTFF, WEBM, MATROSKA];

function openInput(file: Blob): Input {
  return new Input({ source: new BlobSource(file), formats: INPUT_FORMATS });
}

const FPS_SAMPLE_PACKETS = 120;

/** Lee la cabecera del video: duracion, medidas, ritmo, codecs y si este navegador puede decodificarlos. */
export async function probeVideo(file: File): Promise<VideoInfo> {
  if (file.size === 0) throw new VideoError("unreadable", "empty");
  const input = openInput(file);
  try {
    let container: string;
    try {
      container = (await input.getFormat()).name;
    } catch (error) {
      throw classifyVideoError(error);
    }
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new VideoError("noVideoTrack");
    const audio = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();

    const [width, height, rotation, canDecodeVideo, hdr] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.getRotation(),
      video.canDecode().catch(() => false),
      video.hasHighDynamicRange().catch(() => false),
    ]);
    const stats = await video.computePacketStats(FPS_SAMPLE_PACKETS).catch(() => null);
    const fps = stats && Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0 ? stats.averagePacketRate : null;

    let audioInfo: VideoInfo["audio"] = null;
    if (audio) {
      const [channels, sampleRate, canDecode] = await Promise.all([
        audio.getNumberOfChannels().catch(() => 2),
        audio.getSampleRate().catch(() => 48_000),
        audio.canDecode().catch(() => false),
      ]);
      const audioStats = await audio.computePacketStats(FPS_SAMPLE_PACKETS).catch(() => null);
      audioInfo = {
        codec: audio.codec,
        channels,
        sampleRate,
        bitrate: audioStats && audioStats.averageBitrate > 0 ? Math.round(audioStats.averageBitrate) : null,
        canDecode,
      };
    }

    // bits/s medios del video: lo que pesa el archivo entero menos el audio. Mas fiable que el de unos pocos paquetes
    // (el primero es un fotograma clave, mucho mayor que la media).
    const total = duration > 0 ? (file.size * 8) / duration : 0;
    const videoBitrate = total > 0 ? Math.max(total * 0.3, total - (audioInfo?.bitrate ?? 0)) : null;

    return {
      container,
      duration,
      width,
      height,
      rotation,
      fps,
      videoCodec: video.codec,
      videoBitrate: videoBitrate ? Math.round(videoBitrate) : null,
      canDecodeVideo,
      hdr,
      audio: audioInfo,
      fileSize: file.size,
    };
  } catch (error) {
    throw classifyVideoError(error);
  } finally {
    input.dispose();
  }
}

export type ConvertHooks = {
  /** 0..1 y segundos del original ya procesados. */
  onProgress: (progress: number, processedSeconds: number) => void;
  signal: AbortSignal;
};

export type ConvertOutcome = {
  buffer: ArrayBuffer;
  /** El plan llevaba audio y la libreria no pudo conservarlo (el resultado sale sin sonido). */
  audioDropped: boolean;
};

function videoOptions(plan: ConversionPlan): ConversionVideoOptions {
  const video = plan.video;
  if (video.mode === "copy") return { codec: video.codec };
  return {
    codec: video.codec,
    quality: new Quality({ bitrate: video.bitrate ?? undefined }),
    forceTranscode: true,
    ...(video.resize ? { width: video.width, height: video.height, fit: "fill" as const } : {}),
    ...(video.fpsCap ? { frameRate: video.fpsCap } : {}),
  };
}

function audioOptions(plan: ConversionPlan): ConversionAudioOptions {
  const audio = plan.audio;
  if (audio.mode === "none") return { discard: true };
  if (audio.mode === "copy") return {};
  return {
    codec: audio.codec,
    quality: new Quality({ bitrate: audio.bitrate }),
    numberOfChannels: audio.channels,
    forceTranscode: true,
  };
}

/** Convierte `file` segun `plan`. Cancelable con `hooks.signal`; lanza `VideoError`. */
export async function convertVideo(file: File, plan: ConversionPlan, hooks: ConvertHooks): Promise<ConvertOutcome> {
  if (hooks.signal.aborted) throw new VideoError("cancelled");
  const input = openInput(file);
  const target = new BufferTarget();
  const output = new Output({
    format: plan.format === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target,
  });
  let conversion: Conversion | null = null;
  const onAbort = () => void conversion?.cancel();
  try {
    conversion = await Conversion.init({
      input,
      output,
      // Solo la imagen y el audio principales: un MKV con varios idiomas o subtitulos no arrastra pistas que el plan no cuenta.
      tracks: "primary",
      video: videoOptions(plan),
      audio: audioOptions(plan),
      showWarnings: false,
    });
    if (hooks.signal.aborted) throw new VideoError("cancelled");
    hooks.signal.addEventListener("abort", onAbort, { once: true });

    // Sin pista de video en el resultado no hay conversion, aunque la libreria la considere «valida» (con solo audio).
    if (!conversion.utilizedTracks.some((track) => track.isVideoTrack())) {
      const dropped = conversion.discardedTracks.find((entry) => entry.track.isVideoTrack());
      const reason = dropped?.reason;
      if (reason === "undecodable_source_codec" || reason === "unknown_source_codec") throw new VideoError("cannotDecodeVideo");
      if (reason === "no_encodable_target_codec") throw new VideoError("cannotEncode");
      throw new VideoError("failed", reason ?? "no video track used");
    }

    conversion.onProgress = (progress, seconds) => hooks.onProgress(Math.min(1, Math.max(0, progress)), seconds);
    await conversion.execute();
    if (hooks.signal.aborted) throw new VideoError("cancelled");

    const buffer = target.buffer;
    if (!buffer) throw new VideoError("failed", "empty output");
    const audioWanted = plan.audio.mode !== "none";
    const audioDropped =
      audioWanted &&
      conversion.discardedTracks.some((entry) => entry.track.isAudioTrack() && entry.reason !== "discarded_by_user");
    return { buffer, audioDropped };
  } catch (error) {
    if (hooks.signal.aborted) throw new VideoError("cancelled");
    throw classifyVideoError(error);
  } finally {
    hooks.signal.removeEventListener("abort", onAbort);
    input.dispose();
  }
}
