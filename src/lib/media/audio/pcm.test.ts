import { describe, expect, it } from "vitest";
import { concatAudio, dbToGain, gainToDb, normalizationGain, peakOfSource, readAll, remixBlock, remixSource, sourceOfAudio } from "@/lib/media/audio/pcm";
import { audioOf, monoSine, stereoSine } from "@/lib/media/audio/testAudio";

describe("remixBlock / remixSource", () => {
  it("mono a estereo copia el canal; estereo a mono promedia", () => {
    const mono = [new Float32Array([0.2, 0.4])];
    const stereo = remixBlock(mono, 2);
    expect(stereo).toHaveLength(2);
    expect(Array.from(stereo[1])).toEqual(Array.from(mono[0]));
    expect(stereo[1]).not.toBe(mono[0]);
    const back = remixBlock([new Float32Array([1, 0]), new Float32Array([0, 1])], 1);
    expect(Array.from(back[0])).toEqual([0.5, 0.5]);
  });

  it("multicanal a estereo reparte pares en la izquierda e impares en la derecha", () => {
    const six = [1, 2, 3, 4, 5, 6].map((v) => new Float32Array([v]));
    const [left, right] = remixBlock(six, 2);
    expect(left[0]).toBeCloseTo((1 + 3 + 5) / 3);
    expect(right[0]).toBeCloseTo((2 + 4 + 6) / 3);
  });

  it("no toca nada si ya tiene los canales pedidos", () => {
    const source = sourceOfAudio(monoSine(440, 0.1));
    expect(remixSource(source, 1)).toBe(source);
    expect(remixSource(source, 2).numberOfChannels).toBe(2);
    expect(remixSource(source, 2).read(0, 10)).toHaveLength(2);
  });
});

describe("sourceOfAudio / readAll / concat", () => {
  it("read recorta a los limites y devuelve copias", () => {
    const audio = monoSine(440, 0.01, 1000);
    const source = sourceOfAudio(audio);
    expect(source.length).toBe(10);
    expect(source.read(-5, 3)[0]).toHaveLength(3);
    expect(source.read(8, 99)[0]).toHaveLength(2);
    expect(source.read(5, 5)[0]).toHaveLength(0);
    const copy = source.read(0, 10)[0];
    copy[0] = 99;
    expect(audio.channels[0][0]).not.toBe(99);
    expect(readAll(source).channels[0]).toEqual(audio.channels[0]);
  });

  it("concatAudio junta en orden", () => {
    const joined = concatAudio([audioOf([new Float32Array([1, 2])], 8000), audioOf([new Float32Array([3])], 8000)]);
    expect(Array.from(joined.channels[0])).toEqual([1, 2, 3]);
    expect(joined.sampleRate).toBe(8000);
  });
});

describe("volumen", () => {
  it("peakOfSource y normalizationGain llevan el pico a -1 dBFS", () => {
    const source = sourceOfAudio(stereoSine(440, 880, 0.5, 8000, 0.25));
    const peak = peakOfSource(source);
    expect(peak).toBeCloseTo(0.25, 2);
    expect(peak * normalizationGain(peak)).toBeCloseTo(0.891, 3);
    expect(normalizationGain(0)).toBe(1);
  });

  it("dB <-> ganancia", () => {
    expect(dbToGain(6)).toBeCloseTo(1.995, 2);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 5);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
  });
});
