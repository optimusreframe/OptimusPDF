import { BlobReader } from "@/lib/media/audio/blobReader";
import type { AudioTrackInfo, EncodedPacket, MediaStructure } from "@/lib/media/audio/containers";

/**
 * Lector de MP4 / MOV / M4A / M4V (ISO BMFF) para extraer la PISTA DE AUDIO sin cargar el video entero.
 *
 * Solo lee lo necesario: busca la caja `moov` saltando por los tamanos de las cajas de primer nivel, interpreta las
 * tablas de muestras de la pista de audio (`stsd`, `stts`, `stsc`, `stsz`, `stco`/`co64`) y entrega los paquetes leyendo
 * unicamente los trozos de audio. No cubre MP4 fragmentado (`moof`): lo detecta y lo declara.
 */

const MAX_MOOV_BYTES = 128 * 1024 * 1024;

type Box = { type: string; start: number; bodyStart: number; end: number };

const fourcc = (view: Uint8Array, offset: number) =>
  String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);

/** Cajas hijas dentro de `[start, end)` de un buffer ya en memoria. */
function* childBoxes(buf: Uint8Array, start: number, end: number): Generator<Box> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = fourcc(buf, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos, bodyStart: pos + header, end: pos + size };
    pos += size;
  }
}

function findChild(buf: Uint8Array, parent: Box, type: string): Box | null {
  for (const box of childBoxes(buf, parent.bodyStart, parent.end)) if (box.type === type) return box;
  return null;
}

