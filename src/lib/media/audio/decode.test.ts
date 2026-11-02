import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProbeAllowed, checkMediaFile, decodeMedia } from "@/lib/media/audio/decode";
import { AudioError } from "@/lib/media/audio/errors";
import { buildAudioSpecificConfig, muxM4a } from "@/lib/media/audio/m4a";
import { sourceOfAudio } from "@/lib/media/audio/pcm";
import { fakeWebm, silentVideoMp4, stereoSine } from "@/lib/media/audio/testAudio";
import { encodeWav } from "@/lib/media/audio/wav";

afterEach(() => vi.unstubAllGlobals());

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);
const m4a = (packets = 10) =>
  muxM4a(
    Array.from({ length: packets }, (_, i) => ({ data: Uint8Array.from([i, 1, 2, 3]), samples: 1024 })),
    { sampleRate: 44100, channels: 2, bitrate: 128000, config: buildAudioSpecificConfig(44100, 2) },
  );

describe("decodeMedia: WAV", () => {
  it("lo lee con el lector propio, sin Web Audio, conservando frecuencia y canales", async () => {
    const wav = await encodeWav(sourceOfAudio(stereoSine(440, 880, 0.5, 22050)));
    const progress: number[] = [];
    const result = await decodeMedia(wav, { onProgress: (value) => progress.push(value) });
    expect(result.via).toBe("wav");
    expect(result.audio.sampleRate).toBe(22050);
    expect(result.audio.channels).toHaveLength(2);
    expect(result.audio.channels[0]).toHaveLength(11025);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("archivo vacio: `empty`; basura que no es audio: `corrupt`", async () => {
    await expect(decodeMedia(new Blob([]))).rejects.toMatchObject({ code: "empty" });
    vi.stubGlobal("OfflineAudioContext", class { decodeAudioData() { return Promise.reject(new DOMException("x", "EncodingError")); } });
    await expect(decodeMedia(blobOf(new TextEncoder().encode("no soy audio")))).rejects.toMatchObject({ code: "corrupt" });
  });

  it("respeta la cancelacion antes de empezar", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(decodeMedia(blobOf(new Uint8Array(10).fill(1)), { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("decodeMedia: limites y video sin audio", () => {
  it("un video sin pista de audio da `noAudioTrack` sin intentar decodificar", async () => {
    const decode = vi.fn();
    vi.stubGlobal("OfflineAudioContext", class { decodeAudioData = decode; });
    await expect(decodeMedia(blobOf(silentVideoMp4()))).rejects.toMatchObject({ code: "noAudioTrack" });
    await expect(decodeMedia(blobOf(fakeWebm({ withVideo: true })))).rejects.toMatchObject({ code: "noAudioTrack" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("assertProbeAllowed: tamano maximo, y audio que no cabe en memoria dice cuantos minutos caben", () => {
    const big = Object.defineProperty(new Blob([new Uint8Array(10)]), "size", { value: 400 * 1024 * 1024 });
    expect(() => assertProbeAllowed(big, { kind: "mp3" })).toThrowError(expect.objectContaining({ code: "tooLarge" }));
    // Un contenedor de video admite mas peso (solo se lee la pista de audio).
    expect(() => assertProbeAllowed(big, { kind: "mp4", hasAudio: true })).not.toThrow();
    const long = { kind: "mp3" as const, durationSec: 4 * 3600, sampleRate: 44100, channels: 2 };
    try {
      assertProbeAllowed(blobOf(new Uint8Array(10)), long);
      throw new Error("debia lanzar");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioError);
      expect((error as AudioError).code).toBe("tooLong");
      expect(Number((error as AudioError).detail)).toBeGreaterThan(5);
    }
    expect(() => assertProbeAllowed(blobOf(new Uint8Array(10)), { kind: "mp3", durationSec: 60, sampleRate: 44100, channels: 2 })).not.toThrow();
  });

  it("checkMediaFile resume lo mismo sin lanzar", async () => {
    expect(await checkMediaFile(new Blob([]))).toEqual({ ok: false, code: "empty" });
    expect(await checkMediaFile(blobOf(silentVideoMp4()))).toMatchObject({ ok: false, code: "noAudioTrack" });
    const wav = await encodeWav(sourceOfAudio(stereoSine(440, 880, 0.2, 8000)));
    const ok = await checkMediaFile(wav);
    expect(ok.ok && ok.probe.durationSec).toBeCloseTo(0.2, 3);
  });
});

describe("decodeMedia: Web Audio y WebCodecs", () => {
  it("un M4A se entrega a decodeAudioData con un contexto a la frecuencia del archivo, y se devuelven los canales tal cual", async () => {
    const channels = [Float32Array.of(0.1, 0.2, 0.3), Float32Array.of(-0.1, -0.2, -0.3)];
    const created: number[][] = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        constructor(...args: number[]) {
          created.push(args);
        }
        decodeAudioData(buffer: ArrayBuffer) {
          expect(buffer.byteLength).toBeGreaterThan(0);
          return Promise.resolve({ sampleRate: 44100, numberOfChannels: 2, getChannelData: (i: number) => channels[i] });
        }
      },
    );
    const result = await decodeMedia(m4a());
    expect(result.via).toBe("web-audio");
    expect(created[0][2]).toBe(44100);
    expect(result.audio.channels).toEqual(channels);
  });

  it("si decodeAudioData no abre el archivo, lee la pista con el lector propio y la decodifica con AudioDecoder", async () => {
    vi.stubGlobal("OfflineAudioContext", class { decodeAudioData() { return Promise.reject(new DOMException("no", "EncodingError")); } });
    const configured: Array<{ codec: string; sampleRate: number; numberOfChannels: number; description?: BufferSource }> = [];
    const decoded: number[] = [];
    class FakeDecoder {
      static isConfigSupported = async () => ({ supported: true });
      decodeQueueSize = 0;
      state = "configured";
      constructor(private init: { output: (data: unknown) => void }) {}
      configure(config: (typeof configured)[number]) {
        configured.push(config);
      }
      addEventListener() {}
      decode(chunk: { data: Uint8Array }) {
        decoded.push(chunk.data[0]);
        const frames = 1024;
        this.init.output({
          sampleRate: 44100,
          numberOfChannels: 2,
          numberOfFrames: frames,
          copyTo: (out: Float32Array, options: { planeIndex: number }) => out.fill(options.planeIndex === 0 ? 0.25 : -0.25),
          close() {},
        });
      }
      async flush() {}
      close() {
        this.state = "closed";
      }
    }
    class FakeChunk {
      data: Uint8Array;
      constructor(init: { data: Uint8Array }) {
        this.data = init.data;
      }
    }
    vi.stubGlobal("AudioDecoder", FakeDecoder);
    vi.stubGlobal("EncodedAudioChunk", FakeChunk);
    const result = await decodeMedia(m4a(10));
    expect(result.via).toBe("webcodecs");
    expect(configured[0]).toMatchObject({ codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2 });
    expect(Array.from(configured[0].description as Uint8Array)).toEqual([0x12, 0x10]);
    expect(decoded).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.audio.channels[0]).toHaveLength(10 * 1024);
    expect(result.audio.channels[0][0]).toBe(0.25);
    expect(result.audio.channels[1][10 * 1024 - 1]).toBe(-0.25);
  });

  it("sin AudioDecoder y con decodeAudioData fallando: `unsupportedFormat` con el nombre del codec, nunca un error generico", async () => {
    vi.stubGlobal("OfflineAudioContext", class { decodeAudioData() { return Promise.reject(new DOMException("no", "EncodingError")); } });
    vi.stubGlobal("AudioDecoder", undefined);
    await expect(decodeMedia(m4a())).rejects.toMatchObject({ code: "unsupportedFormat", detail: "mp4a" });
  });

  it("memoria agotada al decodificar: `outOfMemory`, sin probar otra via", async () => {
    vi.stubGlobal("OfflineAudioContext", class { decodeAudioData() { return Promise.reject(new RangeError("Array buffer allocation failed")); } });
    await expect(decodeMedia(m4a())).rejects.toMatchObject({ code: "outOfMemory" });
  });

  it("audio de 0 muestras tras decodificar: `empty`", async () => {
    vi.stubGlobal("OfflineAudioContext", class { decodeAudioData() { return Promise.resolve({ sampleRate: 44100, numberOfChannels: 1, getChannelData: () => new Float32Array(0) }); } });
    await expect(decodeMedia(m4a())).rejects.toMatchObject({ code: "empty" });
  });
});
