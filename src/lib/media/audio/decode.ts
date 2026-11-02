import { canDecodePackets } from "@/lib/media/audio/capabilities";
import type { AudioTrackInfo, EncodedPacket } from "@/lib/media/audio/containers";
import { AudioError, throwIfAborted, toAudioError } from "@/lib/media/audio/errors";
import {
  MAX_AUDIO_FILE_BYTES,
  MAX_DIRECT_DECODE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  decodedBudgetBytes,
  decodedBytes,
  minutesThatFit,
} from "@/lib/media/audio/limits";
import { readMp4 } from "@/lib/media/audio/mp4";
import { yieldToBrowser } from "@/lib/media/audio/pcm";
import { probeMedia, type MediaProbe } from "@/lib/media/audio/probe";
import type { PcmAudio, Progress } from "@/lib/media/audio/types";
import { frameCount } from "@/lib/media/audio/types";
import { decodeWav } from "@/lib/media/audio/wav";
import { readWebm } from "@/lib/media/audio/webm";

/**
 * Decodificacion de un archivo de audio o de video a muestras.
 *
 * Orden (de mas fiel a mas general), siempre en el dispositivo:
 *  1. WAV: lector propio (conserva la frecuencia original, no depende del navegador).
 *  2. `decodeAudioData` del navegador: MP3, AAC/M4A, OGG, Opus, FLAC y el audio de MP4/MOV/WebM, segun lo que traiga
 *     ese navegador. Exige entregarle el archivo entero, asi que solo se usa por debajo de un tope de tamano.
 *  3. Lector de contenedor propio (MP4/MOV y WebM/MKV) + `AudioDecoder` de WebCodecs: lee solo la pista de audio por
 *     trozos (sirve para videos grandes) y abre lo que `decodeAudioData` no abre (p. ej. WebM en Safari).
 * Antes de decodificar se avisa si el audio no cabe en la memoria del dispositivo.
 */

export type DecodeContext = { signal?: AbortSignal; onProgress?: Progress };

export type DecodeResult = {
  audio: PcmAudio;
  probe: MediaProbe;
  via: "wav" | "web-audio" | "webcodecs";
};

const clampRate = (rate: number | undefined) => Math.min(96000, Math.max(8000, rate ?? 48000));

function checkBudget(probe: MediaProbe, fallbackChannels = 2): void {
  if (!probe.durationSec || !probe.sampleRate) return;
  const bytes = decodedBytes(probe.durationSec, probe.sampleRate, probe.channels ?? fallbackChannels);
  if (bytes > decodedBudgetBytes()) throw new AudioError("tooLong", String(minutesThatFit()));
}

function planarOf(buffer: AudioBuffer): PcmAudio {
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)),
  };
}

async function decodeWithWebAudio(file: Blob, probe: MediaProbe, signal: AbortSignal | undefined, onProgress: Progress | undefined): Promise<PcmAudio> {
  if (typeof OfflineAudioContext === "undefined") throw new AudioError("unsupportedFormat", "no-web-audio");
  onProgress?.(0.05);
  const bytes = await file.arrayBuffer();
  throwIfAborted(signal);
  onProgress?.(0.35);
  // El contexto fija la frecuencia de lo decodificado: se usa la del archivo (sondeada) para no remuestrear.
  const context = new OfflineAudioContext(1, 1, clampRate(probe.sampleRate));
  const buffer = await context.decodeAudioData(bytes);
  throwIfAborted(signal);
  onProgress?.(1);
  return planarOf(buffer);
}

type Demuxed = { track: AudioTrackInfo; packets: () => AsyncGenerator<EncodedPacket> };

async function demux(file: Blob, probe: MediaProbe): Promise<Demuxed | null> {
  if (probe.kind === "mp4") {
    const mp4 = await readMp4(file);
    const track = mp4?.structure.audioTracks.find((candidate) => candidate.codec) ?? null;
    if (!mp4 || !track || mp4.structure.fragmented) return null;
    return { track, packets: () => mp4.packets(track.trackId) };
  }
  if (probe.kind === "webm") {
    const webm = await readWebm(file);
    const track = webm?.structure.audioTracks.find((candidate) => candidate.codec) ?? null;
    if (!webm || !track) return null;
    return { track, packets: () => webm.packets(track.trackId) };
  }
  return null;
}