/** Longitud de un descriptor MPEG-4 (hasta 4 bytes de 7 bits). */
function readDescriptorLength(buf: Uint8Array, pos: number): { length: number; next: number } {
  let length = 0;
  let next = pos;
  for (let i = 0; i < 4 && next < buf.length; i += 1) {
    const byte = buf[next];
    next += 1;
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { length, next };
}

/** `esds`: tipo de objeto MPEG-4 y bytes de configuracion (ASC en AAC). */
function parseEsds(buf: Uint8Array, box: Box): { objectType: number; specific?: Uint8Array } | null {
  let pos = box.bodyStart + 4; // version + flags
  if (buf[pos] !== 0x03) return null;
  const es = readDescriptorLength(buf, pos + 1);
  pos = es.next + 2; // ES_ID
  const flags = buf[pos];
  pos += 1;
  if (flags & 0x80) pos += 2; // streamDependenceFlag
  if (flags & 0x40) pos += 1 + buf[pos]; // URL
  if (flags & 0x20) pos += 2; // OCRstreamFlag
  if (buf[pos] !== 0x04) return null;
  const dc = readDescriptorLength(buf, pos + 1);
  pos = dc.next;
  const objectType = buf[pos];
  pos += 13; // objectType, streamType, bufferSize(3), maxBitrate(4), avgBitrate(4)
  let specific: Uint8Array | undefined;
  if (buf[pos] === 0x05) {
    const info = readDescriptorLength(buf, pos + 1);
    specific = buf.slice(info.next, info.next + info.length);
  }
  return { objectType, specific };
}

/** Tipo de objeto de audio del ASC de AAC (5 bits, con escape a 6 bits mas). */
function aacObjectType(asc: Uint8Array | undefined): number {
  if (!asc || asc.length < 2) return 2;
  let type = asc[0] >> 3;
  if (type === 31) type = 32 + (((asc[0] & 0x07) << 3) | (asc[1] >> 5));
  return type;
}

function parseAudioEntry(buf: Uint8Array, entry: Box, trackId: number, mediaTimescale: number, mediaDuration: number): AudioTrackInfo {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const format = entry.type;
  const body = entry.bodyStart + 8; // 6 reservados + indice de referencia de datos
  const version = view.getUint16(body);
  let channels = view.getUint16(body + 8);
  let sampleRate = view.getUint32(body + 16) / 65536;
  let childStart = body + 20;
  if (version === 1) childStart += 16;
  else if (version === 2) {
    sampleRate = view.getFloat64(body + 32);
    channels = view.getUint32(body + 40);
    childStart = body + 20 + 36;
  }

  const info: AudioTrackInfo = {
    container: "mp4",
    trackId,
    rawCodec: format,
    codec: null,
    sampleRate: Math.round(sampleRate),
    channels,
    durationSec: mediaTimescale > 0 ? mediaDuration / mediaTimescale : undefined,
  };

  const child = (type: string): Box | null => {
    for (const box of childBoxes(buf, childStart, entry.end)) if (box.type === type) return box;
    return null;
  };

  if (format === "mp4a") {
    const esds = child("esds");
    const parsed = esds ? parseEsds(buf, esds) : null;
    if (parsed) {
      if (parsed.objectType === 0x40 || (parsed.objectType >= 0x66 && parsed.objectType <= 0x68)) {
        info.codec = `mp4a.40.${aacObjectType(parsed.specific)}`;
        info.description = parsed.specific;
      } else if (parsed.objectType === 0x69 || parsed.objectType === 0x6b) {
        info.codec = "mp3";
      }
    }
  } else if (format === "Opus") {
    const dOps = child("dOps");
    if (dOps) {
      const o = dOps.bodyStart;
      const outChannels = buf[o + 1];
      const preSkip = view.getUint16(o + 2);
      const inputRate = view.getUint32(o + 4);
      const gain = view.getInt16(o + 8);
      const family = buf[o + 10];
      const tail = buf.slice(o + 11, dOps.end);
      const head = new Uint8Array(19 + tail.length);
      head.set(Array.from("OpusHead", (c) => c.charCodeAt(0)), 0);
      head[8] = 1;
      head[9] = outChannels;
      const headView = new DataView(head.buffer);
      headView.setUint16(10, preSkip, true);
      headView.setUint32(12, inputRate, true);
      headView.setInt16(16, gain, true);
      head[18] = family;
      head.set(tail, 19);
      info.codec = "opus";
      info.description = head;
      info.sampleRate = 48000;
      info.channels = outChannels;
    }
  } else if (format === "fLaC") {
    const dfLa = child("dfLa");
    if (dfLa) {
      const blocks = buf.slice(dfLa.bodyStart + 4, dfLa.end);
      const description = new Uint8Array(4 + blocks.length);
      description.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
      description.set(blocks, 4);
      info.codec = "flac";
      info.description = description;
    }
  }
  return info;
}

type SampleTable = {
  sizes: Uint32Array;
  offsets: Float64Array;
  /** Marca de tiempo de decodificacion de cada muestra, en unidades del timescale de la pista. */
  times: Float64Array;
  durations: Uint32Array;
};

function parseSampleTable(buf: Uint8Array, stbl: Box): SampleTable | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stsz = findChild(buf, stbl, "stsz");
  const stsc = findChild(buf, stbl, "stsc");
  const stts = findChild(buf, stbl, "stts");
  const stco = findChild(buf, stbl, "stco");
  const co64 = findChild(buf, stbl, "co64");
  if (!stsz || !stsc || !stts || !(stco || co64)) return null;

  const constantSize = view.getUint32(stsz.bodyStart + 4);
  const sampleCount = view.getUint32(stsz.bodyStart + 8);
  const sizes = new Uint32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) sizes[i] = constantSize || view.getUint32(stsz.bodyStart + 12 + i * 4);

  const chunkBox = (stco ?? co64) as Box;
  const chunkCount = view.getUint32(chunkBox.bodyStart + 4);
  const chunkOffsets = new Float64Array(chunkCount);
  for (let i = 0; i < chunkCount; i += 1) {
    chunkOffsets[i] = stco ? view.getUint32(chunkBox.bodyStart + 8 + i * 4) : Number(view.getBigUint64(chunkBox.bodyStart + 8 + i * 8));
  }

  const stscCount = view.getUint32(stsc.bodyStart + 4);
  const firstChunk = new Uint32Array(stscCount);
  const perChunk = new Uint32Array(stscCount);
  for (let i = 0; i < stscCount; i += 1) {
    firstChunk[i] = view.getUint32(stsc.bodyStart + 8 + i * 12);
    perChunk[i] = view.getUint32(stsc.bodyStart + 12 + i * 12);
  }

  const offsets = new Float64Array(sampleCount);
  let sample = 0;
  for (let chunk = 0; chunk < chunkCount && sample < sampleCount; chunk += 1) {
    let entry = stscCount - 1;
    while (entry > 0 && firstChunk[entry] > chunk + 1) entry -= 1;
    let offset = chunkOffsets[chunk];
    for (let k = 0; k < perChunk[entry] && sample < sampleCount; k += 1) {
      offsets[sample] = offset;
      offset += sizes[sample];
      sample += 1;
    }
  }
  if (sample < sampleCount) return null;

  const sttsCount = view.getUint32(stts.bodyStart + 4);
  const durations = new Uint32Array(sampleCount);
  const times = new Float64Array(sampleCount);
  let index = 0;
  let clock = 0;
  for (let i = 0; i < sttsCount && index < sampleCount; i += 1) {
    const count = view.getUint32(stts.bodyStart + 8 + i * 8);
    const delta = view.getUint32(stts.bodyStart + 12 + i * 8);
    for (let k = 0; k < count && index < sampleCount; k += 1) {
      durations[index] = delta;
      times[index] = clock;
      clock += delta;
      index += 1;
    }
  }
  return { sizes, offsets, times, durations };
}

export type Mp4Audio = {
  structure: MediaStructure;
  /** Paquetes de la pista de audio indicada, leyendo solo esos trozos del archivo. */
  packets(trackId: number): AsyncGenerator<EncodedPacket>;
};

