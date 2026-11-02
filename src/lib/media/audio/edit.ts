import { readAll, remixSource, sourceOfAudio, yieldToBrowser } from "@/lib/media/audio/pcm";
import { resampleSource } from "@/lib/media/audio/resample";
import type { PcmAudio, PcmSource } from "@/lib/media/audio/types";
import { frameCount } from "@/lib/media/audio/types";

/**
 * Modelo de edicion de Audio Studio.
 *
 * La pista es una SECUENCIA de segmentos. Cada segmento apunta a un trozo de un audio fuente INMUTABLE (`source`,
 * `start`..`end`) y lleva una ganancia y una lista de rampas de volumen (fundidos). Cortar, quitar, dividir y unir solo
 * reordenan segmentos: no copian muestras, asi que deshacer/rehacer es gratis (los estados son valores inmutables que
 * comparten los mismos buffers) y un audio largo no se multiplica en memoria con cada edicion. Las muestras con ganancia
 * y fundidos se calculan al leer (reproducir, dibujar la onda, exportar).
 *
 * Todas las funciones son puras: devuelven una pista nueva y nunca modifican la recibida.
 */

/** Rampa lineal de volumen en coordenadas de la fuente: de `g0` en `a` a `g1` en `b`; fuera de `[a, b)` vale 1. */
export type Ramp = { a: number; b: number; g0: number; g1: number };

export type Segment = {
  id: number;
  /** Nombre del archivo del que viene (solo para la lista de clips). */
  name: string;
  source: PcmAudio;
  start: number;
  end: number;
  gain: number;
  ramps: readonly Ramp[];
};

export type Track = {
  sampleRate: number;
  /** 1 o 2: el estudio trabaja siempre en mono o estereo. */
  channels: 1 | 2;
  segments: readonly Segment[];
};

let nextSegmentId = 1;
export const newSegmentId = () => nextSegmentId++;

export function emptyTrack(sampleRate = 44100, channels: 1 | 2 = 2): Track {
  return { sampleRate, channels, segments: [] };
}

export const segmentLength = (segment: Segment) => segment.end - segment.start;

const startsCache = new WeakMap<Track, number[]>();
/** Fotograma de la pista en que empieza cada segmento; el ultimo elemento es la longitud total. */
export function segmentStarts(track: Track): number[] {
  let starts = startsCache.get(track);
  if (!starts) {
    starts = [0];
    for (const segment of track.segments) starts.push(starts[starts.length - 1] + segmentLength(segment));
    startsCache.set(track, starts);
  }
  return starts;
}

export function trackLength(track: Track): number {
  const starts = segmentStarts(track);
  return starts[starts.length - 1];
}

export function trackDuration(track: Track): number {
  return track.sampleRate > 0 ? trackLength(track) / track.sampleRate : 0;
}

/* ------------------------------------------------------------------ *
 * Cortar segmentos
 * ------------------------------------------------------------------ */

function splitRamps(ramps: readonly Ramp[], point: number): [Ramp[], Ramp[]] {
  const left: Ramp[] = [];
  const right: Ramp[] = [];
  for (const ramp of ramps) {
    if (ramp.b <= point) left.push(ramp);
    else if (ramp.a >= point) right.push(ramp);
    else {
      const gp = ramp.g0 + ((ramp.g1 - ramp.g0) * (point - ramp.a)) / (ramp.b - ramp.a);
      left.push({ a: ramp.a, b: point, g0: ramp.g0, g1: gp });
      right.push({ a: point, b: ramp.b, g0: gp, g1: ramp.g1 });
    }
  }
  return [left, right];
}

/** Parte un segmento en `local` (0 < local < longitud) en dos que comparten fuente. */
export function splitSegment(segment: Segment, local: number): [Segment, Segment] {
  const point = segment.start + local;
  const [leftRamps, rightRamps] = splitRamps(segment.ramps, point);
  return [
    { ...segment, id: newSegmentId(), end: point, ramps: leftRamps },
    { ...segment, id: newSegmentId(), start: point, ramps: rightRamps },
  ];
}

