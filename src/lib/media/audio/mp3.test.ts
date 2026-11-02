import { describe, expect, it } from "vitest";
import { encodeAudio, estimateOutputBytes, resolveTarget } from "@/lib/media/audio/encode";
import { clampMp3BitrateKbps, maxMp3BitrateKbps, snapMp3SampleRate } from "@/lib/media/audio/mp3Params";
import { sourceOfAudio } from "@/lib/media/audio/pcm";
import { probeMedia } from "@/lib/media/audio/probe";
import { monoSine, stereoSine } from "@/lib/media/audio/testAudio";
import { DEFAULT_ENCODE_OPTIONS, FORMAT_INFO, type EncodeOptions } from "@/lib/media/audio/types";
import { decodeWav, encodeWav } from "@/lib/media/audio/wav";

/**
 * MP3 de verdad (LAME en WASM dentro de un worker de Node: `@mediabunny/mp3-encoder` cae a `worker_threads` si no hay
 * `Worker`). No hay decodificador de MP3 en Node, asi que aqui se comprueba la ESTRUCTURA con un recorrido de tramas
 * escrito en la prueba (independiente de mediabunny); la decodificacion real y el tono se comprueban en el E2E con el
 * navegador (`audio-mp3.spec.ts`). Los audios son senos generados aqui.
 */

const options = (patch: Partial<EncodeOptions>): EncodeOptions => ({ ...DEFAULT_ENCODE_OPTIONS, format: "mp3", bitrateKbps: 128, ...patch });

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

type Mp3Walk = { frames: number; sampleRate: number; channels: number; bitrates: Set<number>; consumed: number; id3: boolean; samplesPerFrame: number };

/** Recorre tramas MPEG Capa III una a una por su longitud; lanza si algo no encaja. */
function walkMp3(bytes: Uint8Array): Mp3Walk {
  const id3 = String.fromCharCode(...bytes.subarray(0, 3)) === "ID3";
  let pos = 0;
  let frames = 0;
  let sampleRate = 0;
  let channels = 0;
  let samplesPerFrame = 0;
  const bitrates = new Set<number>();
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xe0) !== 0xe0) throw new Error(`sin sincronismo de trama en ${pos}`);
    const version = (bytes[pos + 1] >> 3) & 3;
    const layer = (bytes[pos + 1] >> 1) & 3;
    if (layer !== 1) throw new Error("no es Capa III");
    const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bytes[pos + 2] >> 4];
    const rate = RATES[version][(bytes[pos + 2] >> 2) & 3];
    const padding = (bytes[pos + 2] >> 1) & 1;
    if (!kbps || !rate) throw new Error("cabecera de trama invalida");
    samplesPerFrame = version === 3 ? 1152 : 576;
    const length = Math.floor(((samplesPerFrame / 8) * kbps * 1000) / rate) + padding;
    sampleRate = rate;
    channels = ((bytes[pos + 3] >> 6) & 3) === 3 ? 1 : 2;
    bitrates.add(kbps);
    frames += 1;
    pos += length;
  }
  return { frames, sampleRate, channels, bitrates, consumed: pos, id3, samplesPerFrame };
}

/** Duracion que oye quien decodifica: todas las tramas menos la de cabecera (Xing/Info) y menos el retraso del codificador. */
const decodedSeconds = (walk: Mp3Walk) => ((walk.frames - 1) * walk.samplesPerFrame - 1105) / walk.sampleRate;

