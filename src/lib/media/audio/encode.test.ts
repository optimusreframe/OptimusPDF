import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectOutputSupport, resetOutputSupportCache } from "@/lib/media/audio/capabilities";
import { encodeAudio, estimateOutputBytes, resolveTarget } from "@/lib/media/audio/encode";
import { sourceOfAudio } from "@/lib/media/audio/pcm";
import { readMp4 } from "@/lib/media/audio/mp4";
import { probeMedia } from "@/lib/media/audio/probe";
import { monoSine, stereoSine } from "@/lib/media/audio/testAudio";
import { DEFAULT_ENCODE_OPTIONS, type EncodeOptions } from "@/lib/media/audio/types";
import { decodeWav } from "@/lib/media/audio/wav";

/**
 * `AudioEncoder` falso: por cada trama de entrada (1024 muestras para AAC, 960 para Opus) emite un paquete de 8 bytes
 * cuyo primer byte es un contador. Sirve para comprobar el empaquetado, la configuracion pedida y la contrapresion sin
 * depender de ningun codec real (los codecs reales se prueban en el E2E con el navegador de verdad).
 */
type Config = AudioEncoderConfig & { aac?: unknown };
const instances: FakeEncoder[] = [];
let supported: Record<string, boolean> = {};

class FakeEncoder {
  static isConfigSupported = async (config: Config) => ({ supported: supported[config.codec] ?? false, config });
  encodeQueueSize = 0;
  state = "unconfigured";
  config: Config | null = null;
  frames = 0;
  counter = 0;
  pending = 0;
  closed = false;
  constructor(private init: { output: (chunk: unknown, metadata?: unknown) => void; error: (error: Error) => void }) {
    instances.push(this);
  }
  configure(config: Config) {
    this.config = config;
    this.state = "configured";
  }
  addEventListener() {}
  encode(data: { numberOfFrames: number }) {
    this.frames += data.numberOfFrames;
    const frameSize = this.config?.codec === "opus" ? 960 : 1024;
    this.pending += data.numberOfFrames;
    while (this.pending >= frameSize) {
      this.pending -= frameSize;
      this.emit(frameSize);
    }
  }
  private emit(frameSize: number) {
    const bytes = new Uint8Array(8);
    bytes[0] = this.counter++;
    const metadata = this.counter === 1 && this.config?.codec !== "opus" ? { decoderConfig: { description: new Uint8Array([0x12, 0x10]).buffer } } : undefined;
    this.init.output({ byteLength: 8, duration: Math.round((frameSize / (this.config?.sampleRate ?? 44100)) * 1e6), copyTo: (target: Uint8Array) => target.set(bytes) }, metadata);
  }
  async flush() {
    if (this.pending > 0) {
      const size = this.config?.codec === "opus" ? 960 : 1024;
      this.pending = 0;
      this.emit(size);
    }
  }
  close() {
    this.state = "closed";
    this.closed = true;
  }
}

class FakeAudioData {
  constructor(public init: { numberOfFrames: number; numberOfChannels: number; sampleRate: number; format: string; data: Float32Array }) {}
  get numberOfFrames() {
    return this.init.numberOfFrames;
  }
  close() {}
}

beforeEach(() => {
  instances.length = 0;
  supported = { opus: true, "mp4a.40.2": true };
  resetOutputSupportCache();
  vi.stubGlobal("AudioEncoder", FakeEncoder);
  vi.stubGlobal("AudioData", FakeAudioData);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetOutputSupportCache();
});

const options = (patch: Partial<EncodeOptions>): EncodeOptions => ({ ...DEFAULT_ENCODE_OPTIONS, ...patch });