const clampFrame = (track: Track, frame: number) => Math.max(0, Math.min(trackLength(track), Math.round(frame)));

/** Garantiza un limite entre segmentos en `frame` (sin cambiar el sonido). Devuelve la misma pista si ya lo hay. */
export function splitTrackAt(track: Track, frame: number): Track {
  const at = clampFrame(track, frame);
  const starts = segmentStarts(track);
  for (let i = 0; i < track.segments.length; i += 1) {
    if (at <= starts[i] || at >= starts[i + 1]) continue;
    const [left, right] = splitSegment(track.segments[i], at - starts[i]);
    return { ...track, segments: [...track.segments.slice(0, i), left, right, ...track.segments.slice(i + 1)] };
  }
  return track;
}

function withBoundaries(track: Track, from: number, to: number): { track: Track; from: number; to: number } {
  const a = clampFrame(track, Math.min(from, to));
  const b = clampFrame(track, Math.max(from, to));
  return { track: splitTrackAt(splitTrackAt(track, a), b), from: a, to: b };
}

/** Aplica `fn` a cada segmento que queda dentro de `[from, to)` (tras partir en los bordes). */
function mapRange(track: Track, from: number, to: number, fn: (segment: Segment, startFrame: number, endFrame: number) => Segment): Track {
  const split = withBoundaries(track, from, to);
  if (split.to <= split.from) return track;
  const starts = segmentStarts(split.track);
  return {
    ...split.track,
    segments: split.track.segments.map((segment, i) => (starts[i] >= split.from && starts[i + 1] <= split.to ? fn(segment, starts[i], starts[i + 1]) : segment)),
  };
}

/** Deja solo `[from, to)`. */
export function trimToRange(track: Track, from: number, to: number): Track {
  const split = withBoundaries(track, from, to);
  if (split.to <= split.from) return track;
  const starts = segmentStarts(split.track);
  return { ...split.track, segments: split.track.segments.filter((_, i) => starts[i] >= split.from && starts[i + 1] <= split.to) };
}

/** Quita `[from, to)` y junta lo que queda. */
export function removeRange(track: Track, from: number, to: number): Track {
  const split = withBoundaries(track, from, to);
  if (split.to <= split.from) return track;
  const starts = segmentStarts(split.track);
  return { ...split.track, segments: split.track.segments.filter((_, i) => !(starts[i] >= split.from && starts[i + 1] <= split.to)) };
}

/* ------------------------------------------------------------------ *
 * Volumen y fundidos
 * ------------------------------------------------------------------ */

export function applyGain(track: Track, from: number, to: number, factor: number): Track {
  return mapRange(track, from, to, (segment) => ({ ...segment, gain: segment.gain * factor }));
}

/** Fundido lineal sobre `[from, to)`: `"in"` sube de silencio a volumen normal, `"out"` baja a silencio. */
export function applyFade(track: Track, from: number, to: number, direction: "in" | "out"): Track {
  const a = clampFrame(track, Math.min(from, to));
  const b = clampFrame(track, Math.max(from, to));
  if (b <= a) return track;
  return mapRange(track, a, b, (segment, startFrame, endFrame) => {
    const p0 = (startFrame - a) / (b - a);
    const p1 = (endFrame - a) / (b - a);
    const ramp: Ramp = {
      a: segment.start,
      b: segment.end,
      g0: direction === "in" ? p0 : 1 - p0,
      g1: direction === "in" ? p1 : 1 - p1,
    };
    return { ...segment, ramps: [...segment.ramps, ramp] };
  });
}

/* ------------------------------------------------------------------ *
 * Lectura (reproducir, exportar, medir)
 * ------------------------------------------------------------------ */