async function decodeWithWebCodecs(demuxed: Demuxed, signal: AbortSignal | undefined, onProgress: Progress | undefined): Promise<PcmAudio> {
  const { track } = demuxed;
  const config: AudioDecoderConfig = {
    codec: track.codec as string,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    ...(track.description ? { description: track.description as BufferSource } : {}),
  };
  const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) throw new AudioError("unsupportedFormat", track.rawCodec);

  const budget = decodedBudgetBytes();
  const parts: Float32Array[][] = [];
  let sampleRate = track.sampleRate;
  let frames = 0;
  let failure: unknown = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        sampleRate = data.sampleRate;
        const planes: Float32Array[] = [];
        for (let plane = 0; plane < data.numberOfChannels; plane += 1) {
          const out = new Float32Array(data.numberOfFrames);
          data.copyTo(out, { planeIndex: plane, format: "f32-planar" });
          planes.push(out);
        }
        parts.push(planes);
        frames += data.numberOfFrames;
        if (frames * planes.length * 4 > budget) failure = new AudioError("tooLong", String(minutesThatFit()));
      } finally {
        data.close();
      }
    },
    error: (error) => {
      failure = error;
    },
  });
  try {
    decoder.configure(config);
    const total = track.durationSec ? track.durationSec * 1e6 : 0;
    let count = 0;
    for await (const packet of demuxed.packets()) {
      throwIfAborted(signal);
      if (failure) throw failure;
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: packet.timestampUs, duration: packet.durationUs, data: packet.data }));
      while (decoder.decodeQueueSize > 24) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20);
          decoder.addEventListener(
            "dequeue",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (failure) throw failure;
        throwIfAborted(signal);
      }
      count += 1;
      if (total > 0) onProgress?.(Math.min(0.97, packet.timestampUs / total));
      if (count % 200 === 0) await yieldToBrowser();
    }
    await decoder.flush();
    if (failure) throw failure;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  if (frames === 0) throw new AudioError("empty");
  const channelCount = parts[0].length;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  let offset = 0;
  for (const part of parts) {
    part.forEach((plane, index) => channels[index].set(plane, offset));
    offset += part[0].length;
  }
  onProgress?.(1);
  return { sampleRate, channels };
}

/**
 * Comprobaciones previas con lo que dice la sonda, SIN decodificar: tamano, video sin audio y memoria. Las usa
 * `decodeMedia` y tambien la interfaz al anadir un archivo (para avisar antes de pulsar «Procesar»).
 */
export function assertProbeAllowed(file: Blob, probe: MediaProbe): void {
  if (file.size === 0) throw new AudioError("empty");
  const isContainer = probe.kind === "mp4" || probe.kind === "webm";
  if (file.size > (isContainer ? MAX_VIDEO_FILE_BYTES : MAX_AUDIO_FILE_BYTES)) throw new AudioError("tooLarge");
  // Estructura leida y sin pista de audio: es un video mudo (no un archivo danado).
  if (probe.hasAudio === false) throw new AudioError("noAudioTrack");
  checkBudget(probe);
}

export type FileCheck = { ok: true; probe: MediaProbe } | { ok: false; code: AudioError["code"]; detail?: string };

export async function checkMediaFile(file: Blob): Promise<FileCheck> {
  if (file.size === 0) return { ok: false, code: "empty" };
  let probe: MediaProbe = { kind: "unknown" };
  try {
    probe = await probeMedia(file);
  } catch {
    // La sonda es solo ayuda: sin ella se decide al procesar.
  }
  try {
    assertProbeAllowed(file, probe);
    return { ok: true, probe };
  } catch (error) {
    const known = toAudioError(error);
    return { ok: false, code: known.code, detail: known.detail };
  }
}

export async function decodeMedia(file: Blob, context: DecodeContext = {}): Promise<DecodeResult> {
  const { signal, onProgress } = context;
  if (file.size === 0) throw new AudioError("empty");
  throwIfAborted(signal);

  let probe: MediaProbe;
  try {
    probe = await probeMedia(file);
  } catch {
    probe = { kind: "unknown" };
  }
  throwIfAborted(signal);

  assertProbeAllowed(file, probe);
  const isContainer = probe.kind === "mp4" || probe.kind === "webm";

  try {
    if (probe.kind === "wav") {
      try {
        const audio = decodeWav(new Uint8Array(await file.arrayBuffer()));
        onProgress?.(1);
        return { audio, probe, via: "wav" };
      } catch (error) {
        // WAV con un formato que el lector propio no cubre (ADPCM...): se intenta con el navegador.
        if (!(error instanceof AudioError && error.code === "unsupportedFormat")) throw error;
      }
    }

    const directLimit = isContainer ? MAX_DIRECT_DECODE_BYTES : MAX_AUDIO_FILE_BYTES;
    let direct: unknown = null;
    if (file.size <= directLimit) {
      try {
        const audio = await decodeWithWebAudio(file, probe, signal, onProgress);
        if (frameCount(audio) === 0) throw new AudioError("empty");
        return { audio, probe, via: "web-audio" };
      } catch (error) {
        const known = toAudioError(error);
        // Memoria agotada o cancelacion: no tiene sentido probar otra via. Lo demas (formato no abierto): se prueba la siguiente.
        if (known.code === "outOfMemory" || known.code === "cancelled" || known.code === "tooLong" || known.code === "empty") throw known;
        direct = error;
      }
    }

    if (isContainer && canDecodePackets()) {
      const demuxed = await demux(file, probe);
      if (demuxed) {
        const audio = await decodeWithWebCodecs(demuxed, signal, onProgress);
        return { audio, probe, via: "webcodecs" };
      }
    }

    if (direct === null) throw new AudioError("tooLarge");
    // Ningun decodificador de este navegador pudo con el archivo: danado o formato no soportado.
    const rawCodec = probe.structure?.audioTracks[0]?.rawCodec;
    throw new AudioError(probe.kind === "unknown" ? "corrupt" : "unsupportedFormat", rawCodec);
  } catch (error) {
    throw toAudioError(error);
  }
}
