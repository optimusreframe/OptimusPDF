import { describe, expect, it } from "vitest";
import { AudioError } from "@/lib/media/audio/errors";
import { sourceOfAudio } from "@/lib/media/audio/pcm";
import { audioOf, estimateFrequency, monoSine, stereoSine } from "@/lib/media/audio/testAudio";
import { decodeWav, encodeWav, parseWavHeader, wavHeader } from "@/lib/media/audio/wav";

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("encodeWav", () => {
  it("escribe una cabecera RIFF/WAVE de 44 bytes con los campos correctos (estereo, 44,1 kHz, 16 bits)", async () => {
    const blob = await encodeWav(sourceOfAudio(stereoSine(440, 880, 0.5, 44100)));
    const bytes = await bytesOf(blob);
    const view = new DataView(bytes.buffer);
    const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
    const frames = 22050;
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(tag(36)).toBe("data");
    expect(view.getUint32(4, true)).toBe(36 + frames * 4);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(44100 * 4);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(frames * 4);
    expect(bytes.length).toBe(44 + frames * 4);
    expect(blob.type).toBe("audio/wav");
  });

  it("ida y vuelta: decodeWav devuelve las mismas muestras (error maximo medio escalon de 16 bits) y conserva la frecuencia", async () => {
    const original = stereoSine(440, 1000, 1, 22050, 0.8);
    const decoded = decodeWav(await bytesOf(await encodeWav(sourceOfAudio(original))));
    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.channels).toHaveLength(2);
    let worst = 0;
    original.channels.forEach((channel, c) => channel.forEach((value, i) => (worst = Math.max(worst, Math.abs(value - decoded.channels[c][i])))));
    expect(worst).toBeLessThanOrEqual(1 / 32768);
    expect(estimateFrequency(decoded.channels[0], 22050)).toBeCloseTo(440, -1);
  });

  it("recorta lo que pasa de -1..1 en vez de dar la vuelta", async () => {
    const loud = audioOf([new Float32Array([2, -2, 1, -1, 0.5, Number.NaN])], 8000);
    const decoded = decodeWav(await bytesOf(await encodeWav(sourceOfAudio(loud))));
    const values = Array.from(decoded.channels[0]);
    expect(values[0]).toBeCloseTo(32767 / 32768, 6);
    expect(values[1]).toBe(-1);
    expect(values[2]).toBeCloseTo(32767 / 32768, 6);
    expect(values[3]).toBe(-1);
    expect(values[4]).toBeCloseTo(0.5, 4);
    expect(values[5]).toBe(0);
  });

  it("informa del progreso hasta 1 y se detiene si se cancela", async () => {
    const seen: number[] = [];
    await encodeWav(sourceOfAudio(monoSine(440, 3, 44100)), undefined, (value) => seen.push(value));
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((value, i) => i === 0 || value >= seen[i - 1])).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(encodeWav(sourceOfAudio(monoSine(440, 1)), controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rechaza un audio que no cabe en un WAV (limite de 4 GiB del formato) antes de leer nada", async () => {
    const huge = { sampleRate: 48000, numberOfChannels: 2, length: 2_000_000_000, read: () => { throw new Error("no debe leer"); } };
    await expect(encodeWav(huge)).rejects.toMatchObject({ code: "tooLong" });
  });
});

describe("parseWavHeader / decodeWav", () => {
  it("lee una cabecera propia con chunks extra (LIST) antes de `data`", async () => {
    const wav = await bytesOf(await encodeWav(sourceOfAudio(monoSine(440, 0.1, 8000))));
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4]);
    const patched = new Uint8Array(wav.length + list.length);
    patched.set(wav.subarray(0, 36), 0);
    patched.set(list, 36);
    patched.set(wav.subarray(36), 36 + list.length);
    const info = parseWavHeader(patched);
    expect(info).toMatchObject({ sampleRate: 8000, channels: 1, bitsPerSample: 16, frames: 800 });
  });

  it("decodifica PCM de 8, 24 y 32 bits y flotante de 32 bits", () => {
    const build = (bits: number, format: number, samples: number[], write: (view: DataView, offset: number, value: number) => void) => {
      const step = bits / 8;
      const data = new Uint8Array(samples.length * step);
      const dv = new DataView(data.buffer);
      samples.forEach((value, i) => write(dv, i * step, value));
      const head = new DataView(wavHeader(samples.length, 8000, 1));
      head.setUint16(20, format, true);
      head.setUint16(32, step, true);
      head.setUint16(34, bits, true);
      head.setUint32(28, 8000 * step, true);
      head.setUint32(40, data.length, true);
      const out = new Uint8Array(44 + data.length);
      out.set(new Uint8Array(head.buffer), 0);
      out.set(data, 44);
      return out;
    };
    expect(decodeWav(build(8, 1, [128, 255, 0], (v, o, x) => v.setUint8(o, x))).channels[0]).toEqual(new Float32Array([0, 127 / 128, -1]));
    const pcm24 = decodeWav(build(24, 1, [0, 4194304, -8388608], (v, o, x) => {
      v.setUint8(o, x & 255);
      v.setUint8(o + 1, (x >> 8) & 255);
      v.setUint8(o + 2, (x >> 16) & 255);
    }));
    expect(Array.from(pcm24.channels[0])).toEqual([0, 0.5, -1]);
    const pcm32 = decodeWav(build(32, 1, [0, 1073741824], (v, o, x) => v.setInt32(o, x, true)));
    expect(Array.from(pcm32.channels[0])).toEqual([0, 0.5]);
    const float = decodeWav(build(32, 3, [0.25, -0.75], (v, o, x) => v.setFloat32(o, x, true)));
    expect(Array.from(float.channels[0])).toEqual([0.25, -0.75]);
  });

  it("devuelve null para lo que no es WAV o es un formato que no cubrimos (ADPCM), y decodeWav lanza `unsupportedFormat`", () => {
    expect(parseWavHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    const adpcm = new Uint8Array(wavHeader(10, 8000, 1));
    new DataView(adpcm.buffer).setUint16(20, 2, true);
    expect(parseWavHeader(adpcm)).toBeNull();
    expect(() => decodeWav(adpcm)).toThrowError(AudioError);
  });

  it("un `data` truncado (menos bytes que los declarados) se lee hasta donde llega, y vacio da `empty`", async () => {
    const wav = await bytesOf(await encodeWav(sourceOfAudio(monoSine(440, 0.1, 8000))));
    const cut = wav.subarray(0, 44 + 201); // 100 muestras y un byte suelto
    expect(decodeWav(cut).channels[0]).toHaveLength(100);
    expect(() => decodeWav(wav.subarray(0, 44))).toThrowError(expect.objectContaining({ code: "empty" }));
  });
});