/** `true` si los bytes de cabecera parecen un MP4/MOV (`ftyp` u otra caja de primer nivel conocida). */
export function looksLikeMp4(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const type = fourcc(head, 4);
  return type === "ftyp" || type === "moov" || type === "mdat" || type === "wide" || type === "free" || type === "skip";
}

/** Lee la estructura de un MP4/MOV. Devuelve `null` si no se encuentra una caja `moov` valida. */
export async function readMp4(blob: Blob): Promise<Mp4Audio | null> {
  const reader = new BlobReader(blob);
  let pos = 0;
  let moovStart = -1;
  let moovEnd = -1;
  let fragmented = false;
  while (pos + 8 <= reader.size) {
    const head = await reader.bytes(pos, 16);
    if (head.length < 8) break;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1 && head.length >= 16) size = Number(view.getBigUint64(8));
    else if (size === 0) size = reader.size - pos;
    if (size < 8) return null;
    if (type === "moov") {
      moovStart = pos;
      moovEnd = pos + size;
    } else if (type === "moof") {
      fragmented = true;
    }
    pos += size;
  }
  if (moovStart < 0 || moovEnd - moovStart > MAX_MOOV_BYTES || moovEnd > reader.size) return null;

  const buf = await reader.copy(moovStart, moovEnd - moovStart);
  const moov: Box = { type: "moov", start: 0, bodyStart: 8, end: buf.length };
  // Una caja `moov` con tamano de 64 bits tiene cabecera de 16 bytes.
  if (new DataView(buf.buffer).getUint32(0) === 1) moov.bodyStart = 16;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let movieDuration: number | undefined;
  const mvhd = findChild(buf, moov, "mvhd");
  if (mvhd) {
    const v = buf[mvhd.bodyStart];
    const timescale = v === 1 ? view.getUint32(mvhd.bodyStart + 20) : view.getUint32(mvhd.bodyStart + 12);
    const duration = v === 1 ? Number(view.getBigUint64(mvhd.bodyStart + 24)) : view.getUint32(mvhd.bodyStart + 16);
    if (timescale > 0) movieDuration = duration / timescale;
  }

  const audioTracks: AudioTrackInfo[] = [];
  const tables = new Map<number, { table: SampleTable | null; timescale: number }>();
  let videoTracks = 0;
  for (const trak of childBoxes(buf, moov.bodyStart, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = findChild(buf, trak, "mdia");
    const hdlr = mdia ? findChild(buf, mdia, "hdlr") : null;
    if (!mdia || !hdlr) continue;
    const handler = fourcc(buf, hdlr.bodyStart + 8);
    if (handler === "vide") {
      videoTracks += 1;
      continue;
    }
    if (handler !== "soun") continue;

    const tkhd = findChild(buf, trak, "tkhd");
    const trackId = tkhd ? view.getUint32(tkhd.bodyStart + (buf[tkhd.bodyStart] === 1 ? 20 : 12)) : audioTracks.length + 1;
    const mdhd = findChild(buf, mdia, "mdhd");
    let timescale = 0;
    let duration = 0;
    if (mdhd) {
      const v = buf[mdhd.bodyStart];
      timescale = v === 1 ? view.getUint32(mdhd.bodyStart + 20) : view.getUint32(mdhd.bodyStart + 12);
      duration = v === 1 ? Number(view.getBigUint64(mdhd.bodyStart + 24)) : view.getUint32(mdhd.bodyStart + 16);
    }
    const minf = findChild(buf, mdia, "minf");
    const stbl = minf ? findChild(buf, minf, "stbl") : null;
    const stsd = stbl ? findChild(buf, stbl, "stsd") : null;
    if (!stbl || !stsd) continue;
    const entry = childBoxes(buf, stsd.bodyStart + 8, stsd.end).next().value as Box | undefined;
    if (!entry) continue;

    const info = parseAudioEntry(buf, entry, trackId, timescale, duration);
    audioTracks.push(info);
    tables.set(trackId, { table: parseSampleTable(buf, stbl), timescale });
  }

  const structure: MediaStructure = { container: "mp4", videoTracks, audioTracks, durationSec: movieDuration, fragmented };
  return {
    structure,
    async *packets(trackId) {
      const entry = tables.get(trackId);
      if (!entry?.table || entry.timescale <= 0) return;
      const { sizes, offsets, times, durations } = entry.table;
      for (let i = 0; i < sizes.length; i += 1) {
        // Ventana compartida: los paquetes de un trozo van seguidos, asi que casi siempre ya estan en memoria.
        const data = (await reader.bytes(offsets[i], sizes[i])).slice();
        yield {
          data,
          timestampUs: Math.round((times[i] / entry.timescale) * 1e6),
          durationUs: Math.round((durations[i] / entry.timescale) * 1e6),
        };
      }
    },
  };
}
