import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRequest, TaskResult } from "@/lib/scan/renderTasks";

const runTask = vi.fn(async (): Promise<TaskResult> => ({ kind: "sample", image: { data: new Uint8ClampedArray(4), width: 1, height: 1 } }));
vi.mock("@/lib/scan/renderTasks", () => ({ runTask: (...args: unknown[]) => (runTask as (...a: unknown[]) => unknown)(...args), clearTaskCache: () => {} }));

import { ScanCancelled, __resetScanWorkerStateForTests, disposeScanWorker, enqueueTask, renderStats, setScanWorkerFactory, warmScanWorker, workerSupported } from "@/lib/scan/renderBrowser";

/**
 * Cola de procesado: el worker que no carga (sin conexion) NO se da por muerto para siempre ni deja sin servicio al motor: el
 * hilo principal lo sustituye y, pasado un rato, se vuelve a probar el worker.
 */

const request: TaskRequest = { kind: "sample", source: new Blob([]), corners: null, rotation: 0, mode: "document", maxSide: 100 };

/** Worker de mentira que contesta a cada tarea con una imagen de 2 x 2. */
function fakeWorker(): Worker {
  const target = new EventTarget();
  const worker = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    postMessage(message: { id?: number }) {
      if (message.id === undefined) return;
      queueMicrotask(() => {
        const event = new Event("message") as Event & { data?: unknown };
        event.data = { id: message.id, ok: true, result: { kind: "sample", image: { data: new Uint8ClampedArray(16), width: 2, height: 2 } } };
        target.dispatchEvent(event);
      });
    },
    terminate: vi.fn(),
  };
  return worker as unknown as Worker;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 26, 12, 0, 0));
  runTask.mockClear();
  __resetScanWorkerStateForTests();
  setScanWorkerFactory(null);
});

afterEach(() => {
  setScanWorkerFactory(null);
  disposeScanWorker();
  vi.useRealTimers();
});

describe("cola de procesado — src/lib/scan/renderBrowser.ts", () => {
  it("si el worker no se puede crear (sin conexion al pedir su script) el hilo principal atiende la tarea y el fallo NO es para siempre", async () => {
    let creations = 0;
    let broken = true;
    setScanWorkerFactory(() => {
      creations += 1;
      if (broken) throw new Error("Failed to fetch worker script");
      return fakeWorker();
    });
    const before = renderStats();
    const first = await enqueueTask(request);
    expect(first.kind).toBe("sample");
    expect(renderStats().main).toBe(before.main + 1);
    expect(creations).toBe(1);
    // Mientras dura el enfriamiento no se vuelve a intentar (cada tarea no paga un fallo).
    await enqueueTask(request);
    expect(creations).toBe(1);
    expect(renderStats().main).toBe(before.main + 2);
    // Pasado el enfriamiento y con conexion otra vez, el worker vuelve a servir.
    broken = false;
    vi.setSystemTime(new Date(2026, 9, 26, 12, 0, 20));
    const third = await enqueueTask(request);
    expect(creations).toBe(2);
    expect(third.kind).toBe("sample");
    expect(renderStats().worker).toBe(before.worker + 1);
    expect(renderStats().main).toBe(before.main + 2);
  });

  it("un worker que arranca y muere (evento error) tampoco deja sin servicio: se atiende en el hilo principal y se reintenta mas tarde", async () => {
    let creations = 0;
    setScanWorkerFactory(() => {
      creations += 1;
      const worker = fakeWorker();
      const dying = {
        ...worker,
        addEventListener: worker.addEventListener.bind(worker),
        removeEventListener: worker.removeEventListener.bind(worker),
        postMessage: () => {
          queueMicrotask(() => worker.dispatchEvent(new Event("error")));
        },
        terminate: vi.fn(),
      };
      return creations === 1 ? (dying as unknown as Worker) : worker;
    });
    const before = renderStats();
    await enqueueTask(request);
    expect(renderStats().main).toBe(before.main + 1);
    vi.setSystemTime(new Date(2026, 9, 26, 12, 0, 30));
    await enqueueTask(request);
    expect(creations).toBe(2);
    expect(renderStats().worker).toBe(before.worker + 1);
  });

  it("warmScanWorker arranca el worker por adelantado una sola vez y nunca lanza (aunque la fabrica falle)", () => {
    let creations = 0;
    setScanWorkerFactory(() => {
      creations += 1;
      return fakeWorker();
    });
    warmScanWorker();
    warmScanWorker();
    expect(creations).toBe(1);
    disposeScanWorker();
    setScanWorkerFactory(() => {
      throw new Error("sin conexion");
    });
    expect(() => warmScanWorker()).not.toThrow();
    // Y tras el fallo no insiste hasta el enfriamiento.
    vi.setSystemTime(new Date(2026, 9, 26, 12, 0, 1));
    let again = 0;
    setScanWorkerFactory(() => {
      again += 1;
      return fakeWorker();
    });
    expect(workerSupported()).toBe(true);
    expect(again).toBe(0);
  });

  it("una tarea ya cancelada ni empieza", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(enqueueTask(request, controller.signal)).rejects.toBeInstanceOf(ScanCancelled);
    expect(runTask).not.toHaveBeenCalled();
  });
});
