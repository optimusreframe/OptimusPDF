import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PcmSource } from "@/lib/media/audio/types";

/**
 * Caminos de fallo de `encodeMp3` con un `mediabunny` y un codificador FALSOS (el LAME real esta en `mp3.test.ts`): el
 * Worker que no arranca, el que nunca contesta, la cancelacion con un trozo en vuelo, los recursos que se sueltan siempre y
 * el tope de tamano. Nada de esto se puede provocar con el WASM real sin romper el paquete.
 */

const state = vi.hoisted(() => ({
  /** Que hace `add`: resuelve, rechaza con un error o no contesta nunca. */
  add: "resolve" as "resolve" | "never" | { reject: unknown },
  cancelled: 0,
  finalized: 0,
  closedSamples: 0,
  createdSamples: 0,
  added: 0,
  registered: 0,
}));

vi.mock("@mediabunny/mp3-encoder", () => ({ registerMp3Encoder: () => void (state.registered += 1) }));
vi.mock("mediabunny", () => {
  class BufferTarget {
    buffer: ArrayBuffer | null = new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer;
  }
  class Mp3OutputFormat {}
  class Output {
    constructor(public options: unknown) {}
    addAudioTrack() {}
    async start() {}
    async finalize() {
      state.finalized += 1;
    }
    async cancel() {
      state.cancelled += 1;
    }
  }
  class AudioSampleSource {
    constructor(public config: unknown) {}
    async add() {
      state.added += 1;
      if (state.add === "never") return new Promise<void>(() => {});
      if (state.add !== "resolve") throw state.add.reject;
    }
    close() {}
  }
  class AudioSample {
    constructor(public init: unknown) {
      state.createdSamples += 1;
    }
    close() {
      state.closedSamples += 1;
    }
  }
  return { AudioSample, AudioSampleSource, BufferTarget, Mp3OutputFormat, Output };
});

const { encodeMp3 } = await import("@/lib/media/audio/mp3");

const tone = (seconds: number, rate = 44100, channels = 1): PcmSource => ({
  sampleRate: rate,
  numberOfChannels: channels,
  length: Math.round(seconds * rate),
  read: (start, end) => Array.from({ length: channels }, () => new Float32Array(end - start)),
});

beforeEach(() => {
  Object.assign(state, { add: "resolve", cancelled: 0, finalized: 0, closedSamples: 0, createdSamples: 0, added: 0, registered: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("encodeMp3 · fallos", () => {
  it("camino feliz con el codificador falso: registra LAME, cierra CADA muestra, finaliza y devuelve audio/mpeg", async () => {
    const progress: number[] = [];
    const blob = await encodeMp3(tone(2.2), 128, undefined, (value) => progress.push(value));
    expect(blob.type).toBe("audio/mpeg");
    expect(state.registered).toBe(1);
    expect(state.createdSamples).toBeGreaterThanOrEqual(5); // 2,2 s en trozos de 0,5 s
    expect(state.closedSamples).toBe(state.createdSamples);
    expect(state.finalized).toBe(1);
    expect(state.cancelled).toBe(0);
    expect(progress.at(-1)).toBe(1);
  });

  it("un Worker que no se puede crear (SecurityError) antes del primer trozo: `encoderUnavailable`, suelta el codificador y cierra la muestra", async () => {
    state.add = { reject: new DOMException("bloqueado", "SecurityError") };
    await expect(encodeMp3(tone(1), 128)).rejects.toMatchObject({ code: "encoderUnavailable", detail: "mp3-init" });
    expect(state.cancelled).toBe(1);
    expect(state.closedSamples).toBe(state.createdSamples);
  });

  it("un error del WASM o del Worker (Error generico) antes del primer trozo tambien es `encoderUnavailable`", async () => {
    state.add = { reject: new Error("CompileError: WebAssembly.instantiate(): unsupported opcode") };
    await expect(encodeMp3(tone(1), 192)).rejects.toMatchObject({ code: "encoderUnavailable" });
  });

  it("sin memoria (RangeError) NO se confunde con un codificador bloqueado: `outOfMemory`", async () => {
    state.add = { reject: new RangeError("Array buffer allocation failed") };
    await expect(encodeMp3(tone(1), 192)).rejects.toMatchObject({ code: "outOfMemory" });
    expect(state.cancelled).toBe(1);
  });

  it("un Worker que nunca contesta se declara tras 45 s (`encoderUnavailable`) en vez de colgar la pantalla de progreso", async () => {
    vi.useFakeTimers();
    state.add = "never";
    const outcome = encodeMp3(tone(1), 128).then(
      () => "creado",
      (error: { code: string; detail?: string }) => `${error.code}:${error.detail}`,
    );
    await vi.advanceTimersByTimeAsync(44_000);
    expect(state.cancelled).toBe(0); // aun se espera
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(outcome).resolves.toBe("encoderUnavailable:mp3-timeout");
    expect(state.cancelled).toBe(1);
    expect(state.closedSamples).toBe(state.createdSamples);
  });

  it("cancelar con un trozo en vuelo corta ya (sin esperar al Worker), lanza `cancelled` y suelta el codificador", async () => {
    state.add = "never";
    const controller = new AbortController();
    const outcome = encodeMp3(tone(5), 128, controller.signal).then(
      () => "creado",
      (error: { code: string }) => error.code,
    );
    await vi.waitFor(() => expect(state.added).toBe(1));
    controller.abort();
    await expect(outcome).resolves.toBe("cancelled");
    expect(state.cancelled).toBe(1);
    expect(state.finalized).toBe(0);
    expect(state.closedSamples).toBe(state.createdSamples);
  });

  it("ya cancelado: no registra el codificador ni crea nada", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(encodeMp3(tone(1), 128, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(state.registered).toBe(0);
    expect(state.createdSamples).toBe(0);
  });

  it("un MP3 que pasaria de 1 GiB (~7 h a 320 kbps) se rechaza ANTES de leer una sola muestra: `tooLarge`", async () => {
    const read = vi.fn();
    const huge: PcmSource = { sampleRate: 44100, numberOfChannels: 2, length: 44100 * 3600 * 8, read };
    await expect(encodeMp3(huge, 320)).rejects.toMatchObject({ code: "tooLarge" });
    expect(read).not.toHaveBeenCalled();
    expect(state.registered).toBe(0);
  });

  it("mas de dos canales no se puede crear como MP3 (la capa de arriba ya remezcla; aqui se defiende)", async () => {
    await expect(encodeMp3(tone(1, 44100, 3), 128)).rejects.toMatchObject({ code: "encoderUnavailable" });
  });
});
