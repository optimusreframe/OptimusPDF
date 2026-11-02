import { AudioError, throwIfAborted, toAudioError } from "@/lib/media/audio/errors";
import { buildAudioSpecificConfig, muxM4a, stripAdts, type AacPacket } from "@/lib/media/audio/m4a";
import { muxOggOpus, type OpusPacket } from "@/lib/media/audio/ogg";
import { remixSource, yieldToBrowser } from "@/lib/media/audio/pcm";
import { resampleSource } from "@/lib/media/audio/resample";
import { clampMp3BitrateKbps, snapMp3SampleRate } from "@/lib/media/audio/mp3Params";
import { encodeWav } from "@/lib/media/audio/wav";
import { detectOutputSupport } from "@/lib/media/audio/capabilities";
import type { EncodeOptions, OutputFormat, PcmSource, Progress } from "@/lib/media/audio/types";

/**
 * Codificacion a WAV, M4A (AAC), Opus y MP3.
 *
 * Todos parten de un `PcmSource` peresoso: primero se ajustan los canales y la frecuencia pedidos y despues se
 * codifica por bloques. WAV usa el codificador propio; M4A y Opus usan `AudioEncoder` (WebCodecs) y se empaquetan con
 * `m4a.ts` / `ogg.ts`; MP3 usa LAME en WebAssembly (`mp3.ts`, que se carga SOLO al elegirlo). Todo en el dispositivo,
 * con progreso real y cancelacion.
 */

export type EncodeContext = { signal?: AbortSignal; onProgress?: Progress };

/** Canales y frecuencia con que se codificara, resueltos a partir de las opciones y del origen. */
export function resolveTarget(source: { sampleRate: number; numberOfChannels: number }, options: EncodeOptions): { sampleRate: number; channels: number } {
  const lossy = options.format !== "wav";
  const channels = options.channels === "original" ? (lossy ? Math.min(2, source.numberOfChannels) : source.numberOfChannels) : options.channels;
  let sampleRate = options.format === "opus" ? 48000 : options.sampleRate === "original" ? source.sampleRate : options.sampleRate;
  // MP3 solo existe a nueve frecuencias: lo pedido (o la del original) se lleva a la valida mas cercana.
  if (options.format === "mp3") sampleRate = snapMp3SampleRate(sampleRate);
  return { sampleRate, channels };
}

/** Tamano aproximado (bytes) de la salida, para avisar antes de empezar. */
export function estimateOutputBytes(durationSec: number, source: { sampleRate: number; numberOfChannels: number }, options: EncodeOptions): number {
  const target = resolveTarget(source, options);
  if (options.format === "wav") return Math.round(durationSec * target.sampleRate * target.channels * 2) + 44;
  const kbps = options.format === "mp3" ? clampMp3BitrateKbps(options.bitrateKbps, target.sampleRate) : options.bitrateKbps;
  return Math.round((durationSec * kbps * 1000) / 8);
}

export async function encodeAudio(source: PcmSource, options: EncodeOptions, context: EncodeContext = {}): Promise<Blob> {
  const { signal, onProgress } = context;
  if (source.length <= 0) throw new AudioError("empty");
  throwIfAborted(signal);
  const target = resolveTarget(source, options);
  const prepared = resampleSource(remixSource(source, target.channels), target.sampleRate);
  try {
    if (options.format === "wav") return await encodeWav(prepared, signal, onProgress);
    if (options.format === "mp3") {
      // Import dinamico: LAME (WASM) y mediabunny solo se descargan al elegir MP3. Si el trozo no carga (sin red), se dice.
      const { encodeMp3 } = await import("@/lib/media/audio/mp3").catch(() => {
        throw new AudioError("encoderUnavailable", "mp3-chunk");
      });
      return await encodeMp3(prepared, options.bitrateKbps, signal, onProgress);
    }
    return await encodeWithWebCodecs(prepared, options.format, options.bitrateKbps, signal, onProgress);
  } catch (error) {
    throw toAudioError(error);
  }
}

type RawChunk = { data: Uint8Array; samples: number };

/** Copia la configuracion del decodificador (ArrayBuffer o vista) en un `Uint8Array` propio. */
function toBytes(raw: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
  return new Uint8Array((raw as ArrayBuffer).slice(0));
}

