import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InkError,
  WORKER_MIN_PIXELS,
  extractInk,
  extractInkAsync,
  extractInkFromFile,
  setInkWorkerFactory,
  type ExtractResult,
  type InkImage,
} from "./inkExtract";
import type { InkWorkerRequest, InkWorkerResponse } from "./inkExtract.worker";
import { WARM_PAPER, composePhoto, drawSignature, nodeRasterizer, toPngFile } from "./inkTestUtils";

/**
 * Camino asincrono: trozos que ceden el control, cancelacion y Web Worker. En Node no hay `Worker`, asi que se prueba el
 * PROTOCOLO con un Worker falso que ejecuta el modulo REAL `inkExtract.worker.ts` (con un `self` falso). El worker de un
 * navegador de verdad se prueba en `e2e/specs/ink-extract.spec.ts`.
 */

function sample(width = 600, height = 220): InkImage {
  return composePhoto(drawSignature({ width, height, lineWidth: 4 }), { ink: { r: 10, g: 10, b: 40 }, paper: WARM_PAPER, noise: 2 });
}

const sameBytes = (a: ExtractResult, b: ExtractResult) => Buffer.from(a.image.data).equals(Buffer.from(b.image.data));

afterEach(() => {
  vi.unstubAllGlobals();
  setInkWorkerFactory(null);
});

