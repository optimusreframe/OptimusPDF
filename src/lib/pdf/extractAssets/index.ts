import { cropRegion as defaultCropRegion } from "@/lib/pdf/extractAssets/region";
import type { ExtractAssetsApi } from "@/lib/pdf/extractAssets/types";

export * from "@/lib/pdf/extractAssets/types";

/**
 * Fachada de la herramienta «Extraer elementos» (F7): la interfaz importa SIEMPRE de aqui (`@/lib/pdf/extractAssets`).
 *
 * Por defecto la implementacion es la REAL (U7.3, `orchestrate.ts`): motor de imagenes, de anotaciones/sellos/marcas de agua,
 * clasificador heuristico y recorte manual, todo con pdf.js en el navegador y sin red. El orquestador se carga bajo demanda
 * (`import()`): solo pesa cuando se usa la herramienta.
 *
 * Se puede sustituir con `setExtractEngine({ extractAssets, renderAsset, cropRegion })` (lo que falte conserva la implementacion
 * real; `setExtractEngine(null)` la restaura) y `unavailableEngine` sigue exportado para probar el aviso «sin motor»
 * (`ExtractUnavailableError`) que la interfaz sabe explicar.
 *
 * Gancho de pruebas: si existe `globalThis.__optimusExtractEngine` (un objeto con alguna de las tres funciones), SUS
 * funciones mandan sobre las instaladas. Lo usan los E2E para inyectar el motor falso (`testing/fakeEngine.ts`) en la
 * build de produccion sin anadir rutas de prueba. En produccion nadie lo define: es inerte.
 */

export const EXTRACT_ENGINE_TEST_HOOK = "__optimusExtractEngine";

/** La deteccion automatica no esta disponible (se sustituyo por `unavailableEngine` o el motor instalado la rechaza): la interfaz lo explica y deja el recorte manual. */
export class ExtractUnavailableError extends Error {
  readonly code = "engine-unavailable";
  constructor(message = "El motor de extraccion no esta instalado") {
    super(message);
    this.name = "ExtractUnavailableError";
  }
}

export function isExtractUnavailable(error: unknown): error is ExtractUnavailableError {
  return error instanceof Error && (error as { code?: unknown }).code === "engine-unavailable";
}

const unavailable = (): Promise<never> => Promise.reject(new ExtractUnavailableError());

/** Sin deteccion automatica y con el recorte manual real (para probar el aviso «sin motor» de la interfaz). */
export const unavailableEngine: ExtractAssetsApi = {
  extractAssets: unavailable,
  renderAsset: unavailable,
  cropRegion: defaultCropRegion,
};

/** Implementacion por defecto: el orquestador real (cargado al primer uso) y el recorte manual real. */
export const defaultEngine: ExtractAssetsApi = {
  extractAssets: async (file, options) => (await import("@/lib/pdf/extractAssets/orchestrate")).extractAssets(file, options),
  renderAsset: async (file, asset, format) => (await import("@/lib/pdf/extractAssets/orchestrate")).renderAsset(file, asset, format),
  cropRegion: defaultCropRegion,
};

let installed: Partial<ExtractAssetsApi> | null = null;

/** Instala (o, con `null`, retira) la implementacion real. Lo que no traiga conserva la de por defecto. */
export function setExtractEngine(api: Partial<ExtractAssetsApi> | null): void {
  installed = api;
}

const METHODS = ["extractAssets", "renderAsset", "cropRegion"] as const;

function testHook(): Partial<ExtractAssetsApi> | null {
  const hook = (globalThis as Record<string, unknown>)[EXTRACT_ENGINE_TEST_HOOK];
  if (!hook || typeof hook !== "object") return null;
  const picked: Partial<ExtractAssetsApi> = {};
  for (const method of METHODS) {
    const candidate = (hook as Record<string, unknown>)[method];
    if (typeof candidate === "function") {
      (picked as Record<string, unknown>)[method] = (candidate as (...args: unknown[]) => unknown).bind(hook);
    }
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

/** Motor vigente: real por defecto < instalado < gancho de pruebas. */
export function getExtractEngine(): ExtractAssetsApi {
  return { ...defaultEngine, ...(installed ?? {}), ...(testHook() ?? {}) };
}

/** `true` si la deteccion automatica esta disponible (el `extractAssets` vigente no es el de `unavailableEngine`). */
export function isExtractEngineAvailable(): boolean {
  return getExtractEngine().extractAssets !== unavailableEngine.extractAssets;
}

export const extractAssets: ExtractAssetsApi["extractAssets"] = (file, options) =>
  getExtractEngine().extractAssets(file, options);

export const renderAsset: ExtractAssetsApi["renderAsset"] = (file, asset, format) =>
  getExtractEngine().renderAsset(file, asset, format);

export const cropRegion: ExtractAssetsApi["cropRegion"] = (file, pageIndex, rect, options) =>
  getExtractEngine().cropRegion(file, pageIndex, rect, options);
