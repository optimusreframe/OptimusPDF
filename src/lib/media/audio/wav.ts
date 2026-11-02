import { AudioError, throwIfAborted } from "@/lib/media/audio/errors";
import { MAX_WAV_BYTES } from "@/lib/media/audio/limits";
import { yieldToBrowser } from "@/lib/media/audio/pcm";
import type { PcmAudio, PcmSource, Progress } from "@/lib/media/audio/types";

/**
 * WAV (RIFF/PCM). Codificador propio de 16 bits y lector propio de PCM 8/16/24/32 bits y flotante 32/64 bits.
 *
 * El lector evita `decodeAudioData` para los WAV: no remuestrea (conserva la frecuencia original), no depende de
 * codecs del navegador y se puede probar en Node.
 */

const BLOCK_FRAMES = 1 << 15;
const HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Cabecera RIFF/WAVE de 44 bytes para PCM de 16 bits. */
export function wavHeader(frames: number, sampleRate: number, channels: number): ArrayBuffer {
  const dataBytes = frames * channels * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // tamano del bloque fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // bytes por segundo
  view.setUint16(32, channels * 2, true); // alineacion de bloque
  view.setUint16(34, 16, true); // bits por muestra
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

/** Codifica un origen como WAV de 16 bits, leyendo por bloques (cede el hilo y respeta la cancelacion). */
export async function encodeWav(source: PcmSource, signal?: AbortSignal, onProgress?: Progress): Promise<Blob> {
  const channels = source.numberOfChannels;
  const dataBytes = source.length * channels * 2;
  if (HEADER_BYTES + dataBytes > MAX_WAV_BYTES) throw new AudioError("tooLong");
  const parts: ArrayBuffer[] = [wavHeader(source.length, source.sampleRate, channels)];

  for (let start = 0; start < source.length; start += BLOCK_FRAMES) {
    throwIfAborted(signal);
    const end = Math.min(source.length, start + BLOCK_FRAMES);
    const block = source.read(start, end);
    const frames = end - start;
    const out = new Int16Array(frames * channels);
    for (let c = 0; c < channels; c += 1) {
      const channel = block[c];
      for (let i = 0; i < frames; i += 1) {
        const value = channel[i];
        // Redondeo al entero mas cercano con recorte: sin "dither", fiel a la muestra original (ida y vuelta exacta).
        const scaled = Math.round(value * 32768);
        out[i * channels + c] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
      }
    }
    parts.push(out.buffer as ArrayBuffer);
    onProgress?.(end / source.length);
    if ((start / BLOCK_FRAMES) % 8 === 7) await yieldToBrowser();
  }
  onProgress?.(1);
  return new Blob(parts, { type: "audio/wav" });
}

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 = PCM entero, 3 = flotante. */
  format: 1 | 3;
  dataOffset: number;
  dataBytes: number;
  frames: number;
};

/** Lee la cabecera de un WAV (devuelve `null` si no es un WAV PCM/flotante que sepamos leer). */
export function parseWavHeader(bytes: Uint8Array, fileSize: number = bytes.length): WavInfo | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let format: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: el formato real va en el GUID del subformato.
      if (format === 0xfffe && size >= 40 && body + 26 <= bytes.length) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      if (format !== 1 && format !== 3) return null;
      if (channels < 1 || sampleRate < 1 || bits < 8) return null;
      // Un `data` con tamano 0 o desmedido (archivo en directo) ocupa hasta el final.
      if (size === 0 || body + size > fileSize) size = fileSize - body;
      const bytesPerFrame = channels * (bits / 8);
      if (!Number.isInteger(bytesPerFrame) || bytesPerFrame < 1) return null;
      const frames = Math.floor(size / bytesPerFrame);
      return { sampleRate, channels, bitsPerSample: bits, format, dataOffset: body, dataBytes: frames * bytesPerFrame, frames };
    }
    offset = body + size + (size % 2); // los bloques RIFF se alinean a par
  }
  return null;
}

/** Decodifica un WAV PCM/flotante entero. Lanza `AudioError` si no es legible. */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  const info = parseWavHeader(bytes);
  if (!info) throw new AudioError("unsupportedFormat", "wav");
  if (info.frames === 0) throw new AudioError("empty");
  const { channels, frames, bitsPerSample: bits, dataOffset } = info;
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, info.dataBytes);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const step = bits / 8;

  const read: (position: number) => number =
    info.format === 3
      ? bits === 32
        ? (p) => view.getFloat32(p, true)
        : bits === 64
          ? (p) => view.getFloat64(p, true)
          : () => {
              throw new AudioError("unsupportedFormat", "wav-float");
            }
      : bits === 8
        ? (p) => (view.getUint8(p) - 128) / 128
        : bits === 16
          ? (p) => view.getInt16(p, true) / 32768
          : bits === 24
            ? (p) => {
                const v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
                return ((v << 8) >> 8) / 8388608;
              }
            : bits === 32
              ? (p) => view.getInt32(p, true) / 2147483648
              : () => {
                  throw new AudioError("unsupportedFormat", "wav-bits");
                };

  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      out[c][i] = read((i * channels + c) * step);
    }
  }
  return { sampleRate: info.sampleRate, channels: out };
}