async function encodeToBytes(audio: { sampleRate: number; channels: Float32Array[] }, patch: Partial<EncodeOptions>) {
  const blob = await encodeAudio(sourceOfAudio(audio), options(patch));
  return { blob, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

describe("mp3Params", () => {
  it("snapMp3SampleRate: las nueve validas se quedan; el resto va a la mas cercana (a igual distancia, la mayor)", () => {
    for (const rate of [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000]) expect(snapMp3SampleRate(rate)).toBe(rate);
    expect(snapMp3SampleRate(96000)).toBe(48000);
    expect(snapMp3SampleRate(88200)).toBe(48000);
    expect(snapMp3SampleRate(6000)).toBe(8000);
    expect(snapMp3SampleRate(40000)).toBe(44100);
    expect(snapMp3SampleRate(28000)).toBe(32000);
    expect(snapMp3SampleRate(10000)).toBe(11025);
  });
  it("la tasa de bits maxima depende de la frecuencia: 320 (MPEG-1), 160 (MPEG-2), 64 (MPEG-2.5)", () => {
    expect(maxMp3BitrateKbps(44100)).toBe(320);
    expect(maxMp3BitrateKbps(32000)).toBe(320);
    expect(maxMp3BitrateKbps(22050)).toBe(160);
    expect(maxMp3BitrateKbps(16000)).toBe(160);
    expect(maxMp3BitrateKbps(11025)).toBe(64);
    expect(clampMp3BitrateKbps(320, 22050)).toBe(160);
    expect(clampMp3BitrateKbps(192, 8000)).toBe(64);
    expect(clampMp3BitrateKbps(192, 44100)).toBe(192);
  });
});

describe("resolveTarget / estimateOutputBytes con MP3", () => {
  it("`original` lleva la frecuencia a una valida y deja como mucho 2 canales; lo pedido tambien se ajusta", () => {
    expect(resolveTarget({ sampleRate: 96000, numberOfChannels: 6 }, options({}))).toEqual({ sampleRate: 48000, channels: 2 });
    expect(resolveTarget({ sampleRate: 44100, numberOfChannels: 2 }, options({}))).toEqual({ sampleRate: 44100, channels: 2 });
    expect(resolveTarget({ sampleRate: 44100, numberOfChannels: 2 }, options({ sampleRate: 48000, channels: 1 }))).toEqual({ sampleRate: 48000, channels: 1 });
    expect(resolveTarget({ sampleRate: 44100, numberOfChannels: 2 }, options({ sampleRate: 40000 }))).toEqual({ sampleRate: 44100, channels: 2 });
  });
  it("tamano estimado = tasa de bits x duracion, recortada a lo que permite la frecuencia", () => {
    expect(estimateOutputBytes(10, { sampleRate: 44100, numberOfChannels: 2 }, options({ bitrateKbps: 192 }))).toBe(240_000);
    expect(estimateOutputBytes(10, { sampleRate: 22050, numberOfChannels: 2 }, options({ bitrateKbps: 320 }))).toBe(200_000);
  });
  it("FORMAT_INFO: extension .mp3 y MIME audio/mpeg", () => {
    expect(FORMAT_INFO.mp3).toEqual({ extension: "mp3", mime: "audio/mpeg" });
  });
});

describe("encodeAudio -> MP3 (LAME real)", () => {
  it("WAV -> MP3 estereo 44,1 kHz a 192 kbps: tramas validas de principio a fin, sin etiqueta ID3, duracion +-50 ms, frecuencia y canales", async () => {
    // Ida y vuelta por WAV como en la herramienta: el WAV de entrada se lee con nuestro lector y de ahi pasa al codificador.
    const wav = await encodeWav(sourceOfAudio(stereoSine(440, 880, 2, 44100)));
    const audio = decodeWav(new Uint8Array(await wav.arrayBuffer()));
    const progress: number[] = [];
    const blob = await encodeAudio(sourceOfAudio(audio), options({ bitrateKbps: 192 }), { onProgress: (v) => progress.push(v) });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(blob.type).toBe("audio/mpeg");
    const walk = walkMp3(bytes);
    expect(walk.consumed).toBe(bytes.length); // ni un byte sobrante ni una trama cortada
    expect(walk.id3).toBe(false); // sin etiquetas: nada del original
    expect(walk).toMatchObject({ sampleRate: 44100, channels: 2 });
    expect(walk.bitrates.has(192)).toBe(true);
    expect(Math.abs(decodedSeconds(walk) - 2)).toBeLessThan(0.05);

    // La cabecera Xing/Info esta en la primera trama y el sondeo propio del proyecto lo lee igual.
    expect(String.fromCharCode(...bytes.subarray(36, 40))).toMatch(/^(Xing|Info)$/);
    expect(await probeMedia(blob)).toMatchObject({ kind: "mp3", sampleRate: 44100, channels: 2 });

    // ~192 kbps x 2 s = 48 kB (CBR): ni vacio ni desmesurado.
    expect(bytes.length).toBeGreaterThan(40_000);
    expect(bytes.length).toBeLessThan(60_000);
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  }, 60_000);

  it("cada tasa de bits ofrecida sale a tasa constante y con el tamano esperado (128/192/256/320)", async () => {
    for (const kbps of [128, 192, 256, 320]) {
      const { bytes } = await encodeToBytes(stereoSine(440, 660, 1.5, 44100), { bitrateKbps: kbps });
      const walk = walkMp3(bytes);
      expect(walk.consumed).toBe(bytes.length);
      expect([...walk.bitrates].filter((value) => value !== kbps).length, `tasas distintas de ${kbps}: ${[...walk.bitrates]}`).toBeLessThanOrEqual(1); // la trama Xing puede llevar otra
      expect(walk.bitrates.has(kbps)).toBe(true);
      const expected = (1.5 * kbps * 1000) / 8;
      expect(bytes.length).toBeGreaterThan(expected * 0.9);
      expect(bytes.length).toBeLessThan(expected * 1.25);
    }
  }, 120_000);

  it("mono a 48 kHz desde un original estereo de 44,1 kHz: remezcla y remuestrea (cabecera mono, 48 kHz, duracion +-50 ms)", async () => {
    const { blob, bytes } = await encodeToBytes(stereoSine(440, 880, 1.2, 44100), { channels: 1, sampleRate: 48000, bitrateKbps: 128 });
    const walk = walkMp3(bytes);
    expect(walk).toMatchObject({ sampleRate: 48000, channels: 1 });
    expect(walk.consumed).toBe(bytes.length);
    expect(Math.abs(decodedSeconds(walk) - 1.2)).toBeLessThan(0.05);
    expect(await probeMedia(blob)).toMatchObject({ kind: "mp3", sampleRate: 48000, channels: 1 });
  }, 60_000);

  it("un original de 22,05 kHz a 320 kbps: la tasa se recorta a 160 (maximo MPEG-2) y el archivo es coherente", async () => {
    const { bytes } = await encodeToBytes(monoSine(440, 1, 22050), { bitrateKbps: 320 });
    const walk = walkMp3(bytes);
    expect(walk).toMatchObject({ sampleRate: 22050, channels: 1 });
    expect(walk.bitrates.has(160)).toBe(true);
    expect(Math.max(...walk.bitrates)).toBeLessThanOrEqual(160);
    expect(walk.consumed).toBe(bytes.length);
  }, 60_000);

  it("un audio muy corto (menos de una trama) sigue dando un MP3 valido", async () => {
    const { bytes } = await encodeToBytes(monoSine(440, 0.05, 44100), {});
    const walk = walkMp3(bytes);
    expect(walk.frames).toBeGreaterThanOrEqual(2);
    expect(walk.consumed).toBe(bytes.length);
  }, 60_000);

  it("silencio total: tambien es un MP3 valido (no falla ni sale vacio)", async () => {
    const { bytes } = await encodeToBytes({ sampleRate: 44100, channels: [new Float32Array(44100)] }, {});
    expect(walkMp3(bytes).consumed).toBe(bytes.length);
  }, 60_000);

  it("cancelar a mitad: lanza `cancelled` sin esperar al final y sin dejar el proceso colgado", async () => {
    const controller = new AbortController();
    const long = stereoSine(440, 880, 30, 44100);
    const started = Date.now();
    const promise = encodeAudio(sourceOfAudio(long), options({}), { signal: controller.signal, onProgress: (value) => value > 0.1 && controller.abort() });
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("ya cancelado antes de empezar: `cancelled` de inmediato", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(encodeAudio(sourceOfAudio(monoSine(440, 1, 44100)), options({}), { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("un audio sin muestras: `empty` (antes de cargar nada)", async () => {
    await expect(encodeAudio(sourceOfAudio({ sampleRate: 44100, channels: [new Float32Array(0)] }), options({}))).rejects.toMatchObject({ code: "empty" });
  });
});
