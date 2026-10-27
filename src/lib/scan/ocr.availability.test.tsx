import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeSharedRecognizer, ocrModelAvailable, prepareOcrModel, setOcrRecognizerFactory, withRecognizer, type OcrRecognizer } from "@/lib/scan/ocr";

/**
 * El OCR NO se usa por defecto (100 % local): solo si el modelo ya esta en el dispositivo (datos de idioma en la cache de
 * tesseract.js) o por accion explicita (`prepareOcrModel`). Entorno jsdom + fake-indexeddb (IndexedDB de pruebas).
 */

const fake = (): OcrRecognizer => ({ recognize: async (image) => ({ text: "", width: image.width, height: image.height, lines: [] }), dispose: async () => {} });

/** Crea la base `keyval-store` de tesseract.js con las claves de idioma dadas. */
async function seedTesseractCache(keys: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("keyval-store");
    request.onupgradeneeded = () => request.result.createObjectStore("keyval");
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("keyval", "readwrite");
      for (const key of keys) tx.objectStore("keyval").put(new Uint8Array([1, 2, 3]), key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dropTesseractCache(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("keyval-store");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await dropTesseractCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setOcrRecognizerFactory(null);
  await disposeSharedRecognizer();
});

describe("disponibilidad del modelo de OCR — src/lib/scan/ocr.ts", () => {
  it("sin cache de tesseract.js NO esta disponible y no se abre ninguna base", async () => {
    const open = vi.spyOn(indexedDB, "open");
    expect(await ocrModelAvailable()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("sin la cache de tesseract.js: no esta disponible y NO se crea la base (abrir una inexistente la romperia)", async () => {
    expect(await ocrModelAvailable()).toBe(false);
    const names = (await indexedDB.databases()).map((db) => db.name);
    expect(names).not.toContain("keyval-store");
  });

  it("con los datos de espanol e ingles en la cache: disponible; si falta un idioma, no", async () => {
    await seedTesseractCache(["./spa.traineddata", "./eng.traineddata"]);
    expect(await ocrModelAvailable()).toBe(true);
    await dropTesseractCache();
    await seedTesseractCache(["./spa.traineddata"]);
    expect(await ocrModelAvailable()).toBe(false);
  });

  it("navegador sin indexedDB.databases(): no se arriesga a crear la base y da el modelo por NO disponible", async () => {
    await seedTesseractCache(["./spa.traineddata", "./eng.traineddata"]);
    const original = (indexedDB as { databases?: unknown }).databases;
    (indexedDB as { databases?: unknown }).databases = undefined;
    try {
      expect(await ocrModelAvailable()).toBe(false);
    } finally {
      (indexedDB as { databases?: unknown }).databases = original;
    }
  });

  it("un reconocedor ya cargado cuenta como disponible", async () => {
    setOcrRecognizerFactory(async () => fake());
    await withRecognizer(async () => 0);
    expect(await ocrModelAvailable()).toBe(true);
  });

  it("prepareOcrModel sin conexion no intenta nada (ni crea el worker) y lo dice", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    const factory = vi.fn(async () => fake());
    setOcrRecognizerFactory(factory);
    expect(await prepareOcrModel()).toEqual({ ok: false, reason: "offline" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("prepareOcrModel: resultado tipado para exito, fallo de red, fallo del motor y cancelacion (nunca lanza)", async () => {
    setOcrRecognizerFactory(async () => fake());
    expect(await prepareOcrModel()).toEqual({ ok: true });
    await disposeSharedRecognizer();
    setOcrRecognizerFactory(async () => {
      throw Object.assign(new Error("CDN inalcanzable"), { code: "ocrNetworkFailure" });
    });
    expect(await prepareOcrModel()).toEqual({ ok: false, reason: "network" });
    setOcrRecognizerFactory(async () => {
      throw new Error("wasm roto");
    });
    expect(await prepareOcrModel()).toEqual({ ok: false, reason: "engine" });
    const controller = new AbortController();
    controller.abort();
    setOcrRecognizerFactory(async () => {
      throw new Error("abortado");
    });
    expect(await prepareOcrModel({ signal: controller.signal })).toEqual({ ok: false, reason: "cancelled" });
  });

  it("mientras se crea el worker, un `error` del navegador (script de la CDN que no carga) NO queda sin capturar", async () => {
    let event: ErrorEvent | null = null;
    setOcrRecognizerFactory(async () => {
      event = new ErrorEvent("error", { cancelable: true, message: "NetworkError: importScripts failed" });
      window.dispatchEvent(event);
      throw Object.assign(new Error("fallo"), { code: "ocrNetworkFailure" });
    });
    expect(await prepareOcrModel()).toEqual({ ok: false, reason: "network" });
    expect((event as unknown as ErrorEvent).defaultPrevented).toBe(true);
  });
});