describe("detectOutputSupport", () => {
  it("WAV siempre; M4A y Opus segun isConfigSupported", async () => {
    const support = await detectOutputSupport();
    expect(support.wav).toEqual({ available: true });
    expect(support.m4a).toEqual({ available: true });
    expect(support.opus).toEqual({ available: true });
  });

  it("MP3 (LAME en WASM + Worker): disponible con WebAssembly SIMD y Worker; si falta cualquiera, no disponible y con el motivo exacto", async () => {
    // En Node no hay `Worker`: se simula para comprobar la deteccion (el codificador real usa worker_threads).
    vi.stubGlobal("Worker", class {});
    expect((await detectOutputSupport()).mp3).toEqual({ available: true });

    resetOutputSupportCache();
    vi.stubGlobal("Worker", undefined);
    expect((await detectOutputSupport()).mp3).toEqual({ available: false, reason: "noWorker" });

    resetOutputSupportCache();
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("WebAssembly", undefined);
    expect((await detectOutputSupport()).mp3).toEqual({ available: false, reason: "noWasm" });

    // Un motor con WebAssembly pero SIN SIMD (Safari < 16.4): `validate` rechaza el modulo con instruccion `v128`.
    resetOutputSupportCache();
    vi.stubGlobal("WebAssembly", { validate: () => false });
    expect((await detectOutputSupport()).mp3).toEqual({ available: false, reason: "noWasm" });

    // Y si `validate` lanza, tampoco se promete MP3.
    resetOutputSupportCache();
    vi.stubGlobal("WebAssembly", { validate: () => { throw new Error("boom"); } });
    expect((await detectOutputSupport()).mp3).toEqual({ available: false, reason: "noWasm" });
  });

  it("el Node de las pruebas SI valida el modulo SIMD (si no, el resto de pruebas de MP3 no tendrian sentido)", async () => {
    vi.stubGlobal("Worker", class {});
    expect((await detectOutputSupport()).mp3.available).toBe(true);
  });

  it("con un navegador sin WebCodecs: M4A y Opus no disponibles por `noWebCodecs`; con codec no soportado: `codecUnsupported`", async () => {
    supported = { opus: true, "mp4a.40.2": false };
    expect((await detectOutputSupport()).m4a).toEqual({ available: false, reason: "codecUnsupported" });
    resetOutputSupportCache();
    vi.stubGlobal("AudioEncoder", undefined);
    const support = await detectOutputSupport();
    expect(support.opus).toEqual({ available: false, reason: "noWebCodecs" });
    expect(support.m4a).toEqual({ available: false, reason: "noWebCodecs" });
    expect(support.wav.available).toBe(true);
  });
});

describe("resolveTarget / estimateOutputBytes", () => {
  const stereo44 = { sampleRate: 44100, numberOfChannels: 2 };
  it("`original` conserva frecuencia y canales (WAV puede tener mas de 2; los formatos con perdida, como mucho 2)", () => {
    expect(resolveTarget(stereo44, options({}))).toEqual({ sampleRate: 44100, channels: 2 });
    expect(resolveTarget({ sampleRate: 48000, numberOfChannels: 6 }, options({}))).toEqual({ sampleRate: 48000, channels: 6 });
    expect(resolveTarget({ sampleRate: 48000, numberOfChannels: 6 }, options({ format: "m4a" }))).toEqual({ sampleRate: 48000, channels: 2 });
  });
  it("Opus siempre a 48 kHz; lo pedido manda sobre lo original", () => {
    expect(resolveTarget(stereo44, options({ format: "opus", sampleRate: 22050 }))).toEqual({ sampleRate: 48000, channels: 2 });
    expect(resolveTarget(stereo44, options({ sampleRate: 16000, channels: 1 }))).toEqual({ sampleRate: 16000, channels: 1 });
  });
  it("el tamano estimado: WAV por muestras, el resto por tasa de bits", () => {
    expect(estimateOutputBytes(10, stereo44, options({}))).toBe(10 * 44100 * 2 * 2 + 44);
    expect(estimateOutputBytes(10, stereo44, options({ format: "m4a", bitrateKbps: 128 }))).toBe(160000);
  });
});

