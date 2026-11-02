import type { PcmAudio } from "@/lib/media/audio/types";

/**
 * Utilidades SOLO para pruebas: audio sintetico (senos generados, nunca datos de nadie) y piezas de contenedores
 * hechas a mano (MP4 sin audio, WebM con y sin audio).
 */

export function sine(frequency: number, seconds: number, sampleRate: number, amplitude = 0.5): Float32Array {
  const frames = Math.round(seconds * sampleRate);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return out;
}

export function audioOf(channels: Float32Array[], sampleRate = 44100): PcmAudio {
  return { sampleRate, channels };
}

export function monoSine(frequency = 440, seconds = 1, sampleRate = 44100, amplitude = 0.5): PcmAudio {
  return audioOf([sine(frequency, seconds, sampleRate, amplitude)], sampleRate);
}

export function stereoSine(left = 440, right = 880, seconds = 1, sampleRate = 44100, amplitude = 0.5): PcmAudio {
  return audioOf([sine(left, seconds, sampleRate, amplitude), sine(right, seconds, sampleRate, amplitude)], sampleRate);
}

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

export function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let max = 0;
  for (let i = from; i < to; i += 1) max = Math.max(max, Math.abs(samples[i]));
  return max;
}

/** Frecuencia dominante aproximada por cruces por cero ascendentes. */
export function estimateFrequency(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
  return (crossings * sampleRate) / samples.length;
}

/* ------------------------------------------------------------------ *
 * Cajas MP4 minimas
 * ------------------------------------------------------------------ */

const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

export function mp4Box(type: string, ...parts: Array<number[] | Uint8Array>): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(8 + length);
  out.set([...u32(8 + length), ...ascii(type)], 0);
  let offset = 8;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** MP4 con solo una pista de VIDEO (sin audio): `ftyp` + `moov(mvhd, trak(mdia(mdhd, hdlr vide)))`. */
export function silentVideoMp4(): Uint8Array {
  const mvhd = mp4Box("mvhd", [0, 0, 0, 0], u32(0), u32(0), u32(1000), u32(2000), new Array(80).fill(0));
  const mdhd = mp4Box("mdhd", [0, 0, 0, 0], u32(0), u32(0), u32(1000), u32(2000), [0x55, 0xc4, 0, 0]);
  const hdlr = mp4Box("hdlr", [0, 0, 0, 0], u32(0), ascii("vide"), u32(0), u32(0), u32(0), [0]);
  const tkhd = mp4Box("tkhd", [0, 0, 0, 3], u32(0), u32(0), u32(1), u32(0), u32(2000), new Array(60).fill(0));
  const trak = mp4Box("trak", tkhd, mp4Box("mdia", mdhd, hdlr, mp4Box("minf", mp4Box("stbl"))));
  const ftyp = mp4Box("ftyp", ascii("isom"), u32(0), ascii("isom"));
  const free = mp4Box("free", new Array(16).fill(0));
  return concat([ftyp, free, mp4Box("moov", mvhd, trak)]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * EBML / WebM minimo
 * ------------------------------------------------------------------ */

function vintSize(size: number | null): number[] {
  if (size === null) return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  if (size < 127) return [0x80 | size];
  if (size < 16383) return [0x40 | (size >> 8), size & 255];
  return [0x10 | ((size >>> 24) & 15), (size >>> 16) & 255, (size >>> 8) & 255, size & 255];
}

function idBytes(id: number): number[] {
  const bytes: number[] = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 255);
    value = Math.floor(value / 256);
  }
  return bytes;
}

export function ebml(id: number, body: number[] | Uint8Array, unknownSize = false): Uint8Array {
  const head = [...idBytes(id), ...vintSize(unknownSize ? null : body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

const uint = (value: number) => {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 255);
    v = Math.floor(v / 256);
  } while (v > 0);
  return bytes;
};

export type FakeWebmOptions = {
  audio?: { codecId: string; sampleRate: number; channels: number; privateData?: number[]; packets: Uint8Array[]; packetMs: number };
  withVideo?: boolean;
  /** Segmento y clusters de tamano desconocido (como en `MediaRecorder`). */
  live?: boolean;
  lacing?: boolean;
};

/** WebM sintetico: cabecera EBML, `Info`, `Tracks` y clusters con `SimpleBlock` de audio (y de "video" intercalado). */
export function fakeWebm(options: FakeWebmOptions): Uint8Array {
  const entries: Uint8Array[] = [];
  const trackEntry = (number: number, type: number, codec: string, extra: Uint8Array[] = [], priv?: number[]) =>
    ebml(0xae, concat([ebml(0xd7, uint(number)), ebml(0x83, uint(type)), ebml(0x86, ascii(codec)), ...(priv ? [ebml(0x63a2, priv)] : []), ...extra]));
  if (options.withVideo) entries.push(trackEntry(1, 1, "V_VP8", [ebml(0xe0, concat([ebml(0xb0, [0x02, 0x80]), ebml(0xba, [0x01, 0xe0])]))]));
  if (options.audio) {
    const a = options.audio;
    const sr = new Uint8Array(new Float64Array([a.sampleRate]).buffer).reverse();
    entries.push(trackEntry(2, 2, a.codecId, [ebml(0xe1, concat([ebml(0xb5, sr), ebml(0x9f, uint(a.channels))]))], a.privateData));
  }
  const header = ebml(0x1a45dfa3, concat([ebml(0x4282, ascii("webm"))]));
  const info = ebml(0x1549a966, concat([ebml(0x2ad7b1, uint(1_000_000))]));
  const tracks = ebml(0x1654ae6b, concat(entries));

  const clusters: Uint8Array[] = [];
  const packets = options.audio?.packets ?? [];
  const perCluster = 4;
  for (let c = 0; c * perCluster < Math.max(1, packets.length); c += 1) {
    const base = c * perCluster * (options.audio?.packetMs ?? 20);
    const blocks: Uint8Array[] = [ebml(0xe7, uint(base))];
    for (let i = 0; i < perCluster && c * perCluster + i < packets.length; i += 1) {
      const rel = i * (options.audio?.packetMs ?? 20);
      if (options.withVideo) blocks.push(ebml(0xa3, [0x81, (rel >> 8) & 255, rel & 255, 0x80, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
      blocks.push(ebml(0xa3, [0x82, (rel >> 8) & 255, rel & 255, options.lacing ? 0x02 : 0x00, ...packets[c * perCluster + i]]));
    }
    clusters.push(ebml(0x1f43b675, concat(blocks), options.live));
  }
  return concat([header, ebml(0x18538067, concat([info, tracks, ...clusters]), options.live)]);
}