/** Paquetes comprimidos con `AudioEncoder`, mas la configuracion que da el codificador (ASC / OpusHead). */
async function runAudioEncoder(
  source: PcmSource,
  config: AudioEncoderConfig,
  signal: AbortSignal | undefined,
  onProgress: Progress | undefined,
): Promise<{ chunks: RawChunk[]; description?: Uint8Array }> {
  const chunks: RawChunk[] = [];
  let description: Uint8Array | undefined;
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const samples = chunk.duration ? Math.round((chunk.duration * config.sampleRate) / 1e6) : 0;
      chunks.push({ data, samples });
      const raw = metadata?.decoderConfig?.description;
      if (raw && !description) description = toBytes(raw);
    },
    error: (error) => {
      failure = error;
    },
  });
  try {
    encoder.configure(config);
    const channels = source.numberOfChannels;
    const block = Math.max(1024, Math.round(source.sampleRate / 2));
    let blocks = 0;
    for (let start = 0; start < source.length; start += block) {
      throwIfAborted(signal);
      if (failure) throw failure;
      const end = Math.min(source.length, start + block);
      const planes = source.read(start, end);
      const frames = end - start;
      const packed = new Float32Array(frames * channels);
      planes.forEach((plane, index) => packed.set(plane, index * frames));
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: source.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((start / source.sampleRate) * 1e6),
        data: packed,
      });
      encoder.encode(data);
      data.close();
      // Contrapresion: no se apila el archivo entero en la cola del codificador.
      while (encoder.encodeQueueSize > 6) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30);
          encoder.addEventListener(
            "dequeue",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        throwIfAborted(signal);
        if (failure) throw failure;
      }
      onProgress?.((end / source.length) * 0.95);
      blocks += 1;
      if (blocks % 4 === 0) await yieldToBrowser();
    }
    await encoder.flush();
    if (failure) throw failure;
    onProgress?.(1);
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  return { chunks, description };
}

async function encodeWithWebCodecs(
  source: PcmSource,
  format: Exclude<OutputFormat, "wav" | "mp3">,
  bitrateKbps: number,
  signal: AbortSignal | undefined,
  onProgress: Progress | undefined,
): Promise<Blob> {
  const support = (await detectOutputSupport())[format];
  if (!support.available) throw new AudioError("encoderUnavailable", format);

  const bitrate = Math.round(bitrateKbps * 1000);
  const base: AudioEncoderConfig =
    format === "opus"
      ? { codec: "opus", sampleRate: 48000, numberOfChannels: source.numberOfChannels, bitrate, opus: { application: "audio", frameDuration: 20000 } as OpusEncoderConfig }
      : ({ codec: "mp4a.40.2", sampleRate: source.sampleRate, numberOfChannels: source.numberOfChannels, bitrate, aac: { format: "aac" } } as AudioEncoderConfig);
  const checked = await AudioEncoder.isConfigSupported(base).catch(() => null);
  if (!checked?.supported) throw new AudioError("encoderUnavailable", `${format}-config`);
  const config = checked.config ?? base;

  const { chunks, description } = await runAudioEncoder(source, config, signal, onProgress);
  if (chunks.length === 0) throw new AudioError("unknown", "no-packets");

  if (format === "opus") {
    const packets: OpusPacket[] = chunks.map((chunk) => ({ data: chunk.data, samples: chunk.samples || 960 }));
    // El OpusHead del codificador, si lo da, marca su retraso real; si no, el valor estandar de libopus.
    let preSkip: number | undefined;
    if (description && description.length >= 12 && String.fromCharCode(...description.subarray(0, 8)) === "OpusHead") {
      preSkip = description[10] | (description[11] << 8);
    }
    return muxOggOpus(packets, { channels: source.numberOfChannels, inputSampleRate: source.sampleRate, inputFrames48k: source.length, preSkip });
  }

  const raw: AacPacket[] = chunks.map((chunk) => ({ data: chunk.data, samples: chunk.samples || 1024 }));
  const stripped = stripAdts(raw);
  const sampleRate = stripped.config?.sampleRate ?? source.sampleRate;
  const channels = stripped.config?.channels ?? source.numberOfChannels;
  const asc = description && description.length >= 2 ? description : buildAudioSpecificConfig(sampleRate, channels);
  return muxM4a(stripped.packets, { sampleRate, channels, bitrate, config: asc });
}