describe("encodeAudio", () => {
  it("WAV: aplica canales y frecuencia pedidos y el resultado se lee de vuelta", async () => {
    const blob = await encodeAudio(sourceOfAudio(stereoSine(440, 880, 1, 44100)), options({ sampleRate: 22050, channels: 1 }));
    const decoded = decodeWav(new Uint8Array(await blob.arrayBuffer()));
    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.channels).toHaveLength(1);
    expect(decoded.channels[0]).toHaveLength(22050);
  });

  it("un audio sin muestras: `empty`", async () => {
    await expect(encodeAudio(sourceOfAudio({ sampleRate: 44100, channels: [new Float32Array(0)] }), options({}))).rejects.toMatchObject({ code: "empty" });
  });

  it("M4A: configura AAC-LC con la frecuencia, canales y tasa pedidas y empaqueta un MP4 legible con la configuracion del codificador", async () => {
    const progress: number[] = [];
    const blob = await encodeAudio(sourceOfAudio(stereoSine(440, 880, 1, 44100)), options({ format: "m4a", bitrateKbps: 96 }), { onProgress: (v) => progress.push(v) });
    expect(instances[0].config).toMatchObject({ codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 96000 });
    expect(instances[0].closed).toBe(true);
    expect(blob.type).toBe("audio/mp4");
    const mp4 = await readMp4(blob);
    const track = mp4!.structure.audioTracks[0];
    expect(track).toMatchObject({ codec: "mp4a.40.2", sampleRate: 44100, channels: 2 });
    expect(Array.from(track.description!)).toEqual([0x12, 0x10]);
    let count = 0;
    for await (const packet of mp4!.packets(track.trackId)) {
      expect(packet.data[0]).toBe(count);
      count += 1;
    }
    expect(count).toBe(Math.ceil(44100 / 1024));
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("Opus: se remuestrea a 48 kHz y sale un Ogg Opus con la duracion exacta (el relleno de la ultima trama se recorta)", async () => {
    const blob = await encodeAudio(sourceOfAudio(monoSine(440, 1, 44100)), options({ format: "opus", bitrateKbps: 64 }));
    expect(instances[0].config).toMatchObject({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 });
    const probe = await probeMedia(blob);
    expect(probe).toMatchObject({ kind: "ogg", sampleRate: 48000, channels: 1 });
    expect(probe.durationSec).toBeCloseTo(1, 3);
  });

  it("si el navegador no puede crear el formato: `encoderUnavailable` (nunca un error generico)", async () => {
    supported = { opus: false, "mp4a.40.2": false };
    await expect(encodeAudio(sourceOfAudio(monoSine(440, 0.1)), options({ format: "m4a" }))).rejects.toMatchObject({ code: "encoderUnavailable" });
    await expect(encodeAudio(sourceOfAudio(monoSine(440, 0.1)), options({ format: "opus" }))).rejects.toMatchObject({ code: "encoderUnavailable" });
  });

  it("cancelar a mitad detiene y cierra el codificador", async () => {
    const controller = new AbortController();
    const source = sourceOfAudio(monoSine(440, 5, 44100));
    const wrapped = {
      ...source,
      read: (start: number, end: number) => {
        if (start > 0) controller.abort();
        return source.read(start, end);
      },
    };
    await expect(encodeAudio(wrapped, options({ format: "m4a" }), { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(instances[0].closed).toBe(true);
  });

  it("un error del codificador llega como error, no se queda colgado", async () => {
    class Failing extends FakeEncoder {
      encode() {
        throw new DOMException("fallo", "EncodingError");
      }
    }
    vi.stubGlobal("AudioEncoder", Failing);
    await expect(encodeAudio(sourceOfAudio(monoSine(440, 0.5)), options({ format: "m4a" }))).rejects.toMatchObject({ code: "corrupt" });
  });
});
