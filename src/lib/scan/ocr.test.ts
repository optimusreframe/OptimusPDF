import { afterEach, describe, expect, it, vi } from "vitest";
import { OCR_IDLE_MS, SCAN_OCR_LANGUAGES, disposeSharedRecognizer, isOcrReady, setOcrRecognizerFactory, withRecognizer, type OcrRecognizer } from "@/lib/scan/ocr";

const fake = (log: string[] = []): OcrRecognizer => ({
  recognize: async (image) => {
    log.push(`read ${image.width}`);
    return { text: "hola", width: image.width, height: image.height, lines: [] };
  },
  dispose: async () => {
    log.push("dispose");
  },
});

afterEach(async () => {
  vi.useRealTimers();
  setOcrRecognizerFactory(null);
  await disposeSharedRecognizer();
});

describe("OCR compartido — src/lib/scan/ocr.ts", () => {
  it("es perezoso: no se crea hasta el primer uso y se reutiliza (un solo worker)", async () => {
    const factory = vi.fn(async () => fake());
    setOcrRecognizerFactory(factory);
    expect(isOcrReady()).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    await withRecognizer(async (r) => r.recognize({ data: new Uint8ClampedArray(4), width: 1, height: 1 }));
    await withRecognizer(async (r) => r.recognize({ data: new Uint8ClampedArray(4), width: 1, height: 1 }));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(isOcrReady()).toBe(true);
    expect(SCAN_OCR_LANGUAGES).toBe("spa+eng");
  });

  it("si crearlo falla, el error sale al llamador y el siguiente uso lo vuelve a intentar", async () => {
    let attempt = 0;
    setOcrRecognizerFactory(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("sin red para el idioma");
      return fake();
    });
    await expect(withRecognizer(async () => 1)).rejects.toThrow("sin red");
    expect(isOcrReady()).toBe(false);
    expect(await withRecognizer(async () => 2)).toBe(2);
    expect(attempt).toBe(2);
  });

  it("se libera solo tras un rato sin uso (memoria) y vuelve a crearse al necesitarlo", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const factory = vi.fn(async () => fake(log));
    setOcrRecognizerFactory(factory);
    await withRecognizer(async (r) => r.recognize({ data: new Uint8ClampedArray(4), width: 1, height: 1 }));
    expect(isOcrReady()).toBe(true);
    await vi.advanceTimersByTimeAsync(OCR_IDLE_MS - 1000);
    expect(isOcrReady()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(isOcrReady()).toBe(false);
    expect(log).toContain("dispose");
    await withRecognizer(async () => 0);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("cambiar la fabrica descarta el worker anterior", async () => {
    const log: string[] = [];
    setOcrRecognizerFactory(async () => fake(log));
    await withRecognizer(async () => 0);
    setOcrRecognizerFactory(async () => fake(log));
    await vi.waitFor(() => expect(log).toContain("dispose"));
    expect(isOcrReady()).toBe(false);
  });
});
