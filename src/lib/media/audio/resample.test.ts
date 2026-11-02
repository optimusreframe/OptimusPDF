import { describe, expect, it } from "vitest";
import { readAll, sourceOfAudio } from "@/lib/media/audio/pcm";
import { outputLength, resampleSource } from "@/lib/media/audio/resample";
import { estimateFrequency, monoSine, peak, rms, sine, audioOf } from "@/lib/media/audio/testAudio";

describe("resampleSource", () => {
  it("con la misma frecuencia devuelve el mismo origen", () => {
    const source = sourceOfAudio(monoSine(440, 0.1));
    expect(resampleSource(source, 44100)).toBe(source);
  });

  it("44,1 -> 48 kHz: longitud proporcional, frecuencia y nivel conservados", () => {
    const source = sourceOfAudio(monoSine(1000, 1, 44100, 0.5));
    const up = readAll(resampleSource(source, 48000));
    expect(up.sampleRate).toBe(48000);
    expect(up.channels[0]).toHaveLength(48000);
    // Se ignoran los bordes (el filtro no tiene vecinos fuera).
    const middle = up.channels[0].subarray(2000, 46000);
    expect(estimateFrequency(middle, 48000)).toBeCloseTo(1000, -1);
    expect(rms(middle)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(peak(middle)).toBeLessThan(0.52);
  });

  it("48 -> 16 kHz: conserva 1 kHz y elimina 12 kHz (por encima del nuevo Nyquist) en mas de 40 dB", () => {
    const keep = readAll(resampleSource(sourceOfAudio(monoSine(1000, 1, 48000, 0.5)), 16000)).channels[0];
    const drop = readAll(resampleSource(sourceOfAudio(monoSine(12000, 1, 48000, 0.5)), 16000)).channels[0];
    expect(rms(keep, 500, 15500)).toBeCloseTo(0.5 / Math.SQRT2, 1);
    expect(rms(drop, 500, 15500)).toBeLessThan((0.5 / Math.SQRT2) * 0.01);
  });

  it("leer por bloques da exactamente lo mismo que leer de una vez (los trozos del codificador)", () => {
    const source = resampleSource(sourceOfAudio(audioOf([sine(440, 0.5, 44100), sine(660, 0.5, 44100)], 44100)), 32000);
    const whole = source.read(0, source.length);
    const parts = [source.read(0, 1000), source.read(1000, 7000), source.read(7000, source.length)];
    whole.forEach((channel, c) => {
      const joined = new Float32Array(channel.length);
      let offset = 0;
      for (const part of parts) {
        joined.set(part[c], offset);
        offset += part[c].length;
      }
      expect(joined).toEqual(channel);
    });
  });

  it("outputLength redondea y no es negativo", () => {
    expect(outputLength(44100, 44100, 48000)).toBe(48000);
    expect(outputLength(0, 44100, 8000)).toBe(0);
    expect(outputLength(3, 48000, 8000)).toBe(1);
  });
});
