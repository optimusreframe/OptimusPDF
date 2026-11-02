import { describe, expect, it } from "vitest";
import {
  appendClip,
  applyFade,
  applyGain,
  commit,
  conformAudio,
  emptyTrack,
  initHistory,
  moveSegment,
  peakInRange,
  peakInRangeAsync,
  readTrack,
  redo,
  removeRange,
  removeSegment,
  segmentIndexAt,
  segmentStarts,
  splitTrackAt,
  trackDuration,
  trackLength,
  trackPeaks,
  trackSource,
  trimToRange,
  undo,
  type Track,
} from "@/lib/media/audio/edit";
import { dbToGain, normalizationGain } from "@/lib/media/audio/pcm";
import { audioOf, monoSine, peak, stereoSine } from "@/lib/media/audio/testAudio";

/** Una pista con una rampa 0,1,2,... 9 (un fotograma por unidad) para ver exactamente que muestras quedan. */
const ramp = (frames: number, name = "rampa", rate = 100): Track =>
  appendClip(emptyTrack(rate, 1), audioOf([Float32Array.from({ length: frames }, (_, i) => i / 100)], rate), name).track;

const values = (track: Track) => Array.from(readTrack(track, 0, trackLength(track))[0]).map((v) => Math.round(v * 100));

describe("pista: importar y medir", () => {
  it("el primer audio fija frecuencia y canales; la duracion sale de los fotogramas", () => {
    const { track, conformed } = appendClip(emptyTrack(), stereoSine(440, 880, 2, 48000), "uno.wav");
    expect(track.sampleRate).toBe(48000);
    expect(track.channels).toBe(2);
    expect(conformed).toBe(false);
    expect(trackLength(track)).toBe(96000);
    expect(trackDuration(track)).toBe(2);
  });

  it("un audio mono como primero deja la pista mono; mas de 2 canales se baja a estereo", () => {
    expect(appendClip(emptyTrack(), monoSine(440, 0.1), "m").track.channels).toBe(1);
    const six = audioOf(Array.from({ length: 6 }, () => new Float32Array(100)), 44100);
    const result = appendClip(emptyTrack(), six, "seis");
    expect(result.track.channels).toBe(2);
    expect(result.track.segments[0].source.channels).toHaveLength(2);
  });

  it("los siguientes se ajustan a la pista (frecuencia y canales) y se avisa", () => {
    const first = appendClip(emptyTrack(), monoSine(440, 1, 44100), "a").track;
    const second = appendClip(first, stereoSine(440, 440, 1, 48000), "b");
    expect(second.conformed).toBe(true);
    const joined = second.track;
    expect(joined.sampleRate).toBe(44100);
    expect(joined.channels).toBe(1);
    expect(trackLength(joined)).toBe(88200);
    expect(joined.segments[1].source.sampleRate).toBe(44100);
    expect(joined.segments[1].source.channels).toHaveLength(1);
  });

  it("un audio que ya coincide no se copia ni se avisa", () => {
    const audio = monoSine(440, 0.1);
    expect(conformAudio(audio, 44100, 1)).toBe(audio);
    const { track, conformed } = appendClip(appendClip(emptyTrack(), audio, "a").track, monoSine(440, 0.1), "b");
    expect(conformed).toBe(false);
    expect(track.segments).toHaveLength(2);
  });

  it("unir dos clips los deja en orden y sin hueco", () => {
    const a = audioOf([Float32Array.from([0.1, 0.2, 0.3])], 100);
    const b = audioOf([Float32Array.from([0.4, 0.5])], 100);
    const track = appendClip(appendClip(emptyTrack(100, 1), a, "a").track, b, "b").track;
    expect(values(track)).toEqual([10, 20, 30, 40, 50]);
    expect(segmentStarts(track)).toEqual([0, 3, 5]);
  });
});

