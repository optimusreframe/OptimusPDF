import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendClip, emptyTrack } from "@/lib/media/audio/edit";
import { TrackPlayer } from "@/lib/media/audio/player";
import { monoSine } from "@/lib/media/audio/testAudio";

type Scheduled = { start: number; frames: number; stopped: boolean };

function fakeContext() {
  const state = { currentTime: 0, scheduled: [] as Scheduled[], closed: false, resumed: 0 };
  const context = {
    get currentTime() {
      return state.currentTime;
    },
    state: "suspended" as AudioContextState,
    destination: {},
    resume: () => {
      state.resumed += 1;
      return Promise.resolve();
    },
    close: () => {
      state.closed = true;
      return Promise.resolve();
    },
    createBuffer: (channels: number, frames: number) => ({ numberOfChannels: channels, length: frames, copyToChannel: () => {} }),
    createBufferSource: () => {
      const entry: Scheduled = { start: 0, frames: 0, stopped: false };
      state.scheduled.push(entry);
      return {
        buffer: null as { length: number } | null,
        onended: null,
        connect() {},
        disconnect() {},
        start(when: number) {
          entry.start = when;
          entry.frames = this.buffer?.length ?? 0;
        },
        stop() {
          entry.stopped = true;
        },
      };
    },
  };
  return { state, context: context as unknown as AudioContext };
}

const track = appendClip(emptyTrack(1000, 1), monoSine(440, 10, 1000), "pista").track; // 10 s a 1 kHz

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TrackPlayer", () => {
  it("programa trozos de 0,5 s con ~1,5 s de margen, uno detras de otro sin huecos", () => {
    const { state, context } = fakeContext();
    const player = new TrackPlayer({ createContext: () => context });
    player.play(track, 0, 10000);
    expect(player.playing).toBe(true);
    expect(state.resumed).toBe(1);
    expect(state.scheduled.length).toBe(3); // se programa mientras falte menos de 1,5 s: 0,56 / 1,06 / 1,56
    state.scheduled.forEach((entry, i) => {
      expect(entry.frames).toBe(500);
      expect(entry.start).toBeCloseTo(0.06 + i * 0.5, 5);
    });
    state.currentTime = 1;
    vi.advanceTimersByTime(100);
    expect(state.scheduled.length).toBeGreaterThan(3);
    player.dispose();
  });

  it("la posicion avanza con el reloj del audio y se acota al final pedido", () => {
    const { state, context } = fakeContext();
    const player = new TrackPlayer({ createContext: () => context });
    player.play(track, 2000, 5000);
    state.currentTime = 0.06 + 1.25;
    expect(player.position()).toBe(3250);
    state.currentTime = 99;
    expect(player.position()).toBe(5000);
    player.dispose();
  });

  it("pausa: detiene los trozos programados y devuelve donde se quedo", () => {
    const { state, context } = fakeContext();
    const player = new TrackPlayer({ createContext: () => context });
    player.play(track, 0, 10000);
    state.currentTime = 0.06 + 2;
    expect(player.pause()).toBe(2000);
    expect(player.playing).toBe(false);
    expect(state.scheduled.every((entry) => entry.stopped)).toBe(true);
    const count = state.scheduled.length;
    vi.advanceTimersByTime(1000);
    expect(state.scheduled.length).toBe(count);
    expect(player.position()).toBe(2000);
  });

  it("al llegar al final avisa una sola vez y queda parado en el final", () => {
    const { state, context } = fakeContext();
    const onEnded = vi.fn();
    const player = new TrackPlayer({ createContext: () => context, onEnded });
    player.play(track, 0, 1200);
    state.currentTime = 0.06 + 1.2 + 0.01;
    vi.advanceTimersByTime(100);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
    expect(player.position()).toBe(1200);
    vi.advanceTimersByTime(1000);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("un rango vacio no suena; dispose cierra el contexto", () => {
    const { state, context } = fakeContext();
    const player = new TrackPlayer({ createContext: () => context });
    player.play(track, 500, 500);
    expect(player.playing).toBe(false);
    player.play(track, 0, 100);
    player.dispose();
    expect(state.closed).toBe(true);
  });
});
