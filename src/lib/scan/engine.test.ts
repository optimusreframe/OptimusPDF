import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCAN_ENGINE_TEST_HOOK,
  ScanEngineUnavailableError,
  analyzeFrame,
  buildPdf,
  createPage,
  defaultEngine,
  estimateSize,
  getScanEngine,
  isScanEngineAvailable,
  isScanEngineUnavailable,
  setScanEngine,
  splitSpread,
  unavailableEngine,
} from "@/lib/scan/engine";
import { DEFAULT_SCAN_SETTINGS, type FrameVerdict, type ScanPage } from "@/lib/scan/types";

/** Fachada del motor: sustituible con `setScanEngine`, con el gancho de pruebas y con el aviso «sin motor». */

const verdict: FrameVerdict = { quad: null, confidence: 0, stable: false, stableMs: 0, blurry: false, glare: false, dark: false, coverage: 0, hint: "no_document", shouldAutoCapture: false };
const frame = { data: new Uint8ClampedArray(320 * 240 * 4).fill(120), width: 320, height: 240 } as unknown as ImageData;

afterEach(() => {
  setScanEngine(null);
  delete (globalThis as Record<string, unknown>)[SCAN_ENGINE_TEST_HOOK];
});

describe("fachada del motor — src/lib/scan/engine.ts", () => {
  it("por defecto es el motor REAL: analyzeFrame y estimateSize son sincronos y funcionan sin cargar nada mas", () => {
    expect(isScanEngineAvailable()).toBe(true);
    expect(analyzeFrame(frame).hint).toBe("no_document");
    expect(estimateSize([], { preset: "balanced", searchable: false }).bytes).toBe(0);
    expect(getScanEngine().createPage).toBe(defaultEngine.createPage);
  });

  it("setScanEngine sustituye solo lo que trae; null restaura el real", async () => {
    const analyze = vi.fn(() => verdict);
    setScanEngine({ analyzeFrame: analyze });
    expect(analyzeFrame(frame, undefined, 5, { mode: "photo" })).toBe(verdict);
    expect(analyze).toHaveBeenCalledWith(frame, undefined, 5, { mode: "photo" });
    // Lo que no trae queda con el real.
    expect(getScanEngine().estimateSize).toBe(defaultEngine.estimateSize);
    setScanEngine(null);
    expect(analyzeFrame(frame).hint).toBe("no_document");
  });

  it("un motor falso entero atiende crear pagina, PDF y partir libro (lo que usa la interfaz en sus pruebas)", async () => {
    const fakePage = { id: "p-fake-1" } as ScanPage;
    const blob = new Blob(["%PDF"]);
    setScanEngine({
      createPage: async () => fakePage,
      buildPdf: async () => blob,
      splitSpread: async () => [fakePage, fakePage],
    });
    expect(await createPage(new Blob([]), { source: "camera", mode: "document", settings: DEFAULT_SCAN_SETTINGS })).toBe(fakePage);
    expect(await buildPdf({} as never, { preset: "balanced", pageSize: "a4", margin: "none" })).toBe(blob);
    expect(await splitSpread(fakePage)).toEqual([fakePage, fakePage]);
  });

  it("el gancho globalThis.__optimusScanEngine manda sobre lo instalado (E2E con un motor falso)", async () => {
    setScanEngine({ analyzeFrame: () => ({ ...verdict, hint: "ok" }) });
    (globalThis as Record<string, unknown>)[SCAN_ENGINE_TEST_HOOK] = {
      analyzeFrame(this: { marker: string }) {
        return { ...verdict, hint: this.marker === "hook" ? "glare" : "ok" };
      },
      marker: "hook",
      noEsUnaFuncion: 3,
    };
    expect(analyzeFrame(frame).hint).toBe("glare");
    // Un gancho vacio o con valores que no son funciones no cambia nada.
    (globalThis as Record<string, unknown>)[SCAN_ENGINE_TEST_HOOK] = { nada: 1 };
    expect(analyzeFrame(frame).hint).toBe("ok");
    (globalThis as Record<string, unknown>)[SCAN_ENGINE_TEST_HOOK] = "texto";
    expect(analyzeFrame(frame).hint).toBe("ok");
  });

  it("`unavailableEngine` lanza el aviso tipado que la interfaz sabe explicar", async () => {
    setScanEngine(unavailableEngine);
    expect(isScanEngineAvailable()).toBe(false);
    expect(() => analyzeFrame(frame)).toThrow(ScanEngineUnavailableError);
    await expect(createPage(new Blob([]), { source: "camera", mode: "document", settings: DEFAULT_SCAN_SETTINGS })).rejects.toMatchObject({ code: "engine-unavailable" });
    expect(() => estimateSize([], { preset: "balanced", searchable: false })).toThrow(/no esta instalado/);
    expect(isScanEngineUnavailable(new ScanEngineUnavailableError())).toBe(true);
    expect(isScanEngineUnavailable(new Error("otro"))).toBe(false);
    expect(isScanEngineUnavailable("texto")).toBe(false);
  });

  it("splitSpread sin ese metodo en el motor vigente rechaza con el aviso (es opcional en el contrato)", async () => {
    setScanEngine({ splitSpread: undefined });
    // El motor real si lo trae; uno que lo quite de verdad deja el rechazo tipado.
    const bare = { ...unavailableEngine, splitSpread: undefined } as unknown as Parameters<typeof setScanEngine>[0];
    setScanEngine(bare);
    await expect(splitSpread({} as ScanPage)).rejects.toBeInstanceOf(ScanEngineUnavailableError);
  });
});
