import { describe, expect, it } from "vitest";
import { muxM4a, buildAudioSpecificConfig, stripAdts } from "@/lib/media/audio/m4a";
import { readMp4, looksLikeMp4 } from "@/lib/media/audio/mp4";
import { readWebm, looksLikeWebm } from "@/lib/media/audio/webm";
import { concat, fakeWebm, mp4Box, silentVideoMp4 } from "@/lib/media/audio/testAudio";

const packetsOf = (count: number, size = 20): Uint8Array[] => Array.from({ length: count }, (_, i) => Uint8Array.from({ length: size + (i % 3) }, (_, k) => (i * 7 + k) & 255));

async function collect<T>(iterable: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("M4A escrito por nosotros y leido por nuestro lector MP4", () => {
  const data = packetsOf(50);
  const blob = muxM4a(
    data.map((bytes) => ({ data: bytes, samples: 1024 })),
    { sampleRate: 44100, channels: 2, bitrate: 128000, config: buildAudioSpecificConfig(44100, 2) },
  );

  it("el archivo empieza por `ftyp` con la marca M4A y `moov` va antes de `mdat`", async () => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(looksLikeMp4(bytes)).toBe(true);
    expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe("ftyp");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("M4A ");
    const text = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 4000)));
    expect(text.indexOf("moov")).toBeGreaterThan(0);
    expect(text.indexOf("moov")).toBeLessThan(text.indexOf("mdat"));
  });

  it("la estructura dice: una pista de audio AAC-LC, 44,1 kHz, 2 canales, con la duracion correcta, y ninguna de video", async () => {
    const mp4 = await readMp4(blob);
    expect(mp4).not.toBeNull();
    const { structure } = mp4!;
    expect(structure.videoTracks).toBe(0);
    expect(structure.audioTracks).toHaveLength(1);
    const track = structure.audioTracks[0];
    expect(track).toMatchObject({ container: "mp4", rawCodec: "mp4a", codec: "mp4a.40.2", sampleRate: 44100, channels: 2 });
    expect(Array.from(track.description!)).toEqual(Array.from(buildAudioSpecificConfig(44100, 2)));
    expect(track.durationSec).toBeCloseTo((50 * 1024) / 44100, 3);
    expect(structure.durationSec).toBeCloseTo((50 * 1024) / 44100, 2);
  });

  it("los paquetes salen identicos, en orden y con sus marcas de tiempo", async () => {
    const mp4 = await readMp4(blob);
    const packets = await collect(mp4!.packets(mp4!.structure.audioTracks[0].trackId));
    expect(packets).toHaveLength(50);
    packets.forEach((packet, i) => {
      expect(Array.from(packet.data)).toEqual(Array.from(data[i]));
      expect(packet.timestampUs).toBe(Math.round(((i * 1024) / 44100) * 1e6));
      expect(packet.durationUs).toBe(Math.round((1024 / 44100) * 1e6));
    });
  });
});

describe("lector MP4: casos de video", () => {
  it("un MP4 con solo video: se lee la estructura y se declara que no hay audio", async () => {
    const mp4 = await readMp4(new Blob([silentVideoMp4() as BlobPart]));
    expect(mp4?.structure.videoTracks).toBe(1);
    expect(mp4?.structure.audioTracks).toHaveLength(0);
  });

  it("sin caja `moov` (o basura) devuelve null en vez de lanzar", async () => {
    expect(await readMp4(new Blob([new Uint8Array(64)]))).toBeNull();
    expect(await readMp4(new Blob([mp4Box("ftyp", [105, 115, 111, 109, 0, 0, 0, 0]) as BlobPart]))).toBeNull();
    expect(await readMp4(new Blob([]))).toBeNull();
  });

  it("detecta un MP4 fragmentado (`moof`) para no prometer paquetes que no lee", async () => {
    const fragmented = concat([silentVideoMp4(), mp4Box("moof", [0, 0, 0, 0])]);
    expect((await readMp4(new Blob([fragmented as BlobPart])))?.structure.fragmented).toBe(true);
  });
});

