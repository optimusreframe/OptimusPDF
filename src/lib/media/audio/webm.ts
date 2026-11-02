import { BlobReader } from "@/lib/media/audio/blobReader";
import type { AudioTrackInfo, EncodedPacket, MediaStructure } from "@/lib/media/audio/containers";

/**
 * Lector de WebM / Matroska (EBML) para extraer la pista de audio.
 *
 * Recorre los elementos "en plano": los maestros que interesan (`Segment`, `Cluster`, `BlockGroup`) se atraviesan sin
 * saltarlos y todo lo demas se salta por su tamano. Asi tambien lee las grabaciones en directo (`MediaRecorder`), cuyo
 * `Segment` y `Cluster` tienen tamano desconocido. No cubre pistas con "lacing" (Xiph/EBML/fijo), que no usan ni
 * `MediaRecorder` ni los codificadores habituales: en ese caso lo declara.
 */

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
} as const;

const MAX_ELEMENT_BODY = 64 * 1024 * 1024;

type Header = { id: number; size: number | null; bodyStart: number };

/** Lee un identificador (1-4 bytes con la marca de longitud incluida) y un tamano (1-8 bytes, `null` si es desconocido). */
async function readHeader(reader: BlobReader, pos: number): Promise<Header | null> {
  const head = await reader.bytes(pos, 12);
  if (head.length < 2) return null;
  const idLength = Math.clz32(head[0]) - 24 + 1;
  if (idLength < 1 || idLength > 4 || head.length < idLength + 1) return null;
  let id = 0;
  for (let i = 0; i < idLength; i += 1) id = id * 256 + head[i];
  const sizeFirst = head[idLength];
  const sizeLength = Math.clz32(sizeFirst) - 24 + 1;
  if (sizeLength < 1 || sizeLength > 8 || head.length < idLength + sizeLength) return null;
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i += 1) {
    const byte = head[idLength + i];
    size = size * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { id, size: allOnes ? null : size, bodyStart: pos + idLength + sizeLength };
}

function readUint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function readFloat(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length === 4 ? view.getFloat32(0) : bytes.length === 8 ? view.getFloat64(0) : 0;
}

type RawTrack = {
  number: number;
  type: number;
  codecId: string;
  privateData?: Uint8Array;
  sampleRate: number;
  channels: number;
};

/** Hijos de un maestro ya cargado en memoria. */
function* children(buf: Uint8Array, start: number, end: number): Generator<{ id: number; body: Uint8Array }> {
  let pos = start;
  while (pos + 2 <= end) {
    const idLength = Math.clz32(buf[pos]) - 24 + 1;
    if (idLength < 1 || idLength > 4) return;
    let id = 0;
    for (let i = 0; i < idLength; i += 1) id = id * 256 + buf[pos + i];
    const sizePos = pos + idLength;
    const sizeLength = Math.clz32(buf[sizePos]) - 24 + 1;
    if (sizeLength < 1 || sizeLength > 8) return;
    let size = buf[sizePos] & (0xff >> sizeLength);
    for (let i = 1; i < sizeLength; i += 1) size = size * 256 + buf[sizePos + i];
    const bodyStart = sizePos + sizeLength;
    if (bodyStart + size > end) return;
    yield { id, body: buf.subarray(bodyStart, bodyStart + size) };
    pos = bodyStart + size;
  }
}

function parseTrackEntry(body: Uint8Array): RawTrack {
  const track: RawTrack = { number: 0, type: 0, codecId: "", sampleRate: 8000, channels: 1 };
  for (const child of children(body, 0, body.length)) {
    if (child.id === ID.trackNumber) track.number = readUint(child.body);
    else if (child.id === ID.trackType) track.type = readUint(child.body);
    else if (child.id === ID.codecId) track.codecId = String.fromCharCode(...child.body);
    else if (child.id === ID.codecPrivate) track.privateData = child.body.slice();
    else if (child.id === ID.audio) {
      for (const audio of children(child.body, 0, child.body.length)) {
        if (audio.id === ID.samplingFrequency) track.sampleRate = Math.round(readFloat(audio.body));
        else if (audio.id === ID.channels) track.channels = readUint(audio.body);
      }
    }
  }
  return track;
}

