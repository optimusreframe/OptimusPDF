import { describe, expect, it } from "vitest";
import { buildAudioSpecificConfig, muxM4a } from "@/lib/media/audio/m4a";
import { probeMedia } from "@/lib/media/audio/probe";
import { sourceOfAudio } from "@/lib/media/audio/pcm";
import { concat, fakeWebm, monoSine, silentVideoMp4, stereoSine } from "@/lib/media/audio/testAudio";
import { encodeWav } from "@/lib/media/audio/wav";

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

describe("probeMedia", () => {
  it("WAV: frecuencia, canales y duracion sin decodificar", async () => {
    const wav = await encodeWav(sourceOfAudio(stereoSine(440, 880, 2, 32000)));
    expect(await probeMedia(wav)).toEqual({ kind: "wav", sampleRate: 32000, channels: 2, durationSec: 2 });
  });

  it("MP3 con etiqueta ID3 y cabecera Xing: duracion exacta por numero de tramas", async () => {
    // Trama MPEG-1 capa III, 128 kbps, 44,1 kHz, estereo; cabecera Xing con 1000 tramas.
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x00], 0);
    frame.set([0x58, 0x69, 0x6e, 0x67], 4 + 32); // "Xing"
    frame.set([0, 0, 0, 1, 0, 0, 0x03, 0xe8], 4 + 32 + 4); // banderas = tramas; 1000 tramas
    const id3 = new Uint8Array(10 + 100);
    id3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 100], 0); // ID3v2 con 100 bytes de etiquetas
    const probe = await probeMedia(blobOf(concat([id3, frame, new Uint8Array(2000)])));
    expect(probe).toMatchObject({ kind: "mp3", sampleRate: 44100, channels: 2 });
    expect(probe.durationSec).toBeCloseTo((1000 * 1152) / 44100, 3);
  });

  it("MP3 sin Xing (CBR): estima la duracion con tamano y tasa de bits; mono se detecta", async () => {
    const data = new Uint8Array(16000 * 10);
    data.set([0xff, 0xfb, 0x90, 0xc4], 0); // 128 kbps, 44,1 kHz, mono
    const probe = await probeMedia(blobOf(data));
    expect(probe).toMatchObject({ kind: "mp3", sampleRate: 44100, channels: 1 });
    expect(probe.durationSec).toBeCloseTo(10, 5);
  });

  it("FLAC: STREAMINFO da frecuencia, canales y muestras totales", async () => {
    const head = new Uint8Array(42);
    head.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0, 0, 34], 0);
    // 20 bits de frecuencia (44100), 3 de canales-1 (1), 5 de bits-1 (15), 36 de muestras (441000)
    const big = BigInt;
    const bits = (big(44100) << big(44)) | (big(1) << big(41)) | (big(15) << big(36)) | big(441000);
    for (let i = 0; i < 8; i += 1) head[18 + i] = Number((bits >> big(56 - 8 * i)) & big(255));
    expect(await probeMedia(blobOf(head))).toEqual({ kind: "flac", sampleRate: 44100, channels: 2, durationSec: 10 });
  });

  it("AAC en ADTS: frecuencia y canales de la cabecera", async () => {
    const probe = await probeMedia(blobOf(Uint8Array.from([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc, 0, 0, 0])));
    expect(probe).toEqual({ kind: "aac", sampleRate: 44100, channels: 2 });
  });

  it("M4A (MP4 de audio): hay audio, no hay video, con su duracion", async () => {
    const m4a = muxM4a(
      Array.from({ length: 43 }, () => ({ data: new Uint8Array(10), samples: 1024 })),
      { sampleRate: 44100, channels: 2, bitrate: 128000, config: buildAudioSpecificConfig(44100, 2) },
    );
    const probe = await probeMedia(m4a);
    expect(probe).toMatchObject({ kind: "mp4", hasAudio: true, hasVideo: false, sampleRate: 44100, channels: 2 });
    expect(probe.durationSec).toBeCloseTo((43 * 1024) / 44100, 3);
  });

  it("video MP4 sin pista de audio: hasAudio es false (no es un archivo danado)", async () => {
    expect(await probeMedia(blobOf(silentVideoMp4()))).toMatchObject({ kind: "mp4", hasVideo: true, hasAudio: false });
  });

  it("WebM con audio Opus y video, y WebM mudo", async () => {
    const withAudio = fakeWebm({ audio: { codecId: "A_OPUS", sampleRate: 48000, channels: 2, packets: [new Uint8Array(5)], packetMs: 20 }, withVideo: true });
    expect(await probeMedia(blobOf(withAudio))).toMatchObject({ kind: "webm", hasAudio: true, hasVideo: true, sampleRate: 48000, channels: 2 });
    expect(await probeMedia(blobOf(fakeWebm({ withVideo: true })))).toMatchObject({ kind: "webm", hasAudio: false, hasVideo: true });
  });

  it("lo que no se reconoce o esta vacio es `unknown`; no lanza", async () => {
    expect(await probeMedia(blobOf(new Uint8Array(0)))).toEqual({ kind: "unknown" });
    expect(await probeMedia(blobOf(new TextEncoder().encode("hola, esto no es audio")))).toEqual({ kind: "unknown" });
    expect((await probeMedia(blobOf(new Uint8Array(1000).fill(255)))).kind).toBeDefined();
    expect((await probeMedia(await encodeWav(sourceOfAudio(monoSine(440, 0.01, 8000))))).kind).toBe("wav");
  });
});
