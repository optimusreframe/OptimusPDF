/**
 * Escritura de M4A (MP4 de solo audio con AAC) a partir de los paquetes de `AudioEncoder` ("mp4a.40.2").
 * `moov` va ANTES de `mdat` (inicio rapido: se reproduce sin descargar el final).
 */

export type AacPacket = { data: Uint8Array; samples: number };

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig de AAC-LC (2 bytes) para una frecuencia y canales dados. */
export function buildAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const index = ADTS_RATES.indexOf(sampleRate);
  if (index < 0) throw new Error(`aac-rate-${sampleRate}`);
  const value = (2 << 11) | (index << 7) | (channels << 3);
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

/** Si el codificador entrego tramas ADTS (con cabecera de 7/9 bytes), las deja en AAC crudo y devuelve su configuracion. */
export function stripAdts(packets: AacPacket[]): { packets: AacPacket[]; config?: { sampleRate: number; channels: number } } {
  const first = packets[0]?.data;
  if (!first || first.length < 7 || first[0] !== 0xff || (first[1] & 0xf0) !== 0xf0) return { packets };
  const rate = ADTS_RATES[(first[2] >> 2) & 15];
  const channels = ((first[2] & 1) << 2) | (first[3] >> 6);
  const stripped = packets.map((packet) => {
    const protectionAbsent = packet.data[1] & 1;
    return { ...packet, data: packet.data.subarray(protectionAbsent ? 7 : 9) };
  });
  return { packets: stripped, config: { sampleRate: rate, channels } };
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}
function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}
function box(type: string, ...children: Array<number[] | Uint8Array>): Uint8Array {
  const size = 8 + children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(size);
  out.set([...u32(size), ...ascii(type)], 0);
  let offset = 8;
  for (const child of children) {
    out.set(child, offset);
    offset += child.length;
  }
  return out;
}
/** Caja con version y banderas (`FullBox`). */
function fullBox(type: string, version: number, flags: number, ...children: Array<number[] | Uint8Array>): Uint8Array {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...children);
}

/** Descriptor MPEG-4 con longitud de 4 bytes (forma fija, valida para todos los lectores). */
function descriptor(tag: number, ...children: Array<number[] | Uint8Array>): number[] {
  const length = children.reduce((sum, child) => sum + child.length, 0);
  return [tag, 0x80 | ((length >> 21) & 0x7f), 0x80 | ((length >> 14) & 0x7f), 0x80 | ((length >> 7) & 0x7f), length & 0x7f, ...children.flatMap((c) => Array.from(c))];
}

export function muxM4a(
  packets: AacPacket[],
  options: { sampleRate: number; channels: number; bitrate: number; config: Uint8Array },
): Blob {
  const { sampleRate, channels, bitrate, config } = options;
  const totalSamples = packets.reduce((sum, packet) => sum + packet.samples, 0);
  const totalBytes = packets.reduce((sum, packet) => sum + packet.data.length, 0);
  const durationMs = Math.round((totalSamples / sampleRate) * 1000);

  // stts: tramas seguidas con la misma duracion se agrupan.
  const runs: Array<[number, number]> = [];
  for (const packet of packets) {
    const last = runs[runs.length - 1];
    if (last && last[1] === packet.samples) last[0] += 1;
    else runs.push([1, packet.samples]);
  }

  const esds = fullBox(
    "esds",
    0,
    0,
    descriptor(
      0x03,
      [0x00, 0x01, 0x00], // ES_ID, banderas
      descriptor(
        0x04,
        [0x40, 0x15, 0x00, 0x00, 0x00], // AAC, flujo de audio, tamano del bufer
        u32(bitrate), // velocidad maxima
        u32(bitrate), // velocidad media
        descriptor(0x05, config),
      ),
      descriptor(0x06, [0x02]),
    ),
  );
  const mp4a = box(
    "mp4a",
    [0, 0, 0, 0, 0, 0, 0, 1], // reservado + indice de datos
    [0, 0, 0, 0, 0, 0, 0, 0], // version 0 + reservado
    u16(channels),
    u16(16),
    [0, 0, 0, 0],
    u32(sampleRate * 65536),
    esds,
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), mp4a);
  const stts = fullBox("stts", 0, 0, u32(runs.length), ...runs.map(([count, delta]) => [...u32(count), ...u32(delta)]));
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(packets.length), u32(1));
  const stszBody = new Uint8Array(packets.length * 4);
  const stszView = new DataView(stszBody.buffer);
  packets.forEach((packet, index) => stszView.setUint32(index * 4, packet.data.length));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(packets.length), stszBody);

  const buildMoov = (chunkOffset: number): Uint8Array => {
    const stco = fullBox("stco", 0, 0, u32(1), u32(chunkOffset));
    const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
    const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
    const minf = box("minf", fullBox("smhd", 0, 0, u16(0), u16(0)), dinf, stbl);
    const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(sampleRate), u32(totalSamples), u16(0x55c4), u16(0));
    const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii("soun"), u32(0), u32(0), u32(0), [...ascii("SoundHandler"), 0]);
    const mdia = box("mdia", mdhd, hdlr, minf);
    const identity = [0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00];
    const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durationMs), u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), identity, u32(0), u32(0));
    const trak = box("trak", tkhd, mdia);
    const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), identity, new Array(24).fill(0), u32(2));
    return box("moov", mvhd, trak);
  };

  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A "), ascii("mp42"), ascii("isom"));
  const moovProbe = buildMoov(0);
  const mdatHeader = [...u32(8 + totalBytes), ...ascii("mdat")];
  const moov = buildMoov(ftyp.length + moovProbe.length + 8);
  return new Blob([ftyp, moov, new Uint8Array(mdatHeader), ...packets.map((packet) => packet.data)] as BlobPart[], { type: "audio/mp4" });
}