describe("extractInkAsync · hilo principal por trozos", () => {
  it("da exactamente el mismo resultado que extractInk y no toca la entrada", async () => {
    const image = sample();
    const before = new Uint8ClampedArray(image.data);
    const sync = extractInk(image, { ink: "black" });
    const asynchronous = await extractInkAsync(image, { ink: "black" });
    expect(asynchronous).toEqual(sync);
    expect(sameBytes(asynchronous, sync)).toBe(true);
    expect(Buffer.from(image.data).equals(Buffer.from(before))).toBe(true);
  });

  it("cede el control al navegador muchas veces en una imagen grande (el tiempo por tarea se mide en el E2E, no aqui)", async () => {
    // Un limite de milisegundos seria inestable con la suite entera en paralelo: aqui solo se comprueba que hay MUCHOS
    // puntos de cesion (cada ~65 000 pixeles) y que ceder no cambia el resultado; `ink-extract.spec.ts` mide las tareas
    // largas reales (`PerformanceObserver`) en un navegador.
    let yields = 0;
    vi.stubGlobal("scheduler", {
      yield: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    const width = 2400;
    const height = 900;
    const image = composePhoto(drawSignature({ width, height, lineWidth: 8 }), { ink: { r: 0, g: 0, b: 0 }, noise: 1 });
    const result = await extractInkAsync(image, undefined, { budgetMs: 1 });
    expect(result.inkPixels).toBeGreaterThan(1000);
    expect(yields).toBeGreaterThan(8);
    expect(sameBytes(result, extractInk(image))).toBe(true);
  });

  it("sin scheduler.yield usa setTimeout y sigue funcionando", async () => {
    vi.stubGlobal("scheduler", undefined);
    const image = sample(900, 300);
    expect(sameBytes(await extractInkAsync(image, undefined, { budgetMs: 1 }), extractInk(image))).toBe(true);
  });

  it("un error del motor llega como InkError (no hay tinta) y una entrada invalida falla antes de empezar", async () => {
    const blank = { width: 100, height: 40, data: new Uint8ClampedArray(100 * 40 * 4).fill(255) };
    await expect(extractInkAsync(blank)).rejects.toMatchObject({ code: "no-ink" });
    await expect(extractInkAsync({ width: 0, height: 5, data: new Uint8ClampedArray(0) })).rejects.toMatchObject({ code: "invalid-image" });
    await expect(extractInkAsync({ width: 30_000, height: 30_000, data: new Uint8ClampedArray(4) })).rejects.toMatchObject({ code: "too-many-pixels" });
  });

  it("AbortSignal: ya cancelada no empieza; cancelada a mitad, se detiene con «aborted»", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractInkAsync(sample(), undefined, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    const midway = new AbortController();
    vi.stubGlobal("scheduler", { yield: () => { midway.abort(); return Promise.resolve(); } });
    await expect(extractInkAsync(sample(1200, 400), undefined, { signal: midway.signal, budgetMs: 1 })).rejects.toBeInstanceOf(InkError);
    await expect(extractInkAsync(sample(1200, 400), undefined, { signal: midway.signal, budgetMs: 1 })).rejects.toMatchObject({ code: "aborted" });
  });

  it("extractInkFromFile: archivo -> tinta en un paso", async () => {
    const file = toPngFile(sample(400, 150));
    const result = await extractInkFromFile(file, { ink: "blue" }, undefined, { rasterizer: nodeRasterizer });
    expect(result.inkPixels).toBeGreaterThan(500);
    await expect(extractInkFromFile(new File(["no soy una imagen"], "x.png"), undefined, undefined, { rasterizer: nodeRasterizer })).rejects.toMatchObject({
      code: "unsupported-format",
    });
  });
});

describe("extractInkAsync · Web Worker (protocolo con el modulo real del worker)", () => {
  type WorkerHandle = {
    onmessage: ((event: MessageEvent<InkWorkerResponse>) => void) | null;
    onerror: ((event: { preventDefault?: () => void }) => void) | null;
    onmessageerror: (() => void) | null;
    postMessage: (message: InkWorkerRequest) => void;
    terminate: () => void;
  };

  let scope: { onmessage: ((event: { data: InkWorkerRequest }) => void) | null; postMessage: ReturnType<typeof vi.fn> };
  let created: WorkerHandle[];
  let terminated: number;

  beforeEach(async () => {
    created = [];
    terminated = 0;
    scope = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("Worker", class {});
    vi.resetModules();
    await import("./inkExtract.worker");
  });

  function fakeWorker(): WorkerHandle {
    const worker: WorkerHandle = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminate: () => {
        terminated += 1;
      },
      postMessage: (message) => {
        // Cada mensaje se resuelve en la tarea siguiente, como un worker de verdad.
        setTimeout(() => {
          scope.postMessage.mockImplementationOnce((response: InkWorkerResponse) => {
            worker.onmessage?.({ data: response } as MessageEvent<InkWorkerResponse>);
          });
          scope.onmessage?.({ data: message });
        }, 0);
      },
    };
    created.push(worker);
    return worker;
  }

  it("worker: «always» envia la imagen y recibe el MISMO resultado byte a byte (y el worker se termina)", async () => {
    const mod = await import("./inkExtract");
    mod.setInkWorkerFactory(() => fakeWorker() as unknown as Worker);
    const image = sample();
    const result = await mod.extractInkAsync(image, { ink: "blue" }, { worker: "always" });
    expect(created).toHaveLength(1);
    expect(terminated).toBe(1);
    expect(sameBytes(result, extractInk(image, { ink: "blue" }))).toBe(true);
    // El resultado viaja con su buffer por transferencia desde el worker.
    expect(scope.postMessage.mock.calls[0][1]).toHaveLength(1);
  });

  it("worker: por defecto solo se usa por encima de 4 MP", async () => {
    const mod = await import("./inkExtract");
    mod.setInkWorkerFactory(() => fakeWorker() as unknown as Worker);
    await mod.extractInkAsync(sample(), undefined);
    expect(created).toHaveLength(0);
    await mod.extractInkAsync(sample(), undefined, { worker: "never" });
    expect(created).toHaveLength(0);
    expect(WORKER_MIN_PIXELS).toBe(4_000_000);
    const width = 2600;
    const height = 1600; // 4,16 MP
    expect(width * height).toBeGreaterThan(WORKER_MIN_PIXELS);
    const big = composePhoto(drawSignature({ width, height, lineWidth: 12 }), { ink: { r: 0, g: 0, b: 0 } });
    const viaWorker = await mod.extractInkAsync(big, { crop: "none", maxDimension: 600 });
    expect(created).toHaveLength(1);
    expect(sameBytes(viaWorker, extractInk(big, { crop: "none", maxDimension: 600 }))).toBe(true);
  });

  it("worker: un error del motor llega como InkError con su codigo", async () => {
    const mod = await import("./inkExtract");
    mod.setInkWorkerFactory(() => fakeWorker() as unknown as Worker);
    const blank = { width: 100, height: 40, data: new Uint8ClampedArray(100 * 40 * 4).fill(255) };
    await expect(mod.extractInkAsync(blank, undefined, { worker: "always" })).rejects.toMatchObject({ code: "no-ink" });
    expect(terminated).toBe(1);
  });

  it("worker: si no puede arrancar (excepcion, error de carga o mensaje roto) se cae al hilo principal con el mismo resultado", async () => {
    const mod = await import("./inkExtract");
    const image = sample();
    const expected = extractInk(image);
    mod.setInkWorkerFactory(() => {
      throw new Error("CSP");
    });
    expect(sameBytes(await mod.extractInkAsync(image, undefined, { worker: "always" }), expected)).toBe(true);
    mod.setInkWorkerFactory(() => {
      const worker = fakeWorker();
      worker.postMessage = () => setTimeout(() => worker.onerror?.({ preventDefault: () => {} }), 0);
      return worker as unknown as Worker;
    });
    expect(sameBytes(await mod.extractInkAsync(image, undefined, { worker: "always" }), expected)).toBe(true);
    mod.setInkWorkerFactory(() => {
      const worker = fakeWorker();
      worker.postMessage = () => setTimeout(() => worker.onmessageerror?.(), 0);
      return worker as unknown as Worker;
    });
    expect(sameBytes(await mod.extractInkAsync(image, undefined, { worker: "always" }), expected)).toBe(true);
    mod.setInkWorkerFactory(() => {
      const worker = fakeWorker();
      worker.postMessage = () => {
        throw new Error("DataCloneError");
      };
      return worker as unknown as Worker;
    });
    expect(sameBytes(await mod.extractInkAsync(image, undefined, { worker: "always" }), expected)).toBe(true);
    // Sin `Worker` en el entorno tambien.
    vi.stubGlobal("Worker", undefined);
    expect(sameBytes(await mod.extractInkAsync(image, undefined, { worker: "always" }), expected)).toBe(true);
  });

  it("worker: cancelar mientras trabaja termina el worker y rechaza con «aborted»", async () => {
    const mod = await import("./inkExtract");
    mod.setInkWorkerFactory(() => {
      const worker = fakeWorker();
      worker.postMessage = () => {}; // nunca responde
      return worker as unknown as Worker;
    });
    const controller = new AbortController();
    const pending = mod.extractInkAsync(sample(), undefined, { worker: "always", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(terminated).toBe(1);
  });

  it("el worker real responde con error de motor desconocido como decode-failed", async () => {
    scope.postMessage.mockClear();
    scope.onmessage?.({ data: { id: 9, image: null as unknown as InkImage } });
    expect(scope.postMessage).toHaveBeenCalledTimes(1);
    expect(scope.postMessage.mock.calls[0][0]).toMatchObject({ id: 9, ok: false, code: "invalid-image" });
    scope.postMessage.mockClear();
    scope.onmessage?.({ data: { id: 10, image: sample(50, 20), options: { ink: { r: 1, g: 2, b: 3 }, threshold: "bad" as unknown as number } } });
    expect(scope.postMessage.mock.calls[0][0]).toMatchObject({ id: 10, ok: false });
  });
});
