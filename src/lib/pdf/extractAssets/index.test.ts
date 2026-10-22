import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTRACT_ENGINE_TEST_HOOK,
  ExtractUnavailableError,
  cropRegion,
  defaultEngine,
  extractAssets,
  getExtractEngine,
  isExtractEngineAvailable,
  isExtractUnavailable,
  renderAsset,
  setExtractEngine,
  unavailableEngine,
} from "@/lib/pdf/extractAssets";
import { cropRegion as realCropRegion } from "@/lib/pdf/extractAssets/region";
import type { ExtractResult, ExtractedAsset } from "@/lib/pdf/extractAssets/types";

/** Fachada del motor (`index.ts`): por defecto el orquestador REAL con el recorte real; `unavailableEngine` prueba el aviso «sin motor»; se sustituye con `setExtractEngine`; el gancho de pruebas manda. */

const RESULT: ExtractResult = { pageCount: 1, assets: [], scannedPages: [], warnings: [], truncated: false };
const file = new Uint8Array([1, 2, 3]);

afterEach(() => {
  setExtractEngine(null);
  delete (globalThis as Record<string, unknown>)[EXTRACT_ENGINE_TEST_HOOK];
});

describe("motor por defecto", () => {
  it("es el orquestador REAL (no el de «sin motor») y la deteccion esta disponible", () => {
    expect(isExtractEngineAvailable()).toBe(true);
    expect(getExtractEngine().extractAssets).toBe(defaultEngine.extractAssets);
    expect(getExtractEngine().extractAssets).not.toBe(unavailableEngine.extractAssets);
    expect(getExtractEngine().renderAsset).not.toBe(unavailableEngine.renderAsset);
  });

  it("extractAssets real: un archivo vacio rechaza con PdfError «empty» (se carga el orquestador bajo demanda)", async () => {
    await expect(extractAssets(new Uint8Array(0))).rejects.toMatchObject({ name: "PdfError", code: "empty" });
  });

  it("renderAsset real: un elemento sin formatos rechaza con un codigo claro", async () => {
    await expect(renderAsset(file, { formats: [], ref: { engine: "image", objectId: "x", pageIndex: 0 } } as unknown as ExtractedAsset)).rejects.toMatchObject({ name: "ExtractRenderError", code: "no-formats" });
  });

  it("cropRegion es el real (el de region.ts)", () => {
    expect(defaultEngine.cropRegion).toBe(realCropRegion);
    expect(unavailableEngine.cropRegion).toBe(realCropRegion);
    expect(getExtractEngine().cropRegion).toBe(realCropRegion);
  });
});

describe("motor «sin motor» (unavailableEngine)", () => {
  it("extractAssets y renderAsset lanzan un error claro y reconocible; el recorte sigue siendo real", async () => {
    setExtractEngine(unavailableEngine);
    expect(isExtractEngineAvailable()).toBe(false);
    await expect(extractAssets(file)).rejects.toBeInstanceOf(ExtractUnavailableError);
    await expect(renderAsset(file, {} as ExtractedAsset)).rejects.toMatchObject({ code: "engine-unavailable", name: "ExtractUnavailableError" });
    const error = await extractAssets(file).catch((caught: unknown) => caught);
    expect(isExtractUnavailable(error)).toBe(true);
    expect(isExtractUnavailable(new Error("otro"))).toBe(false);
    expect(isExtractUnavailable("texto")).toBe(false);
    expect((error as Error).message.length).toBeGreaterThan(10);
    expect(getExtractEngine().cropRegion).toBe(realCropRegion);
  });
});

describe("setExtractEngine", () => {
  it("instala la implementacion y conserva la real de lo que no trae", async () => {
    const extract = vi.fn(async () => RESULT);
    setExtractEngine({ extractAssets: extract });
    const options = { maxPages: 5 };
    await expect(extractAssets(file, options)).resolves.toBe(RESULT);
    expect(extract).toHaveBeenCalledWith(file, options);
    // `renderAsset` sigue siendo el real.
    expect(getExtractEngine().renderAsset).toBe(defaultEngine.renderAsset);
    expect(getExtractEngine().cropRegion).toBe(realCropRegion);
  });

  it("la API completa sustituye tambien el recorte", async () => {
    const crop = vi.fn(async () => ({ png: new Blob(), width: 1, height: 1 }));
    setExtractEngine({ extractAssets: async () => RESULT, renderAsset: async () => new Blob(), cropRegion: crop });
    await cropRegion(file, 2, { x: 0, y: 0, width: 1, height: 1 }, { dpi: 600 });
    expect(crop).toHaveBeenCalledWith(file, 2, { x: 0, y: 0, width: 1, height: 1 }, { dpi: 600 });
  });

  it("null restaura la de por defecto (la real)", async () => {
    setExtractEngine({ extractAssets: async () => RESULT });
    setExtractEngine(null);
    expect(getExtractEngine().extractAssets).toBe(defaultEngine.extractAssets);
    await expect(extractAssets(new Uint8Array(0))).rejects.toMatchObject({ code: "empty" });
  });
});

describe("gancho de pruebas (__optimusExtractEngine)", () => {
  it("manda sobre lo instalado, solo con las funciones que trae", async () => {
    const installed = vi.fn(async () => RESULT);
    setExtractEngine({ extractAssets: installed, renderAsset: async () => new Blob(["instalado"]) });
    const hooked = vi.fn(async () => ({ ...RESULT, pageCount: 9 }));
    (globalThis as Record<string, unknown>)[EXTRACT_ENGINE_TEST_HOOK] = { extractAssets: hooked, nada: 1 };
    await expect(extractAssets(file)).resolves.toMatchObject({ pageCount: 9 });
    expect(installed).not.toHaveBeenCalled();
    expect(await (await renderAsset(file, {} as ExtractedAsset)).text()).toBe("instalado");
  });

  it("se lee en cada llamada (se puede definir despues) y se ignora si no es un objeto con funciones", async () => {
    setExtractEngine(unavailableEngine);
    (globalThis as Record<string, unknown>)[EXTRACT_ENGINE_TEST_HOOK] = "no soy un motor";
    await expect(extractAssets(file)).rejects.toBeInstanceOf(ExtractUnavailableError);
    (globalThis as Record<string, unknown>)[EXTRACT_ENGINE_TEST_HOOK] = { extractAssets: "tampoco" };
    await expect(extractAssets(file)).rejects.toBeInstanceOf(ExtractUnavailableError);
    (globalThis as Record<string, unknown>)[EXTRACT_ENGINE_TEST_HOOK] = { extractAssets: async () => RESULT };
    await expect(extractAssets(file)).resolves.toBe(RESULT);
  });

  it("las funciones del gancho se llaman con el propio gancho como `this`", async () => {
    const hook = { calls: 0, async extractAssets(this: { calls: number }) { this.calls += 1; return RESULT; } };
    (globalThis as Record<string, unknown>)[EXTRACT_ENGINE_TEST_HOOK] = hook;
    await extractAssets(file);
    expect(hook.calls).toBe(1);
  });
});