/** Muestras `[a, b)` (coordenadas de la fuente) de un segmento con su ganancia y rampas aplicadas. */
function renderSegment(segment: Segment, a: number, b: number): Float32Array[] {
  const count = b - a;
  const out = segment.source.channels.map((channel) => {
    if (segment.gain === 1) return channel.slice(a, b);
    const block = new Float32Array(count);
    for (let i = 0; i < count; i += 1) block[i] = channel[a + i] * segment.gain;
    return block;
  });
  for (const ramp of segment.ramps) {
    const lo = Math.max(a, ramp.a);
    const hi = Math.min(b, ramp.b);
    if (hi <= lo) continue;
    const slope = (ramp.g1 - ramp.g0) / (ramp.b - ramp.a);
    for (const block of out) for (let i = lo; i < hi; i += 1) block[i - a] *= ramp.g0 + slope * (i - ramp.a);
  }
  return out;
}

/** Fotogramas `[start, end)` de la pista ya mezclados (nuevo `Float32Array` por canal). */
export function readTrack(track: Track, start: number, end: number): Float32Array[] {
  const from = clampFrame(track, start);
  const to = Math.max(from, clampFrame(track, end));
  const out = Array.from({ length: track.channels }, () => new Float32Array(to - from));
  const starts = segmentStarts(track);
  for (let i = 0; i < track.segments.length; i += 1) {
    const segStart = starts[i];
    const segEnd = starts[i + 1];
    if (segEnd <= from) continue;
    if (segStart >= to) break;
    const lo = Math.max(from, segStart);
    const hi = Math.min(to, segEnd);
    const segment = track.segments[i];
    const rendered = renderSegment(segment, segment.start + (lo - segStart), segment.start + (hi - segStart));
    rendered.forEach((block, c) => out[c].set(block, lo - from));
  }
  return out;
}

/** La pista como origen peresoso (para exportar con `encodeAudio`). */
export function trackSource(track: Track): PcmSource {
  const length = trackLength(track);
  return { sampleRate: track.sampleRate, numberOfChannels: track.channels, length, read: (start, end) => readTrack(track, start, end) };
}

/** Mayor valor absoluto en `[from, to)` (con ganancia y fundidos). */
export function peakInRange(track: Track, from: number, to: number): number {
  const a = clampFrame(track, Math.min(from, to));
  const b = clampFrame(track, Math.max(from, to));
  let peak = 0;
  const block = 1 << 16;
  for (let start = a; start < b; start += block) {
    for (const channel of readTrack(track, start, Math.min(b, start + block))) {
      for (let i = 0; i < channel.length; i += 1) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
    }
  }
  return peak;
}

/** Igual que `peakInRange`, pero cede el hilo entre bloques (audios largos) y respeta la cancelacion. */
export async function peakInRangeAsync(track: Track, from: number, to: number, signal?: AbortSignal): Promise<number> {
  const a = clampFrame(track, Math.min(from, to));
  const b = clampFrame(track, Math.max(from, to));
  let peak = 0;
  const block = 1 << 17;
  let blocks = 0;
  for (let start = a; start < b; start += block) {
    if (signal?.aborted) break;
    for (const channel of readTrack(track, start, Math.min(b, start + block))) {
      for (let i = 0; i < channel.length; i += 1) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
    }
    blocks += 1;
    if (blocks % 4 === 0) await yieldToBrowser();
  }
  return peak;
}

