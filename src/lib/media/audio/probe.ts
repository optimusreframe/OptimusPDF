import { BlobReader } from "@/lib/media/audio/blobReader";
import type { MediaStructure } from "@/lib/media/audio/containers";
import { looksLikeMp4, readMp4 } from "@/lib/media/audio/mp4";
import { parseWavHeader } from "@/lib/media/audio/wav";
import { looksLikeWebm, readWebm } from "@/lib/media/audio/webm";

/**
 * Sonda barata de un archivo: mira unos bytes (y, en video, solo la estructura del contenedor) para saber su tipo,
 * frecuencia, canales y duracion SIN decodificarlo. Sirve para tres cosas: avisar de un audio demasiado largo antes de
 * gastar memoria, decodificar con la frecuencia original y distinguir un video SIN pista de audio de un archivo danado.
 * Todo es mejor esfuerzo: un campo `undefined` significa «no se pudo saber», nunca «no existe».
 */

export type MediaKind = "wav" | "mp3" | "flac" | "ogg" | "aac" | "mp4" | "webm" | "unknown";

export type MediaProbe = {
  kind: MediaKind;
  sampleRate?: number;
  channels?: number;
  durationSec?: number;
  /** Solo contenedores de video: hay al menos una pista de video. */
  hasVideo?: boolean;
  /** `false` solo cuando se LEYO la estructura y no habia pista de audio; `undefined` = no se pudo saber. */
  hasAudio?: boolean;
  structure?: MediaStructure;
};

const ASCII = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...Array.from(bytes.subarray(offset, offset + length)));

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

async function probeMp3(reader: BlobReader): Promise<MediaProbe | null> {
  let pos = 0;
  const head = await reader.bytes(0, 10);
  if (ASCII(head, 0, 3) === "ID3" && head.length >= 10) {
    pos = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
  }
  // Busca el primer sincronismo de trama cerca del punto esperado (relleno o etiquetas intermedias).
  const window = await reader.bytes(pos, 4096);
  for (let i = 0; i + 4 <= window.length; i += 1) {
    if (window[i] !== 0xff || (window[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (window[i + 1] >> 3) & 3;
    const layer = (window[i + 1] >> 1) & 3;
    if (version === 1 || layer === 0) continue;
    const bitrateIndex = (window[i + 2] >> 4) & 15;
    const rateIndex = (window[i + 2] >> 2) & 3;
    if (bitrateIndex === 15 || rateIndex === 3) continue;
    const sampleRate = MP3_RATES[version]?.[rateIndex];
    if (!sampleRate) continue;
    const mono = ((window[i + 3] >> 6) & 3) === 3;
    const probe: MediaProbe = { kind: "mp3", sampleRate, channels: mono ? 1 : 2 };
    if (layer === 1) {
      const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] * 1000;
      const samplesPerFrame = version === 3 ? 1152 : 576;
      // Cabecera Xing/Info: guarda el numero de tramas, y con ello la duracion exacta (tambien en VBR).
      const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
      const tag = ASCII(window, i + 4 + sideInfo, 4);
      if ((tag === "Xing" || tag === "Info") && i + 4 + sideInfo + 12 <= window.length) {
        const flags = window[i + 4 + sideInfo + 7];
        if (flags & 1) {
          const view = new DataView(window.buffer, window.byteOffset + i + 4 + sideInfo + 8, 4);
          probe.durationSec = (view.getUint32(0) * samplesPerFrame) / sampleRate;
        }
      }
      if (probe.durationSec === undefined && bitrate > 0) probe.durationSec = ((reader.size - pos) * 8) / bitrate;
    }
    return probe;
  }
  return null;
}

async function probeOgg(reader: BlobReader): Promise<MediaProbe> {
  const head = await reader.bytes(0, 512);
  const probe: MediaProbe = { kind: "ogg" };
  const segments = head[26] ?? 0;
  const packet = 27 + segments;
  let preSkip = 0;
  let divisor = 0;
  if (ASCII(head, packet, 8) === "OpusHead") {
    probe.channels = head[packet + 9];
    probe.sampleRate = 48000;
    preSkip = head[packet + 10] | (head[packet + 11] << 8);
    divisor = 48000;
  } else if (ASCII(head, packet, 7) === "\x01vorbis") {
    probe.channels = head[packet + 11];
    probe.sampleRate = new DataView(head.buffer, head.byteOffset + packet + 12, 4).getUint32(0, true);
    divisor = probe.sampleRate;
  }
  if (divisor > 0 && reader.size > 64) {
    const tailStart = Math.max(0, reader.size - 65536);
    const tail = await reader.copy(tailStart, reader.size - tailStart);
    for (let i = tail.length - 27; i >= 0; i -= 1) {
      if (tail[i] === 0x4f && ASCII(tail, i, 4) === "OggS") {
        const view = new DataView(tail.buffer, tail.byteOffset + i + 6, 8);
        const granule = view.getUint32(0, true) + view.getUint32(4, true) * 4294967296;
        if (granule > 0) probe.durationSec = Math.max(0, granule - preSkip) / divisor;
        break;
      }
    }
  }
  return probe;
}

export async function probeMedia(blob: Blob): Promise<MediaProbe> {
  const reader = new BlobReader(blob);
  const head = await reader.bytes(0, 64 * 1024);
  if (head.length < 4) return { kind: "unknown" };

  if (ASCII(head, 0, 4) === "RIFF" && ASCII(head, 8, 4) === "WAVE") {
    const info = parseWavHeader(head, blob.size);
    return info
      ? { kind: "wav", sampleRate: info.sampleRate, channels: info.channels, durationSec: info.frames / info.sampleRate }
      : { kind: "wav" };
  }
  if (ASCII(head, 0, 4) === "fLaC" && head.length >= 26) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const hi = view.getUint32(18);
    const sampleRate = hi >>> 12;
    const channels = ((hi >> 9) & 7) + 1;
    const total = (hi & 15) * 4294967296 + view.getUint32(22);
    return { kind: "flac", sampleRate, channels, durationSec: sampleRate > 0 && total > 0 ? total / sampleRate : undefined };
  }
  if (ASCII(head, 0, 4) === "OggS") return probeOgg(reader);
  if (looksLikeWebm(head)) {
    const webm = await readWebm(blob);
    return fromStructure("webm", webm?.structure);
  }
  if (looksLikeMp4(head)) {
    const mp4 = await readMp4(blob);
    return fromStructure("mp4", mp4?.structure);
  }
  // ADTS (.aac): 0xFFF + capa 00.
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) {
    const rateIndex = (head[2] >> 2) & 15;
    const channels = ((head[2] & 1) << 2) | (head[3] >> 6);
    return { kind: "aac", sampleRate: ADTS_RATES[rateIndex], channels: channels || undefined };
  }
  if (ASCII(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
    return (await probeMp3(reader)) ?? { kind: "unknown" };
  }
  return { kind: "unknown" };
}

function fromStructure(kind: "mp4" | "webm", structure: MediaStructure | undefined): MediaProbe {
  if (!structure) return { kind };
  const audio = structure.audioTracks[0];
  return {
    kind,
    structure,
    hasVideo: structure.videoTracks > 0,
    // En un MP4 fragmentado las muestras no estan en `moov`, pero las pistas si: cuenta como «hay audio».
    hasAudio: structure.audioTracks.length > 0,
    sampleRate: audio?.sampleRate,
    channels: audio?.channels,
    durationSec: audio?.durationSec ?? structure.durationSec,
  };
}
