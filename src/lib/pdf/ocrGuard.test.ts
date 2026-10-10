import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCR_STALL_MS, OcrStalledError, createOcrWorker, runWithStallGuard } from "@/lib/pdf/ocrGuard";

vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(),
  OEM: { LSTM_ONLY: 1 },
}));

describe("runWithStallGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resuelve con el resultado si el motor responde a tiempo", async () => {
    const value = runWithStallGuard(async () => "listo");
    await expect(value).resolves.toBe("listo");
  });

  it("rechaza con OcrStalledError (ocrNetworkFailure) tras 20 s sin ninguna señal", async () => {
    const outcome = runWithStallGuard(() => new Promise<string>(() => {})).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(OCR_STALL_MS + 600);
    const error = await outcome;
    expect(error).toBeInstanceOf(OcrStalledError);
    expect(error).toMatchObject({ code: "ocrNetworkFailure" });
  });

  it("una descarga lenta pero activa (touch periodico) NO se corta", async () => {
    let resolveStart: (value: string) => void = () => {};
    const outcome = runWithStallGuard((touch) => {
      const interval = setInterval(touch, 5_000);
      return new Promise<string>((resolve) => {
        resolveStart = (value) => {
          clearInterval(interval);
          resolve(value);
        };
      });
    });
    await vi.advanceTimersByTimeAsync(90_000);
    resolveStart("tarde pero bien");
    await expect(outcome).resolves.toBe("tarde pero bien");
  });

  it("si el motor llega despues de rendirse la guarda, se libera con dispose", async () => {
    let late: (value: string) => void = () => {};
    const dispose = vi.fn();
    const outcome = runWithStallGuard(() => new Promise<string>((resolve) => (late = resolve)), { dispose }).catch(() => "rendida");
    await vi.advanceTimersByTimeAsync(OCR_STALL_MS + 600);
    expect(await outcome).toBe("rendida");
    late("worker");
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledWith("worker");
  });

  it("cancelar rechaza al instante con 'cancelled' y una señal ya cancelada ni arranca", async () => {
    const controller = new AbortController();
    const start = vi.fn(() => new Promise<string>(() => {}));
    const outcome = runWithStallGuard(start, { signal: controller.signal }).catch((error: { code?: string }) => error.code);
    controller.abort();
    expect(await outcome).toBe("cancelled");

    const done = new AbortController();
    done.abort();
    const second = vi.fn(async () => "x");
    await expect(runWithStallGuard(second, { signal: done.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(second).not.toHaveBeenCalled();
  });
});

describe("createOcrWorker (compartido por ocr-pdf, PDF a texto/Word/Markdown, traducir y resumir)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const tesseract = await import("tesseract.js");
    vi.mocked(tesseract.createWorker).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const mock = async () => vi.mocked((await import("tesseract.js")).createWorker);

  it("CDN muda: falla a los 20 s con 'ocrNetworkFailure' y sin reintentar", async () => {
    const createWorker = await mock();
    createWorker.mockImplementation(() => new Promise(() => {}));
    const outcome = createOcrWorker("spa").catch((error: { code?: string }) => error.code);
    await vi.advanceTimersByTimeAsync(OCR_STALL_MS + 600);
    expect(await outcome).toBe("ocrNetworkFailure");
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("sin red (rechazo inmediato): un reintento y despues 'ocrNetworkFailure', no un error generico", async () => {
    const createWorker = await mock();
    createWorker.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(createOcrWorker("spa")).rejects.toMatchObject({ code: "ocrNetworkFailure" });
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it("un fallo del motor (no de red) se clasifica 'ocrEngineFailure'", async () => {
    const createWorker = await mock();
    createWorker.mockRejectedValue(new Error("RuntimeError: memory access out of bounds"));
    await expect(createOcrWorker("spa")).rejects.toMatchObject({ code: "ocrEngineFailure" });
  });

  it("un fallo transitorio se recupera en el reintento", async () => {
    const createWorker = await mock();
    const worker = { terminate: vi.fn(), recognize: vi.fn() };
    createWorker.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(worker as never);
    await expect(createOcrWorker("spa")).resolves.toBe(worker);
  });
});