/** Envolvente para dibujar la onda: minimo y maximo por columna (mezcla de canales), muestreando como mucho ~48 puntos por columna. */
export function trackPeaks(track: Track, bins: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  const total = trackLength(track);
  if (total === 0 || bins <= 0) return { min, max };
  const starts = segmentStarts(track);
  let segmentIndex = 0;
  const gainAt = (segment: Segment, position: number) => {
    let gain = segment.gain;
    for (const ramp of segment.ramps) {
      if (position >= ramp.a && position < ramp.b) gain *= ramp.g0 + ((ramp.g1 - ramp.g0) * (position - ramp.a)) / (ramp.b - ramp.a);
    }
    return gain;
  };
  for (let bin = 0; bin < bins; bin += 1) {
    const from = Math.floor((bin * total) / bins);
    const to = Math.max(from + 1, Math.floor(((bin + 1) * total) / bins));
    const step = Math.max(1, Math.floor((to - from) / 48));
    let lo = Infinity;
    let hi = -Infinity;
    for (let frame = from; frame < to; frame += step) {
      while (segmentIndex > 0 && frame < starts[segmentIndex]) segmentIndex -= 1;
      while (segmentIndex < track.segments.length - 1 && frame >= starts[segmentIndex + 1]) segmentIndex += 1;
      const segment = track.segments[segmentIndex];
      const position = segment.start + (frame - starts[segmentIndex]);
      const gain = gainAt(segment, position);
      for (const channel of segment.source.channels) {
        const value = channel[position] * gain;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    min[bin] = lo === Infinity ? 0 : lo;
    max[bin] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

/* ------------------------------------------------------------------ *
 * Clips: importar, ordenar, quitar
 * ------------------------------------------------------------------ */

/** Ajusta un audio a la frecuencia y canales de la pista (sin copiar si ya coincide). */
export function conformAudio(audio: PcmAudio, sampleRate: number, channels: 1 | 2): PcmAudio {
  if (audio.sampleRate === sampleRate && audio.channels.length === channels) return audio;
  return readAll(resampleSource(remixSource(sourceOfAudio(audio), channels), sampleRate));
}

export type AppendResult = { track: Track; conformed: boolean };

/**
 * Anade un audio al final. El primero que entra fija la frecuencia y los canales de la pista (mono o estereo); los
 * siguientes se ajustan a ellos y `conformed` avisa de que hubo que convertirlos.
 */
export function appendClip(track: Track, audio: PcmAudio, name: string): AppendResult {
  let base = track;
  if (track.segments.length === 0) {
    base = { sampleRate: audio.sampleRate, channels: audio.channels.length >= 2 ? 2 : 1, segments: [] };
  }
  const conformed = audio.sampleRate !== base.sampleRate || (audio.channels.length >= 2 ? 2 : 1) !== base.channels || audio.channels.length > 2;
  const source = conformAudio(audio, base.sampleRate, base.channels);
  const length = frameCount(source);
  if (length === 0) return { track, conformed: false };
  const segment: Segment = { id: newSegmentId(), name, source, start: 0, end: length, gain: 1, ramps: [] };
  return { track: { ...base, segments: [...base.segments, segment] }, conformed: track.segments.length > 0 && conformed };
}

export function removeSegment(track: Track, index: number): Track {
  if (index < 0 || index >= track.segments.length) return track;
  return { ...track, segments: track.segments.filter((_, i) => i !== index) };
}

export function moveSegment(track: Track, from: number, to: number): Track {
  if (from === to || from < 0 || to < 0 || from >= track.segments.length || to >= track.segments.length) return track;
  const segments = [...track.segments];
  const [moved] = segments.splice(from, 1);
  segments.splice(to, 0, moved);
  return { ...track, segments };
}

/** Indice del segmento que contiene `frame` (el ultimo si esta al final). */
export function segmentIndexAt(track: Track, frame: number): number {
  const starts = segmentStarts(track);
  for (let i = 0; i < track.segments.length; i += 1) if (frame < starts[i + 1]) return i;
  return Math.max(0, track.segments.length - 1);
}

/* ------------------------------------------------------------------ *
 * Historial (deshacer / rehacer)
 * ------------------------------------------------------------------ */

export type History<T> = { past: readonly T[]; present: T; future: readonly T[] };

export const HISTORY_LIMIT = 100;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function commit<T>(history: History<T>, next: T): History<T> {
  if (next === history.present) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}
