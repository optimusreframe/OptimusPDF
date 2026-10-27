import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThumbnailBlob, getThumbnailInfo, makeThumbnailInfo, setThumbnailWorkerFactory } from "@/lib/image/thumbnail";
import { beginHeavyWork } from "@/lib/image/heavyWork";
import { makeSyntheticJpeg } from "@/lib/image/photoTestUtils";
import type { ThumbnailWorkerRequest, ThumbnailWorkerResponse } from "@/lib/image/thumbnail.worker";

/**
 * Las miniaturas y la comprobacion de cada foto van a un Web Worker (fuera del hilo principal); si no hay worker o falla,
 * se hacen en el hilo principal. Aqui el worker es de mentira: una clase que responde con lo que diga `reply`.
 */

const jpegBlob = (seed = 1): Blob => new Blob([new Uint8Array(makeSyntheticJpeg({ width: 300, height: 200, seed }))], { type: "image/jpeg" });

type Reply = (request: ThumbnailWorkerRequest) => ThumbnailWorkerResponse | "error" | "silent";

class FakeWorker {
  static created: FakeWorker[] = [];
  static reply: Reply = (request) => ({ id: request.id, ok: true, blob: new Blob(["t"]), problem: null, heic: false });
  static handled: ThumbnailWorkerRequest[] = [];
  terminated = false;
  private listeners = { message: new Set<(event: MessageEvent<ThumbnailWorkerResponse>) => void>(), error: new Set<() => void>() };
  constructor() {
    FakeWorker.created.push(this);
  }
  addEventListener(type: "message" | "error", listener: never): void {
    (this.listeners[type] as Set<unknown>).add(listener);
  }
  removeEventListener(type: "message" | "error", listener: never): void {
    (this.listeners[type] as Set<unknown>).delete(listener);
  }
  postMessage(request: ThumbnailWorkerRequest): void {
    FakeWorker.handled.push(request);
    const answer = FakeWorker.reply(request);
    setTimeout(() => {
      if (answer === "silent") return;
      if (answer === "error") this.listeners.error.forEach((listener) => listener());
      else this.listeners.message.forEach((listener) => listener({ data: answer } as MessageEvent<ThumbnailWorkerResponse>));
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.created = [];
  FakeWorker.handled = [];
  FakeWorker.reply = (request) => ({ id: request.id, ok: true, blob: new Blob(["t"]), problem: null, heic: false });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => {
    throw new Error("sin decodificador en Node");
  }));
  setThumbnailWorkerFactory(() => new FakeWorker() as unknown as Worker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setThumbnailWorkerFactory(null, { disabled: true });
});

describe("miniaturas en un worker", () => {
  it("la foto va al worker (el Blob por referencia) y su miniatura vuelve; la misma foto no se procesa dos veces", async () => {
    const file = jpegBlob();
    const info = await getThumbnailInfo(file);
    expect(info.problem).toBeNull();
    expect(info.blob?.size).toBeGreaterThan(0);
    expect(FakeWorker.handled).toHaveLength(1);
    expect(FakeWorker.handled[0].source).toBe(file);
    expect(FakeWorker.handled[0].side).toBe(360);
    await getThumbnailInfo(file);
    expect(await getThumbnailBlob(file)).toBe(info.blob);
    expect(FakeWorker.handled).toHaveLength(1);
  });

  it("un problema de estructura detectado por el worker se devuelve tal cual, sin pasar al hilo principal", async () => {
    FakeWorker.reply = (request) => ({ id: request.id, ok: true, blob: null, problem: "truncated", heic: false });
    const decoder = vi.mocked(globalThis.createImageBitmap);
    const info = await getThumbnailInfo(jpegBlob(2));
    expect(info).toEqual({ blob: null, problem: "truncated" });
    expect(decoder).not.toHaveBeenCalled();
  });

  it("si el worker falla o no puede decodificar, se prueba en el hilo principal antes de dar la foto por mala", async () => {
    FakeWorker.reply = (request) => ({ id: request.id, ok: true, blob: null, problem: null, heic: false });
    const decoder = vi.mocked(globalThis.createImageBitmap);
    const info = await getThumbnailInfo(jpegBlob(3));
    expect(decoder).toHaveBeenCalled(); // el respaldo del hilo principal lo intento
    expect(info).toEqual({ blob: null, problem: null });
  });

  it("un worker que da error se descarta para siempre y el trabajo sigue en el hilo principal", async () => {
    FakeWorker.reply = () => "error";
    const first = await getThumbnailInfo(jpegBlob(4));
    expect(first.problem).toBeNull();
    const decoder = vi.mocked(globalThis.createImageBitmap);
    decoder.mockClear();
    await getThumbnailInfo(jpegBlob(5));
    expect(FakeWorker.created).toHaveLength(1); // no se vuelve a crear
    expect(FakeWorker.created[0].terminated).toBe(true);
    expect(decoder).toHaveBeenCalled();
  });

  it("HEIC que ni el worker ni el hilo principal pueden abrir se marca «heic»; un JPEG ilegible NO (puede que <img> si lo abra)", async () => {
    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 24], 0);
    heic.set(new TextEncoder().encode("ftypheic"), 4);
    FakeWorker.reply = (request) => ({ id: request.id, ok: true, blob: null, problem: null, heic: true });
    expect(await getThumbnailInfo(new Blob([heic]))).toEqual({ blob: null, problem: "heic" });
    expect(await getThumbnailInfo(jpegBlob(6))).toEqual({ blob: null, problem: null });
  });

  it("sin worker (desactivado) todo ocurre en el hilo principal", async () => {
    setThumbnailWorkerFactory(null, { disabled: true });
    const info = await makeThumbnailInfo(new Blob([new TextEncoder().encode("esto no es una imagen".repeat(10))]));
    expect(info).toEqual({ blob: null, problem: "notImage" });
    expect(FakeWorker.created).toHaveLength(0);
  });

  it("las miniaturas esperan mientras se preparan las fotos del PDF (nunca dos decodificaciones grandes a la vez)", async () => {
    const end = beginHeavyWork();
    let done = false;
    const pending = getThumbnailInfo(jpegBlob(7)).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(FakeWorker.handled).toHaveLength(0);
    end();
    await pending;
    expect(done).toBe(true);
  });

  it("las fotos se procesan de una en una y en el orden en que se pidieron", async () => {
    const order: number[] = [];
    FakeWorker.reply = (request) => {
      order.push(request.id);
      return { id: request.id, ok: true, blob: new Blob(["t"]), problem: null, heic: false };
    };
    await Promise.all([1, 2, 3, 4].map((seed) => getThumbnailInfo(jpegBlob(seed))));
    expect(FakeWorker.handled).toHaveLength(4);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("el worker se cierra tras unos segundos sin trabajo (libera su memoria)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = getThumbnailInfo(jpegBlob(8));
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    const worker = FakeWorker.created[0];
    expect(worker.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(4100);
    expect(worker.terminated).toBe(true);
  });
});