describe("cortar", () => {
  it("recortar a la seleccion deja solo ese tramo", () => {
    expect(values(trimToRange(ramp(10), 3, 7))).toEqual([3, 4, 5, 6]);
  });

  it("quitar la seleccion junta lo que queda a ambos lados", () => {
    expect(values(removeRange(ramp(10), 3, 7))).toEqual([0, 1, 2, 7, 8, 9]);
    expect(values(removeRange(ramp(10), 0, 4))).toEqual([4, 5, 6, 7, 8, 9]);
    expect(values(removeRange(ramp(10), 8, 10))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("los extremos al reves o fuera de rango se acotan; una seleccion vacia no cambia nada", () => {
    const track = ramp(10);
    expect(values(trimToRange(track, 7, 3))).toEqual([3, 4, 5, 6]);
    expect(values(trimToRange(track, -5, 4))).toEqual([0, 1, 2, 3]);
    expect(trimToRange(track, 5, 5)).toBe(track);
    expect(removeRange(track, 5, 5)).toBe(track);
  });

  it("dividir no cambia el sonido, crea un limite y es idempotente", () => {
    const track = ramp(10);
    const split = splitTrackAt(track, 4);
    expect(values(split)).toEqual(values(track));
    expect(split.segments).toHaveLength(2);
    expect(segmentStarts(split)).toEqual([0, 4, 10]);
    expect(splitTrackAt(split, 4)).toBe(split);
    expect(splitTrackAt(track, 0)).toBe(track);
    expect(splitTrackAt(track, 10)).toBe(track);
  });

  it("tras dividir, cada parte se puede quitar o reordenar", () => {
    const split = splitTrackAt(splitTrackAt(ramp(9), 3), 6);
    expect(values(removeSegment(split, 1))).toEqual([0, 1, 2, 6, 7, 8]);
    expect(values(moveSegment(split, 2, 0))).toEqual([6, 7, 8, 0, 1, 2, 3, 4, 5]);
    expect(values(moveSegment(split, 0, 2))).toEqual([3, 4, 5, 6, 7, 8, 0, 1, 2]);
    expect(moveSegment(split, 1, 1)).toBe(split);
    expect(moveSegment(split, 0, 9)).toBe(split);
  });

  it("segmentIndexAt devuelve el clip que contiene el fotograma", () => {
    const split = splitTrackAt(ramp(9), 3);
    expect(segmentIndexAt(split, 0)).toBe(0);
    expect(segmentIndexAt(split, 2)).toBe(0);
    expect(segmentIndexAt(split, 3)).toBe(1);
    expect(segmentIndexAt(split, 99)).toBe(1);
  });

  it("las operaciones son puras: la pista original no cambia", () => {
    const track = ramp(10);
    const before = values(track);
    trimToRange(track, 2, 5);
    removeRange(track, 2, 5);
    applyGain(track, 0, 10, 0.5);
    applyFade(track, 0, 10, "in");
    expect(values(track)).toEqual(before);
    expect(track.segments).toHaveLength(1);
  });
});

describe("volumen", () => {
  it("la ganancia se aplica solo a la seleccion", () => {
    const track = applyGain(ramp(10), 4, 8, 2);
    expect(values(track)).toEqual([0, 1, 2, 3, 8, 10, 12, 14, 8, 9]);
  });

  it("ganancias sucesivas se multiplican y sobreviven a cortar", () => {
    const loud = applyGain(applyGain(ramp(10), 0, 10, 2), 0, 10, 2);
    expect(values(loud)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
    expect(values(trimToRange(loud, 2, 4))).toEqual([8, 12]);
  });

  it("normalizar lleva el pico a -1 dBFS", () => {
    const track = appendClip(emptyTrack(8000, 1), monoSine(440, 0.5, 8000, 0.2), "q").track;
    const p = peakInRange(track, 0, trackLength(track));
    expect(p).toBeCloseTo(0.2, 2);
    const normalized = applyGain(track, 0, trackLength(track), normalizationGain(p));
    expect(peakInRange(normalized, 0, trackLength(normalized))).toBeCloseTo(0.891, 2);
  });

  it("peakInRangeAsync da lo mismo que la version sincrona y respeta la cancelacion", async () => {
    const track = appendClip(emptyTrack(8000, 1), monoSine(440, 1, 8000, 0.3), "q").track;
    expect(await peakInRangeAsync(track, 0, trackLength(track))).toBeCloseTo(peakInRange(track, 0, trackLength(track)), 6);
    const controller = new AbortController();
    controller.abort();
    expect(await peakInRangeAsync(track, 0, trackLength(track), controller.signal)).toBe(0);
  });

  it("dbToGain es la conversion usada por el control de volumen", () => {
    const track = applyGain(appendClip(emptyTrack(8000, 1), monoSine(440, 0.1, 8000, 0.5), "q").track, 0, 800, dbToGain(-6));
    expect(peak(readTrack(track, 0, 800)[0])).toBeCloseTo(0.25, 2);
  });
});

describe("fundidos", () => {
  const fv = (track: Track) => Array.from(readTrack(track, 0, trackLength(track))[0]).map((v) => Math.round(v * 1000) / 1000);
  const flat = (frames: number) => appendClip(emptyTrack(100, 1), audioOf([new Float32Array(frames).fill(1)], 100), "plano").track;

  it("fundido de entrada: sube linealmente de 0 a 1 sobre el tramo y no toca lo demas", () => {
    const faded = applyFade(flat(10), 0, 4, "in");
    expect(fv(faded)).toEqual([0, 0.25, 0.5, 0.75, 1, 1, 1, 1, 1, 1]);
  });

  it("fundido de salida: baja de 1 a 0 al final", () => {
    const faded = applyFade(flat(10), 6, 10, "out");
    expect(fv(faded)).toEqual([1, 1, 1, 1, 1, 1, 1, 0.75, 0.5, 0.25]);
  });

  it("un fundido que cruza varios clips es continuo (la rampa se reparte entre ellos)", () => {
    const a = appendClip(emptyTrack(100, 1), audioOf([new Float32Array(4).fill(1)], 100), "a").track;
    const joined = appendClip(a, audioOf([new Float32Array(4).fill(1)], 100), "b").track;
    const faded = applyFade(joined, 0, 8, "in");
    expect(fv(faded)).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
  });

  it("cortar despues de un fundido parte la rampa sin saltos", () => {
    const faded = applyFade(flat(8), 0, 8, "in");
    const cut = trimToRange(faded, 2, 6);
    expect(fv(cut)).toEqual([0.25, 0.375, 0.5, 0.625]);
    const split = splitTrackAt(faded, 4);
    expect(fv(split)).toEqual(fv(faded));
  });

  it("fundido de entrada y de salida a la vez se multiplican", () => {
    const both = applyFade(applyFade(flat(8), 0, 4, "in"), 4, 8, "out");
    expect(fv(both)).toEqual([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]);
  });
});

describe("lectura y onda", () => {
  it("readTrack acota y mezcla varios clips; trackSource lo expone como origen", () => {
    const track = appendClip(appendClip(emptyTrack(100, 1), audioOf([Float32Array.from([0.1, 0.2])], 100), "a").track, audioOf([Float32Array.from([0.3])], 100), "b").track;
    expect(Array.from(readTrack(track, -3, 99)[0]).map((v) => Math.round(v * 10))).toEqual([1, 2, 3]);
    expect(Array.from(readTrack(track, 1, 3)[0]).map((v) => Math.round(v * 10))).toEqual([2, 3]);
    const source = trackSource(track);
    expect(source.length).toBe(3);
    expect(source.numberOfChannels).toBe(1);
    expect(source.read(2, 3)[0]).toHaveLength(1);
  });

  it("trackPeaks da minimo y maximo por columna y refleja la ganancia", () => {
    const track = appendClip(emptyTrack(1000, 1), audioOf([sineOfSquare(1000)], 1000), "c").track;
    const peaks = trackPeaks(track, 10);
    expect(peaks.max).toHaveLength(10);
    expect(Math.max(...peaks.max)).toBeCloseTo(0.8, 5);
    expect(Math.min(...peaks.min)).toBeCloseTo(-0.8, 5);
    const quiet = applyGain(track, 0, 1000, 0.5);
    expect(Math.max(...trackPeaks(quiet, 10).max)).toBeCloseTo(0.4, 5);
    const empty = trackPeaks(emptyTrack(), 5);
    expect(Array.from(empty.max)).toEqual([0, 0, 0, 0, 0]);
  });
});

/** Onda cuadrada de +-0,8 para comprobar picos exactos. */
function sineOfSquare(frames: number): Float32Array {
  return Float32Array.from({ length: frames }, (_, i) => (Math.floor(i / 50) % 2 === 0 ? 0.8 : -0.8));
}

describe("historial", () => {
  it("deshacer y rehacer recorren los estados y un cambio nuevo borra el futuro", () => {
    let history = initHistory(ramp(10));
    const start = history.present;
    history = commit(history, trimToRange(history.present, 2, 8));
    history = commit(history, removeRange(history.present, 0, 2));
    expect(values(history.present)).toEqual([4, 5, 6, 7]);
    history = undo(history);
    expect(values(history.present)).toEqual([2, 3, 4, 5, 6, 7]);
    history = undo(history);
    expect(history.present).toBe(start);
    expect(undo(history)).toBe(history);
    history = redo(history);
    expect(values(history.present)).toEqual([2, 3, 4, 5, 6, 7]);
    history = commit(history, trimToRange(history.present, 0, 1));
    expect(history.future).toHaveLength(0);
    expect(redo(history)).toBe(history);
  });

  it("confirmar el mismo estado no ensucia el historial; el limite es de 100 estados", () => {
    const history = initHistory(ramp(10));
    expect(commit(history, history.present)).toBe(history);
    let long = history;
    for (let i = 0; i < 130; i += 1) long = commit(long, applyGain(long.present, 0, 10, 1.01));
    expect(long.past).toHaveLength(100);
  });

  it("los estados comparten los mismos buffers (deshacer no copia audio)", () => {
    const base = ramp(10);
    const next = trimToRange(base, 2, 8);
    expect(next.segments[0].source).toBe(base.segments[0].source);
  });
});
