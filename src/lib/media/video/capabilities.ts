import {
  AUDIO_ENCODER_PROBES,
  FORMAT_INFO,
  OUTPUT_FORMATS,
  VIDEO_ENCODER_PROBES,
  type AudioCodecId,
  type OutputFormat,
  type VideoCodecId,
} from "@/lib/media/video/formats";

/**
 * Que puede hacer ESTE navegador. El convertidor no promete formatos: pregunta a `VideoEncoder.isConfigSupported` y
 * `AudioEncoder.isConfigSupported` y ofrece solo lo posible, con el motivo cuando no (Safari antiguo sin codificador de audio,
 * un Chromium sin H.264, una pagina servida por http fuera de localhost...). `env` se inyecta para poder simular cada caso en
 * las pruebas; en la aplicacion es `globalThis`.
 */

type EncoderApi<C> = { isConfigSupported(config: C): Promise<{ supported?: boolean }> };

export type CodecEnv = {
  VideoEncoder?: EncoderApi<{ codec: string; width: number; height: number; bitrate?: number; framerate?: number }>;
  AudioEncoder?: EncoderApi<{ codec: string; numberOfChannels: number; sampleRate: number; bitrate?: number }>;
  VideoDecoder?: unknown;
  /** WebCodecs solo existe en contextos seguros (https o localhost). */
  isSecureContext?: boolean;
};

/** Por que no hay conversion en absoluto. */
export type NoWebCodecsReason = "insecure-context" | "no-video-encoder" | "no-video-decoder";

/** Por que un formato concreto no se ofrece. */
export type FormatUnavailableReason = "no-video-encoder";

export type FormatCapability = {
  format: OutputFormat;
  /** Se puede producir (hay al menos un codificador de video). */
  available: boolean;
  reason?: FormatUnavailableReason;
  /** Codecs de video que SI se pueden codificar, por orden de preferencia. */
  videoCodecs: VideoCodecId[];
  /** El codificador de audio de este formato existe: si no, el audio solo puede pasar tal cual (sin recodificar) o quitarse. */
  audioEncodable: boolean;
};

export type VideoCapabilities =
  | { supported: false; reason: NoWebCodecsReason; formats: Record<OutputFormat, FormatCapability> }
  | { supported: true; formats: Record<OutputFormat, FormatCapability> };

/** Medidas de la prueba: una resolucion comun, para saber si el codec existe (la resolucion real se comprueba despues). */
const PROBE_VIDEO = { width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 };
const PROBE_AUDIO = { numberOfChannels: 2, sampleRate: 48_000, bitrate: 128_000 };

async function safe(check: () => Promise<{ supported?: boolean }>): Promise<boolean> {
  try {
    return (await check()).supported === true;
  } catch {
    // Un codec que el navegador no entiende lanza TypeError: equivale a «no».
    return false;
  }
}

async function canEncodeVideoCodec(env: CodecEnv, codec: VideoCodecId, size = PROBE_VIDEO): Promise<boolean> {
  const encoder = env.VideoEncoder;
  if (!encoder) return false;
  for (const probe of VIDEO_ENCODER_PROBES[codec]) {
    if (await safe(() => encoder.isConfigSupported({ codec: probe, ...size }))) return true;
  }
  return false;
}

async function canEncodeAudioCodec(env: CodecEnv, codec: AudioCodecId): Promise<boolean> {
  const encoder = env.AudioEncoder;
  if (!encoder) return false;
  return safe(() => encoder.isConfigSupported({ codec: AUDIO_ENCODER_PROBES[codec], ...PROBE_AUDIO }));
}

async function formatCapability(env: CodecEnv, format: OutputFormat): Promise<FormatCapability> {
  const info = FORMAT_INFO[format];
  const videoCodecs: VideoCodecId[] = [];
  for (const codec of info.videoCodecs) {
    if (await canEncodeVideoCodec(env, codec)) videoCodecs.push(codec);
  }
  const audioEncodable = await canEncodeAudioCodec(env, info.audioCodec);
  return videoCodecs.length > 0
    ? { format, available: true, videoCodecs, audioEncodable }
    : { format, available: false, reason: "no-video-encoder", videoCodecs, audioEncodable };
}

export async function detectCapabilities(env: CodecEnv): Promise<VideoCapabilities> {
  const closed = (format: OutputFormat): FormatCapability => ({
    format,
    available: false,
    reason: "no-video-encoder",
    videoCodecs: [],
    audioEncodable: false,
  });
  const none = (reason: NoWebCodecsReason): VideoCapabilities => ({
    supported: false,
    reason,
    formats: { mp4: closed("mp4"), webm: closed("webm") },
  });
  if (env.isSecureContext === false) return none("insecure-context");
  if (typeof env.VideoEncoder === "undefined" || typeof env.VideoEncoder.isConfigSupported !== "function") {
    return none("no-video-encoder");
  }
  if (typeof env.VideoDecoder === "undefined") return none("no-video-decoder");
  const entries = await Promise.all(OUTPUT_FORMATS.map(async (format) => [format, await formatCapability(env, format)] as const));
  const formats = Object.fromEntries(entries) as Record<OutputFormat, FormatCapability>;
  // WebCodecs existe, pero ningun formato tiene codificador de video: tampoco hay conversion posible.
  if (!OUTPUT_FORMATS.some((format) => formats[format].available)) return { supported: false, reason: "no-video-encoder", formats };
  return { supported: true, formats };
}

/**
 * ¿El codificador acepta la configuracion REAL (medidas y ritmo del resultado)? Un H.264 de 4K o de 60 fps puede no existir en
 * un movil aunque 720p si. Se pregunta con las medidas finales, antes de empezar, para avisar en el acto en vez de fallar a
 * los 20 segundos. Devuelve `true` si no se puede preguntar (sin `VideoEncoder`), para no bloquear algo que si podria andar.
 */
export async function canEncodeVideoAt(
  env: CodecEnv,
  codec: VideoCodecId,
  size: { width: number; height: number; bitrate: number; framerate: number },
): Promise<boolean> {
  if (!env.VideoEncoder) return true;
  return canEncodeVideoCodec(env, codec, size);
}

/** Entorno real del navegador (`globalThis`), recortado a lo que `detectCapabilities` mira. */
export function browserCodecEnv(): CodecEnv {
  const scope = globalThis as unknown as CodecEnv;
  return {
    VideoEncoder: scope.VideoEncoder,
    AudioEncoder: scope.AudioEncoder,
    VideoDecoder: scope.VideoDecoder,
    isSecureContext: typeof scope.isSecureContext === "boolean" ? scope.isSecureContext : undefined,
  };
}