describe("lector WebM / Matroska", () => {
  const opusHead = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
  const base = { codecId: "A_OPUS", sampleRate: 48000, channels: 2, privateData: opusHead, packetMs: 20 };

  it("lee las pistas: audio Opus (con su OpusHead) y video; los paquetes de audio llegan sin los de video", async () => {
    const packets = packetsOf(10, 12);
    const bytes = fakeWebm({ audio: { ...base, packets }, withVideo: true });
    expect(looksLikeWebm(bytes)).toBe(true);
    const webm = await readWebm(new Blob([bytes as BlobPart]));
    expect(webm).not.toBeNull();
    expect(webm!.structure.videoTracks).toBe(1);
    const track = webm!.structure.audioTracks[0];
    expect(track).toMatchObject({ container: "webm", rawCodec: "A_OPUS", codec: "opus", sampleRate: 48000, channels: 2, trackId: 2 });
    expect(Array.from(track.description!)).toEqual(opusHead);
    const read = await collect(webm!.packets(track.trackId));
    expect(read).toHaveLength(10);
    read.forEach((packet, i) => {
      expect(Array.from(packet.data)).toEqual(Array.from(packets[i]));
      expect(packet.timestampUs).toBe(i * 20 * 1000);
    });
  });

  it("lee grabaciones en directo (segmento y clusters de tamano desconocido, como MediaRecorder)", async () => {
    const packets = packetsOf(9, 8);
    const webm = await readWebm(new Blob([fakeWebm({ audio: { ...base, packets }, withVideo: true, live: true }) as BlobPart]));
    const read = await collect(webm!.packets(2));
    expect(read.map((p) => Array.from(p.data))).toEqual(packets.map((p) => Array.from(p)));
  });

  it("un WebM sin pista de audio se declara sin audio", async () => {
    const webm = await readWebm(new Blob([fakeWebm({ withVideo: true }) as BlobPart]));
    expect(webm?.structure.audioTracks).toHaveLength(0);
    expect(webm?.structure.videoTracks).toBe(1);
  });

  it("mapea los codecs de audio habituales y deja `null` los que no sabemos decodificar", async () => {
    const codecOf = async (codecId: string) => (await readWebm(new Blob([fakeWebm({ audio: { ...base, codecId, packets: packetsOf(1) } }) as BlobPart])))!.structure.audioTracks[0].codec;
    expect(await codecOf("A_VORBIS")).toBe("vorbis");
    expect(await codecOf("A_MPEG/L3")).toBe("mp3");
    expect(await codecOf("A_AAC")).toBe("mp4a.40.2");
    expect(await codecOf("A_FLAC")).toBe("flac");
    expect(await codecOf("A_PCM/INT/LIT")).toBeNull();
  });

  it("bloques con lacing no se leen en silencio: lanza para que se use otra via", async () => {
    const webm = await readWebm(new Blob([fakeWebm({ audio: { ...base, packets: packetsOf(2), }, lacing: true }) as BlobPart]));
    await expect(collect(webm!.packets(2))).rejects.toThrow("webm-lacing");
  });

  it("basura o archivo vacio: null", async () => {
    expect(await readWebm(new Blob([new Uint8Array(100).fill(7)]))).toBeNull();
    expect(await readWebm(new Blob([]))).toBeNull();
  });
});

describe("ADTS y configuracion AAC", () => {
  it("buildAudioSpecificConfig codifica AAC-LC, frecuencia y canales", () => {
    expect(Array.from(buildAudioSpecificConfig(44100, 2))).toEqual([0x12, 0x10]);
    expect(Array.from(buildAudioSpecificConfig(48000, 1))).toEqual([0x11, 0x88]);
    expect(() => buildAudioSpecificConfig(12345, 2)).toThrow();
  });

  it("stripAdts quita la cabecera de 7 bytes y devuelve la configuracion; sin ADTS no toca nada", () => {
    const header = [0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]; // 44,1 kHz, 2 canales, sin CRC
    const adts = { data: Uint8Array.from([...header, 9, 9, 9]), samples: 1024 };
    const stripped = stripAdts([adts]);
    expect(Array.from(stripped.packets[0].data)).toEqual([9, 9, 9]);
    expect(stripped.config).toEqual({ sampleRate: 44100, channels: 2 });
    const raw = [{ data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), samples: 1024 }];
    expect(stripAdts(raw).packets).toBe(raw);
  });
});