function toTrackInfo(track: RawTrack, durationSec: number | undefined): AudioTrackInfo {
  const info: AudioTrackInfo = {
    container: "webm",
    trackId: track.number,
    rawCodec: track.codecId,
    codec: null,
    sampleRate: track.sampleRate,
    channels: track.channels,
    durationSec,
  };
  const id = track.codecId;
  if (id === "A_OPUS") {
    info.codec = "opus";
    info.description = track.privateData;
    info.sampleRate = 48000;
  } else if (id === "A_VORBIS") {
    info.codec = "vorbis";
    info.description = track.privateData;
  } else if (id === "A_AAC" || id.startsWith("A_AAC/")) {
    info.codec = "mp4a.40.2";
    info.description = track.privateData;
  } else if (id === "A_MPEG/L3") {
    info.codec = "mp3";
  } else if (id === "A_FLAC") {
    info.codec = "flac";
    info.description = track.privateData;
  }
  return info;
}

export type WebmAudio = {
  structure: MediaStructure;
  packets(trackNumber: number): AsyncGenerator<EncodedPacket>;
};

export function looksLikeWebm(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

/** Lee la estructura (pistas) de un WebM/Matroska. Devuelve `null` si no se encuentra `Tracks`. */
export async function readWebm(blob: Blob): Promise<WebmAudio | null> {
  const reader = new BlobReader(blob, 128 * 1024);
  let pos = 0;
  let timecodeScale = 1_000_000;
  let durationTicks: number | undefined;
  let tracks: RawTrack[] | null = null;

  // Cabecera hasta `Tracks`: se atraviesa `Segment` y se leen `Info` y `Tracks`; los clusters aun no.
  while (pos < reader.size && !tracks) {
    const header = await readHeader(reader, pos);
    if (!header) return null;
    if (header.id === ID.segment) {
      pos = header.bodyStart;
      continue;
    }
    if (header.id === ID.cluster) break; // las pistas siempre van antes del primer cluster en archivos validos
    if (header.size === null) return null;
    if (header.id === ID.info || header.id === ID.tracks) {
      if (header.size > MAX_ELEMENT_BODY) return null;
      const body = await reader.copy(header.bodyStart, header.size);
      if (header.id === ID.info) {
        for (const child of children(body, 0, body.length)) {
          if (child.id === ID.timecodeScale) timecodeScale = readUint(child.body);
          else if (child.id === ID.duration) durationTicks = readFloat(child.body);
        }
      } else {
        tracks = [];
        for (const child of children(body, 0, body.length)) if (child.id === ID.trackEntry) tracks.push(parseTrackEntry(child.body));
      }
    }
    pos = header.bodyStart + header.size;
  }
  if (!tracks) return null;

  let durationSec = durationTicks !== undefined ? (durationTicks * timecodeScale) / 1e9 : undefined;
  if (durationSec !== undefined && !Number.isFinite(durationSec)) durationSec = undefined;
  const audioTracks = tracks.filter((track) => track.type === 2).map((track) => toTrackInfo(track, durationSec));
  const videoTracks = tracks.filter((track) => track.type === 1).length;
  const structure: MediaStructure = { container: "webm", videoTracks, audioTracks, durationSec };

  return {
    structure,
    async *packets(trackNumber) {
      let cursor = pos;
      let clusterTime = 0;
      while (cursor < reader.size) {
        const header = await readHeader(reader, cursor);
        if (!header) return;
        const isMaster = header.id === ID.segment || header.id === ID.cluster || header.id === ID.blockGroup;
        if (isMaster) {
          cursor = header.bodyStart;
          continue;
        }
        if (header.size === null) return;
        const end = header.bodyStart + header.size;
        if (header.id === ID.timecode) {
          clusterTime = readUint(await reader.copy(header.bodyStart, header.size));
        } else if (header.id === ID.simpleBlock || header.id === ID.block) {
          // Cabecera del bloque: numero de pista (vint), tiempo relativo (int16) y banderas.
          const prefix = await reader.bytes(header.bodyStart, 16);
          const trackLength = Math.clz32(prefix[0]) - 24 + 1;
          let number = prefix[0] & (0xff >> trackLength);
          for (let i = 1; i < trackLength; i += 1) number = number * 256 + prefix[i];
          if (number === trackNumber) {
            const relative = new DataView(prefix.buffer, prefix.byteOffset).getInt16(trackLength);
            const flags = prefix[trackLength + 2];
            if (flags & 0x06) throw new Error("webm-lacing");
            const dataStart = header.bodyStart + trackLength + 3;
            const data = (await reader.bytes(dataStart, end - dataStart)).slice();
            yield {
              data,
              timestampUs: Math.round(((clusterTime + relative) * timecodeScale) / 1000),
            };
          }
        }
        cursor = end;
      }
    },
  };
}
